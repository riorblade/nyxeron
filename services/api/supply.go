package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

// The platform's warehouse. CEOs stock their shops from the platform's own inventory (never from thin air), and
// the platform restocks it with real bStock: its agent buys with the platform's Binance Agentic Wallet and
// reports each swap here; the api verifies it on BSC before any unit is added (restock.go). The agent reads
// demand (what CEOs order, what they hold) to decide what to buy.
//
//	GET  /api/agent/demand   (Authorization: Bearer $AGENT_KEY) → Supply
//	POST /api/agent/restock  {token, tx, note?} → Restocked: units from the bStock the swap really delivered
//
// The back office sees the same view (GET /api/admin/stock), reports swaps the same way and may only take units
// out by hand (PUT /api/admin/stock/{token}).

type SupplyRow struct {
	Token     string  `json:"token"`
	Ticker    string  `json:"ticker"`
	OnHand    int64   `json:"onHand"`    // in the platform's warehouse, free to sell
	Reserved  int64   `json:"reserved"`  // held for sales in progress (parties)
	InShops   int64   `json:"inShops"`   // already with CEOs, on their shelves
	Sold24h   int64   `json:"sold24h"`   // to CEOs
	Sold7d    int64   `json:"sold7d"`    // to CEOs
	Shops     int     `json:"shops"`     // CEOs holding this token
	DaysLeft  float64 `json:"daysLeft"`  // at the last 7 days' pace (-1: no demand yet)
	Suggested int64   `json:"suggested"` // to cover coverDays at that pace
}

type StockMove struct {
	ID     int64  `json:"id"`
	Token  string `json:"token"`
	Delta  int64  `json:"delta"`
	Kind   string `json:"kind"` // restock | adjust | sold
	UserID string `json:"userId,omitempty"`
	Actor  string `json:"actor"`
	Reason string `json:"reason"`
	Tx     string `json:"tx,omitempty"`
	At     int64  `json:"at"`
}

type Supply struct {
	// What the agent's restocks paid in the last 24 h, in cents: it checks its daily limit before swapping.
	AgentSpentToday int64       `json:"agentSpentTodayCents"`
	Tokens          []SupplyRow `json:"tokens"`
	Moves           []StockMove `json:"moves"`
	CoverDays       int         `json:"coverDays"`
	At              int64       `json:"at"`
}

// coverDays: how many days of demand the suggestion aims to keep on hand.
// ponytail: plain 7-day average × cover; the agent is where the real forecasting lives.
const coverDays = 3

func (s *store) Supply(ctx context.Context, now time.Time) (Supply, error) {
	out := Supply{Tokens: []SupplyRow{}, CoverDays: coverDays, At: now.Unix()}
	spent, err := spentToday(s.db, now)
	if err != nil {
		return out, err
	}
	out.AgentSpentToday = spent
	for _, tok := range sortedTokens() {
		r := SupplyRow{Token: tok, Ticker: game.tokens[tok].Ticker}
		err := s.db.QueryRowContext(ctx, `SELECT
			COALESCE((SELECT qty FROM platform_stock WHERE token = ?1), 0),
			COALESCE((SELECT reserved FROM platform_stock WHERE token = ?1), 0),
			COALESCE((SELECT SUM(qty) FROM shop_stock WHERE token = ?1), 0),
			COALESCE((SELECT COUNT(*) FROM shop_stock WHERE token = ?1 AND qty > 0), 0),
			COALESCE((SELECT -SUM(delta) FROM stock_moves WHERE token = ?1 AND kind = 'sold' AND at >= ?2), 0),
			COALESCE((SELECT -SUM(delta) FROM stock_moves WHERE token = ?1 AND kind = 'sold' AND at >= ?3), 0)`,
			tok, now.Unix()-86400, now.Unix()-7*86400).Scan(&r.OnHand, &r.Reserved, &r.InShops, &r.Shops, &r.Sold24h, &r.Sold7d)
		if err != nil {
			return out, err
		}
		r.DaysLeft = -1
		if perDay := float64(r.Sold7d) / 7; perDay > 0 {
			r.DaysLeft = float64(r.OnHand) / perDay
			r.Suggested = max(0, int64(perDay*coverDays+0.999)-r.OnHand)
		}
		out.Tokens = append(out.Tokens, r)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, token, delta, kind, user_id, actor, reason, tx, at FROM stock_moves
		ORDER BY id DESC LIMIT 100`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.Moves = []StockMove{}
	for rows.Next() {
		var m StockMove
		if err := rows.Scan(&m.ID, &m.Token, &m.Delta, &m.Kind, &m.UserID, &m.Actor, &m.Reason, &m.Tx, &m.At); err != nil {
			return out, err
		}
		out.Moves = append(out.Moves, m)
	}
	return out, rows.Err()
}

func sortedTokens() []string {
	out := make([]string, 0, len(game.tokens))
	for t := range game.tokens {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func moveStock(t *sql.Tx, token string, delta int64, kind, user, actor, reason, tx string) error {
	var have int64
	err := t.QueryRow(`SELECT qty FROM platform_stock WHERE token = ?`, token).Scan(&have)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if have+delta < 0 {
		return errSoldOut
	}
	now := time.Now().Unix()
	// The new total, not an upsert of the delta: SQLite checks qty >= 0 on the would-be inserted row too.
	if _, err := t.Exec(`INSERT INTO platform_stock (token, qty, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (token) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`, token, have+delta, now); err != nil {
		return err
	}
	_, err = t.Exec(`INSERT INTO stock_moves (token, delta, kind, user_id, actor, reason, tx, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		token, delta, kind, user, actor, reason, tx, now)
	return err
}

var errSoldOut = errors.New("platform sold out")

// Restock adds to (or, with a negative delta, corrects) the platform's warehouse. Audited.
func (s *store) Restock(ctx context.Context, actor, token string, delta int64, kind, reason, tx string) error {
	if _, ok := game.tokens[token]; !ok || delta == 0 || delta > 1_000_000 || delta < -1_000_000 ||
		strings.TrimSpace(reason) == "" || len(tx) > 100 || len(reason) > 200 {
		return errBad
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if err := moveStock(t, token, delta, kind, "", actor, reason, tx); err != nil {
		return err
	}
	if err := audit(t, actor, "stock-"+kind, token, map[string]any{"delta": delta, "tx": tx}, reason); err != nil {
		return err
	}
	return t.Commit()
}

// ---------- the agent ----------

type agent struct {
	key   string
	db    *store
	chain *bsc
}

func (ag *agent) ok(w http.ResponseWriter, r *http.Request) bool {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if ag.key == "" || ag.db == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
		return false
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(ag.key)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return false
	}
	return true
}

func (ag *agent) route(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/agent/demand", func(w http.ResponseWriter, r *http.Request) {
		if ag.ok(w, r) {
			v, err := ag.db.Supply(r.Context(), time.Now())
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, v)
		}
	})
	mux.HandleFunc("POST /api/agent/restock", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Token string
			Tx    string
			Note  string
		}
		if !ag.ok(w, r) || !body(w, r, &in) {
			return
		}
		// The units come from the swap on BSC, never from the request.
		got, err := ag.db.VerifiedRestock(r.Context(), ag.chain, "agent", in.Token, in.Tx, in.Note, time.Now())
		if err != nil {
			restockError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, got)
	})
}

// supplyFor: what the warehouse holds per token (shown to CEOs next to prices).
func (s *store) supplyFor(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	rows, err := s.db.QueryContext(ctx, `SELECT token, qty FROM platform_stock`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		var q int64
		if rows.Scan(&t, &q) == nil {
			out[t] = q
		}
	}
	return out
}
