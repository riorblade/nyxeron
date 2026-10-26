package main

// Review of PR #64: attacks beyond #38's brutal suite. A passing test proves an attack held; a failing test is a
// finding (see the comment on each).

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const rvStranger = "0x000000000000000000000000000000000000beef"

func rvCursor(t *testing.T, s *store) string {
	t.Helper()
	var v string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&v)
	return v
}

func rvSafe() string { return fmt.Sprint(usdcAt + 40 - game.payments.Confirmations + 1) }

// ---------- the scanner ----------

// FINDING (blocker): the receipt wedge of #38 has a twin one call earlier. eth_getLogs for a block whose
// Transfer logs to the Agentic Wallet exceed rpcMaxBytes is errUnreadable on both rpcs; scanRange returns it as is,
// the span halves to 1 and the cursor never moves past that block. Zero-value transfer(AW, 0) needs no balance and
// no allowance; ~8-10k of them in one block (a few contract calls, ~5k gas each, a few dollars of BNB) wedge the
// scanner for good. The zero-value skip runs after TransfersTo, so it doesn't help. A real deposit in a later block,
// never reported by its browser, is never credited.
func TestRV64ScannerWedgedByOversizedGetLogs(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	attack := bTx(0xa77ac2)
	var logs []bLog
	for i := range 10_000 {
		logs = append(logs, bLog{from: rvStranger, amount: big.NewInt(0), idx: uint64(i)})
	}
	rc := bReceipt(attack, usdcAt-1, logs...)
	if len(rc) <= 4<<20 {
		t.Fatalf("attack logs only %d bytes", len(rc))
	}
	x.put(attack, rc) // the victim's real, unreported deposit (usdcTx) is in the next block, usdcAt
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-2, time.Now())
	var err error
	for range 3 {
		err = x.db.scanTopups(ctx, c, time.Now())
	}
	if cur := rvCursor(t, x.db); cur != rvSafe() || credits(t, x.db, brutalMe) == 0 {
		t.Fatalf("scanner wedged by a block of zero-value Transfer logs: cursor %s (safe %s), victim credits %d, err %v",
			cur, rvSafe(), credits(t, x.db, brutalMe), err)
	}
}

// FINDING (medium): errUnreadable is any 200 answer that isn't JSON (or is > 4 MB). When both providers answer a
// real player's receipt with garbage at the same time (a shared CDN/WAF page, a truncated body), the scanner treats
// it as "the tx itself is unreadable": records it "unknown", moves the cursor on, and never looks at it again, even
// after the providers recover. The deposit is only credited if the player reports it again by hand.
func TestRV64GarbageFromBothProvidersIsNeverRetried(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	good := x.a.receipts[usdcTx]
	x.put(bTx(0x1095), good) // keeps the transfer in eth_getLogs (the fake reads logs from its receipts)
	x.put(usdcTx, `<html>502 Bad Gateway</html>`)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	_ = x.db.scanTopups(ctx, c, time.Now())
	x.put(usdcTx, good) // the providers recover
	x.a.head, x.b.head = usdcAt+60, usdcAt+60
	for range 2 {
		_ = x.db.scanTopups(ctx, c, time.Now())
	}
	if credits(t, x.db, brutalMe) == 0 {
		var st, why string
		x.db.db.QueryRow(`SELECT status, reason FROM topups WHERE tx = ?`, usdcTx).Scan(&st, &why)
		t.Fatalf("a real deposit read as garbage by both providers once is never credited by the scanner: %s %q", st, why)
	}
}

// FINDING (medium): the back office can't tell an unreadable real deposit from a stranger's transfer. The row's
// reason says "unreadable receipt" but Payments() (the admin's Payments page) never selects t.reason.
func TestRV64UnreadableRowShowsItsReasonInTheBackOffice(t *testing.T) {
	s := testStore(t)
	tr := Transfer{Tx: bTx(0x0b0), Token: usdcAddr(), From: player, To: game.payments.AgenticWallet, Amount: centsAmt(500)}
	if err := s.recordUnreadable(ctx, tr, errUnreadable, time.Now()); err != nil {
		t.Fatal(err)
	}
	p, err := s.Payments(ctx)
	if err != nil || len(p.Topups) != 1 {
		t.Fatalf("%v %+v", err, p.Topups)
	}
	if !strings.Contains(p.Topups[0].Reason, "unreadable") {
		t.Fatalf("back office row has no reason: %+v", p.Topups[0])
	}
}

