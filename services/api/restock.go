package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Warehouse units exist only for bStock the Agentic Wallet really holds. A restock is a swap on BSC: the agent
// (or an admin) reports its tx, and the api reads it itself (bsc.go: two rpcs, 15 confirmations): the bStock the
// Agentic Wallet received sets the units (1 unit = payments.json's sharesPerUnit of a share), the USDC/USDT it
// paid must stay within the agent's limits, and a tx counts once. The USDC spent is platform money going out.
//
// Reservations hold units during a party: reserve (on hand → reserved), release (back), take (sold: gone).

var (
	errTxUsed        = errors.New("restock: tx already counted")
	errNoStock       = errors.New("restock: no whitelisted bStock reached the Agentic Wallet")
	errOverLimit     = errors.New("restock: over the agent's limits")
	errNotConfigured = errors.New("restock: BSC_RPC_1 and BSC_RPC_2 are not set")
)

// netFlow: how much of a token the Agentic Wallet gained in a successful tx (negative: it paid). Its transfers to
// itself count for nothing.
func netFlow(rc Receipt, token string) (*big.Int, error) {
	trs, err := transfersIn(rc, token)
	if err != nil {
		return nil, err
	}
	net := new(big.Int)
	for _, tr := range trs {
		in, out := strings.EqualFold(tr.To, game.payments.AgenticWallet), strings.EqualFold(tr.From, game.payments.AgenticWallet)
		switch {
		case in && !out:
			net.Add(net, tr.Amount)
		case out && !in:
			net.Sub(net, tr.Amount)
		}
	}
	return net, nil
}

// spentToday: what the agent's restocks paid in the last 24 h, in cents (platform money out).
func spentToday(q interface {
	QueryRow(string, ...any) *sql.Row
}, now time.Time) (int64, error) {
	var credits int64
	err := q.QueryRow(`SELECT COALESCE(-SUM(delta), 0) FROM platform_ledger WHERE kind = 'restock' AND at > ?`,
		now.Unix()-86400).Scan(&credits)
	return credits * 100 / int64(game.payments.CreditsPerUSD), err
}

// restockError answers a verified restock that didn't add units, for the agent and the back office alike.
func restockError(w http.ResponseWriter, err error) {
	code, name := http.StatusInternalServerError, "internal"
	switch {
	case errors.Is(err, errUnconfirmed) || errors.Is(err, errNoTx):
		code, name = http.StatusAccepted, "pending" // not final yet: report it again later
	case errors.Is(err, errTxUsed):
		code, name = http.StatusConflict, "tx_used"
	case errors.Is(err, errNoStock), errors.Is(err, errTxFailed):
		code, name = http.StatusUnprocessableEntity, "not_a_restock"
	case errors.Is(err, errOverLimit):
		code, name = http.StatusUnprocessableEntity, "over_limit"
	case errors.Is(err, errPaused):
		code, name = http.StatusServiceUnavailable, "paused"
	case errors.Is(err, errBad):
		code, name = http.StatusBadRequest, "bad_request"
	case errors.Is(err, errNotConfigured):
		code, name = http.StatusServiceUnavailable, "not_configured"
	default:
		slog.Warn("restock", "err", err)
		code, name = http.StatusServiceUnavailable, "chain_unavailable"
	}
	writeJSON(w, code, map[string]string{"error": name})
}

// Restocked: what a verified restock booked.
type Restocked struct {
	Token    string `json:"token"`
	Units    int64  `json:"units"`  // whole units added to the warehouse
	Shares   string `json:"shares"` // base units of the bStock received (18 decimals)
	USDCents int64  `json:"usdCents"`
	Tx       string `json:"tx"`
	// Short: whole units bought that the wallet's balance doesn't back, because it already held fewer units than
	// the books count (some went missing). The agent's report adds them anyway and pauses payments (Paused) so the
	// loss stays visible until the team writes it off; an admin's report writes them off itself, as a "loss" move.
	Short  int64 `json:"short,omitempty"`
	Paused bool  `json:"paused,omitempty"`
	// Others: units added of other whitelisted tokens the same swap bought (the payment is booked once, here).
	Others map[string]int64 `json:"others,omitempty"`
}

