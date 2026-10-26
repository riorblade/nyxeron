package main

import (
	"bytes"
	"database/sql"
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

// fund gives a player credits, as a verified top-up would (the city runs on credits since the cutover).
func fund(t *testing.T, s *store, id string, credits int64) {
	t.Helper()
	s.Get(ctx, id)
	if err := s.inTx(ctx, func(tx *sql.Tx) error { return creditLedger(tx, id, credits, "topup", "", "test") }); err != nil {
		t.Fatal(err)
	}
}

func wallet(t *testing.T, s *store, id string) int64 {
	t.Helper()
	p, err := s.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return p.Wallet
}

// gamedata/ must be an exact copy of the game's data, so the server settles with the browser's numbers.
func TestGameDataIsTheGamesData(t *testing.T) {
	for _, name := range []string{"tokens", "levels", "city", "strategy", "payments", "wardrobe"} {
		a, _ := os.ReadFile(filepath.Join("gamedata", name+".json"))
		b, err := os.ReadFile(filepath.Join("..", "..", "packages", "core", "src", "data", name+".json"))
		if err != nil || !bytes.Equal(a, b) {
			t.Errorf("gamedata/%s.json differs: cp packages/core/src/data/%s.json services/api/gamedata/", name, name)
		}
	}
}

func TestLeases(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	rent1 := s.Rent(ctx)["1"]
	if rent1 != game.payments.RentCredits["1"] {
		t.Fatalf("rent comes from payments.json: %d", rent1)
	}
	fund(t, s, "a", 1000)
	fund(t, s, "b", 500)
	p, err := s.Lease(ctx, "a", 1, 0, "Booth A", 1, now)
	if err != nil || credits(t, s, "a") != 1000-rent1 || p.Wallet != startWallet {
		t.Fatalf("rent is paid in credits, Coin untouched: %+v %v", p, err)
	}
	// A taken venue can't be rented; nor something unaffordable.
	if _, err := s.Lease(ctx, "b", 1, 1, "Mine now", 1, now); !errors.Is(err, errConflict) {
		t.Fatalf("taken: %v", err)
	}
	if _, err := s.Lease(ctx, "b", 5, 0, "Too big", 1, now); !errors.Is(err, errRejected) {
		t.Fatalf("unaffordable: %v", err)
	}
	if credits(t, s, "b") != 500 {
		t.Fatal("failed rent must not charge")
	}
	// Extending: the slot is already yours (slot 1 of Level 1), up to the limit paid ahead.
	if _, err := s.Lease(ctx, "a", 1, 1, "", 2, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lease(ctx, "a", 1, 1, "", 2, now); !errors.Is(err, errRejected) {
		t.Fatalf("beyond max weeks: %v", err)
	}
	v, _ := s.City(ctx, "a", false, now)
	l := v.Venues[0].Lease
	if l == nil || !l.Mine || l.Club != "Booth A" || l.EndsAt != now.Unix()+3*7*86400 || len(v.Venues) != 48 {
		t.Fatalf("%+v", l)
	}
	if total, week := s.Revenue(ctx, now); total != 3*rent1 || week != 3*rent1 {
		t.Fatalf("revenue %d %d", total, week)
	}
	// Rent is the platform's own money, so reconciliation counts it (it doesn't back players' credits).
	var platform, rows int64
	s.db.QueryRow(`SELECT COALESCE(SUM(delta), 0), COUNT(*) FROM platform_ledger WHERE kind = 'rent' AND ref = 'lease:1'`).Scan(&platform, &rows)
	if platform != 3*rent1 || rows != 2 {
		t.Fatalf("platform rent %d in %d rows, want %d in 2", platform, rows, 3*rent1)
	}
	// Several venues per player, up to the limit.
	fund(t, s, "a", 100_000)
	for i := 1; i < game.city.MaxVenues; i++ {
		if _, err := s.Lease(ctx, "a", 2, 0, "More", 1, now); err != nil {
			t.Fatalf("venue %d: %v", i+1, err)
		}
	}
	if _, err := s.Lease(ctx, "a", 2, 0, "One too many", 1, now); !errors.Is(err, errVenueLimit) {
		t.Fatalf("over the limit: %v", err)
	}
	if v, _ := s.City(ctx, "a", false, now); countMine(v) != game.city.MaxVenues {
		t.Fatalf("mine: %d", countMine(v))
	}
	// A lapsed lease frees the venue.
	if _, err := s.Lease(ctx, "b", 1, 1, "Next tenant", 1, now.Add(22*24*time.Hour)); err != nil {
		t.Fatalf("after expiry: %v", err)
	}
}

// A shop's shelves are its menu in credits, with what the platform's warehouse has (sales.go sells from it).
func TestShopShelves(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	fund(t, s, "a", 1000)
	s.Lease(ctx, "a", 1, 0, "Booth", 1, now)
	s.Restock(ctx, "boss", "tsla", 15, "restock", "launch", "")
	if err := s.SetShopPrices(ctx, "a", 1, map[string]int64{"tsla": 50}, market, now); err != nil {
		t.Fatal(err)
	}
	v, _ := s.City(ctx, "", false, now)
	if st := v.Venues[0].Lease.Stock; len(st) != 1 || st[0].Token != "tsla" || st[0].Qty != 15 || st[0].Price != 50 {
		t.Fatalf("%+v", st)
	}
	// A token sells only at venues of its level and up (tokens.json minLevel): a Level 1 booth can't list a
	// Level 2 token. An empty list takes everything off the menu.
	tsla := game.tokens["tsla"]
	game.tokens["tsla"] = tokenInfo{Ticker: tsla.Ticker, MinLevel: 2}
	err := s.SetShopPrices(ctx, "a", 1, map[string]int64{"tsla": 50}, market, now)
	game.tokens["tsla"] = tsla
	if !errors.Is(err, errBad) {
		t.Fatalf("above the venue's level: %v", err)
	}
	if err := s.SetShopPrices(ctx, "a", 1, map[string]int64{}, market, now); err != nil {
		t.Fatalf("empty menu: %v", err)
	}
	if v, _ := s.City(ctx, "", false, now); len(v.Venues[0].Lease.Stock) != 0 {
		t.Fatalf("menu not emptied: %+v", v.Venues[0].Lease.Stock)
	}
	closed := false
	if err := s.SetShop(ctx, "a", 1, &closed, now); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.City(ctx, "", false, now); v.Venues[0].Lease.Open {
		t.Fatal("closed shop still open")
	}
}

func TestParties(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	start := now.Add(time.Hour).Unix()
	fund(t, s, "small", 1000)
	s.Lease(ctx, "small", 2, 0, "Shop", 1, now)
	if _, err := s.Event(ctx, "small", EventInput{Lease: 1, StartsAt: start, Minutes: 0, Title: ""}, now); !errors.Is(err, errRejected) {
		t.Fatalf("party at a shop: %v", err)
	}
	fund(t, s, "host", 1000)
	if _, err := s.Lease(ctx, "host", 3, 0, "Neon Tap", 1, now); err != nil {
		t.Fatal(err)
	}
	hostLease := leaseOf(t, s, "host", now)
	p, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: start, Minutes: 0, Title: "Opening night"}, now)
	if err != nil || p.Minutes != game.city.Party.DefaultMinutes || p.Live || p.Club != "Neon Tap" {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: start + 60, Minutes: 10, Title: ""}, now); !errors.Is(err, errConflict) {
		t.Fatalf("overlap: %v", err)
	}
	if _, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: now.Add(8 * 24 * time.Hour).Unix(), Minutes: 10, Title: ""}, now); !errors.Is(err, errBad) {
		t.Fatalf("too far ahead: %v", err)
	}
	if err := s.EventRoom(ctx, "host", p.ID, "ABC123", now); !errors.Is(err, errRejected) {
		t.Fatalf("room before it starts: %v", err)
	}
	at := time.Unix(start+60, 0)
	if err := s.EventRoom(ctx, "intruder", p.ID, "ABC123", at); !errors.Is(err, errNotFound) {
		t.Fatalf("someone else's party: %v", err)
	}
	if err := s.EventRoom(ctx, "host", p.ID, "abc123", at); err != nil {
		t.Fatal(err)
	}
	v, _ := s.City(ctx, "", false, at)
	if len(v.Parties) != 1 || !v.Parties[0].Live || v.Parties[0].Room != "ABC123" {
		t.Fatalf("%+v", v.Parties)
	}

	// A guest settles their night at the live party: play money, nobody is paid Coin for it.
	host := wallet(t, s, "host")
	s.Get(ctx, "guest")
	if _, err := s.Night(ctx, "guest", startWallet-1500, map[string]Holding{"tsla": {Qty: 1, Cost: 1000}}, 0, "ABC123", now); err != nil {
		t.Fatal(err)
	}
	if wallet(t, s, "host") != host {
		t.Fatal("the host was paid Coin")
	}
}

