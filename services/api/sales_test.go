package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TSLA at $371.50: one unit (0.001 share) wholesales at ceil(37.15) = 38 credits.
var market = map[string]float64{"TSLA": 371.5}

const wholesaleTSLA = 38

type city struct {
	t     *testing.T
	s     *store
	now   time.Time
	party int64
	lease int64
}

// newCity: a CEO ("ceo") with a rented venue and a party starting in an hour, a guest ("g") with 1,000 credits,
// and 10 TSLA units in the warehouse.
func newCity(t *testing.T) *city {
	s := testStore(t)
	now := time.Now()
	for _, id := range []string{"ceo", "g", "g2"} {
		s.Get(ctx, id)
	}
	c := &city{t: t, s: s, now: now}
	c.run(func(tx *sql.Tx) error { return creditLedger(tx, "g", 1000, "topup", "", "0xt") })
	c.run(func(tx *sql.Tx) error {
		return moveStock(tx, "tsla", 10, "restock", "", "agent", "test", "0xswap")
	})
	res, _ := s.db.Exec(`INSERT INTO leases (level, slot, user_id, club, rent, starts_at, ends_at, open)
		VALUES (3, 1, 'ceo', 'Nyx', 0, ?, ?, 1)`, now.Unix()-3600, now.Unix()+7*86400)
	c.lease, _ = res.LastInsertId()
	res, _ = s.db.Exec(`INSERT INTO parties (lease_id, host_id, starts_at, minutes, created_at, invite)
		VALUES (?, 'ceo', ?, 60, ?, 'inv1')`, c.lease, now.Unix()+3600, now.Unix())
	c.party, _ = res.LastInsertId()
	return c
}

func (c *city) run(f func(*sql.Tx) error) {
	c.t.Helper()
	if err := c.s.inTx(ctx, f); err != nil {
		c.t.Fatal(err)
	}
}

// at: the party's clock, minutes after it starts (negative: before).
func (c *city) at(min int) time.Time { return c.now.Add(time.Hour + time.Duration(min)*time.Minute) }

func (c *city) state() (cr, hand, held, units int64) {
	cr = credits(c.t, c.s, "g")
	hand, held = onHand(c.t, c.s, "tsla")
	c.s.db.QueryRow(`SELECT COALESCE(SUM(qty), 0) FROM backed_units WHERE user_id = 'g'`).Scan(&units)
	return
}

func TestPartyPrices(t *testing.T) {
	c := newCity(t)
	set := func(who string, p map[string]int64, when time.Time) error {
		return c.s.SetPartyPrices(ctx, who, c.party, p, market, when)
	}
	cases := map[string]error{
		"not the host":           set("g", map[string]int64{"tsla": 50}, c.now),
		"under wholesale":        set("ceo", map[string]int64{"tsla": wholesaleTSLA - 1}, c.now),
		"over 3× wholesale":      set("ceo", map[string]int64{"tsla": 3*wholesaleTSLA + 1}, c.now),
		"not whitelisted (nvda)": set("ceo", map[string]int64{"nvda": 50}, c.now),
		"after it started":       set("ceo", map[string]int64{"tsla": 50}, c.at(1)),
	}
	want := map[string]error{"not the host": errNotFound, "under wholesale": errBad, "over 3× wholesale": errBad,
		"not whitelisted (nvda)": errBad, "after it started": errPriceLocked}
	for name, err := range cases {
		if !errors.Is(err, want[name]) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := set("ceo", map[string]int64{"tsla": 50}, c.now); err != nil {
		t.Fatal(err)
	}
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, map[string]float64{}, c.now); !errors.Is(err, errNoPrice) {
		t.Fatalf("no live price: %v", err)
	}
}

