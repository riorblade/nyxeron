package main

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Clubs open right now: a CEO's browser hosts the club in a relay room and announces it here every ~20 s while
// it's open, so guests can find it without a code. In memory only: a host that stops announcing drops off after
// roomTTL, and after an api restart every open club re-announces within one heartbeat.
//
//	GET    /api/rooms          → [{room, club, level, host, players, night, since}] (public)
//	POST   /api/rooms          {room, club, level, players, night} → announce / heartbeat (signed in)
//	DELETE /api/rooms/{room}   → the host closed the club
//
// ponytail: one api instance holds the list; move it to the relay (or a shared store) if the api ever scales out.
const (
	roomTTL      = 45 * time.Second
	roomsPerHost = 3
	maxRooms     = 500
)

type LiveRoom struct {
	Room    string `json:"room"`
	Club    string `json:"club"`
	Level   int    `json:"level"`
	Host    string `json:"host"`
	Players int    `json:"players"`
	Night   bool   `json:"night"`
	Since   int64  `json:"since"`
	owner   string
	seen    time.Time
}

type roomList struct {
	mu sync.Mutex
	m  map[string]*LiveRoom
}

func newRoomList() *roomList { return &roomList{m: map[string]*LiveRoom{}} }

func validRoom(code string) bool {
	return len(code) >= 4 && len(code) <= 8 && strings.Trim(code, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") == ""
}

// announce adds or refreshes a room. A room code belongs to whoever announced it first while it's live.
func (rl *roomList) announce(owner, host string, in LiveRoom, now time.Time) error {
	in.Room = strings.ToUpper(strings.TrimSpace(in.Room))
	club, ok := cleanName(in.Club)
	if !validRoom(in.Room) || !ok || club == "" || in.Level < 1 || in.Level > 5 || in.Players < 0 || in.Players > 1000 {
		return errBad
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.sweep(now)
	if r, ok := rl.m[in.Room]; ok {
		if r.owner != owner {
			return errConflict
		}
		r.Club, r.Level, r.Host, r.Players, r.Night, r.seen = club, in.Level, host, in.Players, in.Night, now
		return nil
	}
	mine := 0
	for _, r := range rl.m {
		if r.owner == owner {
			mine++
		}
	}
	if mine >= roomsPerHost || len(rl.m) >= maxRooms {
		return errRejected
	}
	rl.m[in.Room] = &LiveRoom{Room: in.Room, Club: club, Level: in.Level, Host: host, Players: in.Players,
		Night: in.Night, Since: now.Unix(), owner: owner, seen: now}
	return nil
}

func (rl *roomList) remove(owner, room string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if r, ok := rl.m[strings.ToUpper(room)]; ok && r.owner == owner {
		delete(rl.m, r.Room)
	}
}

func (rl *roomList) list(now time.Time) []LiveRoom {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.sweep(now)
	out := make([]LiveRoom, 0, len(rl.m))
	for _, r := range rl.m {
		out = append(out, *r)
	}
	// Busiest first, then the newest.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Players != out[j].Players {
			return out[i].Players > out[j].Players
		}
		return out[i].Since > out[j].Since
	})
	return out
}

func (rl *roomList) sweep(now time.Time) {
	for k, r := range rl.m {
		if now.Sub(r.seen) > roomTTL {
			delete(rl.m, k)
		}
	}
}

func (pl *players) routeRooms(mux *http.ServeMux, rl *roomList) {
	mux.HandleFunc("GET /api/rooms", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, rl.list(time.Now()))
	})
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pl.who(w, r)
		var in LiveRoom
		if !ok || !body(w, r, &in) {
			return
		}
		p, err := pl.db.Get(r.Context(), id)
		if err != nil {
			fail(w, err)
			return
		}
		if err := rl.announce(id, p.Name, in, time.Now()); err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("DELETE /api/rooms/{room}", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pl.who(w, r); ok {
			rl.remove(id, r.PathValue("room"))
			w.WriteHeader(http.StatusNoContent)
		}
	})
}
