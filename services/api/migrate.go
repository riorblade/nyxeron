package main

import (
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

// Schema changes after the first release, applied once each, in order, inside a transaction. PRAGMA user_version
// records how far a database has come, so a live database upgrades in place and keeps its data.
var migrations = []string{
	// 1 — back office: identity for search, entitlements, moderation, activity, coin history, admins, audit log.
	`ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
	ALTER TABLE users ADD COLUMN wallet_address TEXT NOT NULL DEFAULT '';
	ALTER TABLE users ADD COLUMN unlock_level INTEGER NOT NULL DEFAULT 1;
	ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
	ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
	CREATE INDEX users_email ON users(email);
	CREATE TABLE ledger (
		id      INTEGER PRIMARY KEY,
		user_id TEXT    NOT NULL,
		delta   INTEGER NOT NULL,
		balance INTEGER NOT NULL,
		kind    TEXT    NOT NULL,
		actor   TEXT    NOT NULL DEFAULT '',
		reason  TEXT    NOT NULL DEFAULT '',
		at      INTEGER NOT NULL
	);
	CREATE INDEX ledger_user ON ledger(user_id, id);
	CREATE TABLE admins (
		email      TEXT PRIMARY KEY,
		role       TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
		granted_by TEXT NOT NULL,
		at         INTEGER NOT NULL
	);
	CREATE TABLE audit (
		id     INTEGER PRIMARY KEY,
		actor  TEXT    NOT NULL,
		action TEXT    NOT NULL,
		target TEXT    NOT NULL DEFAULT '',
		detail TEXT    NOT NULL DEFAULT '{}',
		reason TEXT    NOT NULL DEFAULT '',
		at     INTEGER NOT NULL
	);
	CREATE INDEX audit_target ON audit(target, id);
	CREATE TABLE settings (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);`,
	// 2 — the city: weekly venue leases, shop stock (the player's, moves with them), scheduled parties.
	`CREATE TABLE leases (
		id        INTEGER PRIMARY KEY,
		level     INTEGER NOT NULL,
		slot      INTEGER NOT NULL,
		user_id   TEXT    NOT NULL,
		club      TEXT    NOT NULL,
		rent      INTEGER NOT NULL,
		starts_at INTEGER NOT NULL,
		ends_at   INTEGER NOT NULL,
		open      INTEGER NOT NULL DEFAULT 1
	);
	CREATE INDEX leases_venue ON leases(level, slot, ends_at);
	CREATE INDEX leases_user ON leases(user_id, ends_at);
	CREATE TABLE shop_stock (
		user_id TEXT    NOT NULL,
		token   TEXT    NOT NULL,
		qty     INTEGER NOT NULL,
		price   INTEGER NOT NULL,
		PRIMARY KEY (user_id, token)
	);
	CREATE TABLE parties (
		id         INTEGER PRIMARY KEY,
		lease_id   INTEGER NOT NULL,
		title      TEXT    NOT NULL DEFAULT '',
		starts_at  INTEGER NOT NULL,
		minutes    INTEGER NOT NULL,
		room       TEXT    NOT NULL DEFAULT '',
		cancelled  INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX parties_time ON parties(starts_at);
	CREATE INDEX parties_room ON parties(room);`,
	// 3 — the platform's warehouse (CEOs stock from it; the back office and the agent restock it) and every
	// movement in and out, for demand and the audit trail.
	`CREATE TABLE platform_stock (
		token      TEXT PRIMARY KEY,
		qty        INTEGER NOT NULL CHECK (qty >= 0),
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE stock_moves (
		id      INTEGER PRIMARY KEY,
		token   TEXT    NOT NULL,
		delta   INTEGER NOT NULL,
		kind    TEXT    NOT NULL,
		user_id TEXT    NOT NULL DEFAULT '',
		actor   TEXT    NOT NULL DEFAULT '',
		reason  TEXT    NOT NULL DEFAULT '',
		tx      TEXT    NOT NULL DEFAULT '',
		at      INTEGER NOT NULL
	);
	CREATE INDEX stock_moves_token ON stock_moves(token, kind, at);`,
	// 4 — events: city parties become events at any club (practice clubs have no lease), public or private,
	// with an invite code; RSVPs.
	`ALTER TABLE parties ADD COLUMN host_id TEXT NOT NULL DEFAULT '';
	ALTER TABLE parties ADD COLUMN club TEXT NOT NULL DEFAULT '';
	ALTER TABLE parties ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
	ALTER TABLE parties ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE parties ADD COLUMN invite TEXT NOT NULL DEFAULT '';
	UPDATE parties SET
		host_id = COALESCE((SELECT user_id FROM leases WHERE leases.id = parties.lease_id), ''),
		level = COALESCE((SELECT level FROM leases WHERE leases.id = parties.lease_id), 1),
		invite = lower(hex(randomblob(5)));
	CREATE UNIQUE INDEX parties_invite ON parties(invite);
	CREATE INDEX parties_host ON parties(host_id, starts_at);
	CREATE TABLE rsvps (
		party_id INTEGER NOT NULL,
		user_id  TEXT    NOT NULL,
		at       INTEGER NOT NULL,
		PRIMARY KEY (party_id, user_id)
	);`,
	// 5 — real money (docs/payments.md), kept apart from play money: credits (paid, minted only by verified
	// top-ups) next to Coin, real units next to the play portfolio, top-ups, party/shop sales and the price lists
	// (a party's, locked when it starts; a shop's), units reserved in the warehouse during a party, and the platform's own money. Credits and platform money are in credits
	// (1 = $0.01); top-up amounts also as the token's base units (18 decimals: too big for an INTEGER).
	`ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0);
	ALTER TABLE ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'coin' CHECK (currency IN ('coin', 'credit'));
	CREATE TABLE backed_units (
		user_id TEXT    NOT NULL,
		token   TEXT    NOT NULL,
		qty     INTEGER NOT NULL CHECK (qty >= 0),
		PRIMARY KEY (user_id, token)
	);
	CREATE TABLE topups (
		id         INTEGER PRIMARY KEY,
		tx         TEXT    NOT NULL COLLATE NOCASE,
		log_index  INTEGER NOT NULL,
		user_id    TEXT    NOT NULL DEFAULT '',
		sender     TEXT    NOT NULL,
		token      TEXT    NOT NULL,
		amount     TEXT    NOT NULL,
		usd_cents  INTEGER NOT NULL CHECK (usd_cents >= 0),
		fee        INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
		gas_used   INTEGER NOT NULL DEFAULT 0,
		credits    INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
		status     TEXT    NOT NULL CHECK (status IN ('pending', 'credited', 'unknown', 'rejected')),
		reason     TEXT    NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE (tx, log_index)
	);
	CREATE INDEX topups_user ON topups(user_id, created_at);
	CREATE TABLE sales (
		id         INTEGER PRIMARY KEY,
		party_id   INTEGER NOT NULL DEFAULT 0,
		lease_id   INTEGER NOT NULL DEFAULT 0,
		buyer      TEXT    NOT NULL,
		seller     TEXT    NOT NULL,
		token      TEXT    NOT NULL,
		qty        INTEGER NOT NULL CHECK (qty > 0),
		price      INTEGER NOT NULL CHECK (price > 0),
		wholesale  INTEGER NOT NULL CHECK (wholesale > 0),
		status     TEXT    NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'void')),
		created_at INTEGER NOT NULL,
		settled_at INTEGER NOT NULL DEFAULT 0,
		CHECK ((party_id > 0) + (lease_id > 0) = 1),
		CHECK (price >= wholesale)
	);
	CREATE INDEX sales_party ON sales(party_id, status);
	CREATE INDEX sales_status ON sales(status, created_at);
	CREATE TABLE party_prices (
		party_id INTEGER NOT NULL,
		token    TEXT    NOT NULL,
		price    INTEGER NOT NULL CHECK (price > 0),
		PRIMARY KEY (party_id, token)
	);
	CREATE TABLE shop_prices (
		lease_id INTEGER NOT NULL,
		token    TEXT    NOT NULL,
		price    INTEGER NOT NULL CHECK (price > 0),
		PRIMARY KEY (lease_id, token)
	);
	ALTER TABLE platform_stock ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0);
	CREATE TABLE platform_ledger (
		id     INTEGER PRIMARY KEY,
		delta  INTEGER NOT NULL,
		kind   TEXT    NOT NULL CHECK (kind IN ('fee', 'wholesale', 'rent', 'seed', 'restock')),
		ref    TEXT    NOT NULL DEFAULT '',
		reason TEXT    NOT NULL DEFAULT '',
		at     INTEGER NOT NULL
	);`,
	// 6 — the cutover: the city runs on credits. The warehouse keeps only units bought by swaps verified on BSC
	// (a restock whose tx is in platform_ledger); the units typed in by hand (100 per token on 2026-10-02) aren't
	// real stock and go, each removal written as a stock move. Nothing is reserved before the cutover. Coin shops
	// are gone too: what CEOs still hold on their shelves is bought back in NYX Points at their own shelf price,
	// one ledger row per player, and the shelves are emptied.
	// Edited after it ran in production (#38): units reserved for held sales count against the verified ones
	// (on hand + reserved never exceeds them), and a shelf with no positive price buys nothing back. Production
	// had nothing reserved and no such shelf when it ran, so only fresh databases (and the tests) see the change.
	`CREATE TEMP TABLE verified AS
		SELECT ps.token, COALESCE((SELECT SUM(m.delta) FROM stock_moves m WHERE m.token = ps.token AND m.kind = 'restock'
			AND m.tx != '' AND m.tx IN (SELECT ref FROM platform_ledger WHERE kind = 'restock')), 0) AS units
		FROM platform_stock ps;
	INSERT INTO stock_moves (token, delta, kind, actor, reason, at)
		SELECT ps.token, MAX(0, MIN(ps.qty, v.units - ps.reserved)) - ps.qty, 'adjust', 'cutover',
			'hand-entered units are not real stock', CAST(strftime('%s', 'now') AS INTEGER)
		FROM platform_stock ps JOIN verified v ON v.token = ps.token WHERE ps.qty > MAX(0, MIN(ps.qty, v.units - ps.reserved));
	UPDATE platform_stock SET qty = MAX(0, MIN(qty, (SELECT units FROM verified WHERE verified.token = platform_stock.token) - reserved)),
		updated_at = CAST(strftime('%s', 'now') AS INTEGER);
	DROP TABLE verified;
	CREATE TEMP TABLE buyback AS
		SELECT user_id, SUM(qty * price) AS np, group_concat(qty || ' ' || upper(token), ', ') AS what
		FROM shop_stock WHERE qty > 0 AND price > 0 GROUP BY user_id;
	UPDATE users SET wallet = wallet + (SELECT np FROM buyback WHERE buyback.user_id = users.id)
		WHERE id IN (SELECT user_id FROM buyback);
	INSERT INTO ledger (user_id, delta, balance, kind, actor, reason, at)
		SELECT b.user_id, b.np, u.wallet, 'buyback', 'cutover', 'Coin shop closed, shelf bought back: ' || b.what,
			CAST(strftime('%s', 'now') AS INTEGER)
		FROM buyback b JOIN users u ON u.id = b.user_id WHERE b.np > 0;
	DELETE FROM shop_stock;
	DROP TABLE buyback;`,
	// 7 — money owed back to senders, in cents: an unknown sender's transfer, a rejected top-up, or the part of a
	// credited one over the caps. It sits in the Agentic Wallet but backs nobody's credits, so reconciliation counts
	// it as owed until the back office marks it refunded (refunded_at). Existing rows: what their reason says
	// ("N cents …"; a seed's reason is "seed", so 0), or the whole amount while the sender is unknown, except in a
	// tx the platform booked as a restock or seed (a swap's change: the platform's own money). Re-runnable: on a
	// database that has the columns already, the backfill is skipped (onceMark), so what the scanner recorded since,
	// a swap's change at 0 included, stays as it is.
	`ALTER TABLE topups ADD COLUMN refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0);
	ALTER TABLE topups ADD COLUMN refunded_at INTEGER NOT NULL DEFAULT 0;
	` + onceMark + `
	UPDATE topups SET refund_cents = CASE
		WHEN tx IN (SELECT ref FROM platform_ledger WHERE kind IN ('restock', 'seed')) THEN 0
		WHEN status = 'unknown' THEN usd_cents
		WHEN status IN ('rejected', 'credited') THEN MAX(0, CAST(reason AS INTEGER))
		ELSE 0 END
		WHERE refund_cents = 0 AND refunded_at = 0;`,
	// 8 — when a top-up was credited. The 24 h cap counts credits by this, not by created_at (when the transfer was
	// first recorded): a transfer recorded "unknown" and claimed days later counts on the day it is credited (#38).
	// Existing credited rows were credited when last updated.
	// scan_retries: what the top-up scanner couldn't read and moved past (a block's Transfer logs for one token, a
	// player's receipt, or the Agentic Wallet's payouts in a block range: both rpcs answered too big, malformed or
	// refused). Read again on later passes, a bounded
	// number of times; the back office sees what is still open (Payments). Players' own reports credit those
	// deposits meanwhile.
	// platform_ledger_ref: the "booked already?" lookups (seed, restock) match lower(ref); one row per credited
	// top-up (its fee) lands there, so they'd scan the table.
	`ALTER TABLE topups ADD COLUMN credited_at INTEGER NOT NULL DEFAULT 0;
	UPDATE topups SET credited_at = updated_at WHERE status = 'credited' AND credited_at = 0;
	CREATE INDEX IF NOT EXISTS topups_credited ON topups(user_id, credited_at);
	CREATE TABLE IF NOT EXISTS scan_retries (
		kind TEXT NOT NULL CHECK (kind IN ('logs', 'receipt', 'payouts')),
		ref TEXT NOT NULL,                  -- logs: the token contract; receipt: the tx; payouts: the range's last block
		block INTEGER NOT NULL,
		reason TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 1,
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'given_up')),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (kind, ref, block)
	);
	CREATE INDEX IF NOT EXISTS platform_ledger_ref ON platform_ledger(lower(ref));`,
	// 9 — the wardrobe: the outfit a player saved, and the shop items they bought with Coin (items.go). Bought once,
	// kept for good; price is what was paid.
	`ALTER TABLE users ADD COLUMN look TEXT NOT NULL DEFAULT '';
	CREATE TABLE IF NOT EXISTS owned_items (
		user_id TEXT    NOT NULL,
		item    TEXT    NOT NULL,
		price   INTEGER NOT NULL,
		at      INTEGER NOT NULL,
		PRIMARY KEY (user_id, item)
	);`,
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for ; v < len(migrations); v++ {
		t, err := db.Begin()
		if err != nil {
			return err
		}
		m, err := withoutColumnsPresent(t, migrations[v])
		if err != nil {
			t.Rollback()
			return err
		}
		if _, err := t.Exec(m); err != nil {
			t.Rollback()
			return fmt.Errorf("migration %d: %w", v+1, err)
		}
		if _, err := t.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, v+1)); err != nil {
			t.Rollback()
			return err
		}
		if err := t.Commit(); err != nil {
			return err
		}
	}
	return nil
}

