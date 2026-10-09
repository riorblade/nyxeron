package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	writeTimeout = 5 * time.Second
	pingEvery    = 25 * time.Second
	// Reliable frames waiting for a slow client, bounded twice: by count (256 slice headers ≈ 6 KB) and by bytes
	// (maxQueueBytes per connection, plus the hub's budget for all of them), so no client can pin relay memory.
	// Control messages past a bound drop the client (a stuck client must not grow memory); peer input is refused
	// with "host_busy" instead, and may only fill half the host's queue so controls to the host always fit.
	queueLen      = 256
	maxQueueBytes = 256 << 10
	// A socket must create, join or resume within this; silent sockets are closed.
	helloDeadline = 10 * time.Second
)

// limits per role: biggest frame accepted and a token bucket for message rate.
type limits struct {
	maxFrame int64
	rate     float64 // messages per second
	burst    float64
}

var (
	hostLimits = limits{maxFrame: 256 << 10, rate: 60, burst: 120}
	peerLimits = limits{maxFrame: 8 << 10, rate: 20, burst: 40}
	// Before a create/join the client is nobody: tiny frames only.
	lobbyLimits = limits{maxFrame: 1 << 10, rate: 5, burst: 10}
)

type conn struct {
	ws   *websocket.Conn
	hub  *hub
	ip   string
	who  string // the player limits and kicks follow: "u:"+account from a ticket, else "ip:"+ip
	room *room
	host bool
	id   uint16
	name string
	role string

	queue  chan []byte // reliable frames (control JSON is tagged by a leading '{')
	latest atomic.Pointer[[]byte]
	wake   chan struct{} // a new latest snapshot is waiting
	done   chan struct{}
	cancel context.CancelFunc
	// Closed when the write loop has finished (after flushing), so the socket is only closed after that.
	flushed chan struct{}
	once    sync.Once
	reason  atomic.Value
	// Bytes waiting in queue (qmu guards it with the hub's budget); dead once the write loop has finished.
	qmu    sync.Mutex
	qbytes int64
	qdead  bool

	tokens float64
	last   time.Time
}

func newConn(ws *websocket.Conn, h *hub) *conn {
	return &conn{
		ws: ws, hub: h,
		queue:   make(chan []byte, queueLen),
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
		flushed: make(chan struct{}),
		last:    time.Now(),
		// Start with a full bucket, so the first create/join isn't throttled.
		tokens: lobbyLimits.burst,
	}
}

func (c *conn) closeWith(reason string) {
	c.once.Do(func() {
		c.reason.Store(reason)
		close(c.done)
	})
}

// push queues a frame within the count and byte bounds; false = the receiver is backed up. `slots` and `maxBytes`
// cap how much of the queue this frame may use (peer input gets half, so controls to the host always have room).
func (c *conn) push(b []byte, slots int, maxBytes int64, budget bool) bool {
	n := int64(len(b))
	c.qmu.Lock()
	defer c.qmu.Unlock()
	// One frame always fits an empty queue (a host may send up to 256 KB); after that the byte bounds apply.
	// Controls skip the shared budget: a few hundred bytes each, and other clients filling it must not cost a
	// player (or a resuming host) their connection.
	full := c.qbytes > 0 && (c.qbytes+n > maxBytes || (budget && c.hub.queued.Load()+n > c.hub.queueBudget))
	if c.qdead || full || len(c.queue) >= slots {
		return false
	}
	select {
	case c.queue <- b:
		c.qbytes += n
		c.hub.queued.Add(n)
		return true
	default:
		return false
	}
}

// popped: the write loop took b off the queue.
func (c *conn) popped(b []byte) {
	c.qmu.Lock()
	c.qbytes -= int64(len(b))
	c.hub.queued.Add(-int64(len(b)))
	c.qmu.Unlock()
}

// release: the write loop is done; whatever is still queued no longer counts against the hub's budget.
func (c *conn) release() {
	c.qmu.Lock()
	c.qdead = true
	c.hub.queued.Add(-c.qbytes)
	c.qbytes = 0
	c.qmu.Unlock()
}

// offer queues peer input for the host if there is room; false = the host is backed up ("host_busy").
// Half the slots and half the bytes: the other half is always there for controls to the host.
func (c *conn) offer(b []byte) bool { return c.push(b, queueLen/2, maxQueueBytes/2, true) }

// enqueue a reliable frame; a client too slow to drain its queue is disconnected.
func (c *conn) enqueue(b []byte) { c.reliable(b, true) }

func (c *conn) reliable(b []byte, budget bool) {
	if !c.push(b, queueLen, maxQueueBytes, budget) {
		c.closeWith("too slow")
	}
}

func (c *conn) control(m control) {
	b, _ := json.Marshal(m)
	c.reliable(b, false)
}

