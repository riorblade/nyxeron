package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var flat factorFn = func(string) float64 { return 1 }

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
	for _, name := range []string{"tokens", "levels", "city", "strategy"} {
		a, _ := os.ReadFile(filepath.Join("gamedata", name+".json"))
		b, err := os.ReadFile(filepath.Join("..", "..", "packages", "core", "src", "data", name+".json"))
		if err != nil || !bytes.Equal(a, b) {
			t.Errorf("gamedata/%s.json differs: cp packages/core/src/data/%s.json services/api/gamedata/", name, name)
		}
	}
	// Same prices as packages/core/test/city.test.ts.
	if wholesale("tsla", 1, 1) >= shelfPrice("tsla", 1, 1) || shelfPrice("tsla", 1, 2) != 2*shelfPrice("tsla", 1, 1) {
		t.Fatal("city prices")
	}
	if f := spotFactorOf(map[string]float64{"SPY": 2, "QQQ": 1, "IWM": 1}, map[string]float64{"SPY": 1, "QQQ": 1, "IWM": 1}, "us500"); f != 1.5 {
		t.Fatalf("basket factor %v", f)
	}
}

func TestLeases(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	rent1 := game.city.Venues["1"].WeeklyRent
	p, err := s.Lease(ctx, "a", 1, 0, "Booth A", 1, now)
	if err != nil || p.Wallet != startWallet-rent1 {
		t.Fatalf("%+v %v", p, err)
	}
	// A taken venue can't be rented; nor something unaffordable.
	if _, err := s.Lease(ctx, "b", 1, 1, "Mine now", 1, now); !errors.Is(err, errConflict) {
		t.Fatalf("taken: %v", err)
	}
	if _, err := s.Lease(ctx, "b", 5, 0, "Too big", 1, now); !errors.Is(err, errRejected) {
		t.Fatalf("unaffordable: %v", err)
	}
	if wallet(t, s, "b") != startWallet {
		t.Fatal("failed rent must not charge")
	}
	// Extending adds weeks, up to the limit paid ahead.
	// Extending: the slot is already yours (slot 1 of Level 1).
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
	// Several venues per player, up to the limit.
	s.GrantCoins(ctx, "boss", "a", 1_000_000, "test")
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

func TestShop(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	if _, err := s.Stock(ctx, "a", "tsla", 10, flat, now); !errors.Is(err, errNoLease) {
		t.Fatalf("no venue: %v", err)
	}
	s.Lease(ctx, "a", 1, 0, "Booth", 1, now)
	// The platform's warehouse is empty until it is restocked.
	if _, err := s.Stock(ctx, "a", "tsla", 10, flat, now); !errors.Is(err, errSoldOut) {
		t.Fatalf("empty warehouse: %v", err)
	}
	if err := s.Restock(ctx, "boss", "tsla", 15, "restock", "launch", ""); err != nil {
		t.Fatal(err)
	}
	s.Restock(ctx, "boss", "us500", 5000, "restock", "launch", "")
	before := wallet(t, s, "a")
	if _, err := s.Stock(ctx, "a", "tsla", 10, flat, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Stock(ctx, "a", "tsla", 6, flat, now); !errors.Is(err, errSoldOut) {
		t.Fatalf("more than the warehouse has: %v", err)
	}
	if got := before - wallet(t, s, "a"); got != 10*wholesale("tsla", 1, 1) {
		t.Fatalf("stock cost %d", got)
	}
	if _, err := s.Stock(ctx, "a", "nvda", 1, flat, now); !errors.Is(err, errRejected) {
		t.Fatalf("level-2 token in a booth: %v", err)
	}
	if _, err := s.Stock(ctx, "a", "us500", game.levels["1"].Storage, flat, now); !errors.Is(err, errRejected) {
		t.Fatalf("over storage: %v", err)
	}
	// Prices: capped at maxMarkup × the usual.
	top := maxShelfPrice("tsla", 1, 1)
	if err := s.SetShop(ctx, "a", 1, nil, map[string]int64{"tsla": top + 1}, flat, now); !errors.Is(err, errBad) {
		t.Fatalf("overpriced: %v", err)
	}
	if err := s.SetShop(ctx, "a", 1, nil, map[string]int64{"tsla": top}, flat, now); err != nil {
		t.Fatal(err)
	}
	v, _ := s.City(ctx, "", false, now)
	lease := v.Venues[0].Lease
	if len(lease.Stock) != 1 || lease.Stock[0].Qty != 10 || lease.Stock[0].Price != top {
		t.Fatalf("%+v", lease.Stock)
	}

	// Another player buys while the owner is away: money to the owner, tokens to the buyer.
	owner := wallet(t, s, "a")
	p, err := s.ShopBuy(ctx, "b", lease.ID, "tsla", 3, now)
	if err != nil || p.Wallet != startWallet-3*top || p.Portfolio["tsla"] != (Holding{Qty: 3, Cost: 3 * top}) {
		t.Fatalf("%+v %v", p, err)
	}
	if wallet(t, s, "a") != owner+3*top {
		t.Fatal("owner not paid")
	}
	for name, try := range map[string]func() error{
		"own shop":     func() error { _, e := s.ShopBuy(ctx, "a", lease.ID, "tsla", 1, now); return e },
		"out of stock": func() error { _, e := s.ShopBuy(ctx, "b", lease.ID, "tsla", 8, now); return e },
	} {
		if err := try(); !errors.Is(err, errRejected) {
			t.Errorf("%s: %v", name, err)
		}
	}
	closed := false
	s.SetShop(ctx, "a", 1, &closed, nil, flat, now)
	if _, err := s.ShopBuy(ctx, "b", lease.ID, "tsla", 1, now); !errors.Is(err, errRejected) {
		t.Fatalf("closed shop: %v", err)
	}
}

func TestParties(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	start := now.Add(time.Hour).Unix()
	s.Lease(ctx, "small", 2, 0, "Shop", 1, now)
	if _, err := s.Event(ctx, "small", EventInput{Lease: 1, StartsAt: start, Minutes: 0, Title: ""}, now); !errors.Is(err, errRejected) {
		t.Fatalf("party at a shop: %v", err)
	}
	s.Get(ctx, "host")
	s.GrantCoins(ctx, "test", "host", 100_000, "test")
	if _, err := s.Lease(ctx, "host", 3, 0, "Neon Tap", 1, now); err != nil {
		t.Fatal(err)
	}
	hostLease := leaseOf(t, s, "host", now)
	p, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: start, Minutes: 0, Title: "Opening night"}, now)
	if err != nil || p.Minutes != game.city.Party.DefaultMinutes || p.Live || p.Club != "Neon Tap" {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: start+60, Minutes: 10, Title: ""}, now); !errors.Is(err, errConflict) {
		t.Fatalf("overlap: %v", err)
	}
	if _, err := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: now.Add(8*24*time.Hour).Unix(), Minutes: 10, Title: ""}, now); !errors.Is(err, errBad) {
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

	// A guest settles their night at the live party: the host gets what they spent.
	host := wallet(t, s, "host")
	s.Get(ctx, "guest")
	if _, err := s.Night(ctx, "guest", startWallet-1500, map[string]Holding{"tsla": {Qty: 1, Cost: 1000}}, 0, "ABC123"); err != nil {
		t.Fatal(err)
	}
	// time.Now() in Night is before the party in this test, so nothing is paid out yet.
	if wallet(t, s, "host") != host {
		t.Fatal("paid outside the party")
	}
}