// Since the cutover a live city party pays its host in credits through real sales (sales.go), never in Coin from
// guests' play nights.
func TestCityPartyPaysNoCoin(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	fund(t, s, "host", 1000)
	s.Lease(ctx, "host", 3, 0, "Neon Tap", 1, now)
	hostLease := leaseOf(t, s, "host", now)
	p, _ := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: now.Unix(), Minutes: 10, Title: ""}, now)
	if err := s.EventRoom(ctx, "host", p.ID, "LIVE01", now); err != nil {
		t.Fatal(err)
	}
	host := wallet(t, s, "host")
	s.Get(ctx, "guest")
	if _, err := s.Night(ctx, "guest", startWallet-1500, nil, -1500, "live01", now); err != nil {
		t.Fatal(err)
	}
	if wallet(t, s, "host") != host {
		t.Fatalf("host paid %d Coin", wallet(t, s, "host")-host)
	}
	// The back office can end a lease: the venue frees and upcoming parties are cancelled.
	v, _ := s.City(ctx, "", true, now)
	var lease int64
	for _, x := range v.Venues {
		if x.Lease != nil {
			lease = x.Lease.ID
			if x.Lease.OwnerID != "host" {
				t.Fatalf("admin view: %+v", x.Lease)
			}
		}
	}
	if err := s.EndLease(ctx, "boss", lease, "abuse", now); err != nil {
		t.Fatal(err)
	}
	if v.Venues[36].Level != 3 {
		t.Fatal("first Level 3 venue")
	}
	if v, _ = s.City(ctx, "", false, now.Add(time.Second)); len(v.Parties) != 0 || v.Venues[36].Lease != nil {
		t.Fatalf("after eviction: %+v", v.Parties)
	}
	if err := s.SetRent(ctx, "boss", map[string]int64{"5": 99}, "promo"); err != nil || s.Rent(ctx)["5"] != 99 {
		t.Fatalf("rent: %v", err)
	}
	if err := s.SetRent(ctx, "boss", map[string]int64{"9": 1}, "x"); !errors.Is(err, errBad) {
		t.Fatalf("unknown level: %v", err)
	}
}

