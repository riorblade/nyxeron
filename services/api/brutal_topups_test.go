package main

// Adversarial tests for the top-up path (topups.go, bsc.go): replays, claims, spoofed logs, decimals, caps, the
// 24 h window, scanner/report races, RPC trouble. A passing test proves an attack held; a failing one is a bug
// (see the comment on each). Run with -race.

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- helpers ----------

type bLog struct {
	addr   string   // emitting contract ("" = USDC)
	from   string   // "" = a junk log with no topics (padding)
	to     string   // "" = the Agentic Wallet
	amount *big.Int // base units (18 decimals)
	idx    uint64
}

func usdcAddr() string { return strings.ToLower(game.payments.Topup.Tokens["USDC"]) }
func usdtAddr() string { return strings.ToLower(game.payments.Topup.Tokens["USDT"]) }

// cents of USD as 18-decimal base units.
func centsAmt(c int64) *big.Int { return new(big.Int).Mul(big.NewInt(c), big.NewInt(1e16)) }

func bTx(n int) string { return fmt.Sprintf("0x%064x", n) }

// bReceipt: a successful receipt for tx in block with these logs.
func bReceipt(tx string, block uint64, logs ...bLog) string {
	type lg struct {
		Address     string   `json:"address"`
		Topics      []string `json:"topics"`
		Data        string   `json:"data"`
		BlockNumber string   `json:"blockNumber"`
		BlockHash   string   `json:"blockHash"`
		TxHash      string   `json:"transactionHash"`
		LogIndex    string   `json:"logIndex"`
		Removed     bool     `json:"removed"`
	}
	bn := fmt.Sprintf("0x%x", block)
	bh := fmt.Sprintf("0x%064x", block)
	out := make([]lg, 0, len(logs))
	for _, l := range logs {
		x := lg{Address: l.addr, BlockNumber: bn, BlockHash: bh, TxHash: tx, LogIndex: fmt.Sprintf("0x%x", l.idx), Topics: []string{}, Data: "0x"}
		if x.Address == "" {
			x.Address = usdcAddr()
		}
		if l.from != "" {
			to := l.to
			if to == "" {
				to = game.payments.AgenticWallet
			}
			x.Topics = []string{transferTopic, padded(l.from), padded(to)}
			x.Data = fmt.Sprintf("0x%064x", l.amount)
		}
		out = append(out, x)
	}
	b, _ := json.Marshal(map[string]any{"transactionHash": tx, "status": "0x1", "blockNumber": bn, "blockHash": bh,
		"gasUsed": "0x5208", "logs": out})
	return string(b)
}

func (x *topupAPI) put(tx, rc string) { x.a.receipts[tx], x.b.receipts[tx] = rc, rc }

// realCaps: payments.json's real minimum and caps back on, after newTopupAPI lifted them.
func realCaps(t *testing.T) {
	t.Helper()
	game.payments.Topup.CapUSDPerDay, game.payments.Topup.CapUSDTotal = 20, 100
	if game.payments.Topup.MinUSD != 3 {
		t.Fatalf("payments.json minimum changed: %d", game.payments.Topup.MinUSD)
	}
}

func rec(t *testing.T, s *store, tx string, idx uint64, amount *big.Int, user string, at time.Time) Topup {
	t.Helper()
	tp, _, err := s.recordTopup(ctx, Transfer{Tx: tx, LogIndex: idx, Token: usdcAddr(), From: player,
		To: game.payments.AgenticWallet, Amount: amount}, 0, user, at)
	if err != nil {
		t.Fatalf("recordTopup %s: %v", tx, err)
	}
	return tp
}

const brutalMe = "did:privy:abc" // the fake Privy user

// ---------- BUGS (these fail on main) ----------

// BUG: a claimed "unknown" row keeps the created_at of when the scanner saw it, so the 24 h cap never counts it.
// A player whose wallet isn't stored yet (or who is banned at the time) sends five $20 transfers; the scanner
// records them "unknown". A day later one POST claims all five: each claim sees $0 used today → $100 in one day.
func TestBrutalDailyCapBypassViaLateClaim(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	realCaps(t)
	delete(x.a.receipts, usdcTx)
	delete(x.b.receipts, usdcTx)
	tx := bTx(0xbad1)
	var logs []bLog
	for i := range 5 {
		logs = append(logs, bLog{from: player, amount: centsAmt(2000), idx: uint64(i)})
	}
	x.put(tx, bReceipt(tx, usdcAt+1, logs...))
	c := newBSC(x.a.serve(t), x.b.serve(t))
	old := time.Now().Add(-25 * time.Hour)
	x.db.setScanned(ctx, usdcAt-1, old)
	if err := x.db.scanTopups(ctx, c, old); err != nil {
		t.Fatal(err)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown'`); n != 5 {
		t.Fatalf("unknown rows %d", n)
	}
	code, out := x.post(tx)
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	// Everything credited by this one request happened "today": at most $20 of it may be credited.
	if got := credits(t, x.db, brutalMe); got > 1980 {
		t.Fatalf("daily cap bypassed: %d credits ($%.2f) credited in one request; topped=%v", got, float64(got)/99, out["topped"])
	}
}

