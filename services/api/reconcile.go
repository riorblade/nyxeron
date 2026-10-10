package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Reconciliation (docs/payments.md): every hour, prove from BSC that the money in the game is real.
//
//  1. Credits are backed: Σ players' credits (held ones included) + money owed back to senders (unknown, rejected
//     and over-cap top-ups not yet refunded) ≤ USDC + USDT in the Agentic Wallet − the platform's own money (fees,
//     wholesale, seed, restocks; platform_ledger). In cents (1 credit = 1 cent). Money owed back is in the wallet
//     but belongs to its senders: counted as backing, it would hide credits nobody paid for.
//  2. Units are backed, per whitelisted token: warehouse + reserved + players' real units ≤ the wallet's bStock,
//     in units of payments.json's sharesPerUnit.
//
// A mismatch pauses top-ups, sales and restocks (errPaused) and shows in the back office; the next check that
// matches resumes them. A check that can't read BSC changes nothing (it can't prove anything either way). Every
// result is kept in the audit log ("reconcile"), which is the history the back office shows.

var (
	errPaused  = errors.New("payments are paused: the last reconciliation didn't match")
	errNoTopup = errors.New("no such top-up")
)

const pauseKey = "payments_paused" // settings: present while paused, with the problems found

type Recon struct {
	At             int64             `json:"at"`
	OK             bool              `json:"ok"`
	OwedCents      int64             `json:"owedCents"`     // players' credits incl. held, in cents
	WalletCents    int64             `json:"walletCents"`   // USDC + USDT in the Agentic Wallet, in cents
	PlatformCents  int64             `json:"platformCents"` // the platform's own money in that wallet
	RefundCents    int64             `json:"refundCents"`   // owed back to senders, not refunded yet
	Units          map[string]Backed `json:"units"`         // per whitelisted token
	Problems       []string          `json:"problems"`
	walletReadings map[string]string // raw balances, for the record
}

type Backed struct {
	Counted int64 `json:"counted"` // warehouse + reserved + players' real units
	OnChain int64 `json:"onChain"` // the wallet's bStock, in units
}

// Reconcile runs both checks and pauses or resumes payments accordingly. actor/reason: who asked and why ("system",
// "hourly" for the job; an admin's "Check now" carries their own).
func (s *store) Reconcile(ctx context.Context, c *bsc, actor, reason string, now time.Time) (Recon, error) {
	r := Recon{At: now.Unix(), Units: map[string]Backed{}, Problems: []string{}, walletReadings: map[string]string{}}
	if c == nil {
		return r, errNotConfigured
	}
	// From BSC first (two rpcs), then the books in one read.
	for name, token := range game.payments.Topup.Tokens {
		bal, err := c.BalanceOf(ctx, token, game.payments.AgenticWallet)
		if err != nil {
			return r, err
		}
		r.WalletCents += usdCents(bal)
		r.walletReadings[name] = bal.String()
	}
	onChain := map[string]*big.Int{}
	for id, t := range game.payments.Tokens {
		bal, err := c.BalanceOf(ctx, t.Contract, game.payments.AgenticWallet)
		if err != nil {
			return r, err
		}
		onChain[id] = bal
	}
	var owedCredits, platformCredits int64
	// Owed back: not in a tx the platform booked (a restock's or seed's stablecoin coming back, e.g. a router's
	// change, is already netted in platform_ledger).
	if err := s.db.QueryRowContext(ctx, `SELECT
		COALESCE((SELECT SUM(credits) FROM users), 0) +
		COALESCE((SELECT SUM(price * qty) FROM sales WHERE status = 'held'), 0),
		COALESCE((SELECT SUM(delta) FROM platform_ledger), 0),
		COALESCE((SELECT SUM(refund_cents) FROM topups WHERE refunded_at = 0 AND tx NOT IN `+bookedTxs+`), 0)`).Scan(&owedCredits,
		&platformCredits, &r.RefundCents); err != nil {
		return r, err
	}
	r.OwedCents, r.PlatformCents = centsOf(owedCredits), centsOf(platformCredits)
	// The platform can't have spent more than it had (fees, wholesale, a recorded seed): past that, a restock was
	// paid with players' money, which the credits check alone wouldn't see (a negative platform balance would
	// count as backing).
	if r.PlatformCents < 0 {
		r.Problems = append(r.Problems, fmt.Sprintf("platform: spent %d cents more than it has (players' money; record the seed?)",
			-r.PlatformCents))
	}
	if r.OwedCents+r.RefundCents > r.WalletCents-max(r.PlatformCents, 0) {
		r.Problems = append(r.Problems, fmt.Sprintf("credits: players are owed %d cents and senders %d to refund, the wallet backs %d (%d − %d platform)",
			r.OwedCents, r.RefundCents, r.WalletCents-max(r.PlatformCents, 0), r.WalletCents, r.PlatformCents))
	}
	ids := make([]string, 0, len(onChain))
	for id := range onChain {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		var b Backed
		if err := s.db.QueryRowContext(ctx, `SELECT
			COALESCE((SELECT qty + reserved FROM platform_stock WHERE token = ?1), 0) +
			COALESCE((SELECT SUM(qty) FROM backed_units WHERE token = ?1), 0)`, id).Scan(&b.Counted); err != nil {
			return r, err
		}
		b.OnChain = unitsOf(onChain[id])
		r.Units[id] = b
		if b.Counted > b.OnChain {
			r.Problems = append(r.Problems, fmt.Sprintf("%s: %d units counted, %d held on chain", id, b.Counted, b.OnChain))
		}
	}
	r.OK = len(r.Problems) == 0
	return r, s.inTx(ctx, func(t *sql.Tx) error {
		if r.OK {
			if _, err := t.Exec(`DELETE FROM settings WHERE key = ?`, pauseKey); err != nil {
				return err
			}
		} else {
			why, _ := json.Marshal(r.Problems)
			if _, err := t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
				pauseKey, string(why), now.Unix()); err != nil {
				return err
			}
		}
		verdict := "match"
		if !r.OK {
			verdict = "mismatch: payments paused"
		}
		if reason != "" {
			verdict += " (" + reason + ")"
		}
		return audit(t, actor, "reconcile", "payments", map[string]any{"ok": r.OK, "owedCents": r.OwedCents,
			"walletCents": r.WalletCents, "platformCents": r.PlatformCents, "refundCents": r.RefundCents, "units": r.Units, "problems": r.Problems,
			"wallet": r.walletReadings}, verdict)
	})
}

