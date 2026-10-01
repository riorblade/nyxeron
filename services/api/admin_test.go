package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAdminStore(t *testing.T) {
	s := testStore(t)
	s.Update(ctx, "u1", ptr("Kiel"), nil)
	s.Update(ctx, "u2", ptr("Rio"), nil)
	s.SetIdentity(ctx, "u1", "Kiel@Gmail.com", "0xABC", time.Now())

	// Search by email (case-insensitive), name, wallet; LIKE wildcards are literal.
	for q, want := range map[string]int{"kiel@gmail": 1, "rio": 1, "0xabc": 1, "": 2, "%": 0} {
		if list, total, err := s.ListUsers(ctx, q, "coin", 50, 0); err != nil || total != want || len(list) != want {
			t.Errorf("q=%q: %d %v", q, total, err)
		}
	}

	// Grants: need a reason, can't take the wallet below zero, never create a player, ledgered and audited.
	if err := s.GrantCoins(ctx, "boss@x", "u1", 5000, ""); !errors.Is(err, errBad) {
		t.Fatalf("no reason: %v", err)
	}
	if err := s.GrantCoins(ctx, "boss@x", "u1", -startWallet-1, "oops"); !errors.Is(err, errRejected) {
		t.Fatalf("below zero: %v", err)
	}
	if err := s.GrantCoins(ctx, "boss@x", "ghost", 5000, "x"); !errors.Is(err, errNotFound) {
		t.Fatalf("unknown player: %v", err)
	}
	if err := s.GrantCoins(ctx, "boss@x", "u1", 5000, "tournament prize"); err != nil {
		t.Fatal(err)
	}
	d, err := s.UserDetail(ctx, "u1")
	if err != nil || d.User.Coin != startWallet+5000 || d.User.Email != "kiel@gmail.com" {
		t.Fatalf("%+v %v", d.User, err)
	}
	if l := d.Ledger[0]; l.Delta != 5000 || l.Balance != startWallet+5000 || l.Kind != "admin" || l.Actor != "boss@x" || l.Reason != "tournament prize" {
		t.Fatalf("ledger: %+v", l)
	}
	if a := d.Audit[0]; a.Action != "coins" || a.Actor != "boss@x" || string(a.Detail) != `{"after":25000,"before":20000,"delta":5000}` {
		t.Fatalf("audit: %+v %s", a, a.Detail)
	}

	// Access, ban, rename: only real changes are audited.
	lvl, yes := 5, true
	if err := s.SetUser(ctx, "boss@x", "u1", UserPatch{UnlockLevel: &lvl, Banned: &yes, BanReason: ptr("bot farming"), Reason: "review"}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Get(ctx, "u1")
	if p.UnlockLevel != 5 || !p.Banned || p.BanReason != "bot farming" || !s.Banned(ctx, "u1") {
		t.Fatalf("%+v", p)
	}
	if err := s.SetUser(ctx, "boss@x", "u1", UserPatch{UnlockLevel: &lvl, Reason: "again"}); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.Audit(ctx, "u1", 50, 0); len(rows) != 3 {
		t.Fatalf("audit rows: %d", len(rows))
	}
	six := 6
	if err := s.SetUser(ctx, "boss@x", "u1", UserPatch{UnlockLevel: &six, Reason: "x"}); !errors.Is(err, errBad) {
		t.Fatalf("level 6: %v", err)
	}

	s.PutDoc(ctx, "u2", "saves", "auto", []byte(`{"v":1,"savedAt":1,"state":{"day":1,"level":1}}`), time.Now())
	if err := s.ClearSaves(ctx, "boss@x", "u2", "corrupt save"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListDocs(ctx, "u2", "saves"); len(list) != 0 {
		t.Fatalf("saves left: %+v", list)
	}

	if err := s.SetAnnouncement(ctx, "boss@x", Announcement{Text: " Double coins tonight ", Active: true}); err != nil {
		t.Fatal(err)
	}
	if a := s.Announcement(ctx); a.Text != "Double coins tonight" || !a.Active {
		t.Fatalf("%+v", a)
	}
}

// Over HTTP: the role comes from the verified email, never the request; viewers read, only admins change things,
// only owners manage admins; a banned player can read but not change.
func TestAdminEndpoints(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := fakePrivy(t, key)
	db := testStore(t)
	db.Update(ctx, "target", ptr("Target"), nil)
	adm := &admin{owners: map[string]bool{}, client: http.DefaultClient}
	srv := httptest.NewServer(routes(&quoter{}, nil, p, db, adm))
	defer srv.Close()
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	call := func(method, path string, body any) int {
		var buf bytes.Buffer
		if body != nil {
			json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, srv.URL+path, &buf)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	grant := map[string]any{"delta": 1000, "reason": "support"}

	// The fake Privy user is kiel@gmail.com: nobody yet.
	if c := call("GET", "/api/admin/stats", nil); c != 403 {
		t.Fatalf("stranger: %d", c)
	}
	db.SetAdmin(ctx, "test", "kiel@gmail.com", "viewer")
	if c := call("GET", "/api/admin/users?q=targ", nil); c != 200 {
		t.Fatalf("viewer list: %d", c)
	}
	if c := call("POST", "/api/admin/users/target/coins", grant); c != 403 {
		t.Fatalf("viewer grant: %d", c)
	}
	db.SetAdmin(ctx, "test", "kiel@gmail.com", "admin")
	if c := call("POST", "/api/admin/users/target/coins", grant); c != 200 {
		t.Fatalf("admin grant: %d", c)
	}
	if c := call("POST", "/api/admin/users/nobody/coins", grant); c != 404 {
		t.Fatalf("unknown player: %d", c)
	}
	if c := call("PUT", "/api/admin/admins", map[string]string{"email": "x@y.z", "role": "admin"}); c != 403 {
		t.Fatalf("admin making admins: %d", c)
	}
	adm.owners["kiel@gmail.com"] = true
	if c := call("PUT", "/api/admin/admins", map[string]string{"email": "x@y.z", "role": "admin"}); c != 200 {
		t.Fatalf("owner making admins: %d", c)
	}
	if c := call("GET", "/api/admin/stats", nil); c != 200 {
		t.Fatalf("stats: %d", c)
	}

	// Ban the signed-in player itself: profile still loads, changes are refused.
	call("GET", "/api/profile", nil)
	yes := true
	if c := call("PATCH", "/api/admin/users/did:privy:abc", UserPatch{Banned: &yes, Reason: "test"}); c != 200 {
		t.Fatalf("ban: %d", c)
	}
	if c := call("GET", "/api/profile", nil); c != 200 {
		t.Fatalf("banned read: %d", c)
	}
	if c := call("PATCH", "/api/profile", map[string]any{"name": "x"}); c != 403 {
		t.Fatalf("banned write: %d", c)
	}
	// GET /api/profile stored who they are, for search.
	if list, _, _ := db.ListUsers(ctx, "kiel@gmail", "", 10, 0); len(list) != 1 || list[0].Wallet != "0xEMBEDDED" {
		t.Fatalf("identity: %+v", list)
	}
}
