package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const appID = "app_test"

func enc(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func signJWT(t *testing.T, key *ecdsa.PrivateKey, head, claims map[string]any) string {
	t.Helper()
	in := enc(head) + "." + enc(claims)
	d := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, key, d[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// fakePrivy serves the app's JWKS and one user, like auth.privy.io.
func fakePrivy(t *testing.T, key *ecdsa.PrivateKey) *privy {
	return fakePrivyWallet(t, key, "0xEMBEDDED")
}

// fakePrivyWallet: the same, with the user's embedded wallet at this address.
func fakePrivyWallet(t *testing.T, key *ecdsa.PrivateKey, wallet string) *privy {
	pub := key.PublicKey
	x, y := make([]byte, 32), make([]byte, 32)
	pub.X.FillBytes(x)
	pub.Y.FillBytes(y)
	mux := http.NewServeMux()
	mux.HandleFunc("/apps/"+appID+"/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "EC", "crv": "P-256",
			"x": base64.RawURLEncoding.EncodeToString(x), "y": base64.RawURLEncoding.EncodeToString(y),
		}}})
	})
	mux.HandleFunc("/users/did:privy:abc", func(w http.ResponseWriter, r *http.Request) {
		if u, pw, _ := r.BasicAuth(); u != appID || pw != "secret" || r.Header.Get("privy-app-id") != appID {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"id":"did:privy:abc","linked_accounts":[
			{"type":"wallet","address":"0xEXTERNAL","chain_type":"ethereum","wallet_client_type":"metamask"},
			{"type":"google_oauth","email":"kiel@gmail.com","name":"Kiel"},
			{"type":"wallet","address":"` + wallet + `","chain_type":"ethereum","wallet_client_type":"privy"}]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	return p
}

func good(exp time.Time) map[string]any {
	return map[string]any{"iss": "privy.io", "aud": appID, "sub": "did:privy:abc", "sid": "s1", "exp": exp.Unix()}
}

func TestVerifyPrivyToken(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := fakePrivy(t, key)
	now := time.Now()
	head := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}

	if id, err := p.verify(signJWT(t, key, head, good(now.Add(time.Hour))), now); err != nil || id != "did:privy:abc" {
		t.Fatalf("valid token: %q %v", id, err)
	}
	bad := map[string]string{
		"wrong signer":   signJWT(t, other, head, good(now.Add(time.Hour))),
		"expired":        signJWT(t, key, head, good(now.Add(-time.Hour))),
		"other app":      signJWT(t, key, head, map[string]any{"iss": "privy.io", "aud": "app_other", "sub": "x", "exp": now.Add(time.Hour).Unix()}),
		"other issuer":   signJWT(t, key, head, map[string]any{"iss": "evil", "aud": appID, "sub": "x", "exp": now.Add(time.Hour).Unix()}),
		"alg none":       enc(map[string]any{"alg": "none", "kid": "k1"}) + "." + enc(good(now.Add(time.Hour))) + ".",
		"unknown key id": signJWT(t, key, map[string]any{"alg": "ES256", "kid": "nope"}, good(now.Add(time.Hour))),
		"garbage":        "a.b.c",
	}
	for name, tok := range bad {
		if _, err := p.verify(tok, now); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestMeEndpoint(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := fakePrivy(t, key)
	srv := httptest.NewServer(routes(&quoter{}, []string{"https://nyxeron.xyz"}, p, nil, nil))
	defer srv.Close()
	call := func(auth string) (*http.Response, Me) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/me", nil)
		req.Header.Set("Origin", "https://nyxeron.xyz")
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var me Me
		_ = json.NewDecoder(res.Body).Decode(&me)
		return res, me
	}
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	res, me := call("Bearer " + tok)
	if res.StatusCode != 200 || me != (Me{ID: "did:privy:abc", Email: "kiel@gmail.com", Wallet: "0xEMBEDDED"}) {
		t.Fatalf("me: %d %+v", res.StatusCode, me)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "https://nyxeron.xyz" {
		t.Fatal("no CORS on /api/me")
	}
	if res, _ := call(""); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, _ := call("Bearer " + strings.Replace(tok, ".", ".x", 1)); res.StatusCode != 401 {
		t.Fatalf("tampered token: %d", res.StatusCode)
	}
	// Preflight for the Authorization header.
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/me", nil)
	req.Header.Set("Origin", "https://nyxeron.xyz")
	pre, _ := http.DefaultClient.Do(req)
	if pre.StatusCode != 204 || !strings.Contains(pre.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight: %d %q", pre.StatusCode, pre.Header.Get("Access-Control-Allow-Headers"))
	}
}

// A JWKS refetch that fails (Privy down, rate limited, an empty set) must not throw away the keys we have: anyone can
// trigger a refetch with a made-up kid, and losing the keys signs every player out until the next fetch is allowed.
func TestJWKSRefetchKeepsKeysOnBadResponse(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	x, y := make([]byte, 32), make([]byte, 32)
	key.PublicKey.X.FillBytes(x)
	key.PublicKey.Y.FillBytes(y)
	jwks := `{"keys":[{"kid":"k1","kty":"EC","crv":"P-256","x":"` + base64.RawURLEncoding.EncodeToString(x) +
		`","y":"` + base64.RawURLEncoding.EncodeToString(y) + `"}]}`
	head := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}

	for name, bad := range map[string]func(http.ResponseWriter){
		"503 with a JSON error": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"unavailable"}`))
		},
		"429 with an empty set": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"keys":[]}`))
		},
		"200 with no usable key": func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"keys":[]}`)) },
	} {
		t.Run(name, func(t *testing.T) {
			fetches := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fetches++
				if fetches == 1 {
					_, _ = w.Write([]byte(jwks))
					return
				}
				bad(w)
			}))
			t.Cleanup(srv.Close)
			p := newPrivy(appID, "secret", srv.Client())
			p.base = srv.URL
			now := time.Now()
			if _, err := p.verify(signJWT(t, key, head, good(now.Add(time.Hour))), now); err != nil {
				t.Fatalf("first fetch: %v", err)
			}
			later := now.Add(2 * jwksMinGap)
			unknown := map[string]any{"alg": "ES256", "kid": "made-up", "typ": "JWT"}
			if _, err := p.verify(signJWT(t, key, unknown, good(later.Add(time.Hour))), later); err == nil {
				t.Fatal("unknown kid accepted")
			}
			if fetches != 2 {
				t.Fatalf("the unknown kid should refetch once, fetched %d times", fetches)
			}
			if _, err := p.verify(signJWT(t, key, head, good(later.Add(time.Hour))), later); err != nil {
				t.Fatalf("a valid token after a failed refetch: %v", err)
			}
		})
	}
}

// jwksBody is a JWKS document with these keys, as Privy serves it.
func jwksBody(keys map[string]*ecdsa.PrivateKey) []byte {
	var list []map[string]string
	for kid, k := range keys {
		x, y := make([]byte, 32), make([]byte, 32)
		k.PublicKey.X.FillBytes(x)
		k.PublicKey.Y.FillBytes(y)
		list = append(list, map[string]string{"kid": kid, "kty": "EC", "crv": "P-256",
			"x": base64.RawURLEncoding.EncodeToString(x), "y": base64.RawURLEncoding.EncodeToString(y)})
	}
	b, _ := json.Marshal(map[string]any{"keys": list})
	return b
}

// While Privy is down at boot (no key ever loaded) sign-ins don't hammer it, yet a blip heals within seconds, not a
// minute. The 503 body isn't JSON, so the decode fails and the key map stays nil: only the time-based gate holds.
func TestJWKSBootOutageRateLimitedAndHealsFast(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var mu sync.Mutex
	fetches, up := 0, false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		fetches++
		if !up {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("upstream connect error"))
			return
		}
		_, _ = w.Write(jwksBody(map[string]*ecdsa.PrivateKey{"k1": key}))
	}))
	t.Cleanup(srv.Close)
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	now := time.Now()
	head := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	tok := func(at time.Time) string { return signJWT(t, key, head, good(at.Add(time.Hour))) }
	for i := 0; i < 20; i++ {
		if _, err := p.verify(tok(now), now); err == nil {
			t.Fatal("accepted without keys")
		}
	}
	if fetches != 1 {
		t.Fatalf("20 sign-ins during an outage fetched the JWKS %d times, want 1", fetches)
	}
	mu.Lock()
	up = true
	mu.Unlock()
	if _, err := p.verify(tok(now.Add(jwksBoot/2)), now.Add(jwksBoot/2)); err == nil || fetches != 1 {
		t.Fatalf("inside the boot gap: err %v, %d fetches; want refused without a fetch", err, fetches)
	}
	later := now.Add(jwksBoot + time.Second)
	if _, err := p.verify(tok(later), later); err != nil || fetches != 2 {
		t.Fatalf("Privy back, %v after boot: err %v, %d fetches; want signed in after 1 more fetch", jwksBoot+time.Second, err, fetches)
	}
}

// The JWKS request runs outside the lock: while a made-up kid waits on a slow Privy, players with known keys still
// sign in at once; and concurrent unknown kids share that one fetch.
func TestJWKSFetchDoesNotStallKnownKeys(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	release := make(chan struct{})
	var fetches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fetches.Add(1) > 1 {
			<-release // Privy hangs on the refetch
		}
		_, _ = w.Write(jwksBody(map[string]*ecdsa.PrivateKey{"k1": key}))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	now := time.Now()
	known := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}, good(now.Add(2*time.Hour)))
	if _, err := p.verify(known, now); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	later := now.Add(2 * jwksMinGap)
	made := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "made-up", "typ": "JWT"}, good(later.Add(time.Hour)))
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = p.verify(made, later) }()
	}
	for fetches.Load() < 2 {
		time.Sleep(time.Millisecond)
	}
	done := make(chan error, 1)
	go func() { _, err := p.verify(known, later); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("known key during a slow refetch: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a known key waited on the JWKS refetch (fetch holds the lock)")
	}
	close(release)
	wg.Wait()
	if n := fetches.Load(); n != 2 {
		t.Fatalf("10 concurrent unknown kids fetched %d times in all, want 2 (boot + one shared refetch)", n)
	}
}

// Keys older than jwksMaxAge are re-fetched: a key Privy removed stops working, the new one works, and a failed
// refresh keeps the old keys rather than signing everyone out.
func TestJWKSCacheExpires(t *testing.T) {
	old, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	rotated, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var mu sync.Mutex
	serve := func(w http.ResponseWriter) { _, _ = w.Write(jwksBody(map[string]*ecdsa.PrivateKey{"k1": old})) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		serve(w)
	}))
	t.Cleanup(srv.Close)
	set := func(f func(http.ResponseWriter)) { mu.Lock(); serve = f; mu.Unlock() }
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	now := time.Now()
	tok := func(k *ecdsa.PrivateKey, kid string, at time.Time) string {
		return signJWT(t, k, map[string]any{"alg": "ES256", "kid": kid, "typ": "JWT"}, good(at.Add(time.Hour)))
	}
	if _, err := p.verify(tok(old, "k1", now), now); err != nil {
		t.Fatalf("first fetch: %v", err)
	}

	// Past the max age with Privy failing: the old key still signs in.
	set(func(w http.ResponseWriter) { w.WriteHeader(http.StatusBadGateway) })
	t1 := now.Add(jwksMaxAge + time.Minute)
	if _, err := p.verify(tok(old, "k1", t1), t1); err != nil {
		t.Fatalf("stale key with Privy down: %v", err)
	}

	// Privy rotated k1 out: once the gap allows a refetch, k1 is refused and k2 accepted.
	set(func(w http.ResponseWriter) { _, _ = w.Write(jwksBody(map[string]*ecdsa.PrivateKey{"k2": rotated})) })
	t2 := t1.Add(jwksMinGap + time.Second)
	if _, err := p.verify(tok(old, "k1", t2), t2); err == nil {
		t.Fatal("a key Privy removed still signs in after the cache expired")
	}
	if _, err := p.verify(tok(rotated, "k2", t2), t2); err != nil {
		t.Fatalf("the rotated key: %v", err)
	}
}