// BUG: the scanner stops for good on one transaction it can't read. Anyone can emit a 0-value
// transferFrom(playerWallet → Agentic Wallet) (no allowance needed for 0) inside a tx padded with ~20k empty
// LOG0s (~5M gas, cents of BNB): the receipt is > 4 MB, post() truncates it, Receipt fails on both rpcs, the
// span halves to 1 and the cursor never moves past that block. Every later unreported top-up is never credited.
func TestBrutalScannerWedgedByOversizedReceipt(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now()) // the victim is a known player
	attack := bTx(0xa77ac)
	logs := []bLog{{from: player, amount: big.NewInt(0), idx: 0}}
	for i := 1; i <= 20_000; i++ {
		logs = append(logs, bLog{addr: "0x000000000000000000000000000000000000dead", idx: uint64(i)})
	}
	rc := bReceipt(attack, usdcAt, logs...)
	if len(rc) <= 4<<20 {
		t.Fatalf("attack receipt only %d bytes", len(rc))
	}
	x.put(attack, rc)
	delete(x.a.receipts, usdcTx)
	delete(x.b.receipts, usdcTx)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	now := time.Now()
	x.db.setScanned(ctx, usdcAt-1, now)
	var err error
	for range 3 { // three scanner ticks
		err = x.db.scanTopups(ctx, c, now)
	}
	// A healthy scanner reads past the attack (the 0-value transfer recorded or skipped). Here the cursor stays
	// before it forever, so no later unreported top-up is scanned. (Real eth_getLogs answers in block order, so
	// later transfers in the same span are never reached; the fake rpc's map order would blur that, hence the
	// cursor is what's checked.)
	var cur string
	x.db.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&cur)
	if want := fmt.Sprint(usdcAt + 40 - game.payments.Confirmations + 1); cur != want {
		t.Fatalf("scanner wedged: cursor stuck at %s (safe head %s) after 3 passes: %v", cur, want, err)
	}
}

// BUG: RecordSeed only refuses a tx a player was already credited for. Booked as the seed first (admin mistake or
// a player claiming "that's the team's seed"), the same dollars are then credited to the player as well: the
// platform's books and the player's credits both claim them (reconciliation then pauses all payments).
func TestBrutalSeedThenPlayerReportDoubleCounts(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	if _, err := x.db.RecordSeed(ctx, c, "owner@x", usdcTx, "first stock", time.Now()); err != nil {
		t.Fatal(err)
	}
	code, out := x.post(usdcTx)
	seed := count(t, x.db, `SELECT COUNT(*) FROM platform_ledger WHERE kind = 'seed'`)
	if seed > 0 && code == 200 && out["status"] == "credited" {
		t.Fatalf("same transfer booked as seed AND credited to the player (%v credits)", out["credits"])
	}
}

// ---------- attacks that held ----------

// Replay: the same tx reported 20× at once while three scanners run: one credit, one fee.
func TestBrutalReplayRaceReportAndScanner(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	var wg sync.WaitGroup
	for i := range 23 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i < 3 {
				_ = x.db.scanTopups(ctx, c, time.Now())
				return
			}
			tx := usdcTx
			if i%2 == 0 {
				tx = "0x" + strings.ToUpper(usdcTx[2:])
			}
			x.post(tx)
		}()
	}
	wg.Wait()
	if got := credits(t, x.db, brutalMe); got != 89769 {
		t.Fatalf("credits %d", got)
	}
	for q, want := range map[string]int{
		`SELECT COUNT(*) FROM topups`:                             1,
		`SELECT COUNT(*) FROM ledger WHERE currency = 'credit'`:   1,
		`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'fee'`: 1,
	} {
		if n := count(t, x.db, q); n != want {
			t.Errorf("%s = %d, want %d", q, n, want)
		}
	}
}

