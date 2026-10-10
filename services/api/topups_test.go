package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The recorded USDC transfer, re-addressed: the real sender is our player's embedded wallet and the recipient is
// the Agentic Wallet. Amounts and senders are swapped in as text, so every case is a real receipt's shape.
const (
	player     = "0x11713482f2fb3f5d17e33969bc402339e41abe36" // the fixture's sender
	realTo     = "0x0000000000000000000000008ec07697ea678ed029787f7d01dcccc3a0b07f9b"
	realAmount = "0x00000000000000000000000000000000000000000000003127e1bd11aee80dea" // 906.764245… USDC
	threeUSD   = "0x00000000000000000000000000000000000000000000000029a2241af62c0000" // 3 × 1e18
)

func padded(addr string) string { return "0x" + strings.Repeat("0", 24) + strings.ToLower(addr[2:]) }

// topupReceipt: the fixture as a top-up from player to the Agentic Wallet, with these replacements on top.
func topupReceipt(t *testing.T, swaps ...string) string {
	rc := strings.Replace(fixture(t, "receipt-usdc-transfer"), realTo, padded(game.payments.AgenticWallet), 1)
	for i := 0; i+1 < len(swaps); i += 2 {
		if !strings.Contains(rc, swaps[i]) {
			t.Fatalf("fixture text %q not found", swaps[i])
		}
		rc = strings.Replace(rc, swaps[i], swaps[i+1], 1)
	}
	return rc
}

type topupAPI struct {
	t      *testing.T
	srv    *httptest.Server
	db     *store
	tok    string
	a, b   *fakeRPC
	wallet string
	key    *ecdsa.PrivateKey
}

// liftCaps: the recorded transfer is $906, over payments.json's caps; tests of the chain path lift them
// (TestTopupCaps checks the real ones).
func liftCaps(t *testing.T) {
	caps := game.payments.Topup
	game.payments.Topup.CapUSDPerDay, game.payments.Topup.CapUSDTotal = 1_000_000, 1_000_000
	t.Cleanup(func() { game.payments.Topup = caps })
}

func newTopupAPI(t *testing.T, wallet string, head uint64) *topupAPI {
	liftCaps(t)
	every := topupEvery
	topupEvery = 0 // tests report back to back; TestTopupRateLimit checks the real pace
	t.Cleanup(func() { topupEvery = every })
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	a, b := newFakeRPC(t, head), newFakeRPC(t, head)
	a.receipts[usdcTx], b.receipts[usdcTx] = topupReceipt(t), topupReceipt(t)
	t.Setenv("BSC_RPC_1", a.serve(t))
	t.Setenv("BSC_RPC_2", b.serve(t))
	db := testStore(t)
	srv := httptest.NewServer(routes(&quoter{}, nil, fakePrivyWallet(t, key, wallet), db, nil))
	t.Cleanup(srv.Close)
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	return &topupAPI{t: t, srv: srv, db: db, tok: tok, a: a, b: b, wallet: wallet, key: key}
}

