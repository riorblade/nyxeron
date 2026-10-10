package main

// Owner's follow-ups on #57/#64: the scanner skips txs the platform booked (seed, restock), a payouts read that fails
// is recorded for the back office and read again, and the pre-deploy query of docs/payments.md lists exactly what
// migration 7 will count as owed.

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The owner's repro: a seed recorded first whose sender is (later) a player's wallet. The scanner records nothing for
// it: no credits, no row, and reconciliation isn't thrown off by a "rejected" row tied to the player.
func TestScanSkipsATxBookedAsSeed(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	s := x.db
	ch := newBSC(x.a.serve(t), x.b.serve(t))
	if _, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "first stock", time.Now()); err != nil {
		t.Fatal(err)
	}
	s.Get(ctx, "team")
	s.SetIdentity(ctx, "team", "", player, time.Now())
	s.setScanned(ctx, usdcAt-1, time.Now())
	if err := s.scanTopups(ctx, ch, time.Now()); err != nil {
		t.Fatal(err)
	}
	if c := credits(t, s, "team"); c != 0 {
		t.Fatalf("seed money credited to the team member (%d credits)", c)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM topups WHERE tx = ?`, usdcTx); n != 0 {
		t.Fatalf("%d top-up rows recorded for a tx booked as the seed", n)
	}
	if rvCursor(t, s) != rvSafe() {
		t.Fatal("the scan didn't move past the booked tx")
	}
}

// A tx booked as a restock (any letter case) is skipped too: a player's transfer in it is never credited by the scan.
func TestScanSkipsATxBookedAsRestock(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	s := x.db
	ch := newBSC(x.a.serve(t), x.b.serve(t))
	s.Get(ctx, "p")
	s.SetIdentity(ctx, "p", "", player, time.Now())
	if _, err := s.db.Exec(`INSERT INTO platform_ledger (delta, kind, ref, reason, at) VALUES (-500, 'restock', ?, '', 1)`,
		strings.ToUpper(usdcTx)); err != nil {
		t.Fatal(err)
	}
	s.setScanned(ctx, usdcAt-1, time.Now())
	if err := s.scanTopups(ctx, ch, time.Now()); err != nil {
		t.Fatal(err)
	}
	if c := credits(t, s, "p"); c != 0 || count(t, s, `SELECT COUNT(*) FROM topups`) != 0 {
		t.Fatalf("a restock's tx was scanned as a top-up (%d credits)", c)
	}
}

// POST /api/topups refuses a tx booked as the seed or a restock: not a top-up, nothing recorded, no credits.
func TestTopupReportRefusesABookedTx(t *testing.T) {
	for _, kind := range []string{"seed", "restock"} {
		t.Run(kind, func(t *testing.T) {
			x := newTopupAPI(t, player, usdcAt+40)
			if kind == "seed" {
				ch := newBSC(x.a.serve(t), x.b.serve(t))
				if _, err := x.db.RecordSeed(ctx, ch, "kiel@x", usdcTx, "first stock", time.Now()); err != nil {
					t.Fatal(err)
				}
			} else if _, err := x.db.db.Exec(`INSERT INTO platform_ledger (delta, kind, ref, reason, at)
				VALUES (-500, 'restock', ?, '', 1)`, strings.ToUpper(usdcTx)); err != nil {
				t.Fatal(err)
			}
			code, out := x.post(usdcTx)
			if code != 422 || out["error"] != "not_a_topup" {
				t.Fatalf("%d %v", code, out)
			}
			if credits(t, x.db, brutalMe) != 0 || count(t, x.db, `SELECT COUNT(*) FROM topups`) != 0 {
				t.Fatal("a booked tx was recorded or credited for the player")
			}
		})
	}
}

// When the Agentic Wallet's payouts in a range can't be read, the scanner records it in scan_retries ("payouts"),
// marks the strangers' rows in the range so the back office can't mark a swap's change refunded meanwhile, and reads
// the payouts again on later passes: once they read, the change is owed nothing and the other rows can be refunded.
func TestScanRecordsUnreadPayoutsAndReadsThemAgain(t *testing.T) {
	s := testStore(t)
	const router = "0x00000000000000000000000000000000000000bb"
	deposit := rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), stranger, rvW(), 4000}}, 0)
	swap := rvReceipt(rvTx(2), usdcAt+1, []rvLog{{rvUSDC(), rvW(), router, 5000}, {rvUSDC(), router, rvW(), 300}}, 0)
	c := rvNewChainAt(t, usdcAt+40, map[string]string{rvTx(1): deposit, rvTx(2): swap})
	wallet := "0x000000000000000000000000" + strings.TrimPrefix(strings.ToLower(game.payments.AgenticWallet), "0x")
	c.a.failLogsFrom, c.b.failLogsFrom = wallet, wallet
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM scan_retries WHERE kind = 'payouts' AND status = 'open'`); n != 1 {
		t.Fatalf("%d open payouts retries, want 1", n)
	}
	p, err := s.Payments(ctx)
	if err != nil || len(p.ScanRetries) != 1 || p.ScanRetries[0].Kind != "payouts" || p.ScanRetries[0].Block != usdcAt {
		t.Fatalf("back office: %+v %v", p.ScanRetries, err)
	}
	for _, tp := range p.Topups {
		if !strings.Contains(tp.Reason, "payouts") {
			t.Fatalf("row %s doesn't say its payouts weren't read: %q", tp.Tx, tp.Reason)
		}
	}
	if _, err := s.MarkRefunded(ctx, "admin@x", rvTx(2), 1, "sent back", time.Now()); !errors.Is(err, errPayoutsUnread) {
		t.Fatalf("a possible swap's change marked refunded while the payouts are unread: %v", err)
	}
	c.a.failLogsFrom, c.b.failLogsFrom = "", "" // the providers answer now
	if err := s.scanTopups(ctx, c.ch, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM scan_retries WHERE kind = 'payouts' AND status = 'done'`); n != 1 {
		t.Fatal("the payouts retry isn't done once it read")
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(2)); n != 0 {
		t.Fatalf("the swap's change still owed %d", n)
	}
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE tx = ?`, rvTx(1)); n != 4000 {
		t.Fatalf("the stranger's deposit owed %d, want 4000", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM topups WHERE reason LIKE '%payouts%'`); n != 0 {
		t.Fatal("the payouts note stays on rows after they read")
	}
	if _, err := s.MarkRefunded(ctx, "admin@x", rvTx(2), 1, "sent back", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("change: %v, want nothing owed", err)
	}
	if cents, err := s.MarkRefunded(ctx, "admin@x", rvTx(1), 0, "sent back", time.Now()); err != nil || cents != 4000 {
		t.Fatalf("deposit: %d %v", cents, err)
	}
}

// Given up, the payouts are the back office's to check by hand: the rows can be marked refunded then.
func TestUnreadPayoutsGivenUpLeaveTheRowsToTheBackOffice(t *testing.T) {
	s := testStore(t)
	c := rvNewChain(t, map[string]string{rvTx(1): rvReceipt(rvTx(1), usdcAt, []rvLog{{rvUSDC(), stranger, rvW(), 4000}}, 0)})
	wallet := "0x000000000000000000000000" + strings.TrimPrefix(strings.ToLower(game.payments.AgenticWallet), "0x")
	c.a.failLogsFrom, c.b.failLogsFrom = wallet, wallet
	if err := rvScan(t, s, c); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for range 40 {
		now = now.Add(3 * time.Hour)
		s.scanTopups(ctx, c.ch, now)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM scan_retries WHERE kind = 'payouts' AND status = 'given_up'`); n != 1 {
		t.Fatal("unread payouts never given up")
	}
	if cents, err := s.MarkRefunded(ctx, "admin@x", rvTx(1), 0, "checked on BscScan, sent back", now); err != nil || cents != 4000 {
		t.Fatalf("%d %v", cents, err)
	}
}

