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
// No refunds and no server-side limits on what arrived: money a known player sent is credited in full (the
// minimum and the caps in payments.json are kept by the web before it sends). Senders that are no player's
// wallet are recorded as "unknown" for the back office, without credits.

type Topup struct {
	Tx       string `json:"tx"`
	LogIndex int64  `json:"logIndex"`
	Token    string `json:"token"`
	USDCents int64  `json:"usdCents"`
	Fee      int64  `json:"fee"`
	Credits  int64  `json:"credits"`
	Status   string `json:"status"`
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
	if !topupToken(tr.Token) || !strings.EqualFold(tr.To, game.payments.AgenticWallet) || tr.Amount == nil || tr.Amount.Sign() < 0 {
		return tp, false, errBad
	}
	cents := usdCents(tr.Amount)
	if cents < 0 {
		return tp, false, errBad
	}
	tp = Topup{Tx: strings.ToLower(tr.Tx), LogIndex: int64(tr.LogIndex), Token: tr.Token, USDCents: cents,
		Status: "unknown", At: now.Unix()}
	if user != "" {
		tp.Status, tp.Fee = "credited", topupFee(cents)
		tp.Credits = toCredits(cents - tp.Fee)
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return tp, false, err
	}
	defer t.Rollback()
	res, err := t.Exec(`INSERT INTO topups (tx, log_index, user_id, sender, token, amount, usd_cents, fee, gas_used, credits,
		status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (tx, log_index) DO NOTHING`,
		tp.Tx, tp.LogIndex, user, tr.From, tp.Token, tr.Amount.String(), cents, tp.Fee, int64(gasUsed), tp.Credits,
		tp.Status, tp.At, tp.At)
	if err != nil {
		return tp, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 { // already recorded (another report, or the scanner)
		if user == "" {
			return tp, false, nil
		}
		// Recorded before the sender was known: this player's wallet sent it, so it is theirs now.
		claim, err := t.Exec(`UPDATE topups SET user_id = ?, status = 'credited', fee = ?, credits = ?, updated_at = ?
			WHERE tx = ? AND log_index = ? AND user_id = '' AND status = 'unknown' AND lower(sender) = lower(?)`,
			user, tp.Fee, tp.Credits, tp.At, tp.Tx, tp.LogIndex, tr.From)
		if err != nil {
			return tp, false, err
		}
		if n, _ := claim.RowsAffected(); n == 0 {
			return tp, false, nil
		}
	}
	if user != "" {
		if err := creditLedger(t, user, tp.Credits, "topup", "", tp.Tx); err != nil {
			return tp, false, err
		}
		if err := platformLedger(t, toCredits(tp.Fee), "fee", tp.Tx, fmt.Sprintf("%d%% of %d cents", game.payments.Topup.FeePercent, cents)); err != nil {
			return tp, false, err
		}
	}
	return tp, true, t.Commit()
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
	if err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN created_at > ? THEN usd_cents END), 0),
		COALESCE(SUM(usd_cents), 0) FROM topups WHERE user_id = ? AND status = 'credited'`,
		now.Unix()-86400, user).Scan(&sums.Day, &sums.Total); err != nil {
		return
	}
	rows, err := s.db.QueryContext(ctx, `SELECT tx, log_index, token, usd_cents, fee, credits, status, created_at
		FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 20`, user)
	if err != nil {
		return
	}
	defer rows.Close()
	list = []Topup{}
	for rows.Next() {
		var tp Topup
		if err = rows.Scan(&tp.Tx, &tp.LogIndex, &tp.Token, &tp.USDCents, &tp.Fee, &tp.Credits, &tp.Status, &tp.At); err != nil {
			return
		}
		list = append(list, tp)
	}
	return credits, sums, list, rows.Err()
}

// playerByWallet: the player whose stored embedded wallet sent a transfer ("" when none).
func (s *store) playerByWallet(ctx context.Context, wallet string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE lower(wallet_address) = ? AND wallet_address != ''
		ORDER BY created_at LIMIT 1`, strings.ToLower(wallet)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// ---------- the endpoint ----------