// Same tx, different log indexes: each credited once; the same log index twice in one receipt: once.
func TestBrutalLogIndexes(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	tx := bTx(0x10)
	x.put(tx, bReceipt(tx, usdcAt, bLog{from: player, amount: centsAmt(500), idx: 1}, bLog{from: player, amount: centsAmt(500), idx: 2}))
	if code, out := x.post(tx); code != 200 || out["credits"] != float64(2*495) {
		t.Fatalf("%d %v", code, out)
	}
	dup := bTx(0x11)
	x.put(dup, bReceipt(dup, usdcAt, bLog{from: player, amount: centsAmt(500), idx: 7}, bLog{from: player, amount: centsAmt(500), idx: 7}))
	x.post(dup)
	if got := credits(t, x.db, brutalMe); got != 3*495 {
		t.Fatalf("duplicate log index credited twice: %d", got)
	}
}

// Claim someone else's transfer: reported by another player, or claimed while "unknown": nothing moves.
func TestBrutalClaimSomeoneElsesTransfer(t *testing.T) {
	attacker := "0x00000000000000000000000000000000000a77ac"
	x := newTopupAPI(t, attacker, usdcAt+20)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	if err := x.db.scanTopups(ctx, c, time.Now()); err != nil { // the victim's wallet isn't stored: "unknown"
		t.Fatal(err)
	}
	if code, out := x.post(usdcTx); code != 422 || out["error"] != "not_a_topup" {
		t.Fatalf("%d %v", code, out)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown' AND user_id = ''`); n != 1 {
		t.Fatalf("the victim's row changed hands")
	}
	if got := credits(t, x.db, brutalMe); got != 0 {
		t.Fatalf("attacker got %d", got)
	}
}

// Spoofed logs: a Transfer event from a contract that isn't a locked token, a look-alike token, a recipient that
// isn't the Agentic Wallet, a failed tx. Only the real USDC log next to them counts.
func TestBrutalSpoofedLogs(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	fake := bTx(0x20)
	x.put(fake, bReceipt(fake, usdcAt,
		bLog{addr: "0x00000000000000000000000000000000deadbeef", from: player, amount: centsAmt(1_000_000), idx: 0},
		bLog{addr: usdcAddr()[:41] + "0", from: player, amount: centsAmt(1_000_000), idx: 1},
		bLog{from: player, to: "0x00000000000000000000000000000000000a77ac", amount: centsAmt(1_000_000), idx: 2}))
	if code, out := x.post(fake); code != 422 || out["error"] != "not_a_topup" {
		t.Fatalf("spoof %d %v", code, out)
	}
	mixed := bTx(0x21)
	x.put(mixed, bReceipt(mixed, usdcAt,
		bLog{addr: "0x00000000000000000000000000000000deadbeef", from: player, amount: centsAmt(1_000_000), idx: 0},
		bLog{addr: usdtAddr(), from: player, amount: centsAmt(500), idx: 1}))
	if code, out := x.post(mixed); code != 200 || out["credits"] != float64(495) {
		t.Fatalf("mixed %d %v", code, out)
	}
	failed := bTx(0x22)
	x.put(failed, strings.Replace(bReceipt(failed, usdcAt, bLog{from: player, amount: centsAmt(500), idx: 0}), `"status":"0x1"`, `"status":"0x0"`, 1))
	if code, _ := x.post(failed); code != 422 {
		t.Fatalf("failed tx %d", code)
	}
	if got := credits(t, x.db, brutalMe); got != 495 {
		t.Fatalf("credits %d", got)
	}
}

// Decimals: USDC/USDT on BSC have 18. A 6-decimal "$3" (3e6) is 0 cents; dust and 0 credit nothing; sub-cent
// remainders round down; fee + credits always add up to the credited cents.
func TestBrutalDecimalsAndDust(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	n := 0
	next := func() string { n++; return bTx(0x300 + n) }
	for _, amt := range []*big.Int{big.NewInt(0), big.NewInt(1), big.NewInt(3_000_000), new(big.Int).Sub(centsAmt(300), big.NewInt(1))} {
		if tp := rec(t, s, next(), 0, amt, "a", time.Now()); tp.Status != "rejected" || tp.Credits != 0 {
			t.Fatalf("%s: %+v", amt, tp)
		}
	}
	if tp := rec(t, s, next(), 0, centsAmt(300), "a", time.Now()); tp.Status != "credited" || tp.Credits != 297 || tp.Fee != 3 {
		t.Fatalf("$3: %+v", tp)
	}
	almost := new(big.Int).Sub(centsAmt(302), big.NewInt(1)) // $3.0199…: 301 cents
	if tp := rec(t, s, next(), 0, almost, "a", time.Now()); tp.USDCents != 301 || tp.Fee != 4 || tp.Credits != 297 {
		t.Fatalf("$3.0199: %+v", tp)
	}
	if got := credits(t, s, "a"); got != 594 {
		t.Fatalf("credits %d", got)
	}
	for c := int64(300); c <= 2000; c++ {
		if f := topupFee(c); f+toCredits(c-f) != c || f != (c+99)/100 {
			t.Fatalf("fee rounding at %d cents: fee %d credits %d", c, f, toCredits(c-f))
		}
	}
}

