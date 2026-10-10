package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Top-ups: a player sends USDC or USDT from their embedded wallet to the platform's Agentic Wallet; the api reads
// the transfer on BSC itself (bsc.go: two rpcs, 15 confirmations) and only then mints credits, (amount − fee) ×
// 100, in one transaction with the ledger. The browser only reports a tx hash; the amount, the sender and the
// recipient come from the chain. A transfer is credited once (tx + log index unique), whoever reports it.
//
//	POST /api/topups {tx} → {status, credits, topups}; status "pending" until the transfer is final
//	GET  /api/topups      → {credits, topups} (the player's last 20)
//
// payments.json's minimum and caps are kept here, in the same transaction as the credits (the web checks them too
// before it sends): a player is credited only up to their room (capUsdPerDay over 24 h, capUsdTotal in all), and
// nothing when that is below minUsd. What isn't credited stays recorded for the back office to refund by hand: a
// "rejected" row when nothing was credited, or a "credited" row whose reason says how many cents were over the
// caps (usd_cents is then the credited part; amount is always what arrived). Senders that are no player's wallet
// are recorded as "unknown", without credits. refund_cents keeps what is owed back, until the back office marks it
// refunded (MarkRefunded); reconciliation counts it as owed, not as backing.

type Topup struct {
	Tx       string `json:"tx"`
	LogIndex int64  `json:"logIndex"`
	Token    string `json:"token"`
	USDCents int64  `json:"usdCents"`
	Fee      int64  `json:"fee"`
	Credits  int64  `json:"credits"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"` // what wasn't credited and why (the back office refunds it)
	At       int64  `json:"at"`
}

// usdCents: a stablecoin amount (18 decimals, 1 token = $1) in whole cents, rounded down.
func usdCents(amount *big.Int) int64 {
	c := new(big.Int).Quo(amount, big.NewInt(1e16))
	if !c.IsInt64() {
		return -1
	}
	return c.Int64()
}

// usdCentsUp: the same, rounded up (money that left the platform's wallet).
func usdCentsUp(amount *big.Int) int64 {
	q, r := new(big.Int).QuoRem(amount, big.NewInt(1e16), new(big.Int))
	if r.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	if !q.IsInt64() {
		return -1
	}
	return q.Int64()
}

// topupFee: payments.json's percentage of the top-up, in cents, rounded up (it covers the gas sponsorship).
func topupFee(cents int64) int64 {
	pct := int64(game.payments.Topup.FeePercent)
	return (cents*pct + 99) / 100
}

func topupToken(addr string) bool {
	for _, t := range game.payments.Topup.Tokens {
		if strings.EqualFold(t, addr) {
			return true
		}
	}
	return false
}

// recordTopup credits one transfer to the Agentic Wallet, once. user "" = no player is known for the sender yet
// (recorded "unknown", no credits). A later call with the sender's player claims such a row and credits it then
// (the scanner can see a transfer before the player's wallet is stored). fresh is false when nothing changed.
func (s *store) recordTopup(ctx context.Context, tr Transfer, gasUsed uint64, user string, now time.Time) (tp Topup, fresh bool, err error) {
	return s.recordTransfer(ctx, tr, gasUsed, user, false, now)
}