// Held: a player who pads their own top-up into an unreadable receipt gets nothing: the scanner records it with
// no user and no credits, their report is 503 (a miss), and the cursor moves on. Dust (1 wei, not zero) in such a
// receipt is recorded too, so the zero-value skip isn't the only thing keeping the scanner going.
func TestRV64UnreadableReceiptGivesNoCredits(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	padded := bTx(0x9add)
	logs := []bLog{{from: player, amount: centsAmt(500), idx: 0}, {from: player, amount: big.NewInt(1), idx: 1},
		{from: player, amount: big.NewInt(0), idx: 2}}
	for i := 3; i <= 20_000; i++ {
		logs = append(logs, bLog{addr: "0x000000000000000000000000000000000000dead", idx: uint64(i)})
	}
	x.put(padded, bReceipt(padded, usdcAt, logs...))
	delete(x.a.receipts, usdcTx)
	delete(x.b.receipts, usdcTx)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	if err := x.db.scanTopups(ctx, c, time.Now()); err != nil {
		t.Fatal(err)
	}
	if cur := rvCursor(t, x.db); cur != rvSafe() {
		t.Fatalf("cursor %s", cur)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'unknown' AND user_id = '' AND credits = 0`, padded); n != 2 {
		t.Fatalf("unknown rows %d, want 2 (the $5 and the 1 wei; the zero skipped)", n)
	}
	if code, out := x.post(padded); code != 503 || credits(t, x.db, brutalMe) != 0 {
		t.Fatalf("report of an unreadable tx: %d %v, credits %d", code, out, credits(t, x.db, brutalMe))
	}
}

// Held: one provider answering garbage (or being down) while the other answers stops the scan: the cursor stays
// and nothing is recorded, so a broken provider never skips a transfer.
func TestRV64OneProviderGarbageStopsTheScan(t *testing.T) {
	for name, breakA := range map[string]func(x *topupAPI){
		"garbage": func(x *topupAPI) { x.a.receipts[usdcTx] = `{"transactionHash": 7` },
		"down":    func(x *topupAPI) { x.a.down = true },
	} {
		t.Run(name, func(t *testing.T) {
			x := newTopupAPI(t, player, usdcAt+40)
			x.db.Get(ctx, brutalMe)
			x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
			x.a.receipts[bTx(0x1096)] = x.a.receipts[usdcTx] // logs stay visible to eth_getLogs
			breakA(x)
			c := newBSC(x.a.serve(t), x.b.serve(t))
			x.db.setScanned(ctx, usdcAt-1, time.Now())
			if err := x.db.scanTopups(ctx, c, time.Now()); err == nil {
				t.Fatal("scan went on with one provider broken")
			}
			if cur := rvCursor(t, x.db); cur != fmt.Sprint(usdcAt-1) || count(t, x.db, `SELECT COUNT(*) FROM topups`) != 0 {
				t.Fatalf("cursor %s, rows %d", cur, count(t, x.db, `SELECT COUNT(*) FROM topups`))
			}
		})
	}
}

// ---------- the 24 h cap by credit time ----------

// Held: the window is (credited_at − 24 h, now]: one second before 24 h after a credit there's no room, at 24 h
// there is.
func TestRV64CapBoundaryByCreditTime(t *testing.T) {
	s := testStore(t)
	realCaps(t)
	s.Get(ctx, "a")
	t0 := time.Unix(1_800_000_000, 0)
	rec(t, s, bTx(1), 0, centsAmt(2000), "", t0.Add(-72*time.Hour)) // seen 3 days ago, claimed at t0
	if tp := rec(t, s, bTx(1), 0, centsAmt(2000), "a", t0); tp.Status != "credited" {
		t.Fatalf("%+v", tp)
	}
	if tp := rec(t, s, bTx(2), 0, centsAmt(500), "a", t0.Add(86399*time.Second)); tp.Status != "rejected" {
		t.Fatalf("room before 24 h: %+v", tp)
	}
	if tp := rec(t, s, bTx(3), 0, centsAmt(2000), "a", t0.Add(86400*time.Second)); tp.Status != "credited" || tp.USDCents != 2000 {
		t.Fatalf("no room at 24 h: %+v", tp)
	}
}

// Held: 12 "unknown" $20 transfers claimed by 12 concurrent calls, plus 6 fresh $20 transfers at the same time:
// $20 credited in all.
func TestRV64ConcurrentClaimsRaceTheCap(t *testing.T) {
	s := testStore(t)
	realCaps(t)
	s.Get(ctx, "a")
	now := time.Now()
	for i := range 12 {
		rec(t, s, bTx(100+i), 0, centsAmt(2000), "", now.Add(-48*time.Hour))
	}
	var errs atomic.Int64
	parallel(18, func(i int) {
		tx := bTx(100 + i)
		if i >= 12 {
			tx = bTx(200 + i)
		}
		_, _, err := s.recordTopup(ctx, Transfer{Tx: tx, Token: usdcAddr(), From: player, To: game.payments.AgenticWallet,
			Amount: centsAmt(2000)}, 0, "a", now)
		if err != nil {
			errs.Add(1)
		}
	})
	var day int64
	s.db.QueryRow(`SELECT COALESCE(SUM(usd_cents), 0) FROM topups WHERE user_id = 'a' AND status = 'credited'`).Scan(&day)
	if day != 2000 || credits(t, s, "a") != 1980 || errs.Load() != 0 {
		t.Fatalf("credited %d cents, %d credits, %d errors", day, credits(t, s, "a"), errs.Load())
	}
}

// ---------- the pause under concurrency ----------

// Held: with a trigger that refuses any money row written while paused, 30 buys and 30 top-ups racing a pause
// either commit before it or get errPaused; none reaches its write after the pause.
func TestRV64PauseRacesBuysAndTopups(t *testing.T) {
	liftCaps(t)
	for round := range 5 {
		c := newCity(t)
		livePrices(t, c, 50)
		for i := range 30 {
			c.s.Get(ctx, fmt.Sprint("p", i))
		}
		if _, err := c.s.db.Exec(`
CREATE TRIGGER rv_sale BEFORE INSERT ON sales WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'payments_paused')
	BEGIN SELECT RAISE(ABORT, 'money moved after the pause'); END;
CREATE TRIGGER rv_topup_ins BEFORE INSERT ON topups WHEN NEW.status = 'credited' AND EXISTS (SELECT 1 FROM settings WHERE key = 'payments_paused')
	BEGIN SELECT RAISE(ABORT, 'money moved after the pause'); END;`); err != nil {
			t.Fatal(err)
		}
		var slipped atomic.Int64
		parallel(61, func(i int) {
			var err error
			switch {
			case i == 60:
				time.Sleep(time.Duration(rand.Intn(3000)) * time.Microsecond)
				_, err = c.s.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, '["test"]', 1)`, pauseKey)
			case i%2 == 0:
				_, err = c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 50, market, c.now)
			default:
				_, _, err = c.s.recordTopup(ctx, Transfer{Tx: bTx(5000 + i), Token: usdcAddr(), From: player,
					To: game.payments.AgenticWallet, Amount: centsAmt(500)}, 0, fmt.Sprint("p", i/2), time.Now())
			}
			if err != nil && strings.Contains(err.Error(), "after the pause") {
				slipped.Add(1)
			}
		})
		if slipped.Load() > 0 {
			t.Fatalf("round %d: %d writes reached the db after the pause", round, slipped.Load())
		}
	}
}

