package main

// Adversarial tests for real-stock sales, the warehouse, reconciliation, leases and the cutover migration.
// Tests named TestBrutalBug* assert the correct behaviour and FAIL on main: each one is a bug found here.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"math/rand"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------- helpers ----------

// books: the money and units invariants that must hold after anything.
type books struct {
	userCredits, heldCredits, platform int64
	ledgerCredits                      int64
	onHand, reserved, backed           int64
}

func readBooks(t *testing.T, s *store) books {
	t.Helper()
	var b books
	err := s.db.QueryRow(`SELECT
		COALESCE((SELECT SUM(credits) FROM users), 0),
		COALESCE((SELECT SUM(price * qty) FROM sales WHERE status = 'held'), 0),
		COALESCE((SELECT SUM(delta) FROM platform_ledger), 0),
		COALESCE((SELECT SUM(delta) FROM ledger WHERE currency = 'credit'), 0),
		COALESCE((SELECT SUM(qty) FROM platform_stock WHERE token = 'tsla'), 0),
		COALESCE((SELECT SUM(reserved) FROM platform_stock WHERE token = 'tsla'), 0),
		COALESCE((SELECT SUM(qty) FROM backed_units WHERE token = 'tsla'), 0)`).
		Scan(&b.userCredits, &b.heldCredits, &b.platform, &b.ledgerCredits, &b.onHand, &b.reserved, &b.backed)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// checkBooks: credits only move between players, holds and the platform; units only between shelf, hold, buyers.
func checkBooks(t *testing.T, s *store, totalMoney, totalUnits int64) {
	t.Helper()
	b := readBooks(t, s)
	if b.userCredits != b.ledgerCredits {
		t.Errorf("credits %d != credit ledger %d", b.userCredits, b.ledgerCredits)
	}
	if got := b.userCredits + b.heldCredits + b.platform; got != totalMoney {
		t.Errorf("money: credits %d + held %d + platform %d = %d, want %d", b.userCredits, b.heldCredits, b.platform, got, totalMoney)
	}
	if got := b.onHand + b.reserved + b.backed; got != totalUnits || b.onHand < 0 || b.reserved < 0 {
		t.Errorf("units: on hand %d + reserved %d + buyers %d = %d, want %d", b.onHand, b.reserved, b.backed, got, totalUnits)
	}
	var held int64
	s.db.QueryRow(`SELECT COALESCE(SUM(qty), 0) FROM sales WHERE status = 'held'`).Scan(&held)
	if held != b.reserved {
		t.Errorf("held sales %d units, warehouse reserved %d", held, b.reserved)
	}
}

func parallel(n int, f func(i int)) {
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			f(i)
		}()
	}
	close(start)
	wg.Wait()
}

func livePrices(t *testing.T, c *city, price int64) {
	t.Helper()
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": price}, market, c.now); err != nil {
		t.Fatal(err)
	}
	if err := c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": price}, market, c.now); err != nil {
		t.Fatal(err)
	}
}

// ---------- concurrency: double spend, oversell ----------

// One guest with 1,000 credits fires 40 buys at once across the party and the shop at 110 a unit: 9 at most.
func TestBrutalConcurrentDoubleSpend(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 110)
	var ok atomic.Int64
	parallel(40, func(i int) {
		var err error
		if i%2 == 0 {
			_, err = c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 110, market, c.at(5))
		} else {
			_, err = c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 110, market, c.now)
		}
		if err == nil {
			ok.Add(1)
		} else if !errors.Is(err, errRejected) {
			t.Errorf("buy %d: %v", i, err)
		}
	})
	if ok.Load() != 9 {
		t.Fatalf("%d buys of 110 went through on 1,000 credits", ok.Load())
	}
	if cr := credits(t, c.s, "g"); cr != 10 {
		t.Fatalf("credits left %d", cr)
	}
	checkBooks(t, c.s, 1000, 10)
}

