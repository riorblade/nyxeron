package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Events: a night a CEO schedules at one of their clubs (a rented city venue, or a practice club identified by its
// name and level), public or private, with a start time and a length (10 minutes by default). Every event has an
// invite code: a public one is listed for everyone, a private one only for its host and the players who opened its
// invite link. The club itself still runs in the host's browser, so an event goes live when the host opens the club
// (its relay room is attached to the event) and guests who said they're going get a one-click join.
//
//	GET    /api/events                    → upcoming + live: public ones, mine, and the ones I'm going to
//	GET    /api/events/invite/{code}      → the event behind an invite link; opening it marks me as going
//	POST   /api/events                    {lease?, club?, level?, startsAt, minutes?, title?, private?} → schedule
//	POST   /api/events/{id}/rsvp          {going} → going / not going (private: only after opening the invite)
//	DELETE /api/events/{id}               → cancel my event
//	PUT    /api/events/{id}/room          {room} → my event is live in this relay room
//
// Stored in the `parties` table (the city's first version); `lease_id` is 0 for practice clubs.

const maxUpcomingEvents = 20

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
	Private   bool   `json:"private"`
	Invite    string `json:"invite,omitempty"` // the host's (and the back office's) to share
	Going     int    `json:"going"`
	IGo       bool   `json:"iGo,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
	Mine      bool   `json:"mine,omitempty"`
}

// events lists events matching `where` (over p = parties), as seen by `viewer`.
func (s *store) events(ctx context.Context, viewer string, admin bool, now time.Time, where string, args ...any) ([]PartyView, error) {
	// Before the main query: the database has one connection, so a second query can't run while rows are open.
	going, err := s.goingTo(ctx, viewer)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.lease_id, COALESCE(l.level, p.level), COALESCE(l.slot, 0),
		COALESCE(l.club, p.club), u.name, p.host_id, p.title, p.starts_at, p.minutes, p.room, p.cancelled, p.private,
		p.invite, (SELECT COUNT(*) FROM rsvps r WHERE r.party_id = p.id)
		FROM parties p LEFT JOIN leases l ON l.id = p.lease_id JOIN users u ON u.id = p.host_id
		WHERE `+where+` ORDER BY p.starts_at LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PartyView{}
	for rows.Next() {
		var p PartyView
		var host string
		var cancelled, private int
		if err := rows.Scan(&p.ID, &p.LeaseID, &p.Level, &p.Slot, &p.Club, &p.Owner, &host, &p.Title, &p.StartsAt,
			&p.Minutes, &p.Room, &cancelled, &private, &p.Invite, &p.Going); err != nil {
			return nil, err
		}
		p.Cancelled, p.Private, p.Mine, p.IGo = cancelled == 1, private == 1, host == viewer, going[p.ID]
		p.Live = !p.Cancelled && p.Room != "" && now.Unix() >= p.StartsAt-900 && now.Unix() < p.StartsAt+int64(p.Minutes)*60
		if !p.Mine && !admin {
			p.Invite = ""
			if !p.Live {
				p.Room = "" // the code only matters while it's on
			}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// goingTo: the events a player said they're going to.
func (s *store) goingTo(ctx context.Context, viewer string) (map[int64]bool, error) {
	out := map[int64]bool{}
	if viewer == "" {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT party_id FROM rsvps WHERE user_id = ?`, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func newInvite() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type EventInput struct {
	Lease    int64  `json:"lease"`
	Club     string `json:"club"`
	Level    int    `json:"level"`
	StartsAt int64  `json:"startsAt"`
	Minutes  int    `json:"minutes"`
	Title    string `json:"title"`
	Private  bool   `json:"private"`
}

// Event schedules an event at one of the host's clubs. A city venue (lease) must be theirs and rented through the
// event; any club needs the party level (Level 3+). Events at the same club may not overlap.
func (s *store) Event(ctx context.Context, id string, in EventInput, now time.Time) (PartyView, error) {
	pc := game.city.Party
	if in.Minutes == 0 {
		in.Minutes = pc.DefaultMinutes
	}
	title, ok := cleanName(in.Title)
	club, okClub := cleanName(in.Club)
	if !ok || !okClub || in.Minutes < pc.MinMinutes || in.Minutes > pc.MaxMinutes ||
		in.StartsAt < now.Unix()-60 || in.StartsAt > now.Unix()+int64(pc.MaxAheadDays)*86400 {
		return PartyView{}, errBad
	}
	start := max(in.StartsAt, now.Unix())
	end := start + int64(in.Minutes)*60
	var pid int64
	err := s.tx(ctx, id, func(t *sql.Tx) error {
		level := in.Level
		if in.Lease > 0 {
			l, e := ownLease(t, id, in.Lease, now)
			if e != nil {
				return e
			}
			if end > l.endsAt {
				return errRejected
			}
			level, club = l.level, ""
		} else if club == "" || level < 1 || level > 5 {
			return errBad
		}
		if level < pc.MinLevel {
			return errRejected
		}
		var clash, upcoming int
		if e := t.QueryRow(`SELECT COUNT(*) FROM parties WHERE host_id = ? AND lease_id = ? AND club = ? AND cancelled = 0
			AND starts_at < ? AND starts_at + minutes * 60 > ?`, id, in.Lease, club, end, start).Scan(&clash); e != nil {
			return e
		}
		if e := t.QueryRow(`SELECT COUNT(*) FROM parties WHERE host_id = ? AND cancelled = 0 AND starts_at + minutes * 60 > ?`,
			id, now.Unix()).Scan(&upcoming); e != nil {
			return e
		}
		if clash > 0 {
			return errConflict
		}
		if upcoming >= maxUpcomingEvents {
			return errRejected
		}
		priv := 0
		if in.Private {
			priv = 1
		}
		res, e := t.Exec(`INSERT INTO parties (lease_id, host_id, club, level, private, invite, title, starts_at, minutes, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, in.Lease, id, club, level, priv, newInvite(), title, start, in.Minutes, now.Unix())
		if e != nil {
			return e
		}
		pid, e = res.LastInsertId()
		return e
	})
	if err != nil {
		return PartyView{}, err
	}
	return s.eventByID(ctx, id, pid, now)
}

func (s *store) eventByID(ctx context.Context, viewer string, pid int64, now time.Time) (PartyView, error) {
	list, err := s.events(ctx, viewer, false, now, `p.id = ?`, pid)
	if err != nil {
		return PartyView{}, err
	}
	if len(list) == 0 {
		return PartyView{}, errNotFound
	}
	return list[0], nil
}

// Events: what a player sees: public upcoming/live events, their own, and the ones they're going to.
func (s *store) Events(ctx context.Context, viewer string, now time.Time) ([]PartyView, error) {
	return s.events(ctx, viewer, false, now, `p.cancelled = 0 AND p.starts_at + p.minutes * 60 > ?1
		AND (p.private = 0 OR p.host_id = ?2 OR EXISTS (SELECT 1 FROM rsvps r WHERE r.party_id = p.id AND r.user_id = ?2))`,
		now.Unix(), viewer)
}

// Invite opens an invite link: the event, and the player marked as going (which also lists a private event).
func (s *store) Invite(ctx context.Context, viewer, code string, now time.Time) (PartyView, error) {
	var pid int64
	err := s.tx(ctx, viewer, func(t *sql.Tx) error {
		e := t.QueryRow(`SELECT id FROM parties WHERE invite = ? AND cancelled = 0 AND starts_at + minutes * 60 > ?`,
			strings.ToLower(strings.TrimSpace(code)), now.Unix()).Scan(&pid)
		if errors.Is(e, sql.ErrNoRows) {
			return errNotFound
		} else if e != nil {
			return e
		}
		_, e = t.Exec(`INSERT OR IGNORE INTO rsvps (party_id, user_id, at) VALUES (?, ?, ?)`, pid, viewer, now.Unix())
		return e
	})
	if err != nil {
		return PartyView{}, err
	}
	return s.eventByID(ctx, viewer, pid, now)
}

// RSVP marks the player as going (or not). A private event needs its invite opened first.
func (s *store) RSVP(ctx context.Context, viewer string, pid int64, going bool, now time.Time) (PartyView, error) {
	err := s.tx(ctx, viewer, func(t *sql.Tx) error {
		var private, invited int
		e := t.QueryRow(`SELECT private, EXISTS (SELECT 1 FROM rsvps WHERE party_id = p.id AND user_id = ?) FROM parties p
			WHERE id = ? AND cancelled = 0 AND starts_at + minutes * 60 > ?`, viewer, pid, now.Unix()).Scan(&private, &invited)
		if errors.Is(e, sql.ErrNoRows) {
			return errNotFound
		} else if e != nil {
			return e
		}
		if !going {
			_, e = t.Exec(`DELETE FROM rsvps WHERE party_id = ? AND user_id = ?`, pid, viewer)
			return e
		}
		if private == 1 && invited == 0 {
			return errNotFound
		}
		_, e = t.Exec(`INSERT OR IGNORE INTO rsvps (party_id, user_id, at) VALUES (?, ?, ?)`, pid, viewer, now.Unix())
		return e
	})
	if err != nil {
		return PartyView{}, err
	}
	return s.eventByID(ctx, viewer, pid, now)
}

// eventHost: who hosts an event.
func (s *store) eventHost(ctx context.Context, pid int64) (string, error) {
	var host string
	err := s.db.QueryRowContext(ctx, `SELECT host_id FROM parties WHERE id = ?`, pid).Scan(&host)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errNotFound
	}
	return host, err
}

// CancelEvent: the host calls an event off, only before it starts. Once a party has started its guests may have
// bought real stock, and cancelling would void their sales (sales.go): a free option against the price. After the
// start only an admin voids sales (payments.md §4.4).
func (s *store) CancelEvent(ctx context.Context, id string, pid int64, now time.Time) error {
	if host, err := s.eventHost(ctx, pid); err != nil || host != id {
		return errNotFound
	}
	res, err := s.db.ExecContext(ctx, `UPDATE parties SET cancelled = 1 WHERE id = ? AND starts_at > ?`, pid, now.Unix())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errStarted
	}
	return nil
}

// EventRoom: the host opened the club for their event (from 15 minutes before it starts until it ends).
func (s *store) EventRoom(ctx context.Context, id string, pid int64, room string, now time.Time) error {
	room = strings.ToUpper(strings.TrimSpace(room))
	if !validRoom(room) {
		return errBad
	}
	if host, err := s.eventHost(ctx, pid); err != nil || host != id {
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

// partyHost: whose live city event a guest was at (by relay room), for paying out what they spent; "" if none.
// Only city venues pay out: a practice club's takings stay in its own (offline) game.
func partyHost(t *sql.Tx, room string, now time.Time) string {
	if room == "" {
		return ""
	}
	var host string
	grace := int64(game.city.Party.SettleGraceMinutes) * 60
	_ = t.QueryRow(`SELECT host_id FROM parties WHERE room = ? AND cancelled = 0 AND lease_id > 0
		AND starts_at - 900 <= ? AND starts_at + minutes * 60 + ? > ? ORDER BY starts_at DESC LIMIT 1`,
		strings.ToUpper(room), now.Unix(), grace, now.Unix()).Scan(&host)
	return host
}

func (pl *players) routeEvents(mux *http.ServeMux) {
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
	pid := func(r *http.Request) int64 {
		n, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		return n
	}
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		if pl.db == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not_configured"})
			return
		}
		list, err := pl.db.Events(r.Context(), pl.viewer(r), time.Now())
		reply(w, list, err)
	})
	mux.HandleFunc("GET /api/events/invite/{code}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			e, err := pl.db.Invite(r.Context(), id, r.PathValue("code"), time.Now())
			reply(w, e, err)
		}
	})
	mux.HandleFunc("POST /api/events", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in EventInput
		if ok && body(w, r, &in) {
			if in.Lease > 0 && cityClosed(w) {
				return
			}
			e, err := pl.db.Event(r.Context(), id, in, time.Now())
			reply(w, e, err)
		}
	})
	mux.HandleFunc("POST /api/events/{id}/rsvp", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct{ Going bool }
		if ok && body(w, r, &in) {
			e, err := pl.db.RSVP(r.Context(), id, pid(r), in.Going, time.Now())
			reply(w, e, err)
		}
	})
	mux.HandleFunc("DELETE /api/events/{id}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			reply(w, map[string]bool{"ok": true}, pl.db.CancelEvent(r.Context(), id, pid(r), time.Now()))
		}
	})
	mux.HandleFunc("PUT /api/events/{id}/room", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in struct{ Room string }
		if ok && body(w, r, &in) {
			reply(w, map[string]bool{"ok": true}, pl.db.EventRoom(r.Context(), id, pid(r), in.Room, time.Now()))
		}
	})
}
