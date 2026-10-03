package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The shared city (packages/core/src/rules/city.ts has the same rules for the browser). Venues are rented by the
// week with the account's Coin — the platform's income. A tenant's shop sells to other players while they are
// away, as long as there is stock; from Level 3 the tenant can also schedule parties (10 minutes by default), and
// what guests spend at a live party goes to the tenant's wallet. Everything is settled here, never in the browser.
//
//	GET    /api/city                       → venues (free / rented, shops, stock), upcoming + live parties, rent
//	POST   /api/city/lease                 {level, slot?, club, weeks} → rent (or extend) a venue
//	POST   /api/city/stock                 {token, qty} → buy stock for my shop from the platform's warehouse
//	PUT    /api/city/venue                 {club} → rename my venue
//	PUT    /api/city/shop                  {lease, open?, prices?} → open/close that venue's shop, set my prices
//	POST   /api/city/shops/{lease}/buy     {token, qty} → buy from someone's shop
//
// Parties at city venues are events (events.go): /api/events with a lease.
//
// Game numbers come from gamedata/ — a copy of packages/core/src/data that a test keeps identical.

//go:embed gamedata/*.json
var gameFS embed.FS

type tokenInfo struct {
	Ticker       string  `json:"ticker"`
	BuyCost      float64 `json:"buyCost"`
	DefaultPrice float64 `json:"defaultPrice"`
	MinLevel     int     `json:"minLevel"`
	Legs         [][]any `json:"legs"`
}

var game struct {
	tokens map[string]tokenInfo
	levels map[string]struct {
		Name       string  `json:"name"`
		PriceScale float64 `json:"priceScale"`
		Storage    int64   `json:"storage"`
	}
	city struct {
		LeaseDays     int `json:"leaseDays"`
		MaxWeeksAhead int `json:"maxWeeksAhead"`
		MaxVenues     int `json:"maxVenuesPerPlayer"`
		Venues        map[string]struct {
			Count      int   `json:"count"`
			WeeklyRent int64 `json:"weeklyRent"`
		} `json:"venues"`
		Shop struct {
			MaxMarkup float64 `json:"maxMarkup"`
			MaxBuy    int64   `json:"maxBuy"`
		} `json:"shop"`
		Party struct {
			MinLevel           int `json:"minLevel"`
			DefaultMinutes     int `json:"defaultMinutes"`
			MinMinutes         int `json:"minMinutes"`
			MaxMinutes         int `json:"maxMinutes"`
			MaxAheadDays       int `json:"maxAheadDays"`
			SettleGraceMinutes int `json:"settleGraceMinutes"`
		} `json:"party"`
	}
	strategy struct {
		Platform struct {
			SpotFactorRange [2]float64 `json:"spotFactorRange"`
		} `json:"platform"`
	}
}

func init() {
	for name, v := range map[string]any{
		"tokens": &game.tokens, "levels": &game.levels, "city": &game.city, "strategy": &game.strategy,
	} {
		b, err := gameFS.ReadFile("gamedata/" + name + ".json")
		if err == nil {
			err = json.Unmarshal(b, v)
		}
		if err != nil {
			panic("gamedata/" + name + ".json: " + err.Error())
		}
	}
}

func lv(level int) string { return strconv.Itoa(level) }

// factorFn: a token's spot factor (spot now / spot when the server first saw it); 1 without prices.
type factorFn func(token string) float64

func spotFactorOf(quotes, ref map[string]float64, token string) float64 {
	var sum, w float64
	legs := game.tokens[token].Legs
	if len(legs) == 0 {
		legs = [][]any{{game.tokens[token].Ticker, 100.0}}
	}
	for _, leg := range legs {
		ticker, _ := leg[0].(string)
		weight, _ := leg[1].(float64)
		now, was := quotes[ticker], ref[ticker]
		if now <= 0 || was <= 0 {
			continue
		}
		sum += now / was * weight
		w += weight
	}
	if w == 0 {
		return 1
	}
	r := game.strategy.Platform.SpotFactorRange
	return max(r[0], min(r[1], sum/w))
}

