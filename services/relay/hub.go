package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Room codes avoid look-alikes (0/O, 1/I/L) so they can be read out loud.
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

type room struct {
	code  string
	token string
	host  *conn
	// When the host dropped (zero while connected); the room waits `grace` for a resume.
	hostGone time.Time
	peers    map[uint16]*conn
	nextID   uint16
}

// hub holds every room. One mutex: rooms are tiny and operations are O(peers); fine for thousands of players.
// ponytail: single lock; shard by room code if a profile ever shows contention.
type hub struct {
	mu       sync.Mutex
	rooms    map[string]*room
	maxRooms int
	maxPeers int
	grace    time.Duration
}

func newHub(maxRooms, maxPeers int, grace time.Duration) *hub {
	return &hub{rooms: map[string]*room{}, maxRooms: maxRooms, maxPeers: maxPeers, grace: grace}
}

func randomCode(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// create opens a room with c as its host.
func (h *hub) create(c *conn) (*room, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.rooms) >= h.maxRooms {
		return nil, "server_full"
	}
	code := randomCode(6)
	for h.rooms[code] != nil {
		code = randomCode(6)
	}
	r := &room{code: code, token: randomToken(), host: c, peers: map[uint16]*conn{}, nextID: 1}
	h.rooms[code] = r
	c.room, c.host = r, true
	return r, ""
}

// resume puts a reconnecting host back in charge of its room.
func (h *hub) resume(c *conn, code, token string) (*room, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[code]
	if r == nil || r.token != token {
		return nil, "room_not_found"
	}
	if r.host != nil {
		r.host.closeWith("replaced")
	}
	r.host, r.hostGone = c, time.Time{}
	c.room, c.host = r, true
	for _, p := range r.peers {
		p.control(control{T: "host", On: boolp(true)})
	}
	return r, ""
}

func (h *hub) join(c *conn, code string) (*room, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[code]
	if r == nil {
		return nil, "room_not_found"
	}
	if len(r.peers) >= h.maxPeers {
		return nil, "room_full"
	}
	// Ids wrap at 65535 but skip 0 (the host) and any still in use.
	for r.peers[r.nextID] != nil || r.nextID == 0 {
		r.nextID++
	}
	c.id = r.nextID
	r.nextID++
	r.peers[c.id] = c
	c.room = r
	if r.host != nil {
		r.host.control(control{T: "peer", ID: c.id, Name: c.name, Role: c.role, On: boolp(true)})
	}
	return r, ""
}

// leave takes c out of its room. A host leaving starts the grace period; its peers are told.
func (h *hub) leave(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := c.room
	if r == nil {
		return
	}
	if c.host {
		if r.host != c {
			return // already replaced by a resume
		}
		r.host, r.hostGone = nil, time.Now()
		for _, p := range r.peers {
			p.control(control{T: "host", On: boolp(false)})
		}
		return
	}
	if r.peers[c.id] == c {
		delete(r.peers, c.id)
		if r.host != nil {
			r.host.control(control{T: "peer", ID: c.id, On: boolp(false)})
		}
	}
}

func (h *hub) kick(host *conn, id uint16) {
	h.mu.Lock()
	r := host.room
	var p *conn
	if r != nil && r.host == host {
		p = r.peers[id]
	}
	h.mu.Unlock()
	if p != nil {
		p.closeWith("kicked")
	}
}

// peersOf snapshots a room's peers so frames are sent without holding the lock.
func (h *hub) peersOf(r *room) []*conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*conn, 0, len(r.peers))
	for _, p := range r.peers {
		out = append(out, p)
	}
	return out
}

func (h *hub) peer(r *room, id uint16) *conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return r.peers[id]
}

func (h *hub) hostOf(r *room) *conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return r.host
}

// sweep closes rooms whose host has been gone longer than the grace period.
func (h *hub) sweep(now time.Time) {
	h.mu.Lock()
	var closing []*conn
	for code, r := range h.rooms {
		if r.host == nil && now.Sub(r.hostGone) > h.grace {
			for _, p := range r.peers {
				closing = append(closing, p)
			}
			delete(h.rooms, code)
		}
	}
	h.mu.Unlock()
	for _, p := range closing {
		p.control(control{T: "closed"})
		p.closeWith("room closed")
	}
}

func (h *hub) stats() (rooms, peers int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		peers += len(r.peers)
		if r.host != nil {
			peers++
		}
	}
	return len(h.rooms), peers
}