// perUnit: one unit in base units of bStock (18 decimals).
func perUnit() *big.Int { return big.NewInt(int64(math.Round(1e18 * game.payments.SharesPerUnit))) }

// unitsOf: whole units in an amount of bStock (base units, 18 decimals), rounded down.
func unitsOf(shares *big.Int) int64 {
	per := perUnit()
	if per.Sign() <= 0 || shares.Sign() <= 0 {
		return 0
	}
	u := new(big.Int).Quo(shares, per)
	if !u.IsInt64() {
		return -1
	}
	return u.Int64()
}

// buy: one whitelisted bStock a swap delivered to the Agentic Wallet.
type buy struct {
	token  string
	shares *big.Int
	onHand int64 // the wallet's balance on chain, in units
}

// fractionKey: settings key for the part of a unit a token's swaps bought but no unit has counted yet (base
// units). Sub-unit leftovers add up there and are booked once they make a whole unit (review #56).
func fractionKey(token string) string { return "restock_fraction:" + token }

// carryFraction: the units in shares plus the token's leftover from earlier swaps; keeps the new leftover.
func carryFraction(t *sql.Tx, token string, shares *big.Int, now time.Time) (int64, error) {
	var v string
	err := t.QueryRow(`SELECT value FROM settings WHERE key = ?`, fractionKey(token)).Scan(&v)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	total := new(big.Int).Set(shares)
	if left, ok := new(big.Int).SetString(v, 10); ok && left.Sign() > 0 {
		total.Add(total, left)
	}
	units := unitsOf(total)
	if units < 0 {
		return 0, errBad
	}
	left := new(big.Int).Sub(total, new(big.Int).Mul(big.NewInt(units), perUnit()))
	if _, err := t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		fractionKey(token), left.String(), now.Unix()); err != nil {
		return 0, err
	}
	return units, nil
}