// 25 funded buyers race for 10 units (party and shop share the warehouse): exactly 10 sold, never negative.
func TestBrutalConcurrentOversell(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	for i := range 25 {
		fund(t, c.s, "b"+string(rune('a'+i)), 1000)
	}
	var sold, out atomic.Int64
	parallel(25, func(i int) {
		who := "b" + string(rune('a'+i))
		var err error
		qty := int64(1 + i%3)
		if i%2 == 0 {
			_, err = c.s.BuyAtParty(ctx, who, c.party, "tsla", qty, 50, market, c.at(5))
		} else {
			_, err = c.s.BuyAtShop(ctx, who, c.lease, "tsla", qty, 50, market, c.now)
		}
		switch {
		case err == nil:
			sold.Add(qty)
		case errors.Is(err, errSoldOut):
			out.Add(1)
		default:
			t.Errorf("%s: %v", who, err)
		}
	})
	if sold.Load() > 10 {
		t.Fatalf("oversold: %d units from a warehouse of 10", sold.Load())
	}
	checkBooks(t, c.s, 1000+25*1000, 10)
	// Every refused buyer kept every credit.
	if n := count(t, c.s, `SELECT COUNT(*) FROM users WHERE id LIKE 'b%' AND credits NOT IN (1000, 950, 900, 850)`); n != 0 {
		t.Fatalf("%d buyers with odd balances", n)
	}
}

