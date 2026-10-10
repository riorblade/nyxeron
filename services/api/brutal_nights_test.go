package main

// Adversarial tests for POST /api/nights: a signed-in player with a hand-written client. Tests that FAIL document a
// real hole (see the t.Errorf text); the rest are attacks that held.

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type nightsAPI struct {
	t   *testing.T
	url string
	tok string
	db  *store
}

func newNightsAPI(t *testing.T) *nightsAPI {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s := testStore(t)
	srv := httptest.NewServer(routes(&quoter{}, []string{"https://nyxeron.xyz"}, fakePrivy(t, key), s, nil))
	t.Cleanup(srv.Close)
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	return &nightsAPI{t, srv.URL, tok, s}
}

// night posts a raw body; returns the status and the profile (if 200).
func (a *nightsAPI) night(body string) (int, Profile) {
	req, _ := http.NewRequest("POST", a.url+"/api/nights", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+a.tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	var p Profile
	b, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(b, &p)
	return res.StatusCode, p
}

func (a *nightsAPI) me() Profile {
	req, _ := http.NewRequest("GET", a.url+"/api/profile", nil)
	req.Header.Set("Authorization", "Bearer "+a.tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	var p Profile
	_ = json.NewDecoder(res.Body).Decode(&p)
	return p
}

func jsonOf(v any) string { var b bytes.Buffer; _ = json.NewEncoder(&b).Encode(v); return b.String() }

// ---------------------------------------------------------------------------------------------------------------
// Attacks that held
// ---------------------------------------------------------------------------------------------------------------

func TestBrutalNightsBadInputRefused(t *testing.T) {
	a := newNightsAPI(t)
	start := a.me().Wallet
	cases := map[string]struct {
		body string
		code int
	}{
		"negative cash":       {`{"cash":-1}`, 400},
		"cash above wallet":   {jsonOf(map[string]any{"cash": start + 1}), 422},
		"cash int64 overflow": {`{"cash":9223372036854775808}`, 400},
		"cash float":          {`{"cash":1.5}`, 400},
		"cash string":         {`{"cash":"20000"}`, 400},
		"negative qty":        {jsonOf(map[string]any{"cash": start, "bought": map[string]Holding{"tsla": {Qty: -5, Cost: 0}}}), 400},
		"zero qty":            {jsonOf(map[string]any{"cash": start, "bought": map[string]Holding{"tsla": {Qty: 0, Cost: 0}}}), 400},
		"negative cost":       {jsonOf(map[string]any{"cash": 0, "bought": map[string]Holding{"tsla": {Qty: 1, Cost: -1_000_000}}}), 400},
		"unknown token":       {jsonOf(map[string]any{"cash": start, "bought": map[string]Holding{"btc": {Qty: 1, Cost: 0}}}), 400},
		"qty over 1M":         {jsonOf(map[string]any{"cash": start, "bought": map[string]Holding{"tsla": {Qty: 1_000_001}}}), 400},
		"cost above spend":    {jsonOf(map[string]any{"cash": start - 10, "bought": map[string]Holding{"tsla": {Qty: 1, Cost: 11}}}), 422},
		"pnl above wallet":    {jsonOf(map[string]any{"cash": start, "pnl": start + 1}), 422},
		"pnl below -wallet":   {jsonOf(map[string]any{"cash": start, "pnl": -start - 1}), 422},
		"body over 16 KB":     {`{"cash":0,"room":"` + strings.Repeat("A", 17<<10) + `"}`, 400},
		"not json":            {`cash=0`, 400},
		"cost summed past spend": {jsonOf(map[string]any{"cash": start - 100, "bought": map[string]Holding{
			"tsla": {Qty: 1, Cost: 60}, "nvda": {Qty: 1, Cost: 60}}}), 422},
	}
	for name, c := range cases {
		if code, _ := a.night(c.body); code != c.code {
			t.Errorf("%s: %d, want %d", name, code, c.code)
		}
	}
	if p := a.me(); p.Wallet != start || len(p.Portfolio) != 0 || p.Nights != 0 {
		t.Fatalf("a refused night changed the profile: %+v", p)
	}
	// No token, a bad token: 401.
	req, _ := http.NewRequest("POST", a.url+"/api/nights", strings.NewReader(`{"cash":0}`))
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	req, _ = http.NewRequest("POST", a.url+"/api/nights", strings.NewReader(`{"cash":0}`))
	req.Header.Set("Authorization", "Bearer "+a.tok+"x")
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != 401 {
		t.Fatalf("bad token: %d", res.StatusCode)
	}
	// Banned: 403.
	_, _ = a.db.db.Exec(`UPDATE users SET banned = 1 WHERE id = 'did:privy:abc'`)
	if code, _ := a.night(`{"cash":0}`); code != 403 {
		t.Fatalf("banned: %d", code)
	}
}

// The wallet can never grow, even with many settles racing on one connection pool.
func TestBrutalNightsConcurrentDoubleSpend(t *testing.T) {
	a := newNightsAPI(t)
	start := a.me().Wallet
	// 20 parallel settles each claim the whole wallet was spent on tokens: only one may count.
	body := jsonOf(map[string]any{"cash": 0, "bought": map[string]Holding{"tsla": {Qty: 10, Cost: start}}})
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, _ := a.night(body); code == 200 {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	p := a.me()
	if ok != 1 || p.Wallet != 0 || p.Portfolio["tsla"].Qty != 10 {
		t.Fatalf("double spend: %d accepted, %+v", ok, p)
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Holes (these fail on main)
// ---------------------------------------------------------------------------------------------------------------

// HOLE: tokens for free. validHoldings accepts cost 0 and Night only checks Σcost ≤ spent, so "spend nothing, take
// home 1 000 000 TSLA" passes, and can be replayed without limit. Nothing ties qty to a price.
func TestBrutalNightsMintTokensForFree(t *testing.T) {
	a := newNightsAPI(t)
	start := a.me().Wallet
	body := jsonOf(map[string]any{"cash": start, "bought": map[string]Holding{
		"tsla": {Qty: 1_000_000, Cost: 0}, "nvda": {Qty: 1_000_000, Cost: 0}, "spcx": {Qty: 1_000_000, Cost: 0}}})
	accepted := 0
	for i := 0; i < 25; i++ {
		if code, _ := a.night(body); code == 200 {
			accepted++
		}
	}
	p := a.me()
	if accepted > 0 {
		t.Errorf("free tokens: %d/25 settles accepted, wallet %d (unchanged), portfolio TSLA qty %d at cost %d",
			accepted, p.Wallet, p.Portfolio["tsla"].Qty, p.Portfolio["tsla"].Cost)
	}
	// Same with a token "cost": 1 coin for a million shares.
	if code, _ := a.night(jsonOf(map[string]any{"cash": p.Wallet - 1,
		"bought": map[string]Holding{"us500": {Qty: 1_000_000, Cost: 1}}})); code == 200 {
		t.Errorf("1 000 000 US500 for 1 coin accepted")
	}
}

// HOLE: pnl is the client's word. With nothing bought and nothing spent, a night may claim a profit as big as the
// wallet, every time: total_pnl and best_pnl (and the nights count) are whatever the client says.
func TestBrutalNightsFakePnlAndReplay(t *testing.T) {
	a := newNightsAPI(t)
	start := a.me().Wallet
	body := jsonOf(map[string]any{"cash": start, "pnl": start})
	for i := 0; i < 100; i++ {
		a.night(body)
	}
	p := a.me()
	if p.TotalPnl > 0 || p.BestPnl > 0 {
		t.Errorf("profit from nothing: 100 replays of a no-spend night → nights %d, totalPnl %d, bestPnl %d (wallet %d)",
			p.Nights, p.TotalPnl, p.BestPnl, p.Wallet)
	}
	if p.Nights > 1 {
		t.Errorf("the same settle replayed counts %d nights: no idempotency key / one settle per joined night", p.Nights)
	}
}

// HOLE: no proof of a night. `room` is free text (never checked against a live room or a relay join) and is
// stored verbatim in the ledger; a settle needs no room at all.
func TestBrutalNightsWithoutARoom(t *testing.T) {
	a := newNightsAPI(t)
	start := a.me().Wallet
	junk := "NOSUCH" + strings.Repeat("A", 15<<10) // ~15 KB, under the body cap
	code, _ := a.night(jsonOf(map[string]any{"cash": start - 1, "room": junk}))
	if code == 200 {
		var reason string
		_ = a.db.db.QueryRow(`SELECT reason FROM ledger WHERE kind = 'night' ORDER BY rowid DESC LIMIT 1`).Scan(&reason)
		t.Errorf("night in a room that never existed accepted; ledger reason stored %d bytes of client text", len(reason))
	}
}

// HOLE (play money laundering): refill is free when nearly broke, and a night turns the whole wallet into tokens
// "at cost". Loop: spend → refill → spend; the portfolio grows by the starter wallet each round, forever.
func TestBrutalNightsRefillLoop(t *testing.T) {
	a := newNightsAPI(t)
	for i := 0; i < 20; i++ {
		w := a.me().Wallet
		a.night(jsonOf(map[string]any{"cash": 0, "bought": map[string]Holding{"tsla": {Qty: 1, Cost: w}}}))
		req, _ := http.NewRequest("POST", a.url+"/api/wallet/refill", nil)
		req.Header.Set("Authorization", "Bearer "+a.tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
	if p := a.me(); p.Portfolio["tsla"].Cost > 2*startWallet {
		t.Errorf("refill loop: portfolio cost basis %d from a %d starter wallet (wallet %d)",
			p.Portfolio["tsla"].Cost, startWallet, p.Wallet)
	}
}
