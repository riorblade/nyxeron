package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// walletHolds sets what the fake rpcs report the Agentic Wallet holds: USDC in cents, TSLAB in units.
func walletHolds(a, b *fakeRPC, usdcCents int64, tslaUnits int64) {
	usdc := new(big.Int).Mul(big.NewInt(usdcCents), big.NewInt(1e16))
	tsla := new(big.Int).Mul(big.NewInt(tslaUnits), big.NewInt(1e15))
	for _, f := range []*fakeRPC{a, b} {
		f.mu.Lock()
		f.balances = map[string]string{
			strings.ToLower(game.payments.Topup.Tokens["USDC"]):    fmt.Sprintf("0x%064x", usdc),
			strings.ToLower(game.payments.Topup.Tokens["USDT"]):    fmt.Sprintf("0x%064x", 0),
			strings.ToLower(game.payments.Tokens["tsla"].Contract): fmt.Sprintf("0x%064x", tsla),
		}
		f.mu.Unlock()
	}
}

// The city of sales_test (a CEO, a guest with 1,000 credits, 10 TSLA units, a party) on a fake chain.
func reconCity(t *testing.T) (*city, *bsc, *fakeRPC, *fakeRPC) {
	c := newCity(t)
	ch, a, b := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	return c, ch, a, b
}

func TestReconcileMatchesWhenBacked(t *testing.T) {
	c, ch, a, b := reconCity(t)
	walletHolds(a, b, 1000, 10) // $10.00 backs 1,000 credits; 10 units on chain for 10 counted
	r, err := c.s.Reconcile(ctx, ch, "system", "test", c.now)
	if err != nil || !r.OK || r.OwedCents != 1000 || r.WalletCents != 1000 || r.Units["tsla"] != (Backed{10, 10}) {
		t.Fatalf("%+v %v", r, err)
	}
	if why, _ := c.s.Paused(ctx); why != nil {
		t.Fatalf("paused on a match: %v", why)
	}
}

// A mismatch pauses top-ups, sales and restocks; the next check that matches resumes them.
func TestReconcileMismatchPausesAndMatchResumes(t *testing.T) {
	c, ch, a, b := reconCity(t)
	c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now)
	walletHolds(a, b, 999, 10) // one cent short of the 1,000 credits players hold
	r, err := c.s.Reconcile(ctx, ch, "system", "test", c.now)
	if err != nil || r.OK || len(r.Problems) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	// 1. sales
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 0, market, c.at(5)); !errors.Is(err, errPaused) {
		t.Fatalf("party sale while paused: %v", err)
	}
	if _, err := c.s.BuyAtShop(ctx, "g", c.lease, "tsla", 1, 0, market, c.now); !errors.Is(err, errPaused) {
		t.Fatalf("shop sale while paused: %v", err)
	}
	// 2. restocks: the agent stops buying (demand says paused); recording a swap already made stays open, since
	// that is what brings the books back in line (TestRestockIsRecordedWhilePaused).
	if sup, _ := c.s.Supply(ctx, c.now); !sup.Paused {
		t.Fatal("demand doesn't tell the agent to stop buying")
	}
	// 3. top-ups (the report and the scanner both go through recordTopup)
	tr := Transfer{Tx: usdcTx, Token: strings.ToLower(game.payments.Topup.Tokens["USDC"]), From: player,
		To: strings.ToLower(game.payments.AgenticWallet), Amount: big.NewInt(3e18)}
	if _, _, err := c.s.recordTopup(ctx, tr, 0, "g", c.now); !errors.Is(err, errPaused) {
		t.Fatalf("top-up while paused: %v", err)
	}
	if n := count(t, c.s, `SELECT COUNT(*) FROM sales`) + count(t, c.s, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("%d rows written while paused", n)
	}
	// Units short on chain pause too.
	walletHolds(a, b, 1000, 9)
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); r.OK || !strings.Contains(strings.Join(r.Problems, ";"), "tsla") {
		t.Fatalf("units: %+v", r)
	}
	// Backed again: everything runs.
	walletHolds(a, b, 1000, 10)
	if r, err := c.s.Reconcile(ctx, ch, "system", "test", c.now); err != nil || !r.OK {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 1, 0, market, c.at(5)); err != nil {
		t.Fatalf("party sale after the match: %v", err)
	}
	if _, _, err := c.s.recordTopup(ctx, tr, 0, "g", c.now); err != nil {
		t.Fatalf("top-up after the match: %v", err)
	}
	// The history: three checks, newest first.
	h, _ := c.s.Reconciliations(ctx, 10)
	if len(h) != 3 || h[0]["ok"] != true || h[1]["ok"] != false || h[2]["ok"] != false {
		t.Fatalf("history %v", h)
	}
}