// centsOf: credits as cents of USD (100 credits = $1 today, so the same number).
func centsOf(credits int64) int64 { return credits * 100 / int64(game.payments.CreditsPerUSD) }

// pauseFor pauses payments now with these problems (kept with any already standing), as a mismatch would. The
// next reconciliation that matches resumes them.
func pauseFor(t *sql.Tx, problems []string, now time.Time) error {
	var v string
	err := t.QueryRow(`SELECT value FROM settings WHERE key = ?`, pauseKey).Scan(&v)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var why []string
	_ = json.Unmarshal([]byte(v), &why)
	why = append(why, problems...)
	b, _ := json.Marshal(why)
	_, err = t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		pauseKey, string(b), now.Unix())
	return err
}

// Paused: the problems that paused payments, or nil while they run.
func (s *store) Paused(ctx context.Context) ([]string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, pauseKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var why []string
	_ = json.Unmarshal([]byte(v), &why)
	if why == nil {
		why = []string{v}
	}
	return why, nil
}

// unpaused: errPaused while a reconciliation mismatch stands. Top-ups, sales and restocks check it first.
func (s *store) unpaused(ctx context.Context) error {
	why, err := s.Paused(ctx)
	if err != nil {
		return err
	}
	if why != nil {
		return errPaused
	}
	return nil
}

// pausedIn: errPaused while a reconciliation mismatch stands, read inside the transaction that moves the money
// (unpaused is only an early answer: a reconciliation can pause between it and the commit).
func pausedIn(t *sql.Tx) error {
	var n int
	if err := t.QueryRow(`SELECT COUNT(*) FROM settings WHERE key = ?`, pauseKey).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errPaused
	}
	return nil
}

// Reconciliations: the last results, newest first (from the audit log).
func (s *store) Reconciliations(ctx context.Context, limit int) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT detail, reason, at FROM audit WHERE action = 'reconcile'
		ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var detail, verdict string
		var at int64
		if err := rows.Scan(&detail, &verdict, &at); err != nil {
			return nil, err
		}
		m := map[string]any{}
		_ = json.Unmarshal([]byte(detail), &m)
		m["at"], m["verdict"] = at, verdict
		out = append(out, m)
	}
	return out, rows.Err()
}

