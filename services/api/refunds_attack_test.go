package main

// Adversarial tests from the owner's review of PR #57 (refunds owed in reconciliation).

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type rvLog struct {
	token, from, to string
	cents           int64 // amount in cents (1e16 base units)
}

const rvJunk = "0x00000000000000000000000000000000000000ee" // some contract that emits big logs

func rvTx(n int) string { return fmt.Sprintf("0x%064x", n) }

// rvReceipt: a successful tx in block with these Transfer logs, plus junk logs of 64 KiB each (to make it big).
func rvReceipt(tx string, block uint64, logs []rvLog, junk int) string {
	hexb := "0x" + strconv.FormatUint(block, 16)
	out := []map[string]any{}
	i := 0
	for _, l := range logs {
		out = append(out, map[string]any{"address": strings.ToLower(l.token),
			"topics":      []string{transferTopic, padded(l.from), padded(l.to)},
			"data":        fmt.Sprintf("0x%064x", new(big.Int).Mul(big.NewInt(l.cents), big.NewInt(1e16))),
			"blockNumber": hexb, "transactionHash": tx, "logIndex": "0x" + strconv.FormatInt(int64(i), 16), "removed": false})
		i++
	}
	for j := 0; j < junk; j++ {
		out = append(out, map[string]any{"address": rvJunk, "topics": []string{}, "data": "0x" + strings.Repeat("ab", 64<<10),
			"blockNumber": hexb, "transactionHash": tx, "logIndex": "0x" + strconv.FormatInt(int64(i), 16), "removed": false})
		i++
	}
	b, _ := json.Marshal(map[string]any{"transactionHash": tx, "status": "0x1", "blockNumber": hexb,
		"blockHash": "0x" + strings.Repeat("1", 64), "gasUsed": "0x5208", "logs": out})
	return string(b)
}

type rvChain struct {
	ch   *bsc
	a, b *fakeRPC
}

func rvNewChain(t *testing.T, receipts map[string]string) rvChain {
	return rvNewChainAt(t, usdcAt+40, receipts)
}

func rvNewChainAt(t *testing.T, head uint64, receipts map[string]string) rvChain {
	a, b := newFakeRPC(t, head), newFakeRPC(t, head)
	for tx, rc := range receipts {
		a.receipts[tx], b.receipts[tx] = rc, rc
	}
	return rvChain{newBSC(a.serve(t), b.serve(t)), a, b}
}

func (c rvChain) receiptCalls() (n int) {
	for _, f := range []*fakeRPC{c.a, c.b} {
		f.mu.Lock()
		for _, m := range f.methods {
			if m == "eth_getTransactionReceipt" {
				n++
			}
		}
		f.mu.Unlock()
	}
	return n
}

func rvScan(t *testing.T, s *store, c rvChain) error {
	t.Helper()
	if err := s.setScanned(ctx, usdcAt-1, time.Now()); err != nil {
		t.Fatal(err)
	}
	return s.scanTopups(ctx, c.ch, time.Now())
}

var (
	rvUSDC = func() string { return game.payments.Topup.Tokens["USDC"] }
	rvW    = func() string { return game.payments.AgenticWallet }
)

// ---------- 1. previously requested fixes ----------

// A stranger's plain transfer (not a swap) seen by the scanner is owed back in full, and reconciliation counts it.
func TestRV57StrangerPlainTransferIsOwedBack(t *testing.T) {
	s := testStore(t)
	c := rvNewChain(t, map[string]string{rvTx(1): rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), stranger, rvW(), 4000}}, 0)})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(1)); n != 4000 {
		t.Fatalf("stranger's $40 owed back %d", n)
	}
	s.Get(ctx, "b")
	if err := s.inTx(ctx, func(tx *sql.Tx) error { return creditLedger(tx, "b", 1, "refund", "", "bug") }); err != nil {
		t.Fatal(err)
	}
	walletHolds(c.a, c.b, 4000, 0)
	if r, err := s.Reconcile(ctx, c.ch, "system", "t", time.Now()); err != nil || r.OK || r.RefundCents != 4000 {
		t.Fatalf("1 unbacked credit hidden behind a stranger's money: %+v %v", r, err)
	}
}

