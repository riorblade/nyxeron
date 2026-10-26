package main

// Review of PR #64, round 2 (head 43b3196): attacks on "the scanner skips unreadable blocks and retries what it
// skipped". A passing test proves an attack held; a failing test is a finding (see the comment on each).

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// rvbProxy sits in front of a fake rpc. While intercept returns a body for a method, that body is answered (HTTP
// 200) instead; status, when > 0, is answered as a bare HTTP status instead. Bytes counts what the proxy sent back.
type rvbProxy struct {
	mu        sync.Mutex
	intercept map[string]string // method → body answered instead of the upstream's
	status    map[string]int    // method → HTTP status answered instead
	bytes     atomic.Int64
}

func (p *rvbProxy) set(method, body string, status int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.intercept == nil {
		p.intercept, p.status = map[string]string{}, map[string]int{}
	}
	delete(p.intercept, method)
	delete(p.status, method)
	if body != "" {
		p.intercept[method] = body
	}
	if status > 0 {
		p.status[method] = status
	}
}

func (p *rvbProxy) serve(t *testing.T, upstream string) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct{ Method string }
		_ = json.Unmarshal(raw, &req)
		p.mu.Lock()
		body, hit := p.intercept[req.Method]
		code := p.status[req.Method]
		p.mu.Unlock()
		if code > 0 {
			w.WriteHeader(code)
			return
		}
		if hit {
			p.bytes.Add(int64(len(body)))
			_, _ = w.Write([]byte(body))
			return
		}
		res, err := http.Post(upstream, "application/json", bytes.NewReader(raw))
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		out, _ := io.ReadAll(res.Body)
		p.bytes.Add(int64(len(out)))
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// What real BSC providers answer, HTTP 200, when they throttle or have a hiccup: a JSON-RPC error. Nothing about the
// request is wrong; asking again later works.
const (
	rvbRateLimited = `{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}`
	rvbUpstream    = `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"upstream request timeout"}}`
)

func rvbPlayer(t *testing.T) *topupAPI {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	return x
}

func rvbScanCursor(t *testing.T, s *store) string {
	t.Helper()
	var v string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&v)
	return v
}

// ---------- 1. a transient refusal from both providers is treated as "this block is unreadable" ----------

// FINDING (medium): both() turns any JSON-RPC error from both providers into errRefused, and scanRange/scanTransfers
// treat errRefused like an oversized block: skip it (logs) or record it "unknown" (receipt). Throttling ("limit
// exceeded", -32005) and upstream timeouts are JSON-RPC errors at HTTP 200 on most BSC providers, and both
// providers throttling eth_getLogs together is plausible (our own halving + retries hit both at once; an attacker's
// 4 MB blocks make every getLogs heavy). eth_blockNumber keeps working, so SafeHead doesn't stop the pass.
// Before 43b3196 such a pass stopped and the deposit was credited when the providers recovered. Now the block is
// passed, retried scanRetryMax times over ≈5 h, then given up: an outage of getLogs on both providers that lasts
// longer than that leaves an unreported deposit uncredited for good (back office only), even after recovery.
// This is the "both RPCs fail transiently: should stop, not skip" case.
func TestRV64bTransientRefusalOfBothSkipsAndLosesTheDeposit(t *testing.T) {
	for name, msg := range map[string]string{"rate limited": rvbRateLimited, "upstream timeout": rvbUpstream} {
		t.Run(name, func(t *testing.T) {
			x := rvbPlayer(t)
			var pa, pb rvbProxy
			c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
			now := time.Unix(1_900_000_000, 0)
			x.db.setScanned(ctx, usdcAt-1, now) // the player's $906 deposit (usdcTx) is in usdcAt, never reported
			pa.set("eth_getLogs", msg, 0)
			pb.set("eth_getLogs", msg, 0)
			_ = x.db.scanTopups(ctx, c, now)
			moved := rvbScanCursor(t, x.db)
			for range 36 { // the throttling lasts 6 h; a pass every 10 min
				now = now.Add(10 * time.Minute)
				_ = x.db.scanTopups(ctx, c, now)
			}
			pa.set("eth_getLogs", "", 0) // the providers recover
			pb.set("eth_getLogs", "", 0)
			for range 30 {
				now = now.Add(10 * time.Minute)
				_ = x.db.scanTopups(ctx, c, now)
			}
			if credits(t, x.db, brutalMe) == 0 {
				var st string
				var n int
				x.db.db.QueryRow(`SELECT status, attempts FROM scan_retries WHERE block = ? AND ref = ?`, usdcAt, usdcAddr()).Scan(&st, &n)
				t.Fatalf("a transient refusal by both providers moved the cursor past the deposit's block (cursor %s after "+
					"the first throttled pass, from %d) and the scanner never credited it after recovery: retry %q after %d reads",
					moved, usdcAt-1, st, n)
			}
		})
	}
}