func TestPartySaleHoldsThenSettlesOnce(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now); err != nil {
		t.Fatal(err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 3, 0, market, c.at(-5)); !errors.Is(err, errNotLive) {
		t.Fatalf("before it starts: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "ceo", c.party, "tsla", 1, 0, market, c.at(5)); !errors.Is(err, errRejected) {
		t.Fatalf("the host buying at their own party: %v", err)
	}
	sale, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 3, 0, market, c.at(5))
	if err != nil || sale.Price != 50 || sale.Wholesale != wholesaleTSLA || sale.Status != "held" {
		t.Fatalf("%+v %v", sale, err)
	}
	if cr, hand, held, units := c.state(); cr != 850 || hand != 7 || held != 3 || units != 0 {
		t.Fatalf("held: credits %d, on hand %d, reserved %d, units %d", cr, hand, held, units)
	}
	// Not yet: the party (60 min) + settleGraceMinutes hasn't passed. The host being gone changes nothing.
	grace := game.city.Party.SettleGraceMinutes
	if n, _ := c.s.SettleParties(ctx, c.at(60+grace-1)); n != 0 {
		t.Fatalf("settled %d too early", n)
	}
	for range 3 { // the job runs every minute: settling is exactly once
		c.s.SettleParties(ctx, c.at(60+grace+1))
	}
	if cr, hand, held, units := c.state(); cr != 850 || hand != 7 || held != 0 || units != 3 {
		t.Fatalf("settled: credits %d, on hand %d, reserved %d, units %d", cr, hand, held, units)
	}
	if m := credits(t, c.s, "ceo"); m != 3*(50-wholesaleTSLA) {
		t.Fatalf("CEO margin %d", m)
	}
	checks := map[string]int{
		`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'wholesale' AND delta = 114`: 1,
		`SELECT COUNT(*) FROM ledger WHERE kind = 'margin' AND delta = 36`:              1,
		`SELECT COUNT(*) FROM sales WHERE status = 'settled'`:                           1,
		`SELECT COUNT(*) FROM audit WHERE action = 'sale-settle'`:                       1,
	}
	for q, want := range checks {
		if n := count(t, c.s, q); n != want {
			t.Errorf("%s = %d, want %d", q, n, want)
		}
	}
}

func TestPartySaleOverspendAndOversell(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 110}, market, c.now); err != nil {
		t.Fatal(err)
	}
	start := [4]int64{}
	start[0], start[1], start[2], start[3] = c.state()
	// 10 × 110 = 1,100 credits: more than the guest's 1,000 (and all 10 units are there).
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 10, 0, market, c.at(5)); !errors.Is(err, errRejected) {
		t.Fatalf("overspend: %v", err)
	}
	// Enough credits (g2 gets 5,000) but 11 units: the warehouse has 10.
	c.run(func(tx *sql.Tx) error { return creditLedger(tx, "g2", 5000, "topup", "", "0xt2") })
	if _, err := c.s.BuyAtParty(ctx, "g2", c.party, "tsla", 11, 0, market, c.at(5)); !errors.Is(err, errSoldOut) {
		t.Fatalf("oversell: %v", err)
	}
	if got := credits(t, c.s, "g2"); got != 5000 {
		t.Fatalf("a refused purchase kept %d credits", 5000-got)
	}
	now := [4]int64{}
	now[0], now[1], now[2], now[3] = c.state()
	if now != start || count(t, c.s, `SELECT COUNT(*) FROM sales`) != 0 {
		t.Fatalf("refusals changed things: %v → %v", start, now)
	}
	// The market moved above the CEO's price: selling would lose money, so it doesn't.
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 0, map[string]float64{"TSLA": 1300}, c.at(5)); !errors.Is(err, errRejected) {
		t.Fatalf("price under today's wholesale: %v", err)
	}
	// Not on the menu.
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "nvda", 1, 0, market, c.at(5)); !errors.Is(err, errRejected) {
		t.Fatalf("not on the menu: %v", err)
	}
}

func TestVoidReleasesTheHold(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now); err != nil {
		t.Fatal(err)
	}
	sale, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 4, 0, market, c.at(5))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", sale.ID, ""); !errors.Is(err, errBad) {
		t.Fatalf("void without a reason: %v", err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", sale.ID, "guest complained"); err != nil {
		t.Fatal(err)
	}
	if cr, hand, held, units := c.state(); cr != 1000 || hand != 10 || held != 0 || units != 0 {
		t.Fatalf("after void: credits %d, on hand %d, reserved %d, units %d", cr, hand, held, units)
	}
	if err := c.s.VoidSale(ctx, "admin@x", sale.ID, "again"); !errors.Is(err, errNotFound) {
		t.Fatalf("void twice: %v", err)
	}
	if n, _ := c.s.SettleParties(ctx, c.at(200)); n != 0 {
		t.Fatalf("a voided sale settled: %d", n)
	}
	if credits(t, c.s, "ceo") != 0 {
		t.Fatal("the CEO got a margin on a voided sale")
	}
}