func scale(level int) float64 { return game.levels[lv(level)].PriceScale }

func wholesale(token string, level int, f float64) int64 {
	return max(1, int64(math.Round(game.tokens[token].BuyCost*scale(level)*f)))
}

func shelfPrice(token string, level int, f float64) int64 {
	base := math.Round(game.tokens[token].DefaultPrice * scale(level))
	return max(1, int64(math.Round(base*f)))
}

func maxShelfPrice(token string, level int, f float64) int64 {
	return int64(float64(shelfPrice(token, level, f)) * game.city.Shop.MaxMarkup)
}

// ---------- store ----------

type Shelf struct {
	Token string `json:"token"`
	Qty   int64  `json:"qty"`
	Price int64  `json:"price"`
}

type LeaseView struct {
	ID      int64   `json:"id"`
	Club    string  `json:"club"`
	Owner   string  `json:"owner"`
	OwnerID string  `json:"ownerId,omitempty"` // back office only
	Email   string  `json:"email,omitempty"`   // back office only
	Since   int64   `json:"since"`
	EndsAt  int64   `json:"endsAt"`
	Open    bool    `json:"open"`
	Mine    bool    `json:"mine,omitempty"`
	Stock   []Shelf `json:"stock"`
}

type VenueView struct {
	Level int        `json:"level"`
	Slot  int        `json:"slot"`
	Lease *LeaseView `json:"lease"`
}

type CityView struct {
	Venues  []VenueView      `json:"venues"`
	Parties []PartyView      `json:"parties"`
	Rent    map[string]int64 `json:"rent"`
	Counts  map[string]int   `json:"counts"`
	Now     int64            `json:"now"`
	// Prices[level][token]: what stock costs, the usual shelf price and the most a shop may ask, right now.
	Prices map[string]map[string]PriceRow `json:"prices,omitempty"`
	// Supply[token]: what the platform's warehouse holds (shops restock from it).
	Supply map[string]int64 `json:"supply,omitempty"`
}

type PriceRow struct {
	Wholesale int64 `json:"wholesale"`
	Shelf     int64 `json:"shelf"`
	Max       int64 `json:"max"`
}

func priceTable(f factorFn) map[string]map[string]PriceRow {
	out := map[string]map[string]PriceRow{}
	for l := range game.city.Venues {
		level, _ := strconv.Atoi(l)
		out[l] = map[string]PriceRow{}
		for tok, info := range game.tokens {
			if info.MinLevel <= level {
				fx := f(tok)
				out[l][tok] = PriceRow{wholesale(tok, level, fx), shelfPrice(tok, level, fx), maxShelfPrice(tok, level, fx)}
			}
		}
	}
	return out
}

// Rent: the back office's table (settings "rent") over the game data.
func (s *store) Rent(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	for l, v := range game.city.Venues {
		out[l] = v.WeeklyRent
	}
	var raw string
	if s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'rent'`).Scan(&raw) == nil {
		var o map[string]int64
		if json.Unmarshal([]byte(raw), &o) == nil {
			for l, v := range o {
				if _, ok := out[l]; ok && v > 0 {
					out[l] = v
				}
			}
		}
	}
	return out
}

// VenueCounts: how many venues of each level the city has: the back office's numbers (settings "venueCounts") over
// the game data.
func (s *store) VenueCounts(ctx context.Context) map[string]int {
	out := map[string]int{}
	for l, v := range game.city.Venues {
		out[l] = v.Count
	}
	var raw string
	if s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'venueCounts'`).Scan(&raw) == nil {
		var o map[string]int
		if json.Unmarshal([]byte(raw), &o) == nil {
			for l, n := range o {
				if _, ok := out[l]; ok && n > 0 {
					out[l] = n
				}
			}
		}
	}
	return out
}

