package main

// Adversarial tests: a hostile client against the relay that every live club depends on. Tests named
// TestBrutal* that FAIL document a real bug (see the t.Errorf text); the rest are attacks that held.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// brutalServer: a relay with chosen limits (setup() fixes 10 rooms / 2 peers).
func brutalServer(t *testing.T, maxRooms, maxPeers int, grace time.Duration) (*hub, string) {
	t.Helper()
	h := newHub(maxRooms, maxPeers, grace)
	srv := httptest.NewServer(server(h, []string{"*"}))
	t.Cleanup(srv.Close)
	return h, srv.URL
}

func (c *client) raw(typ websocket.MessageType, b []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return c.ws.Write(ctx, typ, b)
}

// closed reports whether the relay hung up on this client within d.
func (c *client) closed(d time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	for {
		if _, _, err := c.ws.Read(ctx); err != nil {
			return ctx.Err() == nil // a read error before the deadline = the socket went away
		}
	}
}

// fake is a connection with no socket: the hub and queues only, so queue limits are deterministic.
func fake(h *hub) *conn { return newConn(nil, h) }

func isDone(c *conn) bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func reasonOf(c *conn) string { s, _ := c.reason.Load().(string); return s }

// ---------------------------------------------------------------------------------------------------------------
// Attacks that should hold
// ---------------------------------------------------------------------------------------------------------------

func TestBrutalLobbyGarbage(t *testing.T) {
	_, url := brutalServer(t, 10, 4, time.Minute)
	// Binary frames before any hello, of every awkward size, are ignored; the socket still works.
	c := dial(t, url)
	for _, b := range [][]byte{{}, {kindFrom}, {kindState, 0}, {kindEvent, 0xff, 0xff}, {kindTo, 0, 1, 'x'}, {99, 1, 2, 3}} {
		if err := c.raw(websocket.MessageBinary, b); err != nil {
			t.Fatal(err)
		}
	}
	c.send(control{T: "create"})
	if m := c.expect("created"); m.Room == "" {
		t.Fatal("create after garbage failed")
	}

	// Odd but valid JSON: a polite error, the socket stays.
	for _, s := range []string{`{}`, `null`, `{"t":""}`, `{"t":"nope"}`, `{"t":"join","room":"X","role":"admin"}`,
		`{"t":"kick","id":1}`, `{"t":"close"}`, `{"t":"join","room":"` + strings.Repeat("Z", 500) + `","role":"guest"}`} {
		g := dial(t, url)
		if err := g.raw(websocket.MessageText, []byte(s)); err != nil {
			t.Fatal(err)
		}
		if s == `{"t":"kick","id":1}` || s == `{"t":"close"}` {
			continue // a nobody's kick/close: silently ignored
		}
		if m, _ := g.next(); m.T != "error" {
			t.Fatalf("%s → %+v", s, m)
		}
	}
	// Broken JSON / wrong types: bad_request, then the socket is dropped (only the sender is hurt).
	for _, s := range []string{`{`, `[]`, `"t"`, `{"t":"join","id":70000}`, `{"t":"join","id":-1}`, `{"t":5}`,
		strings.Repeat("[", 900)} {
		g := dial(t, url)
		_ = g.raw(websocket.MessageText, []byte(s))
		if !g.closed(2 * time.Second) {
			t.Errorf("%.20q: socket kept", s)
		}
	}
	// Invalid UTF-8 and a huge name: cleaned, not echoed raw.
	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	g := dial(t, url)
	_ = g.raw(websocket.MessageText, []byte(`{"t":"join","room":"`+room+`","role":"guest","name":"`+"\xff\xfe"+strings.Repeat("é", 100)+`"}`))
	g.expect("joined")
	if m := host.expect("peer"); len([]rune(m.Name)) > 24 {
		t.Fatalf("name not cleaned: %q", m.Name)
	}
}