// Settlement, admin voids and repeated settlement jobs all at once: each sale ends settled XOR void, once.
func TestBrutalSettleVoidRace(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	var ids []int64
	for range 5 {
		s, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 2, 50, market, c.at(5))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.ID)
	}
	end := c.at(60 + game.city.Party.SettleGraceMinutes)
	parallel(30, func(i int) {
		if i%3 == 0 {
			c.s.SettleParties(ctx, end)
		} else {
			c.s.VoidSale(ctx, "admin@x", ids[i%len(ids)], "race")
		}
	})
	for _, id := range ids {
		ref := "sale:" + jsonInt(id)
		refunds := count(t, c.s, `SELECT COUNT(*) FROM ledger WHERE kind = 'refund' AND reason = ?`, ref)
		margins := count(t, c.s, `SELECT COUNT(*) FROM ledger WHERE kind = 'margin' AND reason = ?`, ref)
		whole := count(t, c.s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'wholesale' AND ref = ?`, ref)
		if refunds+whole != 1 || margins != whole {
			t.Errorf("sale %d: %d refunds, %d margins, %d wholesale rows", id, refunds, margins, whole)
		}
	}
	checkBooks(t, c.s, 1000, 10)
	if n := count(t, c.s, `SELECT COUNT(*) FROM sales WHERE status = 'held'`); n != 0 {
		t.Fatalf("%d sales still held", n)
	}
}

func TestBrutalSettleTwiceVoidAfterSettleSettleAfterVoid(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	a, _ := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 2, 50, market, c.at(1))
	b, _ := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(2))
	if err := c.s.VoidSale(ctx, "admin@x", b.ID, "guest asked"); err != nil {
		t.Fatal(err)
	}
	end := c.at(60 + game.city.Party.SettleGraceMinutes)
	if n, err := c.s.SettleParties(ctx, end); err != nil || n != 1 {
		t.Fatalf("settled %d %v", n, err)
	}
	if n, err := c.s.SettleParties(ctx, end.Add(time.Hour)); err != nil || n != 0 {
		t.Fatalf("settled again %d %v", n, err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", a.ID, "too late"); !errors.Is(err, errNotFound) {
		t.Fatalf("void after settle: %v", err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", b.ID, "again"); !errors.Is(err, errNotFound) {
		t.Fatalf("void twice: %v", err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", 999, "no such sale"); !errors.Is(err, errNotFound) {
		t.Fatalf("void unknown: %v", err)
	}
	if err := c.s.VoidSale(ctx, "admin@x", a.ID, strings.Repeat("x", 201)); !errors.Is(err, errBad) {
		t.Fatalf("long reason: %v", err)
	}
	checkBooks(t, c.s, 1000, 10)
	if cr := credits(t, c.s, "g"); cr != 900 {
		t.Fatalf("guest %d", cr)
	}
}

// ---------- inputs ----------

func TestBrutalHostileQuantitiesAndPrices(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	before := readBooks(t, c.s)
	for _, q := range []int64{0, -1, -50, game.city.Shop.MaxBuy + 1, math.MaxInt64, math.MinInt64} {
		if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", q, 50, market, c.at(5)); !errors.Is(err, errBad) {
			t.Errorf("party qty %d: %v", q, err)
		}
		if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", q, 50, market, c.now); !errors.Is(err, errBad) {
			t.Errorf("shop qty %d: %v", q, err)
		}
	}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, -1, market, c.now); !errors.Is(err, errBad) {
		t.Errorf("negative maxPrice: %v", err)
	}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 49, market, c.now); !errors.Is(err, errPriceChanged) {
		t.Errorf("maxPrice under the price: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "TSLA", 1, 50, market, c.at(5)); !errors.Is(err, errRejected) {
		t.Errorf("token case games: %v", err)
	}
	for name, p := range map[string]float64{"NaN": math.NaN(), "+Inf": math.Inf(1), "-Inf": math.Inf(-1), "neg": -371.5,
		"zero": 0, "absurd": 1e300, "just over the cap": 10_000_000.01} {
		q := map[string]float64{"TSLA": p}
		if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 50, q, c.now); !errors.Is(err, errNoPrice) {
			t.Errorf("quote %s: %v", name, err)
		}
		if err := c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 50}, q, c.now); !errors.Is(err, errNoPrice) {
			t.Errorf("set prices on quote %s: %v", name, err)
		}
	}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 50, map[string]float64{}, c.now); !errors.Is(err, errNoPrice) {
		t.Errorf("no quote: %v", err)
	}
	for name, p := range map[string]map[string]int64{
		"zero": {"tsla": 0}, "negative": {"tsla": -50}, "under wholesale": {"tsla": wholesaleTSLA - 1},
		"over 3x": {"tsla": 3*wholesaleTSLA + 1}, "huge": {"tsla": math.MaxInt64}, "unknown token": {"zzz": 50},
		"too many": {"tsla": 50, "nvda": 50},
	} {
		if err := c.s.SetShopPrices(ctx, "ceo", c.lease, p, market, c.now); err == nil {
			t.Errorf("shop prices %s accepted", name)
		}
	}
	if after := readBooks(t, c.s); after != before {
		t.Fatalf("refusals changed the books: %+v → %+v", before, after)
	}
}

// ---------- party timing ----------

func TestBrutalPartyWindowAndCancelBoundary(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	buy := func(min int) error {
		_, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(min))
		return err
	}
	if err := buy(-1); !errors.Is(err, errNotLive) {
		t.Errorf("before start: %v", err)
	}
	if err := buy(60); !errors.Is(err, errNotLive) {
		t.Errorf("at the end: %v", err)
	}
	if err := buy(0); err != nil {
		t.Errorf("at the start: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "ceo", c.party, "tsla", 1, 50, market, c.at(5)); !errors.Is(err, errRejected) {
		t.Errorf("host buys at own party: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", 9999, "tsla", 1, 50, market, c.at(5)); !errors.Is(err, errNotFound) {
		t.Errorf("no such party: %v", err)
	}
	// The host can't cancel at exactly starts_at (a guest may already have bought in that second).
	if err := c.s.CancelEvent(ctx, "ceo", c.party, c.at(0)); !errors.Is(err, errStarted) {
		t.Errorf("cancel at starts_at: %v", err)
	}
	if err := c.s.CancelEvent(ctx, "g", c.party, c.now); !errors.Is(err, errNotFound) {
		t.Errorf("a guest cancels: %v", err)
	}
	// A practice-club party (no lease) sells no real stock, even with a price row forced in.
	res, _ := c.s.db.Exec(`INSERT INTO parties (lease_id, host_id, club, level, starts_at, minutes, created_at, invite)
		VALUES (0, 'ceo', 'Practice', 3, ?, 60, ?, 'prac1')`, c.now.Unix()-60, c.now.Unix())
	practice, _ := res.LastInsertId()
	c.s.db.Exec(`INSERT INTO party_prices VALUES (?, 'tsla', 50)`, practice)
	if _, err := c.s.BuyAtParty(ctx, "g", practice, "tsla", 1, 50, market, c.now); !errors.Is(err, errNotLive) {
		t.Errorf("practice club: %v", err)
	}
	// Evicted mid-party: the party is cancelled and its held sale refunded at settlement.
	if err := c.s.EndLease(ctx, "admin@x", c.lease, "abuse", c.at(10)); err != nil {
		t.Fatal(err)
	}
	if err := buy(11); !errors.Is(err, errNotLive) {
		t.Errorf("after eviction: %v", err)
	}
	if _, err := c.s.SettleParties(ctx, c.at(11)); err != nil {
		t.Fatal(err)
	}
	if cr := credits(t, c.s, "g"); cr != 1000 {
		t.Errorf("guest after the evicted party: %d", cr)
	}
	checkBooks(t, c.s, 1000, 10)
}

// ---------- rounding ----------

// Every settled sale: what the buyer paid == the CEO's margin + the platform's wholesale, to the credit.
func TestBrutalSplitsAlwaysSumToTheAmount(t *testing.T) {
	c := newCity(t)
	c.run(func(tx *sql.Tx) error { return creditLedger(tx, "g", 1_000_000_000_000, "topup", "", "big") })
	c.run(func(tx *sql.Tx) error { return moveStock(tx, "tsla", 100_000, "restock", "", "agent", "test", "0xbig") })
	r := rand.New(rand.NewSource(7))
	for i := range 300 {
		usd := math.Round(r.Float64()*999_999) / 100 // $0.00 … $9,999.99
		if i%10 == 0 {
			usd = r.Float64() * 10 // tiny and odd decimals
		}
		q := map[string]float64{"TSLA": usd}
		w, err := wholesaleOf("tsla", q)
		if err != nil {
			continue
		}
		price := w + r.Int63n(2*w+1)
		qty := 1 + r.Int63n(game.city.Shop.MaxBuy)
		if err := c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": price}, q, c.now); err != nil {
			t.Fatalf("$%v: price %d (w %d): %v", usd, price, w, err)
		}
		g0, ceo0 := credits(t, c.s, "g"), credits(t, c.s, "ceo")
		var p0 int64
		c.s.db.QueryRow(`SELECT COALESCE(SUM(delta), 0) FROM platform_ledger`).Scan(&p0)
		sale, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", qty, price, q, c.now)
		if err != nil {
			t.Fatalf("$%v: %v", usd, err)
		}
		var p1 int64
		c.s.db.QueryRow(`SELECT COALESCE(SUM(delta), 0) FROM platform_ledger`).Scan(&p1)
		paid, margin, whole := g0-credits(t, c.s, "g"), credits(t, c.s, "ceo")-ceo0, p1-p0
		if paid != price*qty || margin+whole != paid || whole != sale.Wholesale*qty || margin < 0 {
			t.Fatalf("$%v ×%d at %d: paid %d = margin %d + wholesale %d?", usd, qty, price, paid, margin, whole)
		}
	}
	checkBooks(t, c.s, 1000+1_000_000_000_000, 100_010)
}

// payments.md: wholesale = live price × 0.001 × 100, ROUNDED UP. The code first rounds the per-share price to the
// nearest cent, so prices with sub-cent decimals sell a unit for less than it costs (by < 0.0005 credit).
func TestBrutalBugWholesaleNeverBelowCost(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for range 200_000 {
		usd := float64(r.Int63n(10_000_000)) / 1000 // three decimals, as an API may quote
		w, err := wholesaleOf("tsla", map[string]float64{"TSLA": usd})
		if err != nil {
			continue
		}
		cost := new(big.Rat).Mul(new(big.Rat).SetFloat64(usd), big.NewRat(1, 10)) // credits per unit
		if new(big.Rat).SetInt64(w).Cmp(cost) < 0 {
			t.Fatalf("$%.3f a share: a unit wholesales at %d credits, it costs %s", usd, w, cost.FloatString(4))
		}
	}
}

// payments.md: the CEO's price is at most 3× wholesale. A shop's price is checked only when it is set; after the
// market falls the shop keeps selling far above the cap.
func TestBrutalBugShopMarkupCapNotEnforcedAtSale(t *testing.T) {
	c := newCity(t)
	if err := c.s.SetShopPrices(ctx, "ceo", c.lease, map[string]int64{"tsla": 3 * wholesaleTSLA}, market, c.now); err != nil {
		t.Fatal(err)
	}
	crash := map[string]float64{"TSLA": 100} // wholesale 10
	w, _ := wholesaleOf("tsla", crash)
	sale, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 3*wholesaleTSLA, crash, c.now)
	if err == nil {
		t.Fatalf("sold at %d credits = %.1f× today's wholesale %d (cap %.0f×)", sale.Price,
			float64(sale.Price)/float64(w), w, game.city.Shop.MaxMarkup)
	}
}

// ---------- the pause ----------

// hookConnector wraps the sqlite driver so a test can run a statement on the api's single connection right after
// a given query's rows close: another request being served in between two of a handler's statements.
type hookConnector struct {
	drv   driver.Driver
	dsn   string
	match string
	then  string
	fired atomic.Bool
}

func (h *hookConnector) Connect(context.Context) (driver.Conn, error) {
	c, err := h.drv.Open(h.dsn)
	if err != nil {
		return nil, err
	}
	return &hookConn{Conn: c, h: h}, nil
}
func (h *hookConnector) Driver() driver.Driver { return h.drv }

type hookConn struct {
	driver.Conn
	h *hookConnector
}

func (c *hookConn) BeginTx(ctx context.Context, o driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, o)
}
func (c *hookConn) PrepareContext(ctx context.Context, q string) (driver.Stmt, error) {
	return c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, q)
}
func (c *hookConn) ExecContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Result, error) {
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, a)
}
func (c *hookConn) QueryContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Rows, error) {
	rows, err := c.Conn.(driver.QueryerContext).QueryContext(ctx, q, a)
	if err != nil || !strings.Contains(q, c.h.match) {
		return rows, err
	}
	return &hookRows{Rows: rows, done: func() {
		if c.h.fired.CompareAndSwap(false, true) {
			if _, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, c.h.then, nil); err != nil {
				panic(err)
			}
		}
	}}, nil
}

type hookRows struct {
	driver.Rows
	done func()
}

func (r *hookRows) Close() error {
	err := r.Rows.Close()
	r.done()
	return err
}

// hooked: a second store on the same database file whose connection runs `then` right after `match`.
func hooked(t *testing.T, s *store, match, then string) *store {
	t.Helper()
	var path string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name = 'main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	d, _ := sql.Open("sqlite", ":memory:")
	drv := d.Driver()
	d.Close()
	db := sql.OpenDB(&hookConnector{drv: drv, dsn: "file:" + path + "?_pragma=busy_timeout(5000)", match: match, then: then})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return &store{db}
}

// A mismatch pauses sales, but the pause is read outside the purchase's transaction: a reconciliation that
// pauses between that read and the purchase's commit doesn't stop it.
func TestBrutalBugBuySlipsThroughPause(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 50)
	pause := `INSERT INTO settings (key, value, updated_at) VALUES ('` + pauseKey + `', '["credits short"]', 1)`
	for name, buy := range map[string]func(s *store) (Sale, error){
		"shop": func(s *store) (Sale, error) { return s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 50, market, c.now) },
		"party": func(s *store) (Sale, error) {
			return s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(5))
		},
	} {
		c.s.db.Exec(`DELETE FROM settings WHERE key = ?`, pauseKey)
		s := hooked(t, c.s, "FROM settings WHERE key", pause)
		sale, err := buy(s)
		why, _ := c.s.Paused(ctx)
		if why == nil {
			t.Fatalf("%s: the hook didn't pause", name)
		}
		if !errors.Is(err, errPaused) {
			t.Errorf("%s: sale %d committed after payments were paused (err %v)", name, sale.ID, err)
		}
	}
}

// ---------- reconciliation ----------

// A whole day of city money (holds, settlement, shop sales, voids, rent, a cancelled party) never trips the check.
func TestBrutalReconcileNoFalsePositives(t *testing.T) {
	c, ch, a, b := reconCity(t)
	walletHolds(a, b, 1000, 10)
	livePrices(t, c, 50)
	check := func(step string) {
		t.Helper()
		r, err := c.s.Reconcile(ctx, ch, "system", step, c.now)
		if err != nil || !r.OK {
			t.Fatalf("%s: %+v %v", step, r, err)
		}
	}
	check("start")
	s1, _ := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 3, 50, market, c.at(5))
	check("held")
	s2, _ := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 50, market, c.at(6))
	c.s.VoidSale(ctx, "admin@x", s2.ID, "test")
	check("voided")
	c.s.SettleParties(ctx, c.at(200))
	check("settled")
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 2, 50, market, c.now); err != nil {
		t.Fatal(err)
	}
	check("shop")
	if _, err := c.s.Lease(ctx, "g", 1, 0, "Mine", 1, c.now); err != nil {
		t.Fatal(err)
	}
	check("rent")
	if s1.ID == 0 {
		t.Fatal("no sale")
	}
	checkBooks(t, c.s, 1000, 10)
}

// The team's seed booked from a player's top-up tx (one the api hasn't seen yet) and then the player's report of
// the same tx: both count the same dollars, the platform's and the player's.
func TestBrutalBugSeedThenTopupSameTx(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	s.Get(ctx, "p")
	s.SetIdentity(ctx, "p", "", player, now)
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	a.receipts[usdcTx], b.receipts[usdcTx] = topupReceipt(t), topupReceipt(t)
	ch := newBSC(a.serve(t), b.serve(t))
	seed, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "first stock", now)
	if err != nil {
		t.Fatal(err)
	}
	tr := Transfer{Tx: usdcTx, Token: strings.ToLower(game.payments.Topup.Tokens["USDC"]), From: player,
		To: strings.ToLower(game.payments.AgenticWallet), Amount: new(big.Int).Mul(big.NewInt(seed), big.NewInt(1e16))}
	_, _, err = s.recordTopup(ctx, tr, 0, "p", now)
	if cr := credits(t, s, "p"); cr > 0 {
		var platform int64
		s.db.QueryRow(`SELECT SUM(delta) FROM platform_ledger`).Scan(&platform)
		t.Errorf("one transfer of %d cents counted twice: seed (platform %d) and the player's %d credits (err %v)",
			seed, platform, cr, err)
	}
	walletHolds(a, b, seed, 0)
	if r, _ := s.Reconcile(ctx, ch, "system", "test", now); !r.OK {
		t.Logf("…and the next reconciliation pauses all payments: %v", r.Problems)
	}
}

// ---------- the warehouse ----------

// The same swap reported 8× at once (both letter cases): one restock.
func TestBrutalConcurrentRestockSameTx(t *testing.T) {
	s := testStore(t)
	c, _, _ := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	var ok atomic.Int64
	parallel(8, func(i int) {
		tx := usdcTx
		if i%2 == 1 {
			tx = "0x" + strings.ToUpper(usdcTx[2:])
		}
		_, err := s.VerifiedRestock(ctx, c, "agent", "tsla", tx, "", time.Now())
		if err == nil {
			ok.Add(1)
		} else if !errors.Is(err, errTxUsed) {
			t.Errorf("%d: %v", i, err)
		}
	})
	if q, _ := onHand(t, s, "tsla"); ok.Load() != 1 || q != 8 {
		t.Fatalf("%d restocks, %d units", ok.Load(), q)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'restock'`); n != 1 {
		t.Fatalf("%d restock spends", n)
	}
}