// FINDING (medium, same root cause, receipt path, and no per-pass limit): both providers throttling
// eth_getTransactionReceipt during a pass records EVERY player deposit in the range as "unknown" ("unreadable
// receipt") and moves on, with no scanSkipsPerPass bound. Retries recover them if the throttling ends within ≈5 h;
// otherwise they are given up although the receipts are perfectly readable.
func TestRV64bTransientReceiptRefusalRecordsEveryDepositUnreadable(t *testing.T) {
	x := rvbPlayer(t)
	const n = 30
	for i := range n {
		tx := bTx(0xd000 + i)
		x.put(tx, bReceipt(tx, uint64(usdcAt-n+i), bLog{from: player, amount: centsAmt(500), idx: 0}))
	}
	var pa, pb rvbProxy
	c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
	now := time.Unix(1_900_000_000, 0)
	x.db.setScanned(ctx, usdcAt-n-1, now)
	pa.set("eth_getTransactionReceipt", rvbRateLimited, 0)
	pb.set("eth_getTransactionReceipt", rvbRateLimited, 0)
	_ = x.db.scanTopups(ctx, c, now)
	unknown := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown' AND reason LIKE 'unreadable%'`)
	t.Logf("one throttled pass: cursor %s (started at %d), %d deposits recorded unreadable", rvbScanCursor(t, x.db), usdcAt-n-1, unknown)
	if unknown > 0 {
		t.Fatalf("a throttled eth_getTransactionReceipt on both providers recorded %d readable deposits as unreadable "+
			"and moved the cursor past them in one pass (no per-pass bound on receipts)", unknown)
	}
}

// Held: both providers DOWN (HTTP 503, or one 503 and one JSON-RPC error) for eth_getLogs stops the scan: no skip,
// no retry row, cursor stays.
func TestRV64bBothProvidersDownStops(t *testing.T) {
	for name, set := range map[string]func(a, b *rvbProxy){
		"both 503":        func(a, b *rvbProxy) { a.set("eth_getLogs", "", 503); b.set("eth_getLogs", "", 503) },
		"503 + rpc error": func(a, b *rvbProxy) { a.set("eth_getLogs", "", 503); b.set("eth_getLogs", rvbRateLimited, 0) },
		"garbage + 503":   func(a, b *rvbProxy) { a.set("eth_getLogs", "<html>", 0); b.set("eth_getLogs", "", 502) },
	} {
		t.Run(name, func(t *testing.T) {
			x := rvbPlayer(t)
			var pa, pb rvbProxy
			c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
			set(&pa, &pb)
			x.db.setScanned(ctx, usdcAt-1, time.Now())
			for range 3 {
				if err := x.db.scanTopups(ctx, c, time.Now()); err == nil {
					t.Fatal("the scan went on")
				}
			}
			if cur := rvbScanCursor(t, x.db); cur != fmt.Sprint(usdcAt-1) || count(t, x.db, `SELECT COUNT(*) FROM scan_retries`) != 0 {
				t.Fatalf("cursor %s, retries %d", cur, count(t, x.db, `SELECT COUNT(*) FROM scan_retries`))
			}
		})
	}
}

// ---------- 2. the retry queue ----------

