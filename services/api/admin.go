package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Back office (apps/admin). Admins sign in with Privy like players; the server decides who they are:
//
//	owner  — emails in ADMIN_EMAILS (set on the server); can do everything, including managing admins
//	admin  — granted by an owner; can change players (coins, access, bans, names, saves)
//	viewer — granted by an owner; read-only (support)
//
// Every change is written to the audit log with who did it, to whom, the values before and after, and why.
type role int

const (
	roleNone role = iota
	roleViewer
	roleAdmin
	roleOwner
)

func (r role) String() string {
	return [...]string{"", "viewer", "admin", "owner"}[r]
}

type admin struct {
	auth     *privy
	db       *store
	owners   map[string]bool
	quotes   *quoter
	relayURL string
	dbPath   string
	client   *http.Client
}

func parseOwners(env string) map[string]bool {
	m := map[string]bool{}
	for _, e := range strings.Split(env, ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			m[e] = true
		}
	}
	return m
}

// who returns the admin's email and role, or answers 401/403 itself when they lack `need`.
func (a *admin) who(w http.ResponseWriter, r *http.Request, need role) (string, role, bool) {
	if a.db == nil || !a.auth.configured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
		return "", roleNone, false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	id, err := a.auth.verify(strings.TrimSpace(token), time.Now())
	if !ok || err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return "", roleNone, false
	}
	me, err := a.auth.user(id, time.Now())
	email := strings.ToLower(me.Email)
	rl := roleNone
	if err == nil && email != "" {
		if a.owners[email] {
			rl = roleOwner
		} else {
			var s string
			if a.db.db.QueryRowContext(r.Context(), `SELECT role FROM admins WHERE email = ?`, email).Scan(&s) == nil {
				rl = map[string]role{"admin": roleAdmin, "viewer": roleViewer}[s]
			}
		}
	}
	if rl < need {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return "", rl, false
	}
	return email, rl, true
}

// ---------- store ----------

type UserRow struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	Wallet      string `json:"walletAddress"`
	Name        string `json:"name"`
	Avatar      int    `json:"avatar"`
	Coin        int64  `json:"coin"`
	Nights      int    `json:"nights"`
	Gigs        int    `json:"gigs"`
	UnlockLevel int    `json:"unlockLevel"`
	Banned      bool   `json:"banned"`
	CreatedAt   int64  `json:"createdAt"`
	LastSeen    int64  `json:"lastSeen"`
}

const userCols = `id, email, wallet_address, name, avatar, wallet, nights, gigs, unlock_level, banned, created_at, last_seen`

func scanUser(sc interface{ Scan(...any) error }) (UserRow, error) {
	var u UserRow
	var banned int
	err := sc.Scan(&u.ID, &u.Email, &u.Wallet, &u.Name, &u.Avatar, &u.Coin, &u.Nights, &u.Gigs, &u.UnlockLevel, &banned, &u.CreatedAt, &u.LastSeen)
	u.Banned = banned == 1
	return u, err
}

var userSorts = map[string]string{
	"recent": "last_seen DESC", "new": "created_at DESC", "coin": "wallet DESC", "nights": "nights DESC", "name": "name COLLATE NOCASE ASC",
}

