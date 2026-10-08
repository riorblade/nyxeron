package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Real stock sold in the city (docs/payments.md §4–5). The CEO is a reseller: they hold no stock and need no
// capital. They set their price per token (between the live wholesale price and city.json's maxMarkup × it), and
// a guest buys from the platform's warehouse at that price, in credits.
//
// At a party (a city event): the purchase holds the guest's credits and reserves the units, and the whole party
// settles when it ends (+ settleGraceMinutes): units to the guest's real units, wholesale to the platform, the
// margin to the CEO. A host who disconnects cancels nothing; an admin may void a sale before it settles.
// At a shop (no end): each purchase settles at once, with the same split.
//
//	GET  /api/events/prices/{id}          → {prices, wholesale} (credits per unit)
//	PUT  /api/events/{id}/prices          {prices} → host only, before the party starts
//	POST /api/events/{id}/buy             {token, qty, maxPrice} → while live: credits held, units reserved
//	PUT  /api/city/shops/{lease}/prices   {prices} → the tenant's shop prices in credits
//	POST /api/city/shops/{lease}/buy-credit {token, qty, maxPrice} → settled at once
//	POST /api/admin/sales/{id}/void       {reason} → a held sale: credits back, units released

var (
	errNoPrice     = errors.New("sales: no live price for the token")
	errNotLive     = errors.New("sales: the party isn't on")
	errPriceLocked = errors.New("sales: the party has started; its prices are locked")
	errStarted     = errors.New("events: the party has started; only an admin can call it off")
)

// wholesaleOf: what one unit costs the platform now, in credits: live price × sharesPerUnit × creditsPerUsd,
// rounded up. Only whitelisted tokens are sold for credits.
func wholesaleOf(token string, quotes map[string]float64) (int64, error) {
	if _, ok := game.payments.Tokens[token]; !ok {
		return 0, errBad
	}
	price := quotes[game.tokens[token].Ticker]
	if !(price > 0) || math.IsInf(price, 0) {
		return 0, errNoPrice
	}
	// Whole numbers: the price in credits per share (cents today), then up to whole credits per unit. Float math
	// alone rounds one credit too many at some prices ($70.00 × 0.001 × 100 = 7.000…01 → 8).
	per := int64(math.Round(1 / game.payments.SharesPerUnit))
	perShare := price * float64(game.payments.CreditsPerUSD)
	if perShare > float64(maxWholesale*per) { // an absurd quote is no price (and keeps price × qty far from overflowing)
		return 0, errNoPrice
	}
	c := int64(math.Round(perShare))
	return max(1, (c+per-1)/per), nil
}

// maxWholesale: one unit (0.001 share) above $10,000 means a broken feed, not a stock.
const maxWholesale = 1_000_000

// quoteMaxAge: prices older than this aren't sold against (the quoter serves its last good answer when Binance
// is down; selling real stock at an old price would lose the platform money).
const quoteMaxAge = 10 * time.Minute

// freshQuotes: the quoter's prices, or none when they are too old.
func freshQuotes(q *quoter, now time.Time) map[string]float64 {
	r := q.get()
	if now.Sub(time.UnixMilli(r.At)) > quoteMaxAge || r.Source != "binance" {
		return map[string]float64{}
	}
	return r.Quotes
}

// checkPrices: every token whitelisted, every price between wholesale and maxMarkup × wholesale.
func checkPrices(prices map[string]int64, quotes map[string]float64) error {
	if len(prices) == 0 || len(prices) > len(game.payments.Tokens) {
		return errBad
	}
	for token, p := range prices {
		w, err := wholesaleOf(token, quotes)
		if err != nil {
			return err
		}
		if p < w || float64(p) > game.city.Shop.MaxMarkup*float64(w) {
			return errBad
		}
	}
	return nil
}

func setPrices(t *sql.Tx, table, key string, id int64, prices map[string]int64) error {
	if _, err := t.Exec(`DELETE FROM `+table+` WHERE `+key+` = ?`, id); err != nil {
		return err
	}
	for token, p := range prices {
		if _, err := t.Exec(`INSERT INTO `+table+` (`+key+`, token, price) VALUES (?, ?, ?)`, id, token, p); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) prices(ctx context.Context, table, key string, id int64) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT token, price FROM `+table+` WHERE `+key+` = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var t string
		var p int64
		if err := rows.Scan(&t, &p); err != nil {
			return nil, err
		}
		out[t] = p
	}
	return out, rows.Err()
}

