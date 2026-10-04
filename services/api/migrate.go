package main

import (
	"database/sql"
	"fmt"
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
		if _, err := t.Exec(migrations[v]); err != nil {
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