// recordTransfer is recordTopup; change: the Agentic Wallet itself paid stablecoin out in the same transaction (a
// swap whose router sent back what it didn't use). Such a transfer from no player is the platform's own money,
// netted in the restock's books (restock.go), so nothing is owed back on it.
func (s *store) recordTransfer(ctx context.Context, tr Transfer, gasUsed uint64, user string, change bool, now time.Time) (tp Topup, fresh bool, err error) {
	if !topupToken(tr.Token) || !strings.EqualFold(tr.To, game.payments.AgenticWallet) || tr.Amount == nil || tr.Amount.Sign() < 0 {
		return tp, false, errBad
	}
	cents := usdCents(tr.Amount)
	if cents < 0 {
		return tp, false, errBad
	}
	if err := s.unpaused(ctx); err != nil { // a reconciliation mismatch stands: no new credits until it clears
		return tp, false, err
	}
	tp = Topup{Tx: strings.ToLower(tr.Tx), LogIndex: int64(tr.LogIndex), Token: tr.Token, USDCents: cents,
		Status: "unknown", At: now.Unix()}
	refund := cents // owed back to the sender: all of it until it is credited (reconcile.go counts it as owed)
	if change && user == "" {
		refund = 0
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return tp, false, err
	}
	defer t.Rollback()
	if err := pausedIn(t); err != nil { // read again inside: a reconciliation that paused meanwhile stops this
		return tp, false, err
	}
	var seed int // booked as the team's seed already: these dollars are the platform's, never also a player's
	if err := t.QueryRow(`SELECT COUNT(*) FROM platform_ledger WHERE kind = 'seed' AND lower(ref) = ?`, tp.Tx).Scan(&seed); err != nil {
		return tp, false, err
	}
	switch {
	case seed > 0:
		tp.Status, tp.Reason = "rejected", "seed: booked as the platform's own money, for the back office to check"
		refund = 0 // the platform's own money: owed to nobody
	case user != "":
		// Inside the transaction: the api's single connection serializes top-ups, so two claims can't share room.
		ok, err := topupRoom(t, user, now)
		if err != nil {
			return tp, false, err
		}
		ok = min(ok, cents)
		switch {
		case ok < game.payments.Topup.MinUSD*100:
			tp.Status, tp.Reason = "rejected", fmt.Sprintf("%d cents not credited: under the $%d minimum or over the caps, to refund", cents, game.payments.Topup.MinUSD)
		default:
			tp.Status, tp.USDCents, tp.Fee = "credited", ok, topupFee(ok)
			tp.Credits = toCredits(ok - tp.Fee)
			refund = cents - ok
			if ok < cents {
				tp.Reason = fmt.Sprintf("%d cents over the caps, to refund", cents-ok)
			}
		}
	}
	res, err := t.Exec(`INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, gas_used, credits,
		status, reason, refund_cents, created_at, updated_at, credited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (tx, log_index) DO NOTHING`,
		tp.Tx, tp.LogIndex, user, tr.From, tp.Token, tr.Amount.String(), tp.USDCents, tp.Fee, int64(gasUsed), tp.Credits,
		tp.Status, tp.Reason, refund, tp.At, tp.At, creditedAt(tp))
	if err != nil {
		return tp, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 { // already recorded (another report, or the scanner)
		if user == "" {
			return tp, false, nil
		}
		// Recorded before the sender was known: this player's wallet sent it, so it is theirs now. It counts against
		// the daily cap from now (credited_at), whenever it arrived (created_at stays when it was first recorded).
		// Not once it was refunded (the back office marks a refunded unknown row "rejected" too).
		claim, err := t.Exec(`UPDATE topups SET user_id = ?, status = ?, usd_cents = ?, fee = ?, credits = ?, reason = ?,
			refund_cents = ?, updated_at = ?, credited_at = ? WHERE tx = ? AND log_index = ? AND user_id = '' AND status = 'unknown'
			AND refunded_at = 0 AND lower(sender) = lower(?)`,
			user, tp.Status, tp.USDCents, tp.Fee, tp.Credits, tp.Reason, refund, tp.At, creditedAt(tp), tp.Tx, tp.LogIndex, tr.From)
		if err != nil {
			return tp, false, err
		}
		if n, _ := claim.RowsAffected(); n == 0 {
			return tp, false, nil
		}
	}
	if tp.Status == "credited" {
		if err := creditLedger(t, user, tp.Credits, "topup", "", tp.Tx); err != nil {
			return tp, false, err
		}
		if err := platformLedger(t, toCredits(tp.Fee), "fee", tp.Tx, fmt.Sprintf("%d%% of %d cents", game.payments.Topup.FeePercent, tp.USDCents)); err != nil {
			return tp, false, err
		}
	}
	return tp, true, t.Commit()
}

// creditedAt: when a row is credited (now), 0 while it isn't.
func creditedAt(tp Topup) int64 {
	if tp.Status == "credited" {
		return tp.At
	}
	return 0
}

// topupRoom: how many cents this player may still be credited: payments.json's caps over 24 h (by when each
// top-up was credited, not when it arrived) and in total.
func topupRoom(t *sql.Tx, user string, now time.Time) (int64, error) {
	var day, total int64
	if err := t.QueryRow(`SELECT COALESCE(SUM(CASE WHEN credited_at > ? THEN usd_cents END), 0), COALESCE(SUM(usd_cents), 0)
		FROM topups WHERE user_id = ? AND status = 'credited'`, now.Unix()-86400, user).Scan(&day, &total); err != nil {
		return 0, err
	}
	p := game.payments.Topup
	return max(0, min(p.CapUSDPerDay*100-day, p.CapUSDTotal*100-total)), nil
}

// toCredits: cents of USD as credits (payments.json: 100 credits = $1, so 1 cent = 1 credit today).
func toCredits(cents int64) int64 { return cents * int64(game.payments.CreditsPerUSD) / 100 }

// TopupSums: what a player has topped up (credited), in cents: in the last 24 h and in total. The web keeps the
// payments.json caps with these.
type TopupSums struct {
	Day   int64 `json:"day"`
	Total int64 `json:"total"`
}

// Topups: the player's credits, what they topped up, and their last 20 top-ups.
func (s *store) Topups(ctx context.Context, user string, now time.Time) (credits int64, sums TopupSums, list []Topup, err error) {
	if err = s.db.QueryRowContext(ctx, `SELECT credits FROM users WHERE id = ?`, user).Scan(&credits); err != nil {
		return
	}
	if err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN credited_at > ? THEN usd_cents END), 0),
		COALESCE(SUM(usd_cents), 0) FROM topups WHERE user_id = ? AND status = 'credited'`,
		now.Unix()-86400, user).Scan(&sums.Day, &sums.Total); err != nil {
		return
	}
	rows, err := s.db.QueryContext(ctx, `SELECT tx, log_index, token, usd_cents, fee, credits, status, reason, created_at
		FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 20`, user)
	if err != nil {
		return
	}
	defer rows.Close()
	list = []Topup{}
	for rows.Next() {
		var tp Topup
		if err = rows.Scan(&tp.Tx, &tp.LogIndex, &tp.Token, &tp.USDCents, &tp.Fee, &tp.Credits, &tp.Status, &tp.Reason, &tp.At); err != nil {
			return
		}
		list = append(list, tp)
	}
	return credits, sums, list, rows.Err()
}

// playerByWallet: the player whose stored embedded wallet sent a transfer ("" when none, or when that player is
// banned: as on POST /api/topups, a banned player isn't credited; the transfer stays "unknown" for the back office).
func (s *store) playerByWallet(ctx context.Context, wallet string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE lower(wallet_address) = ? AND wallet_address != ''
		AND banned = 0 ORDER BY created_at LIMIT 1`, strings.ToLower(wallet)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// ---------- the endpoint ----------