// Huge amounts: past int64 cents the transfer is refused (nothing recorded); right at MaxInt64 cents only the
// room is credited.
func TestBrutalHugeAmounts(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	max256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	over := new(big.Int).Mul(new(big.Int).Add(big.NewInt(math.MaxInt64), big.NewInt(1)), big.NewInt(1e16))
	for _, amt := range []*big.Int{max256, over, big.NewInt(-1)} {
		if _, _, err := s.recordTopup(ctx, Transfer{Tx: bTx(0x400), Token: usdcAddr(), From: player,
			To: game.payments.AgenticWallet, Amount: amt}, 0, "a", time.Now()); err == nil {
			t.Fatalf("%s accepted", amt)
		}
	}
	if n := count(t, s, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("%d rows", n)
	}
	edge := new(big.Int).Mul(big.NewInt(math.MaxInt64), big.NewInt(1e16))
	if tp := rec(t, s, bTx(0x401), 0, edge, "a", time.Now()); tp.USDCents != 2000 || tp.Credits != 1980 {
		t.Fatalf("edge %+v", tp)
	}
}

// Caps to the cent: exactly $20 a day, room of 299 cents is under the minimum, exactly $100 in all.
func TestBrutalCapBoundaries(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	s.Get(ctx, "a")
	if tp := rec(t, s, bTx(0x500), 0, centsAmt(1700), "a", now); tp.USDCents != 1700 {
		t.Fatalf("%+v", tp)
	}
	if tp := rec(t, s, bTx(0x501), 0, centsAmt(300), "a", now); tp.Status != "credited" || tp.USDCents != 300 || tp.Reason != "" {
		t.Fatalf("exactly at the cap: %+v", tp)
	}
	if tp := rec(t, s, bTx(0x502), 0, centsAmt(300), "a", now); tp.Status != "rejected" {
		t.Fatalf("cap + $3: %+v", tp)
	}
	s.Get(ctx, "b")
	rec(t, s, bTx(0x503), 0, centsAmt(1701), "b", now)
	if tp := rec(t, s, bTx(0x504), 0, centsAmt(300), "b", now); tp.Status != "rejected" {
		t.Fatalf("299 cents of room: %+v", tp)
	}
	// $20.01 into an empty day: $20 credited, 1 cent recorded for a refund.
	s.Get(ctx, "c")
	if tp := rec(t, s, bTx(0x505), 0, centsAmt(2001), "c", now); tp.USDCents != 2000 || !strings.Contains(tp.Reason, "1 cents") {
		t.Fatalf("cap + 1 cent: %+v", tp)
	}
	// Total: $99.99 over five days, then $3: only 1 cent of room, rejected.
	s.Get(ctx, "d")
	for d, c := range []int64{2000, 2000, 2000, 2000, 1999} {
		rec(t, s, bTx(0x510+d), 0, centsAmt(c), "d", now.Add(time.Duration(d)*25*time.Hour))
	}
	if tp := rec(t, s, bTx(0x520), 0, centsAmt(300), "d", now.Add(6*25*time.Hour)); tp.Status != "rejected" {
		t.Fatalf("over the total: %+v", tp)
	}
	var total int64
	s.db.QueryRow(`SELECT SUM(usd_cents) FROM topups WHERE user_id = 'd' AND status = 'credited'`).Scan(&total)
	if total != 9999 {
		t.Fatalf("total %d", total)
	}
}

// The 24 h window: 1 s before it ends the day is still full; at exactly 86400 s it is free again.
func TestBrutal24hWindowEdges(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	t0 := time.Unix(1_800_000_000, 0)
	rec(t, s, bTx(0x600), 0, centsAmt(2000), "a", t0)
	if tp := rec(t, s, bTx(0x601), 0, centsAmt(300), "a", t0.Add(86399*time.Second)); tp.Status != "rejected" {
		t.Fatalf("inside the day: %+v", tp)
	}
	if tp := rec(t, s, bTx(0x602), 0, centsAmt(2000), "a", t0.Add(86400*time.Second)); tp.Status != "credited" || tp.USDCents != 2000 {
		t.Fatalf("day over: %+v", tp)
	}
}