type partyRow struct {
	host         string
	lease        int64
	starts, ends int64
	cancelled    bool
}

func partyOf(q interface {
	QueryRow(string, ...any) *sql.Row
}, pid int64) (partyRow, error) {
	var p partyRow
	var cancelled, minutes int64
	err := q.QueryRow(`SELECT host_id, lease_id, starts_at, minutes, cancelled FROM parties WHERE id = ?`, pid).
		Scan(&p.host, &p.lease, &p.starts, &minutes, &cancelled)
	if errors.Is(err, sql.ErrNoRows) {
		return p, errNotFound
	}
	p.ends, p.cancelled = p.starts+minutes*60, cancelled == 1
	return p, err
}

// SetPartyPrices: the host's price list for a city event, before it starts.
func (s *store) SetPartyPrices(ctx context.Context, host string, pid int64, prices map[string]int64, quotes map[string]float64, now time.Time) error {
	p, err := partyOf(s.db, pid)
	if err != nil {
		return err
	}
	if p.host != host || p.lease == 0 || p.cancelled {
		return errNotFound // only the host of a city event (practice clubs don't sell real stock)
	}
	if now.Unix() >= p.starts {
		return errPriceLocked
	}
	if err := checkPrices(prices, quotes); err != nil {
		return err
	}
	return s.inTx(ctx, func(t *sql.Tx) error {
		if err := setPrices(t, "party_prices", "party_id", pid, prices); err != nil {
			return err
		}
		return audit(t, host, "party-prices", strconv.FormatInt(pid, 10), prices, "set by the host")
	})
}

