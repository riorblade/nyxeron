package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The same vector is checked by services/relay/ticket_test.go: change both or neither.
const ticketVector = "v1.eyJzdWIiOiJkaWQ6cHJpdnk6YWJjIiwiZXhwIjoxODAwMDAwMDAwfQ.Hj3vrKMr5FIzwJPhZZQJFZdDcEH9wPXGY-5FCPlLOag"

func TestTicketFormatVector(t *testing.T) {
	got := signTicket([]byte("test-secret"), "did:privy:abc", time.Unix(1800000000, 0))
	if got != ticketVector {
		t.Fatalf("format changed: %s", got)
	}
}

func TestRelayTicketEndpoint(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := fakePrivy(t, key)
	db := testStore(t)
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	post := func(srv *httptest.Server, bearer string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", srv.URL+"/api/relay/ticket", nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	off := httptest.NewServer(routes(&quoter{}, nil, p, db, nil))
	defer off.Close()
	if c, _ := post(off, tok); c != http.StatusServiceUnavailable {
		t.Fatalf("no secret: %d", c)
	}

	t.Setenv("RELAY_TICKET_SECRET", "0123456789abcdef0123456789abcdef")
	srv := httptest.NewServer(routes(&quoter{}, nil, p, db, nil))
	defer srv.Close()
	if c, _ := post(srv, ""); c != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", c)
	}
	c, out := post(srv, tok)
	if c != http.StatusOK {
		t.Fatalf("signed in: %d %v", c, out)
	}
	exp := time.Unix(int64(out["exp"].(float64)), 0)
	if want := signTicket([]byte("0123456789abcdef0123456789abcdef"), "did:privy:abc", exp); out["ticket"] != want {
		t.Fatalf("ticket %v, want %s", out["ticket"], want)
	}
	if d := time.Until(exp); d < 9*time.Minute || d > ticketTTL {
		t.Fatalf("ttl %v", d)
	}
	db.Get(ctx, "did:privy:abc") // the player exists, then is banned
	db.db.Exec(`UPDATE users SET banned = 1 WHERE id = 'did:privy:abc'`)
	if c, _ := post(srv, tok); c != http.StatusForbidden {
		t.Fatalf("banned: %d", c)
	}
}
