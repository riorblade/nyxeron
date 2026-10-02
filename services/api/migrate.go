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
