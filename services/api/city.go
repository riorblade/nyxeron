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
//	POST   /api/city/stock                 {token, qty} → buy stock for my shop at the market's price
//	PUT    /api/city/shop                  {open?, prices?} → open/close my shop, set shelf prices
//	POST   /api/city/shops/{lease}/buy     {token, qty} → buy from someone's shop
//	POST   /api/city/parties               {startsAt, minutes?, title?} → schedule a party at my venue
//	DELETE /api/city/parties/{id}          → cancel my party
//	PUT    /api/city/parties/{id}/room     {room} → my party is live in this relay room
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

type PartyView struct {
	ID        int64  `json:"id"`
	LeaseID   int64  `json:"leaseId"`
	Level     int    `json:"level"`
	Slot      int    `json:"slot"`
	Club      string `json:"club"`
	Owner     string `json:"owner"`
	Title     string `json:"title"`
	StartsAt  int64  `json:"startsAt"`
	Minutes   int    `json:"minutes"`
	Room      string `json:"room"`
	Live      bool   `json:"live"`
	Cancelled bool   `json:"cancelled,omitempty"`
	Mine      bool   `json:"mine,omitempty"`
}

type CityView struct {
	Venues  []VenueView      `json:"venues"`
	Parties []PartyView      `json:"parties"`
	Rent    map[string]int64 `json:"rent"`
	Now     int64            `json:"now"`
	// Prices[level][token]: what stock costs, the usual shelf price and the most a shop may ask, right now.
	Prices map[string]map[string]PriceRow `json:"prices,omitempty"`
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

// City: every venue with its tenant (if any) and shop, and the parties that haven't ended. `viewer` marks what is
// theirs; `admin` adds who the tenants are.
func (s *store) City(ctx context.Context, viewer string, admin bool, now time.Time) (CityView, error) {
	v := CityView{Rent: s.Rent(ctx), Now: now.Unix(), Venues: []VenueView{}, Parties: []PartyView{}}
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
		for slot := 1; slot <= game.city.Venues[lv(level)].Count; slot++ {
			v.Venues = append(v.Venues, VenueView{Level: level, Slot: slot, Lease: byVenue[[2]int{level, slot}]})
		}
	}
	v.Parties, err = s.parties(ctx, viewer, admin, now, `p.starts_at + p.minutes * 60 > ? AND p.cancelled = 0`, now.Unix())
	return v, err
}