// topupEvery: how often one player may report a tx (each report costs several rpc calls; the web asks every 5 s).
var topupEvery = 2 * time.Second

// The rpcs are paid and shared with the scanner and reconciliation, so what one player can make them spend on
// hashes that aren't their top-ups is bounded. A "miss" is every report whose receipt the rpcs could not show to
// hold a USDC/USDT transfer from the player's wallet to the Agentic Wallet: no such transaction (yet), a failed
// one, someone else's (final or not), and any rpc error (a receipt too big to read, a mismatch, a provider down).
// A player gets topupMissBudget misses per topupMissWindow; past it they get 429 too_many_misses until old misses
// age out (the scanner still credits a real transfer meanwhile). The player's own transfer is in its receipt from
// the block it lands in, before it is final, so re-reporting it while it confirms (202) is never a miss. A settled
// refusal (tx_failed, not_a_topup) is remembered for the window and answered again without the rpcs. Stale entries
// are swept once per window, and sooner when the maps double. Not player-facing: constants.
const (
	topupMissBudget = 20               // misses per player per window (a just-sent transfer misses only for a few seconds)
	topupMissWindow = 10 * time.Minute // how long a miss, and a remembered refusal, counts
	topupGuardSweep = 10_000           // entries that trigger an early sweep (never everyone's: only stale ones)
)

type topupRefusal struct {
	code int
	err  string
	at   time.Time
}

// topupGuard: the per-player pace, misses and remembered refusals of POST /api/topups, in memory (one api).
type topupGuard struct {
	mu      sync.Mutex
	last    map[string]time.Time    // player → last report
	misses  map[string][]time.Time  // player → their misses within the window
	settled map[string]topupRefusal // player|tx → a settled refusal
	sweepAt int                     // the size that triggers the next sweep
	sweptAt time.Time               // the last sweep (one is due every topupMissWindow)
	every   time.Duration           // the pace last asked for
}

func newTopupGuard() *topupGuard {
	return &topupGuard{last: map[string]time.Time{}, misses: map[string][]time.Time{},
		settled: map[string]topupRefusal{}, sweepAt: topupGuardSweep, sweptAt: time.Now()}
}