func (x *topupAPI) post(tx string) (int, map[string]any) {
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(map[string]string{"tx": tx})
	req, _ := http.NewRequest(http.MethodPost, x.srv.URL+"/api/topups", &buf)
	req.Header.Set("Authorization", "Bearer "+x.tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		x.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// both fake rpcs answer this receipt for usdcTx.
func (x *topupAPI) receipt(rc string) { x.a.receipts[usdcTx], x.b.receipts[usdcTx] = rc, rc }

func TestTopupCreditsOnce(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	code, out := x.post(usdcTx)
	// 906.76 USDC → 90676 cents; fee 1% rounded up = 907; credits 89769.
	if code != 200 || out["status"] != "credited" || out["credits"] != float64(89769) {
		t.Fatalf("%d %v", code, out)
	}
	// The same transfer reported again (a retry, a second tab): nothing more.
	if code, out := x.post(usdcTx); code != 200 || out["credits"] != float64(89769) {
		t.Fatalf("double report %d %v", code, out)
	}
	checks := map[string]int{
		`SELECT COUNT(*) FROM topups WHERE status = 'credited' AND usd_cents = 90676 AND fee = 907 AND credits = 89769 AND gas_used > 0`: 1,
		`SELECT COUNT(*) FROM ledger WHERE currency = 'credit' AND kind = 'topup' AND delta = 89769`:                                     1,
		`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'fee' AND delta = 907`:                                                        1,
		`SELECT COUNT(*) FROM users WHERE lower(wallet_address) = '` + player + `'`:                                                      1,
	}
	for q, want := range checks {
		if got := count(t, x.db, q); got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
	// Coin is untouched: credits are a separate balance.
	if p, _ := x.db.Get(ctx, "did:privy:abc"); p.Wallet != startWallet {
		t.Fatalf("Coin changed: %d", p.Wallet)
	}
}

func TestTopupSmallAmountIsCreditedInFull(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	x.receipt(topupReceipt(t, realAmount, threeUSD))
	if code, out := x.post(usdcTx); code != 200 || out["credits"] != float64(297) { // $3 − 3 cents
		t.Fatalf("%d %v", code, out)
	}
}

func TestTopupRefusals(t *testing.T) {
	stranger := "0x00000000000000000000000099999999999999999999999999999999999999aa"
	cases := map[string]struct {
		head    uint64
		receipt func(t *testing.T) string
		tx      string
		code    int
		errCode string
	}{
		"not final yet": {head: usdcAt + game.payments.Confirmations - 2, code: 202},
		"unknown tx":    {head: usdcAt + 20, tx: "0x" + strings.Repeat("ef", 32), code: 202},
		"failed tx":     {head: usdcAt + 20, tx: failedTx, code: 422, errCode: "tx_failed"},
		"bad hash":      {head: usdcAt + 20, tx: "0x1234", code: 400},
		"someone else's transfer": {head: usdcAt + 20, code: 422, errCode: "not_a_topup",
			receipt: func(t *testing.T) string { return topupReceipt(t, padded(player), stranger) }},
		"not to the platform": {head: usdcAt + 20, code: 422, errCode: "not_a_topup",
			receipt: func(t *testing.T) string { return fixture(t, "receipt-usdc-transfer") }},
		"not a locked token": {head: usdcAt + 20, code: 422, errCode: "not_a_topup",
			receipt: func(t *testing.T) string {
				return topupReceipt(t, `"address": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"`,
					`"address": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd5800"`)
			}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			x := newTopupAPI(t, player, c.head)
			if c.receipt != nil {
				x.receipt(c.receipt(t))
			}
			tx := usdcTx
			if c.tx != "" {
				tx = c.tx
			}
			code, out := x.post(tx)
			if code != c.code || (c.errCode != "" && out["error"] != c.errCode) {
				t.Fatalf("%d %v", code, out)
			}
			if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 0 {
				t.Fatalf("%d top-ups recorded", n)
			}
			if n := count(t, x.db, `SELECT COUNT(*) FROM ledger WHERE currency = 'credit'`); n != 0 {
				t.Fatalf("%d credit rows", n)
			}
		})
	}
}

func TestTopupWhenTheChainCanNotBeTrusted(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	x.b.receipts[usdcTx] = topupReceipt(t, realAmount, threeUSD) // the providers disagree on the amount
	if code, out := x.post(usdcTx); code != 503 || out["error"] != "chain_unavailable" {
		t.Fatalf("mismatch %d %v", code, out)
	}
	x.b.receipts[usdcTx] = x.a.receipts[usdcTx]
	x.b.down = true
	if code, out := x.post(usdcTx); code != 503 || out["error"] != "chain_unavailable" {
		t.Fatalf("one rpc down %d %v", code, out)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("%d top-ups recorded", n)
	}
	// A provider on another chain (the chain id is checked once per rpc, before its first answer counts).
	y := newTopupAPI(t, player, usdcAt+20)
	y.b.chainID = "0x1"
	if code, _ := y.post(usdcTx); code != 503 {
		t.Fatalf("wrong chain %d", code)
	}
	if n := count(t, y.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("%d top-ups recorded on the wrong chain", n)
	}
}

func TestTopupsNeedTwoRPCs(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	t.Setenv("BSC_RPC_1", "http://one")
	t.Setenv("BSC_RPC_2", "")
	srv := httptest.NewServer(routes(&quoter{}, nil, fakePrivyWallet(t, key, player), testStore(t), nil))
	defer srv.Close()
	tok := signJWT(t, key, map[string]any{"alg": "ES256", "kid": "k1"}, good(time.Now().Add(time.Hour)))
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/topups", strings.NewReader(`{"tx":"`+usdcTx+`"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 503 {
		t.Fatalf("one rpc configured: %d", res.StatusCode)
	}
	if res, _ := http.Post(srv.URL+"/api/topups", "application/json", strings.NewReader(`{"tx":"`+usdcTx+`"}`)); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
}

// The scanner credits transfers nobody reported: the player's (by their stored wallet) and, for a sender who is
// nobody's wallet, a record without credits. Reported and scanned never double up.
func TestTopupScanner(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.Get(ctx, "did:privy:abc")
	x.db.SetIdentity(ctx, "did:privy:abc", "kiel@x", "0x"+strings.ToUpper(player[2:]), now) // checksum case
	// The first pass only marks where to start.
	x.db.setScanned(ctx, usdcAt-1, now)
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if got := credits(t, x.db, "did:privy:abc"); got != 89769 {
		t.Fatalf("scanned credits %d", got)
	}
	// Reported afterwards: already there, nothing more.
	if code, out := x.post(usdcTx); code != 200 || out["credits"] != float64(89769) {
		t.Fatalf("report after scan %d %v", code, out)
	}
	// A transfer from a wallet that is nobody's: recorded "unknown", no credits.
	other := "0x" + strings.Repeat("ab", 32)
	rc := strings.ReplaceAll(topupReceipt(t, padded(player), padded("0x99999999999999999999999999999999999999aa")), usdcTx, other)
	rc = strings.ReplaceAll(rc, `"0x77b514b"`, fmt.Sprintf(`"0x%x"`, usdcAt+10)) // inside the next pass
	x.a.receipts[other], x.b.receipts[other] = rc, rc
	x.a.head, x.b.head = usdcAt+30, usdcAt+30
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown' AND user_id = '' AND credits = 0`); n != 1 {
		t.Fatalf("unknown sender rows %d", n)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 2 {
		t.Fatalf("top-ups %d", n)
	}
	if got := credits(t, x.db, "did:privy:abc"); got != 89769 {
		t.Fatalf("credits after the second pass %d", got)
	}
	var last string
	x.db.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&last)
	if want := fmt.Sprint(usdcAt + 30 - game.payments.Confirmations + 1); last != want {
		t.Fatalf("scanned up to %s, want %s", last, want)
	}
}