func TestBrutalOversizedFrames(t *testing.T) {
	h, url := brutalServer(t, 10, 4, time.Minute)
	// Lobby: 1 KB max. A 2 KB hello drops only that socket.
	big := dial(t, url)
	_ = big.raw(websocket.MessageText, []byte(`{"t":"create","name":"`+strings.Repeat("a", 2048)+`"}`))
	if !big.closed(2 * time.Second) {
		t.Fatal("oversized lobby frame accepted")
	}
	// Guest: 8 KB max.
	host := dial(t, url)
	host.send(control{T: "create"})
	c := host.expect("created")
	g := dial(t, url)
	g.send(control{T: "join", Room: c.Room, Role: "guest"})
	g.expect("joined")
	host.expect("peer")
	_ = g.raw(websocket.MessageBinary, append([]byte{kindFrom, 0, 0}, make([]byte, 9<<10)...))
	if !g.closed(2 * time.Second) {
		t.Fatal("oversized guest frame accepted")
	}
	host.expect("peer") // off
	// Host: 256 KB max. Over it drops the host, but the room waits for a resume.
	_ = host.raw(websocket.MessageBinary, append([]byte{kindEvent, 0, 0}, make([]byte, 257<<10)...))
	if !host.closed(2 * time.Second) {
		t.Fatal("oversized host frame accepted")
	}
	if rooms, _ := h.stats(); rooms != 1 {
		t.Fatal("room lost with the host")
	}
	back := dial(t, url)
	back.send(control{T: "resume", Room: c.Room, Token: c.Token})
	back.expect("created")
}

func TestBrutalResumeWithForeignToken(t *testing.T) {
	h, url := brutalServer(t, 10, 4, 20*time.Millisecond)
	a, b := dial(t, url), dial(t, url)
	a.send(control{T: "create"})
	ra := a.expect("created")
	b.send(control{T: "create"})
	rb := b.expect("created")
	try := func(room, token string) string {
		x := dial(t, url)
		x.send(control{T: "resume", Room: room, Token: token})
		m, _ := x.next()
		return m.T + ":" + m.Code
	}
	for _, tc := range [][2]string{{ra.Room, rb.Token}, {ra.Room, ""}, {ra.Room, strings.ToUpper(ra.Token)},
		{"", ""}, {"", ra.Token}, {"ZZZZZZ", ra.Token}, {strings.ToLower(ra.Room), ra.Token}} {
		if got := try(tc[0], tc[1]); got != "error:room_not_found" {
			t.Errorf("resume %q/%q → %s", tc[0], tc[1], got)
		}
	}
	// Same after the room expired: only its own token reopens it.
	_ = a.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(60 * time.Millisecond)
	h.sweep(time.Now())
	for _, tok := range []string{rb.Token, "", "x"} {
		if got := try(ra.Room, tok); got != "error:room_not_found" {
			t.Errorf("expired resume with %q → %s", tok, got)
		}
	}
	if got := try(ra.Room, ra.Token); got != "created:" {
		t.Errorf("own token: %s", got)
	}
}