// Party payout uses the real clock: a party that is on right now.
func TestPartyPaysHost(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	s.Get(ctx, "host")
	s.GrantCoins(ctx, "test", "host", 100_000, "test")
	s.Lease(ctx, "host", 3, 0, "Neon Tap", 1, now)
	hostLease := leaseOf(t, s, "host", now)
	p, _ := s.Event(ctx, "host", EventInput{Lease: hostLease, StartsAt: now.Unix(), Minutes: 10, Title: ""}, now)
	if err := s.EventRoom(ctx, "host", p.ID, "LIVE01", now); err != nil {
		t.Fatal(err)
	}
	host := wallet(t, s, "host")
	s.Get(ctx, "guest")
	if _, err := s.Night(ctx, "guest", startWallet-1500, nil, 0, "live01"); err != nil {
		t.Fatal(err)
	}
	if wallet(t, s, "host") != host+1500 {
		t.Fatalf("host %d, want %d", wallet(t, s, "host"), host+1500)
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

// The warehouse: CEOs' orders show up as demand; the agent restocks only with an on-chain purchase behind it.
func TestSupplyAndAgent(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	s.Restock(ctx, "boss", "tsla", 100, "restock", "launch", "")
	s.Lease(ctx, "a", 1, 0, "Booth", 1, now)
	s.Stock(ctx, "a", "tsla", 70, flat, now)
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
	if tsla.OnHand != 30 || tsla.InShops != 70 || tsla.Sold7d != 70 || tsla.Shops != 1 || tsla.Suggested != 0 {
		t.Fatalf("%+v", tsla)
	}
	// 10/day for 3 days = 30 on hand: none suggested; sell 21 more → 13/day × 3 = 39 − 9 = 30.
	s.Stock(ctx, "a", "tsla", 21, flat, now)
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
	if c := call("POST", "/api/agent/restock", "k-secret", `{"token":"tsla","qty":30,"tx":"0xabc"}`); c != 200 {
		t.Fatalf("restock: %d", c)
	}
	if sup, _ = s.Supply(ctx, now); sup.Moves[0].Actor != "agent" || sup.Moves[0].Tx != "0xabc" || sup.Moves[0].Delta != 30 {
		t.Fatalf("%+v", sup.Moves[0])
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
	s.Restock(ctx, "boss", "us500", 10_000, "restock", "launch", "")
	s.Get(ctx, "a")
	s.GrantCoins(ctx, "boss", "a", 1_000_000, "test")
	s.Lease(ctx, "a", 1, 1, "Booth", 1, now)
	s.Lease(ctx, "a", 2, 1, "Shop", 1, now)
	both := game.levels["1"].Storage + game.levels["2"].Storage
	if _, err := s.Stock(ctx, "a", "us500", both, flat, now); err != nil {
		t.Fatalf("combined storage: %v", err)
	}
	if _, err := s.Stock(ctx, "a", "us500", 1, flat, now); !errors.Is(err, errRejected) {
		t.Fatalf("past combined storage: %v", err)
	}
	// Leases 1 (booth) and 2 (shop): close one shop, the other stays open.
	closed := false
	if err := s.SetShop(ctx, "a", 1, &closed, nil, flat, now); err != nil {
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
	if err := s.SetShop(ctx, "b", 2, &closed, nil, flat, now); !errors.Is(err, errNoLease) {
		t.Fatalf("someone else's shop: %v", err)
	}
}