// tooSoon: whether id reported less than every ago; if not, this report is the new last one.
func (g *topupGuard) tooSoon(id string, now time.Time, every time.Duration) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if t, ok := g.last[id]; ok && now.Sub(t) < every {
		return true
	}
	g.last[id], g.every = now, every
	if len(g.last)+len(g.misses)+len(g.settled) > g.sweepAt || now.Sub(g.sweptAt) >= topupMissWindow {
		g.sweep(now)
	}
	return false
}

// refused: a remembered refusal of this tx for id, if any.
func (g *topupGuard) refused(id, tx string, now time.Time) (topupRefusal, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	r, ok := g.settled[id+"|"+strings.ToLower(tx)]
	return r, ok && now.Sub(r.at) < topupMissWindow
}

// spent: whether id has used up their misses.
func (g *topupGuard) spent(id string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.misses[id] = recent(g.misses[id], now)
	if len(g.misses[id]) == 0 {
		delete(g.misses, id)
	}
	return len(g.misses[id]) >= topupMissBudget
}

// miss counts a report that wasn't id's top-up.
func (g *topupGuard) miss(id string, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.misses[id] = append(recent(g.misses[id], now), now)
}

// refuse remembers a settled refusal (it is a miss too).
func (g *topupGuard) refuse(id, tx string, code int, err string, now time.Time) {
	g.miss(id, now)
	g.mu.Lock()
	defer g.mu.Unlock()
	g.settled[id+"|"+strings.ToLower(tx)] = topupRefusal{code: code, err: err, at: now}
}

// sweep drops what no longer counts (g.mu held). Its cost is paid back by the doubling and the window: sweeps stay
// rare.
func (g *topupGuard) sweep(now time.Time) {
	g.sweptAt = now
	for id, t := range g.last {
		if now.Sub(t) >= g.every {
			delete(g.last, id)
		}
	}
	for id, ms := range g.misses {
		if ms = recent(ms, now); len(ms) == 0 {
			delete(g.misses, id)
		} else {
			g.misses[id] = ms
		}
	}
	for k, r := range g.settled {
		if now.Sub(r.at) >= topupMissWindow {
			delete(g.settled, k)
		}
	}
	g.sweepAt = max(topupGuardSweep, 2*(len(g.last)+len(g.misses)+len(g.settled)))
}

// recent: the times within the miss window (oldest first, as appended).
func recent(ts []time.Time, now time.Time) []time.Time {
	i := 0
	for i < len(ts) && now.Sub(ts[i]) >= topupMissWindow {
		i++
	}
	return ts[i:]
}

func (pl *players) routeTopups(mux *http.ServeMux) {
	guard := newTopupGuard()
	answer := func(w http.ResponseWriter, r *http.Request, id string, extra map[string]any) {
		c, sums, list, err := pl.db.Topups(r.Context(), id, time.Now())
		if err != nil {
			fail(w, err)
			return
		}
		out := map[string]any{"credits": c, "topped": sums, "topups": list}
		for k, v := range extra {
			out[k] = v
		}
		writeJSON(w, http.StatusOK, out)
	}
	mux.HandleFunc("GET /api/topups", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			if _, err := pl.db.Get(r.Context(), id); err != nil { // a first-time player has a row (0 credits)
				fail(w, err)
				return
			}
			answer(w, r, id, nil)
		}
	})
	mux.HandleFunc("POST /api/topups", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct{ Tx string }
		if !ok || !body(w, r, &in) {
			return
		}
		if !hashRe.MatchString(in.Tx) {
			fail(w, errBad)
			return
		}
		if pl.chain == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
			return
		}
		if why, _ := pl.db.Paused(r.Context()); why != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "paused"})
			return
		}
		now := time.Now()
		if guard.tooSoon(id, now, topupEvery) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_soon"})
			return
		}
		if r, ok := guard.refused(id, in.Tx, now); ok { // settled already: no rpc calls
			writeJSON(w, r.code, map[string]string{"error": r.err})
			return
		}
		if guard.spent(id, now) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_many_misses"})
			return
		}
		// The sender to match: the embedded wallet Privy reports for this player, read server-side.
		me, err := pl.auth.user(id, time.Now())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth_unavailable"})
			return
		}
		if !addrRe.MatchString(me.Wallet) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no_wallet"})
			return
		}
		if _, err := pl.db.Get(r.Context(), id); err != nil { // the player's row exists before credits land on it
			fail(w, err)
			return
		}
		_ = pl.db.SetIdentity(r.Context(), id, me.Email, me.Wallet, time.Now())
		rc, err := pl.chain.Final(r.Context(), in.Tx)
		switch {
		case errors.Is(err, errTxFailed):
			guard.refuse(id, in.Tx, http.StatusUnprocessableEntity, "tx_failed", now)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "tx_failed"})
			return
		case err != nil:
			// Not final, or not read. Final hands back the receipt both rpcs agreed on whenever there was one: the
			// player's own transfer is in it before it is final, so only that is spared; anything else is a miss.
			if !errors.Is(err, errUnconfirmed) && !errors.Is(err, errNoTx) {
				slog.Warn("topup: bsc", "tx", in.Tx, "err", err)
			}
			if rc.Tx == "" || len(topupsFrom(rc, me.Wallet)) == 0 {
				guard.miss(id, now)
			}
			if errors.Is(err, errUnconfirmed) || errors.Is(err, errNoTx) { // still confirming, or not seen yet
				writeJSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
			} else {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chain_unavailable"})
			}
			return
		}
		mine := topupsFrom(rc, me.Wallet)
		if len(mine) == 0 { // no USDC/USDT from this player's wallet to the platform in that transaction
			guard.refuse(id, in.Tx, http.StatusUnprocessableEntity, "not_a_topup", now)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "not_a_topup"})
			return
		}
		for _, tr := range mine {
			if _, _, err := pl.db.recordTopup(r.Context(), tr, rc.GasUsed, id, time.Now()); err != nil {
				fail(w, err)
				return
			}
		}
		// The answer comes from this player's rows for the tx: credited (in full or up to the caps) or rejected.
		var credited, rejected int
		if err := pl.db.db.QueryRowContext(r.Context(), `SELECT COUNT(CASE WHEN status = 'credited' THEN 1 END),
			COUNT(CASE WHEN status = 'rejected' THEN 1 END) FROM topups WHERE tx = ? AND user_id = ?`,
			strings.ToLower(in.Tx), id).Scan(&credited, &rejected); err != nil {
			fail(w, err)
			return
		}
		switch {
		case credited+rejected != len(mine):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "not_yours"})
		case credited == 0:
			answer(w, r, id, map[string]any{"status": "rejected"})
		default:
			answer(w, r, id, map[string]any{"status": "credited"})
		}
	})
}