// SetShopPrices: a tenant's shop prices in credits.
func (s *store) SetShopPrices(ctx context.Context, owner string, lease int64, prices map[string]int64, quotes map[string]float64, now time.Time) error {
	var who string
	err := s.db.QueryRowContext(ctx, `SELECT user_id FROM leases WHERE id = ? AND ends_at > ?`, lease, now.Unix()).Scan(&who)
	if errors.Is(err, sql.ErrNoRows) || who != owner {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if err := checkPrices(prices, quotes); err != nil {
		return err
	}
	return s.inTx(ctx, func(t *sql.Tx) error {
		if err := setPrices(t, "shop_prices", "lease_id", lease, prices); err != nil {
			return err
		}
		return audit(t, owner, "shop-prices", strconv.FormatInt(lease, 10), prices, "set by the tenant")
	})
}

// Sale: one purchase of real stock in the city.
type Sale struct {
	ID        int64  `json:"id"`
	Token     string `json:"token"`
	Qty       int64  `json:"qty"`
	Price     int64  `json:"price"`     // credits per unit, the CEO's
	Wholesale int64  `json:"wholesale"` // credits per unit, the platform's, at the time of the sale
	Status    string `json:"status"`
}

// errPriceChanged: the seller's price is above what the buyer saw (a shop's price changed in between).
var errPriceChanged = errors.New("sales: the price changed")

// sellable: a price the CEO set for the token that still covers today's wholesale price, and that is no more
// than the buyer agreed to pay (maxPrice; 0 = the price shown is the price paid).
func sellable(prices map[string]int64, token string, qty, maxPrice int64, quotes map[string]float64) (price, wholesale int64, err error) {
	if qty < 1 || qty > game.city.Shop.MaxBuy || maxPrice < 0 {
		return 0, 0, errBad
	}
	price, ok := prices[token]
	if !ok {
		return 0, 0, errRejected // not on the menu
	}
	if maxPrice > 0 && price > maxPrice {
		return 0, 0, errPriceChanged
	}
	if wholesale, err = wholesaleOf(token, quotes); err != nil {
		return 0, 0, err
	}
	if price < wholesale {
		return 0, 0, errRejected // the market moved above the CEO's price: they'd sell at a loss
	}
	return price, wholesale, nil
}

// BuyAtParty: while a city event is on, a guest buys at the host's price. Credits are held and units reserved;
// both settle when the party ends.
func (s *store) BuyAtParty(ctx context.Context, buyer string, pid int64, token string, qty, maxPrice int64, quotes map[string]float64, now time.Time) (Sale, error) {
	sale := Sale{Token: token, Qty: qty, Status: "held"}
	p, err := partyOf(s.db, pid)
	if err != nil {
		return sale, err
	}
	if p.lease == 0 || p.cancelled || now.Unix() < p.starts || now.Unix() >= p.ends {
		return sale, errNotLive
	}
	if buyer == p.host {
		return sale, errRejected
	}
	prices, err := s.prices(ctx, "party_prices", "party_id", pid)
	if err != nil {
		return sale, err
	}
	if sale.Price, sale.Wholesale, err = sellable(prices, token, qty, maxPrice, quotes); err != nil {
		return sale, err
	}
	err = s.inTx(ctx, func(t *sql.Tx) error {
		if err := creditLedger(t, buyer, -sale.Price*qty, "hold", "", fmt.Sprintf("party %d: %d %s", pid, qty, token)); err != nil {
			return err // not enough credits
		}
		if err := reserve(t, token, qty); err != nil {
			return err // the warehouse doesn't have that many
		}
		res, err := t.Exec(`INSERT INTO sales (party_id, buyer, seller, token, qty, price, wholesale, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`, pid, buyer, p.host, token, qty, sale.Price, sale.Wholesale, now.Unix())
		if err != nil {
			return err
		}
		sale.ID, err = res.LastInsertId()
		return err
	})
	return sale, err
}

// BuyAtShop: a city shop sells real stock at its tenant's price, settled at once.
func (s *store) BuyAtShop(ctx context.Context, buyer string, lease int64, token string, qty, maxPrice int64, quotes map[string]float64, now time.Time) (Sale, error) {
	sale := Sale{Token: token, Qty: qty, Status: "settled"}
	var owner string
	var open int
	err := s.db.QueryRowContext(ctx, `SELECT user_id, open FROM leases WHERE id = ? AND ends_at > ?`, lease, now.Unix()).Scan(&owner, &open)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && open == 0) {
		return sale, errNotFound
	}
	if err != nil {
		return sale, err
	}
	if buyer == owner {
		return sale, errRejected
	}
	prices, err := s.prices(ctx, "shop_prices", "lease_id", lease)
	if err != nil {
		return sale, err
	}
	if sale.Price, sale.Wholesale, err = sellable(prices, token, qty, maxPrice, quotes); err != nil {
		return sale, err
	}
	err = s.inTx(ctx, func(t *sql.Tx) error {
		if err := creditLedger(t, buyer, -sale.Price*qty, "sale", "", fmt.Sprintf("shop %d: %d %s", lease, qty, token)); err != nil {
			return err
		}
		if err := reserve(t, token, qty); err != nil {
			return err
		}
		res, err := t.Exec(`INSERT INTO sales (lease_id, buyer, seller, token, qty, price, wholesale, status, created_at, settled_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, 0)`, lease, buyer, owner, token, qty, sale.Price, sale.Wholesale, now.Unix())
		if err != nil {
			return err
		}
		if sale.ID, err = res.LastInsertId(); err != nil {
			return err
		}
		return settle(t, sale.ID, now) // a shop has no end: the same split, right away
	})
	return sale, err
}

// settle one held sale (exactly once: only a 'held' row turns 'settled'): the reserved units leave the warehouse
// for the buyer's real units, wholesale goes to the platform, the margin to the seller.
func settle(t *sql.Tx, id int64, now time.Time) error {
	var buyer, seller, token string
	var qty, price, wholesale int64
	if err := t.QueryRow(`SELECT buyer, seller, token, qty, price, wholesale FROM sales WHERE id = ? AND status = 'held'`, id).
		Scan(&buyer, &seller, &token, &qty, &price, &wholesale); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil // settled or voided already
		}
		return err
	}
	if _, err := t.Exec(`UPDATE sales SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'held'`, now.Unix(), id); err != nil {
		return err
	}
	if err := take(t, token, qty); err != nil {
		return err
	}
	if _, err := t.Exec(`INSERT INTO backed_units (user_id, token, qty) VALUES (?, ?, ?)
		ON CONFLICT (user_id, token) DO UPDATE SET qty = qty + excluded.qty`, buyer, token, qty); err != nil {
		return err
	}
	ref := "sale:" + strconv.FormatInt(id, 10)
	if err := creditLedger(t, seller, (price-wholesale)*qty, "margin", "", ref); err != nil {
		return err
	}
	if err := platformLedger(t, wholesale*qty, "wholesale", ref, fmt.Sprintf("%d %s", qty, token)); err != nil {
		return err
	}
	return audit(t, "system", "sale-settle", ref, map[string]any{"buyer": buyer, "seller": seller, "token": token,
		"qty": qty, "price": price, "wholesale": wholesale}, "settled")
}