// topupEvery: how often one player may report a tx (each report costs several rpc calls; the web asks every 5 s).
var topupEvery = 2 * time.Second

func (pl *players) routeTopups(mux *http.ServeMux) {
	var mu sync.Mutex
	last := map[string]time.Time{}
	tooSoon := func(id string, now time.Time) bool {
		mu.Lock()
		defer mu.Unlock()
		if now.Sub(last[id]) < topupEvery {
			return true
		}
		if len(last) > 10_000 { // forget everyone now and then; the window is seconds
			clear(last)
		}
		last[id] = now
		return false
	}
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
		if tooSoon(id, time.Now()) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_soon"})
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
		case errors.Is(err, errUnconfirmed) || errors.Is(err, errNoTx):
			writeJSON(w, http.StatusAccepted, map[string]string{"status": "pending"}) // not final yet: ask again
			return
		case errors.Is(err, errTxFailed):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "tx_failed"})
			return
		case err != nil:
			slog.Warn("topup: bsc", "tx", in.Tx, "err", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chain_unavailable"})
			return
		}
		var mine []Transfer
		for _, token := range game.payments.Topup.Tokens {
			trs, err := transfersIn(rc, token)
			if err != nil {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "not_a_topup"})
				return
			}
			for _, tr := range trs {
				if strings.EqualFold(tr.To, game.payments.AgenticWallet) && strings.EqualFold(tr.From, me.Wallet) {
					mine = append(mine, tr)
				}
			}
		}
		if len(mine) == 0 { // no USDC/USDT from this player's wallet to the platform in that transaction
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "not_a_topup"})
			return
		}
		for _, tr := range mine {
			if _, _, err := pl.db.recordTopup(r.Context(), tr, rc.GasUsed, id, time.Now()); err != nil {
				fail(w, err)
				return
			}
		}
		// "credited" only when this player's rows for the tx say so.
		var credited int
		if err := pl.db.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM topups WHERE tx = ? AND user_id = ?
			AND status = 'credited'`, strings.ToLower(in.Tx), id).Scan(&credited); err != nil {
			fail(w, err)
			return
		}
		if credited != len(mine) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "not_yours"})
			return
		}
		answer(w, r, id, map[string]any{"status": "credited"})
	})
}

// ---------- the scanner ----------

const scanKey = "topup_scan_block" // settings: the last block the scanner read
const scanSpan = 500               // blocks per read at most; halved while a provider refuses the range

// scanTopups credits transfers to the Agentic Wallet that no browser reported (closed tab, lost network), from
// the last scanned block up to the newest final one. The first pass starts at the chain's tip: history before
// the scanner ran is reported by players, not replayed. The cursor only moves past blocks that were read and
// recorded in full, so an error never skips a transfer.
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
	span := uint64(scanSpan)
	for last < safe {
		to := min(safe, last+span)
		err := s.scanRange(ctx, c, last+1, to, now)
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
	}
	return nil
}

// scanRange records every transfer to the Agentic Wallet in blocks [from, to].
func (s *store) scanRange(ctx context.Context, c *bsc, from, to uint64, now time.Time) error {
	for _, token := range game.payments.Topup.Tokens {
		trs, err := c.TransfersTo(ctx, token, game.payments.AgenticWallet, from, to)
		if err != nil {
			return err
		}
		for _, tr := range trs {
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
			if user != "" { // the receipt costs two rpc calls: only for a player's top-up (its gas is recorded)
				rc, err := c.Receipt(ctx, tr.Tx)
				if err != nil {
					return err
				}
				if !rc.OK || rc.Block != tr.Block {
					return fmt.Errorf("topup scan: %s does not match its receipt", tr.Tx)
				}
				gas = rc.GasUsed
			}
			if _, _, err := s.recordTopup(ctx, tr, gas, user, now); err != nil {
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
