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