// topupsFrom: the USDC/USDT transfers in a receipt from wallet to the Agentic Wallet (none when a Transfer log is
// malformed or the transaction failed).
func topupsFrom(rc Receipt, wallet string) []Transfer {
	var mine []Transfer
	for _, token := range game.payments.Topup.Tokens {
		trs, err := transfersIn(rc, token)
		if err != nil {
			return nil
		}
		for _, tr := range trs {
			if strings.EqualFold(tr.To, game.payments.AgenticWallet) && strings.EqualFold(tr.From, wallet) {
				mine = append(mine, tr)
			}
		}
	}
	return mine
}

// ---------- the scanner ----------

const scanKey = "topup_scan_block" // settings: the last block the scanner read
const scanSpan = 500               // blocks per read at most; halved while a provider refuses the range

// scanSkipsPerPass: how many single blocks one pass may move past unread (scan_retries). Anyone can make a block's
// logs unreadable (≈10k zero-value transfers to the Agentic Wallet), and both providers answering garbage for a while
// looks the same, so one pass doesn't skip a whole outage: past this many, the pass stops and the next one goes on.
const scanSkipsPerPass = 5

// scanRetryMax: how many times what the scanner couldn't read is read in all (the first time included) before it is
// left to the back office ("given_up"). Retries wait 0, 1, 2, 4 … 128 minutes: about 4 h in all.
const scanRetryMax = 10

// scanRetriesPerPass: the oldest open retries read per pass at most.
const scanRetriesPerPass = 20

// unanswerable: both rpcs answered, and neither answer can be used (too big, malformed, or a JSON-RPC error). The
// request itself is the problem, not a provider that is down.
func unanswerable(err error) bool { return errors.Is(err, errUnreadable) || errors.Is(err, errRefused) }