// VerifiedRestock reads a swap on BSC and books it in one transaction: the USDC/USDT paid as platform money out,
// and the whole units it bought into the warehouse. errUnconfirmed / errNoTx: not final yet, report it again later.
//
// A restock is a purchase: the Agentic Wallet's NET bStock gain in the tx (in − out, its transfers to itself
// ignored) against USDC/USDT it paid out. A tx with no stablecoin paid (moving bStock it already had, or getting
// back what it sent away) is not one. Every verified purchase is booked, exactly once (issue #55): the money left
// the wallet whatever it bought, and leaving it off the books would pause payments at the next reconciliation.
//   - Fractions of a unit: each token's leftover is kept (fractionKey) and booked once the swaps make a whole
//     unit; until then it stays in the wallet as surplus (the reconciliation only needs counted ≤ on chain).
//   - Units already short on chain (some went missing): the spend is booked either way. The agent's report adds
//     what it bought and pauses payments, so the loss stays visible until the team writes it off; an admin's
//     report writes the missing units off itself, as an explicit "loss" stock move with its reason, audited.
//   - Several whitelisted bStocks in one tx: all are added, the payment booked once.
//
// The agent's per-swap and daily limits bind the agent; the team's own reports (the back office) are not capped.
func (s *store) VerifiedRestock(ctx context.Context, c *bsc, actor, token, tx, reason string, now time.Time) (Restocked, error) {
	out := Restocked{Token: token, Tx: strings.ToLower(tx)}
	if _, ok := game.payments.Tokens[token]; !ok || !hashRe.MatchString(tx) || len(reason) > 200 {
		return out, errBad
	}
	limited := actor == "agent"

	if c == nil {
		return out, errNotConfigured
	}
	// Not blocked by a reconciliation pause: recording a swap that already happened mints no credits, and it is
	// what brings the books back in line (the agent stops buying while paused instead: demand says so).
	if err := s.unused(ctx, s.db, out.Tx); err != nil {
		return out, err
	}
	rc, err := c.Final(ctx, tx)
	if err != nil {
		return out, err
	}
	ids := make([]string, 0, len(game.payments.Tokens))
	for id := range game.payments.Tokens {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var buys []buy // the reported token first
	for _, id := range ids {
		shares, err := netFlow(rc, game.payments.Tokens[id].Contract) // bStock: what the wallet gained
		if err != nil {
			return out, err
		}
		if shares.Sign() <= 0 {
			continue
		}
		if unitsOf(shares) < 0 {
			return out, errBad
		}
		b := buy{token: id, shares: shares}
		if id == token {
			buys = append([]buy{b}, buys...)
		} else {
			buys = append(buys, b)
		}
	}
	var cents int64
	for _, stable := range game.payments.Topup.Tokens {
		flow, err := netFlow(rc, stable) // stablecoins: what the wallet paid (a negative flow)
		if err != nil {
			return out, err
		}
		if flow.Sign() < 0 {
			cents += usdCentsUp(new(big.Int).Neg(flow)) // what left the wallet, never less (the books stay cautious)
		}
	}
	if len(buys) == 0 || buys[0].token != token || cents <= 0 {
		return out, errNoStock
	}
	out.Shares, out.USDCents = buys[0].shares.String(), cents
	if limited && cents > game.payments.Agent.MaxUsdPerSwap*100 {
		return out, errOverLimit
	}
	// The chain must hold what we count: warehouse + held + players' real units, this restock included. The
	// balance is read before the write (no network call holds the database), so a report that finds units short
	// reads the chain again and books once more: another report of the same token committing in between must not
	// look like a loss (a false pause, or a write-off of units the wallet holds).
	for attempt := 0; ; attempt++ {
		for i := range buys {
			balance, err := c.BalanceOf(ctx, game.payments.Tokens[buys[i].token].Contract, game.payments.AgenticWallet)
			if err != nil {
				return out, err
			}
			buys[i].onHand = unitsOf(balance)
		}
		got, again, err := s.bookRestock(ctx, actor, token, reason, out, buys, cents, limited, attempt > 0, now)
		if again {
			continue
		}
		return got, err
	}
}

// bookRestock writes one verified swap in one transaction (see VerifiedRestock). With final false, units found
// short return again = true instead of being acted on, so the caller re-reads the chain first.
func (s *store) bookRestock(ctx context.Context, actor, token, reason string, out Restocked, buys []buy, cents int64,
	limited, final bool, now time.Time) (got Restocked, again bool, err error) {
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, false, err
	}
	defer t.Rollback()
	// Checked again inside the write: two reports of one tx at once count once.
	if err := s.unused(ctx, t, out.Tx); err != nil {
		return out, false, err
	}
	if limited {
		today, err := spentToday(t, now)
		if err != nil {
			return out, false, err
		}
		if today+cents > game.payments.Agent.MaxUsdPerDay*100 {
			return out, false, errOverLimit
		}
	}
	if strings.TrimSpace(reason) == "" {
		reason = "verified swap"
	}
	detail := map[string]any{"usdCents": cents, "tx": out.Tx}
	var what, problems []string
	for i, b := range buys {
		units, err := carryFraction(t, b.token, b.shares, now)
		if err != nil {
			return out, false, err
		}
		var counted int64
		if err := t.QueryRow(`SELECT COALESCE((SELECT qty + reserved FROM platform_stock WHERE token = ?1), 0) +
			COALESCE((SELECT SUM(qty) FROM backed_units WHERE token = ?1), 0)`, b.token).Scan(&counted); err != nil {
			return out, false, err
		}
		short := units - min(units, max(b.onHand-counted, 0)) // bought, but the chain doesn't back it
		if short > 0 && !final {
			return out, true, nil // read the chain again before calling it a loss (the deferred rollback undoes this try)
		}
		// A move even for 0 units: the trail shows the swap, and it is what makes the tx count once.
		if err := moveStock(t, b.token, units, "restock", "", actor, reason, out.Tx); err != nil {
			return out, false, err
		}
		add := units
		if short > 0 {
			slog.Warn("restock: units short on chain", "token", b.token, "bought", units, "short", short,
				"counted", counted, "onChain", b.onHand, "tx", out.Tx, "actor", actor)
			if limited {
				// The agent can't decide a loss: the books keep counting what's missing, so every reconciliation
				// flags it, and payments stop now rather than at the next hourly check.
				problems = append(problems, fmt.Sprintf("%s: restock %s bought %d units but the wallet holds %d "+
					"for %d counted: %d missing on chain; write them off in the back office (stock) to resume",
					b.token, out.Tx, units, b.onHand, counted+units, short))
			} else {
				why := fmt.Sprintf("lost on chain: %d units counted, %d held (%s)", counted+units, b.onHand, reason)
				if err := moveStock(t, b.token, -short, "loss", "", actor, why, out.Tx); err != nil {
					return out, false, err
				}
				if err := audit(t, actor, "stock-loss", b.token, map[string]any{"units": short, "tx": out.Tx,
					"counted": counted, "onChain": b.onHand, "bought": units}, why); err != nil {
					return out, false, err
				}
				add = units - short
			}
		}
		what = append(what, fmt.Sprintf("%d units of %s", add, b.token))
		detail[b.token] = map[string]any{"units": add, "bought": units, "short": short, "shares": b.shares.String()}
		if i == 0 {
			out.Units, out.Short = add, short
			detail["units"], detail["shares"] = add, out.Shares // as before, for the reported token
		} else {
			if out.Others == nil {
				out.Others = map[string]int64{}
			}
			out.Others[b.token] = add
		}
	}
	if len(problems) > 0 {
		if err := pauseFor(t, problems, now); err != nil {
			return out, false, err
		}
		out.Paused = true
	}
	if err := platformLedger(t, -toCredits(cents), "restock", out.Tx, strings.Join(what, ", ")); err != nil {
		return out, false, err
	}
	// A stranger's transfer the scanner recorded in this tx is the router's change, booked in the restock: nothing
	// is owed back on it (as RecordSeed does for a seed's tx).
	if _, err := t.ExecContext(ctx, `UPDATE topups SET refund_cents = 0, updated_at = ? WHERE tx = ? AND user_id = ''
		AND status = 'unknown' AND refunded_at = 0`, now.Unix(), out.Tx); err != nil {
		return out, false, err
	}
	if err := audit(t, actor, "stock-restock", token, detail, reason); err != nil {
		return out, false, err
	}
	return out, false, t.Commit()
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// unused: errTxUsed when this tx (any letter case) is already on the books as a restock or as the team's seed:
// one tx is one or the other, once (issue #55: a swap's refund leg must not also count as seed money).
func (s *store) unused(ctx context.Context, q querier, tx string) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM stock_moves WHERE lower(tx) = lower(?1) AND kind = 'restock') +
		(SELECT COUNT(*) FROM platform_ledger WHERE lower(ref) = lower(?1) AND kind IN ('restock', 'seed'))`,
		tx).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errTxUsed
	}
	return nil
}

// ---------- reservations ----------

// reserve holds qty units for a sale in progress: on hand → reserved. Never more than is on hand.
func reserve(t *sql.Tx, token string, qty int64) error {
	return shiftReserved(t, token, qty, `qty = qty - ?2, reserved = reserved + ?2`, `qty >= ?2`)
}

// release gives held units back: reserved → on hand (a voided sale).
func release(t *sql.Tx, token string, qty int64) error {
	return shiftReserved(t, token, qty, `qty = qty + ?2, reserved = reserved - ?2`, `reserved >= ?2`)
}

// take removes held units from the warehouse for good (a settled sale: they are the buyer's now).
func take(t *sql.Tx, token string, qty int64) error {
	return shiftReserved(t, token, qty, `reserved = reserved - ?2`, `reserved >= ?2`)
}

func shiftReserved(t *sql.Tx, token string, qty int64, set, guard string) error {
	if qty <= 0 {
		return errBad
	}
	res, err := t.Exec(`UPDATE platform_stock SET `+set+`, updated_at = ?3 WHERE token = ?1 AND `+guard,
		token, qty, time.Now().Unix())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errSoldOut
	}
	return nil
}
