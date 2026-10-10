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
	// #38 (bug 3): nor a player's rejected top-up (under the minimum): it is theirs to refund, not the platform's.
	s3 := testStore(t)
	s3.Get(ctx, "p")
	s3.SetIdentity(ctx, "p", "", player, time.Now())
	tr.Amount = big.NewInt(2e18) // $2, under the $3 minimum
	if tp, _, _ := s3.recordTopup(ctx, tr, 0, "p", time.Now()); tp.Status != "rejected" {
		t.Fatalf("setup: %+v", tp)
	}
	if _, err := s3.RecordSeed(ctx, ch, "kiel@x", usdcTx, "oops", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("a player's rejected top-up booked as seed: %v", err)
	}
	if n := count(t, s3, `SELECT COUNT(*) FROM platform_ledger`); n != 0 {
		t.Fatalf("platform rows %d", n)
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

// sendTopup records a USDC transfer of usd dollars to the Agentic Wallet (user "" = no player known: "unknown").
func sendTopup(t *testing.T, s *store, n int, usd int64, user, from string) Topup {
	t.Helper()
	amt := new(big.Int).Mul(big.NewInt(usd), big.NewInt(1e18))
	tp, _, err := s.recordTopup(ctx, Transfer{Tx: fmt.Sprintf("0x%064x", n), LogIndex: 0, Token: game.payments.Topup.Tokens["USDC"],
		From: from, To: game.payments.AgenticWallet, Amount: amt}, 0, user, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return tp
}

const stranger = "0x00000000000000000000000000000000000000aa"

// Money owed back to senders (an over-cap remainder, an unknown sender's transfer) sits in the Agentic Wallet but
// is neither a player's credits nor the platform's: it can't back credits, or unbacked credits hide behind it.
func TestReconcileDoesNotCountRefundsOwedAsBacking(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	s.Get(ctx, "b")
	sendTopup(t, s, 1, 50, "a", player)  // $20 credited (1,980 + 20 fee), $30 over the caps, to refund
	sendTopup(t, s, 2, 40, "", stranger) // a stranger: "unknown", $40 to refund
	// A bug mints 7,000 credits nobody paid for.
	if err := s.inTx(ctx, func(tx *sql.Tx) error { return creditLedger(tx, "b", 7000, "refund", "", "bug") }); err != nil {
		t.Fatal(err)
	}
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	walletHolds(a, b, 9000, 0) // exactly the $90 that arrived
	r, err := s.Reconcile(ctx, newBSC(a.serve(t), b.serve(t)), "system", "test", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if r.OK {
		t.Fatalf("matched although 7,000 credits are unbacked once the $70 owed back is refunded: %+v", r)
	}
}

// Paying refunds out by hand lowers the wallet: until the back office marks them refunded the check is short (the
// money may still be owed), and once marked it matches again. Without the mark, every refund would pause payments
// for good.
func TestReconcileAfterRefundsArePaidAndMarked(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	sendTopup(t, s, 1, 50, "a", player)  // 1,980 credits, 20 fee, 3,000 cents over the caps
	sendTopup(t, s, 2, 2, "a", player)   // no room left: rejected, 200 cents
	sendTopup(t, s, 3, 40, "", stranger) // unknown, 4,000 cents
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	ch := newBSC(a.serve(t), b.serve(t))
	walletHolds(a, b, 9200, 0)
	if r, err := s.Reconcile(ctx, ch, "system", "test", time.Now()); err != nil || !r.OK || r.RefundCents != 7200 ||
		r.OwedCents != 1980 || r.PlatformCents != 20 {
		t.Fatalf("before refunds: %+v %v", r, err)
	}
	walletHolds(a, b, 2000, 0) // the $72 went back to their senders
	if r, _ := s.Reconcile(ctx, ch, "system", "test", time.Now()); r.OK {
		t.Fatalf("refunds paid but not marked: %+v", r)
	}
	for n := 1; n <= 3; n++ {
		if _, err := s.MarkRefunded(ctx, "kiel@x", fmt.Sprintf("0x%064x", n), 0, "sent back from the wallet", time.Now()); err != nil {
			t.Fatalf("refund %d: %v", n, err)
		}
	}
	if r, err := s.Reconcile(ctx, ch, "system", "test", time.Now()); err != nil || !r.OK || r.RefundCents != 0 {
		t.Fatalf("after marking: %+v %v", r, err)
	}
	if why, _ := s.Paused(ctx); why != nil {
		t.Fatalf("still paused: %v", why)
	}
}

// Marking a refund: a reason, once, only where something is owed, audited; a refunded unknown transfer can't be
// claimed by a player afterwards, nor booked as the seed.
func TestMarkRefunded(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	s.SetIdentity(ctx, "a", "", player, time.Now())
	sendTopup(t, s, 1, 10, "a", player) // credited in full: nothing owed
	sendTopup(t, s, 2, 40, "", player)  // seen before the player was known: unknown
	tx := func(n int) string { return fmt.Sprintf("0x%064x", n) }
	cases := []struct {
		tx     string
		index  int64
		reason string
		want   error
	}{
		{tx(2), 0, " ", errBad},
		{"0x12", 0, "x", errBad},
		{tx(2), -1, "x", errBad},
		{tx(9), 0, "x", errNoTopup},
		{tx(2), 1, "x", errNoTopup},
		{tx(1), 0, "x", errRejected}, // credited in full
	}
	for _, c := range cases {
		if _, err := s.MarkRefunded(ctx, "kiel@x", c.tx, c.index, c.reason, time.Now()); !errors.Is(err, c.want) {
			t.Errorf("%s:%d %q: %v, want %v", c.tx, c.index, c.reason, err, c.want)
		}
	}
	if cents, err := s.MarkRefunded(ctx, "kiel@x", tx(2), 0, "sent back", time.Now()); err != nil || cents != 4000 {
		t.Fatalf("refund: %d %v", cents, err)
	}
	if _, err := s.MarkRefunded(ctx, "kiel@x", tx(2), 0, "again", time.Now()); !errors.Is(err, errConflict) {
		t.Fatalf("refunded twice: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM audit WHERE action = 'topup-refund' AND reason = 'sent back'`); n != 1 {
		t.Fatalf("audit rows %d", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM topups WHERE status = 'rejected' AND refunded_at > 0`); n != 1 {
		t.Fatalf("refunded unknown row not closed: %d", n)
	}
	// The player reports the transfer now: it was given back, so no credits.
	before := credits(t, s, "a")
	if _, fresh, err := s.recordTopup(ctx, Transfer{Tx: tx(2), Token: game.payments.Topup.Tokens["USDC"], From: player,
		To: game.payments.AgenticWallet, Amount: new(big.Int).Mul(big.NewInt(40), big.NewInt(1e18))}, 0, "a", time.Now()); err != nil || fresh {
		t.Fatalf("claimed after refund: fresh=%v %v", fresh, err)
	}
	if credits(t, s, "a") != before {
		t.Fatal("credited a refunded transfer")
	}
}

// A refunded transfer is not the platform's money: it can't be booked as the seed.
func TestRecordSeedRefusesARefundedTransfer(t *testing.T) {
	s := testStore(t)
	a, b := newFakeRPC(t, usdcAt+20), newFakeRPC(t, usdcAt+20)
	a.receipts[usdcTx], b.receipts[usdcTx] = topupReceipt(t), topupReceipt(t)
	ch := newBSC(a.serve(t), b.serve(t))
	tr := Transfer{Tx: usdcTx, Token: game.payments.Topup.Tokens["USDC"], From: stranger,
		To: game.payments.AgenticWallet, Amount: big.NewInt(3e18)}
	if _, _, err := s.recordTopup(ctx, tr, 0, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MarkRefunded(ctx, "kiel@x", usdcTx, 0, "not ours", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordSeed(ctx, ch, "kiel@x", usdcTx, "seed", time.Now()); !errors.Is(err, errRejected) {
		t.Fatalf("refunded transfer booked as seed: %v", err)
	}
	// And a seed is the platform's: nothing owed back on it.
	s2 := testStore(t)
	if _, _, err := s2.recordTopup(ctx, tr, 0, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s2.RecordSeed(ctx, ch, "kiel@x", usdcTx, "seed", time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s2, `SELECT COALESCE(SUM(refund_cents), 0) FROM topups`); n != 0 {
		t.Fatalf("seed still owed back: %d", n)
	}
}

// A claim of an unknown transfer keeps only the part over the caps as owed back.
func TestClaimedTopupOwesBackOnlyTheExcess(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	sendTopup(t, s, 1, 40, "", player)
	if n := count(t, s, `SELECT refund_cents FROM topups`); n != 4000 {
		t.Fatalf("unknown: %d", n)
	}
	sendTopup(t, s, 1, 40, "a", player) // $20 room today
	if n := count(t, s, `SELECT refund_cents FROM topups WHERE status = 'credited'`); n != 2000 {
		t.Fatalf("claimed: %d", n)
	}
}

// Over HTTP: viewers can't mark refunds; admins can, with a reason, once.
func TestRefundAdminEndpoint(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s := testStore(t)
	sendTopup(t, s, 1, 40, "", stranger)
	adm := &admin{owners: map[string]bool{}, client: http.DefaultClient}
	srv := httptest.NewServer(routes(&quoter{}, nil, fakePrivy(t, key), s, adm))
	defer srv.Close()
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	do := func(body string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", srv.URL+"/api/admin/topups/refund", strings.NewReader(body))
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
	ok := fmt.Sprintf(`{"tx":"0x%064x","logIndex":0,"reason":"sent back"}`, 1)
	s.SetAdmin(ctx, "test", "kiel@gmail.com", "viewer")
	if code, _ := do(ok); code != 403 {
		t.Fatalf("a viewer marked a refund: %d", code)
	}
	s.SetAdmin(ctx, "test", "kiel@gmail.com", "admin")
	if code, _ := do(fmt.Sprintf(`{"tx":"0x%064x","logIndex":0,"reason":""}`, 1)); code != 400 {
		t.Fatalf("no reason: %d", code)
	}
	if code, _ := do(fmt.Sprintf(`{"tx":"0x%064x","logIndex":0,"reason":"x"}`, 2)); code != 404 {
		t.Fatalf("unknown tx: %d", code)
	}
	if code, out := do(ok); code != 200 || out["refundCents"] != float64(4000) {
		t.Fatalf("refund %d %v", code, out)
	}
	if code, _ := do(ok); code != 409 {
		t.Fatalf("twice: %d", code)
	}
	p, _ := s.Payments(ctx)
	if len(p.Topups) != 1 || p.Topups[0].RefundCents != 4000 || p.Topups[0].RefundedAt == 0 {
		t.Fatalf("payments page: %+v", p.Topups)
	}
}

// changeSwap: the Agentic Wallet's swap that pays paidCents of USDC to the pool and gets changeCents back from it
// (a router returning what it didn't use), buying TSLAB. In usdcTx's block.
func changeSwap(t *testing.T, paidCents, changeCents int64) string {
	var rc map[string]any
	if err := json.Unmarshal([]byte(swapReceipt(t, paidCents, bought, game.payments.AgenticWallet)), &rc); err != nil {
		t.Fatal(err)
	}
	logs := rc["logs"].([]any)
	change := map[string]any{}
	for k, v := range logs[0].(map[string]any) {
		change[k] = v
	}
	change["topics"] = []any{transferTopic, padded(pool), padded(game.payments.AgenticWallet)}
	change["data"] = fmt.Sprintf("0x%064x", new(big.Int).Mul(big.NewInt(changeCents), big.NewInt(1e16)))
	change["logIndex"] = "0x1a"
	rc["logs"] = append(logs, change)
	b, _ := json.Marshal(rc)
	return string(b)
}

// A restock swap pays $5 and gets $2 back from the router: the scanner sees the $2 come in from a sender that is
// nobody's wallet. That is the platform's own change (the restock books the net $3 out), not a stranger's money to
// refund: counted as owed back, it would pause payments for everyone. Either order of scan and report.
func TestReconcileSwapChangeIsNotOwedBack(t *testing.T) {
	for _, scanFirst := range []bool{true, false} {
		t.Run(fmt.Sprint("scanFirst=", scanFirst), func(t *testing.T) {
			s := testStore(t)
			s.Get(ctx, "a")
			sendTopup(t, s, 1, 10, "a", player) // 990 credits, 10 fee
			if err := s.inTx(ctx, func(tx *sql.Tx) error { return platformLedger(tx, 500, "seed", "0xseed", "team") }); err != nil {
				t.Fatal(err)
			}
			ch, a, b := restockChain(t, changeSwap(t, 500, 200), usdcAt+20)
			walletHolds(a, b, 1000+500-500+200, 8) // top-up + seed − paid + change; 8 units bought
			scan := func() {
				s.setScanned(ctx, usdcAt-1, time.Now())
				if err := s.scanTopups(ctx, ch, time.Now()); err != nil {
					t.Fatal(err)
				}
			}
			restock := func() {
				if got, err := s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", time.Now()); err != nil || got.USDCents != 300 {
					t.Fatalf("restock %+v %v", got, err)
				}
			}
			if scanFirst {
				scan()
				restock()
			} else {
				restock()
				scan()
			}
			// Scanned after the restock is booked, the tx is skipped: nothing is recorded (the platform's money).
			if n, want := count(t, s, `SELECT COUNT(*) FROM topups WHERE tx = ?`, usdcTx), map[bool]int{true: 1, false: 0}[scanFirst]; n != want {
				t.Fatalf("change rows %d, want %d", n, want)
			}
			if n := count(t, s, `SELECT COALESCE(SUM(refund_cents), 0) FROM topups WHERE tx = ?`, usdcTx); n != 0 {
				t.Fatalf("the change is owed back: %d cents", n)
			}
			r, err := s.Reconcile(ctx, ch, "system", "test", time.Now())
			if err != nil || !r.OK || r.RefundCents != 0 || r.OwedCents != 990 || r.PlatformCents != 210 {
				t.Fatalf("%+v %v", r, err)
			}
			if _, err := s.MarkRefunded(ctx, "kiel@x", usdcTx, 0x1a, "x", time.Now()); !errors.Is(err, errRejected) &&
				(scanFirst || !errors.Is(err, errNoTopup)) {
				t.Fatalf("change marked refundable: %v", err)
			}
			if !scanFirst {
				return
			}
			// A row recorded owing before the scanner knew (pre-fix data): the booked restock still rules it out.
			s.db.Exec(`UPDATE topups SET refund_cents = 200 WHERE tx = ?`, usdcTx)
			if r, err := s.Reconcile(ctx, ch, "system", "test", time.Now()); err != nil || !r.OK || r.RefundCents != 0 {
				t.Fatalf("legacy row: %+v %v", r, err)
			}
		})
	}
}

// Issue #55 (F1): the agent swaps $0.30 of platform USDC for 0.0009 TSLAB (less than one unit). The swap is booked
// (the spend, no unit; the fraction stays in the wallet as surplus) and the next reconciliation still matches,
// instead of pausing payments for everyone over a spend nobody could book.
func TestSubUnitSwapKeepsTheBooksInLine(t *testing.T) {
	c, ch, a, b := reconCity(t)
	c.run(func(tx *sql.Tx) error { return platformLedger(tx, 300, "seed", "0xseed", "test") })
	walletHolds(a, b, 1300, 10) // players' 1,000 credits + the $3 seed; 10 units counted
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); !r.OK {
		t.Fatalf("baseline: %+v", r)
	}
	sub := big.NewInt(9e14)
	rc := swapReceipt(t, 30, sub, game.payments.AgenticWallet)
	a.receipts[usdcTx], b.receipts[usdcTx] = rc, rc
	walletHolds(a, b, 1270, 10)
	tsla := fmt.Sprintf("0x%064x", new(big.Int).Add(big.NewInt(10e15), sub)) // 10.9 units on chain
	for _, f := range []*fakeRPC{a, b} {
		f.mu.Lock()
		f.balances[strings.ToLower(game.payments.Tokens["tsla"].Contract)] = tsla
		f.mu.Unlock()
	}
	got, err := c.s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", c.now)
	if err != nil || got.Units != 0 || got.USDCents != 30 {
		t.Fatalf("sub-unit swap: %+v %v", got, err)
	}
	r, err := c.s.Reconcile(ctx, ch, "system", "hourly", c.now)
	if err != nil || !r.OK {
		t.Fatalf("after a sub-unit swap: %+v %v", r, err)
	}
	if u := r.Units["tsla"]; u.Counted != 10 || u.OnChain != 10 {
		t.Fatalf("units %+v: the fraction is surplus, not stock", u)
	}
}

// Review #56 (1): a unit goes missing between hourly checks, then the agent's routine buy arrives. The spend is
// booked, payments pause at once, and every reconciliation keeps flagging the missing unit (as before #56) until
// the team writes it off; then the next one matches and payments resume.
func TestAgentShortRestockKeepsTheLossVisible(t *testing.T) {
	c, ch, a, b := reconCity(t)
	c.run(func(tx *sql.Tx) error { return platformLedger(tx, 300, "seed", "0xseed", "test") })
	walletHolds(a, b, 1300, 10)
	if r, _ := c.s.Reconcile(ctx, ch, "system", "test", c.now); !r.OK {
		t.Fatalf("baseline: %+v", r)
	}
	walletHolds(a, b, 1000, 9) // one unit gone; then the agent pays $3 for 8.09 units
	tsla := fmt.Sprintf("0x%064x", new(big.Int).Add(big.NewInt(9e15), bought))
	for _, f := range []*fakeRPC{a, b} {
		f.mu.Lock()
		f.balances[strings.ToLower(game.payments.Tokens["tsla"].Contract)] = tsla
		f.mu.Unlock()
	}
	if got, err := c.s.VerifiedRestock(ctx, ch, "agent", "tsla", usdcTx, "", c.now); err != nil || got.USDCents != 300 {
		t.Fatalf("restock: %+v %v", got, err)
	}
	if why, _ := c.s.Paused(ctx); why == nil {
		t.Fatal("payments still run after a short restock")
	}
	r, err := c.s.Reconcile(ctx, ch, "system", "hourly", c.now)
	if err != nil || r.OK {
		t.Fatalf("the missing unit vanished from the books: %+v %v", r, err)
	}
	if err := c.s.Restock(ctx, "kiel@x", "tsla", -1, "adjust", "unit lost on chain", ""); err != nil {
		t.Fatal(err)
	}
	if r, err := c.s.Reconcile(ctx, ch, "system", "hourly", c.now); err != nil || !r.OK {
		t.Fatalf("after the write-off: %+v %v", r, err)
	}
	if why, _ := c.s.Paused(ctx); why != nil {
		t.Fatalf("still paused: %v", why)
	}
}
