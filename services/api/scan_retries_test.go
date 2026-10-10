package main

// Review of #64 (round 3): the top-up scanner moves past what it can't read, records it for the back office
// (scan_retries, shown by Payments), and reads it again on later passes, a bounded number of times.

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

func scanRetryRow(t *testing.T, s *store, kind, ref string, block uint64) (status string, attempts int) {
	t.Helper()
	err := s.db.QueryRow(`SELECT status, attempts FROM scan_retries WHERE kind = ? AND ref = ? AND block = ?`,
		kind, ref, int64(block)).Scan(&status, &attempts)
	if err == sql.ErrNoRows {
		return "", 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return status, attempts
}

func getLogsCalls(f *fakeRPC) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.methods {
		if m == "eth_getLogs" {
			n++
		}
	}
	return n
}

// A block whose logs both rpcs refuse is passed and recorded (the back office sees it); once the rpcs answer it, the
// next pass reads it and credits the player's deposit in it. A deposit in a later block is credited meanwhile.
func TestScanRetryReadsASkippedBlockAndCreditsIt(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	hidden := bTx(0x41dd)
	x.put(hidden, bReceipt(hidden, usdcAt-1, bLog{from: player, amount: centsAmt(700), idx: 0}))
	x.a.refuseLogsAt = map[uint64]bool{usdcAt - 1: true}
	x.b.refuseLogsAt = map[uint64]bool{usdcAt - 1: true}
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-2, now)
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if cur := rvCursor(t, x.db); cur != rvSafe() {
		t.Fatalf("cursor %s, want %s", cur, rvSafe())
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'credited'`, usdcTx); n != 1 {
		t.Fatal("the later deposit wasn't credited past the skipped block")
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ?`, hidden); n != 0 {
		t.Fatal("a refused block's transfer was recorded")
	}
	if st, n := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt-1); st != "open" || n != 1 {
		t.Fatalf("skipped block: %q after %d reads", st, n)
	}
	p, err := x.db.Payments(ctx) // one row per token: the fake refuses the block's logs of both
	if err != nil || len(p.ScanRetries) != 2 || p.ScanRetries[0].Block != int64(usdcAt-1) ||
		!strings.Contains(p.ScanRetries[0].Reason, "10000 results") {
		t.Fatalf("back office: %+v %v", p.ScanRetries, err)
	}
	x.a.refuseLogsAt, x.b.refuseLogsAt = nil, nil // the providers answer it now
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'credited' AND user_id = ?`, hidden, brutalMe); n != 1 {
		t.Fatal("the skipped block's deposit wasn't credited once it read")
	}
	if st, _ := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt-1); st != "done" {
		t.Fatalf("retry %q", st)
	}
	if p, _ := x.db.Payments(ctx); len(p.ScanRetries) != 0 {
		t.Fatalf("done retries still shown: %+v", p.ScanRetries)
	}
}

// What never reads is read scanRetryMax times in all, with growing waits between reads, then given up (the back
// office's); it is never read again after that.
func TestScanRetryIsBoundedThenGivenUp(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.a.refuseLogsAt = map[uint64]bool{usdcAt - 1: true}
	x.b.refuseLogsAt = map[uint64]bool{usdcAt - 1: true}
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-2, now)
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	read := func() int { _, n := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt-1); return n }
	x.db.scanTopups(ctx, c, now) // second read: right away
	x.db.scanTopups(ctx, c, now) // third: not before a minute
	if read() != 2 {
		t.Fatalf("reads %d, want 2 (the third waits)", read())
	}
	for range 40 {
		now = now.Add(3 * time.Hour)
		x.db.scanTopups(ctx, c, now)
	}
	if st, n := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt-1); st != "given_up" || n != scanRetryMax {
		t.Fatalf("%q after %d reads, want given_up after %d", st, n, scanRetryMax)
	}
	before := getLogsCalls(x.a)
	x.db.scanTopups(ctx, c, now.Add(24*time.Hour))
	if getLogsCalls(x.a) != before {
		t.Fatal("a given-up block is still read")
	}
	if p, _ := x.db.Payments(ctx); len(p.ScanRetries) != 2 || p.ScanRetries[0].Status != "given_up" {
		t.Fatalf("back office: %+v", p.ScanRetries)
	}
}

// Both providers refusing everything for a while (a shared outage page) looks like refused blocks: one pass moves
// past at most scanSkipsPerPass of them, then stops; it never sweeps an outage away.
func TestScanSkipsAFewBlocksPerPassAtMost(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	refuse := map[uint64]bool{}
	for b := usdcAt - 10; b < usdcAt; b++ {
		refuse[uint64(b)] = true
	}
	x.a.refuseLogsAt, x.b.refuseLogsAt = refuse, refuse
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-11, now)
	if err := x.db.scanTopups(ctx, c, now); err == nil {
		t.Fatal("one pass moved past 10 refused blocks")
	}
	if cur, want := rvCursor(t, x.db), fmt.Sprint(usdcAt-11+scanSkipsPerPass); cur != want {
		t.Fatalf("cursor %s, want %s", cur, want)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM scan_retries WHERE kind = 'logs'`); n != scanSkipsPerPass*2 { // both tokens
		t.Fatalf("%d skipped", n)
	}
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if cur := rvCursor(t, x.db); cur != rvSafe() {
		t.Fatalf("cursor %s", cur)
	}
}