func TestBrutalJoinFloodRace(t *testing.T) {
	h, url := brutalServer(t, 10, 64, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	// The host keeps reading (a healthy host).
	var hostSaw sync.WaitGroup
	hostSaw.Add(1)
	ons := 0
	go func() {
		defer hostSaw.Done()
		for ons < 64 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, b, err := host.ws.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			var m control
			if json.Unmarshal(b, &m) == nil && m.T == "peer" && m.On != nil && *m.On {
				ons++
			}
		}
	}()
	var mu sync.Mutex
	got := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 90; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http")+"/ws", nil)
			if err != nil {
				mu.Lock()
				got["dial"]++
				mu.Unlock()
				return
			}
			t.Cleanup(func() { _ = ws.CloseNow() })
			b, _ := json.Marshal(control{T: "join", Room: room, Role: "guest"})
			_ = ws.Write(ctx, websocket.MessageText, b)
			_, r, err := ws.Read(ctx)
			var m control
			_ = json.Unmarshal(r, &m)
			mu.Lock()
			got[m.T+":"+m.Code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	hostSaw.Wait()
	if got["joined:"] != 64 || got["error:room_full"] != 26 || ons != 64 {
		t.Fatalf("joins %v, host saw %d", got, ons)
	}
	if _, conns := h.stats(); conns != 65 {
		t.Fatalf("conns %d", conns)
	}
}

func TestBrutalSlowPeerIsDroppedHostStays(t *testing.T) {
	_, url := brutalServer(t, 10, 4, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	slow := dial(t, url) // never reads after joining
	slow.send(control{T: "join", Room: room, Role: "guest"})
	slow.expect("joined")
	host.expect("peer")
	time.Sleep(2 * time.Second) // the host's bucket starts from the lobby's 10 and fills to 120 at 60/s
	payload := strings.Repeat("e", 200<<10)
	for i := 0; i < 115; i++ { // inside the host's burst
		host.frame(kindEvent, 0, payload)
	}
	// The slow peer goes (too slow, or the 5 s write timeout); the host is told and stays.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_, b, err := host.ws.Read(ctx)
	var m control
	_ = json.Unmarshal(b, &m)
	if err != nil || m.T != "peer" || m.On == nil || *m.On {
		t.Fatalf("slow peer not dropped: %+v %v", m, err)
	}
	host.send(control{T: "kick", ID: 99}) // still alive and accepted
	g := dial(t, url)
	g.send(control{T: "join", Room: room, Role: "guest"})
	g.expect("joined")
	host.expect("peer")
}

func TestBrutalCloseDuringResume(t *testing.T) {
	h, url := brutalServer(t, 100, 4, time.Minute)
	for i := 0; i < 25; i++ {
		a := dial(t, url)
		a.send(control{T: "create"})
		c := a.expect("created")
		g := dial(t, url)
		g.send(control{T: "join", Room: c.Room, Role: "guest"})
		g.expect("joined")
		a.expect("peer")
		b := dial(t, url)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _ = a.raw(websocket.MessageText, []byte(`{"t":"close"}`)) }()
		go func() {
			defer wg.Done()
			m, _ := json.Marshal(control{T: "resume", Room: c.Room, Token: c.Token})
			_ = b.raw(websocket.MessageText, m)
		}()
		wg.Wait()
		m, _ := b.next()
		h.mu.Lock()
		r := h.rooms[c.Room]
		h.mu.Unlock()
		switch m.T {
		case "created": // resume won: the old host's close is a no-op, the room lives on with b
			if r == nil {
				t.Fatalf("round %d: resumed but room gone", i)
			}
			if gm := g.expect("host"); !*gm.On {
				t.Fatalf("round %d: guest saw %+v", i, gm)
			}
		case "error": // close won: room gone for good
			if r != nil {
				t.Fatalf("round %d: closed but room still there", i)
			}
			g.expect("closed")
		default:
			t.Fatalf("round %d: %+v", i, m)
		}
		_ = a.ws.CloseNow()
		_ = b.ws.CloseNow()
		_ = g.ws.CloseNow()
	}
}

func TestBrutalManyRoomsExpireMemoryBounded(t *testing.T) {
	const n = 2000
	h := newHub(n, 2, time.Minute)
	now := time.Now()
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	// Ten waves of a full server abandoned by its hosts (one create-flood every grace period).
	for wave := 0; wave < 10; wave++ {
		for i := 0; i < n; i++ {
			c := fake(h)
			if r, code := h.create(c); r == nil {
				t.Fatalf("wave %d: %s", wave, code)
			}
			h.leave(c)
		}
		now = now.Add(70 * time.Second)
		h.sweep(now)
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if rooms, _ := h.stats(); rooms != 0 || len(h.expired) != 10*n {
		t.Fatalf("rooms %d expired %d", rooms, len(h.expired))
	}
	per := float64(after.HeapAlloc-before.HeapAlloc) / float64(len(h.expired))
	// Worst case kept for an hour: maxRooms per (grace + sweep) → 2000 × 3600/70 ≈ 103k entries.
	t.Logf("expired room memory: %.0f B/entry → ~%.1f MB at the 1 h worst case (relay container: 48 MB)",
		per, per*103_000/1e6)
	h.sweep(now.Add(keepExpired + time.Second))
	if len(h.expired) != 0 {
		t.Fatalf("expired not pruned: %d", len(h.expired))
	}
}

// Everything at once under -race: creates, joins, frames, kicks, closes, resumes, drops. No panic, no leak.
func TestBrutalConcurrentChaos(t *testing.T) {
	h := newHub(50, 8, 10*time.Millisecond)
	srv := httptest.NewServer(server(h, []string{"*"}))
	defer srv.Close()
	url := srv.URL
	runtime.GC()
	base := runtime.NumGoroutine()

	wsURL := "ws" + strings.TrimPrefix(url, "http") + "/ws"
	var rooms sync.Map // code → token
	var wg sync.WaitGroup
	deadline := time.Now().Add(2 * time.Second)
	for w := 0; w < 24; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rnd := rand.New(rand.NewSource(seed))
			for time.Now().Before(deadline) {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				ws, _, err := websocket.Dial(ctx, wsURL, nil)
				if err != nil {
					cancel()
					continue
				}
				// Drain everything in the background so only our own chaos drops us.
				read := make(chan control, 256)
				go func() {
					defer close(read)
					for {
						typ, b, err := ws.Read(ctx)
						if err != nil {
							return
						}
						if typ == websocket.MessageText {
							var m control
							_ = json.Unmarshal(b, &m)
							select {
							case read <- m:
							default:
							}
						}
					}
				}()
				send := func(m control) { b, _ := json.Marshal(m); _ = ws.Write(ctx, websocket.MessageText, b) }
				bin := func(kind byte, n int) {
					b := make([]byte, 3+n)
					b[0], b[2] = kind, byte(rnd.Intn(8))
					_ = ws.Write(ctx, websocket.MessageBinary, b)
				}
				switch rnd.Intn(4) {
				case 0: // host
					send(control{T: "create"})
					for m := range read {
						if m.T == "created" {
							rooms.Store(m.Room, m.Token)
						}
						if m.T == "created" || m.T == "error" {
							break
						}
					}
					for i := 0; i < 20; i++ {
						switch rnd.Intn(5) {
						case 0:
							bin(kindState, rnd.Intn(4000))
						case 1:
							bin(kindEvent, rnd.Intn(2000))
						case 2:
							bin(kindTo, rnd.Intn(100))
						case 3:
							send(control{T: "kick", ID: uint16(rnd.Intn(8))})
						case 4:
							if rnd.Intn(4) == 0 {
								send(control{T: "close"})
							}
						}
					}
				case 1: // resumer
					rooms.Range(func(k, v any) bool {
						send(control{T: "resume", Room: k.(string), Token: v.(string)})
						return rnd.Intn(3) != 0
					})
					bin(kindEvent, 10)
				case 2, 3: // guests
					rooms.Range(func(k, _ any) bool {
						send(control{T: "join", Room: k.(string), Role: "guest"})
						return false
					})
					for i := 0; i < 10; i++ {
						bin(kindFrom, rnd.Intn(500))
					}
					if rnd.Intn(2) == 0 {
						_ = ws.Write(ctx, websocket.MessageText, []byte("{garbage"))
					}
				}
				time.Sleep(time.Duration(rnd.Intn(30)) * time.Millisecond)
				if rnd.Intn(2) == 0 {
					_ = ws.Close(websocket.StatusNormalClosure, "")
				} else {
					_ = ws.CloseNow()
				}
				cancel()
			}
		}(int64(w))
	}
	wg.Wait()
	time.Sleep(50 * time.Millisecond)
	h.sweep(time.Now().Add(time.Second))
	// All sockets gone: every room is past its grace, every goroutine is back.
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		h.sweep(time.Now().Add(time.Second))
		if _, conns := h.stats(); conns == 0 && runtime.NumGoroutine() <= base+2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if rooms, conns := h.stats(); rooms != 0 || conns != 0 {
		t.Errorf("left: rooms %d conns %d", rooms, conns)
	}
	if g := runtime.NumGoroutine(); g > base+2 {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Errorf("goroutine leak: %d → %d\n%s", base, g, buf[:n])
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Real bugs (these fail on main)
// ---------------------------------------------------------------------------------------------------------------

// BUG (critical): the write queue is bounded in frames (64), not bytes. A host may send 256 KB frames, so one
// non-reading peer pins 64 × 256 KB = 16 MB; three sock-puppet peers pin the relay's whole 48 MB container
// (deploy/compose.yml mem_limit) → OOM kill → every live club dies. Anyone can be a host (create is free).
func TestBrutalQueueBytesUnbounded(t *testing.T) {
	h, url := brutalServer(t, 10, 8, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	const peers = 3
	ids := make([]uint16, peers)
	for i := range ids {
		p := dial(t, url) // joins, then never reads again
		p.send(control{T: "join", Room: room, Role: "guest"})
		ids[i] = p.expect("joined").ID
	}
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	payload := strings.Repeat("x", int(hostLimits.maxFrame)-headerLen) // the biggest frame a host may send
	time.Sleep(2 * time.Second)                                        // let the host's bucket fill (it starts from the lobby's 10)
	sent := 0
	start := time.Now()
	for n := 0; n < 80*peers; n++ {
		// Stay under the host bucket: 120 burst, then 60/s.
		if n >= 110 {
			time.Sleep(time.Second / 55)
		}
		host.frame(kindTo, ids[n%peers], payload)
		sent++
	}
	// Peak (before the 5 s write timeout lets the stuck peers go): what the relay holds for them.
	queued := 0
	h.mu.Lock()
	for _, p := range h.rooms[room].peers {
		queued += len(p.queue)
	}
	h.mu.Unlock()
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	held := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("sent %d × 256 KB in %v; %d frames queued (%.1f MB), heap +%.1f MB",
		sent, time.Since(start).Round(time.Millisecond), queued, float64(int64(queued)*hostLimits.maxFrame)/1e6, float64(held)/1e6)
	if held > 16<<20 {
		t.Errorf("one host + %d non-reading peers pin %.1f MB of relay heap (container cap 48 MB): queue must be bounded in bytes",
			peers, float64(held)/1e6)
	}
}

// BUG (high): no cap on sockets and no hello deadline. Sockets that never say hello stay forever (a ping keeps them),
// each costing server memory, and one IP may open as many as it likes.
func TestBrutalIdleSocketsUncapped(t *testing.T) {
	_, url := brutalServer(t, 10, 4, time.Minute)
	addr := strings.TrimPrefix(url, "http://")
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	const n = 400
	conns := make([]net.Conn, 0, n)
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	for i := 0; i < n; i++ {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(c, "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", addr)
		res, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil || res.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("socket %d refused: %v", i, err)
		}
		conns = append(conns, c)
	}
	time.Sleep(1500 * time.Millisecond)
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	alive := 0
	for _, c := range conns {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Millisecond))
		if _, err := c.Read(make([]byte, 1)); err != nil && strings.Contains(err.Error(), "timeout") {
			alive++
		}
	}
	per := float64(int64(after.HeapInuse+after.StackInuse)-int64(before.HeapInuse+before.StackInuse)) / n
	t.Logf("%d/%d silent sockets from one IP still open after 1.5 s; ~%.0f KB each → ~%.0f sockets fill 48 MB",
		alive, n, per/1024, 48e6/per)
	if alive == n {
		t.Errorf("all %d silent sockets from one IP accepted and kept: no per-IP cap, no hello deadline", n)
	}
}