// A swap that bought some other token (not the whitelisted bStock contract) adds nothing.
func TestBrutalRestockWrongToken(t *testing.T) {
	s := testStore(t)
	var rc map[string]any
	json.Unmarshal([]byte(swapReceipt(t, 300, bought, game.payments.AgenticWallet)), &rc)
	rc["logs"].([]any)[1].(map[string]any)["address"] = "0x00000000000000000000000000000000000000d1"
	raw, _ := json.Marshal(rc)
	c, _, _ := restockChain(t, string(raw), usdcAt+20)
	if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); err == nil {
		t.Fatal("a swap for another token restocked TSLA")
	}
	if n := count(t, s, `SELECT COUNT(*) FROM stock_moves`) + count(t, s, `SELECT COUNT(*) FROM platform_ledger`); n != 0 {
		t.Fatalf("%d rows written", n)
	}
}

// ---------- leases ----------

// Ten extensions at once of a one-week lease: only up to maxWeeksAhead are bought, each charged once.
func TestBrutalConcurrentLeaseExtend(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	fund(t, s, "a", 100_000)
	if _, err := s.Lease(ctx, "a", 1, 1, "Booth", 1, now); err != nil {
		t.Fatal(err)
	}
	var ok atomic.Int64
	parallel(10, func(int) {
		if _, err := s.Lease(ctx, "a", 1, 1, "", 1, now); err == nil {
			ok.Add(1)
		}
	})
	rent := s.Rent(ctx)["1"]
	weeks := int64(game.city.MaxWeeksAhead)
	if ok.Load() != weeks-1 {
		t.Fatalf("%d extensions", ok.Load())
	}
	var ends, leaseRent, platform int64
	s.db.QueryRow(`SELECT ends_at, rent FROM leases WHERE user_id = 'a'`).Scan(&ends, &leaseRent)
	s.db.QueryRow(`SELECT SUM(delta) FROM platform_ledger WHERE kind = 'rent'`).Scan(&platform)
	if ends != now.Unix()+weeks*7*86400 || credits(t, s, "a") != 100_000-weeks*rent || platform != weeks*rent || leaseRent != weeks*rent {
		t.Fatalf("ends %d, credits %d, platform %d, lease rent %d", ends, credits(t, s, "a"), platform, leaseRent)
	}
	// Ten players race for one free venue: one wins, only the winner pays.
	for i := range 10 {
		fund(t, s, "r"+string(rune('a'+i)), 1000)
	}
	var won atomic.Int64
	parallel(10, func(i int) {
		if _, err := s.Lease(ctx, "r"+string(rune('a'+i)), 2, 1, "Mine", 1, now); err == nil {
			won.Add(1)
		}
	})
	if won.Load() != 1 || count(t, s, `SELECT COUNT(*) FROM users WHERE id LIKE 'r%' AND credits < 1000`) != 1 {
		t.Fatalf("%d won the same venue", won.Load())
	}
}