// A swap's change (same tx: the wallet pays the pool, the pool sends change) next to a genuine stranger refund in
// another tx: only the stranger is owed.
func TestRV57SwapChangeVsGenuineRefund(t *testing.T) {
	s := testStore(t)
	swap := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), rvW(), pool, 500}, {rvUSDC(), pool, rvW(), 200}}, 0)
	gift := rvReceipt(rvTx(2), usdcAt+1, []rvLog{{rvUSDC(), stranger, rvW(), 700}}, 0)
	c := rvNewChain(t, map[string]string{rvTx(1): swap, rvTx(2): gift})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if got := count(t, s, `SELECT COALESCE(SUM(refund_cents), 0) FROM topups`); got != 700 {
		t.Fatalf("owed back %d, want 700 (the gift only)", got)
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(1)); n != 0 {
		t.Fatalf("change owed back: %d", n)
	}
}

// A player's top-up in the same tx where the wallet paid stablecoin out keeps its over-cap part owed.
func TestRV57PlayerTopupInSameTxAsPayoutKeepsRefund(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	s.SetIdentity(ctx, "a", "", player, time.Now())
	rc := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), rvW(), stranger, 100}, {rvUSDC(), player, rvW(), 5000}}, 0)
	c := rvNewChain(t, map[string]string{rvTx(1): rc})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	var status string
	var refund, usd int
	s.db.QueryRow(`SELECT status, refund_cents, usd_cents FROM topups WHERE tx = ?`, rvTx(1)).Scan(&status, &refund, &usd)
	if status != "credited" || usd != 2000 || refund != 3000 {
		t.Fatalf("player row %s usd=%d refund=%d, want credited 2000 / 3000", status, usd, refund)
	}
}

// refund_cents never negative nor over what arrived; credited + owed back = what arrived, whatever the caps.
func TestRV57RefundBounds(t *testing.T) {
	for _, usd := range []int64{0, 1, 2, 3, 19, 20, 21, 99, 100, 101, 5000} {
		s := testStore(t)
		s.Get(ctx, "a")
		for i := 0; i < 3; i++ { // the second and third hit the caps
			sendTopup(t, s, int(usd)*10+i+1, usd, "a", player)
		}
		sendTopup(t, s, 99999, usd, "", stranger)
		if n := count(t, s, `SELECT COUNT(*) FROM topups WHERE refund_cents < 0 OR
			(status = 'credited' AND usd_cents + refund_cents != CAST(amount AS REAL) / 1e16) OR
			(status != 'credited' AND refund_cents != usd_cents)`); n != 0 {
			t.Fatalf("$%d: %d rows out of bounds", usd, n)
		}
	}
}

// Two admins mark the same refund at once: one wins, one audit row.
func TestRV57MarkRefundedOnce(t *testing.T) {
	s := testStore(t)
	sendTopup(t, s, 1, 40, "", stranger)
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.MarkRefunded(ctx, "kiel@x", rvTx(1), 0, "sent back", time.Now()); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ok != 1 || count(t, s, `SELECT COUNT(*) FROM audit WHERE action = 'topup-refund'`) != 1 {
		t.Fatalf("marked %d times", ok)
	}
}

