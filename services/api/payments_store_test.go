package main

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func credits(t *testing.T, s *store, id string) int64 {
	t.Helper()
	var c int64
	if err := s.db.QueryRow(`SELECT credits FROM users WHERE id = ?`, id).Scan(&c); err != nil {
		t.Fatal(err)
	}
	return c
}

func count(t *testing.T, s *store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Migration 5 on a database shaped like production (version 4, players, Coin history, leases, a party, the
// warehouse stocked by hand): nothing is lost, every player starts at 0 credits, the new tables are there.
func TestMigrationFiveOnALiveDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', avatar INTEGER NOT NULL DEFAULT 1,
	wallet INTEGER NOT NULL, nights INTEGER NOT NULL DEFAULT 0, gigs INTEGER NOT NULL DEFAULT 0,
	total_pnl INTEGER NOT NULL DEFAULT 0, best_pnl INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
	last_gig INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE portfolio (user_id TEXT NOT NULL, token TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL,
	PRIMARY KEY (user_id, token));`); err != nil {
		t.Fatal(err)
	}
	for v, m := range migrations[:4] {
		if _, err := db.Exec(m); err != nil {
			t.Fatalf("migration %d: %v", v+1, err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 4;
INSERT INTO users (id, name, wallet, nights, created_at, updated_at, email, wallet_address)
	VALUES ('did:privy:kiel', 'Kiel', 18914, 3, 1, 1, 'kiel@x', '0xabc');
INSERT INTO portfolio VALUES ('did:privy:kiel', 'tsla', 4, 292);
INSERT INTO ledger (user_id, delta, balance, kind, at) VALUES ('did:privy:kiel', -500, 18914, 'rent', 2);
INSERT INTO leases (level, slot, user_id, club, rent, starts_at, ends_at) VALUES (1, 1, 'did:privy:kiel', 'Nyx', 500, 1, 9);
INSERT INTO parties (lease_id, starts_at, minutes, created_at, host_id, invite) VALUES (1, 5, 10, 1, 'did:privy:kiel', 'abc');
INSERT INTO platform_stock VALUES ('tsla', 100, 1);
INSERT INTO stock_moves (token, delta, kind, actor, reason, at) VALUES ('tsla', 100, 'restock', 'boss', 'by hand', 1);`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if n := count(t, s, `PRAGMA user_version`); n != len(migrations) {
		t.Fatalf("version %d", n)
	}
	p, err := s.Get(ctx, "did:privy:kiel")
	if err != nil || p.Name != "Kiel" || p.Wallet != 18914 || p.Portfolio["tsla"].Qty != 4 {
		t.Fatalf("player %+v %v", p, err)
	}
	if credits(t, s, "did:privy:kiel") != 0 {
		t.Fatal("credits must start at 0: only a verified top-up mints them")
	}
	checks := map[string]int{
		`SELECT COUNT(*) FROM ledger WHERE kind = 'rent' AND currency = 'coin'`: 1, // old rows are Coin
		`SELECT COUNT(*) FROM leases WHERE club = 'Nyx'`:                        1,
		`SELECT COUNT(*) FROM parties WHERE invite = 'abc'`:                     1,
		`SELECT COUNT(*) FROM platform_stock WHERE qty = 100 AND reserved = 0`:  1,
		`SELECT COUNT(*) FROM stock_moves`:                                      1,
		`SELECT COUNT(*) FROM backed_units`:                                     0,
		`SELECT COUNT(*) FROM topups`:                                           0,
		`SELECT COUNT(*) FROM sales`:                                            0,
		`SELECT COUNT(*) FROM party_prices`:                                     0,
		`SELECT COUNT(*) FROM platform_ledger`:                                  0,
	}
	for q, want := range checks {
		if got := count(t, s, q); got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
	// Opening again doesn't re-run it.
	s.close()
	if s, err = openStore(path); err != nil {
		t.Fatalf("reopen: %v", err)
	}
}

// Every play-money path (starter wallet, refill, import, nights, gigs, admin grants, rent, shop stock, shop
// sales) moves Coin only: credits stay 0 and no credit row is written.
func TestCoinPathsNeverTouchCredits(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	in := Profile{Name: "Imported", Avatar: 2, Wallet: 900}
	steps := map[string]func() error{
		"import": func() error { _, e := s.Import(ctx, "a", in); return e },
		"grant":  func() error { return s.GrantCoins(ctx, "boss", "a", 1_000_000, "test") },
		"lease":  func() error { _, e := s.Lease(ctx, "a", 1, 0, "Booth", 1, now); return e },
		"restock": func() error {
			return s.Restock(ctx, "boss", "tsla", 50, "restock", "test", "")
		},
		"stock": func() error { _, e := s.Stock(ctx, "a", "tsla", 10, flat, now); return e },
		"night": func() error {
			_, e := s.Night(ctx, "b", startWallet-1500, map[string]Holding{"tsla": {Qty: 1, Cost: 1000}}, 0, "")
			return e
		},
		"gig": func() error { _, e := s.Gig(ctx, "b", 100, now); return e },
	}
	for _, name := range []string{"import", "grant", "lease", "restock", "stock", "night", "gig"} {
		if err := steps[name](); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	open := true
	if err := s.SetShop(ctx, "a", 1, &open, nil, flat, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ShopBuy(ctx, "b", 1, "tsla", 2, now); err != nil {
		t.Fatalf("shop buy: %v", err)
	}
	s.Get(ctx, "c")
	if err := s.GrantCoins(ctx, "boss", "c", -startWallet+10, "broke"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Refill(ctx, "c"); err != nil {
		t.Fatalf("refill: %v", err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if c := credits(t, s, id); c != 0 {
			t.Fatalf("%s has %d credits after Coin paths", id, c)
		}
	}
	if n := count(t, s, `SELECT COUNT(*) FROM ledger WHERE currency = 'credit'`); n != 0 {
		t.Fatalf("%d credit rows from Coin paths", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM ledger WHERE currency = 'coin'`); n < 7 {
		t.Fatalf("Coin paths wrote only %d ledger rows", n)
	}
}

func TestCreditLedger(t *testing.T) {
	s := testStore(t)
	s.Get(ctx, "a")
	run := func(f func(*sql.Tx) error) error {
		tx, err := s.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := f(tx); err != nil {
			tx.Rollback()
			return err
		}
		return tx.Commit()
	}
	if err := run(func(tx *sql.Tx) error { return creditLedger(tx, "a", 990, "topup", "", "0xtx") }); err != nil {
		t.Fatal(err)
	}
	if err := run(func(tx *sql.Tx) error { return creditLedger(tx, "a", -1000, "hold", "", "") }); !errors.Is(err, errRejected) {
		t.Fatalf("below zero: %v", err)
	}
	if err := run(func(tx *sql.Tx) error { return creditLedger(tx, "a", 5, "admin", "boss", "") }); err == nil {
		t.Fatal("an admin grant must not mint credits")
	}
	if err := run(func(tx *sql.Tx) error { return creditLedger(tx, "ghost", 5, "topup", "", "") }); !errors.Is(err, errRejected) {
		t.Fatalf("unknown player: %v", err)
	}
	if c := credits(t, s, "a"); c != 990 {
		t.Fatalf("credits %d", c)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM ledger WHERE currency = 'credit' AND kind = 'topup' AND balance = 990`); n != 1 {
		t.Fatalf("ledger rows %d", n)
	}
	// The database itself refuses negative credits, whatever the code does.
	if _, err := s.db.Exec(`UPDATE users SET credits = -1 WHERE id = 'a'`); err == nil {
		t.Fatal("negative credits stored")
	}
	if err := run(func(tx *sql.Tx) error { return platformLedger(tx, 10, "fee", "0xtx", "1% of $10") }); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO platform_ledger (delta, kind, at) VALUES (1, 'gift', 1)`); err == nil {
		t.Fatal("unknown platform kind stored")
	}
}

func TestPaymentTablesRefuseBadRows(t *testing.T) {
	s := testStore(t)
	topup := `INSERT INTO topups (tx, log_index, sender, token, amount, usd_cents, status, created_at, updated_at)
		VALUES ('0xt', 3, '0xs', '0xusdc', '10000000000000000000', 1000, 'credited', 1, 1)`
	if _, err := s.db.Exec(topup); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(topup); err == nil {
		t.Fatal("the same transfer (tx + log index) credited twice")
	}
	if _, err := s.db.Exec(strings.Replace(topup, "'0xt'", "'0xT'", 1)); err == nil {
		t.Fatal("the same tx hash in other letter case credited twice")
	}
	sale := func(party, lease int) error {
		_, err := s.db.Exec(`INSERT INTO sales (party_id, lease_id, buyer, seller, token, qty, price, wholesale, created_at)
			VALUES (?, ?, 'g', 'ceo', 'tsla', 1, 40, 38, 1)`, party, lease)
		return err
	}
	if err := sale(7, 0); err != nil {
		t.Fatal(err)
	}
	if err := sale(0, 2); err != nil {
		t.Fatal(err)
	}
	if sale(7, 2) == nil || sale(0, 0) == nil {
		t.Fatal("a sale belongs to a party or a shop, exactly one")
	}
	if _, err := s.db.Exec(`UPDATE sales SET status = 'paid'`); err == nil {
		t.Fatal("unknown sale status")
	}
	if _, err := s.db.Exec(`UPDATE sales SET price = 30`); err == nil {
		t.Fatal("a CEO price under wholesale (negative margin) stored")
	}
	if _, err := s.db.Exec(`INSERT INTO party_prices VALUES (7, 'tsla', 0)`); err == nil {
		t.Fatal("a zero party price stored")
	}
	if _, err := s.db.Exec(`INSERT INTO platform_stock (token, qty, updated_at, reserved) VALUES ('tsla', 0, 1, -1)`); err == nil {
		t.Fatal("negative reservation")
	}
}
