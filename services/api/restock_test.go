package main

import (
	"bytes"
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

const pool = "0x00000000000000000000000000000000000000c0" // the swap's counterparty (a router or a pool)

// swapReceipt: the recorded receipt reshaped as the Agentic Wallet's swap: `paid` USDC out to the pool and
// `bought` base units of TSLAB in from it. Every other field is the real receipt's.
func swapReceipt(t *testing.T, paidCents int64, bought *big.Int, buyer string) string {
	var rc map[string]any
	if err := json.Unmarshal([]byte(fixture(t, "receipt-usdc-transfer")), &rc); err != nil {
		t.Fatal(err)
	}
	logs := rc["logs"].([]any)
	usdc := logs[0].(map[string]any)
	usdc["topics"] = []any{transferTopic, padded(game.payments.AgenticWallet), padded(pool)}
	usdc["data"] = fmt.Sprintf("0x%064x", new(big.Int).Mul(big.NewInt(paidCents), big.NewInt(1e16)))
	tsla := map[string]any{}
	for k, v := range usdc {
		tsla[k] = v
	}
	tsla["address"] = game.payments.Tokens["tsla"].Contract
	tsla["topics"] = []any{transferTopic, padded(pool), padded(buyer)}
	tsla["data"] = fmt.Sprintf("0x%064x", bought)
	tsla["logIndex"] = "0x19"
	rc["logs"] = []any{usdc, tsla}
	b, _ := json.Marshal(rc)
	return string(b)
}

// 0.008090 TSLAB: what $3 bought in the recorded quote → 8 units of 0.001 share.
var bought = big.NewInt(8_090_679_605_379_958)

func restockChain(t *testing.T, rc string, head uint64) (*bsc, *fakeRPC, *fakeRPC) {
	a, b := newFakeRPC(t, head), newFakeRPC(t, head)
	a.receipts[usdcTx], b.receipts[usdcTx] = rc, rc
	// The Agentic Wallet's bStock balance on chain: plenty, unless a test says otherwise.
	a.balance = fmt.Sprintf("0x%064x", new(big.Int).Mul(bought, big.NewInt(100)))
	b.balance = a.balance
	return newBSC(a.serve(t), b.serve(t)), a, b
}

func onHand(t *testing.T, s *store, token string) (qty, reserved int64) {
	t.Helper()
	s.db.QueryRow(`SELECT COALESCE(SUM(qty), 0), COALESCE(SUM(reserved), 0) FROM platform_stock WHERE token = ?`, token).
		Scan(&qty, &reserved)
	return
}

func TestVerifiedRestock(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	c, _, _ := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", now)
	if err != nil || got.Units != 8 || got.USDCents != 300 || got.Shares != bought.String() {
		t.Fatalf("%+v %v", got, err)
	}
	if q, _ := onHand(t, s, "tsla"); q != 8 {
		t.Fatalf("on hand %d", q)
	}
	checks := map[string]int{
		`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'restock' AND delta = -300 AND ref = '` + usdcTx + `'`: 1,
		`SELECT COUNT(*) FROM stock_moves WHERE kind = 'restock' AND delta = 8 AND actor = 'agent'`:               1,
		`SELECT COUNT(*) FROM audit WHERE action = 'stock-restock' AND target = 'tsla'`:                           1,
	}
	for q, want := range checks {
		if n := count(t, s, q); n != want {
			t.Errorf("%s = %d, want %d", q, n, want)
		}
	}
	// The same swap reported again, in any letter case: counted once.
	for _, tx := range []string{usdcTx, "0x" + strings.ToUpper(usdcTx[2:])} {
		if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", tx, "", now); !errors.Is(err, errTxUsed) {
			t.Fatalf("reused %s: %v", tx, err)
		}
	}
	if q, _ := onHand(t, s, "tsla"); q != 8 {
		t.Fatalf("on hand after a reused tx %d", q)
	}
}