// Many different $15 top-ups at once, half reported, half scanned, with the real caps: never more than $20.
func TestBrutalConcurrentCapsAcrossReportAndScanner(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+40)
	realCaps(t)
	delete(x.a.receipts, usdcTx)
	delete(x.b.receipts, usdcTx)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	var txs []string
	for i := range 10 {
		tx := bTx(0x700 + i)
		x.put(tx, bReceipt(tx, usdcAt+uint64(i), bLog{from: player, amount: centsAmt(1500), idx: 0}))
		txs = append(txs, tx)
	}
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	var wg sync.WaitGroup
	for i, tx := range txs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				x.post(tx)
			} else {
				_ = x.db.scanTopups(ctx, c, time.Now())
			}
		}()
	}
	wg.Wait()
	_ = x.db.scanTopups(ctx, c, time.Now())
	var cents int64
	x.db.db.QueryRow(`SELECT COALESCE(SUM(usd_cents), 0) FROM topups WHERE status = 'credited'`).Scan(&cents)
	if cents > 2000 || credits(t, x.db, brutalMe) > 1980 {
		t.Fatalf("credited %d cents, credits %d", cents, credits(t, x.db, brutalMe))
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 10 {
		t.Fatalf("%d rows", n)
	}
}

// RPC trouble: confirmations drop (a reorg / a lagging provider), providers disagree on the block, one has the
// receipt and the other doesn't, both on the wrong chain: never credited, always retryable.
func TestBrutalRPCTrouble(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+10)
	if code, _ := x.post(usdcTx); code != 202 {
		t.Fatalf("14 confirmations: %d", code)
	}
	x.a.head = usdcAt + 30 // one provider ahead: the lower head counts
	if code, _ := x.post(usdcTx); code != 202 {
		t.Fatalf("one rpc ahead: %d", code)
	}
	x.b.head = usdcAt + 30
	x.b.receipts[usdcTx] = strings.ReplaceAll(x.a.receipts[usdcTx], "0xff15f423", "0xee15f423") // a reorg: other block hash
	if code, _ := x.post(usdcTx); code != 503 {
		t.Fatalf("block hash mismatch: %d", code)
	}
	delete(x.b.receipts, usdcTx)
	if code, _ := x.post(usdcTx); code != 503 {
		t.Fatalf("one rpc lacks the receipt: %d", code)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("%d rows", n)
	}
	y := newTopupAPI(t, player, usdcAt+20)
	y.a.chainID, y.b.chainID = "0x61", "0x61" // both on BSC testnet
	if code, _ := y.post(usdcTx); code != 503 {
		t.Fatalf("testnet: %d", code)
	}
	if n := count(t, y.db, `SELECT COUNT(*) FROM topups`); n != 0 {
		t.Fatalf("testnet credited")
	}
}

// A banned player's transfer stays "unknown" in the scanner and can't be claimed by a report while banned.
func TestBrutalBannedPlayerCannotClaim(t *testing.T) {
	x := newTopupAPI(t, player, usdcAt+20)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now())
	x.db.db.Exec(`UPDATE users SET banned = 1 WHERE id = ?`, brutalMe)
	c := newBSC(x.a.serve(t), x.b.serve(t))
	x.db.setScanned(ctx, usdcAt-1, time.Now())
	if err := x.db.scanTopups(ctx, c, time.Now()); err != nil {
		t.Fatal(err)
	}
	if code, _ := x.post(usdcTx); code != 403 {
		t.Fatalf("banned report %d", code)
	}
	if n := count(t, x.db, `SELECT COUNT(*) FROM topups WHERE status = 'unknown' AND user_id = ''`); n != 1 || credits(t, x.db, brutalMe) != 0 {
		t.Fatalf("banned player credited")
	}
}

// The player's wallet changes (Privy now reports another one): transfers from the old wallet are no one's
// (not claimable by a report, "unknown" in the scanner), never someone else's.
func TestBrutalWalletChange(t *testing.T) {
	newWallet := "0x00000000000000000000000000000000000b0b0b"
	x := newTopupAPI(t, newWallet, usdcAt+20)
	x.db.Get(ctx, brutalMe)
	x.db.SetIdentity(ctx, brutalMe, "kiel@x", player, time.Now()) // the old wallet stored
	if code, out := x.post(usdcTx); code != 422 || out["error"] != "not_a_topup" {
		t.Fatalf("old wallet's tx %d %v", code, out)
	}
	if id, _ := x.db.playerByWallet(ctx, player); id != "" {
		t.Fatalf("old wallet still maps to %q", id)
	}
}