// The scanner saw the transfer before the player's wallet was stored ("unknown", no credits): the player's own
// report later claims it and is credited, once.
func TestTopupReportClaimsAnUnknownTransfer(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-1, now)
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown' AND user_id = ''`); n != 1 {
		t.Fatalf("unknown rows %d", n)
	}
	if code, out := x.post(usdcTx); code != 200 || out["credits"] != float64(89769) {
		t.Fatalf("claim %d %v", code, out)
	}
	if code, out := x.post("0x" + strings.ToUpper(usdcTx[2:])); code != 200 || out["credits"] != float64(89769) {
		t.Fatalf("again, upper case %d %v", code, out)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM ledger WHERE currency = 'credit'`); n != 1 {
		t.Fatalf("credit rows %d", n)
	}
}

// One transaction with two transfers from the player to the platform (e.g. a batched send): both credited.
func TestTopupSeveralTransfersInOneTx(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	var rc map[string]any
	json.Unmarshal([]byte(topupReceipt(t)), &rc)
	logs := rc["logs"].([]any)
	second := map[string]any{}
	for k, v := range logs[0].(map[string]any) {
		second[k] = v
	}
	second["logIndex"], second["data"] = "0x19", threeUSD
	rc["logs"] = append(logs, second)
	b, _ := json.Marshal(rc)
	x.receipt(string(b))
	if code, out := x.post(usdcTx); code != 200 || out["credits"] != float64(89769+297) {
		t.Fatalf("%d %v", code, out)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'credited'`); n != 2 {
		t.Fatalf("rows %d", n)
	}
}