// Partial: an over-cap credited row marked refunded keeps its credits and status; only its excess leaves the owed.
func TestRV57PartialRefundOfOverCapRow(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	sendTopup(t, s, 1, 50, "a", player)
	before := credits(t, s, "a")
	if cents, err := s.MarkRefunded(ctx, "kiel@x", rvTx(1), 0, "excess sent back", time.Now()); err != nil || cents != 3000 {
		t.Fatalf("%d %v", cents, err)
	}
	if credits(t, s, "a") != before || count(t, s, `SELECT COUNT(*) FROM topups WHERE status = 'credited'`) != 1 {
		t.Fatal("refund of the excess touched the credited part")
	}
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	walletHolds(a, b, 2000, 0) // $50 in, $30 back
	if r, err := s.Reconcile(ctx, newBSC(a.serve(t), b.serve(t)), "system", "t", time.Now()); err != nil || !r.OK || r.RefundCents != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

// Totals: credited, over-cap, rejected, unknown, refunded, swap change, seed. The check matches at the exact wallet
// balance and fails one cent short (nothing hides a shortfall).
func TestRV57ReconcileTotalsExact(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	sendTopup(t, s, 1, 10, "a", player)  // 990 credits + 10 fee
	sendTopup(t, s, 2, 50, "a", player)  // room $10: credited 1000 (990 + 10 fee), 4000 owed back
	sendTopup(t, s, 3, 5, "a", player)   // no room: rejected, 500 owed
	sendTopup(t, s, 4, 40, "", stranger) // 4000 owed
	sendTopup(t, s, 5, 7, "", stranger)  // refunded below: wallet lowered by 700
	if _, err := s.MarkRefunded(ctx, "kiel@x", rvTx(5), 0, "back", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.inTx(ctx, func(tx *sql.Tx) error { return platformLedger(tx, 500, "seed", "0xseed", "team") }); err != nil {
		t.Fatal(err)
	}
	ch, a, b := restockChain(t, changeSwap(t, 500, 200), usdcAt+20)
	s.setScanned(ctx, usdcAt-1, time.Now())
	if err := s.scanTopups(ctx, ch, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	// In: 1000 + 5000 + 500 + 4000 + 700 + seed 500 − 700 refunded − 500 paid + 200 change.
	wallet := int64(1000 + 5000 + 500 + 4000 + 700 + 500 - 700 - 500 + 200)
	walletHolds(a, b, wallet, 8)
	r, err := s.Reconcile(ctx, ch, "system", "t", time.Now())
	if err != nil || !r.OK || r.RefundCents != 8500 || r.OwedCents != 1980 || r.PlatformCents != 20+500-300 {
		t.Fatalf("exact: %+v %v", r, err)
	}
	walletHolds(a, b, wallet-(wallet-1980-8500-220)-1, 8) // one cent short of owed + platform
	if r, _ := s.Reconcile(ctx, ch, "system", "t", time.Now()); r.OK {
		t.Fatalf("one cent short still matched: %+v", r)
	}
}

// Migration 7 on a v6 database with data: each row's backfill; restock/seed refs match whatever their letter case;
// migrate() again is a no-op; reconciliation then matches the books.
func TestRV57MigrationSevenBackfillAtV6(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v6.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', avatar INTEGER NOT NULL DEFAULT 1,
	wallet INTEGER NOT NULL, nights INTEGER NOT NULL DEFAULT 0, gigs INTEGER NOT NULL DEFAULT 0,
	total_pnl INTEGER NOT NULL DEFAULT 0, best_pnl INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
	last_gig INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE portfolio (user_id TEXT NOT NULL, token TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL,
	PRIMARY KEY (user_id, token));`); err != nil {
		t.Fatal(err)
	}
	for v, m := range migrations[:6] {
		if _, err := db.Exec(m); err != nil {
			t.Fatalf("migration %d: %v", v+1, err)
		}
	}
	R, S := "0x"+strings.Repeat("ab", 32), "0x"+strings.Repeat("cd", 32)
	if _, err := db.Exec(`PRAGMA user_version = 6;
INSERT INTO platform_ledger (delta, kind, ref, reason, at) VALUES (-300, 'restock', upper(?1), '', 1), (500, 'seed', ?2, '', 1),
	(10, 'fee', '0x7', '', 1);
INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, credits, status, reason, created_at, updated_at) VALUES
	(?1, 1, '', '0xpool', 'usdc', '0', 200, 0, 0, 'unknown', '', 1, 1),
	(?2, 0, '', '0xteam', 'usdc', '0', 500, 0, 0, 'unknown', '', 1, 1),
	('0x3', 0, '', '0xb', 'usdc', '0', 4000, 0, 0, 'unknown', '', 1, 1),
	('0x4', 0, 'a', '0xa', 'usdc', '0', 200, 0, 0, 'rejected', '200 cents not credited: under the $3 minimum or over the caps, to refund', 1, 1),
	('0x5', 0, 'a', '0xa', 'usdc', '0', 2000, 20, 1980, 'credited', '3000 cents over the caps, to refund', 1, 1),
	('0x6', 0, 'a', '0xa', 'usdc', '0', 1000, 10, 990, 'credited', '', 1, 1),
	('0x7', 0, '', '0xc', 'usdc', '0', 900, 0, 0, 'rejected', 'seed', 1, 1),
	('0x8', 0, '', '0xd', 'usdc', '0', 900, 0, 0, 'pending', '', 1, 1);`, R, S); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	want := map[string]int{R: 0, S: 0, "0x3": 4000, "0x4": 200, "0x5": 3000, "0x6": 0, "0x7": 0, "0x8": 0}
	check := func(when string) {
		for tx, cents := range want {
			if got := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, tx); got != cents {
				t.Errorf("%s: %s owes back %d, want %d", when, tx, got, cents)
			}
		}
	}
	check("after")
	if err := migrate(s.db); err != nil {
		t.Fatal(err)
	}
	check("migrate again")
	if n := count(t, s, `SELECT COUNT(*) FROM pragma_table_info('topups') WHERE name IN ('refund_cents', 'refunded_at')`); n != 2 {
		t.Fatalf("columns %d", n)
	}
}

// ---------- 2. new bugs ----------

// BUG (medium): walletPaidOut ignores the amount. Binance-Peg USDC and BSC-USD (BEP20 template) let ANYONE call
// transferFrom(agenticWallet, x, 0) with no allowance, which emits Transfer(agenticWallet → x, 0). Put that in the
// same tx as a stranger's real transfer and the scanner records it as "a swap's change": nothing owed back, so the
// stranger's money silently becomes backing (and the back office can't mark it refunded: nothing_owed).
func TestRV57ZeroValuePayoutPoisonHidesRefund(t *testing.T) {
	s := testStore(t)
	rc := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), rvW(), stranger, 0}, {rvUSDC(), stranger, rvW(), 4000}}, 0)
	c := rvNewChain(t, map[string]string{rvTx(1): rc})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(1)); n != 4000 {
		t.Errorf("a zero-value transferFrom poison hid $40 owed back: refund_cents = %d", n)
	}
	// And it masks unbacked credits: a bug mints 4,000 credits; the wallet holds exactly the stranger's $40.
	s.Get(ctx, "b")
	if err := s.inTx(ctx, func(tx *sql.Tx) error { return creditLedger(tx, "b", 4000, "refund", "", "bug") }); err != nil {
		t.Fatal(err)
	}
	walletHolds(c.a, c.b, 4000, 0)
	if r, err := s.Reconcile(ctx, c.ch, "system", "t", time.Now()); err != nil || r.OK {
		t.Errorf("false balanced: 4,000 unbacked credits hidden behind the stranger's $40: %+v %v", r, err)
	}
}

// BUG (blocker-ish, regression vs main): a non-player transfer now needs its receipt, and any receipt the api can't
// read (over bsc.go's 4 MiB response cap: ~40 big logs, ~$1 of gas) makes scanRange fail on every pass. The cursor
// never moves past that block, so every later top-up the browser didn't report is never credited. On main a
// non-player transfer costs no rpc and can't wedge the scanner.
func TestRV57OversizedStrangerReceiptWedgesScanner(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	s.SetIdentity(ctx, "a", "", player, time.Now())
	poison := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), stranger, rvW(), 0}}, 40)      // ~5 MiB, a 0-value transfer
	honest := rvReceipt(rvTx(2), usdcAt+1000, []rvLog{{rvUSDC(), player, rvW(), 1000}}, 0) // ~12 min later
	c := rvNewChainAt(t, usdcAt+2000, map[string]string{rvTx(1): poison, rvTx(2): honest})
	err := rvScan(t, s, c)
	_ = s.scanTopups(ctx, c.ch, time.Now()) // the next tick
	var cursor string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&cursor)
	if n := count(t, s, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'credited'`, rvTx(2)); n != 1 {
		t.Errorf("player's $10 top-up 1,000 blocks after the poison tx never credited by the scanner: "+
			"cursor stuck at %s (poison at %d), scan error: %v", cursor, usdcAt, err)
	}
}

// BUG (medium): one receipt read per transfer, not per tx. One tx with N zero-value transfers to the wallet from
// a non-player (anyone can make these) costs 2N receipt reads, each of a receipt with N logs: O(N²) bytes from the
// paid rpcs per scan. On main it cost none.
func TestRV57ReceiptReadsPerTxNotPerTransfer(t *testing.T) {
	s := testStore(t)
	var logs []rvLog
	for i := 0; i < 40; i++ {
		logs = append(logs, rvLog{rvUSDC(), fmt.Sprintf("0x%040x", 0x1000+i), rvW(), 0})
	}
	c := rvNewChain(t, map[string]string{rvTx(1): rvReceipt(rvTx(1), usdcAt, logs, 0)})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if n := c.receiptCalls(); n > 2 {
		t.Errorf("one tx of 40 zero-value transfers cost %d receipt reads (want ≤ 2: one per rpc)", n)
	}
}

// NIT: migration 7 re-run (a harness rewinding user_version) re-flags a swap's change recorded by the scanner with
// refund_cents = 0 as owed in full while its restock isn't booked yet.
func TestRV57MigrationRerunKeepsScannerChangeAtZero(t *testing.T) {
	s := testStore(t)
	swap := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), rvW(), pool, 500}, {rvUSDC(), pool, rvW(), 200}}, 0)
	c := rvNewChain(t, map[string]string{rvTx(1): swap})
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`PRAGMA user_version = 6`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(s.db); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(1)); n != 0 {
		t.Errorf("re-run migration turned the swap's change into %d cents owed back", n)
	}
}