// scanTopups credits transfers to the Agentic Wallet that no browser reported (closed tab, lost network), from
// the last scanned block up to the newest final one. The first pass starts at the chain's tip: history before
// the scanner ran is reported by players, not replayed. The cursor only moves past blocks that were read and
// recorded in full, or that can't be read at all (one block whose logs both rpcs refuse: recorded in scan_retries,
// read again later), so a provider that is down never skips a transfer and no single block wedges the scanner.
// Each pass first reads again what earlier passes couldn't.
func (s *store) scanTopups(ctx context.Context, c *bsc, now time.Time) error {
	safe, err := c.SafeHead(ctx)
	if err != nil || safe == 0 {
		return err
	}
	var v string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, scanKey).Scan(&v); errors.Is(err, sql.ErrNoRows) {
		return s.setScanned(ctx, safe, now)
	} else if err != nil {
		return err
	}
	last, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return err
	}
	if err := s.retryScans(ctx, c, now); err != nil { // never stops the scan: retried next pass
		slog.Warn("topup scan: retries", "err", err)
	}
	span, skips := uint64(scanSpan), 0
	for last < safe {
		to := min(safe, last+span)
		err := s.scanRange(ctx, c, last+1, to, &skips, now)
		if err != nil {
			if span == 1 || ctx.Err() != nil {
				return err
			}
			span /= 2 // a provider caps ranges or result sizes: read less at once
			continue
		}
		if err := s.setScanned(ctx, to, now); err != nil {
			return err
		}
		last = to
		span = min(scanSpan, span*2) // past a hard block: back to full ranges
	}
	return nil
}

// scanRange records every transfer to the Agentic Wallet in blocks [from, to]. One transaction never stops it: a
// zero-value transfer (anyone can emit one from any address) is skipped, a player's transfer whose receipt can't be
// read (both rpcs refuse it) is recorded for the back office without credits and read again later, and a transfer
// from anyone else is never read further than its log: it is owed back in full, unless the Agentic Wallet itself
// paid stablecoin out in the same tx (a swap's change: the platform's own money). Whether it did is one eth_getLogs
// per token for the whole range, read once, and only when such a transfer shows up. One block whose logs for a token
// both rpcs refuse is recorded in scan_retries and passed (up to scanSkipsPerPass a pass). A provider that is down
// still stops the scan, so nothing is skipped by an outage.
func (s *store) scanRange(ctx context.Context, c *bsc, from, to uint64, skips *int, now time.Time) error {
	var paidOut map[string]bool // txs in the range in which the Agentic Wallet sent stablecoin out; nil until read
	skipped := false            // this block counted against the pass's skips already
	for _, token := range game.payments.Topup.Tokens {
		trs, err := c.TransfersTo(ctx, token, game.payments.AgenticWallet, from, to)
		if err != nil {
			if from != to || !unanswerable(err) || (!skipped && *skips >= scanSkipsPerPass) {
				return err
			}
			if !skipped {
				skipped = true
				*skips++
			}
			if err := s.scanSkipped(ctx, "logs", strings.ToLower(token), from, err, now); err != nil {
				return err
			}
			continue
		}
		if err := s.scanTransfers(ctx, c, trs, from, to, &paidOut, now); err != nil {
			return err
		}
	}
	return nil
}

