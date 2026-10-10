package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

// Top-up reports cost paid rpc calls that the scanner and reconciliation share: what one player can make the api
// spend on hashes that are not their top-ups is bounded, and the pacing holds whatever the number of players.

// receiptCalls: how many receipts the first rpc was asked for so far.
func (x *topupAPI) receiptCalls() int {
	x.a.mu.Lock()
	defer x.a.mu.Unlock()
	n := 0
	for _, m := range x.a.methods {
		if m == "eth_getTransactionReceipt" {
			n++
		}
	}
	return n
}

// postAs reports tx as another signed-in player (sub), with a token from the same fake Privy.
func (x *topupAPI) postAs(tok, tx string) int {
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(map[string]string{"tx": tx})
	req, _ := http.NewRequest(http.MethodPost, x.srv.URL+"/api/topups", &buf)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		x.t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body) // keep the connection for the next request
	res.Body.Close()
	return res.StatusCode
}

// More than 10,000 players reporting must not reset everyone's pace: the limiter forgets old entries, not all.
func TestTopupRateLimitHoldsPastTenThousandPlayers(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	topupEvery = time.Hour
	if code, _ := x.post(usdcTx); code != 200 {
		t.Fatalf("first %d", code)
	}
	key := x.key
	for i := range 10_001 {
		claims := good(time.Now().Add(time.Hour))
		claims["sub"] = fmt.Sprintf("did:privy:n%d", i)
		x.postAs(signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, claims), "0x"+fmt.Sprintf("%064x", i))
	}
	if code, out := x.post(usdcTx); code != 429 || out["error"] != "too_soon" {
		t.Fatalf("after 10,001 other players: %d %v (the limiter was reset)", code, out)
	}
}

// Random hashes (no such transaction) cost the rpcs at most topupMissBudget lookups per player per window.
func TestTopupRandomHashesCostABoundedNumberOfRPCCalls(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	for i := range 100 {
		x.post(fmt.Sprintf("0x%064x", 0xdead0000+i))
	}
	if n := x.receiptCalls(); n > topupMissBudget {
		t.Fatalf("100 random hashes cost %d receipt calls, budget %d", n, topupMissBudget)
	}
	code, out := x.post(fmt.Sprintf("0x%064x", 0xbeef))
	if code != 429 || out["error"] != "too_many_misses" {
		t.Fatalf("past the budget: %d %v", code, out)
	}
}

// The same random hash, again and again, is bounded the same way.
func TestTopupRepeatedRandomHashCostsABoundedNumberOfRPCCalls(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	for range 100 {
		x.post("0x" + fmt.Sprintf("%064x", 0xdead))
	}
	if n := x.receiptCalls(); n > topupMissBudget {
		t.Fatalf("one random hash 100 times cost %d receipt calls, budget %d", n, topupMissBudget)
	}
}

// A settled answer that isn't a top-up (someone else's transfer, a failed tx) is remembered: repeats cost nothing.
func TestTopupSettledRefusalsAreRemembered(t *testing.T) {
	for name, c := range map[string]struct {
		tx, receipt, err string
	}{
		"not a top-up": {tx: usdcTx, err: "not_a_topup"},
		"failed tx":    {tx: failedTx, err: "tx_failed"},
	} {
		t.Run(name, func(t *testing.T) {
			x := newTopupAPI(t, player, usdcAt+20)
			if c.err == "not_a_topup" {
				x.receipt(fixture(t, "receipt-usdc-transfer")) // not to the platform
			}
			if code, out := x.post(c.tx); code != 422 || out["error"] != c.err {
				t.Fatalf("first %d %v", code, out)
			}
			before := x.receiptCalls()
			for range 10 {
				if code, out := x.post(c.tx); code != 422 || out["error"] != c.err {
					t.Fatalf("repeat %d %v", code, out)
				}
			}
			if n := x.receiptCalls() - before; n != 0 {
				t.Fatalf("10 repeats cost %d receipt calls", n)
			}
		})
	}
}

// A real top-up still confirming (202) is re-reported by its owner every few seconds for as long as it takes, past
// the miss budget, and is credited once final.
func TestTopupPendingTransferStaysReportable(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+game.payments.Confirmations-2)
	for i := range 3 * topupMissBudget {
		if code, out := x.post(usdcTx); code != 202 {
			t.Fatalf("report %d while confirming: %d %v", i, code, out)
		}
	}
	x.a.mu.Lock()
	x.a.head, x.b.head = usdcAt+20, usdcAt+20
	x.a.mu.Unlock()
	if code, out := x.post(usdcTx); code != 200 || out["status"] != "credited" {
		t.Fatalf("once final: %d %v", code, out)
	}
}

// A few misses (a transfer the rpcs don't see yet) don't stop that player's real top-up.
func TestTopupAFewMissesDoNotBlockARealTopup(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	for i := range topupMissBudget - 1 {
		x.post(fmt.Sprintf("0x%064x", 0xdead0000+i))
	}
	if code, out := x.post(usdcTx); code != 200 || out["status"] != "credited" {
		t.Fatalf("%d %v", code, out)
	}
}

// The limiter's memory: entries older than their window are dropped, live ones kept.
func TestTopupGuardForgetsOnlyOldEntries(t *testing.T) {
	g := newTopupGuard()
	now := time.Now()
	for i := range 3 * topupGuardSweep {
		g.tooSoon(fmt.Sprint(i), now, time.Second)
	}
	if !g.tooSoon("0", now.Add(500*time.Millisecond), time.Second) {
		t.Fatal("a live entry was forgotten")
	}
	later := now.Add(topupMissWindow + time.Second)
	g.tooSoon("fresh", later, time.Second)
	g.miss("fresh", later)
	g.mu.Lock()
	g.sweep(later)
	n := len(g.last) + len(g.misses) + len(g.settled)
	g.mu.Unlock()
	if n != 2 {
		t.Fatalf("%d entries after a sweep, want 2", n)
	}
}