// ---------- migration 6 ----------

func cutoverDB(t *testing.T, seed string) *store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "live.db")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`PRAGMA user_version = 5;` + seed); err != nil {
		t.Fatal(err)
	}
	s.close()
	if s, err = openStore(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.close() })
	return s
}

// Odd shelves at the cutover: a shelf of a player that no longer exists, a negative quantity, a negative price.
// Every Coin change must have its ledger row, and no wallet may be charged by a buyback.
func TestBrutalBugCutoverOddShelves(t *testing.T) {
	s := cutoverDB(t, `
INSERT INTO users (id, wallet, created_at, updated_at) VALUES ('ceo', 1000, 1, 1), ('neg', 500, 1, 1);
INSERT INTO shop_stock (user_id, token, qty, price) VALUES
	('ghost', 'tsla', 5, 100), ('ceo', 'tsla', -3, 100), ('ceo', 'nvda', 1, 50), ('neg', 'tsla', 2, -300);`)
	if w := wallet(t, s, "ceo"); w != 1050 {
		t.Errorf("ceo wallet %d, want 1050 (the negative shelf is ignored)", w)
	}
	for _, id := range []string{"ceo", "neg"} {
		var start int64 = 1000
		if id == "neg" {
			start = 500
		}
		var logged int64
		s.db.QueryRow(`SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE user_id = ? AND kind = 'buyback'`, id).Scan(&logged)
		if w := wallet(t, s, id); w-start != logged || w < start {
			t.Errorf("%s: wallet %d → %d by the buyback, ledger says %+d", id, start, w, logged)
		}
	}
	if n := count(t, s, `SELECT COUNT(*) FROM shop_stock`); n != 0 {
		t.Errorf("%d shelves left", n)
	}
}