var addColumnRe = regexp.MustCompile(`(?i)ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)[^;]*;`)

// onceMark: what follows it in a migration is a backfill of the columns the migration adds, run only by the run that
// adds them.
const onceMark = "-- once: backfill of the new columns"

// rerunnable: the only columns whose ADD COLUMN may be skipped when the table has them already (migrations 7, 8, 9).
// Any other ADD COLUMN runs as written, so a column that exists where it shouldn't (schema drift) fails the
// migration instead of being hidden.
var rerunnable = map[string]bool{"topups.refund_cents": true, "topups.refunded_at": true, "topups.credited_at": true,
	"users.look": true}

// withoutColumnsPresent drops a migration's ADD COLUMN statements for rerunnable columns the table already has, so
// a migration runs again on a database that has it (SQLite has no ADD COLUMN IF NOT EXISTS; a test harness may
// rewind user_version). If it had them all, it ran before: its backfill after onceMark is dropped too (columns are
// added in the same transaction as the backfill, so having them means it was done).
func withoutColumnsPresent(t *sql.Tx, m string) (string, error) {
	var err error
	added, present := 0, 0
	out := addColumnRe.ReplaceAllStringFunc(m, func(stmt string) string {
		added++
		g := addColumnRe.FindStringSubmatch(stmt)
		if !rerunnable[strings.ToLower(g[1]+"."+g[2])] {
			return stmt
		}
		var n int
		if e := t.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, g[1], g[2]).Scan(&n); e != nil {
			err = e
		}
		if n > 0 {
			present++
			return ""
		}
		return stmt
	})
	if i := strings.Index(out, onceMark); i >= 0 && added > 0 && present == added {
		out = out[:i]
	}
	return out, err
}
