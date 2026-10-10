package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// The shared city, on credits (real money; docs/payments.md). Venues are rented by the week in credits
// (payments.json → rentCredits, the back office's table over it): the platform's income. A tenant's shop resells
// real stock from the platform's warehouse at the tenant's credit prices while they are away, and from Level 3 the
// tenant can also schedule parties; both sell through sales.go. Everything is settled here, never in the browser.
//
//	GET    /api/city                       → venues (free / rented, shop menus), upcoming + live parties, rent
//	POST   /api/city/lease                 {level, slot?, club, weeks} → rent (or extend) a venue, in credits
//	PUT    /api/city/venue                 {club} → rename my venue
//	PUT    /api/city/shop                  {lease, open} → open/close that venue's shop
//
// Shop menus and purchases, party prices and sales: sales.go. Parties are events (events.go): /api/events + lease.
//
// Game numbers come from gamedata/ — a copy of packages/core/src/data that a test keeps identical.

//go:embed gamedata/*.json
var gameFS embed.FS

type tokenInfo struct {
	Ticker   string `json:"ticker"`
	MinLevel int    `json:"minLevel"` // the smallest venue that may sell it (tokens.json)
}

var game struct {
	tokens map[string]tokenInfo
	levels map[string]struct {
		Name string `json:"name"`
	}
	city struct {
		LeaseDays     int `json:"leaseDays"`
		MaxWeeksAhead int `json:"maxWeeksAhead"`
		MaxVenues     int `json:"maxVenuesPerPlayer"`
		Venues        map[string]struct {
			Count int `json:"count"`
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
		Market struct {
			Range [2]float64 `json:"range"` // the desk price's multiplier on the list price, low to high
		} `json:"market"`
	}
	payments struct {
		ChainID       int              `json:"chainId"`
		Confirmations uint64           `json:"confirmations"`
		AgenticWallet string           `json:"agenticWallet"`
		CreditsPerUSD int              `json:"creditsPerUsd"`
		SharesPerUnit float64          `json:"sharesPerUnit"`
		RentCredits   map[string]int64 `json:"rentCredits"` // weekly rent per venue level, in credits
		Agent         struct {
			MaxUsdPerSwap int64 `json:"maxUsdPerSwap"`
			MaxUsdPerDay  int64 `json:"maxUsdPerDay"`
		} `json:"agent"`
		Topup struct {
			FeePercent   int               `json:"feePercent"`
			MinUSD       int64             `json:"minUsd"`
			CapUSDPerDay int64             `json:"capUsdPerDay"`
			CapUSDTotal  int64             `json:"capUsdTotal"`
			Tokens       map[string]string `json:"tokens"`
		} `json:"topup"`
		Tokens map[string]struct {
			Symbol   string `json:"symbol"`
			Contract string `json:"contract"`
		} `json:"tokens"`
	}
}

func init() {
	for name, v := range map[string]any{
		"tokens": &game.tokens, "levels": &game.levels, "city": &game.city,
		"payments": &game.payments, "strategy": &game.strategy,
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

// ---------- store ----------

// Shelf: one token on a shop's menu: the warehouse's units and the tenant's price in credits.
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
	// Wholesale[token]: what one unit (0.001 share) costs the platform now, in credits: a shop's floor (its
	// ceiling is maxMarkup × it). Only tokens with a live price.
	Wholesale map[string]int64 `json:"wholesale,omitempty"`
	MaxMarkup float64          `json:"maxMarkup"`
	// Supply[token]: what the platform's warehouse holds (shops restock from it).
	Supply map[string]int64 `json:"supply,omitempty"`
	// Open: renting, shops and city parties are on. Off until Credit (real money) top-ups are live.
	Open bool `json:"open"`
}

// cityOpen: the city runs on Credit (real money) only, so it stays shut until top-ups are live (CITY_OPEN=1).
// ponytail: one process-wide switch; a setting in the back office if it ever needs flipping without a restart.
var cityOpen = os.Getenv("CITY_OPEN") == "1"

// cityClosed answers 403 city_closed while the city is shut.
func cityClosed(w http.ResponseWriter) bool {
	if cityOpen {
		return false
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "city_closed"})
	return true
}

// Rent: weekly rent per venue level, in credits (real money): payments.json's rentCredits, overridden by the back
// office's table (settings "rent_credits"; the Coin-era "rent" table no longer applies).
func (s *store) Rent(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	for l := range game.city.Venues {
		out[l] = game.payments.RentCredits[l]
	}
	var raw string
	if s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'rent_credits'`).Scan(&raw) == nil {
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
	// Shelves: the shop's menu in credits (sales.go), with what the platform's warehouse has of each token.
	for _, l := range byVenue {
		r, err := s.db.QueryContext(ctx, `SELECT sp.token, COALESCE(ps.qty, 0), sp.price FROM shop_prices sp
			LEFT JOIN platform_stock ps ON ps.token = sp.token WHERE sp.lease_id = ? ORDER BY sp.token`, l.ID)
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
			if e := creditLedger(t, id, -rent, "rent", "", "extend"); e != nil {
				return e
			}
			if e := platformLedger(t, rent, "rent", "lease:"+strconv.FormatInt(leaseID, 10), "extend"); e != nil {
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
			if e := creditLedger(t, id, -rent, "rent", "", game.levels[lv(level)].Name); e != nil {
				return e
			}
			res, e := t.Exec(`INSERT INTO leases (level, slot, user_id, club, rent, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				level, slot, id, club, rent, now.Unix(), now.Unix()+int64(weeks)*week)
			if e != nil {
				return e
			}
			leaseID, _ = res.LastInsertId()
			if e := platformLedger(t, rent, "rent", "lease:"+strconv.FormatInt(leaseID, 10), game.levels[lv(level)].Name); e != nil {
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

// SetShop opens or closes one venue's shop (its menu is set in sales.go: SetShopPrices).
func (s *store) SetShop(ctx context.Context, id string, lease int64, open *bool, now time.Time) error {
	return s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := ownLease(t, id, lease, now)
		if e != nil {
			return e
		}
		if open != nil {
			if _, e := t.Exec(`UPDATE leases SET open = ? WHERE id = ?`, map[bool]int{true: 1}[*open], l.id); e != nil {
				return e
			}
		}
		return nil
	})
}

// ---------- routes ----------

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
		v.Wholesale = map[string]int64{}
		for token := range game.payments.Tokens {
			if w, err := wholesaleOf(token, freshQuotes(pl.q, time.Now())); err == nil {
				v.Wholesale[token] = w
			}
		}
		v.MaxMarkup = game.city.Shop.MaxMarkup
		v.Supply = pl.db.supplyFor(r.Context())
		v.Open = cityOpen
		reply(w, v, err)
	})
	mux.HandleFunc("POST /api/city/lease", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) {
			return
		}
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
		if cityClosed(w) {
			return
		}
		id, ok := pl.who(w, r)
		var in struct {
			Lease int64
			Club  string
		}
		if ok && body(w, r, &in) {
			reply(w, map[string]bool{"ok": true}, pl.db.Rename(r.Context(), id, in.Lease, in.Club, time.Now()))
		}
	})
	mux.HandleFunc("PUT /api/city/shop", func(w http.ResponseWriter, r *http.Request) {
		if cityClosed(w) {
			return
		}
		id, ok := pl.who(w, r)
		var in struct {
			Lease int64
			Open  *bool
		}
		// Open / close only: since the cutover a shop sells real stock at its credit prices
		// (PUT /api/city/shops/{lease}/prices, sales.go); it holds no stock of its own.
		if ok && body(w, r, &in) {
			err := pl.db.SetShop(r.Context(), id, in.Lease, in.Open, time.Now())
			reply(w, map[string]bool{"ok": true}, err)
		}
	})
}