// City: every venue with its tenant (if any) and shop, and the parties that haven't ended. `viewer` marks what is
// theirs; `admin` adds who the tenants are.
func (s *store) City(ctx context.Context, viewer string, admin bool, now time.Time) (CityView, error) {
	counts := s.VenueCounts(ctx)
	v := CityView{Rent: s.Rent(ctx), Counts: counts, Now: now.Unix(), Venues: []VenueView{}, Parties: []PartyView{}}
	byVenue := map[[2]int]*LeaseView{}
	rows, err := s.db.QueryContext(ctx, `SELECT l.id, l.level, l.slot, l.club, u.name, u.id, u.email, l.starts_at, l.ends_at, l.open
		FROM leases l JOIN users u ON u.id = l.user_id WHERE l.ends_at > ?`, now.Unix())
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var l LeaseView
		var level, slot, open int
		var owner, email string
		if err := rows.Scan(&l.ID, &level, &slot, &l.Club, &l.Owner, &owner, &email, &l.Since, &l.EndsAt, &open); err != nil {
			rows.Close()
			return v, err
		}
		l.Open, l.Mine, l.Stock = open == 1, owner == viewer, []Shelf{}
		if admin {
			l.OwnerID, l.Email = owner, email
		}
		byVenue[[2]int{level, slot}] = &l
	}
	rows.Close()
	// Shelves: the tenant's stock (stock belongs to the player and moves with them to another venue).
	for _, l := range byVenue {
		r, err := s.db.QueryContext(ctx, `SELECT token, qty, price FROM shop_stock
			WHERE user_id = (SELECT user_id FROM leases WHERE id = ?) AND qty > 0 ORDER BY token`, l.ID)
		if err != nil {
			return v, err
		}
		for r.Next() {
			var sh Shelf
			if err := r.Scan(&sh.Token, &sh.Qty, &sh.Price); err != nil {
				r.Close()
				return v, err
			}
			l.Stock = append(l.Stock, sh)
		}
		r.Close()
	}
	for level := 1; level <= 5; level++ {
		for slot := 1; slot <= counts[lv(level)]; slot++ {
			v.Venues = append(v.Venues, VenueView{Level: level, Slot: slot, Lease: byVenue[[2]int{level, slot}]})
		}
	}
	// Upcoming and live events: public ones, plus the viewer's own (the back office sees all).
	v.Parties, err = s.events(ctx, viewer, admin, now, `p.starts_at + p.minutes * 60 > ?1 AND p.cancelled = 0
		AND (p.private = 0 OR p.host_id = ?2 OR ?3)`, now.Unix(), viewer, admin)
	return v, err
}

type activeLease struct {
	id          int64
	level, slot int
	endsAt      int64
}