func (s *store) parties(ctx context.Context, viewer string, admin bool, now time.Time, where string, args ...any) ([]PartyView, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.lease_id, l.level, l.slot, l.club, u.name, l.user_id, p.title, p.starts_at,
		p.minutes, p.room, p.cancelled FROM parties p JOIN leases l ON l.id = p.lease_id JOIN users u ON u.id = l.user_id
		WHERE `+where+` ORDER BY p.starts_at LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PartyView{}
	for rows.Next() {
		var p PartyView
		var owner string
		var cancelled int
		if err := rows.Scan(&p.ID, &p.LeaseID, &p.Level, &p.Slot, &p.Club, &p.Owner, &owner, &p.Title, &p.StartsAt,
			&p.Minutes, &p.Room, &cancelled); err != nil {
			return nil, err
		}
		p.Cancelled, p.Mine = cancelled == 1, owner == viewer
		p.Live = !p.Cancelled && now.Unix() >= p.StartsAt && now.Unix() < p.StartsAt+int64(p.Minutes)*60
		if !p.Live && !admin && !p.Mine {
			p.Room = "" // the code only matters while it's on
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type activeLease struct {
	id          int64
	level, slot int
	endsAt      int64
}

func myLease(t *sql.Tx, id string, now time.Time) (activeLease, error) {
	var l activeLease
	err := t.QueryRow(`SELECT id, level, slot, ends_at FROM leases WHERE user_id = ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1`,
		id, now.Unix()).Scan(&l.id, &l.level, &l.slot, &l.endsAt)
	if errors.Is(err, sql.ErrNoRows) {
		return l, errNoLease
	}
	return l, err
}

var errNoLease = errors.New("no venue rented")

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

// Lease rents a venue (slot 0: the first free one of that level) for whole weeks, or extends the player's own.
// One venue per player at a time; at most maxWeeksAhead paid ahead.
func (s *store) Lease(ctx context.Context, id string, level, slot int, club string, weeks int, now time.Time) (p Profile, err error) {
	club, ok := cleanName(club)
	v, known := game.city.Venues[lv(level)]
	if !ok || !known || slot < 0 || slot > v.Count || weeks < 1 || weeks > game.city.MaxWeeksAhead {
		return p, errBad
	}
	rent := s.Rent(ctx)[lv(level)] * int64(weeks)
	week := int64(game.city.LeaseDays) * 86400
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		mine, e := myLease(t, id, now)
		switch {
		case e == nil && (mine.level != level || (slot != 0 && slot != mine.slot)):
			return errConflict // already renting another venue
		case e == nil:
			// Extend: from when the current lease ends.
			if mine.endsAt+int64(weeks)*week > now.Unix()+int64(game.city.MaxWeeksAhead)*week {
				return errRejected
			}
			if e := pay(t, id, rent, "rent", "extend"); e != nil {
				return e
			}
			if _, e := t.Exec(`UPDATE leases SET ends_at = ends_at + ?, rent = rent + ?, club = CASE WHEN ? != '' THEN ? ELSE club END
				WHERE id = ?`, int64(weeks)*week, rent, club, club, mine.id); e != nil {
				return e
			}
		case errors.Is(e, errNoLease):
			if club == "" {
				return errBad
			}
			if slot == 0 {
				e := t.QueryRow(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
					SELECT x FROM n WHERE x NOT IN (SELECT slot FROM leases WHERE level = ? AND ends_at > ?) LIMIT 1`,
					v.Count, level, now.Unix()).Scan(&slot)
				if errors.Is(e, sql.ErrNoRows) {
					return errConflict // all taken
				} else if e != nil {
					return e
				}
			}
			var taken int
			if e := t.QueryRow(`SELECT COUNT(*) FROM leases WHERE level = ? AND slot = ? AND ends_at > ?`,
				level, slot, now.Unix()).Scan(&taken); e != nil {
				return e
			}
			if taken > 0 {
				return errConflict
			}
			if e := pay(t, id, rent, "rent", game.levels[lv(level)].Name); e != nil {
				return e
			}
			if _, e := t.Exec(`INSERT INTO leases (level, slot, user_id, club, rent, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				level, slot, id, club, rent, now.Unix(), now.Unix()+int64(weeks)*week); e != nil {
				return e
			}
		default:
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

// Stock buys units for the player's shop at the market's price; they must fit the venue's storage.
func (s *store) Stock(ctx context.Context, id, token string, qty int64, f factorFn, now time.Time) (p Profile, err error) {
	tok, known := game.tokens[token]
	if !known || qty < 1 || qty > 10_000 {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := myLease(t, id, now)
		if e != nil {
			return e
		}
		if tok.MinLevel > l.level {
			return errRejected
		}
		var held int64
		if e := t.QueryRow(`SELECT COALESCE(SUM(qty), 0) FROM shop_stock WHERE user_id = ?`, id).Scan(&held); e != nil {
			return e
		}
		if held+qty > game.levels[lv(l.level)].Storage {
			return errRejected
		}
		factor := f(token)
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

// SetShop opens or closes the player's shop and sets shelf prices (up to maxMarkup times the usual price).
func (s *store) SetShop(ctx context.Context, id string, open *bool, prices map[string]int64, f factorFn, now time.Time) error {
	return s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := myLease(t, id, now)
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

// Party schedules a party at the player's venue (Level 3+), inside the lease, not overlapping another of theirs.
func (s *store) Party(ctx context.Context, id string, startsAt int64, minutes int, title string, now time.Time) (PartyView, error) {
	pc := game.city.Party
	if minutes == 0 {
		minutes = pc.DefaultMinutes
	}
	title, ok := cleanName(title)
	if !ok || minutes < pc.MinMinutes || minutes > pc.MaxMinutes ||
		startsAt < now.Unix()-60 || startsAt > now.Unix()+int64(pc.MaxAheadDays)*86400 {
		return PartyView{}, errBad
	}
	startsAt = max(startsAt, now.Unix())
	end := startsAt + int64(minutes)*60
	var pid int64
	err := s.tx(ctx, id, func(t *sql.Tx) error {
		l, e := myLease(t, id, now)
		if e != nil {
			return e
		}
		if l.level < pc.MinLevel || end > l.endsAt {
			return errRejected
		}
		var clash int
		if e := t.QueryRow(`SELECT COUNT(*) FROM parties WHERE lease_id = ? AND cancelled = 0
			AND starts_at < ? AND starts_at + minutes * 60 > ?`, l.id, end, startsAt).Scan(&clash); e != nil {
			return e
		}
		if clash > 0 {
			return errConflict
		}
		res, e := t.Exec(`INSERT INTO parties (lease_id, title, starts_at, minutes, created_at) VALUES (?, ?, ?, ?, ?)`,
			l.id, title, startsAt, minutes, now.Unix())
		if e != nil {
			return e
		}
		pid, e = res.LastInsertId()
		return e
	})
	if err != nil {
		return PartyView{}, err
	}
	list, err := s.parties(ctx, id, false, now, `p.id = ?`, pid)
	if err != nil || len(list) == 0 {
		return PartyView{}, err
	}
	return list[0], nil
}

// partyOwner: who rents the venue a party is at.
func (s *store) partyOwner(ctx context.Context, pid int64) (string, error) {
	var owner string
	err := s.db.QueryRowContext(ctx, `SELECT l.user_id FROM parties p JOIN leases l ON l.id = p.lease_id WHERE p.id = ?`, pid).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errNotFound
	}
	return owner, err
}

func (s *store) CancelParty(ctx context.Context, id string, pid int64) error {
	if owner, err := s.partyOwner(ctx, pid); err != nil || owner != id {
		return errNotFound
	}
	_, err := s.db.ExecContext(ctx, `UPDATE parties SET cancelled = 1 WHERE id = ?`, pid)
	return err
}

// PartyRoom: the host opened the relay room for their party (from 15 minutes before it starts until it ends).
func (s *store) PartyRoom(ctx context.Context, id string, pid int64, room string, now time.Time) error {
	room = strings.ToUpper(strings.TrimSpace(room))
	if len(room) < 4 || len(room) > 8 || strings.Trim(room, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != "" {
		return errBad
	}
	if owner, err := s.partyOwner(ctx, pid); err != nil || owner != id {
		return errNotFound
	}
	res, err := s.db.ExecContext(ctx, `UPDATE parties SET room = ? WHERE id = ? AND cancelled = 0
		AND starts_at - 900 <= ? AND starts_at + minutes * 60 > ?`, room, pid, now.Unix(), now.Unix())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errRejected
	}
	return nil
}

// partyHost: whose live party a guest was at (by relay room), for paying out what they spent; "" if none.
func partyHost(t *sql.Tx, room string, now time.Time) string {
	if room == "" {
		return ""
	}
	var host string
	grace := int64(game.city.Party.SettleGraceMinutes) * 60
	_ = t.QueryRow(`SELECT l.user_id FROM parties p JOIN leases l ON l.id = p.lease_id WHERE p.room = ? AND p.cancelled = 0
		AND p.starts_at - 900 <= ? AND p.starts_at + p.minutes * 60 + ? > ? ORDER BY p.starts_at DESC LIMIT 1`,
		strings.ToUpper(room), now.Unix(), grace, now.Unix()).Scan(&host)
	return host
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
			Open   *bool
			Prices map[string]int64
		}
		if ok && body(w, r, &in) {
			err := pl.db.SetShop(r.Context(), id, in.Open, in.Prices, pl.factor(r.Context()), time.Now())
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
	mux.HandleFunc("POST /api/city/parties", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct {
			StartsAt int64
			Minutes  int
			Title    string
		}
		if ok && body(w, r, &in) {
			p, err := pl.db.Party(r.Context(), id, in.StartsAt, in.Minutes, in.Title, time.Now())
			reply(w, p, err)
		}
	})
	mux.HandleFunc("DELETE /api/city/parties/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			pid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
			reply(w, map[string]bool{"ok": true}, pl.db.CancelParty(r.Context(), id, pid))
		}
	})
	mux.HandleFunc("PUT /api/city/parties/{id}/room", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct{ Room string }
		if ok && body(w, r, &in) {
			pid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
			reply(w, map[string]bool{"ok": true}, pl.db.PartyRoom(r.Context(), id, pid, in.Room, time.Now()))
		}
	})
}