// setLatest replaces any unsent snapshot (latest wins).
func (c *conn) setLatest(b []byte) {
	c.latest.Store(&b)
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// allow is a token bucket: `rate` messages a second, bursts up to `burst`.
func (c *conn) allow(l limits) bool {
	now := time.Now()
	c.tokens = min(l.burst, c.tokens+now.Sub(c.last).Seconds()*l.rate)
	c.last = now
	if c.tokens < 1 {
		return false
	}
	c.tokens--
	return true
}

func (c *conn) limits() limits {
	switch {
	case c.room == nil:
		return lobbyLimits
	case c.host:
		return hostLimits
	default:
		return peerLimits
	}
}

// typeOf: control JSON goes out as text, frames as binary (frame kinds are 1–4, never '{').
func typeOf(b []byte) websocket.MessageType {
	if len(b) > 0 && b[0] == '{' {
		return websocket.MessageText
	}
	return websocket.MessageBinary
}

// writeLoop is the only writer on the socket: reliable queue first, then the latest snapshot, plus pings.
func (c *conn) writeLoop(ctx context.Context) {
	defer close(c.flushed)
	defer c.release()
	// Cancelling the read context closes the socket (coder/websocket), so only do it after the flush below:
	// it unblocks the reader and ends the request.
	defer c.cancel()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	write := func(b []byte) error {
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		defer cancel()
		return c.ws.Write(wctx, typeOf(b), b)
	}
	for {
		select {
		case <-c.done:
			// Best effort: send what is queued (e.g. "closed", "error") before the socket goes.
			fctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			for {
				select {
				case b := <-c.queue:
					c.popped(b)
					if c.ws.Write(fctx, typeOf(b), b) != nil {
						return
					}
				default:
					return
				}
			}
		case b := <-c.queue:
			c.popped(b)
			if write(b) != nil {
				c.closeWith("write failed")
				return
			}
		case <-c.wake:
			if p := c.latest.Swap(nil); p != nil && write(*p) != nil {
				c.closeWith("write failed")
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.closeWith("no pong")
				return
			}
		}
	}
}

// readLoop handles everything the client sends until it goes away.
func (c *conn) readLoop(ctx context.Context) {
	defer c.closeWith("read ended")
	var hello time.Time // when this socket's current lobby wait ends
	for {
		c.ws.SetReadLimit(c.limits().maxFrame)
		rctx, cancel := ctx, context.CancelFunc(func() {})
		if c.room == nil { // in the lobby: create, join or resume in time, or go
			if hello.IsZero() {
				hello = time.Now().Add(helloDeadline)
			}
			rctx, cancel = context.WithDeadline(ctx, hello)
		} else {
			hello = time.Time{}
		}
		t, b, err := c.ws.Read(rctx)
		cancel()
		if err != nil {
			return
		}
		if !c.allow(c.limits()) {
			c.control(control{T: "error", Code: "rate_limited"})
			continue
		}
		if t == websocket.MessageText {
			if !c.handleControl(b) {
				return
			}
			continue
		}
		c.route(b)
	}
}

func cleanName(s string) string {
	if !utf8.ValidString(s) {
		return ""
	}
	if r := []rune(s); len(r) > 24 {
		s = string(r[:24])
	}
	return s
}

// handleControl runs a JSON control message; false = drop the client.
func (c *conn) handleControl(b []byte) bool {
	var m control
	if json.Unmarshal(b, &m) != nil {
		c.control(control{T: "error", Code: "bad_request"})
		return false
	}
	if c.room != nil && m.T != "kick" && m.T != "close" {
		c.control(control{T: "error", Code: "already_in_room"})
		return true
	}
	// Signed-in players only (when the relay has a ticket secret): the api's ticket names the account.
	if h := c.hub; len(h.ticketKey) > 0 && (m.T == "create" || m.T == "resume" || m.T == "join") {
		sub, ok := verifyTicket(h.ticketKey, m.Ticket, time.Now())
		if !ok {
			c.control(control{T: "error", Code: "bad_ticket"})
			return true
		}
		c.who = "u:" + sub
	}
	switch m.T {
	case "create":
		c.name = cleanName(m.Name)
		r, code := c.hub.create(c)
		if r == nil {
			c.control(control{T: "error", Code: code})
			return true
		}
		c.control(control{T: "created", Room: r.code, Token: r.token})
	case "resume": // the hub answers "created" itself (before the peers hear the host is back)
		if r, code := c.hub.resume(c, m.Room, m.Token); r == nil {
			c.control(control{T: "error", Code: code})
		}
	case "join":
		if m.Role != "guest" && m.Role != "dj" {
			c.control(control{T: "error", Code: "bad_request"})
			return true
		}
		c.name, c.role = cleanName(m.Name), m.Role
		r, code := c.hub.join(c, m.Room)
		if r == nil {
			c.control(control{T: "error", Code: code})
			return true
		}
		c.control(control{T: "joined", Room: r.code, ID: c.id})
	case "kick":
		if c.host {
			c.hub.kick(c, m.ID)
		}
	case "close":
		if c.host {
			c.hub.closeRoom(c)
		}
	default:
		c.control(control{T: "error", Code: "bad_request"})
	}
	return true
}

// route forwards a binary frame by its header, without looking at the payload.
func (c *conn) route(b []byte) {
	if c.room == nil || len(b) < headerLen {
		return
	}
	kind := b[0]
	if c.host {
		if c.hub.hostOf(c.room) != c {
			return // replaced by a resume from another tab, or the room closed
		}
		switch kind {
		case kindState:
			for _, p := range c.hub.peersOf(c.room) {
				p.setLatest(b)
			}
		case kindEvent:
			for _, p := range c.hub.peersOf(c.room) {
				p.enqueue(b)
			}
		case kindTo:
			if p := c.hub.peer(c.room, binary.BigEndian.Uint16(b[1:3])); p != nil {
				p.enqueue(b)
			}
		}
		return
	}
	if kind != kindFrom || c.hub.peer(c.room, c.id) != c {
		return // kicked or gone
	}
	// Stamp the real sender id; the host sees who sent it, peers can't pretend to be someone else.
	out := make([]byte, len(b))
	copy(out, b)
	binary.BigEndian.PutUint16(out[1:3], c.id)
	if h := c.hub.hostOf(c.room); h != nil && !h.offer(out) {
		c.control(control{T: "error", Code: "host_busy"})
	}
}