// Units reserved for held sales at the cutover are not counted against the verified swaps: the warehouse
// (on hand + reserved) ends above what the chain holds, and the first reconciliation pauses payments.
func TestBrutalBugCutoverIgnoresReserved(t *testing.T) {
	s := cutoverDB(t, `
INSERT INTO platform_stock (token, qty, updated_at, reserved) VALUES ('tsla', 103, 1, 5);
INSERT INTO stock_moves (token, delta, kind, actor, reason, tx, at) VALUES
	('tsla', 100, 'restock', 'boss', 'by hand', '', 1), ('tsla', 8, 'restock', 'agent', 'swap', '0xswap', 2);
INSERT INTO platform_ledger (delta, kind, ref, at) VALUES (-300, 'restock', '0xswap', 2);`)
	q, r := onHand(t, s, "tsla")
	if q+r > 8 {
		t.Errorf("after the cutover: %d on hand + %d reserved = %d units, only 8 were bought on chain", q, r, q+r)
	}
}

// Running the cutover again (a restored backup, a hand re-run) changes nothing.
func TestBrutalCutoverTwice(t *testing.T) {
	s := cutoverDB(t, `
INSERT INTO platform_stock (token, qty, updated_at) VALUES ('tsla', 108, 1);
INSERT INTO stock_moves (token, delta, kind, actor, reason, tx, at) VALUES
	('tsla', 100, 'restock', 'boss', 'by hand', '', 1), ('tsla', 8, 'restock', 'agent', 'swap', '0xswap', 2);
INSERT INTO platform_ledger (delta, kind, ref, at) VALUES (-300, 'restock', '0xswap', 2);
INSERT INTO users (id, wallet, created_at, updated_at) VALUES ('ceo', 1000, 1, 1);
INSERT INTO shop_stock (user_id, token, qty, price) VALUES ('ceo', 'tsla', 4, 250);`)
	snap := func() [4]int64 {
		q, _ := onHand(t, s, "tsla")
		return [4]int64{q, wallet(t, s, "ceo"), int64(count(t, s, `SELECT COUNT(*) FROM stock_moves`)),
			int64(count(t, s, `SELECT COUNT(*) FROM ledger`))}
	}
	first := snap()
	if first != [4]int64{8, 2000, 3, 1} {
		t.Fatalf("first run %v", first)
	}
	if _, err := s.db.Exec(migrations[5]); err != nil {
		t.Fatal(err)
	}
	if again := snap(); again != first {
		t.Fatalf("second run %v → %v", first, again)
	}
}