// myLeases: the player's active venues, biggest first.
func myLeases(t *sql.Tx, id string, now time.Time) ([]activeLease, error) {
	rows, err := t.Query(`SELECT id, level, slot, ends_at FROM leases WHERE user_id = ? AND ends_at > ? ORDER BY level DESC, id`,
		id, now.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []activeLease
	for rows.Next() {
		var l activeLease
		if err := rows.Scan(&l.id, &l.level, &l.slot, &l.endsAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errNoLease
	}
	return out, nil
}

// ownLease: one of the player's active venues, by lease id.
func ownLease(t *sql.Tx, id string, lease int64, now time.Time) (activeLease, error) {
	var l activeLease
	err := t.QueryRow(`SELECT id, level, slot, ends_at FROM leases WHERE id = ? AND user_id = ? AND ends_at > ?`,
		lease, id, now.Unix()).Scan(&l.id, &l.level, &l.slot, &l.endsAt)
	if errors.Is(err, sql.ErrNoRows) {
		return l, errNoLease
	}
	return l, err
}

var (
	errNoLease    = errors.New("no venue rented")
	errVenueLimit = errors.New("venue limit reached")
)

func pay(t *sql.Tx, id string, amount int64, kind, reason string) error {
	var wallet int64
	if err := t.QueryRow(`SELECT wallet FROM users WHERE id = ?`, id).Scan(&wallet); err != nil {
		return err
	}
	if wallet < amount {
		return errRejected
	}
	if _, err := t.Exec(`UPDATE users SET wallet = wallet - ? WHERE id = ?`, amount, id); err != nil {
		return err
	}
	return ledger(t, id, -amount, kind, "", reason)
}

// Lease rents a venue (slot 0: the first free one of that level) for whole weeks, or, when the slot is already
// the player's, extends it. A player may run up to maxVenuesPerPlayer venues; at most maxWeeksAhead paid ahead.
func (s *store) Lease(ctx context.Context, id string, level, slot int, club string, weeks int, now time.Time) (p Profile, err error) {
	club, ok := cleanName(club)
	count, known := s.VenueCounts(ctx)[lv(level)]
	if !ok || !known || slot < 0 || slot > count || weeks < 1 || weeks > game.city.MaxWeeksAhead {
		return p, errBad
	}
	rent := s.Rent(ctx)[lv(level)] * int64(weeks)
	week := int64(game.city.LeaseDays) * 86400
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		var leaseID, endsAt int64
		var owner string
		if slot > 0 {
			e := t.QueryRow(`SELECT id, user_id, ends_at FROM leases WHERE level = ? AND slot = ? AND ends_at > ?`,
				level, slot, now.Unix()).Scan(&leaseID, &owner, &endsAt)
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
		}
		switch {
		case owner == id:
			// Extend: from when the current lease ends.
			if endsAt+int64(weeks)*week > now.Unix()+int64(game.city.MaxWeeksAhead)*week {
				return errRejected
			}
			if e := pay(t, id, rent, "rent", "extend"); e != nil {
				return e
			}
			if _, e := t.Exec(`UPDATE leases SET ends_at = ends_at + ?, rent = rent + ?, club = CASE WHEN ? != '' THEN ? ELSE club END
				WHERE id = ?`, int64(weeks)*week, rent, club, club, leaseID); e != nil {
				return e
			}
		case owner != "":
			return errConflict // someone else's venue
		default:
			if club == "" {
				return errBad
			}
			var mine int
			if e := t.QueryRow(`SELECT COUNT(*) FROM leases WHERE user_id = ? AND ends_at > ?`, id, now.Unix()).Scan(&mine); e != nil {
				return e
			}
			if mine >= game.city.MaxVenues {
				return errVenueLimit
			}
			if slot == 0 {
				e := t.QueryRow(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
					SELECT x FROM n WHERE x NOT IN (SELECT slot FROM leases WHERE level = ? AND ends_at > ?) LIMIT 1`,
					count, level, now.Unix()).Scan(&slot)
				if errors.Is(e, sql.ErrNoRows) {
					return errConflict // all taken
				} else if e != nil {
					return e
				}
			}
			if e := pay(t, id, rent, "rent", game.levels[lv(level)].Name); e != nil {
				return e
			}
			if _, e := t.Exec(`INSERT INTO leases (level, slot, user_id, club, rent, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				level, slot, id, club, rent, now.Unix(), now.Unix()+int64(weeks)*week); e != nil {
				return e
			}
		}
		if e := touch(t, id); e != nil {
			return e
		}
		var e error
		p, e = read(t, id)
		return e
	})
	return
}

// Rename: the tenant names one of their venues (e.g. "Escala Bar").
func (s *store) Rename(ctx context.Context, id string, lease int64, club string, now time.Time) error {
	club, ok := cleanName(club)
	if !ok || club == "" {
		return errBad
	}
	return s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := ownLease(t, id, lease, now)
		if e != nil {
			return e
		}
		_, e = t.Exec(`UPDATE leases SET club = ? WHERE id = ?`, club, l.id)
		return e
	})
}

