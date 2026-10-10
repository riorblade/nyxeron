package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite" // pure Go: no CGO, stays a static binary on the scratch image
)

// Player data, kept by the server and keyed by the verified Privy id. SQLite in WAL mode on a volume: one file, no
// separate database server (Postgres alone would use more RAM than everything else here together).
//
// The server owns the game wallet: the browser asks for changes and the rules below decide. Game constants mirror
// packages/core/src/data (a test checks they stay in sync).
const (
	startWallet = 20_000           // strategy.json → visitor.startWallet
	refillBelow = startWallet / 10 // a broke guest may claim the starter wallet again
	maxGigFee   = 12_000           // highest djFee in scenarios.json → events
	gigEvery    = 5 * time.Minute  // a gig takes ~10 real minutes; this stops fee farming
	nightEvery  = time.Minute      // one settled night out per minute: stops replays and the spend → refill loop
	maxImport   = 10_000_000       // ceiling for a wallet brought over from before accounts
	maxName     = 20
)

// tokenIDs are the game's tokens (tokens.json); anything else is rejected.
var tokenIDs = map[string]bool{
	"tsla": true, "us500": true, "nvda": true, "bigtech": true,
	"aisemis": true, "dividend": true, "skhy": true, "spcx": true,
}

type Holding struct {
	Qty  int64 `json:"qty"`
	Cost int64 `json:"cost"`
}

type Profile struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	Avatar    int                `json:"avatar"`
	Wallet    int64              `json:"wallet"`
	Portfolio map[string]Holding `json:"portfolio"`
	Nights    int                `json:"nights"`
	Gigs      int                `json:"gigs"`
	TotalPnl  int64              `json:"totalPnl"`
	BestPnl   int64              `json:"bestPnl"`
	// Imported: the one-time import of this device's pre-account data is used up (or any change happened).
	Imported bool `json:"imported"`
	// Set from the back office: the highest venue level this player may start a career at (1 = the normal
	// ladder), and a ban.
	UnlockLevel int    `json:"unlockLevel"`
	Banned      bool   `json:"banned"`
	BanReason   string `json:"banReason,omitempty"`
}

var (
	errRejected = errors.New("rejected") // breaks a game rule
	errConflict = errors.New("conflict") // already done / too soon
	errBad      = errors.New("bad request")
)

type store struct{ db *sql.DB }