// NIT: reconciliation skips rows in a tx booked as a restock, but the back office and MarkRefunded don't. A row that
// owes (scanned before the deploy, its restock reported after) shows the router's change as "owed back" and can be
// marked refunded, inviting someone to send the platform's money to a router.
func TestRV57ChangeInBookedRestockNotRefundableInBackOffice(t *testing.T) {
	s := testStore(t)
	ch, _, _ := restockChain(t, changeSwap(t, 500, 200), usdcAt+20)
	s.setScanned(ctx, usdcAt-1, time.Now())
	if err := s.scanTopups(ctx, ch, time.Now()); err != nil {
		t.Fatal(err)
	}
	s.db.Exec(`UPDATE topups SET refund_cents = 200 WHERE tx = ?`, usdcTx) // recorded owing before the deploy
	if _, err := s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Payments(ctx)
	for _, x := range p.Topups {
		if x.Tx == usdcTx && x.RefundCents > 0 {
			t.Errorf("back office lists the swap's change as %d cents owed back to %s", x.RefundCents, x.Sender)
		}
	}
	if _, err := s.MarkRefunded(ctx, "kiel@x", usdcTx, 0x1a, "x", time.Now()); err == nil {
		t.Errorf("the swap's change (booked restock) can be marked refunded")
	}
}