// FINDING (low): retryScans picks the 20 open rows with the oldest updated_at and only then checks which are due.
// 20 rows waiting out a long backoff (an attacker's permanently unreadable blocks late in their 10 reads) fill the
// window, and a real deposit's retry that is due right now waits until they come due (up to 128 min a round; with
// a growing backlog, longer). Fix: filter by due time in SQL (updated_at + backoff <= now) and/or read "receipt"
// rows (players' money) before "logs" rows.
func TestRV64bRetryWindowIsBlockedByRowsNotDue(t *testing.T) {
	x := rvbPlayer(t)
	now := time.Unix(1_900_000_000, 0)
	for i := range scanRetriesPerPass { // the attacker's blocks: 8 reads behind them, next read in 64 min
		x.db.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
			VALUES ('logs', ?, ?, 'x', 8, 'open', ?, ?)`, usdcAddr(), usdcAt-1000+i, now.Add(-3*time.Hour).Unix(), now.Add(-time.Minute).Unix())
	}
	good := x.a.receipts[usdcTx]
	x.put(bTx(0x1098), good) // keeps the transfer in eth_getLogs
	x.put(usdcTx, `<html>502</html>`)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, now)
	_ = x.db.scanTopups(ctx, c, now) // the victim's receipt reads as garbage on both: unknown + retry
	x.put(usdcTx, good)              // the providers recover
	for range 5 {                    // five passes, a minute apart: the victim's retry is due on each
		now = now.Add(time.Minute)
		_ = x.db.scanTopups(ctx, c, now)
	}
	if credits(t, x.db, brutalMe) == 0 {
		var st string
		var n int
		x.db.db.QueryRow(`SELECT status, attempts FROM scan_retries WHERE kind = 'receipt'`).Scan(&st, &n)
		t.Fatalf("a due retry of a player's deposit was never read in 5 passes: 20 not-due rows hold the window (%q, %d reads)", st, n)
	}
}

// FINDING (low): the back office sees at most 200 scan_retries rows, given-up ones first, and nothing ever closes a
// given-up row (no admin action). Anyone who makes 200 blocks unreadable (≈$2 each) pushes every open row, and every
// older given-up row (a real deposit's included), off the Payments page for good.
func TestRV64bGivenUpRowsBuryTheRestInTheBackOffice(t *testing.T) {
	s := testStore(t)
	now := time.Now().Unix()
	s.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
		VALUES ('receipt', ?, 100, 'unreadable', 10, 'given_up', ?, ?)`, bTx(0x5ea1), now, now) // a real deposit
	s.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
		VALUES ('receipt', ?, 150, 'unreadable', 1, 'open', ?, ?)`, bTx(0x5ea2), now, now) // another, still open
	for i := range 200 {
		s.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
			VALUES ('logs', ?, ?, 'over 4 MB', 10, 'given_up', ?, ?)`, usdcAddr(), 1000+i, now, now)
	}
	p, err := s.Payments(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, r := range p.ScanRetries {
		seen[r.Ref] = true
	}
	if !seen[bTx(0x5ea1)] || !seen[bTx(0x5ea2)] {
		t.Fatalf("200 attacker rows hide the players' rows from the back office (given-up shown %v, open shown %v)",
			seen[bTx(0x5ea1)], seen[bTx(0x5ea2)])
	}
}

// Held: a real deposit whose receipt was unreadable is credited exactly once when the scanner's retry and the
// player's own report race (20 rounds), and nothing stays owed back on it.
func TestRV64bRetryAndReportRaceCreditOnce(t *testing.T) {
	for round := range 20 {
		x := rvbPlayer(t)
		good := x.a.receipts[usdcTx]
		x.put(bTx(0x1099), good)
		x.put(usdcTx, `{"cut`)
		c := newBSC(x.a.serve(t), x.b.serve(t))
		now := time.Now()
		x.db.setScanned(ctx, usdcAt-1, now)
		_ = x.db.scanTopups(ctx, c, now)
		if count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'unknown'`, usdcTx) != 1 {
			t.Fatal("setup: no unknown row")
		}
		x.put(usdcTx, good)
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); _ = x.db.scanTopups(ctx, c, now.Add(time.Second)) }()
		go func() { defer wg.Done(); x.post(usdcTx) }()
		go func() { defer wg.Done(); x.post(usdcTx) }()
		wg.Wait()
		_ = x.db.scanTopups(ctx, c, now.Add(time.Hour))
		var owed int64
		x.db.db.QueryRow(`SELECT COALESCE(SUM(refund_cents), 0) FROM topups WHERE tx = ?`, usdcTx).Scan(&owed)
		if got := credits(t, x.db, brutalMe); got != 89769 ||
			count(t, x.db, `SELECT COUNT(*) FROM ledger WHERE user_id = ? AND kind = 'topup'`, brutalMe) > 1 ||
			count(t, x.db, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'fee'`) != 1 || owed != 0 {
			t.Fatalf("round %d: credits %d, owed %d", round, got, owed)
		}
	}
}