// SettleParties settles every held sale of the parties that ended (+ settleGraceMinutes), one party per
// transaction. Safe to run again: a settled sale is never settled twice. A party that was cancelled (by its host
// or the back office) sold nothing: its held sales are voided, credits back to the guests. A party that fails to
// settle is logged and retried next time; it never holds up the others.
func (s *store) SettleParties(ctx context.Context, now time.Time) (settled int, err error) {
	grace := int64(game.city.Party.SettleGraceMinutes) * 60
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT s.party_id, p.cancelled FROM sales s JOIN parties p ON p.id = s.party_id
		WHERE s.status = 'held' AND s.party_id > 0 AND (p.cancelled = 1 OR p.starts_at + p.minutes * 60 + ? <= ?)
		ORDER BY s.party_id`, grace, now.Unix())
	if err != nil {
		return 0, err
	}
	type due struct {
		pid       int64
		cancelled bool
	}
	var parties []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.pid, &d.cancelled); err != nil {
			rows.Close()
			return 0, err
		}
		parties = append(parties, d)
	}
	rows.Close()
	var errs []error
	for _, d := range parties {
		err := s.inTx(ctx, func(t *sql.Tx) error {
			ids, err := heldSales(t, d.pid)
			if err != nil {
				return err
			}
			for _, id := range ids {
				if d.cancelled {
					err = voidHeld(t, id, "system", "party cancelled")
				} else {
					err = settle(t, id, now)
				}
				if err != nil {
					return err
				}
			}
			if !d.cancelled {
				settled += len(ids)
			}
			return nil
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("party %d: %w", d.pid, err))
		}
	}
	return settled, errors.Join(errs...)
}

func heldSales(t *sql.Tx, pid int64) ([]int64, error) {
	rows, err := t.Query(`SELECT id FROM sales WHERE party_id = ? AND status = 'held' ORDER BY id`, pid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// VoidSale: an admin cancels a held sale: the guest's credits come back, the units go back on the shelf.
func (s *store) VoidSale(ctx context.Context, actor string, id int64, reason string) error {
	if reason == "" || len(reason) > 200 {
		return errBad
	}
	return s.inTx(ctx, func(t *sql.Tx) error { return voidHeld(t, id, actor, reason) })
}

// voidHeld: a held sale undone (exactly once): credits back to the guest, units back on the shelf.
func voidHeld(t *sql.Tx, id int64, actor, reason string) error {
	var buyer, token string
	var qty, price int64
	err := t.QueryRow(`SELECT buyer, token, qty, price FROM sales WHERE id = ? AND status = 'held'`, id).
		Scan(&buyer, &token, &qty, &price)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound // unknown, settled or voided already
	}
	if err != nil {
		return err
	}
	if _, err := t.Exec(`UPDATE sales SET status = 'void', settled_at = ? WHERE id = ? AND status = 'held'`,
		time.Now().Unix(), id); err != nil {
		return err
	}
	if err := release(t, token, qty); err != nil {
		return err
	}
	ref := "sale:" + strconv.FormatInt(id, 10)
	if err := creditLedger(t, buyer, price*qty, "refund", actor, ref); err != nil {
		return err
	}
	return audit(t, actor, "sale-void", ref, map[string]any{"buyer": buyer, "token": token, "qty": qty}, reason)
}

func (s *store) inTx(ctx context.Context, f func(*sql.Tx) error) error {
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if err := f(t); err != nil {
		return err
	}
	return t.Commit()
}

// settleEvery runs the party settlement until ctx ends.
func (s *store) settleEvery(ctx context.Context, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		if n, err := s.SettleParties(ctx, time.Now()); err != nil {
			slog.Warn("settle parties", "err", err)
		} else if n > 0 {
			slog.Info("settled party sales", "sales", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// ---------- endpoints ----------

func salesError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	case errors.Is(err, errNotLive):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_live"})
	case errors.Is(err, errPriceLocked):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "prices_locked"})
	case errors.Is(err, errPriceChanged):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "price_changed"})
	case errors.Is(err, errNoPrice):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no_price"})
	default:
		fail(w, err) // errBad 400, errRejected 422 (not enough credits, not on the menu), errSoldOut 409
	}
}

func (pl *players) routeSales(mux *http.ServeMux) {
	id := func(r *http.Request, name string) int64 {
		n, _ := strconv.ParseInt(r.PathValue(name), 10, 64)
		return n
	}
	quotes := func() map[string]float64 { return freshQuotes(pl.q, time.Now()) }
	mux.HandleFunc("GET /api/events/prices/{id}", func(w http.ResponseWriter, r *http.Request) {
		if pl.db == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
			return
		}
		prices, err := pl.db.prices(r.Context(), "party_prices", "party_id", id(r, "id"))
		if err != nil {
			fail(w, err)
			return
		}
		wholesale := map[string]int64{}
		for token := range game.payments.Tokens {
			if v, err := wholesaleOf(token, quotes()); err == nil {
				wholesale[token] = v
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"prices": prices, "wholesale": wholesale, "maxMarkup": game.city.Shop.MaxMarkup})
	})
	mux.HandleFunc("PUT /api/events/{id}/prices", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) { // real stock in the city: shut until top-ups are live
			return
		}
		who, ok := pl.who(w, r)
		var in struct{ Prices map[string]int64 }
		if ok && body(w, r, &in) {
			if err := pl.db.SetPartyPrices(r.Context(), who, id(r, "id"), in.Prices, quotes(), time.Now()); err != nil {
				salesError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"prices": in.Prices})
		}
	})
	mux.HandleFunc("POST /api/events/{id}/buy", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) { // real stock in the city: shut until top-ups are live
			return
		}
		who, ok := pl.who(w, r)
		var in struct {
			Token    string
			Qty      int64
			MaxPrice int64 // the price the buyer saw (required); refused if the seller's is higher now
		}
		if ok && body(w, r, &in) {
			if in.MaxPrice < 1 { // 0 would mean no cap: a buyer always says what they agreed to pay
				fail(w, errBad)
				return
			}
			sale, err := pl.db.BuyAtParty(r.Context(), who, id(r, "id"), in.Token, in.Qty, in.MaxPrice, quotes(), time.Now())
			if err != nil {
				salesError(w, err)
				return
			}
			c, _, _, _ := pl.db.Topups(r.Context(), who, time.Now())
			writeJSON(w, http.StatusOK, map[string]any{"sale": sale, "credits": c})
		}
	})
	mux.HandleFunc("PUT /api/city/shops/{lease}/prices", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) { // real stock in the city: shut until top-ups are live
			return
		}
		who, ok := pl.who(w, r)
		var in struct{ Prices map[string]int64 }
		if ok && body(w, r, &in) {
			if err := pl.db.SetShopPrices(r.Context(), who, id(r, "lease"), in.Prices, quotes(), time.Now()); err != nil {
				salesError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"prices": in.Prices})
		}
	})
	mux.HandleFunc("POST /api/city/shops/{lease}/buy-credit", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) { // real stock in the city: shut until top-ups are live
			return
		}
		who, ok := pl.who(w, r)
		var in struct {
			Token    string
			Qty      int64
			MaxPrice int64 // the price the buyer saw (required); refused if the seller's is higher now
		}
		if ok && body(w, r, &in) {
			if in.MaxPrice < 1 { // 0 would mean no cap: a buyer always says what they agreed to pay
				fail(w, errBad)
				return
			}
			sale, err := pl.db.BuyAtShop(r.Context(), who, id(r, "lease"), in.Token, in.Qty, in.MaxPrice, quotes(), time.Now())
			if err != nil {
				salesError(w, err)
				return
			}
			c, _, _, _ := pl.db.Topups(r.Context(), who, time.Now())
			writeJSON(w, http.StatusOK, map[string]any{"sale": sale, "credits": c})
		}
	})
}