// ---------- seed vs top-up ----------

// Held: the scanner records a transfer "unknown" (wallet not stored yet), the team books that tx as the seed, then
// the player stores the wallet and reports it: no credits.
func TestRV64ScannerUnknownThenSeedThenReport(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	if err := x.db.scanTopups(ctx, c, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.RecordSeed(ctx, c, "owner@x", usdcTx, "first stock", time.Now()); err != nil {
		t.Fatal(err)
	}
	code, _ := x.post(usdcTx)
	if credits(t, x.db, brutalMe) != 0 || count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'credited'`) != 0 {
		t.Fatalf("seed also credited to the player (%d)", code)
	}
}

// Held: a top-up credited first can't be booked as the seed; neither can a tx with a stored player's wallet among
// its senders (so the team must never seed from a wallet that plays).
func TestRV64SeedRefusedAfterTopupAndForPlayerSenders(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	if code, out := x.post(usdcTx); code != 200 || out["status"] != "credited" {
		t.Fatalf("%d %v", code, out)
	}
	if _, err := x.db.RecordSeed(ctx, c, "owner@x", usdcTx, "first stock", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("credited top-up booked as seed: %v", err)
	}
	mixed := bTx(0x5eed)
	x.put(mixed, bReceipt(mixed, usdcAt, bLog{from: rvStranger, amount: centsAmt(10_000), idx: 0},
		bLog{from: player, amount: centsAmt(100), idx: 1}))
	if _, err := x.db.RecordSeed(ctx, c, "owner@x", mixed, "team + a player's dollar", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("seed with a player sender: %v", err)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'seed'`); n != 0 {
		t.Fatalf("%d seed rows", n)
	}
}