func TestShopSaleSettlesAtOnce(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetShopPrices(ctx, "g", c.lease, map[string]int64{"tsla": 45}, market, c.now); !errors.Is(err, errNotFound) {
		t.Fatalf("not the tenant: %v", err)
	}
	if err := c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 45}, market, c.now); err != nil {
		t.Fatal(err)
	}
	if _, err := c.s.BuyAtShop(ctx, "ceo", c.lease, "tsla", 1, 0, market, c.now); !errors.Is(err, errRejected) {
		t.Fatalf("buying in one's own shop: %v", err)
	}
	sale, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 2, 0, market, c.now)
	if err != nil || sale.Status != "settled" {
		t.Fatalf("%+v %v", sale, err)
	}
	if cr, hand, held, units := c.state(); cr != 910 || hand != 8 || held != 0 || units != 2 {
		t.Fatalf("credits %d, on hand %d, reserved %d, units %d", cr, hand, held, units)
	}
	if m := credits(t, c.s, "ceo"); m != 2*(45-wholesaleTSLA) {
		t.Fatalf("margin %d", m)
	}
	c.s.db.Exec(`UPDATE leases SET open = 0 WHERE id = ?`, c.lease)
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 0, market, c.now); !errors.Is(err, errNotFound) {
		t.Fatalf("a closed shop: %v", err)
	}
}

// Over HTTP: prices are public, buying needs a signed-in guest, the live price comes from the server's quotes.
func TestSalesEndpoints(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c := newCity(t)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now); err != nil {
		t.Fatal(err)
	}
	c.s.db.Exec(`UPDATE parties SET starts_at = ? WHERE id = ?`, time.Now().Unix()-60, c.party) // on now
	c.s.Get(ctx, "did:privy:abc")
	c.run(func(tx *sql.Tx) error { return creditLedger(tx, "did:privy:abc", 500, "topup", "", "0xt3") })
	open := cityOpen
	t.Cleanup(func() { cityOpen = open })
	cityOpen = false
	q := &quoter{key: "k", secret: "s", cache: &quotesResponse{Quotes: market, Source: "binance", At: time.Now().UnixMilli()}}
	srv := httptest.NewServer(routes(q, nil, fakePrivy(t, key), c.s, nil))
	defer srv.Close()
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	do := func(method, path string, body any) (int, map[string]any) {
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
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	pid := jsonInt(c.party)
	// The city is shut until top-ups are live: buying real stock is too.
	if code, out := do("POST", "/api/events/"+pid+"/buy", map[string]any{"token": "tsla", "qty": 1}); code != 403 || out["error"] != "city_closed" {
		t.Fatalf("city closed %d %v", code, out)
	}
	cityOpen = true
	if code, out := do("GET", "/api/events/prices/"+pid, nil); code != 200 ||
		out["prices"].(map[string]any)["tsla"] != float64(50) || out["wholesale"].(map[string]any)["tsla"] != float64(wholesaleTSLA) {
		t.Fatalf("prices %d %v", code, out)
	}
	// The buyer always says what they agreed to pay: without maxPrice there'd be no cap.
	if code, out := do("POST", "/api/events/"+pid+"/buy", map[string]any{"token": "tsla", "qty": 2}); code != 400 {
		t.Fatalf("no maxPrice %d %v", code, out)
	}
	if code, out := do("POST", "/api/events/"+pid+"/buy", map[string]any{"token": "tsla", "qty": 2, "maxPrice": 50}); code != 200 || out["credits"] != float64(400) {
		t.Fatalf("buy %d %v", code, out)
	}
	if code, out := do("POST", "/api/events/"+pid+"/buy", map[string]any{"token": "tsla", "qty": 20, "maxPrice": 50}); code != 422 {
		t.Fatalf("overspend %d %v", code, out)
	}
	// A private party's price list and stock are its invited guests' only.
	c.s.db.Exec(`UPDATE parties SET private = 1 WHERE id = ?`, c.party)
	if code, out := do("GET", "/api/events/prices/"+pid, nil); code != 404 {
		t.Fatalf("private prices, uninvited %d %v", code, out)
	}
	if code, out := do("POST", "/api/events/"+pid+"/buy", map[string]any{"token": "tsla", "qty": 1, "maxPrice": 50}); code != 404 {
		t.Fatalf("private buy, uninvited %d %v", code, out)
	}
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

// A cancelled party sold nothing: its held sales are voided at settlement, credits back to the guest.
func TestCancelledPartyRefunds(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now); err != nil {
		t.Fatal(err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 2, 0, market, c.at(5)); err != nil {
		t.Fatal(err)
	}
	c.s.db.Exec(`UPDATE parties SET cancelled = 1 WHERE id = ?`, c.party)
	if n, err := c.s.SettleParties(ctx, c.at(10)); err != nil || n != 0 {
		t.Fatalf("settled %d %v", n, err)
	}
	if cr, hand, held, units := c.state(); cr != 1000 || hand != 10 || held != 0 || units != 0 {
		t.Fatalf("after cancel: credits %d, on hand %d, reserved %d, units %d", cr, hand, held, units)
	}
	if credits(t, c.s, "ceo") != 0 || count(t, c.s, `SELECT COUNT(*) FROM sales WHERE status = 'void'`) != 1 {
		t.Fatal("a cancelled party paid out")
	}
}

// The buyer pays at most the price they saw; a shop's price raised in between is refused.
func TestShopPriceChangedInBetween(t *testing.T) {
	c := newCity(t)
	c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 40}, market, c.now)
	c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 110}, market, c.now) // just before the buy
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 40, market, c.now); !errors.Is(err, errPriceChanged) {
		t.Fatalf("price raised under the buyer: %v", err)
	}
	if credits(t, c.s, "g") != 1000 {
		t.Fatal("charged anyway")
	}
}