func openStore(path string) (*store, error) {
	db, err := sql.Open("sqlite", "file:"+path+
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// ponytail: one connection serialises writes (SQLite has one writer anyway); fine for thousands of players.
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`
CREATE TABLE IF NOT EXISTS users (
	id         TEXT PRIMARY KEY,
	name       TEXT    NOT NULL DEFAULT '',
	avatar     INTEGER NOT NULL DEFAULT 1,
	wallet     INTEGER NOT NULL,
	nights     INTEGER NOT NULL DEFAULT 0,
	gigs       INTEGER NOT NULL DEFAULT 0,
	total_pnl  INTEGER NOT NULL DEFAULT 0,
	best_pnl   INTEGER NOT NULL DEFAULT 0,
	imported   INTEGER NOT NULL DEFAULT 0,
	last_gig   INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolio (
	user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token   TEXT    NOT NULL,
	qty     INTEGER NOT NULL,
	cost    INTEGER NOT NULL,
	PRIMARY KEY (user_id, token)
);` + docsSchema)
	if err == nil {
		err = migrate(db)
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return &store{db}, nil
}

func (s *store) close() error { return s.db.Close() }

// backup writes a consistent copy next to the database (VACUUM INTO works while the game is live) and keeps the
// newest `keep` copies.
func (s *store) backup(dir string, now time.Time, keep int) error {
	name := filepath.Join(dir, "backup-"+now.UTC().Format("20060102")+".db")
	_ = os.Remove(name) // VACUUM INTO won't overwrite
	if _, err := s.db.Exec(`VACUUM INTO ?`, name); err != nil {
		return err
	}
	old, _ := filepath.Glob(filepath.Join(dir, "backup-*.db"))
	sort.Strings(old)
	for len(old) > keep {
		_ = os.Remove(old[0])
		old = old[1:]
	}
	return nil
}

// tx runs fn in a transaction with the player's row created if it is new.
func (s *store) tx(ctx context.Context, id string, fn func(*sql.Tx) error) error {
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	now := time.Now().Unix()
	if _, err := t.Exec(`INSERT OR IGNORE INTO users (id, wallet, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		id, startWallet, now, now); err != nil {
		return err
	}
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit()
}

func read(t *sql.Tx, id string) (Profile, error) {
	p := Profile{ID: id, Portfolio: map[string]Holding{}}
	var imported, banned int
	err := t.QueryRow(`SELECT name, avatar, wallet, nights, gigs, total_pnl, best_pnl, imported, unlock_level, banned, ban_reason
		FROM users WHERE id = ?`, id).
		Scan(&p.Name, &p.Avatar, &p.Wallet, &p.Nights, &p.Gigs, &p.TotalPnl, &p.BestPnl, &imported, &p.UnlockLevel, &banned, &p.BanReason)
	if err != nil {
		return p, err
	}
	p.Imported = imported == 1
	p.Banned = banned == 1
	rows, err := t.Query(`SELECT token, qty, cost FROM portfolio WHERE user_id = ?`, id)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		var tok string
		var h Holding
		if err := rows.Scan(&tok, &h.Qty, &h.Cost); err != nil {
			return p, err
		}
		p.Portfolio[tok] = h
	}
	return p, rows.Err()
}

// touch marks a change: bumps updated_at and closes the one-time import.
func touch(t *sql.Tx, id string) error {
	_, err := t.Exec(`UPDATE users SET imported = 1, updated_at = ? WHERE id = ?`, time.Now().Unix(), id)
	return err
}

// ledger records a wallet change (and the balance after it), so every coin can be traced: nights, gigs,
// refills, the one-time import and admin grants.
func ledger(t *sql.Tx, id string, delta int64, kind, actor, reason string) error {
	if delta == 0 {
		return nil
	}
	_, err := t.Exec(`INSERT INTO ledger (user_id, delta, balance, kind, actor, reason, at)
		SELECT id, ?, wallet, ?, ?, ?, ? FROM users WHERE id = ?`, delta, kind, actor, reason, time.Now().Unix(), id)
	return err
}

// creditKinds: why credits (paid, backed by real money) may change. Coin paths never use these.
var creditKinds = map[string]bool{"topup": true, "hold": true, "refund": true, "sale": true, "margin": true,
	"wholesale": true, "rent": true}

// creditLedger is the only way a player's credits change: it moves the balance (never below zero) and writes the
// ledger row, both in the caller's transaction, next to its cause.
func creditLedger(t *sql.Tx, id string, delta int64, kind, actor, reason string) error {
	if delta == 0 {
		return nil
	}
	if !creditKinds[kind] {
		return fmt.Errorf("credit ledger: unknown kind %q", kind)
	}
	res, err := t.Exec(`UPDATE users SET credits = credits + ? WHERE id = ? AND credits + ? >= 0`, delta, id, delta)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errRejected // no such player, or not enough credits
	}
	_, err = t.Exec(`INSERT INTO ledger (user_id, delta, balance, kind, actor, reason, at, currency)
		SELECT id, ?, credits, ?, ?, ?, ?, 'credit' FROM users WHERE id = ?`, delta, kind, actor, reason, time.Now().Unix(), id)
	return err
}

// platformLedger records the platform's own money, in credits: top-up fees, rent and wholesale proceeds in, the seed
// for the first stock in, USDC spent on restocks out. Reconciliation subtracts it from the Agentic Wallet.
func platformLedger(t *sql.Tx, delta int64, kind, ref, reason string) error {
	_, err := t.Exec(`INSERT INTO platform_ledger (delta, kind, ref, reason, at) VALUES (?, ?, ?, ?, ?)`,
		delta, kind, ref, reason, time.Now().Unix())
	return err
}

func cleanName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) || strings.ContainsAny(s, "\x00\n\r\t") {
		return "", false
	}
	if r := []rune(s); len(r) > maxName {
		s = string(r[:maxName])
	}
	return s, true
}

func validHoldings(h map[string]Holding) bool {
	for tok, x := range h {
		if !tokenIDs[tok] || x.Qty <= 0 || x.Cost < 0 || x.Qty > 1_000_000 || x.Cost > maxImport {
			return false
		}
	}
	return true
}

func addHoldings(t *sql.Tx, id string, h map[string]Holding) error {
	for tok, x := range h {
		if _, err := t.Exec(`INSERT INTO portfolio (user_id, token, qty, cost) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id, token) DO UPDATE SET qty = qty + excluded.qty, cost = cost + excluded.cost`,
			id, tok, x.Qty, x.Cost); err != nil {
			return err
		}
	}
	return nil
}

// Get returns the player's profile (a new player starts with the starter wallet).
func (s *store) Get(ctx context.Context, id string) (p Profile, err error) {
	err = s.tx(ctx, id, func(t *sql.Tx) (e error) { p, e = read(t, id); return })
	return
}

// Import brings this device's pre-account profile over, once, within sane bounds.
func (s *store) Import(ctx context.Context, id string, in Profile) (p Profile, err error) {
	name, ok := cleanName(in.Name)
	if !ok || in.Avatar < 1 || in.Avatar > 10 || in.Wallet < 0 || in.Wallet > maxImport ||
		in.Nights < 0 || in.Nights > 100_000 || in.Gigs < 0 || in.Gigs > 100_000 || !validHoldings(in.Portfolio) {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		cur, e := read(t, id)
		if e != nil {
			return e
		}
		if cur.Imported {
			return errConflict
		}
		if _, e := t.Exec(`UPDATE users SET name = ?, avatar = ?, wallet = ?, nights = ?, gigs = ?, total_pnl = ?, best_pnl = ? WHERE id = ?`,
			name, in.Avatar, in.Wallet, in.Nights, in.Gigs, clamp(in.TotalPnl), clamp(in.BestPnl), id); e != nil {
			return e
		}
		if e := ledger(t, id, in.Wallet-cur.Wallet, "import", "", ""); e != nil {
			return e
		}
		if e := addHoldings(t, id, in.Portfolio); e != nil {
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

func clamp(v int64) int64 { return max(-maxImport, min(maxImport, v)) }

// Update sets the name and/or avatar.
func (s *store) Update(ctx context.Context, id string, name *string, avatar *int) (p Profile, err error) {
	if name != nil {
		n, ok := cleanName(*name)
		if !ok {
			return p, errBad
		}
		name = &n
	}
	if avatar != nil && (*avatar < 1 || *avatar > 10) {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		if name != nil {
			if _, e := t.Exec(`UPDATE users SET name = ? WHERE id = ?`, *name, id); e != nil {
				return e
			}
		}
		if avatar != nil {
			if _, e := t.Exec(`UPDATE users SET avatar = ? WHERE id = ?`, *avatar, id); e != nil {
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

// Refill gives a broke guest the starter wallet again.
func (s *store) Refill(ctx context.Context, id string) (p Profile, err error) {
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		var before int64
		if e := t.QueryRow(`SELECT wallet FROM users WHERE id = ?`, id).Scan(&before); e != nil {
			return e
		}
		if before >= refillBelow {
			return errRejected
		}
		if _, e := t.Exec(`UPDATE users SET wallet = ? WHERE id = ?`, startWallet, id); e != nil {
			return e
		}
		if e := ledger(t, id, startWallet-before, "refill", "", ""); e != nil {
			return e
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

// nightValueCap: the most the tokens a guest bought can be worth by the end of the night. The desk sells at
// max(1, round(list × m)) and marks holdings the same way, with m within strategy.json's market range [lo, hi], so a
// unit bought at b is worth at most (hi/lo)·b + (hi/(2·lo) + ½) by closing (the second term covers the rounding).
func nightValueCap(bought map[string]Holding) int64 {
	lo, hi := game.strategy.Market.Range[0], game.strategy.Market.Range[1]
	var v int64
	for _, h := range bought {
		v += int64(math.Ceil(float64(h.Cost)*hi/lo + float64(h.Qty)*(hi/(2*lo)+0.5)))
	}
	return v
}

// Night settles a night out as a guest. Guests only spend (door + tokens), so the wallet can't grow, and the tokens
// taken home can't have cost more than what was spent. Every unit cost at least 1 (the desk's floor price), the
// P&L can't beat what the market range lets those tokens be worth, `room` is a relay code or empty, and an account
// settles at most one night per nightEvery. It is play money everywhere: since the cutover a city party's real sales
// go through the api in credits (sales.go), so nobody is paid Coin for a guest's night.
func (s *store) Night(ctx context.Context, id string, cash int64, bought map[string]Holding, pnl int64, room string, now time.Time) (p Profile, err error) {
	room = strings.ToUpper(strings.TrimSpace(room))
	if cash < 0 || !validHoldings(bought) || (room != "" && !validRoom(room)) {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		cur, e := read(t, id)
		if e != nil {
			return e
		}
		var last int64
		if e := t.QueryRow(`SELECT COALESCE(MAX(at), 0) FROM ledger WHERE user_id = ? AND kind = 'night'`, id).
			Scan(&last); e != nil {
			return e
		}
		if last > 0 && now.Sub(time.Unix(last, 0)) < nightEvery {
			return errConflict
		}
		var cost int64
		for _, h := range bought {
			if h.Cost < h.Qty {
				return errRejected // under the desk's floor price of 1 a unit
			}
			cost += h.Cost
		}
		spent := cur.Wallet - cash
		if cash > cur.Wallet || cost > spent || pnl > nightValueCap(bought)-spent || pnl < -cur.Wallet {
			return errRejected
		}
		best := pnl
		if cur.Nights > 0 {
			best = max(cur.BestPnl, pnl)
		}
		if _, e := t.Exec(`UPDATE users SET wallet = ?, nights = nights + 1, total_pnl = total_pnl + ?, best_pnl = ? WHERE id = ?`,
			cash, pnl, best, id); e != nil {
			return e
		}
		// Written even when nothing was spent: the row is also when this account last settled a night.
		if _, e := t.Exec(`INSERT INTO ledger (user_id, delta, balance, kind, actor, reason, at)
			SELECT id, ?, wallet, 'night', '', ?, ? FROM users WHERE id = ?`,
			cash-cur.Wallet, room, now.Unix(), id); e != nil {
			return e
		}
		if e := addHoldings(t, id, bought); e != nil {
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

// Gig pays a DJ fee: within the highest fee a club offers, and not more often than a gig can be played.
func (s *store) Gig(ctx context.Context, id string, fee int64, now time.Time) (p Profile, err error) {
	if fee < 0 || fee > maxGigFee {
		return p, errBad
	}
	err = s.tx(ctx, id, func(t *sql.Tx) error {
		var last int64
		if e := t.QueryRow(`SELECT last_gig FROM users WHERE id = ?`, id).Scan(&last); e != nil {
			return e
		}
		if last > 0 && now.Sub(time.Unix(last, 0)) < gigEvery {
			return errConflict
		}
		if _, e := t.Exec(`UPDATE users SET wallet = wallet + ?, gigs = gigs + 1, last_gig = ? WHERE id = ?`,
			fee, now.Unix(), id); e != nil {
			return e
		}
		if e := ledger(t, id, fee, "gig", "", ""); e != nil {
			return e
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