// Held credits and the platform's own money count: a guest's hold is still owed; fees are not players'.
func TestReconcileCountsHoldsAndPlatformMoney(t *testing.T) {
	c, ch, a, b := reconCity(t)
	c.s.SetPartyPrices(ctx, "ceo", c.party, map[string]int64{"tsla": 50}, market, c.now)
	walletHolds(a, b, 1000, 10)
	if _, err := c.s.BuyAtParty(ctx, "g", c.party, "tsla", 2, 0, market, c.at(5)); err != nil {
		t.Fatal(err)
	}
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); !r.OK || r.OwedCents != 1000 {
		t.Fatalf("a hold is still owed: %+v", r)
	}
	c.run(func(tx *sql.Tx) error { return platformLedger(tx, 1, "fee", "0xfee", "test") })
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); r.OK {
		t.Fatalf("the platform's cent counted as backing players: %+v", r)
	}
}

// A check that can't read BSC proves nothing: it leaves payments as they were.
func TestReconcileWithoutTheChainChangesNothing(t *testing.T) {
	c, ch, a, b := reconCity(t)
	walletHolds(a, b, 1, 10)
	c.s.Reconcile(ctx, ch, "system", "test", c.now) // paused
	b.down = true
	if _, err := c.s.Reconcile(ctx, ch, "system", "test", c.now); err == nil {
		t.Fatal("reconciled with one provider down")
	}
	if why, _ := c.s.Paused(ctx); why == nil {
		t.Fatal("an unreadable chain resumed payments")
	}
	if _, err := c.s.Reconcile(ctx, nil, "system", "test", time.Now()); !errors.Is(err, errNotConfigured) {
		t.Fatalf("no chain: %v", err)
	}
}

// The back office: viewers read the Payments page, admins run a check now (which resumes payments on a match).
func TestPaymentsAdminEndpoints(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c, ch, a, b := reconCity(t)
	walletHolds(a, b, 1, 10) // short: the first check pauses
	c.s.Reconcile(ctx, ch, "system", "test", c.now)
	adm := &admin{owners: map[string]bool{}, client: http.DefaultClient}
	srv := httptest.NewServer(routes(&quoter{}, nil, fakePrivy(t, key), c.s, adm))
	defer srv.Close()
	adm.chain = ch
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	do := func(method, path string) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(`{"reason":"checked the wallet"}`))
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
	c.s.SetAdmin(ctx, "test", "kiel@gmail.com", "viewer")
	if code, out := do("GET", "/api/admin/payments"); code != 200 || out["paused"] == nil || len(out["reconciliations"].([]any)) != 1 {
		t.Fatalf("payments %d %v", code, out)
	}
	if code, _ := do("POST", "/api/admin/reconcile"); code != 403 {
		t.Fatalf("a viewer ran a check: %d", code)
	}
	c.s.SetAdmin(ctx, "test", "kiel@gmail.com", "admin")
	walletHolds(a, b, 1000, 10)
	if code, out := do("POST", "/api/admin/reconcile"); code != 200 || out["ok"] != true {
		t.Fatalf("check now %d %v", code, out)
	}
	if code, out := do("GET", "/api/admin/payments"); code != 200 || out["paused"] != nil {
		t.Fatalf("still paused after a match: %d %v", code, out)
	}
}