// scanTransfers records the transfers to the Agentic Wallet read from blocks [from, to] (see scanRange).
func (s *store) scanTransfers(ctx context.Context, c *bsc, trs []Transfer, from, to uint64, paidOut *map[string]bool, now time.Time) error {
	for _, tr := range trs {
		if tr.Amount == nil || tr.Amount.Sign() == 0 { // nothing arrived: nothing to credit or refund
			continue
		}
		var known int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM topups WHERE tx = ? AND log_index = ?`,
			tr.Tx, tr.LogIndex).Scan(&known); err != nil {
			return err
		}
		if known > 0 {
			continue
		}
		user, err := s.playerByWallet(ctx, tr.From)
		if err != nil {
			return err
		}
		var gas uint64
		change := false
		if user != "" { // the receipt costs two rpc calls: only for a player's top-up (its gas is recorded)
			rc, err := scanReceipt(ctx, c, tr)
			if unanswerable(err) {
				if err := s.recordUnreadable(ctx, tr, err, now); err != nil {
					return err
				}
				continue
			}
			if err != nil {
				return err
			}
			gas = rc.GasUsed
		} else {
			if *paidOut == nil {
				if *paidOut, err = walletPaidOut(ctx, c, from, to); err != nil {
					// Anyone can make this answer huge (transferFrom(agenticWallet, x, 0) needs no allowance), so it
					// must not stop the scan: strangers' transfers here are owed in full. Safe: a swap's change is
					// zeroed when the swap is booked as a restock (VerifiedRestock).
					slog.Warn("topup scan: the wallet's payouts can't be read; strangers' transfers owed in full",
						"from", from, "to", to, "err", err)
					*paidOut = map[string]bool{}
				}
			}
			change = (*paidOut)[strings.ToLower(tr.Tx)]
		}
		if _, _, err := s.recordTransfer(ctx, tr, gas, user, change, now); err != nil {
			return err
		}
	}
	return nil
}

// errReceiptMismatch: a scanned transfer's receipt says the tx failed or sits in another block.
var errReceiptMismatch = errors.New("topup scan: the transfer does not match its receipt")

// scanReceipt: the receipt of a scanned transfer, checked against it. unanswerable when both rpcs refuse it (the
// caller records the transfer with recordUnreadable and moves on); any other error stops the scan.
func scanReceipt(ctx context.Context, c *bsc, tr Transfer) (Receipt, error) {
	rc, err := c.Receipt(ctx, tr.Tx)
	if err != nil {
		return rc, err
	}
	if !rc.OK || rc.Block != tr.Block {
		return rc, fmt.Errorf("%w: %s", errReceiptMismatch, tr.Tx)
	}
	return rc, nil
}

// unreadableReason: the reason of a top-up row whose receipt couldn't be read (the back office's Payments shows it).
const unreadableReason = "unreadable receipt (too big, malformed or refused by both rpcs): not credited yet, read again for a while, then for the back office"

// recordUnreadable records a transfer whose receipt can't be read as "unknown" with no user and no credits, owed
// back in full, the reason saying why, and puts its receipt in scan_retries: later passes read it again and credit
// the player if it reads (or the player's own report claims it). Nothing changes if the transfer is recorded already.
func (s *store) recordUnreadable(ctx context.Context, tr Transfer, why error, now time.Time) error {
	if tr.Amount == nil || tr.Amount.Sign() < 0 {
		return errBad
	}
	cents := usdCents(tr.Amount)
	if cents < 0 {
		return errBad
	}
	slog.Warn("topup scan: unreadable receipt, recorded for the back office", "tx", tr.Tx, "err", why)
	return s.inTx(ctx, func(t *sql.Tx) error {
		// Owed back in full (refund_cents) until it is credited or refunded: reconciliation counts it as owed.
		if _, err := t.Exec(`INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents,
			status, reason, refund_cents, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
			ON CONFLICT (tx, log_index) DO NOTHING`,
			strings.ToLower(tr.Tx), int64(tr.LogIndex), tr.From, tr.Token, tr.Amount.String(), cents,
			unreadableReason, cents, now.Unix(), now.Unix()); err != nil {
			return err
		}
		return scanSkippedIn(t, "receipt", strings.ToLower(tr.Tx), tr.Block, why, now)
	})
}

// scanSkipped records what the scanner moved past unread (a block's logs for one token, or a receipt), once.
func (s *store) scanSkipped(ctx context.Context, kind, ref string, block uint64, why error, now time.Time) error {
	slog.Warn("topup scan: moved past what can't be read; recorded for the back office and read again later",
		"kind", kind, "ref", ref, "block", block, "err", why)
	return s.inTx(ctx, func(t *sql.Tx) error { return scanSkippedIn(t, kind, ref, block, why, now) })
}

func scanSkippedIn(t *sql.Tx, kind, ref string, block uint64, why error, now time.Time) error {
	_, err := t.Exec(`INSERT INTO scan_retries (kind, ref, block, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, ref, block) DO NOTHING`, kind, ref, int64(block), shortErr(why), now.Unix(), now.Unix())
	return err
}

// shortErr: an error's text cut to fit a row (a joined rpc error can be long).
func shortErr(err error) string {
	msg := strings.ReplaceAll(err.Error(), "\n", "; ")
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	return msg
}

// scanRetryDue: when an open retry with this many reads behind it may be read again: right away after the first,
// then 1, 2, 4 … minutes after the last.
func scanRetryDue(attempts int, last int64) int64 {
	if attempts <= 1 {
		return last
	}
	return last + int64(60)<<min(attempts-2, 20)
}

// retryScans reads again what earlier passes couldn't (scan_retries "open"), oldest first, at most
// scanRetriesPerPass a pass. What reads now is recorded like any scanned transfer ("done"); what both rpcs still
// refuse counts a read, up to scanRetryMax ("given_up": the back office's). Any other error (a provider down, the
// payments pause) ends this pass's retries without counting: they go on next pass.
func (s *store) retryScans(ctx context.Context, c *bsc, now time.Time) error {
	type retry struct {
		kind, ref string
		block     uint64
		attempts  int
		updated   int64
	}
	rows, err := s.db.QueryContext(ctx, `SELECT kind, ref, block, attempts, updated_at FROM scan_retries
		WHERE status = 'open' ORDER BY updated_at, block LIMIT ?`, scanRetriesPerPass)
	if err != nil {
		return err
	}
	var open []retry
	for rows.Next() {
		var r retry
		var block int64
		if err := rows.Scan(&r.kind, &r.ref, &block, &r.attempts, &r.updated); err != nil {
			rows.Close()
			return err
		}
		r.block = uint64(block)
		open = append(open, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range open {
		if now.Unix() < scanRetryDue(r.attempts, r.updated) {
			continue
		}
		var err error
		if r.kind == "logs" {
			err = s.retryLogs(ctx, c, r.ref, r.block, now)
		} else {
			err = s.retryReceipt(ctx, c, r.ref, r.block, now)
		}
		switch {
		case err == nil:
			_, err = s.db.ExecContext(ctx, `UPDATE scan_retries SET status = 'done', attempts = attempts + 1, updated_at = ?
				WHERE kind = ? AND ref = ? AND block = ?`, now.Unix(), r.kind, r.ref, int64(r.block))
		case unanswerable(err) || errors.Is(err, errReceiptMismatch):
			_, err = s.db.ExecContext(ctx, `UPDATE scan_retries SET attempts = attempts + 1, reason = ?, updated_at = ?,
				status = CASE WHEN attempts + 1 >= ? THEN 'given_up' ELSE 'open' END
				WHERE kind = ? AND ref = ? AND block = ?`, shortErr(err), now.Unix(), scanRetryMax, r.kind, r.ref, int64(r.block))
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// retryLogs reads one block's transfers of token to the Agentic Wallet again and records them.
func (s *store) retryLogs(ctx context.Context, c *bsc, token string, block uint64, now time.Time) error {
	trs, err := c.TransfersTo(ctx, token, game.payments.AgenticWallet, block, block)
	if err != nil {
		return err
	}
	var paidOut map[string]bool
	return s.scanTransfers(ctx, c, trs, block, block, &paidOut, now)
}

// retryReceipt reads a receipt the scanner couldn't again and records its players' transfers to the Agentic Wallet:
// the rows recorded "unknown" for it are claimed and credited (or rejected over the caps), like a report would. A
// transfer whose sender is no player any more stays "unknown", owed back.
func (s *store) retryReceipt(ctx context.Context, c *bsc, tx string, block uint64, now time.Time) error {
	rc, err := c.Receipt(ctx, tx)
	if err != nil {
		return err
	}
	if !rc.OK || rc.Block != block {
		return fmt.Errorf("%w: %s", errReceiptMismatch, tx)
	}
	for _, token := range game.payments.Topup.Tokens {
		trs, err := transfersIn(rc, token)
		if err != nil {
			return fmt.Errorf("%w: %w", errReceiptMismatch, err)
		}
		for _, tr := range trs {
			if !strings.EqualFold(tr.To, game.payments.AgenticWallet) || tr.Amount == nil || tr.Amount.Sign() == 0 {
				continue
			}
			user, err := s.playerByWallet(ctx, tr.From)
			if err != nil {
				return err
			}
			if user == "" {
				continue
			}
			if _, _, err := s.recordTransfer(ctx, tr, rc.GasUsed, user, false, now); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *store) setScanned(ctx context.Context, block uint64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		scanKey, strconv.FormatUint(block, 10), now.Unix())
	return err
}

// scanTopupsEvery runs the scanner until ctx ends.
func (s *store) scanTopupsEvery(ctx context.Context, c *bsc, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		if err := s.scanTopups(ctx, c, time.Now()); err != nil {
			slog.Warn("topup scan", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// walletPaidOut: the txs in blocks [from, to] in which the Agentic Wallet sent a positive amount of USDC/USDT to
// someone else. A zero amount doesn't count: anyone can call transferFrom(agenticWallet, x, 0) without an
// allowance (BEP20), which logs a "payout" the wallet never made.
func walletPaidOut(ctx context.Context, c *bsc, from, to uint64) (map[string]bool, error) {
	out := map[string]bool{}
	for _, stable := range game.payments.Topup.Tokens {
		trs, err := c.TransfersFrom(ctx, stable, game.payments.AgenticWallet, from, to)
		if err != nil {
			return nil, err
		}
		for _, tr := range trs {
			if tr.Amount != nil && tr.Amount.Sign() > 0 && !strings.EqualFold(tr.To, game.payments.AgenticWallet) {
				out[strings.ToLower(tr.Tx)] = true
			}
		}
	}
	return out, nil
}