// BUG (high): rooms abandoned by their host count toward MAX_ROOMS for the whole grace period. One client opens
// MAX_ROOMS rooms and hangs up; nobody can open a club (server_full) for ~70 s, and it repeats forever.
func TestBrutalCreateFloodServerFull(t *testing.T) {
	const maxRooms = 30
	_, url := brutalServer(t, maxRooms, 4, time.Minute)
	for i := 0; i < maxRooms; i++ {
		a := dial(t, url)
		a.send(control{T: "create"})
		a.expect("created")
		_ = a.ws.CloseNow()
	}
	time.Sleep(50 * time.Millisecond)
	legit := dial(t, url)
	legit.send(control{T: "create", Name: "Real CEO"})
	if m, _ := legit.next(); m.T != "created" {
		t.Errorf("one client holding %d abandoned rooms locks every new club out: %+v", maxRooms, m)
	}
}

// BUG (high): a guest can get the host dropped. Peer input goes through offer() (refused with host_busy when the
// host's queue is full) but control messages to the host go through enqueue(), which drops a full receiver. So:
// flood input until the host's queue is full, then any join/leave → host closed "too slow". Repeatable.
func TestBrutalGuestFloodDropsHost(t *testing.T) {
	h := newHub(10, 64, time.Minute)
	host := fake(h)
	r, _ := h.create(host)
	g := fake(h)
	h.join(g, r.code) // host queue: 1 (peer on)
	in := []byte{kindFrom, 0, 0, 'b', 'u', 'y'}
	for i := 0; i < queueLen; i++ {
		g.route(in) // 63 fit, then host_busy (correct so far)
	}
	if isDone(host) {
		t.Fatal("host dropped by input alone")
	}
	h.join(fake(h), r.code) // a second (sock-puppet) connection joins, or g just reconnects
	if isDone(host) {
		t.Errorf("guest input + one join dropped the host (%q): control messages to the host must not drop it", reasonOf(host))
	}
}