// Real stock is never sold against a price that is old, missing or absurd.
func TestNoSaleWithoutAFreshSanePrice(t *testing.T) {
	stale := &quoter{key: "k", secret: "s", cache: &quotesResponse{Quotes: market, Source: "binance",
		At: time.Now().Add(-quoteMaxAge - time.Minute).UnixMilli()}}
	// The quoter would refetch an old cache: point it nowhere, so it serves the stale prices as when Binance is down.
	stale.client = &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("down") })}
	if q := freshQuotes(stale, time.Now()); len(q) != 0 {
		t.Fatalf("stale prices used: %v", q)
	}
	if _, err := wholesaleOf("tsla", map[string]float64{"TSLA": 1e20}); !errors.Is(err, errNoPrice) {
		t.Fatalf("absurd price: %v", err)
	}
	if _, err := wholesaleOf("tsla", map[string]float64{"TSLA": 0}); !errors.Is(err, errNoPrice) {
		t.Fatalf("zero price: %v", err)
	}
	// Whole-number rounding: $70.00 is 7 credits a unit, not 8 (float math made it 7.000…01).
	for price, want := range map[float64]int64{70: 7, 70.01: 8, 250.5: 26, 0.004: 1, 433.21: 44} {
		if w, err := wholesaleOf("tsla", map[string]float64{"TSLA": price}); err != nil || w != want {
			t.Fatalf("$%v: %d %v, want %d", price, w, err, want)
		}
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A private party is its host's and its invited guests' (the players who opened its invite link): nobody else
// may read its price list or buy at it, even knowing its (sequential) id. Public parties stay open to everyone.
func TestPrivatePartyNeedsAnInvite(t *testing.T) {
	c := newCity(t)
	c.s.db.Exec(`UPDATE parties SET private = 1 WHERE id = ?`, c.party)
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now); err != nil {
		t.Fatal(err)
	}
	c.run(func(tx *sql.Tx) error { return creditLedger(tx, "g2", 500, "topup", "", "0xt2") })
	if _, err := c.s.BuyAtParty(ctx, "g2", c.party, "tsla", 1, 50, market, c.at(5)); !errors.Is(err, errNotFound) {
		t.Fatalf("uninvited buy at a private party: %v", err)
	}
	if _, err := c.s.PartyPrices(ctx, "g2", c.party); !errors.Is(err, errNotFound) {
		t.Fatalf("uninvited read of a private price list: %v", err)
	}
	if _, err := c.s.PartyPrices(ctx, "", c.party); !errors.Is(err, errNotFound) {
		t.Fatalf("anonymous read of a private price list: %v", err)
	}
	if p, err := c.s.PartyPrices(ctx, "ceo", c.party); err != nil || p["tsla"] != 50 {
		t.Fatalf("the host's own price list: %v %v", p, err)
	}
	if credits(t, c.s, "g2") != 500 || count(t, c.s, `SELECT COUNT(*) FROM sales`) != 0 {
		t.Fatal("the refused buy left a trace")
	}
	// Opening the invite link is what lets a guest in, the same as for joining.
	if _, err := c.s.Invite(ctx, "g2", "inv1", c.now); err != nil {
		t.Fatal(err)
	}
	if p, err := c.s.PartyPrices(ctx, "g2", c.party); err != nil || p["tsla"] != 50 {
		t.Fatalf("invited read: %v %v", p, err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g2", c.party, "tsla", 1, 50, market, c.at(5)); err != nil {
		t.Fatalf("invited buy: %v", err)
	}
	// A public party needs no invite.
	c.s.db.Exec(`UPDATE parties SET private = 0 WHERE id = ?`, c.party)
	if _, err := c.s.PartyPrices(ctx, "", c.party); err != nil {
		t.Fatalf("public price list: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(5)); err != nil {
		t.Fatalf("public buy: %v", err)
	}
}

// An event's lease is a venue id (> 0) or none (0, a practice club): a negative one isn't a city party.
func TestEventLeaseMustNotBeNegative(t *testing.T) {
	c := newCity(t)
	if _, err := c.s.Event(ctx, "ceo", EventInput{Lease: -1, Club: "Fake", Level: 3, StartsAt: c.now.Unix() + 600, Minutes: 10}, c.now); !errors.Is(err, errBad) {
		t.Fatalf("negative lease: %v", err)
	}
	if n := count(t, c.s, `SELECT COUNT(*) FROM parties WHERE lease_id < 0`); n != 0 {
		t.Fatalf("%d parties stored with a negative lease", n)
	}
	// An old row pointing at no venue: setting its prices is a 404, not a raw database error.
	res, _ := c.s.db.Exec(`INSERT INTO parties (lease_id, host_id, starts_at, minutes, created_at, invite)
		VALUES (-1, 'ceo', ?, 60, ?, 'inv2')`, c.now.Unix()+3600, c.now.Unix())
	pid, _ := res.LastInsertId()
	if err := c.s.SetPartyPrices(ctx, "ceo", pid, map[string]int64{"tsla": 50}, market, c.now); !errors.Is(err, errNotFound) {
		t.Fatalf("prices at a party with no venue: %v", err)
	}
}

// A banned tenant changes nothing, so their shop and parties stop selling (and earning them a margin).
func TestBannedSellerSellsNothing(t *testing.T) {
	c := newCity(t)
	c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 45}, market, c.now)
	c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now)
	c.s.db.Exec(`UPDATE users SET banned = 1 WHERE id = 'ceo'`)
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 45, market, c.now); !errors.Is(err, errNotFound) {
		t.Fatalf("shop of a banned tenant: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(5)); !errors.Is(err, errNotLive) {
		t.Fatalf("party of a banned host: %v", err)
	}
	if credits(t, c.s, "g") != 1000 {
		t.Fatal("charged anyway")
	}
}