// Stock buys units for the player's shops from the warehouse. Stock belongs to the player and every one of their
// open venues sells from it; it must fit their venues' storage combined, and a token must be allowed at their
// biggest venue.
// ponytail: one stock pool and one price list per player; per-venue shelves if tenants ask for them.
func (s *store) Stock(ctx context.Context, id, token string, qty int64, f factorFn, now time.Time) (p Profile, err error) {
	tok, known := game.tokens[token]
	if !known || qty < 1 || qty > 10_000 {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		leases, e := myLeases(t, id, now)
		if e != nil {
			return e
		}
		l := leases[0] // the biggest
		if tok.MinLevel > l.level {
			return errRejected
		}
		var held, storage int64
		if e := t.QueryRow(`SELECT COALESCE(SUM(qty), 0) FROM shop_stock WHERE user_id = ?`, id).Scan(&held); e != nil {
			return e
		}
		for _, x := range leases {
			storage += game.levels[lv(x.level)].Storage
		}
		if held+qty > storage {
			return errRejected
		}
		factor := f(token)
		// From the platform's warehouse: what isn't there can't be sold.
		if e := moveStock(t, token, -qty, "sold", id, "", "", ""); e != nil {
			return e
		}
		if e := pay(t, id, wholesale(token, l.level, factor)*qty, "stock", token); e != nil {
			return e
		}
		if _, e := t.Exec(`INSERT INTO shop_stock (user_id, token, qty, price) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id, token) DO UPDATE SET qty = qty + excluded.qty`,
			id, token, qty, shelfPrice(token, l.level, factor)); e != nil {
			return e
		}
		if e := touch(t, id); e != nil {
			return e
		}
		p, e = read(t, id)
		return e
	})
	return
}

// SetShop opens or closes one venue's shop and sets the player's shelf prices (up to maxMarkup times the usual
// price at that venue).
func (s *store) SetShop(ctx context.Context, id string, lease int64, open *bool, prices map[string]int64, f factorFn, now time.Time) error {
	return s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := ownLease(t, id, lease, now)
		if e != nil {
			return e
		}
		for tok, price := range prices {
			if _, ok := game.tokens[tok]; !ok || price < 1 || price > maxShelfPrice(tok, l.level, f(tok)) {
				return errBad
			}
			if _, e := t.Exec(`UPDATE shop_stock SET price = ? WHERE user_id = ? AND token = ?`, price, id, tok); e != nil {
				return e
			}
		}
		if open != nil {
			if _, e := t.Exec(`UPDATE leases SET open = ? WHERE id = ?`, map[bool]int{true: 1}[*open], l.id); e != nil {
				return e
			}
		}
		return nil
	})
}

// ShopBuy: a player buys from an open shop. The money goes straight to the tenant; the tokens to the buyer's
// portfolio at what they paid.
func (s *store) ShopBuy(ctx context.Context, buyer string, leaseID int64, token string, qty int64, now time.Time) (p Profile, err error) {
	if qty < 1 || qty > game.city.Shop.MaxBuy {
		return p, errBad
	}
	err = s.tx(ctx, buyer, func(t *sql.Tx) error {
		var owner, club string
		var open, banned int
		e := t.QueryRow(`SELECT l.user_id, l.club, l.open, u.banned FROM leases l JOIN users u ON u.id = l.user_id
			WHERE l.id = ? AND l.ends_at > ?`, leaseID, now.Unix()).Scan(&owner, &club, &open, &banned)
		if errors.Is(e, sql.ErrNoRows) {
			return errNotFound
		} else if e != nil {
			return e
		}
		if owner == buyer || open == 0 || banned == 1 {
			return errRejected
		}
		var have, price int64
		if e := t.QueryRow(`SELECT qty, price FROM shop_stock WHERE user_id = ? AND token = ?`, owner, token).Scan(&have, &price); e != nil || have < qty {
			return errRejected
		}
		total := price * qty
		if e := pay(t, buyer, total, "shop", club); e != nil {
			return e
		}
		if _, e := t.Exec(`UPDATE users SET wallet = wallet + ? WHERE id = ?`, total, owner); e != nil {
			return e
		}
		if e := ledger(t, owner, total, "sale", "", token); e != nil {
			return e
		}
		if _, e := t.Exec(`UPDATE shop_stock SET qty = qty - ? WHERE user_id = ? AND token = ?`, qty, owner, token); e != nil {
			return e
		}
		if e := addHoldings(t, buyer, map[string]Holding{token: {Qty: qty, Cost: total}}); e != nil {
			return e
		}
		if e := touch(t, buyer); e != nil {
			return e
		}
		p, e = read(t, buyer)
		return e
	})
	return
}

