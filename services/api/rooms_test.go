package main

import (
	"errors"
	"testing"
	"time"
)

func TestOpenClubs(t *testing.T) {
	rl := newRoomList()
	now := time.Now()
	club := LiveRoom{Room: "k7qx9p", Club: "Simpruy club", Level: 5, Players: 2, Night: true}
	if err := rl.announce("ceo", "Kiel", club, now); err != nil {
		t.Fatal(err)
	}
	l := rl.list(now)
	if len(l) != 1 || l[0].Room != "K7QX9P" || l[0].Host != "Kiel" || l[0].Club != "Simpruy club" {
		t.Fatalf("%+v", l)
	}
	// Someone else can't take over a live code; bad input is refused.
	if err := rl.announce("intruder", "X", club, now); !errors.Is(err, errConflict) {
		t.Fatalf("taken code: %v", err)
	}
	for _, bad := range []LiveRoom{{Room: "a", Club: "x", Level: 1}, {Room: "ABCDEF", Club: "", Level: 1}, {Room: "ABCDEF", Club: "x", Level: 9}} {
		if err := rl.announce("ceo", "Kiel", bad, now); !errors.Is(err, errBad) {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	// Heartbeats keep it; silence drops it.
	club.Players = 9
	rl.announce("ceo", "Kiel", club, now.Add(30*time.Second))
	if l = rl.list(now.Add(60 * time.Second)); len(l) != 1 || l[0].Players != 9 {
		t.Fatalf("after heartbeat: %+v", l)
	}
	if l = rl.list(now.Add(2 * time.Minute)); len(l) != 0 {
		t.Fatalf("stale room kept: %+v", l)
	}
	// A host closes their own club only; and has a cap on open clubs.
	rl.announce("ceo", "Kiel", club, now)
	rl.remove("intruder", "K7QX9P")
	if len(rl.list(now)) != 1 {
		t.Fatal("removed by someone else")
	}
	rl.remove("ceo", "k7qx9p")
	if len(rl.list(now)) != 0 {
		t.Fatal("not removed by its host")
	}
	for i, code := range []string{"AAAA", "BBBB", "CCCC", "DDDD"} {
		err := rl.announce("ceo", "Kiel", LiveRoom{Room: code, Club: "c", Level: 1}, now)
		if (i < roomsPerHost) != (err == nil) {
			t.Fatalf("room %d: %v", i, err)
		}
	}
}