// The platform can't spend players' money: a restock paid with more USDC than the platform has is a mismatch,
// even though the wallet still covers "wallet − platform" (a negative platform balance would count as backing).
func TestReconcileCatchesRestocksPaidWithPlayersMoney(t *testing.T) {
	c, ch, a, b := reconCity(t)
	walletHolds(a, b, 700, 10) // players hold 1,000 credits; the agent spent $3 of them: $7 left
	c.run(func(tx *sql.Tx) error { return platformLedger(tx, -300, "restock", "0xswap", "test") })
	r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now)
	if r.OK || !strings.Contains(strings.Join(r.Problems, ";"), "platform") {
		t.Fatalf("%+v", r)
	}
}

// Recording a swap that already happened is allowed while paused: it is what brings the books back in line.
func TestRestockIsRecordedWhilePaused(t *testing.T) {
	c, ch, a, b := reconCity(t)
	// Players hold 1,000 credits; the team seeded $3: the wallet has $13 and the 10 units counted.
	c.run(func(tx *sql.Tx) error { return platformLedger(tx, 300, "seed", "0xseed", "test") })
	walletHolds(a, b, 1300, 10)
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); !r.OK {
		t.Fatalf("seeded: %+v", r)
	}
	// The agent swaps the $3 seed for 8 units: on chain at once, in the books only once reported.
	walletHolds(a, b, 1000, 18)
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); r.OK {
		t.Fatalf("expected a pause between the swap and its report: %+v", r)
	}
	if _, err := c.s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", c.now); err != nil {
		t.Fatalf("restock while paused: %v", err)
	}
	if r, err := c.s.Reconcile(ctx, ch, "system", "test", c.now); err != nil || !r.OK {
		t.Fatalf("after the report: %+v %v", r, err)
	}
	if sup, _ := c.s.Supply(ctx, c.now); sup.Paused {
		t.Fatal("demand still says paused")
	}
}

// The team's seed is booked from the chain, once, and never a player's top-up.
func TestRecordSeed(t *testing.T) {
	s := testStore(t)
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	a.receipts[usdcTx], b.receipts[usdcTx] = topupReceipt(t), topupReceipt(t)
	ch := newBSC(a.serve(t), b.serve(t))
	if _, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "", time.Now()); !errors.Is(err, errBad) {
		t.Fatalf("no reason: %v", err)
	}
	cents, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "first stock", time.Now())
	if err != nil || cents != 90676 {
		t.Fatalf("%d %v", cents, err)
	}
	if _, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "again", time.Now()); !errors.Is(err, errTxUsed) {
		t.Fatalf("booked twice: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'seed' AND delta = 90676`); n != 1 {
		t.Fatalf("seed rows %d", n)
	}
	// A player's credited top-up can't be booked as the platform's.
	s2 := testStore(t)
	s2.Get(ctx, "p")
	s2.SetIdentity(ctx, "p", "", player, time.Now())
	tr := Transfer{Tx: usdcTx, Token: strings.ToLower(game.payments.Topup.Tokens["USDC"]), From: player,
		To: strings.ToLower(game.payments.AgenticWallet), Amount: big.NewInt(3e18)}
	s2.recordTopup(ctx, tr, 0, "p", time.Now())
	if _, err := s2.RecordSeed(ctx, ch, "kiel@x", usdcTx, "oops", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("a player's top-up booked as seed: %v", err)
	}
}

// Over HTTP: a top-up report while paused answers 503 paused (the web keeps asking; the credit lands later).
func TestTopupPausedOverHTTP(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	x.db.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, '["test"]', 1)`, pauseKey)
	if code, out := x.post(usdcTx); code != 503 || out["error"] != "paused" {
		t.Fatalf("%d %v", code, out)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("recorded while paused: %d", n)
	}
}