// FINDING (low): RecordSeed only asks users.wallet_address, not the tx's own rows (#38 suggested both). A transfer
// recorded "rejected" for a player (over the caps: owed a refund) is booked as the seed once that player's stored
// wallet changed: the same dollars are then the platform's and owed back to the player.
func TestRV64SeedBooksAPlayersRejectedTopupAfterWalletChange(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	realCaps(t)
	s := x.db
	s.Get(ctx, "p")
	s.SetIdentity(ctx, "p", "", player, time.Now())
	now := time.Now()
	for d := range 5 { // $100 total used up, oldest first
		rec(t, s, bTx(300+d), 0, centsAmt(2000), "p", now.Add(-time.Duration(30+24*(4-d))*time.Hour))
	}
	tr := Transfer{Tx: usdcTx, Token: usdcAddr(), From: player, To: game.payments.AgenticWallet, Amount: centsAmt(90676)}
	if tp, _, err := s.recordTopup(ctx, tr, 0, "p", now); err != nil || tp.Status != "rejected" {
		t.Fatalf("%+v %v", tp, err)
	}
	s.SetIdentity(ctx, "p", "", "0x2222222222222222222222222222222222222222", now)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	if _, err := s.RecordSeed(ctx, c, "owner@x", usdcTx, "first stock", now); err == nil {
		t.Fatalf("a player's rejected (to refund) top-up was booked as the seed")
	}
}

// ---------- shop prices and wholesale ----------

// Held: a shop priced at exactly 3× sells; after the market halves it doesn't (until repriced); when the market
// recovers it sells again. A started party whose locked price is now over the cap can't sell or reprice (policy).
func TestRV64MarkupCapFollowsTheMarket(t *testing.T) {
	c := newCity(t)
	livePrices(t, c, 3*wholesaleTSLA)
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 0, market, c.now); err != nil {
		t.Fatalf("exactly 3×: %v", err)
	}
	half := map[string]float64{"TSLA": market["TSLA"] / 2}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 0, half, c.now); !errors.Is(err, errRejected) {
		t.Fatalf("over 3× after a drop: %v", err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 0, half, c.at(5)); !errors.Is(err, errRejected) {
		t.Fatalf("party over 3× after a drop: %v", err)
	}
	if err := c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, half, c.at(5)); !errors.Is(err, errPriceLocked) {
		t.Logf("party reprice after start: %v", err)
	}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 0, map[string]float64{"TSLA": 400}, c.now); err != nil {
		t.Fatalf("after the recovery: %v", err)
	}
}