// owedQuery: the pre-deploy query of docs/payments.md (the sql block marked "owed by migration 7").
func owedQuery(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../../docs/payments.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, block := range strings.Split(string(b), "```sql")[1:] {
		q, _, _ := strings.Cut(block, "```")
		if strings.Contains(q, "owed by migration 7") {
			return q
		}
	}
	t.Fatal("docs/payments.md has no sql block marked \"owed by migration 7\"")
	return ""
}

// The pre-deploy query, run on a v6 database, lists exactly the rows migration 7's backfill then owes, with the
// amount it owes on each.
func TestPreDeployOwedQueryMatchesMigration7(t *testing.T) {
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
	(10, 'fee', '0x7', '', 1), (10, 'fee', '0x3', '', 1);
INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, credits, status, reason, created_at, updated_at) VALUES
	(?1, 1, '', '0xpool', 'usdc', '0', 200, 0, 0, 'unknown', '', 1, 1),
	(?1, 2, 'a', '0xa', 'usdc', '0', 900, 0, 0, 'rejected', '900 cents not credited: under the $3 minimum or over the caps, to refund', 1, 1),
	(upper(?2), 0, '', '0xteam', 'usdc', '0', 500, 0, 0, 'unknown', '', 1, 1),
	('0x3', 0, '', '0xb', 'usdc', '0', 4000, 0, 0, 'unknown', '', 2, 1),
	('0x3', 1, '', '0xb', 'usdc', '0', 0, 0, 0, 'unknown', '', 2, 1),
	('0x4', 0, 'a', '0xa', 'usdc', '0', 200, 0, 0, 'rejected', '200 cents not credited: under the $3 minimum or over the caps, to refund', 3, 1),
	('0x5', 0, 'a', '0xa', 'usdc', '0', 2000, 20, 1980, 'credited', '3000 cents over the caps, to refund', 4, 1),
	('0x6', 0, 'a', '0xa', 'usdc', '0', 1000, 10, 990, 'credited', '', 5, 1),
	('0x7', 0, '', '0xc', 'usdc', '0', 900, 0, 0, 'rejected', 'seed', 6, 1),
	('0x8', 0, '', '0xd', 'usdc', '0', 900, 0, 0, 'pending', '', 7, 1),
	('0x9', 0, 'a', '0xa', 'usdc', '0', 900, 0, 0, 'rejected', '-5 cents', 8, 1),
	('0xa', 0, 'a', '0xa', 'usdc', '0', 900, 9, 891, 'credited', 'odd note', 9, 1);`, R, S); err != nil {
		t.Fatal(err)
	}
	listed := func(db *sql.DB, q string) map[string]int64 {
		rows, err := db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		cols, _ := rows.Columns()
		out := map[string]int64{}
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			row := map[string]any{}
			for i, c := range cols {
				row[c] = vals[i]
			}
			out[fmt.Sprintf("%v:%v", strings.ToLower(fmt.Sprint(row["tx"])), row["log_index"])] = row["owed_cents"].(int64)
		}
		return out
	}
	before := listed(db, owedQuery(t))
	db.Close()
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	after := listed(s.db, `SELECT tx, log_index, refund_cents AS owed_cents FROM topups WHERE refund_cents > 0`)
	want := map[string]int64{"0x3:0": 4000, "0x4:0": 200, "0x5:0": 3000}
	if !reflect.DeepEqual(after, want) {
		t.Fatalf("migration 7 owes %v, the test expected %v", after, want)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("the pre-deploy query lists %v, migration 7 owes %v", before, after)
	}
}
