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
			{"type":"wallet","address":"0xEMBEDDED","chain_type":"ethereum","wallet_client_type":"privy"}]}`))
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
	srv := httptest.NewServer(routes(&quoter{}, []string{"https://nyxeron.xyz"}, p))
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
	if pre.StatusCode != 204 || pre.Header.Get("Access-Control-Allow-Headers") != "Authorization" {
		t.Fatalf("preflight: %d %q", pre.StatusCode, pre.Header.Get("Access-Control-Allow-Headers"))
	}
}