// Held: for quotes with up to 6 decimals (any real feed), wholesale × units per share ≥ the share price in credits,
// exactly (big.Rat); tiny prices cost 1; an absurd one is no price. The 1e-6 slack only lets through quotes with
// sub-micro-cent noise, logged below.
func TestRV64WholesaleNeverBelowCostExactly(t *testing.T) {
	per := int64(1 / game.payments.SharesPerUnit)
	r := rand.New(rand.NewSource(64))
	check := func(dec string) {
		t.Helper()
		f, _ := new(big.Rat).SetString(dec)
		pf, _ := f.Float64()
		w, err := wholesaleOf("tsla", map[string]float64{"TSLA": pf})
		if err != nil {
			t.Fatalf("%s: %v", dec, err)
		}
		cost := new(big.Rat).Mul(f, big.NewRat(int64(game.payments.CreditsPerUSD), per)) // credits per unit
		if new(big.Rat).SetInt64(w).Cmp(cost) < 0 {
			t.Fatalf("price %s: wholesale %d < cost %s", dec, w, cost.FloatString(9))
		}
	}
	for range 200_000 {
		micro := r.Int63n(2_000_000_000) + 1 // $0.000001 … $2,000
		check(fmt.Sprintf("%d.%06d", micro/1_000_000, micro%1_000_000))
	}
	for _, d := range []string{"0.000001", "0.01", "70.00", "70.000001", "371.5", "9999.999999"} {
		check(d)
	}
	if _, err := wholesaleOf("tsla", map[string]float64{"TSLA": 1e12}); !errors.Is(err, errNoPrice) {
		t.Fatalf("absurd quote: %v", err)
	}
	w, _ := wholesaleOf("tsla", map[string]float64{"TSLA": 70.0000000049})
	t.Logf("nit: $70.0000000049 wholesales at %d credits (cost 7.00000000049): the 1e-6 slack", w)
}

// ---------- migration 7 ----------

func rvSchema(t *testing.T, s *store) string {
	t.Helper()
	rows, err := s.db.Query(`SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ws := regexp.MustCompile(`\s+`)
	var out []string
	for rows.Next() {
		var x string
		rows.Scan(&x)
		out = append(out, ws.ReplaceAllString(x, " "))
	}
	return strings.Join(out, "\n")
}

// Held: a production-like database at v6 with top-ups in every state gets credited_at = updated_at for credited
// rows only (a claimed row: its claim time), ends at the latest version with the same schema as a fresh database,
// and running migration 7 again changes nothing. Migration 7 is the last one.
func TestRV64Migration7OnAV6Database(t *testing.T) {
	if !strings.Contains(migrations[7], "credited_at") {
		t.Fatal("credited_at isn't migration 8")
	}
	fresh := rvSchema(t, testStore(t))
	path := filepath.Join(t.TempDir(), "prod.db")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP INDEX topups_credited; ALTER TABLE topups DROP COLUMN credited_at; PRAGMA user_version = 6;
	INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, credits, status, reason, created_at, updated_at) VALUES
		('0x01', 0, 'a', '0xs', '0xt', '1', 2000, 20, 1980, 'credited', '', 100, 100),
		('0x02', 0, 'a', '0xs', '0xt', '1', 2000, 20, 1980, 'credited', '', 100, 90000),
		('0x03', 0, '', '0xs', '0xt', '1', 500, 0, 0, 'unknown', '', 100, 100),
		('0x04', 0, 'a', '0xs', '0xt', '1', 500, 0, 0, 'rejected', 'x', 100, 200);`); err != nil {
		t.Fatal(err)
	}
	s.close()
	want := map[string]int64{"0x01": 100, "0x02": 90000, "0x03": 0, "0x04": 0}
	for pass := range 2 {
		if s, err = openStore(path); err != nil {
			t.Fatalf("pass %d: %v", pass, err)
		}
		var v int
		s.db.QueryRow(`PRAGMA user_version`).Scan(&v)
		if v != len(migrations) {
			t.Fatalf("user_version %d", v)
		}
		for tx, at := range want {
			var got int64
			s.db.QueryRow(`SELECT credited_at FROM topups WHERE tx = ?`, tx).Scan(&got)
			if got != at {
				t.Fatalf("pass %d: %s credited_at %d, want %d", pass, tx, got, at)
			}
		}
		if got := rvSchema(t, s); got != fresh {
			t.Fatalf("pass %d: schema differs from a fresh db:\n%s\n---\n%s", pass, got, fresh)
		}
		if pass == 0 {
			s.db.Exec(`PRAGMA user_version = 6`) // run migration 7 again
		}
		s.close()
	}
}