// A fake, failed, foreign or unconfirmed swap never adds a unit.
func TestRestockRefusals(t *testing.T) {
	cases := map[string]struct {
		receipt func(t *testing.T) string
		head    uint64
		token   string
		tx      string
		want    error
	}{
		"not final yet":          {head: usdcAt + 3, want: errUnconfirmed},
		"unknown tx":             {tx: "0x" + strings.Repeat("ef", 32), want: errNoTx},
		"made-up tx":             {tx: "0xabc", want: errBad},
		"failed tx":              {tx: failedTx, want: errTxFailed},
		"not whitelisted (nvda)": {token: "nvda", want: errBad},
		"no bStock in (a plain transfer)": {want: errNoStock,
			receipt: func(t *testing.T) string { return fixture(t, "receipt-usdc-transfer") }},
		"bStock bought for someone else": {want: errNoStock,
			receipt: func(t *testing.T) string { return swapReceipt(t, 300, bought, pool) }},
		"over the per-swap limit": {want: errOverLimit,
			receipt: func(t *testing.T) string {
				return swapReceipt(t, game.payments.Agent.MaxUsdPerSwap*100+1, bought, game.payments.AgenticWallet)
			}},
	}
	for name, cs := range cases {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			rc := swapReceipt(t, 300, bought, game.payments.AgenticWallet)
			if cs.receipt != nil {
				rc = cs.receipt(t)
			}
			head := cs.head
			if head == 0 {
				head = usdcAt + 20
			}
			c, a, b := restockChain(t, rc, head)
			a.receipts[failedTx], b.receipts[failedTx] = fixture(t, "receipt-failed"), fixture(t, "receipt-failed")
			token, tx := "tsla", usdcTx
			if cs.token != "" {
				token = cs.token
			}
			if cs.tx != "" {
				tx = cs.tx
			}
			if _, err := s.VerifiedRestock(ctx, c, "agent", token, tx, "", time.Now()); !errors.Is(err, cs.want) {
				t.Fatalf("got %v, want %v", err, cs.want)
			}
			if n := count(t, s, `SELECT COUNT(*) FROM stock_moves`); n != 0 {
				t.Fatalf("%d stock moves", n)
			}
			if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger`); n != 0 {
				t.Fatalf("%d platform rows", n)
			}
		})
	}
}

func TestRestockDailyLimitAndNoChain(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	tx, _ := s.db.Begin()
	platformLedger(tx, -toCredits(game.payments.Agent.MaxUsdPerDay*100-200), "restock", "0xearlier", "today")
	tx.Commit()
	c, _, _ := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", now); !errors.Is(err, errOverLimit) {
		t.Fatalf("over the daily limit: %v", err)
	}
	if _, err := s.VerifiedRestock(ctx, nil, "agent", "tsla", usdcTx, "", now); !errors.Is(err, errNotConfigured) {
		t.Fatalf("no chain: %v", err)
	}
}

func TestReservations(t *testing.T) {
	s := testStore(t)
	c, _, _ := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	run := func(op func(*sql.Tx) error) error {
		tx, err := s.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := op(tx); err != nil {
			tx.Rollback()
			return err
		}
		return tx.Commit()
	}
	if err := run(func(x *sql.Tx) error { return reserve(x, "tsla", 9) }); !errors.Is(err, errSoldOut) {
		t.Fatalf("reserve more than on hand: %v", err)
	}
	if err := run(func(x *sql.Tx) error { return reserve(x, "tsla", 5) }); err != nil {
		t.Fatal(err)
	}
	if q, r := onHand(t, s, "tsla"); q != 3 || r != 5 {
		t.Fatalf("after reserve: %d on hand, %d reserved", q, r)
	}
	if err := run(func(x *sql.Tx) error { return release(x, "tsla", 6) }); !errors.Is(err, errSoldOut) {
		t.Fatalf("release more than reserved: %v", err)
	}
	if err := run(func(x *sql.Tx) error { return release(x, "tsla", 2) }); err != nil {
		t.Fatal(err)
	}
	if err := run(func(x *sql.Tx) error { return take(x, "tsla", 3) }); err != nil {
		t.Fatal(err)
	}
	if q, r := onHand(t, s, "tsla"); q != 5 || r != 0 {
		t.Fatalf("after release 2 and take 3: %d on hand, %d reserved", q, r)
	}
	if err := run(func(x *sql.Tx) error { return take(x, "tsla", 1) }); !errors.Is(err, errSoldOut) {
		t.Fatalf("take what isn't reserved: %v", err)
	}
	if err := run(func(x *sql.Tx) error { return reserve(x, "nvda", 1) }); !errors.Is(err, errSoldOut) {
		t.Fatalf("reserve a token never stocked: %v", err)
	}
}

// The back office reports a swap (verified like the agent's); typing a number can only take units out.
func TestAdminStockByTx(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	db := testStore(t)
	c, _, _ := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	adm := &admin{owners: map[string]bool{}, client: http.DefaultClient}
	srv := httptest.NewServer(routes(&quoter{}, nil, fakePrivy(t, key), db, adm))
	defer srv.Close()
	adm.chain = c // routes sets it from the environment; the test points it at the fake rpcs
	db.SetAdmin(ctx, "test", "kiel@gmail.com", "admin")
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	put := func(body any) (int, map[string]any) {
		var buf bytes.Buffer
		json.NewEncoder(&buf).Encode(body)
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/admin/stock/tsla", &buf)
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
	if code, _ := put(map[string]any{"tx": usdcTx}); code != 400 {
		t.Fatalf("a swap reported without a reason: %d", code)
	}
	if code, out := put(map[string]any{"delta": 100, "reason": "launch"}); code != 400 || out["error"] != "report_a_tx" {
		t.Fatalf("typed units: %d %v", code, out)
	}
	if code, out := put(map[string]any{"tx": usdcTx, "reason": "first stock"}); code != 200 || out["units"] != float64(8) {
		t.Fatalf("reported swap: %d %v", code, out)
	}
	if code, out := put(map[string]any{"tx": usdcTx, "reason": "again"}); code != 409 || out["error"] != "tx_used" {
		t.Fatalf("reported twice: %d %v", code, out)
	}
	if code, _ := put(map[string]any{"delta": -3, "reason": "count"}); code != 200 {
		t.Fatalf("take out: %d", code)
	}
	if q, _ := onHand(t, db, "tsla"); q != 5 {
		t.Fatalf("on hand %d", q)
	}
}

type move struct {
	token, from, to string
	amount          *big.Int
}

// customReceipt: the recorded receipt with exactly these transfers as its logs.
func customReceipt(t *testing.T, moves ...move) string {
	var rc map[string]any
	if err := json.Unmarshal([]byte(fixture(t, "receipt-usdc-transfer")), &rc); err != nil {
		t.Fatal(err)
	}
	base := rc["logs"].([]any)[0].(map[string]any)
	var logs []any
	for i, m := range moves {
		l := map[string]any{}
		for k, v := range base {
			l[k] = v
		}
		l["address"], l["logIndex"] = m.token, fmt.Sprintf("0x%x", i)
		l["topics"] = []any{transferTopic, padded(m.from), padded(m.to)}
		l["data"] = fmt.Sprintf("0x%064x", m.amount)
		logs = append(logs, l)
	}
	rc["logs"] = logs
	b, _ := json.Marshal(rc)
	return string(b)
}

// Moving bStock the wallet already had, or getting back what it sent away, is not a purchase.
func TestRestockNeedsANetPurchase(t *testing.T) {
	aw, tsla, usdc := game.payments.AgenticWallet, game.payments.Tokens["tsla"].Contract, game.payments.Topup.Tokens["USDC"]
	paid := big.NewInt(3e18)
	cases := map[string][]move{
		"sent to itself":            {{tsla, aw, aw, bought}},
		"in, then out again":        {{usdc, aw, pool, paid}, {tsla, pool, aw, bought}, {tsla, aw, pool, bought}},
		"received without paying":   {{tsla, pool, aw, bought}},
		"paid itself, bStock in":    {{usdc, aw, aw, paid}, {tsla, pool, aw, bought}},
		"paid, but the bStock left": {{usdc, aw, pool, paid}, {tsla, pool, aw, bought}, {tsla, aw, aw, bought}, {tsla, aw, pool, bought}},
	}
	for name, moves := range cases {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			c, _, _ := restockChain(t, customReceipt(t, moves...), usdcAt+20)
			if got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); !errors.Is(err, errNoStock) {
				t.Fatalf("%+v %v", got, err)
			}
			if q, _ := onHand(t, s, "tsla"); q != 0 {
				t.Fatalf("on hand %d", q)
			}
		})
	}
}

// Whatever a receipt says, the wallet's bStock balance on chain must cover all the units we count: a swap of 8
// with only 7 on chain adds 7 (and books the whole spend).
func TestRestockMustBeBackedOnChain(t *testing.T) {
	s := testStore(t)
	c, a, b := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	a.balance = fmt.Sprintf("0x%064x", big.NewInt(7e15)) // 7 units' worth: less than the 8 bought
	b.balance = a.balance
	if got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); err != nil || got.Units != 7 ||
		got.Short != 1 || got.USDCents != 300 {
		t.Fatalf("%+v %v", got, err)
	}
	if q, _ := onHand(t, s, "tsla"); q != 7 {
		t.Fatalf("on hand %d", q)
	}
}

// The agent is capped; the team's own report from the back office (seeding the first stock) is not.
func TestRestockLimitsBindTheAgentOnly(t *testing.T) {
	big500 := swapReceipt(t, 500*100, bought, game.payments.AgenticWallet)
	s := testStore(t)
	c, _, _ := restockChain(t, big500, usdcAt+20)
	if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); !errors.Is(err, errOverLimit) {
		t.Fatalf("agent over the per-swap limit: %v", err)
	}
	if got, err := s.VerifiedRestock(ctx, c, "kiel@x", "tsla", usdcTx, "seed", time.Now()); err != nil || got.Units != 8 {
		t.Fatalf("admin seed: %+v %v", got, err)
	}
	sup, _ := s.Supply(ctx, time.Now())
	if sup.AgentSpentToday != 50000 {
		t.Fatalf("spent today %d", sup.AgentSpentToday)
	}
}

// stockOf puts qty units of token in the warehouse, as earlier verified restocks would have (no chain read).
func stockOf(t *testing.T, s *store, token string, qty int64) {
	t.Helper()
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := moveStock(tx, token, qty, "restock", "", "test", "earlier", "0xearlier"+token); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func holdsTSLA(a, b *fakeRPC, shares *big.Int) {
	a.balance = fmt.Sprintf("0x%064x", shares)
	b.balance = a.balance
}

// Issue #55 (F1b): units already short on chain (books 10, chain 9) and a fresh purchase of 8 arrives. The swap
// is booked, agent or back office: the whole $3 as platform money out, and only the units the chain backs (7), so
// the purchase repairs the shortfall instead of being refused while its spend stays off the books.
func TestRestockRepairsAShortfallInsteadOfRefusingIt(t *testing.T) {
	for _, actor := range []string{"agent", "kiel@x"} {
		t.Run(actor, func(t *testing.T) {
			s := testStore(t)
			stockOf(t, s, "tsla", 10)
			c, a, b := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
			holdsTSLA(a, b, new(big.Int).Add(big.NewInt(9e15), bought)) // 9 left of 10, + 8.09 bought
			got, err := s.VerifiedRestock(ctx, c, actor, "tsla", usdcTx, "repair", time.Now())
			if err != nil || got.Units != 7 || got.Short != 1 || got.USDCents != 300 {
				t.Fatalf("%+v %v", got, err)
			}
			if q, _ := onHand(t, s, "tsla"); q != 17 {
				t.Fatalf("on hand %d, want the 17 the chain holds", q)
			}
			if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'restock' AND delta = -300`); n != 1 {
				t.Fatalf("spend rows %d", n)
			}
		})
	}
}