// Held: a deposit in a skipped block that the player reports meanwhile is credited once; the retry that reads the
// block later finds it recorded and adds nothing.
func TestRV64bSkippedBlockReportedThenRetriedCreditsOnce(t *testing.T) {
	x := rvbPlayer(t)
	x.a.refuseLogsAt = map[uint64]bool{usdcAt: true}
	x.b.refuseLogsAt = map[uint64]bool{usdcAt: true}
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-1, now)
	if err := x.db.scanTopups(ctx, c, now); err != nil || rvbScanCursor(t, x.db) != rvSafe() {
		t.Fatalf("setup: %v, cursor %s", err, rvbScanCursor(t, x.db))
	}
	if code, _ := x.post(usdcTx); code != 200 {
		t.Fatalf("report %d", code)
	}
	x.a.refuseLogsAt, x.b.refuseLogsAt = nil, nil
	for i := range 3 {
		_ = x.db.scanTopups(ctx, c, now.Add(time.Duration(i+1)*time.Hour))
	}
	if credits(t, x.db, brutalMe) != 89769 || count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ?`, usdcTx) != 1 ||
		count(t, x.db, `SELECT COUNT(*) FROM scan_retries WHERE status = 'done'`) != 2 {
		t.Fatalf("credits %d", credits(t, x.db, brutalMe))
	}
}

// Held: a retry credits under the caps of when it reads (over the daily cap: rejected, owed back), and while
// payments are paused it credits nothing and counts no read; once unpaused it credits.
func TestRV64bRetryRespectsCapAndPause(t *testing.T) {
	t.Run("cap", func(t *testing.T) {
		x := rvbPlayer(t)
		realCaps(t)
		now := time.Now()
		rec(t, x.db, bTx(0xca9), 0, centsAmt(2000), brutalMe, now.Add(-time.Hour)) // $20 credited an hour ago
		good := x.a.receipts[usdcTx]
		x.put(bTx(0x109a), good)
		x.put(usdcTx, `nope`)
		c := newBSC(x.a.serve(t), x.b.serve(t))
		x.db.setScanned(ctx, usdcAt-1, now)
		_ = x.db.scanTopups(ctx, c, now)
		x.put(usdcTx, good)
		_ = x.db.scanTopups(ctx, c, now.Add(time.Minute))
		var st string
		var owed int64
		x.db.db.QueryRow(`SELECT status, refund_cents FROM topups WHERE tx = ?`, usdcTx).Scan(&st, &owed)
		if st != "rejected" || owed != 90676 || credits(t, x.db, brutalMe) != 1980 {
			t.Fatalf("retry over the cap: %s owed %d credits %d", st, owed, credits(t, x.db, brutalMe))
		}
	})
	t.Run("pause", func(t *testing.T) {
		x := rvbPlayer(t)
		good := x.a.receipts[usdcTx]
		x.put(bTx(0x109b), good)
		x.put(usdcTx, `nope`)
		c := newBSC(x.a.serve(t), x.b.serve(t))
		now := time.Now()
		x.db.setScanned(ctx, usdcAt-1, now)
		_ = x.db.scanTopups(ctx, c, now)
		x.put(usdcTx, good)
		x.db.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, '["test"]', 1)`, pauseKey)
		for i := range 30 {
			_ = x.db.scanTopups(ctx, c, now.Add(time.Duration(i+1)*time.Hour))
		}
		var st string
		var n int
		x.db.db.QueryRow(`SELECT status, attempts FROM scan_retries WHERE kind = 'receipt'`).Scan(&st, &n)
		if credits(t, x.db, brutalMe) != 0 || st != "open" || n != 1 {
			t.Fatalf("paused: credits %d, retry %q after %d reads", credits(t, x.db, brutalMe), st, n)
		}
		x.db.db.Exec(`DELETE FROM settings WHERE key = ?`, pauseKey)
		_ = x.db.scanTopups(ctx, c, now.Add(40*time.Hour))
		if credits(t, x.db, brutalMe) != 89769 {
			t.Fatalf("unpaused: credits %d", credits(t, x.db, brutalMe))
		}
	})
}

