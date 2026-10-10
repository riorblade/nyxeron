package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Providers that don't serve eth_getLogs at all (a plan without it: "method not found") make the scanner stop, not
// skip: no retry row, the cursor stays, and the deposit is credited once a provider that serves it is used.
func TestScanStopsWhenNeitherProviderServesGetLogs(t *testing.T) {
	x := rvbPlayer(t)
	var pa, pb rvbProxy
	c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
	const notFound = `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"the method eth_getLogs does not exist/is not available"}}`
	pa.set("eth_getLogs", notFound, 0)
	pb.set("eth_getLogs", notFound, 0)
	now := time.Unix(1_900_000_000, 0)
	x.db.setScanned(ctx, usdcAt-1, now)
	for range 3 {
		if err := x.db.scanTopups(ctx, c, now); err == nil {
			t.Fatal("the scan went on without eth_getLogs")
		}
		now = now.Add(10 * time.Minute)
	}
	if cur := rvbScanCursor(t, x.db); cur != fmt.Sprint(usdcAt-1) || count(t, x.db, `SELECT COUNT(*) FROM scan_retries`) != 0 {
		t.Fatalf("cursor %s, %d retries", cur, count(t, x.db, `SELECT COUNT(*) FROM scan_retries`))
	}
	pa.set("eth_getLogs", "", 0)
	pb.set("eth_getLogs", "", 0)
	if err := x.db.scanTopups(ctx, c, now); err != nil || credits(t, x.db, brutalMe) == 0 {
		t.Fatalf("not credited once served: %v", err)
	}
}

// A retry read while both providers throttle doesn't count: its reads stay as they were, so an outage longer than the
// retry window can't give up a block that reads fine afterwards.
func TestScanRetryUnderThrottlingDoesNotCount(t *testing.T) {
	x := rvbPlayer(t)
	var pa, pb rvbProxy
	c := newBSC(pa.serve(t, x.a.serve(t)), pb.serve(t, x.b.serve(t)))
	now := time.Unix(1_900_000_000, 0)
	x.db.setScanned(ctx, usdcAt+40, now) // nothing new to scan: only the retry is read
	x.db.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
		VALUES ('logs', ?, ?, 'x', 3, 'open', ?, ?)`, usdcAddr(), usdcAt, now.Unix(), now.Add(-time.Hour).Unix())
	pa.set("eth_getLogs", rvbRateLimited, 0)
	pb.set("eth_getLogs", rvbRateLimited, 0)
	for range 50 { // two days of throttling
		now = now.Add(time.Hour)
		_ = x.db.scanTopups(ctx, c, now)
	}
	if st, n := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt); st != "open" || n != 3 {
		t.Fatalf("throttled reads counted: %q after %d reads", st, n)
	}
	pa.set("eth_getLogs", "", 0)
	pb.set("eth_getLogs", "", 0)
	_ = x.db.scanTopups(ctx, c, now.Add(time.Hour))
	if st, _ := scanRetryRow(t, x.db, "logs", usdcAddr(), usdcAt); st != "done" || credits(t, x.db, brutalMe) == 0 {
		t.Fatalf("%q, credits %d", st, credits(t, x.db, brutalMe))
	}
}

// The back office closes a given-up (or open) row once it checked it by hand: with a reason, audited with the row as
// it was, gone from Payments, not read again, and only once.
func TestResolveScanRetry(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	tx := bTx(0x5ea1)
	s.db.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, attempts, status, created_at, updated_at)
		VALUES ('receipt', ?, 100, 'unreadable', 30, 'given_up', ?, ?)`, tx, now.Unix(), now.Unix())
	if err := s.ResolveScanRetry(ctx, "ops@x", "receipt", tx, 100, " ", now); err != errBad {
		t.Fatalf("no reason: %v", err)
	}
	if err := s.ResolveScanRetry(ctx, "ops@x", "receipt", tx, 101, "x", now); err != errNoScanRetry {
		t.Fatalf("missing row: %v", err)
	}
	if err := s.ResolveScanRetry(ctx, "ops@x", "receipt", tx, 100, "credited by hand, see refund 0xabc", now); err != nil {
		t.Fatal(err)
	}
	if err := s.ResolveScanRetry(ctx, "ops@x", "receipt", tx, 100, "again", now); err != errConflict {
		t.Fatalf("resolved twice: %v", err)
	}
	p, err := s.Payments(ctx)
	if err != nil || len(p.ScanRetries) != 0 {
		t.Fatalf("still shown: %v %+v", err, p.ScanRetries)
	}
	var actor, detail, why string
	s.db.QueryRow(`SELECT actor, detail, reason FROM audit WHERE action = 'scan-retry-resolve'`).Scan(&actor, &detail, &why)
	if actor != "ops@x" || !strings.Contains(detail, "given_up") || !strings.Contains(why, "credited by hand") {
		t.Fatalf("audit: %q %q %q", actor, detail, why)
	}
}