// One provider refusing a block's logs while the other answers stops the scan (it may be the broken one).
func TestScanOneProviderRefusingABlockStopsTheScan(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.a.refuseLogsAt = map[uint64]bool{usdcAt: true}
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-1, now)
	if err := x.db.scanTopups(ctx, c, now); err == nil {
		t.Fatal("scan went on with one provider refusing")
	}
	if cur := rvCursor(t, x.db); cur != fmt.Sprint(usdcAt-1) || count(t, x.db, `SELECT COUNT(*) FROM scan_retries`) != 0 {
		t.Fatalf("cursor %s", cur)
	}
}

// A receipt that stays unreadable is read again a bounded number of times (a player's money: longer than a block's
// logs, for more than a day), then given up; its row stays unknown, owed back in full, with its reason.
func TestScanRetryUnreadableReceiptIsBounded(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	good := x.a.receipts[usdcTx]
	x.put(bTx(0x1097), good) // keeps the transfer in eth_getLogs
	x.put(usdcTx, `<html>502 Bad Gateway</html>`)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-1, now)
	start := now
	for range 30 { // a day of passes, an hour apart
		x.db.scanTopups(ctx, c, now)
		now = now.Add(time.Hour)
	}
	if st, _ := scanRetryRow(t, x.db, "receipt", usdcTx, usdcAt); st != "open" {
		t.Fatalf("a player's receipt given up within %v", now.Sub(start))
	}
	for range 100 {
		x.db.scanTopups(ctx, c, now)
		now = now.Add(time.Hour)
	}
	if st, n := scanRetryRow(t, x.db, "receipt", usdcTx, usdcAt); st != "given_up" || n != scanReceiptRetryMax {
		t.Fatalf("%q after %d reads", st, n)
	}
	var st, why string
	var owed int64
	x.db.db.QueryRow(`SELECT status, reason, refund_cents FROM topups WHERE tx = ?`, usdcTx).Scan(&st, &why, &owed)
	if st != "unknown" || owed == 0 || !strings.HasPrefix(why, "unreadable") || credits(t, x.db, brutalMe) != 0 {
		t.Fatalf("%s %q owed %d", st, why, owed)
	}
}

// Migrations skip an ADD COLUMN only for the columns meant to be re-runnable; any other column that is there
// already fails the migration (schema drift is never hidden).
func TestMigrationOnlySkipsListedColumns(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { migrations = migrations[:len(migrations)-1] })
	migrations = append(migrations, `ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';`)
	if err := migrate(s.db); err == nil || !strings.Contains(err.Error(), "duplicate column") {
		t.Fatalf("an unlisted column present was skipped: %v", err)
	}
	migrations[len(migrations)-1] = `ALTER TABLE topups ADD COLUMN credited_at INTEGER NOT NULL DEFAULT 0;`
	if err := migrate(s.db); err != nil {
		t.Fatal(err)
	}
}

// The "booked already?" lookups on platform_ledger use its lower(ref) index, not a table scan.
func TestLedgerRefLookupUsesTheIndex(t *testing.T) {
	s := testStore(t)
	for _, q := range []string{
		`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'seed' AND lower(ref) = ?`,
		`SELECT COUNT(*) FROM platform_ledger WHERE lower(ref) = lower(?) AND kind IN ('restock', 'seed')`,
	} {
		rows, err := s.db.Query(`EXPLAIN QUERY PLAN `+q, bTx(1))
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			rows.Scan(&id, &parent, &unused, &detail)
			plan = append(plan, detail)
		}
		rows.Close()
		if p := strings.Join(plan, "; "); !strings.Contains(p, "platform_ledger_ref") {
			t.Fatalf("%s: %s", q, p)
		}
	}
}