// Held (fuzz): with random blocks refused by both providers and deposits in random blocks, the scanner credits every
// deposit in a readable block, records a retry only for refused blocks, and ends at the safe head; never more than
// scanSkipsPerPass blocks are passed in one pass.
func TestRV64bCursorNeverSkipsAReadableBlock(t *testing.T) {
	r := rand.New(rand.NewSource(64))
	for round := range 8 {
		x := rvbPlayer(t)
		delete(x.a.receipts, usdcTx)
		delete(x.b.receipts, usdcTx)
		lo := uint64(usdcAt - 300)
		refuse := map[uint64]bool{}
		for range 12 {
			refuse[lo+1+uint64(r.Intn(300))] = true
		}
		var readable []string
		used := map[uint64]bool{} // one deposit per block: the fake rpcs list a block's logs in map order
		for i := range 25 {
			b := lo + 1 + uint64(r.Intn(300))
			for used[b] {
				b = lo + 1 + uint64(r.Intn(300))
			}
			used[b] = true
			tx := bTx(0xf0000 + round*100 + i)
			x.put(tx, bReceipt(tx, b, bLog{from: player, amount: centsAmt(int64(300 + i)), idx: 0}))
			if !refuse[b] {
				readable = append(readable, tx)
			}
		}
		x.a.refuseLogsAt, x.b.refuseLogsAt = refuse, refuse
		c := newBSC(x.a.serve(t), x.b.serve(t))
		now := time.Unix(1_900_000_000, 0)
		x.db.setScanned(ctx, lo, now)
		for pass := 0; rvbScanCursor(t, x.db) != rvSafe(); pass++ {
			before := count(t, x.db, `SELECT COUNT(DISTINCT block) FROM scan_retries WHERE kind = 'logs'`)
			_ = x.db.scanTopups(ctx, c, now)
			if d := count(t, x.db, `SELECT COUNT(DISTINCT block) FROM scan_retries WHERE kind = 'logs'`) - before; d > scanSkipsPerPass {
				t.Fatalf("round %d: one pass passed %d blocks", round, d)
			}
			if pass > 20 {
				t.Fatalf("round %d: cursor stuck at %s", round, rvbScanCursor(t, x.db))
			}
		}
		for _, tx := range readable {
			if count(t, x.db, `SELECT COUNT(*) FROM topups WHERE tx = ? AND status = 'credited'`, tx) != 1 {
				t.Fatalf("round %d: deposit %s in a readable block not credited", round, tx)
			}
		}
		rows, _ := x.db.db.Query(`SELECT DISTINCT block FROM scan_retries`)
		for rows.Next() {
			var b int64
			rows.Scan(&b)
			if !refuse[uint64(b)] {
				rows.Close()
				t.Fatalf("round %d: readable block %d recorded as skipped", round, b)
			}
		}
		rows.Close()
		// The providers answer everything now: the retries credit the rest.
		x.a.refuseLogsAt, x.b.refuseLogsAt = nil, nil
		for i := range 3 {
			_ = x.db.scanTopups(ctx, c, now.Add(time.Duration(i+1)*time.Hour))
		}
		if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'credited'`); n != 25 {
			t.Fatalf("round %d: %d of 25 credited after the retries", round, n)
		}
	}
}

// Measure (logged, not a finding by itself): what one permanently unreadable block (≈9k zero-value Transfer logs to
// the Agentic Wallet, ≈$2 of BNB) costs us in rpc traffic from first sight to given up, and that it is bounded.
func TestRV64bOneAttackBlockRPCCost(t *testing.T) {
	x := rvbPlayer(t)
	attack := bTx(0xa77ac3)
	var logs []bLog
	for i := range 10_000 {
		logs = append(logs, bLog{from: rvStranger, amount: big.NewInt(0), idx: uint64(i)})
	}
	x.put(attack, bReceipt(attack, usdcAt-1, logs...))
	var pa, pb rvbProxy
	c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
	now := time.Unix(1_900_000_000, 0)
	x.db.setScanned(ctx, usdcAt-400, now)
	for range 60 { // 30 h, a pass every 30 min
		_ = x.db.scanTopups(ctx, c, now)
		now = now.Add(30 * time.Minute)
	}
	after := pa.bytes.Load() + pb.bytes.Load()
	for range 10 {
		_ = x.db.scanTopups(ctx, c, now)
		now = now.Add(30 * time.Minute)
	}
	st, n := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt-1)
	t.Logf("one attack block: %.0f MB of rpc answers read, retry %q after %d reads; later passes read %d bytes more",
		float64(after)/1e6, st, n, pa.bytes.Load()+pb.bytes.Load()-after)
	if st != "given_up" || pa.bytes.Load()+pb.bytes.Load()-after > 1e6 || credits(t, x.db, brutalMe) == 0 {
		t.Fatalf("unbounded: %q %d", st, n)
	}
}

// ---------- 3. migrations 7 + 8 on production-like databases ----------

func rvbAt(t *testing.T, version int) (string, func()) {
	t.Helper()
	all := migrations
	migrations = all[:version]
	path := filepath.Join(t.TempDir(), "prod.db")
	s, err := openStore(path)
	migrations = all
	if err != nil {
		t.Fatal(err)
	}
	return path, func() { s.close() }
}

// Held: a v6 database (production today) with top-ups in every state ends at v8 with refund_cents, credited_at,
// scan_retries and the ledger index as on a fresh database; re-running 7 and 8 changes nothing.
func TestRV64bMigrations7And8OnAV6Database(t *testing.T) {
	if len(migrations) < 8 {
		t.Fatalf("%d migrations, want at least 8 (7 = #57, 8 = #64)", len(migrations))
	}
	if !strings.Contains(migrations[6], "refund_cents") || !strings.Contains(migrations[7], "scan_retries") {
		t.Fatal("order: 7 must be #57's refund columns, 8 this PR's")
	}
	fresh := rvSchema(t, testStore(t))
	path, done := rvbAt(t, 6) // built by migrations 1-6 only: what production is today
	done()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	var v6 int
	db.QueryRow(`PRAGMA user_version`).Scan(&v6)
	if v6 != 6 {
		t.Fatalf("setup at v%d", v6)
	}
	for _, q := range []string{
		`INSERT INTO platform_ledger (delta, kind, ref, reason, at) VALUES (0, 'restock', '0x0b', 'swap', 1)`,
		`INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, credits, status, reason, created_at, updated_at) VALUES
			('0x01', 0, 'a', '0xs', '0xt', '1', 2000, 20, 1980, 'credited', '', 100, 100),
			('0x02', 0, 'a', '0xs', '0xt', '1', 2000, 20, 1980, 'credited', '7000 cents over the caps, to refund', 100, 90000),
			('0x03', 0, '', '0xs', '0xt', '1', 500, 0, 0, 'unknown', '', 100, 100),
			('0x04', 0, 'a', '0xs', '0xt', '1', 250, 0, 0, 'rejected', '250 cents not credited: under the $3 minimum', 100, 200),
			('0x0b', 1, '', '0xr', '0xt', '1', 42, 0, 0, 'unknown', '', 100, 100)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()
	type row struct{ refund, credited int64 }
	want := map[string]row{"0x01": {0, 100}, "0x02": {7000, 90000}, "0x03": {500, 0}, "0x04": {250, 0}, "0x0b": {0, 0}}
	for pass := range 2 {
		s, err := openStore(path)
		if err != nil {
			t.Fatalf("pass %d: %v", pass, err)
		}
		var v int
		s.db.QueryRow(`PRAGMA user_version`).Scan(&v)
		if v != len(migrations) {
			t.Fatalf("user_version %d", v)
		}
		for tx, w := range want {
			var got row
			s.db.QueryRow(`SELECT refund_cents, credited_at FROM topups WHERE tx = ?`, tx).Scan(&got.refund, &got.credited)
			if got != w {
				t.Fatalf("pass %d: %s = %+v, want %+v", pass, tx, got, w)
			}
		}
		if got := rvSchema(t, s); got != fresh {
			t.Fatalf("pass %d: schema differs from a fresh db:\n%s\n---\n%s", pass, got, fresh)
		}
		if pass == 0 {
			s.db.Exec(`PRAGMA user_version = 6`)
		}
		s.close()
	}
}

