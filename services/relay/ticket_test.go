package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// Signed by services/api/ticket_test.go (ticketVector): the two services agree on the format.
const ticketVector = "v1.eyJzdWIiOiJkaWQ6cHJpdnk6YWJjIiwiZXhwIjoxODAwMDAwMDAwfQ.Hj3vrKMr5FIzwJPhZZQJFZdDcEH9wPXGY-5FCPlLOag"

func TestVerifyTicket(t *testing.T) {
	key := []byte("test-secret")
	before := time.Unix(1800000000-1, 0)
	if sub, ok := verifyTicket(key, ticketVector, before); !ok || sub != "did:privy:abc" {
		t.Fatalf("api's vector: %q %v", sub, ok)
	}
	if _, ok := verifyTicket(key, ticketVector, time.Unix(1800000000, 0)); ok {
		t.Fatal("expired ticket accepted")
	}
	if _, ok := verifyTicket([]byte("other"), ticketVector, before); ok {
		t.Fatal("wrong secret accepted")
	}
	// Payload swapped for another account, signature kept.
	forged := "v1.eyJzdWIiOiJkaWQ6cHJpdnk6ZXZpbCIsImV4cCI6MTgwMDAwMDAwMH0" + ticketVector[len(ticketVector)-44:]
	for _, bad := range []string{"", "v1.", "v2" + ticketVector[2:], forged, ticketVector + "x", ticketVector[:40]} {
		if _, ok := verifyTicket(key, bad, before); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// sign mirrors services/api signTicket (TestVerifyTicket pins the shared format).
func sign(secret []byte, sub string, exp time.Time) string {
	b, _ := json.Marshal(map[string]any{"sub": sub, "exp": exp.Unix()})
	head := "v1." + base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(head))
	return head + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestTicketsKeyKicksAndRoomsByAccount(t *testing.T) {
	h, url := setup(t, time.Minute)
	h.ticketKey = []byte("s3cret")
	h.maxRoomsPer = 1
	tk := func(who string) string { return sign(h.ticketKey, who, time.Now().Add(time.Minute)) }

	anon := dial(t, url)
	anon.send(control{T: "create"})
	if m := anon.expect("error"); m.Code != "bad_ticket" {
		t.Fatalf("no ticket: %+v", m)
	}
	host := dial(t, url)
	host.send(control{T: "create", Ticket: tk("ceo")})
	c := host.expect("created")
	again := dial(t, url)
	again.send(control{T: "create", Ticket: tk("ceo")})
	if m := again.expect("error"); m.Code != "too_many_rooms" {
		t.Fatalf("second room for one account: %+v", m)
	}

	// Every socket here is 127.0.0.1: the kick follows the account, so a friend on the same network still gets in.
	troll := dial(t, url)
	troll.send(control{T: "join", Room: c.Room, Role: "guest", Ticket: tk("troll")})
	id := troll.expect("joined").ID
	host.expect("peer")
	host.send(control{T: "kick", ID: id})
	troll.expect("kicked")
	back := dial(t, url)
	back.send(control{T: "join", Room: c.Room, Role: "guest", Ticket: tk("troll")})
	if m := back.expect("error"); m.Code != "kicked" {
		t.Fatalf("kicked account rejoined: %+v", m)
	}
	friend := dial(t, url)
	friend.send(control{T: "join", Room: c.Room, Role: "guest", Ticket: tk("friend")})
	friend.expect("joined")
}

func TestTicketResumeOnlyByTheOwner(t *testing.T) {
	h, url := setup(t, time.Minute)
	h.ticketKey = []byte("s3cret")
	tk := func(who string) string { return sign(h.ticketKey, who, time.Now().Add(time.Minute)) }
	host := dial(t, url)
	host.send(control{T: "create", Ticket: tk("ceo")})
	c := host.expect("created")
	_ = host.ws.CloseNow()
	time.Sleep(50 * time.Millisecond)
	thief := dial(t, url) // has the room token (leaked), but not the account
	thief.send(control{T: "resume", Room: c.Room, Token: c.Token, Ticket: tk("thief")})
	if m := thief.expect("error"); m.Code != "room_not_found" {
		t.Fatalf("another account resumed the room: %+v", m)
	}
	back := dial(t, url)
	back.send(control{T: "resume", Room: c.Room, Token: c.Token, Ticket: tk("ceo")})
	back.expect("created")
}