func TestTopupPlayerStates(t *testing.T) {
	// No embedded wallet yet: nothing to match, the web asks again later.
	x := newTopupAPI(t, "", usdcAt+20)
	if code, out := x.post(usdcTx); code != 409 || out["error"] != "no_wallet" {
		t.Fatalf("no wallet %d %v", code, out)
	}
	// A banned player changes nothing.
	y := newTopupAPI(t, player, usdcAt+20)
	y.db.Get(ctx, "did:privy:abc")
	y.db.db.Exec(`UPDATE users SET banned = 1 WHERE id = 'did:privy:abc'`)
	if code, _ := y.post(usdcTx); code != 403 {
		t.Fatalf("banned %d", code)
	}
	if n := count(t, y.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("banned player recorded %d", n)
	}
}

func TestTopupRateLimit(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	topupEvery = time.Hour
	if code, _ := x.post(usdcTx); code != 200 {
		t.Fatalf("first %d", code)
	}
	if code, out := x.post(usdcTx); code != 429 || out["error"] != "too_soon" {
		t.Fatalf("second %d %v", code, out)
	}
}

// The scanner never skips blocks: a pass that fails keeps the cursor where it was, and the first pass only
// marks where to start.
func TestTopupScannerCursor(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	cursor := func() string {
		var v string
		x.db.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&v)
		return v
	}
	if err := x.db.scanTopups(ctx, c, now); err != nil {
		t.Fatal(err)
	}
	if want := fmt.Sprint(usdcAt + 20 - game.payments.Confirmations + 1); cursor() != want {
		t.Fatalf("first pass cursor %s, want %s", cursor(), want)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("the first pass replayed history: %d", n)
	}
	x.db.setScanned(ctx, usdcAt-1, now)
	x.b.down = true
	if err := x.db.scanTopups(ctx, c, now); err == nil {
		t.Fatal("a scan with one provider down succeeded")
	}
	if cursor() != fmt.Sprint(usdcAt-1) {
		t.Fatalf("cursor moved past unread blocks: %s", cursor())
	}
	x.b.down = false
	if err := x.db.scanTopups(ctx, c, now); err != nil || count(t, x.db, `SELECT COUNT(*) FROM topups`) != 1 {
		t.Fatalf("after recovery: %v", err)
	}
}