// Shop buys racing an eviction: once EndLease commits, no buy at that shop may settle (the margin would go to the
// evicted tenant). The lease check runs inside the buy's transaction.
func TestShopBuyRacingEviction(t *testing.T) {
	for range 40 {
		c := newCity(t)
		c.run(func(tx *sql.Tx) error { return moveStock(tx, "tsla", 500, "restock", "", "agent", "test", "0xswap2") })
		c.run(func(tx *sql.Tx) error { return creditLedger(tx, "g2", 100000, "topup", "", "0xt2") })
		c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 45}, market, c.now)
		var wg sync.WaitGroup
		for _, g := range []string{"g", "g2"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range 10 {
					c.s.BuyAtShop(ctx, g, c.lease, "tsla", 1, 45, market, c.now)
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.s.EndLease(ctx, "admin", c.lease, "fraud", c.now)
		}()
		wg.Wait()
		if n := count(t, c.s, `SELECT COUNT(*) FROM audit WHERE action = 'sale-settle'
			AND id > (SELECT id FROM audit WHERE action = 'end-lease')`); n != 0 {
			t.Fatalf("%d shop sales settled after the eviction", n)
		}
	}
}

// Settlement racing an admin cancel: once the cancel commits, the party's held sales are voided, never settled.
// The cancelled flag is read inside each party's settle transaction.
func TestSettleRacingAdminCancel(t *testing.T) {
	for range 40 {
		c := newCity(t)
		c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now)
		if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 2, 50, market, c.at(5)); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); c.s.SettleParties(ctx, c.at(200)) }()
		go func() { defer wg.Done(); c.s.AdminCancelParty(ctx, "admin", c.party, "fraud") }()
		wg.Wait()
		c.s.SettleParties(ctx, c.at(200))
		if n := count(t, c.s, `SELECT COUNT(*) FROM audit WHERE action = 'sale-settle'
			AND id > (SELECT id FROM audit WHERE action = 'cancel-party')`); n != 0 {
			t.Fatal("a sale settled after the admin cancelled its party")
		}
		if n := count(t, c.s, `SELECT COUNT(*) FROM sales WHERE status = 'held'`); n != 0 {
			t.Fatalf("%d sales still held", n)
		}
	}
}