func TestRename(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	if err := s.Rename(ctx, "a", 1, "Escala Bar", now); !errors.Is(err, errNoLease) {
		t.Fatalf("no venue: %v", err)
	}
	fund(t, s, "a", 1000)
	s.Lease(ctx, "a", 1, 0, "Booth", 1, now)
	if err := s.Rename(ctx, "a", 1, "  ", now); !errors.Is(err, errBad) {
		t.Fatalf("blank: %v", err)
	}
	if err := s.Rename(ctx, "a", 1, "Escala Bar", now); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.City(ctx, "a", false, now); v.Venues[0].Lease.Club != "Escala Bar" {
		t.Fatalf("%+v", v.Venues[0].Lease)
	}
}

// The warehouse: what players buy shows up as demand; the agent restocks only with an on-chain purchase behind it.
func TestSupplyAndAgent(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	s.Restock(ctx, "boss", "tsla", 100, "restock", "launch", "")
	fund(t, s, "a", 1000)
	fund(t, s, "b", 10_000)
	s.Lease(ctx, "a", 1, 0, "Booth", 1, now)
	s.SetShopPrices(ctx, "a", 1, map[string]int64{"tsla": 40}, market, now)
	buy := func(qty int64) {
		t.Helper()
		for qty > 0 {
			n := min(qty, game.city.Shop.MaxBuy)
			if _, err := s.BuyAtShop(ctx, "b", 1, "tsla", n, 0, market, now); err != nil {
				t.Fatal(err)
			}
			qty -= n
		}
	}
	buy(70)
	sup, err := s.Supply(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	var tsla SupplyRow
	for _, r := range sup.Tokens {
		if r.Token == "tsla" {
			tsla = r
		}
	}
	if tsla.OnHand != 30 || tsla.Sold7d != 70 || tsla.Sold24h != 70 || tsla.Suggested != 0 {
		t.Fatalf("%+v", tsla)
	}
	// 10/day for 3 days = 30 on hand: none suggested; sell 21 more → 13/day × 3 = 39 − 9 = 30.
	buy(21)
	sup, _ = s.Supply(ctx, now)
	for _, r := range sup.Tokens {
		if r.Token == "tsla" && (r.OnHand != 9 || r.Suggested != 30) {
			t.Fatalf("%+v", r)
		}
	}
	if err := s.Restock(ctx, "boss", "tsla", -10, "adjust", "count", ""); !errors.Is(err, errSoldOut) {
		t.Fatalf("below zero: %v", err)
	}
	if err := s.Restock(ctx, "boss", "doge", 1, "restock", "x", ""); !errors.Is(err, errBad) {
		t.Fatalf("unknown token: %v", err)
	}

	ag := &agent{key: "k-secret", db: s}
	mux := http.NewServeMux()
	ag.route(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	call := func(method, path, key, body string) int {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := call("GET", "/api/agent/demand", "wrong", ""); c != 401 {
		t.Fatalf("bad key: %d", c)
	}
	if c := call("GET", "/api/agent/demand", "k-secret", ""); c != 200 {
		t.Fatalf("demand: %d", c)
	}
	if c := call("POST", "/api/agent/restock", "k-secret", `{"token":"tsla","qty":30}`); c != 400 {
		t.Fatalf("restock without a tx: %d", c)
	}
	// A claimed purchase is not stock: the units come only from a swap verified on BSC (restock_test.go).
	if c := call("POST", "/api/agent/restock", "k-secret", `{"token":"tsla","qty":30,"tx":"0xabc"}`); c != 400 {
		t.Fatalf("restock with a made-up tx: %d", c)
	}
	tx := `"0x` + strings.Repeat("ab", 32) + `"`
	if c := call("POST", "/api/agent/restock", "k-secret", `{"token":"tsla","qty":30,"tx":`+tx+`}`); c != 503 {
		t.Fatalf("restock without BSC configured: %d", c)
	}
	sup, _ = s.Supply(ctx, now)
	for _, m := range sup.Moves {
		if m.Actor == "agent" {
			t.Fatalf("an unverified restock moved stock: %+v", m)
		}
	}
}

func countMine(v CityView) (n int) {
	for _, x := range v.Venues {
		if x.Lease != nil && x.Lease.Mine {
			n++
		}
	}
	return
}

// leaseOf: the id of a player's (first) active venue.
func leaseOf(t *testing.T, s *store, owner string, now time.Time) int64 {
	t.Helper()
	v, _ := s.City(ctx, owner, false, now)
	for _, x := range v.Venues {
		if x.Lease != nil && x.Lease.Mine {
			return x.Lease.ID
		}
	}
	t.Fatalf("%s rents nothing", owner)
	return 0
}

// Several venues: one stock pool whose storage is the venues' combined; each venue is managed on its own, and
// nobody can manage someone else's.
func TestManyVenues(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	fund(t, s, "a", 10_000)
	s.Lease(ctx, "a", 1, 1, "Booth", 1, now)
	s.Lease(ctx, "a", 2, 1, "Shop", 1, now)
	// Leases 1 (booth) and 2 (shop): close one shop, the other stays open.
	closed := false
	if err := s.SetShop(ctx, "a", 1, &closed, now); err != nil {
		t.Fatal(err)
	}
	v, _ := s.City(ctx, "", false, now)
	if v.Venues[0].Lease.Open || !v.Venues[24].Lease.Open {
		t.Fatalf("open: %v %v", v.Venues[0].Lease.Open, v.Venues[24].Lease.Open)
	}
	s.Get(ctx, "b")
	if err := s.Rename(ctx, "b", 2, "Stolen", now); !errors.Is(err, errNoLease) {
		t.Fatalf("someone else's venue: %v", err)
	}
	if err := s.SetShop(ctx, "b", 2, &closed, now); !errors.Is(err, errNoLease) {
		t.Fatalf("someone else's shop: %v", err)
	}
}

// The back office sets how many venues each level has; a level can't shrink below its highest rented slot.
func TestVenueCounts(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	fund(t, s, "a", 10_000)
	if c := s.VenueCounts(ctx)["5"]; c != game.city.Venues["5"].Count {
		t.Fatalf("default L5 count %d", c)
	}
	// More Premium Venues: a third one can be rented straight away.
	if err := s.SetVenueCounts(ctx, "boss", map[string]int{"5": 3}, "demand", now); err != nil {
		t.Fatal(err)
	}
	v, _ := s.City(ctx, "", false, now)
	five := 0
	for _, x := range v.Venues {
		if x.Level == 5 {
			five++
		}
	}
	if five != 3 || v.Counts["5"] != 3 {
		t.Fatalf("L5 venues %d, counts %v", five, v.Counts)
	}
	if _, err := s.Lease(ctx, "a", 5, 3, "Third", 1, now); err != nil {
		t.Fatalf("rent the new slot: %v", err)
	}
	// Can't shrink below a rented slot; can't go to zero or past the cap; needs a reason; unknown level refused.
	for name, try := range map[string]struct {
		c   map[string]int
		r   string
		err error
	}{
		"below a rented slot": {map[string]int{"5": 2}, "x", errRejected},
		"zero":                {map[string]int{"5": 0}, "x", errBad},
		"over the cap":        {map[string]int{"1": maxVenuesPerLevel + 1}, "x", errBad},
		"no reason":           {map[string]int{"1": 30}, "", errBad},
		"unknown level":       {map[string]int{"9": 3}, "x", errBad},
	} {
		if err := s.SetVenueCounts(ctx, "boss", try.c, try.r, now); !errors.Is(err, try.err) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := s.SetVenueCounts(ctx, "boss", map[string]int{"5": 3, "1": 10}, "tidy", now); err != nil {
		t.Fatal(err)
	}
	if c := s.VenueCounts(ctx); c["1"] != 10 || c["5"] != 3 || c["2"] != game.city.Venues["2"].Count {
		t.Fatalf("%v", c)
	}
	if rows, _ := s.Audit(ctx, "", 10, 0); rows[0].Action != "venue-counts" || rows[0].Actor != "boss" {
		t.Fatalf("audit: %+v", rows[0])
	}
}

// The city runs on Credit only: until top-ups are live every city write answers 403 city_closed and GET says
// open: false.
func TestCityClosed(t *testing.T) {
	pl := &players{db: testStore(t)}
	mux := http.NewServeMux()
	pl.routeCity(mux)
	pl.routeSales(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/city/lease"}, {"PUT", "/api/city/venue"}, {"PUT", "/api/city/shop"},
		{"PUT", "/api/city/shops/1/prices"}, {"POST", "/api/city/shops/1/buy-credit"},
		{"PUT", "/api/events/1/prices"}, {"POST", "/api/events/1/buy"},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader(`{}`))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s: %d", c.method, c.path, res.StatusCode)
		}
	}
	// The Coin shop is gone since the cutover: a shop holds no stock and sells real stock in credits.
	for _, path := range []string{"/api/city/stock", "/api/city/shops/1/buy"} {
		res, _ := http.Post(srv.URL+path, "application/json", strings.NewReader(`{}`))
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("POST %s still answers %d", path, res.StatusCode)
		}
	}
	res, err := http.Get(srv.URL + "/api/city")
	if err != nil {
		t.Fatal(err)
	}
	var v CityView
	json.NewDecoder(res.Body).Decode(&v)
	res.Body.Close()
	if v.Open {
		t.Fatal("city should be closed")
	}
}

// The warehouse floor: an empty warehouse sells nothing, so without it the agent would never see demand.
func TestSupplyFloorForWhitelistedTokens(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	floor := game.payments.Agent.MinUnits
	if floor <= 0 {
		t.Fatalf("agent.minUnits = %d", floor)
	}
	suggested := func() map[string]int64 {
		t.Helper()
		sup, err := s.Supply(ctx, now)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]int64{}
		for _, r := range sup.Tokens {
			out[r.Token] = r.Suggested
		}
		return out
	}
	got := suggested()
	for tok, n := range got {
		_, white := game.payments.Tokens[tok]
		if want := map[bool]int64{true: floor, false: 0}[white]; n != want {
			t.Fatalf("empty warehouse: %s suggested %d, want %d", tok, n, want)
		}
	}
	s.Restock(ctx, "boss", "tsla", floor-3, "restock", "first", "")
	if n := suggested()["tsla"]; n != 3 {
		t.Fatalf("3 under the floor: suggested %d", n)
	}
	s.Restock(ctx, "boss", "tsla", 3, "restock", "second", "")
	if n := suggested()["tsla"]; n != 0 {
		t.Fatalf("at the floor: suggested %d", n)
	}
}