// BUG (low, zero margin): a host resuming a full room gets "created" plus one "peer" per guest = 65 control messages
// in one locked burst into a 64-slot queue. Over real sockets it survives only because the first send is handed
// straight to the parked write loop (TestBrutalResumeFullRoomOverSockets passes); if the writer is busy (a ping, a
// slow first write) the host is closed "too slow", reconnects, resumes again → loop.
func TestBrutalResumeFullRoomOverflowsQueue(t *testing.T) {
	h := newHub(10, 64, time.Minute)
	host := fake(h)
	r, _ := h.create(host)
	for i := 0; i < 64; i++ {
		h.join(fake(h), r.code)
	}
	h.leave(host)
	back := fake(h)
	if _, code := h.resume(back, r.code, r.token); code != "" {
		t.Fatal(code)
	}
	if isDone(back) {
		t.Errorf("resume with 64 guests: host dropped (%q), %d queued of %d", reasonOf(back), len(back.queue), queueLen)
	}
}

// BUG (medium): kick doesn't stick. The relay keeps no record, so a kicked client reconnects and joins at once
// (the honest client stops on "kicked"; a hostile one doesn't).
func TestBrutalKickThenImmediateRejoin(t *testing.T) {
	_, url := brutalServer(t, 10, 4, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create"})
	room := host.expect("created").Room
	g := dial(t, url)
	g.send(control{T: "join", Room: room, Role: "guest", Name: "troll"})
	id := g.expect("joined").ID
	host.expect("peer")
	host.send(control{T: "kick", ID: id})
	g.expect("kicked")
	again := dial(t, url)
	again.send(control{T: "join", Room: room, Role: "guest", Name: "troll"})
	if m, _ := again.next(); m.T == "joined" {
		t.Errorf("kicked client rejoined at once as id %d", m.ID)
	}
}

// BUG (low): the per-connection rate limit starts every socket with a full bucket, so a client that reconnects
// gets 10 free create/join/resume tries each time: room codes of invite-only clubs can be enumerated.
func TestBrutalRateLimitResetByReconnect(t *testing.T) {
	_, url := brutalServer(t, 10, 4, time.Minute)
	limited := 0
	for c := 0; c < 20; c++ {
		x := dial(t, url)
		for i := 0; i < 10; i++ {
			x.send(control{T: "join", Room: fmt.Sprintf("Z%05d", c*10+i), Role: "guest"})
		}
		for i := 0; i < 10; i++ {
			if m, _ := x.next(); m.Code == "rate_limited" {
				limited++
			}
		}
		_ = x.ws.CloseNow()
	}
	if limited == 0 {
		t.Errorf("200 room-code guesses in a burst from one IP, none rate limited")
	}
}

// BUG (low): a replaced host (another tab resumed) keeps broadcasting to the room until its read loop ends; a kicked
// peer's input keeps reaching the host. route() never checks the connection is still current.
func TestBrutalReplacedHostStillBroadcasts(t *testing.T) {
	h := newHub(10, 4, time.Minute)
	old := fake(h)
	r, _ := h.create(old)
	g := fake(h)
	h.join(g, r.code)
	h.resume(fake(h), r.code, r.token)
	if !isDone(old) {
		t.Fatal("old host not replaced")
	}
	for len(g.queue) > 0 {
		<-g.queue
	}
	old.route([]byte{kindEvent, 0, 0, 'f', 'a', 'k', 'e'})
	if len(g.queue) > 0 {
		t.Errorf("replaced host's frame still reached the guest: %q", <-g.queue)
	}
}

// The resume overflow over real sockets: a host with 64 guests drops and resumes. The write loop drains
// concurrently, so it's a race against the lock-held burst of 65 messages.
func TestBrutalResumeFullRoomOverSockets(t *testing.T) {
	h, url := brutalServer(t, 10, 64, time.Minute)
	host := dial(t, url)
	host.send(control{T: "create"})
	c := host.expect("created")
	for i := 0; i < 64; i++ {
		g := dial(t, url)
		g.send(control{T: "join", Room: c.Room, Role: "guest"})
		g.expect("joined")
		go func() { // guests keep reading
			for {
				if _, _, err := g.ws.Read(context.Background()); err != nil {
					return
				}
			}
		}()
	}
	_ = host.ws.CloseNow()
	dropped := 0
	const rounds = 10
	for i := 0; i < rounds; i++ {
		time.Sleep(20 * time.Millisecond)
		back := dial(t, url)
		back.send(control{T: "resume", Room: c.Room, Token: c.Token})
		got := 0
		for got < 65 {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _, err := back.ws.Read(ctx)
			cancel()
			if err != nil {
				break
			}
			got++
		}
		h.mu.Lock()
		gone := h.rooms[c.Room] == nil || h.rooms[c.Room].host == nil
		h.mu.Unlock()
		if got < 65 || gone {
			dropped++
		}
		_ = back.ws.CloseNow()
	}
	if dropped > 0 {
		t.Errorf("host resuming a room of 64 dropped in %d/%d rounds (65 control messages > queue of %d)", dropped, rounds, queueLen)
	}
}
