package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	return &client{t, ws}
}

func (c *client) send(m control) {
	b, _ := json.Marshal(m)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) frame(kind byte, peer uint16, payload string) {
	b := make([]byte, headerLen+len(payload))
	b[0] = kind
	binary.BigEndian.PutUint16(b[1:3], peer)
	copy(b[3:], payload)
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		c.t.Fatal(err)
	}
}

// next reads the next message: a control (text) or a binary frame.
func (c *client) next() (control, []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	typ, b, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	if typ == websocket.MessageText {
		var m control
		_ = json.Unmarshal(b, &m)
		return m, nil
	}
	return control{}, b
}

func (c *client) expect(t string) control {
	c.t.Helper()
	m, _ := c.next()
	if m.T != t {
		c.t.Fatalf("want %q, got %+v", t, m)
	}
	return m
}

func setup(t *testing.T, grace time.Duration) (*hub, string) {
	h := newHub(10, 2, grace)
	srv := httptest.NewServer(server(h, []string{"*"}))
	t.Cleanup(srv.Close)
	return h, srv.URL
}

func TestRoomRouting(t *testing.T) {
	_, url := setup(t, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create", Name: "CEO"})
	room := host.expect("created").Room
	if len(room) != 6 {
		t.Fatalf("room code %q", room)
	}

	guest := dial(t, url)
	guest.send(control{T: "join", Room: room, Name: "Kiel", Role: "guest"})
	id := guest.expect("joined").ID
	if m := host.expect("peer"); m.ID != id || m.Name != "Kiel" || !*m.On {
		t.Fatalf("host saw %+v", m)
	}

	// Host → all (state), host → one, peer → host with the sender stamped (the claimed 999 is overwritten).
	host.frame(kindState, 0, "snapshot")
	if _, b := guest.next(); string(b[3:]) != "snapshot" || b[0] != kindState {
		t.Fatalf("state frame %q", b)
	}
	host.frame(kindTo, id, "just you")
	if _, b := guest.next(); string(b[3:]) != "just you" {
		t.Fatalf("direct frame %q", b)
	}
	guest.frame(kindFrom, 999, "buy tsla")
	_, b := host.next()
	if got := binary.BigEndian.Uint16(b[1:3]); got != id || string(b[3:]) != "buy tsla" {
		t.Fatalf("from frame id=%d %q", got, b[3:])
	}

	// Peers can't broadcast.
	guest.frame(kindState, 0, "fake")
	host.frame(kindEvent, 0, "real")
	if _, b := guest.next(); string(b[3:]) != "real" {
		t.Fatalf("peer broadcast leaked: %q", b)
	}

	_ = guest.ws.Close(websocket.StatusNormalClosure, "")
	if m := host.expect("peer"); m.ID != id || *m.On {
		t.Fatalf("leave not reported: %+v", m)
	}
}

func TestJoinErrors(t *testing.T) {
	_, url := setup(t, time.Minute)
	c := dial(t, url)
	c.send(control{T: "join", Room: "NOPE00", Name: "x", Role: "guest"})
	if m := c.expect("error"); m.Code != "room_not_found" {
		t.Fatal(m)
	}
	c.send(control{T: "join", Room: "NOPE00", Name: "x", Role: "admin"})
	if m := c.expect("error"); m.Code != "bad_request" {
		t.Fatal(m)
	}

	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	for i := 0; i < 2; i++ {
		p := dial(t, url)
		p.send(control{T: "join", Room: room, Role: "dj"})
		p.expect("joined")
	}
	full := dial(t, url)
	full.send(control{T: "join", Room: room, Role: "guest"})
	if m := full.expect("error"); m.Code != "room_full" {
		t.Fatal(m)
	}
}

func TestHostResumeAndGrace(t *testing.T) {
	h, url := setup(t, 50*time.Millisecond)
	host := dial(t, url)
	host.send(control{T: "create"})
	c := host.expect("created")
	guest := dial(t, url)
	guest.send(control{T: "join", Room: c.Room, Role: "guest"})
	guest.expect("joined")

	_ = host.ws.Close(websocket.StatusNormalClosure, "")
	if m := guest.expect("host"); *m.On {
		t.Fatal("host drop not reported")
	}
	back := dial(t, url)
	back.send(control{T: "resume", Room: c.Room, Token: "wrong"})
	back.expect("error")
	back.send(control{T: "resume", Room: c.Room, Token: c.Token})
	back.expect("created")
	if m := back.expect("peer"); !*m.On {
		t.Fatal("peers still here not re-announced")
	}
	if m := guest.expect("host"); !*m.On {
		t.Fatal("host return not reported")
	}

	// Host gone past the grace period: the room closes and its peers are told.
	_ = back.ws.Close(websocket.StatusNormalClosure, "")
	guest.expect("host")
	time.Sleep(80 * time.Millisecond)
	h.sweep(time.Now())
	guest.expect("closed")
	if rooms, _ := h.stats(); rooms != 0 {
		t.Fatalf("rooms left: %d", rooms)
	}

	// The host comes back later: the same code reopens with its token (not with another).
	late := dial(t, url)
	late.send(control{T: "resume", Room: c.Room, Token: "wrong"})
	late.expect("error")
	late.send(control{T: "resume", Room: c.Room, Token: c.Token})
	if m := late.expect("created"); m.Room != c.Room {
		t.Fatalf("reopened as %q", m.Room)
	}
	again := dial(t, url)
	again.send(control{T: "join", Room: c.Room, Role: "guest"})
	again.expect("joined")
}

func TestCloseAndKick(t *testing.T) {
	h, url := setup(t, time.Minute)
	h.kickBan = 0 // every test socket is 127.0.0.1: the kicked guest's IP ban would also keep `other` out
	host := dial(t, url)
	host.send(control{T: "create"})
	c := host.expect("created")
	guest := dial(t, url)
	guest.send(control{T: "join", Room: c.Room, Role: "guest"})
	g := guest.expect("joined")
	host.expect("peer")

	// Kicked: told so before the socket goes, so the client knows not to reconnect.
	host.send(control{T: "kick", ID: g.ID})
	guest.expect("kicked")
	host.expect("peer")

	// Close: peers are told at once and the room is gone (no grace, no resume).
	other := dial(t, url)
	other.send(control{T: "join", Room: c.Room, Role: "guest"})
	other.expect("joined")
	host.expect("peer")
	host.send(control{T: "close"})
	other.expect("closed")
	if rooms, _ := h.stats(); rooms != 0 {
		t.Fatalf("rooms left: %d", rooms)
	}
	host.send(control{T: "resume", Room: c.Room, Token: c.Token})
	host.expect("error")
}

func TestRateLimit(t *testing.T) {
	_, url := setup(t, time.Minute)
	c := dial(t, url)
	// The lobby bucket holds 10; spam bad joins and expect a rate_limited error among the replies.
	for i := 0; i < 15; i++ {
		c.send(control{T: "join", Room: "NOPE00", Role: "guest"})
	}
	limited := false
	for i := 0; i < 15; i++ {
		if m, _ := c.next(); m.Code == "rate_limited" {
			limited = true
		}
	}
	if !limited {
		t.Fatal("no rate limiting")
	}
}

func TestRoomsPerIPAndQueueBudgetReleased(t *testing.T) {
	h, url := setup(t, time.Minute)
	h.maxRoomsPerIP = 1
	host := dial(t, url)
	host.send(control{T: "create"})
	c := host.expect("created")
	second := dial(t, url)
	second.send(control{T: "create"})
	if m := second.expect("error"); m.Code != "too_many_rooms" {
		t.Fatalf("second room from one IP: %+v", m)
	}

	// A peer that stops reading: what it pinned is given back to the hub's budget once it's gone.
	g := dial(t, url)
	g.send(control{T: "join", Room: c.Room, Role: "guest"})
	id := g.expect("joined").ID
	host.expect("peer")
	payload := strings.Repeat("x", 100<<10)
	for i := 0; i < 20; i++ {
		host.frame(kindTo, id, payload)
	}
	_ = g.ws.CloseNow()
	deadline := time.Now().Add(10 * time.Second)
	for h.queued.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if q := h.queued.Load(); q != 0 {
		t.Fatalf("budget leaked: %d bytes still counted", q)
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.9")
	if ip := clientIP(r, nil); ip != "10.0.0.2" {
		t.Fatalf("no trusted proxy: %s", ip)
	}
	// Only the trusted proxy's word counts, and only its own hop (the last), never a client-written one.
	if ip := clientIP(r, newProxies("10.0.0.0/24")); ip != "203.0.113.9" {
		t.Fatalf("trusted: %s", ip)
	}
	if ip := clientIP(r, newProxies("10.0.1.7, 192.168.0.0/16")); ip != "10.0.0.2" {
		t.Fatalf("another container on the network set XFF: %s", ip)
	}
	if ip := clientIP(r, newProxies("localhost")); ip != "10.0.0.2" {
		t.Fatalf("hostname not resolving to the socket: %s", ip)
	}
	r.Header.Del("X-Forwarded-For")
	if ip := clientIP(r, newProxies("10.0.0.0/24")); ip != "10.0.0.2" {
		t.Fatalf("no header: %s", ip)
	}
	// IPv6: one /64 is one subscriber.
	r.RemoteAddr = "[2001:db8:1:2:aaaa::1]:443"
	a := clientIP(r, nil)
	r.RemoteAddr = "[2001:db8:1:2:bbbb::9]:443"
	if b := clientIP(r, nil); a != b || a != "2001:db8:1:2::/64" {
		t.Fatalf("v6 keyed by address, not /64: %s %s", a, b)
	}
}

func TestReplacedHostIsToldInBand(t *testing.T) {
	_, url := setup(t, time.Minute)
	a := dial(t, url)
	a.send(control{T: "create"})
	c := a.expect("created")
	b := dial(t, url)
	b.send(control{T: "resume", Room: c.Room, Token: c.Token})
	b.expect("created")
	// Browsers don't see the close frame's reason, so the old tab must hear it as a message.
	if m := a.expect("error"); m.Code != "replaced" {
		t.Fatalf("old host got %+v", m)
	}
}

func TestRoomChurnPerIPIsCapped(t *testing.T) {
	h, url := setup(t, time.Minute)
	h.maxRooms, h.maxRoomsPerIP = 1000, 3
	for i := 0; i < 3; i++ {
		a := dial(t, url)
		a.send(control{T: "create"})
		a.expect("created")
		_ = a.ws.CloseNow() // abandoned, but still counts during its grace period
	}
	time.Sleep(50 * time.Millisecond)
	x := dial(t, url)
	x.send(control{T: "create"})
	if m := x.expect("error"); m.Code != "too_many_rooms" {
		t.Fatalf("4th room from one IP: %+v", m)
	}
}

func TestControlsIgnoreTheSharedBudget(t *testing.T) {
	h := newHub(10, 64, time.Minute)
	h.queueBudget = 1 // someone else filled it
	h.queued.Store(1)
	host := fake(h)
	r, _ := h.create(host)
	for i := 0; i < 30; i++ {
		h.join(fake(h), r.code) // 30 "peer" controls to the host
	}
	if isDone(host) {
		t.Fatalf("host dropped by a full shared budget: %q", reasonOf(host))
	}
}

func TestProxyLookupFailureKeepsLastGood(t *testing.T) {
	p := newProxies("edge.invalid")
	_, n, _ := net.ParseCIDR("10.0.0.7/32")
	p.byEntry["edge.invalid"] = []*net.IPNet{n} // resolved earlier; the proxy's DNS name is gone for now
	p.at = time.Now().Add(-time.Minute)
	p.refresh()
	if !p.trusts(net.ParseIP("10.0.0.7")) {
		t.Fatal("a failed lookup dropped the proxy: every player would share its IP")
	}
}

func TestGuestInputBytesCannotStarveHostControls(t *testing.T) {
	h := newHub(10, 64, time.Minute)
	host := fake(h)
	r, _ := h.create(host)
	g := fake(h)
	h.join(g, r.code)
	big := make([]byte, 8<<10)
	big[0] = kindFrom
	for i := 0; i < queueLen; i++ {
		g.route(big) // capped at half the host's bytes, then host_busy
	}
	filler := make([]byte, maxQueueBytes) // nothing else may squeeze in past the half either
	filler[0] = kindFrom
	g.route(filler)
	for i := 0; i < 20; i++ {
		h.join(fake(h), r.code)
	}
	if isDone(host) {
		t.Fatalf("guest input starved the host's controls: %q", reasonOf(host))
	}
}

func TestProxyPartialFailureKeepsThatEntry(t *testing.T) {
	p := newProxies("edge.invalid, 10.9.0.0/16")
	_, n, _ := net.ParseCIDR("10.0.0.7/32")
	p.byEntry["edge.invalid"] = []*net.IPNet{n} // resolved earlier
	p.refresh()                                 // edge's lookup fails now, the CIDR still parses
	if !p.trusts(net.ParseIP("10.0.0.7")) || !p.trusts(net.ParseIP("10.9.1.1")) {
		t.Fatal("one failed name dropped its last good addresses")
	}
}

func TestProxyCallersWaitForTheLookupInFlight(t *testing.T) {
	p := newProxies("127.0.0.1")
	var wg sync.WaitGroup
	var untrusted atomic.Int32
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !p.trusts(net.ParseIP("127.0.0.1")) {
				untrusted.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := untrusted.Load(); n != 0 {
		t.Fatalf("%d of 50 concurrent first callers turned away untrusted", n)
	}
}
