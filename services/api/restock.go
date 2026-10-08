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
	errUnbacked      = errors.New("restock: the Agentic Wallet doesn't hold that much bStock")
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
	case errors.Is(err, errUnbacked):
		code, name = http.StatusConflict, "unbacked"
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

// Restocked: what a verified restock added.
type Restocked struct {
	Token    string `json:"token"`
	Units    int64  `json:"units"`
	Shares   string `json:"shares"` // base units of the bStock received (18 decimals)
	USDCents int64  `json:"usdCents"`
	Tx       string `json:"tx"`
}

// unitsOf: whole units in an amount of bStock (base units, 18 decimals), rounded down.
func unitsOf(shares *big.Int) int64 {
	per := big.NewInt(int64(math.Round(1e18 * game.payments.SharesPerUnit)))
	if per.Sign() <= 0 || shares.Sign() <= 0 {
		return 0
	}
	u := new(big.Int).Quo(shares, per)
	if !u.IsInt64() {
		return -1
	}
	return u.Int64()
}

// VerifiedRestock reads a swap on BSC and adds the units it bought to the warehouse, with the USDC paid as
// platform money out, in one transaction. errUnconfirmed / errNoTx: not final yet, report it again later.
//
// A restock is a purchase: the Agentic Wallet's NET bStock gain in the tx (in − out, its transfers to itself
// ignored) against USDC/USDT it paid out. A tx with no stablecoin paid (moving bStock it already had, or getting
// back what it sent away) adds nothing. After the purchase, everything counted as real stock must still be
// covered by the wallet's bStock balance on chain. The agent's per-swap and daily limits bind the agent; the
// team's own reports (the back office: seeding the first stock) are not capped.
func (s *store) VerifiedRestock(ctx context.Context, c *bsc, actor, token, tx, reason string, now time.Time) (Restocked, error) {
	out := Restocked{Token: token, Tx: strings.ToLower(tx)}
	lock, ok := game.payments.Tokens[token]
	if !ok || !hashRe.MatchString(tx) || len(reason) > 200 {
		return out, errBad
	}
	limited := actor == "agent"

	if c == nil {
		return out, errNotConfigured
	}
	if err := s.unused(ctx, s.db, out.Tx); err != nil {
		return out, err
	}
	rc, err := c.Final(ctx, tx)
	if err != nil {
		return out, err
	}
	shares, err := netFlow(rc, lock.Contract) // bStock: what the wallet gained
	if err != nil {
		return out, err
	}
	var cents int64
	for _, stable := range game.payments.Topup.Tokens {
		flow, err := netFlow(rc, stable) // stablecoins: what the wallet paid (a negative flow)
		if err != nil {
			return out, err
		}
		if flow.Sign() < 0 {
			cents += usdCents(new(big.Int).Neg(flow))
		}
	}
	out.Shares, out.USDCents, out.Units = shares.String(), cents, unitsOf(shares)
	if out.Units <= 0 || cents <= 0 {
		return out, errNoStock
	}
	if limited && cents > game.payments.Agent.MaxUsdPerSwap*100 {
		return out, errOverLimit
	}
	// The chain must hold what we'd count: warehouse + held + players' real units, this restock included.
	balance, err := c.BalanceOf(ctx, lock.Contract, game.payments.AgenticWallet)
	if err != nil {
		return out, err
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer t.Rollback()
	// Checked again inside the write: two reports of one tx at once count once.
	if err := s.unused(ctx, t, out.Tx); err != nil {
		return out, err
	}
	if limited {
		today, err := spentToday(t, now)
		if err != nil {
			return out, err
		}
		if today+cents > game.payments.Agent.MaxUsdPerDay*100 {
			return out, errOverLimit
		}
	}
	var counted int64
	if err := t.QueryRow(`SELECT COALESCE((SELECT qty + reserved FROM platform_stock WHERE token = ?1), 0) +
		COALESCE((SELECT SUM(qty) FROM backed_units WHERE token = ?1), 0)`, token).Scan(&counted); err != nil {
		return out, err
	}
	if counted+out.Units > unitsOf(balance) {
		return out, errUnbacked
	}
	if strings.TrimSpace(reason) == "" {
		reason = "verified swap"
	}
	if err := moveStock(t, token, out.Units, "restock", "", actor, reason, out.Tx); err != nil {
		return out, err
	}
	if err := platformLedger(t, -toCredits(cents), "restock", out.Tx, fmt.Sprintf("%d units of %s", out.Units, token)); err != nil {
		return out, err
	}
	if err := audit(t, actor, "stock-restock", token, map[string]any{"units": out.Units, "shares": out.Shares,
		"usdCents": cents, "tx": out.Tx}, reason); err != nil {
		return out, err
	}
	return out, t.Commit()
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// unused: errTxUsed when a restock already counted this tx (any letter case).
func (s *store) unused(ctx context.Context, q querier, tx string) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM stock_moves WHERE lower(tx) = lower(?) AND kind = 'restock'`,
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
