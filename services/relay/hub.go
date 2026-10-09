package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"sync/atomic"
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
	// Who opened it (per-IP room cap) and who the host kicked: an IP → until when it may not rejoin.
	ip     string
	kicked map[string]time.Time
}

// hub holds every room. One mutex: rooms are tiny and operations are O(peers); fine for thousands of players.
// ponytail: single lock; shard by room code if a profile ever shows contention.
type hub struct {
	mu       sync.Mutex
	rooms    map[string]*room
	maxRooms int
	maxPeers int
	grace    time.Duration
	// Rooms closed for a host gone past the grace period: the host can still resume them (same code, so links
	// and events keep working) for keepExpired; their codes aren't handed out meanwhile.
	expired map[string]expiredRoom

	// Abuse limits, all per server process (one relay; see README). 0 = off.
	maxConns      int           // open sockets in total
	maxConnsPerIP int           // open sockets per IP
	maxRoomsPerIP int           // rooms per IP (abandoned ones in their grace period too)
	kickBan       time.Duration // a kicked IP can't rejoin that room for this long
	queueBudget   int64         // bytes queued for all clients together (conn.push)
	queued        atomic.Int64
	conns         int
	perIP         map[string]int
	// Failed joins per IP: a token bucket, so room codes can't be guessed by reconnecting.
	misses map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

const (
	missBurst = 20
	missRate  = 0.2 // per second: 12 wrong codes a minute after the burst
)

type expiredRoom struct {
	token string
	at    time.Time
}

const (
	keepExpired = time.Hour
	maxExpired  = 10_000 // ~1 MB of codes and tokens, whatever the churn
)

func newHub(maxRooms, maxPeers int, grace time.Duration) *hub {
	return &hub{rooms: map[string]*room{}, maxRooms: maxRooms, maxPeers: maxPeers, grace: grace,
		expired: map[string]expiredRoom{}, perIP: map[string]int{}, misses: map[string]*bucket{},
		maxConns: 1000, maxConnsPerIP: 100, kickBan: 10 * time.Minute, queueBudget: 16 << 20}
}

// admit counts a new socket from ip; false = over the total or per-IP cap (the caller closes it).
func (h *hub) admit(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if (h.maxConns > 0 && h.conns >= h.maxConns) || (h.maxConnsPerIP > 0 && h.perIP[ip] >= h.maxConnsPerIP) {
		return false
	}
	h.conns++
	h.perIP[ip]++
	return true
}

func (h *hub) gone(ip string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conns--
	if h.perIP[ip]--; h.perIP[ip] <= 0 {
		delete(h.perIP, ip)
	}
}

// guessing: ip has used up its failed joins. Caller holds h.mu.
func (h *hub) guessing(ip string, now time.Time) bool {
	b := h.misses[ip]
	if b == nil {
		return false
	}
	b.tokens = min(missBurst, b.tokens+now.Sub(b.last).Seconds()*missRate)
	b.last = now
	return b.tokens < 1
}

// miss records a failed join from ip. Caller holds h.mu.
func (h *hub) miss(ip string, now time.Time) {
	b := h.misses[ip]
	if b == nil {
		b = &bucket{tokens: missBurst, last: now}
		h.misses[ip] = b
	}
	b.tokens--
}

// evictHostless frees a room slot when the server is full: the room whose host has been gone longest closes early
// (its host can still resume it, like any expired room). Caller holds h.mu; returns the peers to tell.
func (h *hub) evictHostless(now time.Time) ([]*conn, bool) {
	var oldest *room
	for _, r := range h.rooms {
		if r.host == nil && (oldest == nil || r.hostGone.Before(oldest.hostGone)) {
			oldest = r
		}
	}
	if oldest == nil {
		return nil, false
	}
	return h.expire(oldest, now), true
}

// expire closes a room and keeps its code for a resume. Caller holds h.mu; returns the peers to tell.
func (h *hub) expire(r *room, now time.Time) []*conn {
	delete(h.rooms, r.code)
	if len(h.expired) >= maxExpired {
		for code := range h.expired { // full: forget one (map order is random enough)
			delete(h.expired, code)
			break
		}
	}
	h.expired[r.code] = expiredRoom{r.token, now}
	out := make([]*conn, 0, len(r.peers))
	for _, p := range r.peers {
		out = append(out, p)
	}
	return out
}

func tellClosed(peers []*conn) {
	for _, p := range peers {
		p.control(control{T: "closed"})
		p.closeWith("room closed")
	}
}

// hostedBy counts the rooms opened from ip, abandoned ones included (create-and-drop churn counts). Caller holds h.mu.
// ponytail: O(rooms) scan; keep a per-IP counter if MAX_ROOMS grows past ~10k.
func (h *hub) hostedBy(ip string) int {
	n := 0
	for _, r := range h.rooms {
		if r.ip == ip {
			n++
		}
	}
	return n
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

// create opens a room with c as its host. A full server first closes the longest-abandoned room.
func (h *hub) create(c *conn) (*room, string) {
	h.mu.Lock()
	var evicted []*conn
	defer func() { tellClosed(evicted) }()
	defer h.mu.Unlock()
	if h.maxRoomsPerIP > 0 && h.hostedBy(c.ip) >= h.maxRoomsPerIP {
		return nil, "too_many_rooms"
	}
	if len(h.rooms) >= h.maxRooms {
		var ok bool
		if evicted, ok = h.evictHostless(time.Now()); !ok {
			return nil, "server_full"
		}
	}
	code := randomCode(6)
	for h.rooms[code] != nil || h.expired[code].token != "" {
		code = randomCode(6)
	}
	return h.open(c, code, randomToken()), ""
}

func (h *hub) open(c *conn, code, token string) *room {
	r := &room{code: code, token: token, host: c, peers: map[uint16]*conn{}, nextID: 1, ip: c.ip,
		kicked: map[string]time.Time{}}
	h.rooms[code] = r
	c.room, c.host = r, true
	return r
}

// resume puts a reconnecting host back in charge of its room (reopened if it expired while they were away).
func (h *hub) resume(c *conn, code, token string) (*room, string) {
	h.mu.Lock()
	var evicted []*conn
	defer func() { tellClosed(evicted) }()
	defer h.mu.Unlock()
	now := time.Now()
	r := h.rooms[code]
	if e := h.expired[code]; r == nil && token != "" && e.token == token {
		if h.maxRoomsPerIP > 0 && h.hostedBy(c.ip) >= h.maxRoomsPerIP {
			return nil, "too_many_rooms"
		}
		if len(h.rooms) >= h.maxRooms {
			var ok bool
			if evicted, ok = h.evictHostless(now); !ok {
				return nil, "server_full"
			}
		}
		delete(h.expired, code)
		r = h.open(c, code, token)
		c.control(control{T: "created", Room: r.code, Token: r.token})
		return r, ""
	}
	if r == nil || r.token != token { // a 128-bit token can't be guessed: no miss counted
		return nil, "room_not_found"
	}
	if r.host != nil {
		// Said in a message (flushed before the socket goes): the close frame's reason doesn't reach browsers.
		r.host.control(control{T: "error", Code: "replaced"})
		r.host.closeWith("replaced")
	}
	r.host, r.hostGone = c, time.Time{}
	c.room, c.host = r, true
	// The host hears "created" and who is still here before any peer's input (peers answer "host on").
	c.control(control{T: "created", Room: r.code, Token: r.token})
	for _, p := range r.peers {
		c.control(control{T: "peer", ID: p.id, Name: p.name, Role: p.role, On: boolp(true)})
	}
	for _, p := range r.peers {
		p.control(control{T: "host", On: boolp(true)})
	}
	return r, ""
}

func (h *hub) join(c *conn, code string) (*room, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if h.guessing(c.ip, now) {
		return nil, "rate_limited"
	}
	r := h.rooms[code]
	if r == nil {
		h.miss(c.ip, now)
		return nil, "room_not_found"
	}
	if now.Before(r.kicked[c.ip]) {
		return nil, "kicked"
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
	// The kick sticks for a while: not a ban (no accounts here), but the same IP can't walk straight back in.
	// ponytail: per IP, so players behind one NAT share it; ban by account once the relay checks api tickets.
	if p != nil && h.kickBan > 0 {
		r.kicked[p.ip] = time.Now().Add(h.kickBan)
	}
	h.mu.Unlock()
	if p != nil {
		p.control(control{T: "kicked"}) // flushed before the socket goes: the client won't reconnect
		p.closeWith("kicked")
	}
}

// closeRoom: the host closed the room on purpose; its peers are told at once (no grace, no resume).
func (h *hub) closeRoom(host *conn) {
	h.mu.Lock()
	r := host.room
	if r == nil || r.host != host || h.rooms[r.code] != r {
		h.mu.Unlock()
		return
	}
	delete(h.rooms, r.code)
	r.host, host.room, host.host = nil, nil, false
	peers := make([]*conn, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	h.mu.Unlock()
	for _, p := range peers {
		p.control(control{T: "closed"})
		p.closeWith("room closed")
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
	for _, r := range h.rooms {
		if r.host == nil && now.Sub(r.hostGone) > h.grace {
			closing = append(closing, h.expire(r, now)...)
		}
		for ip, until := range r.kicked {
			if now.After(until) {
				delete(r.kicked, ip)
			}
		}
	}
	for code, e := range h.expired {
		if now.Sub(e.at) > keepExpired {
			delete(h.expired, code)
		}
	}
	for ip, b := range h.misses {
		if now.Sub(b.last) > time.Duration(missBurst/missRate)*time.Second {
			delete(h.misses, ip) // refilled by now
		}
	}
	h.mu.Unlock()
	tellClosed(closing)
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
