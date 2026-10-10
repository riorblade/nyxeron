package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

// While Privy is down and no key was ever loaded, sign-ins still fetch the JWKS at most once a minute.
func TestJWKSRefetchRateLimitedWithoutKeys(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	fetches := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("unavailable")) // not JSON: nothing for an old decoder to turn into an empty key set
	}))
	t.Cleanup(srv.Close)
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	now := time.Now()
	head := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	for i := 0; i < 20; i++ {
		if _, err := p.verify(signJWT(t, key, head, good(now.Add(time.Hour))), now); err == nil {
			t.Fatal("accepted without keys")
		}
	}
	if fetches != 1 {
		t.Fatalf("20 sign-ins in one minute fetched the JWKS %d times, want 1", fetches)
	}
	later := now.Add(jwksMinGap + time.Second)
	_, _ = p.verify(signJWT(t, key, head, good(later.Add(time.Hour))), later)
	if fetches != 2 {
		t.Fatalf("after a minute: %d fetches, want 2", fetches)
	}
}

// jwksServer: the app's JWKS with these keys; `slow` delays every answer after the first, `down` fails them.
func jwksServer(t *testing.T, keys ...*ecdsa.PrivateKey) (*privy, *atomic.Int32, *atomic.Bool, *atomic.Bool) {
	var fetches atomic.Int32
	var slow, down atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := fetches.Add(1)
		if n > 1 && slow.Load() {
			time.Sleep(time.Second)
		}
		if down.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		set := []map[string]string{}
		for i, k := range keys {
			x, y := make([]byte, 32), make([]byte, 32)
			k.PublicKey.X.FillBytes(x)
			k.PublicKey.Y.FillBytes(y)
			set = append(set, map[string]string{"kid": fmt.Sprintf("k%d", i+1), "kty": "EC", "crv": "P-256",
				"x": base64.RawURLEncoding.EncodeToString(x), "y": base64.RawURLEncoding.EncodeToString(y)})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": set})
	}))
	t.Cleanup(srv.Close)
	p := newPrivy(appID, "secret", srv.Client())
	p.base = srv.URL
	return p, &fetches, &slow, &down
}

func TestJWKSSlowRefetchDoesNotStallKnownKeys(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p, fetches, slow, _ := jwksServer(t, key)
	now := time.Now()
	k1 := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	if _, err := p.verify(signJWT(t, key, k1, good(now.Add(time.Hour))), now); err != nil {
		t.Fatal(err)
	}
	slow.Store(true)
	later := now.Add(2 * jwksMinGap)
	// A made-up kid starts a slow refetch; 50 more join it instead of starting their own.
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = p.verify(signJWT(t, key, map[string]any{"alg": "ES256", "kid": "made-up"}, good(later.Add(time.Hour))), later)
		}()
	}
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	if _, err := p.verify(signJWT(t, key, k1, good(later.Add(time.Hour))), later); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("a valid sign-in waited %v on someone else's refetch", d)
	}
	wg.Wait()
	if n := fetches.Load(); n != 2 {
		t.Fatalf("fetches %d, want 2 (one at start, one shared refetch)", n)
	}
}

func TestJWKSBootBlipRetriesSoon(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p, _, _, down := jwksServer(t, key)
	down.Store(true)
	now := time.Now()
	k1 := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	if _, err := p.verify(signJWT(t, key, k1, good(now.Add(time.Hour))), now); err == nil {
		t.Fatal("accepted with Privy down")
	}
	down.Store(false)
	soon := now.Add(jwksBootGap + time.Second)
	if _, err := p.verify(signJWT(t, key, k1, good(soon.Add(time.Hour))), soon); err != nil {
		t.Fatalf("still refused %v after Privy came back: %v", jwksBootGap+time.Second, err)
	}
}

func TestJWKSRotatedKeyExpires(t *testing.T) {
	old, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p, _, _, _ := jwksServer(t, old)
	now := time.Now()
	k1 := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	if _, err := p.verify(signJWT(t, old, k1, good(now.Add(time.Hour))), now); err != nil {
		t.Fatal(err)
	}
	// Privy rotates: k1 is now a different key. Nobody sends an unknown kid, so only the max age notices.
	rotated, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p2, _, _, _ := jwksServer(t, rotated)
	p.base = p2.base
	later := now.Add(jwksMaxAge + time.Minute)
	if _, err := p.verify(signJWT(t, old, k1, good(later.Add(time.Hour))), later); err != nil {
		t.Fatal("the stale key should still serve while the refresh runs:", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := p.verify(signJWT(t, old, k1, good(later.Add(time.Hour))), later); err != nil {
			return // the removed key stopped working
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("a key Privy removed was still accepted after the max age")
}

func TestJWKSKeysNotTrustedPastADayWhilePrivyIsDown(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p, _, _, down := jwksServer(t, key)
	now := time.Now()
	k1 := map[string]any{"alg": "ES256", "kid": "k1", "typ": "JWT"}
	if _, err := p.verify(signJWT(t, key, k1, good(now.Add(time.Hour))), now); err != nil {
		t.Fatal(err)
	}
	down.Store(true)
	hours := now.Add(10 * time.Hour) // an outage: the cached key keeps everyone signed in
	if _, err := p.verify(signJWT(t, key, k1, good(hours.Add(time.Hour))), hours); err != nil {
		t.Fatal("cached key dropped during a short outage:", err)
	}
	time.Sleep(50 * time.Millisecond) // let the background refresh fail
	day := now.Add(jwksMaxKeep + time.Hour)
	if _, err := p.verify(signJWT(t, key, k1, good(day.Add(time.Hour))), day); err == nil {
		t.Fatal("a day-old key accepted without Privy confirming it")
	}
}