// payments.json's minimum and caps are kept by the api: a player is credited up to their room, never below the
// minimum; what isn't credited is recorded for a refund. Real caps: $3 minimum, $20 a day, $100 in all.
func TestTopupCaps(t *testing.T) {
	s := testStore(t)
	p := game.payments.Topup
	if p.MinUSD != 3 || p.CapUSDPerDay != 20 || p.CapUSDTotal != 100 {
		t.Fatalf("payments.json caps changed: %+v; update this test", p)
	}
	s.Get(ctx, "a")
	n := 0
	send := func(usd float64, at time.Time) Topup {
		t.Helper()
		n++
		amount, _ := new(big.Float).Mul(big.NewFloat(usd), big.NewFloat(1e18)).Int(nil)
		tp, _, err := s.recordTopup(ctx, Transfer{Tx: fmt.Sprintf("0x%064x", n), Token: p.Tokens["USDC"],
			From: player, To: game.payments.AgenticWallet, Amount: amount}, 0, "a", at)
		if err != nil {
			t.Fatal(err)
		}
		return tp
	}
	day := time.Now()
	// Under the minimum: nothing credited, recorded for a refund.
	if tp := send(2.99, day); tp.Status != "rejected" || tp.Credits != 0 || tp.Reason == "" || credits(t, s, "a") != 0 {
		t.Fatalf("under the minimum: %+v", tp)
	}
	// $25 in a day: $20 credited (less the 1% fee), $5 over the daily cap recorded.
	if tp := send(25, day); tp.Status != "credited" || tp.USDCents != 2000 || tp.Credits != 1980 || !strings.Contains(tp.Reason, "500 cents") {
		t.Fatalf("over the daily cap: %+v", tp)
	}
	if tp := send(5, day); tp.Status != "rejected" || credits(t, s, "a") != 1980 {
		t.Fatalf("no room left today: %+v", tp)
	}
	// Day by day up to $100 in all: the fifth day has $20 room, the sixth none.
	for d := 1; d <= 4; d++ {
		if tp := send(20, day.Add(time.Duration(d)*25*time.Hour)); tp.Status != "credited" || tp.USDCents != 2000 {
			t.Fatalf("day %d: %+v", d+1, tp)
		}
	}
	if tp := send(20, day.Add(5*25*time.Hour)); tp.Status != "rejected" {
		t.Fatalf("over the total cap: %+v", tp)
	}
	if got := credits(t, s, "a"); got != 5*1980 {
		t.Fatalf("credits %d, want %d", got, 5*1980)
	}
	// Room under the minimum credits nothing: $2 left in the day is below $3.
	s.Get(ctx, "b")
	b := func(usd float64) Topup {
		n++
		amount, _ := new(big.Float).Mul(big.NewFloat(usd), big.NewFloat(1e18)).Int(nil)
		tp, _, err := s.recordTopup(ctx, Transfer{Tx: fmt.Sprintf("0x%064x", n), Token: p.Tokens["USDC"],
			From: player, To: game.payments.AgenticWallet, Amount: amount}, 0, "b", day)
		if err != nil {
			t.Fatal(err)
		}
		return tp
	}
	b(18)
	if tp := b(10); tp.Status != "rejected" {
		t.Fatalf("$2 of room is under the minimum: %+v", tp)
	}
}

// Two claims at once can't share the same room: the api's single connection serializes them.
func TestTopupCapsUnderConcurrentClaims(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			amount, _ := new(big.Int).SetString("15000000000000000000", 10) // $15 each, $60 against a $20 day
			if _, _, err := s.recordTopup(ctx, Transfer{Tx: fmt.Sprintf("0x%064x", 100+i), Token: game.payments.Topup.Tokens["USDC"],
				From: player, To: game.payments.AgenticWallet, Amount: amount}, 0, "a", time.Now()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var cents int64
	s.db.QueryRow(`SELECT SUM(usd_cents) FROM topups WHERE user_id = 'a' AND status = 'credited'`).Scan(&cents)
	// $15 fits, then $5 of room (≥ the $3 minimum) is credited; the other two are rejected: $20 in all.
	if cents != 2000 || credits(t, s, "a") != toCredits(1500-topupFee(1500))+toCredits(500-topupFee(500)) {
		t.Fatalf("credited %d cents, credits %d", cents, credits(t, s, "a"))
	}
}

// The scanner doesn't credit a banned player either: their transfer stays "unknown" for the back office.
func TestTopupScannerSkipsBannedPlayers(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	s.SetIdentity(ctx, "a", "a@x", player, time.Now())
	if id, _ := s.playerByWallet(ctx, player); id != "a" {
		t.Fatalf("player %q", id)
	}
	s.db.Exec(`UPDATE users SET banned = 1 WHERE id = 'a'`)
	if id, _ := s.playerByWallet(ctx, player); id != "" {
		t.Fatalf("banned player matched: %q", id)
	}
}
