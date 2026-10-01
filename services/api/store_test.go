package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) *store {
	t.Helper()
	s, err := openStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.close() })
	return s
}

var ctx = context.Background()

func TestNewPlayerGetsStarterWallet(t *testing.T) {
	s := testStore(t)
	p, err := s.Get(ctx, "did:privy:a")
	if err != nil || p.Wallet != startWallet || p.Avatar != 1 || p.Imported {
		t.Fatalf("%+v %v", p, err)
	}
}

func TestImportOnceWithinBounds(t *testing.T) {
	s := testStore(t)
	in := Profile{Name: "Kiel", Avatar: 3, Wallet: 18_914, Nights: 3, TotalPnl: -615, BestPnl: -2,
		Portfolio: map[string]Holding{"tsla": {Qty: 1, Cost: 292}, "us500": {Qty: 1, Cost: 181}}}
	p, err := s.Import(ctx, "u", in)
	if err != nil || p.Wallet != 18_914 || p.Portfolio["tsla"].Cost != 292 || !p.Imported || p.Name != "Kiel" {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Import(ctx, "u", in); !errors.Is(err, errConflict) {
		t.Fatalf("second import: %v", err)
	}
	for name, bad := range map[string]Profile{
		"huge wallet":   {Avatar: 1, Wallet: maxImport + 1},
		"unknown token": {Avatar: 1, Portfolio: map[string]Holding{"doge": {Qty: 1, Cost: 1}}},
		"bad avatar":    {Avatar: 11},
	} {
		if _, err := s.Import(ctx, "other-"+name, bad); !errors.Is(err, errBad) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Any change closes the import window.
	s.Update(ctx, "fresh", nil, ptr(2))
	if _, err := s.Import(ctx, "fresh", in); !errors.Is(err, errConflict) {
		t.Fatalf("import after a change: %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestNightOutRules(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "u") // 20 000
	// Door 2 500 + 5 TSLA for 7 430: walks out with 10 070 and the tokens.
	p, err := s.Night(ctx, "u", 10_070, map[string]Holding{"tsla": {Qty: 5, Cost: 7_430}}, -2_435)
	if err != nil || p.Wallet != 10_070 || p.Portfolio["tsla"].Qty != 5 || p.Nights != 1 || p.BestPnl != -2_435 {
		t.Fatalf("%+v %v", p, err)
	}
	reject := map[string]func() error{
		"wallet grows": func() error {
			_, e := s.Night(ctx, "u", 50_000, nil, 0)
			return e
		},
		"tokens cost more than was spent": func() error {
			_, e := s.Night(ctx, "u", 10_000, map[string]Holding{"nvda": {Qty: 1, Cost: 500}}, 0)
			return e
		},
	}
	for name, f := range reject {
		if err := f(); !errors.Is(err, errRejected) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A second night adds up.
	p, _ = s.Night(ctx, "u", 9_000, map[string]Holding{"tsla": {Qty: 1, Cost: 1_000}}, 100)
	if p.Portfolio["tsla"] != (Holding{Qty: 6, Cost: 8_430}) || p.Nights != 2 || p.BestPnl != 100 || p.TotalPnl != -2_335 {
		t.Fatalf("%+v", p)
	}
}

func TestGigAndRefillRules(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	p, err := s.Gig(ctx, "u", 4_000, now)
	if err != nil || p.Wallet != startWallet+4_000 || p.Gigs != 1 {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Gig(ctx, "u", 4_000, now.Add(time.Minute)); !errors.Is(err, errConflict) {
		t.Fatalf("gig too soon: %v", err)
	}
	if _, err := s.Gig(ctx, "u", maxGigFee+1, now.Add(time.Hour)); !errors.Is(err, errBad) {
		t.Fatalf("fee too big: %v", err)
	}
	if _, err := s.Refill(ctx, "u"); !errors.Is(err, errRejected) {
		t.Fatalf("refill while rich: %v", err)
	}
	s.Night(ctx, "u", 100, nil, 0)
	if p, err := s.Refill(ctx, "u"); err != nil || p.Wallet != startWallet {
		t.Fatalf("refill when broke: %+v %v", p, err)
	}
}

func TestDataSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keep.db")
	s, _ := openStore(path)
	s.Update(ctx, "u", ptr("Kiel"), ptr(7))
	s.close()
	s2, _ := openStore(path)
	defer s2.close()
	if p, _ := s2.Get(ctx, "u"); p.Name != "Kiel" || p.Avatar != 7 {
		t.Fatalf("%+v", p)
	}
}

// The api's copy of game constants must match the game data.
func TestConstantsMatchGameData(t *testing.T) {
	load := func(name string, v any) {
		b, err := os.ReadFile(filepath.Join("..", "..", "packages", "core", "src", "data", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatal(err)
		}
	}
	var tokens map[string]any
	load("tokens.json", &tokens)
	if len(tokens) != len(tokenIDs) {
		t.Fatalf("tokens.json has %d tokens, api knows %d", len(tokens), len(tokenIDs))
	}
	for id := range tokens {
		if !tokenIDs[id] {
			t.Errorf("api doesn't know token %q", id)
		}
	}
	var strategy struct {
		Visitor struct {
			StartWallet int64 `json:"startWallet"`
		} `json:"visitor"`
	}
	load("strategy.json", &strategy)
	if strategy.Visitor.StartWallet != startWallet {
		t.Errorf("startWallet: game %d, api %d", strategy.Visitor.StartWallet, startWallet)
	}
	var scen struct {
		Events []struct {
			DjFee int64 `json:"djFee"`
		} `json:"events"`
	}
	load("scenarios.json", &scen)
	var top int64
	for _, e := range scen.Events {
		top = max(top, e.DjFee)
	}
	if top != maxGigFee {
		t.Errorf("highest djFee: game %d, api %d", top, maxGigFee)
	}
}

// End to end over HTTP with a signed Privy token: the player is the token's subject.
func TestProfileEndpoints(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := fakePrivy(t, key)
	srv := httptest.NewServer(routes(&quoter{}, []string{"https://nyxeron.xyz"}, p, testStore(t)))
	defer srv.Close()
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	call := func(method, path, auth string, body any) (int, Profile) {
		var buf bytes.Buffer
		if body != nil {
			json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, srv.URL+path, &buf)
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var out Profile
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := call("GET", "/api/profile", "", nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	code, me := call("GET", "/api/profile", tok, nil)
	if code != 200 || me.ID != "did:privy:abc" || me.Wallet != startWallet {
		t.Fatalf("profile: %d %+v", code, me)
	}
	if code, me = call("PATCH", "/api/profile", tok, map[string]any{"name": "  Kiel  ", "avatar": 4}); code != 200 || me.Name != "Kiel" || me.Avatar != 4 {
		t.Fatalf("patch: %d %+v", code, me)
	}
	if code, _ = call("POST", "/api/nights", tok, map[string]any{"cash": 99_999}); code != 422 {
		t.Fatalf("cheating night: %d", code)
	}
	if code, _ = call("PATCH", "/api/profile", tok, map[string]any{"avatar": 99}); code != 400 {
		t.Fatalf("bad avatar: %d", code)
	}
}

func TestBackup(t *testing.T) {
	dir := t.TempDir()
	s, _ := openStore(filepath.Join(dir, "live.db"))
	defer s.close()
	s.Update(ctx, "u", ptr("Kiel"), nil)
	for d := 0; d < 9; d++ {
		if err := s.backup(dir, time.Date(2026, 10, 1+d, 0, 0, 0, 0, time.UTC), 7); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(dir, "backup-*.db"))
	if len(files) != 7 {
		t.Fatalf("kept %d backups", len(files))
	}
	b, _ := openStore(files[len(files)-1])
	defer b.close()
	if p, _ := b.Get(ctx, "u"); p.Name != "Kiel" {
		t.Fatalf("backup content: %+v", p)
	}
}

func TestDocs(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	save := []byte(`{"v":1,"savedAt":1700000000000,"state":{"day":12,"level":3,"clubName":"Neon Tap","coin":250000,"outcome":null}}`)
	info, err := s.PutDoc(ctx, "u", "saves", "auto", save, now)
	if err != nil || info.Meta["day"] != float64(12) || info.Meta["clubName"] != "Neon Tap" {
		t.Fatalf("%+v %v", info, err)
	}
	if got, err := s.GetDoc(ctx, "u", "saves", "auto"); err != nil || string(got) != string(save) {
		t.Fatalf("get: %s %v", got, err)
	}
	if _, err := s.GetDoc(ctx, "someone-else", "saves", "auto"); !errors.Is(err, errNotFound) {
		t.Fatalf("other player's save: %v", err)
	}
	list, _ := s.ListDocs(ctx, "u", "saves")
	if len(list) != 1 || list[0].Slot != "auto" {
		t.Fatalf("list: %+v", list)
	}
	bad := map[string]struct{ kind, slot, body string }{
		"unknown kind":      {"secrets", "main", `{}`},
		"slot 4":            {"saves", "4", string(save)},
		"save without day":  {"saves", "1", `{"v":1,"savedAt":1,"state":{"level":1}}`},
		"level 9":           {"saves", "1", `{"v":1,"savedAt":1,"state":{"day":1,"level":9}}`},
		"9 shoutouts":       {"shoutouts", "main", `["1","2","3","4","5","6","7","8","9"]`},
		"long shoutout":     {"shoutouts", "main", `["` + strings.Repeat("x", 81) + `"]`},
		"djsets no sets":    {"djsets", "main", `{"tonight":null}`},
		"layout not a list": {"layouts", "club", `{"a":1}`},
	}
	for name, c := range bad {
		if _, err := s.PutDoc(ctx, "u", c.kind, c.slot, []byte(c.body), now); !errors.Is(err, errBad) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A big save (a 60-day career) fits, gzipped.
	big := []byte(`{"v":1,"savedAt":1,"state":{"day":60,"level":5,"clubName":"X","coin":1,"log":"` + strings.Repeat("event ", 60_000) + `"}}`)
	if _, err := s.PutDoc(ctx, "u", "saves", "1", big, now); err != nil {
		t.Fatalf("big save: %v", err)
	}
	if got, _ := s.GetDoc(ctx, "u", "saves", "1"); len(got) != len(big) {
		t.Fatal("big save not intact")
	}
	// Slot limits: at most 10 layouts.
	for i := 0; i < 10; i++ {
		if _, err := s.PutDoc(ctx, "u", "layouts", "l"+string(rune('a'+i)), []byte(`[]`), now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PutDoc(ctx, "u", "layouts", "zz", []byte(`[]`), now); !errors.Is(err, errRejected) {
		t.Fatalf("11th layout: %v", err)
	}
	if err := s.DeleteDoc(ctx, "u", "layouts", "la"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetDoc(ctx, "u", "layouts", "la"); !errors.Is(err, errNotFound) {
		t.Fatalf("deleted layout still there: %v", err)
	}
}