// Units far short (books 10, chain 8 after buying 8): the spend is still booked, no unit is added, and the
// reconciliation keeps flagging the missing units (the books never claim more than the chain holds).
func TestRestockBooksTheSpendWhenNothingIsBacked(t *testing.T) {
	s := testStore(t)
	stockOf(t, s, "tsla", 10)
	c, a, b := restockChain(t, swapReceipt(t, 300, bought, game.payments.AgenticWallet), usdcAt+20)
	holdsTSLA(a, b, bought)
	got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now())
	if err != nil || got.Units != 0 || got.Short != 8 || got.USDCents != 300 {
		t.Fatalf("%+v %v", got, err)
	}
	if q, _ := onHand(t, s, "tsla"); q != 10 {
		t.Fatalf("on hand %d", q)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'restock' AND delta = -300`); n != 1 {
		t.Fatalf("spend rows %d", n)
	}
	if _, err := s.VerifiedRestock(ctx, c, "kiel@x", "tsla", usdcTx, "again", time.Now()); !errors.Is(err, errTxUsed) {
		t.Fatalf("booked twice: %v", err)
	}
}

// Issue #55 (F1): a swap of less than one unit is still a purchase of real USDC: it is booked once (0 units, the
// fraction stays in the wallet as surplus), and a second report of it, in any case or by anyone, is refused.
func TestSubUnitSwapIsBookedOnce(t *testing.T) {
	s := testStore(t)
	sub := big.NewInt(999_999_999_999_999)
	c, _, _ := restockChain(t, swapReceipt(t, 30, sub, game.payments.AgenticWallet), usdcAt+20)
	got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now())
	if err != nil || got.Units != 0 || got.USDCents != 30 || got.Shares != sub.String() {
		t.Fatalf("%+v %v", got, err)
	}
	for _, who := range []string{"agent", "kiel@x"} {
		for _, tx := range []string{usdcTx, "0x" + strings.ToUpper(usdcTx[2:])} {
			if _, err := s.VerifiedRestock(ctx, c, who, "tsla", tx, "again", time.Now()); !errors.Is(err, errTxUsed) {
				t.Fatalf("%s reported %s again: %v", who, tx, err)
			}
		}
	}
	if n := count(t, s, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'restock' AND delta = -30`); n != 1 {
		t.Fatalf("spend rows %d", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM stock_moves WHERE kind = 'restock' AND delta = 0`); n != 1 {
		t.Fatalf("stock moves %d", n)
	}
	if q, _ := onHand(t, s, "tsla"); q != 0 {
		t.Fatalf("on hand %d", q)
	}
	// It counts toward the agent's daily spend like any restock.
	if sup, _ := s.Supply(ctx, time.Now()); sup.AgentSpentToday != 30 {
		t.Fatalf("spent today %d", sup.AgentSpentToday)
	}
}

// Issue #55 (F2): one tx is either a restock (net USDC out) or the team's seed (USDC in), never both, in either
// order: a swap whose router refunds part of the USDC must not turn the refund into platform money.
func TestRestockAndSeedNeverShareATx(t *testing.T) {
	aw, tsla, usdc := game.payments.AgenticWallet, game.payments.Tokens["tsla"].Contract, game.payments.Topup.Tokens["USDC"]
	rc := func(t *testing.T) string {
		return customReceipt(t,
			move{usdc, aw, pool, big.NewInt(5e18)}, // max in
			move{usdc, pool, aw, big.NewInt(2e18)}, // refund
			move{tsla, pool, aw, bought})
	}
	t.Run("restock, then seed", func(t *testing.T) {
		s := testStore(t)
		c, _, _ := restockChain(t, rc(t), usdcAt+20)
		if got, err := s.VerifiedRestock(ctx, c, "kiel@x", "tsla", usdcTx, "first stock", time.Now()); err != nil || got.USDCents != 300 {
			t.Fatalf("%+v %v", got, err)
		}
		if _, err := s.RecordSeed(ctx, c, "kiel@x", "0x"+strings.ToUpper(usdcTx[2:]), "seed", time.Now()); !errors.Is(err, errTxUsed) {
			t.Fatalf("seed of a restock tx: %v", err)
		}
		if n := count(t, s, `SELECT COALESCE(SUM(delta), 0) FROM platform_ledger`); n != -300 {
			t.Fatalf("platform net %d, want -300", n)
		}
	})
	t.Run("seed, then restock", func(t *testing.T) {
		s := testStore(t)
		c, _, _ := restockChain(t, rc(t), usdcAt+20)
		if _, err := s.RecordSeed(ctx, c, "kiel@x", usdcTx, "seed", time.Now()); err != nil {
			t.Fatal(err)
		}
		if _, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now()); !errors.Is(err, errTxUsed) {
			t.Fatalf("restock of a seed tx: %v", err)
		}
		if q, _ := onHand(t, s, "tsla"); q != 0 {
			t.Fatalf("on hand %d", q)
		}
	})
}

// Issue #55 (F4): a tx that buys two whitelisted bStocks books both in one report, with the whole payment once;
// a later report for the other token finds the tx used, its units already in the warehouse.
func TestTwoTokenSwapBooksEveryToken(t *testing.T) {
	old := game.payments.Tokens
	nv := "0x00000000000000000000000000000000000000d1"
	cp := make(map[string]struct {
		Symbol   string `json:"symbol"`
		Contract string `json:"contract"`
	}, len(old)+1)
	for k, v := range old {
		cp[k] = v
	}
	nvda := old["tsla"]
	nvda.Contract, nvda.Symbol = nv, "NVDAB"
	cp["nvda"] = nvda
	game.payments.Tokens = cp
	t.Cleanup(func() { game.payments.Tokens = old })

	s := testStore(t)
	aw, tsla, usdc := game.payments.AgenticWallet, game.payments.Tokens["tsla"].Contract, game.payments.Topup.Tokens["USDC"]
	half := new(big.Int).Div(bought, big.NewInt(2)) // 4 units
	c, _, _ := restockChain(t, customReceipt(t,
		move{usdc, aw, pool, big.NewInt(6e18)},
		move{tsla, pool, aw, bought},
		move{nv, pool, aw, half}), usdcAt+20)
	got, err := s.VerifiedRestock(ctx, c, "agent", "tsla", usdcTx, "", time.Now())
	if err != nil || got.Units != 8 || got.USDCents != 600 || got.Others["nvda"] != 4 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := s.VerifiedRestock(ctx, c, "agent", "nvda", usdcTx, "", time.Now()); !errors.Is(err, errTxUsed) {
		t.Fatalf("nvda reported after: %v", err)
	}
	if q, _ := onHand(t, s, "nvda"); q != 4 {
		t.Fatalf("nvda on hand %d", q)
	}
	if q, _ := onHand(t, s, "tsla"); q != 8 {
		t.Fatalf("tsla on hand %d", q)
	}
	if n := count(t, s, `SELECT COALESCE(SUM(delta), 0) FROM platform_ledger`); n != -600 {
		t.Fatalf("platform net %d", n)
	}
}
