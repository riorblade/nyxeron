package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Privy sign-in, checked server-side. The browser sends its Privy access token (a JWT signed ES256 by Privy);
// we verify the signature against the app's published keys (JWKS) and the claims ourselves, then read the
// player's email and embedded wallet from Privy's API with the app secret. Standard library only.
// Docs: https://docs.privy.io/authentication/user-authentication/access-tokens

const (
	privyAPI    = "https://auth.privy.io/api/v1"
	userTTL     = 5 * time.Minute
	jwksMinGap  = time.Minute     // re-fetch keys at most this often (unknown kid → key rotation)
	jwksBootGap = 5 * time.Second // no key loaded yet (Privy blipped at start): retry sooner
	jwksMaxAge  = time.Hour       // refetch in the background, so a key Privy removed stops working
	clockSkew   = 30 * time.Second
)

// Me is the verified player.
type Me struct {
	ID     string `json:"id"`
	Email  string `json:"email"`
	Wallet string `json:"wallet"`
}

type privy struct {
	appID, secret string
	base          string // privyAPI (tests point it at a fake)
	client        *http.Client

	mu       sync.Mutex
	keys     map[string]*ecdsa.PublicKey
	fetched  time.Time     // last JWKS fetch started
	loaded   time.Time     // last JWKS fetch that gave keys
	inflight chan struct{} // closed when the running fetch ends (one at a time)
	users    map[string]cachedMe
}

type cachedMe struct {
	me Me
	at time.Time
}

func newPrivy(appID, secret string, client *http.Client) *privy {
	return &privy{appID: appID, secret: secret, base: privyAPI, client: client, users: map[string]cachedMe{}}
}

func (p *privy) configured() bool { return p.appID != "" && p.secret != "" }

var errToken = errors.New("invalid token")

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// verify checks a Privy access token and returns the user's Privy DID.
func (p *privy) verify(token string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errToken
	}
	var head struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	var claims struct {
		Iss string          `json:"iss"`
		Aud json.RawMessage `json:"aud"`
		Sub string          `json:"sub"`
		Exp int64           `json:"exp"`
	}
	hb, err1 := b64(parts[0])
	cb, err2 := b64(parts[1])
	sig, err3 := b64(parts[2])
	if err1 != nil || err2 != nil || err3 != nil || json.Unmarshal(hb, &head) != nil || json.Unmarshal(cb, &claims) != nil {
		return "", errToken
	}
	// Only ES256: never "none" or a symmetric algorithm an attacker could pick.
	if head.Alg != "ES256" || len(sig) != 64 {
		return "", errToken
	}
	key, err := p.key(head.Kid, now)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return "", errToken
	}
	if claims.Iss != "privy.io" || !audIncludes(claims.Aud, p.appID) || claims.Sub == "" {
		return "", errToken
	}
	if now.After(time.Unix(claims.Exp, 0).Add(clockSkew)) {
		return "", errors.New("token expired")
	}
	return claims.Sub, nil
}

// aud may be a string or a list.
func audIncludes(raw json.RawMessage, app string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == app
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == app {
				return true
			}
		}
	}
	return false
}

// key returns the signing key with this id. Known keys never wait on the network: a fetch runs outside the lock,
// one at a time, and only callers with an unknown kid wait for it. Fetches are rate limited (jwksMinGap, or
// jwksBootGap while no key has loaded), and keys older than jwksMaxAge are refreshed in the background.
func (p *privy) key(kid string, now time.Time) (*ecdsa.PublicKey, error) {
	p.mu.Lock()
	gap := jwksMinGap
	if len(p.keys) == 0 {
		gap = jwksBootGap
	}
	due := p.fetched.IsZero() || now.Sub(p.fetched) >= gap
	if k := p.lookup(kid); k != nil {
		if now.Sub(p.loaded) > jwksMaxAge && due && p.inflight == nil {
			go p.fetch(p.begin(now), now)
		}
		p.mu.Unlock()
		return k, nil
	}
	wait := p.inflight
	if wait == nil {
		// Rate limited even while no key was ever loaded (Privy down at start), so sign-ins can't hammer it.
		if !due {
			p.mu.Unlock()
			return nil, errToken
		}
		wait = p.begin(now)
		go p.fetch(wait, now)
	}
	p.mu.Unlock()
	<-wait
	p.mu.Lock()
	defer p.mu.Unlock()
	if k := p.lookup(kid); k != nil {
		return k, nil
	}
	return nil, errToken
}