// reconcileEvery runs the reconciliation until ctx ends.
func (s *store) reconcileEvery(ctx context.Context, c *bsc, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		if r, err := s.Reconcile(ctx, c, "system", "hourly", time.Now()); err != nil {
			slog.Warn("reconcile", "err", err)
		} else if !r.OK {
			slog.Error("reconcile: mismatch, payments paused", "problems", strings.Join(r.Problems, "; "))
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// ---------- the back office ----------

// AdminTopup: a top-up as the back office lists it (unknown senders included).
type AdminTopup struct {
	Topup
	UserID      string `json:"userId"`
	Email       string `json:"email,omitempty"`
	Sender      string `json:"sender"`
	RefundCents int64  `json:"refundCents"`          // owed back to the sender (or was, once refunded)
	RefundedAt  int64  `json:"refundedAt,omitempty"` // when the back office marked it refunded
}

// AdminSale: a sale as the back office lists it.
type AdminSale struct {
	Sale
	PartyID   int64  `json:"partyId,omitempty"`
	LeaseID   int64  `json:"leaseId,omitempty"`
	Buyer     string `json:"buyer"`
	Seller    string `json:"seller"`
	CreatedAt int64  `json:"createdAt"`
	SettledAt int64  `json:"settledAt,omitempty"`
}

// ScanRetry: something the top-up scanner moved past unread (scan_retries): a block's Transfer logs for one token
// ("logs", ref = the token), a player's receipt ("receipt", ref = the tx), or the Agentic Wallet's payouts in blocks
// Block..Ref ("payouts", ref = the last block; strangers' transfers there can't be marked refunded while it is open). "open" is read again on later passes;
// "given_up" is the back office's: check the block on an explorer and credit or refund by hand.
type ScanRetry struct {
	Kind      string `json:"kind"`
	Ref       string `json:"ref"`
	Block     int64  `json:"block"`
	Reason    string `json:"reason"`
	Attempts  int    `json:"attempts"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Payments: what the back office's Payments page shows.
type Payments struct {
	Paused          []string         `json:"paused"`
	Reconciliations []map[string]any `json:"reconciliations"`
	Topups          []AdminTopup     `json:"topups"`
	Sales           []AdminSale      `json:"sales"`
	ScanRetries     []ScanRetry      `json:"scanRetries"` // not "done": still being read, or given up
}

// bookedTxs: the txs the platform booked as a restock or as the team's seed. Stablecoin coming back to the Agentic
// Wallet in one (a router's change) is already netted in platform_ledger, so it is never owed back: not in
// reconciliation, not in the back office, not markable refunded.
const bookedTxs = `(SELECT lower(ref) FROM platform_ledger WHERE kind IN ('restock', 'seed'))`

func (s *store) Payments(ctx context.Context) (Payments, error) {
	var p Payments
	var err error
	if p.Paused, err = s.Paused(ctx); err != nil {
		return p, err
	}
	if p.Reconciliations, err = s.Reconciliations(ctx, 48); err != nil {
		return p, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT t.tx, t.log_index, t.token, t.usd_cents, t.fee, t.credits, t.status,
		t.reason, t.created_at, t.user_id, COALESCE(u.email, ''), t.sender,
		CASE WHEN t.refunded_at = 0 AND t.tx IN `+bookedTxs+` THEN 0 ELSE t.refund_cents END, t.refunded_at
		FROM topups t LEFT JOIN users u ON u.id = t.user_id
		ORDER BY t.id DESC LIMIT 200`)
	if err != nil {
		return p, err
	}
	p.Topups = []AdminTopup{}
	for rows.Next() {
		var x AdminTopup
		if err := rows.Scan(&x.Tx, &x.LogIndex, &x.Token, &x.USDCents, &x.Fee, &x.Credits, &x.Status, &x.Reason, &x.At,
			&x.UserID, &x.Email, &x.Sender, &x.RefundCents, &x.RefundedAt); err != nil {
			rows.Close()
			return p, err
		}
		p.Topups = append(p.Topups, x)
	}
	rows.Close()
	// Open and given-up rows each get their own window, players' receipts first in each: anyone can make blocks
	// unreadable for a few dollars, and their rows must never push a player's deposit off the page.
	p.ScanRetries = []ScanRetry{}
	for _, status := range []string{"open", "given_up"} {
		rows, err = s.db.QueryContext(ctx, `SELECT kind, ref, block, reason, attempts, status, created_at, updated_at
			FROM scan_retries WHERE status = ? ORDER BY kind = 'receipt' DESC, updated_at DESC, block DESC LIMIT 200`, status)
		if err != nil {
			return p, err
		}
		for rows.Next() {
			var x ScanRetry
			if err := rows.Scan(&x.Kind, &x.Ref, &x.Block, &x.Reason, &x.Attempts, &x.Status, &x.CreatedAt, &x.UpdatedAt); err != nil {
				rows.Close()
				return p, err
			}
			p.ScanRetries = append(p.ScanRetries, x)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return p, err
		}
	}
	rows, err = s.db.QueryContext(ctx, `SELECT id, party_id, lease_id, buyer, seller, token, qty, price, wholesale,
		status, created_at, settled_at FROM sales ORDER BY id DESC LIMIT 200`)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.Sales = []AdminSale{}
	for rows.Next() {
		var x AdminSale
		if err := rows.Scan(&x.ID, &x.PartyID, &x.LeaseID, &x.Buyer, &x.Seller, &x.Token, &x.Qty, &x.Price,
			&x.Wholesale, &x.Status, &x.CreatedAt, &x.SettledAt); err != nil {
			return p, err
		}
		p.Sales = append(p.Sales, x)
	}
	return p, rows.Err()
}

// errNotASeed: the Agentic Wallet sent something out in the tx (a swap, a payout): the seed only ever comes in.
var errNotASeed = errors.New("seed: the Agentic Wallet sent tokens out in this tx")

// paidOut: the Agentic Wallet sent tokens (any, stablecoin or bStock) to someone else in a successful tx. Read from
// the Transfer logs' topics alone, so a token we don't decode still counts.
func paidOut(rc Receipt) bool {
	for _, l := range rc.Logs {
		if len(l.Topics) < 3 || l.Topics[0] != transferTopic || !topicRe.MatchString(l.Topics[1]) {
			continue
		}
		from, to := topicAddr(l.Topics[1]), l.Topics[2]
		if strings.EqualFold(from, game.payments.AgenticWallet) &&
			!(topicRe.MatchString(to) && strings.EqualFold(topicAddr(to), game.payments.AgenticWallet)) {
			return true
		}
	}
	return false
}

// RecordSeed books USDC/USDT the team sent to the Agentic Wallet as the platform's own money (the first stock is
// bought with it). The api reads the tx on BSC itself; a tx is booked once, never one a player sent (credited
// or rejected: theirs either way), and never one in which the wallet sent anything out (a swap is a restock).
// Its transfers, recorded "unknown" by the top-up scanner, are marked as the seed.
func (s *store) RecordSeed(ctx context.Context, c *bsc, actor, tx, reason string, now time.Time) (int64, error) {
	tx = strings.ToLower(tx)
	if !hashRe.MatchString(tx) || strings.TrimSpace(reason) == "" || len(reason) > 200 {
		return 0, errBad
	}
	if c == nil {
		return 0, errNotConfigured
	}
	rc, err := c.Final(ctx, tx)
	if err != nil {
		return 0, err
	}
	var cents int64
	var senders []string
	for _, stable := range game.payments.Topup.Tokens {
		trs, err := transfersIn(rc, stable)
		if err != nil {
			return 0, err
		}
		for _, tr := range trs {
			if strings.EqualFold(tr.To, game.payments.AgenticWallet) && !strings.EqualFold(tr.From, game.payments.AgenticWallet) {
				cents += usdCents(tr.Amount)
				senders = append(senders, tr.From)
			}
		}
	}
	// A player's wallet sent it (banned or not, reported or not): a top-up, theirs to be credited or refunded.
	for _, from := range senders {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE lower(wallet_address) = ? AND wallet_address != ''`,
			strings.ToLower(from)).Scan(&n); err != nil {
			return 0, err
		}
		if n > 0 {
			return 0, errRejected
		}
	}
	if cents <= 0 {
		return 0, errNoStock // nothing came into the wallet
	}
	if paidOut(rc) {
		return 0, errNotASeed
	}
	return cents, s.inTx(ctx, func(t *sql.Tx) error {
		var booked, players int
		// Booked already, as the seed or as anything else (a restock's refund leg is not seed money: issue #55).
		if err := t.QueryRow(`SELECT (SELECT COUNT(*) FROM platform_ledger WHERE lower(ref) = ?1) +
			(SELECT COUNT(*) FROM stock_moves WHERE lower(tx) = ?1 AND kind = 'restock'),
			(SELECT COUNT(*) FROM topups WHERE tx = ?1 AND (user_id != '' OR refunded_at > 0))`, tx).Scan(&booked, &players); err != nil {
			return err
		}
		if players > 0 {
			return errRejected // a player's top-up, credited or to refund: never the platform's
		}
		if booked > 0 {
			return errTxUsed
		}
		if err := platformLedger(t, toCredits(cents), "seed", tx, reason); err != nil {
			return err
		}
		if _, err := t.Exec(`UPDATE topups SET status = 'rejected', reason = 'seed', refund_cents = 0, updated_at = ?
			WHERE tx = ? AND status = 'unknown'`,
			now.Unix(), tx); err != nil {
			return err
		}
		return audit(t, actor, "payments-seed", tx, map[string]any{"usdCents": cents}, reason)
	})
}

// MarkRefunded records that the back office paid back what a top-up transfer is owed (an unknown sender's money, a
// rejected top-up, or the part over the caps): reconciliation stops counting it as owed. Once per transfer; an
// unknown one becomes "rejected", so no player can claim it afterwards. Returns the cents refunded.
func (s *store) MarkRefunded(ctx context.Context, actor, tx string, logIndex int64, reason string, now time.Time) (int64, error) {
	tx = strings.ToLower(tx)
	if !hashRe.MatchString(tx) || logIndex < 0 || strings.TrimSpace(reason) == "" || len(reason) > 200 {
		return 0, errBad
	}
	var cents int64
	return cents, s.inTx(ctx, func(t *sql.Tx) error {
		var refundedAt int64
		var sender, why string
		err := t.QueryRow(`SELECT CASE WHEN tx IN `+bookedTxs+` THEN 0 ELSE refund_cents END, refunded_at, sender, reason
			FROM topups WHERE tx = ? AND log_index = ?`, tx, logIndex).Scan(&cents, &refundedAt, &sender, &why)
		if errors.Is(err, sql.ErrNoRows) {
			return errNoTopup
		}
		if err != nil {
			return err
		}
		if refundedAt > 0 {
			return errConflict // already refunded
		}
		if cents <= 0 {
			return errRejected // nothing is owed back on it (or it is a booked restock's or seed's change)
		}
		// Recorded while the wallet's payouts in its blocks couldn't be read: maybe a swap's change. Not while they're
		// still read again; once given up, the back office checks the tx by hand.
		var from, to uint64
		if n, _ := fmt.Sscanf(why, payoutsNoteFmt, &from, &to); n == 2 {
			var open int
			if err := t.QueryRow(`SELECT COUNT(*) FROM scan_retries WHERE kind = 'payouts' AND ref = ? AND block = ?
				AND status = 'open'`, strconv.FormatUint(to, 10), int64(from)).Scan(&open); err != nil {
				return err
			}
			if open > 0 {
				return errPayoutsUnread
			}
		}
		res, err := t.Exec(`UPDATE topups SET refunded_at = ?1, updated_at = ?1,
			status = CASE WHEN status = 'unknown' THEN 'rejected' ELSE status END
			WHERE tx = ?2 AND log_index = ?3 AND refunded_at = 0`, now.Unix(), tx, logIndex)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return errConflict
		}
		return audit(t, actor, "topup-refund", fmt.Sprintf("%s:%d", tx, logIndex),
			map[string]any{"refundCents": cents, "sender": sender}, reason)
	})
}

// ResolveScanRetry closes what the scanner couldn't read (open or given up) once the back office checked it by hand
// (credited or refunded the deposit, or found nothing to do): it is no longer read again nor shown. The reason goes
// to the audit log with the row as it was.
func (s *store) ResolveScanRetry(ctx context.Context, actor, kind, ref string, block int64, reason string, now time.Time) error {
	reason = strings.TrimSpace(reason)
	if kind == "" || ref == "" || block < 0 || reason == "" || len(reason) > 200 {
		return errBad
	}
	return s.inTx(ctx, func(t *sql.Tx) error {
		var status, why string
		var attempts int
		err := t.QueryRow(`SELECT status, reason, attempts FROM scan_retries WHERE kind = ? AND ref = ? AND block = ?`,
			kind, ref, block).Scan(&status, &why, &attempts)
		if errors.Is(err, sql.ErrNoRows) {
			return errNoScanRetry
		}
		if err != nil {
			return err
		}
		if status == "done" {
			return errConflict
		}
		if _, err := t.Exec(`UPDATE scan_retries SET status = 'done', reason = ?, updated_at = ?
			WHERE kind = ? AND ref = ? AND block = ? AND status = ?`,
			shortErr(errors.New("resolved by hand: "+reason)), now.Unix(), kind, ref, block, status); err != nil {
			return err
		}
		return audit(t, actor, "scan-retry-resolve", fmt.Sprintf("%s:%s:%d", kind, ref, block),
			map[string]any{"status": status, "attempts": attempts, "reason": why}, reason)
	})
}

var errNoScanRetry = errors.New("scan retry: not found")

// errPayoutsUnread: the transfer sits in a block range whose Agentic Wallet payouts the scanner couldn't read yet
// (scan_retries "payouts", open): it may be a swap's change, owed to nobody. Refundable once they read or are given up.
var errPayoutsUnread = errors.New("refund: the wallet's payouts in this transfer's blocks aren't read yet")
