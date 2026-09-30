package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http/httptest"
	"strings"
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