// ---------- spot prices for the city ----------

// factors: spot factors against the server's reference prices (settings "quoteRef": the first price seen per
// ticker, kept for good so city prices move with the market from launch on).
func (s *store) factors(ctx context.Context, quotes map[string]float64) factorFn {
	ref := map[string]float64{}
	var raw string
	if s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'quoteRef'`).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &ref)
	}
	grew := false
	for k, v := range quotes {
		if _, ok := ref[k]; !ok && v > 0 {
			ref[k], grew = v, true
		}
	}
	if grew {
		b, _ := json.Marshal(ref)
		_, _ = s.db.ExecContext(ctx, `INSERT INTO settings (key, value, updated_at) VALUES ('quoteRef', ?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, string(b), time.Now().Unix())
	}
	return func(tok string) float64 { return spotFactorOf(quotes, ref, tok) }
}

// ---------- routes ----------

func (pl *players) factor(ctx context.Context) factorFn {
	if pl.q == nil {
		return func(string) float64 { return 1 }
	}
	return pl.db.factors(ctx, pl.q.get().Quotes)
}

// viewer: the signed-in player if the request carries a valid token, else "" (the city is public).
func (pl *players) viewer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !pl.auth.configured() {
		return ""
	}
	id, _ := pl.auth.verify(strings.TrimSpace(token), time.Now())
	return id
}

func (pl *players) routeCity(mux *http.ServeMux) {
	reply := func(w http.ResponseWriter, v any, err error) {
		switch {
		case errors.Is(err, errNoLease):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no_lease"})
		case errors.Is(err, errVenueLimit):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "venue_limit"})
		case errors.Is(err, errNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		case err != nil:
			fail(w, err)
		default:
			writeJSON(w, http.StatusOK, v)
		}
	}
	mux.HandleFunc("GET /api/city", func(w http.ResponseWriter, r *http.Request) {
		if pl.db == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
			return
		}
		v, err := pl.db.City(r.Context(), pl.viewer(r), false, time.Now())
		v.Prices = priceTable(pl.factor(r.Context()))
		v.Supply = pl.db.supplyFor(r.Context())
		reply(w, v, err)
	})
	mux.HandleFunc("POST /api/city/lease", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Level, Slot, Weeks int
			Club               string
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Lease(r.Context(), id, in.Level, in.Slot, in.Club, in.Weeks, time.Now())
			reply(w, p, err)
		}
	})
	mux.HandleFunc("PUT /api/city/venue", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Lease int64
			Club  string
		}
		if ok && body(w, r, &in) {
			reply(w, map[string]bool{"ok": true}, pl.db.Rename(r.Context(), id, in.Lease, in.Club, time.Now()))
		}
	})
	mux.HandleFunc("POST /api/city/stock", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Token string
			Qty   int64
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Stock(r.Context(), id, in.Token, in.Qty, pl.factor(r.Context()), time.Now())
			reply(w, p, err)
		}
	})
	mux.HandleFunc("PUT /api/city/shop", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			Lease  int64
			Open   *bool
			Prices map[string]int64
		}
		if ok && body(w, r, &in) {
			err := pl.db.SetShop(r.Context(), id, in.Lease, in.Open, in.Prices, pl.factor(r.Context()), time.Now())
			reply(w, map[string]bool{"ok": true}, err)
		}
	})
	mux.HandleFunc("POST /api/city/shops/{lease}/buy", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		lease, _ := strconv.ParseInt(r.PathValue("lease"), 10, 64)
		var in struct {
			Token string
			Qty   int64
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.ShopBuy(r.Context(), id, lease, in.Token, in.Qty, time.Now())
			reply(w, p, err)
		}
	})
}