// lookup: the key with this id; a token without a kid gets the app's only key. Caller holds p.mu.
func (p *privy) lookup(kid string) *ecdsa.PublicKey {
	if k := p.keys[kid]; k != nil {
		return k
	}
	if kid == "" && len(p.keys) == 1 {
		for _, k := range p.keys {
			return k
		}
	}
	return nil
}

// begin marks a fetch as running. Caller holds p.mu.
func (p *privy) begin(now time.Time) chan struct{} {
	p.fetched = now
	p.inflight = make(chan struct{})
	return p.inflight
}

// fetch downloads the JWKS and swaps the keys in. A failed fetch keeps the keys we have: anyone can trigger one with
// a made-up kid, and an empty set would sign every player out until the next fetch is allowed.
func (p *privy) fetch(done chan struct{}, at time.Time) {
	keys, err := p.download()
	p.mu.Lock()
	if err == nil {
		p.keys, p.loaded = keys, at
	} else {
		slog.Warn("jwks fetch failed", "err", err)
	}
	p.inflight = nil
	p.mu.Unlock()
	close(done)
}

func (p *privy) download() (map[string]*ecdsa.PublicKey, error) {
	res, err := p.client.Get(fmt.Sprintf("%s/apps/%s/jwks.json", p.base, url.PathEscape(p.appID)))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks: %s", res.Status)
	}
	var set struct {
		Keys []struct {
			Kid, Kty, Crv, X, Y string
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&set); err != nil {
		return nil, err
	}
	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range set.Keys {
		x, ex := b64(k.X)
		y, ey := b64(k.Y)
		if k.Kty != "EC" || k.Crv != "P-256" || ex != nil || ey != nil {
			continue
		}
		pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), append(append([]byte{4}, pad32(x)...), pad32(y)...))
		if err == nil {
			keys[k.Kid] = pub
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("jwks: no usable key")
	}
	return keys, nil
}

func pad32(b []byte) []byte {
	if len(b) >= 32 {
		return b
	}
	return append(make([]byte, 32-len(b)), b...)
}

// user reads email and the embedded EVM wallet from Privy (cached).
func (p *privy) user(id string, now time.Time) (Me, error) {
	p.mu.Lock()
	if c, ok := p.users[id]; ok && now.Sub(c.at) < userTTL {
		p.mu.Unlock()
		return c.me, nil
	}
	p.mu.Unlock()
	req, _ := http.NewRequest(http.MethodGet, p.base+"/users/"+url.PathEscape(id), nil)
	req.SetBasicAuth(p.appID, p.secret)
	req.Header.Set("privy-app-id", p.appID)
	res, err := p.client.Do(req)
	if err != nil {
		return Me{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Me{}, fmt.Errorf("privy users %d", res.StatusCode)
	}
	var u struct {
		ID       string `json:"id"`
		Accounts []struct {
			Type             string `json:"type"`
			Address          string `json:"address"`
			Email            string `json:"email"`
			ChainType        string `json:"chain_type"`
			WalletClientType string `json:"wallet_client_type"`
		} `json:"linked_accounts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&u); err != nil {
		return Me{}, err
	}
	me := Me{ID: id}
	for _, a := range u.Accounts {
		switch {
		case a.Type == "email" && me.Email == "":
			me.Email = a.Address
		case a.Type == "google_oauth" && me.Email == "":
			me.Email = a.Email
		case a.Type == "wallet" && a.WalletClientType == "privy" && a.ChainType == "ethereum" && me.Wallet == "":
			me.Wallet = a.Address
		}
	}
	// Not cached without a wallet: the embedded wallet can be created after the first lookup, and top-ups
	// match on it.
	if me.Wallet != "" {
		p.mu.Lock()
		p.users[id] = cachedMe{me, now}
		p.mu.Unlock()
	}
	return me, nil
}

// handleMe: GET /api/me with "Authorization: Bearer <Privy access token>" → the verified player.
func (p *privy) handleMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !p.configured() {
		http.Error(w, `{"error":"auth not configured"}`, http.StatusServiceUnavailable)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
		return
	}
	now := time.Now()
	id, err := p.verify(strings.TrimSpace(token), now)
	if err != nil {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}
	me, err := p.user(id, now)
	if err != nil {
		http.Error(w, `{"error":"identity lookup failed"}`, http.StatusBadGateway)
		return
	}
	_ = json.NewEncoder(w).Encode(me)
}