// Held: a database at v7 (#57 merged and deployed first, the scanner writing refund_cents since) gets only
// migration 8: nothing #57 recorded changes, credited rows get their credited_at.
func TestRV64bMigration8OnA57Database(t *testing.T) {
	path, done := rvbAt(t, 7)
	done()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	var v int
	db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != 7 {
		t.Fatalf("setup at v%d", v)
	}
	if _, err := db.Exec(`INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, credits, status,
		reason, refund_cents, refunded_at, created_at, updated_at) VALUES
		('0x01', 0, 'a', '0xs', '0xt', '1', 2000, 20, 1980, 'credited', 'x', 300, 0, 100, 5000),
		('0x02', 0, '', '0xs', '0xt', '1', 500, 0, 0, 'rejected', 'refunded', 500, 777, 100, 777),
		('0x03', 0, '', '0xr', '0xt', '1', 42, 0, 0, 'unknown', '', 0, 0, 100, 100)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	for tx, w := range map[string][3]int64{"0x01": {300, 0, 5000}, "0x02": {500, 777, 0}, "0x03": {0, 0, 0}} {
		var got [3]int64
		s.db.QueryRow(`SELECT refund_cents, refunded_at, credited_at FROM topups WHERE tx = ?`, tx).Scan(&got[0], &got[1], &got[2])
		if got != w {
			t.Fatalf("%s = %v, want %v", tx, got, w)
		}
	}
}