// ListUsers searches by email, name, wallet address or id.
func (s *store) ListUsers(ctx context.Context, q, sortBy string, limit, offset int) ([]UserRow, int, error) {
	order, ok := userSorts[sortBy]
	if !ok {
		order = userSorts["recent"]
	}
	like := "%" + strings.NewReplacer("%", `\%`, "_", `\_`).Replace(strings.ToLower(strings.TrimSpace(q))) + "%"
	where := `WHERE lower(email) LIKE ?1 ESCAPE '\' OR lower(name) LIKE ?1 ESCAPE '\' OR lower(wallet_address) LIKE ?1 ESCAPE '\' OR lower(id) LIKE ?1 ESCAPE '\'`
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users `+where, like).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users `+where+` ORDER BY `+order+` LIMIT ?2 OFFSET ?3`, like, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []UserRow{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

type LedgerRow struct {
	Delta   int64  `json:"delta"`
	Balance int64  `json:"balance"`
	Kind    string `json:"kind"`
	Actor   string `json:"actor"`
	Reason  string `json:"reason"`
	At      int64  `json:"at"`
}

type AuditRow struct {
	ID     int64           `json:"id"`
	Actor  string          `json:"actor"`
	Action string          `json:"action"`
	Target string          `json:"target"`
	Detail json.RawMessage `json:"detail"`
	Reason string          `json:"reason"`
	At     int64           `json:"at"`
}

type UserDetail struct {
	User    UserRow     `json:"user"`
	Profile Profile     `json:"profile"`
	Saves   []DocInfo   `json:"saves"`
	Ledger  []LedgerRow `json:"ledger"`
	Audit   []AuditRow  `json:"audit"`
}

func (s *store) UserDetail(ctx context.Context, id string) (UserDetail, error) {
	var d UserDetail
	u, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return d, errNotFound
	}
	if err != nil {
		return d, err
	}
	d.User = u
	if d.Profile, err = s.Get(ctx, id); err != nil {
		return d, err
	}
	if d.Saves, err = s.ListDocs(ctx, id, "saves"); err != nil {
		return d, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT delta, balance, kind, actor, reason, at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100`, id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	d.Ledger = []LedgerRow{}
	for rows.Next() {
		var l LedgerRow
		if err := rows.Scan(&l.Delta, &l.Balance, &l.Kind, &l.Actor, &l.Reason, &l.At); err != nil {
			return d, err
		}
		d.Ledger = append(d.Ledger, l)
	}
	d.Audit, err = s.Audit(ctx, id, 50, 0)
	return d, err
}

func (s *store) Audit(ctx context.Context, target string, limit int, before int64) ([]AuditRow, error) {
	q := `SELECT id, actor, action, target, detail, reason, at FROM audit WHERE (?1 = '' OR target = ?1) AND (?2 = 0 OR id < ?2) ORDER BY id DESC LIMIT ?3`
	rows, err := s.db.QueryContext(ctx, q, target, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var a AuditRow
		var detail string
		if err := rows.Scan(&a.ID, &a.Actor, &a.Action, &a.Target, &detail, &a.Reason, &a.At); err != nil {
			return nil, err
		}
		a.Detail = json.RawMessage(detail)
		out = append(out, a)
	}
	return out, rows.Err()
}

func audit(t *sql.Tx, actor, action, target string, detail any, reason string) error {
	b, _ := json.Marshal(detail)
	_, err := t.Exec(`INSERT INTO audit (actor, action, target, detail, reason, at) VALUES (?, ?, ?, ?, ?, ?)`,
		actor, action, target, string(b), reason, time.Now().Unix())
	return err
}

// adminTx: a change to an existing player (never creates one), audited in the same transaction.
func (s *store) adminTx(ctx context.Context, id string, fn func(*sql.Tx) error) error {
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	var exists int
	if err := t.QueryRow(`SELECT COUNT(*) FROM users WHERE id = ?`, id).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return errNotFound
	}
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit()
}

const maxGrant = 100_000_000

// GrantCoins adds (or with a negative amount takes away) game coins; the wallet never goes below zero.
func (s *store) GrantCoins(ctx context.Context, actor, id string, delta int64, reason string) error {
	if delta == 0 || delta > maxGrant || delta < -maxGrant || strings.TrimSpace(reason) == "" {
		return errBad
	}
	return s.adminTx(ctx, id, func(t *sql.Tx) error {
		var before int64
		if err := t.QueryRow(`SELECT wallet FROM users WHERE id = ?`, id).Scan(&before); err != nil {
			return err
		}
		if before+delta < 0 {
			return errRejected
		}
		if _, err := t.Exec(`UPDATE users SET wallet = wallet + ?, updated_at = ? WHERE id = ?`, delta, time.Now().Unix(), id); err != nil {
			return err
		}
		if err := ledger(t, id, delta, "admin", actor, reason); err != nil {
			return err
		}
		return audit(t, actor, "coins", id, map[string]int64{"before": before, "delta": delta, "after": before + delta}, reason)
	})
}

type UserPatch struct {
	Name        *string `json:"name"`
	UnlockLevel *int    `json:"unlockLevel"`
	Banned      *bool   `json:"banned"`
	BanReason   *string `json:"banReason"`
	Reason      string  `json:"reason"`
}

// SetUser changes access (unlock level), bans and names; each field changed is audited with before → after.
func (s *store) SetUser(ctx context.Context, actor, id string, p UserPatch) error {
	if strings.TrimSpace(p.Reason) == "" || (p.UnlockLevel != nil && (*p.UnlockLevel < 1 || *p.UnlockLevel > 5)) {
		return errBad
	}
	if p.Name != nil {
		n, ok := cleanName(*p.Name)
		if !ok {
			return errBad
		}
		p.Name = &n
	}
	return s.adminTx(ctx, id, func(t *sql.Tx) error {
		var name, banReason string
		var level, banned int
		if err := t.QueryRow(`SELECT name, unlock_level, banned, ban_reason FROM users WHERE id = ?`, id).Scan(&name, &level, &banned, &banReason); err != nil {
			return err
		}
		set := func(col string, v any, action string, before, after any) error {
			if _, err := t.Exec(`UPDATE users SET `+col+` = ?, updated_at = ? WHERE id = ?`, v, time.Now().Unix(), id); err != nil {
				return err
			}
			return audit(t, actor, action, id, map[string]any{"before": before, "after": after}, p.Reason)
		}
		if p.Name != nil && *p.Name != name {
			if err := set("name", *p.Name, "rename", name, *p.Name); err != nil {
				return err
			}
		}
		if p.UnlockLevel != nil && *p.UnlockLevel != level {
			if err := set("unlock_level", *p.UnlockLevel, "unlock", level, *p.UnlockLevel); err != nil {
				return err
			}
		}
		if p.Banned != nil && *p.Banned != (banned == 1) {
			b := 0
			reason := ""
			if *p.Banned {
				b = 1
				reason = strings.TrimSpace(p.Reason)
				if p.BanReason != nil {
					reason = strings.TrimSpace(*p.BanReason)
				}
			}
			if _, err := t.Exec(`UPDATE users SET ban_reason = ? WHERE id = ?`, reason, id); err != nil {
				return err
			}
			action := map[bool]string{true: "ban", false: "unban"}[*p.Banned]
			if err := set("banned", b, action, banned == 1, *p.Banned); err != nil {
				return err
			}
		}
		return nil
	})
}

// ClearSaves deletes a player's career saves (e.g. a corrupt or exploited save).
func (s *store) ClearSaves(ctx context.Context, actor, id, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errBad
	}
	return s.adminTx(ctx, id, func(t *sql.Tx) error {
		res, err := t.Exec(`DELETE FROM docs WHERE user_id = ? AND kind = 'saves'`, id)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		return audit(t, actor, "clear-saves", id, map[string]int64{"deleted": n}, reason)
	})
}

// SetIdentity keeps the email and wallet address the back office searches by, and when the player was last seen.
func (s *store) SetIdentity(ctx context.Context, id, email, wallet string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET
		email = CASE WHEN ?2 != '' THEN ?2 ELSE email END,
		wallet_address = CASE WHEN ?3 != '' THEN ?3 ELSE wallet_address END,
		last_seen = ?4 WHERE id = ?1`, id, strings.ToLower(email), wallet, now.Unix())
	return err
}

// Banned reports whether the player may not change anything.
func (s *store) Banned(ctx context.Context, id string) bool {
	var b int
	_ = s.db.QueryRowContext(ctx, `SELECT banned FROM users WHERE id = ?`, id).Scan(&b)
	return b == 1
}

type AdminRow struct {
	Email     string `json:"email"`
	Role      string `json:"role"`
	GrantedBy string `json:"grantedBy"`
	At        int64  `json:"at"`
}

func (s *store) Admins(ctx context.Context) ([]AdminRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT email, role, granted_by, at FROM admins ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminRow{}
	for rows.Next() {
		var a AdminRow
		if err := rows.Scan(&a.Email, &a.Role, &a.GrantedBy, &a.At); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *store) SetAdmin(ctx context.Context, actor, email, rl string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	if !strings.Contains(email, "@") || (rl != "admin" && rl != "viewer" && rl != "") {
		return errBad
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if rl == "" {
		_, err = t.Exec(`DELETE FROM admins WHERE email = ?`, email)
	} else {
		_, err = t.Exec(`INSERT INTO admins (email, role, granted_by, at) VALUES (?, ?, ?, ?)
			ON CONFLICT (email) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, at = excluded.at`,
			email, rl, actor, time.Now().Unix())
	}
	if err != nil {
		return err
	}
	if err := audit(t, actor, "admin-role", email, map[string]string{"role": rl}, "role change"); err != nil {
		return err
	}
	return t.Commit()
}

// Announcement: a banner on every player's dashboard (events, maintenance).
type Announcement struct {
	Text      string `json:"text"`
	Active    bool   `json:"active"`
	UpdatedAt int64  `json:"updatedAt"`
}

func (s *store) Announcement(ctx context.Context) Announcement {
	var a Announcement
	var v string
	if s.db.QueryRowContext(ctx, `SELECT value, updated_at FROM settings WHERE key = 'announcement'`).Scan(&v, &a.UpdatedAt) == nil {
		_ = json.Unmarshal([]byte(v), &a)
	}
	return a
}

func (s *store) SetAnnouncement(ctx context.Context, actor string, a Announcement) error {
	a.Text = strings.TrimSpace(a.Text)
	if len([]rune(a.Text)) > 280 {
		return errBad
	}
	b, _ := json.Marshal(map[string]any{"text": a.Text, "active": a.Active})
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if _, err := t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ('announcement', ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, string(b), time.Now().Unix()); err != nil {
		return err
	}
	if err := audit(t, actor, "announcement", "", map[string]any{"text": a.Text, "active": a.Active}, "announcement"); err != nil {
		return err
	}
	return t.Commit()
}

// ---------- city ----------

// EndLease evicts a tenant now (no refund) and cancels their upcoming parties.
func (s *store) EndLease(ctx context.Context, actor string, lease int64, reason string, now time.Time) error {
	if strings.TrimSpace(reason) == "" {
		return errBad
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	var owner, club string
	var ends int64
	err = t.QueryRow(`SELECT user_id, club, ends_at FROM leases WHERE id = ? AND ends_at > ?`, lease, now.Unix()).Scan(&owner, &club, &ends)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	} else if err != nil {
		return err
	}
	if _, err := t.Exec(`UPDATE leases SET ends_at = ?, open = 0 WHERE id = ?`, now.Unix(), lease); err != nil {
		return err
	}
	if _, err := t.Exec(`UPDATE parties SET cancelled = 1 WHERE lease_id = ? AND starts_at + minutes * 60 > ?`, lease, now.Unix()); err != nil {
		return err
	}
	if err := audit(t, actor, "end-lease", owner, map[string]any{"club": club, "before": ends, "after": now.Unix()}, reason); err != nil {
		return err
	}
	return t.Commit()
}

func (s *store) AdminCancelParty(ctx context.Context, actor string, pid int64, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errBad
	}
	owner, err := s.eventHost(ctx, pid)
	if err != nil {
		return err
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if _, err := t.Exec(`UPDATE parties SET cancelled = 1 WHERE id = ?`, pid); err != nil {
		return err
	}
	if err := audit(t, actor, "cancel-party", owner, map[string]int64{"party": pid}, reason); err != nil {
		return err
	}
	return t.Commit()
}

// SetRent changes the weekly rent per venue level (applies to new leases and extensions).
func (s *store) SetRent(ctx context.Context, actor string, rent map[string]int64, reason string) error {
	if strings.TrimSpace(reason) == "" || len(rent) == 0 {
		return errBad
	}
	before := s.Rent(ctx)
	after := map[string]int64{}
	for l, v := range before {
		after[l] = v
	}
	for l, v := range rent {
		if _, ok := before[l]; !ok || v < 1 || v > maxGrant {
			return errBad
		}
		after[l] = v
	}
	b, _ := json.Marshal(after)
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	if _, err := t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ('rent', ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, string(b), time.Now().Unix()); err != nil {
		return err
	}
	if err := audit(t, actor, "rent", "", map[string]any{"before": before, "after": after}, reason); err != nil {
		return err
	}
	return t.Commit()
}

const maxVenuesPerLevel = 500

// SetVenueCounts changes how many venues of each level the city has. A level can't shrink below its highest
// rented slot (nobody loses a venue they're paying for); new slots are free to rent at once.
func (s *store) SetVenueCounts(ctx context.Context, actor string, counts map[string]int, reason string, now time.Time) error {
	if strings.TrimSpace(reason) == "" || len(counts) == 0 {
		return errBad
	}
	before := s.VenueCounts(ctx)
	after := map[string]int{}
	for l, n := range before {
		after[l] = n
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer t.Rollback()
	for l, n := range counts {
		level, _ := strconv.Atoi(l)
		if _, ok := before[l]; !ok || n < 1 || n > maxVenuesPerLevel {
			return errBad
		}
		var highest int
		if err := t.QueryRow(`SELECT COALESCE(MAX(slot), 0) FROM leases WHERE level = ? AND ends_at > ?`, level, now.Unix()).Scan(&highest); err != nil {
			return err
		}
		if n < highest {
			return errRejected
		}
		after[l] = n
	}
	b, _ := json.Marshal(after)
	if _, err := t.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ('venueCounts', ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, string(b), now.Unix()); err != nil {
		return err
	}
	if err := audit(t, actor, "venue-counts", "", map[string]any{"before": before, "after": after}, reason); err != nil {
		return err
	}
	return t.Commit()
}

// Revenue: rent the platform took (all time and the last 7 days).
func (s *store) Revenue(ctx context.Context, now time.Time) (total, week int64) {
	_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(-SUM(delta), 0), COALESCE(-SUM(CASE WHEN at >= ? THEN delta END), 0)
		FROM ledger WHERE kind = 'rent'`, now.Unix()-7*86400).Scan(&total, &week)
	return
}

type Stats struct {
	Users     int   `json:"users"`
	New24h    int   `json:"new24h"`
	New7d     int   `json:"new7d"`
	Active24h int   `json:"active24h"`
	Banned    int   `json:"banned"`
	Coin      int64 `json:"coin"`
	Nights    int64 `json:"nights"`
	Gigs      int64 `json:"gigs"`
	Saves     int   `json:"saves"`
	Live      *struct {
		Rooms int `json:"rooms"`
		Conns int `json:"conns"`
	} `json:"live"`
	Quotes struct {
		Source  string `json:"source"`
		Tickers int    `json:"tickers"`
	} `json:"quotes"`
	Rent struct {
		Total  int64 `json:"total"`
		Week   int64 `json:"week"`
		Leases int   `json:"leases"`
	} `json:"rent"`
	LastBackup int64 `json:"lastBackup"`
	DBBytes    int64 `json:"dbBytes"`
}

func (a *admin) stats(ctx context.Context, now time.Time) (Stats, error) {
	var st Stats
	n := now.Unix()
	err := a.db.db.QueryRowContext(ctx, `SELECT COUNT(*),
		COALESCE(SUM(created_at >= ?1), 0), COALESCE(SUM(created_at >= ?2), 0), COALESCE(SUM(last_seen >= ?1), 0),
		COALESCE(SUM(banned), 0), COALESCE(SUM(wallet), 0), COALESCE(SUM(nights), 0), COALESCE(SUM(gigs), 0) FROM users`,
		n-86400, n-7*86400).Scan(&st.Users, &st.New24h, &st.New7d, &st.Active24h, &st.Banned, &st.Coin, &st.Nights, &st.Gigs)
	if err != nil {
		return st, err
	}
	_ = a.db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM docs WHERE kind = 'saves'`).Scan(&st.Saves)
	st.Rent.Total, st.Rent.Week = a.db.Revenue(ctx, now)
	_ = a.db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM leases WHERE ends_at > ?`, n).Scan(&st.Rent.Leases)
	if a.quotes != nil {
		q := a.quotes.get()
		st.Quotes.Source, st.Quotes.Tickers = q.Source, len(q.Quotes)
	}
	if a.relayURL != "" {
		if res, err := a.client.Get(a.relayURL + "/stats"); err == nil {
			live := &struct {
				Rooms int `json:"rooms"`
				Conns int `json:"conns"`
			}{}
			if json.NewDecoder(res.Body).Decode(live) == nil {
				st.Live = live
			}
			res.Body.Close()
		}
	}
	if fi, err := os.Stat(a.dbPath); err == nil {
		st.DBBytes = fi.Size()
	}
	backups, _ := filepath.Glob(filepath.Join(filepath.Dir(a.dbPath), "backup-*.db"))
	sort.Strings(backups)
	if len(backups) > 0 {
		if fi, err := os.Stat(backups[len(backups)-1]); err == nil {
			st.LastBackup = fi.ModTime().Unix()
		}
	}
	return st, nil
}

// ---------- routes ----------

func intParam(r *http.Request, key string, def, lo, hi int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	return max(lo, min(hi, v))
}

func (a *admin) route(mux *http.ServeMux) {
	ok := func(w http.ResponseWriter, err error) {
		if err != nil {
			if errors.Is(err, errNotFound) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
				return
			}
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
	mux.HandleFunc("GET /api/admin/me", func(w http.ResponseWriter, r *http.Request) {
		if email, rl, yes := a.who(w, r, roleViewer); yes {
			writeJSON(w, http.StatusOK, map[string]string{"email": email, "role": rl.String()})
		}
	})
	mux.HandleFunc("GET /api/admin/stats", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			st, err := a.stats(r.Context(), time.Now())
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, st)
		}
	})
	mux.HandleFunc("GET /api/admin/users", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			list, total, err := a.db.ListUsers(r.Context(), r.URL.Query().Get("q"), r.URL.Query().Get("sort"),
				intParam(r, "limit", 50, 1, 200), intParam(r, "offset", 0, 0, 1_000_000))
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"users": list, "total": total})
		}
	})
	mux.HandleFunc("GET /api/admin/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			d, err := a.db.UserDetail(r.Context(), r.PathValue("id"))
			if err != nil {
				ok(w, err)
				return
			}
			writeJSON(w, http.StatusOK, d)
		}
	})
	mux.HandleFunc("POST /api/admin/users/{id}/coins", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct {
			Delta  int64  `json:"delta"`
			Reason string `json:"reason"`
		}
		if yes && body(w, r, &in) {
			ok(w, a.db.GrantCoins(r.Context(), actor, r.PathValue("id"), in.Delta, in.Reason))
		}
	})
	mux.HandleFunc("PATCH /api/admin/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in UserPatch
		if yes && body(w, r, &in) {
			ok(w, a.db.SetUser(r.Context(), actor, r.PathValue("id"), in))
		}
	})
	mux.HandleFunc("POST /api/admin/users/{id}/clear-saves", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct {
			Reason string `json:"reason"`
		}
		if yes && body(w, r, &in) {
			ok(w, a.db.ClearSaves(r.Context(), actor, r.PathValue("id"), in.Reason))
		}
	})
	mux.HandleFunc("GET /api/admin/audit", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
			rows, err := a.db.Audit(r.Context(), r.URL.Query().Get("target"), intParam(r, "limit", 100, 1, 500), before)
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, rows)
		}
	})
	mux.HandleFunc("GET /api/admin/admins", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleOwner); yes {
			list, err := a.db.Admins(r.Context())
			if err != nil {
				fail(w, err)
				return
			}
			owners := []string{}
			for e := range a.owners {
				owners = append(owners, e)
			}
			sort.Strings(owners)
			writeJSON(w, http.StatusOK, map[string]any{"owners": owners, "admins": list})
		}
	})
	mux.HandleFunc("PUT /api/admin/admins", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleOwner)
		var in struct {
			Email string `json:"email"`
			Role  string `json:"role"` // "admin", "viewer", or "" to remove
		}
		if yes && body(w, r, &in) {
			ok(w, a.db.SetAdmin(r.Context(), actor, in.Email, in.Role))
		}
	})
	mux.HandleFunc("GET /api/admin/announcement", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			writeJSON(w, http.StatusOK, a.db.Announcement(r.Context()))
		}
	})
	mux.HandleFunc("PUT /api/admin/announcement", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in Announcement
		if yes && body(w, r, &in) {
			ok(w, a.db.SetAnnouncement(r.Context(), actor, in))
		}
	})
	mux.HandleFunc("GET /api/admin/city", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			v, err := a.db.City(r.Context(), "", true, time.Now())
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, v)
		}
	})
	mux.HandleFunc("POST /api/admin/leases/{id}/end", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct{ Reason string }
		if yes && body(w, r, &in) {
			id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
			ok(w, a.db.EndLease(r.Context(), actor, id, in.Reason, time.Now()))
		}
	})
	mux.HandleFunc("POST /api/admin/parties/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct{ Reason string }
		if yes && body(w, r, &in) {
			id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
			ok(w, a.db.AdminCancelParty(r.Context(), actor, id, in.Reason))
		}
	})
	mux.HandleFunc("PUT /api/admin/venues", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct {
			Counts map[string]int
			Reason string
		}
		if yes && body(w, r, &in) {
			ok(w, a.db.SetVenueCounts(r.Context(), actor, in.Counts, in.Reason, time.Now()))
		}
	})
	mux.HandleFunc("PUT /api/admin/rent", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct {
			Rent   map[string]int64
			Reason string
		}
		if yes && body(w, r, &in) {
			ok(w, a.db.SetRent(r.Context(), actor, in.Rent, in.Reason))
		}
	})
	mux.HandleFunc("GET /api/admin/stock", func(w http.ResponseWriter, r *http.Request) {
		if _, _, yes := a.who(w, r, roleViewer); yes {
			v, err := a.db.Supply(r.Context(), time.Now())
			if err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, v)
		}
	})
	mux.HandleFunc("PUT /api/admin/stock/{token}", func(w http.ResponseWriter, r *http.Request) {
		actor, _, yes := a.who(w, r, roleAdmin)
		var in struct {
			Delta  int64
			Reason string
			Tx     string
		}
		if yes && body(w, r, &in) {
			kind := "adjust"
			if in.Delta > 0 {
				kind = "restock"
			}
			ok(w, a.db.Restock(r.Context(), actor, r.PathValue("token"), in.Delta, kind, in.Reason, in.Tx))
		}
	})
	// Public: the banner players see.
	mux.HandleFunc("GET /api/announcement", func(w http.ResponseWriter, r *http.Request) {
		if a.db == nil {
			writeJSON(w, http.StatusOK, Announcement{})
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=60")
		an := a.db.Announcement(r.Context())
		if !an.Active {
			an = Announcement{}
		}
		writeJSON(w, http.StatusOK, an)
	})
}
