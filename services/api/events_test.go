package main

import (
	"errors"
	"testing"
	"time"
)

func TestEvents(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	start := now.Add(2 * time.Hour).Unix()
	for _, u := range []string{"ceo", "guest", "stranger"} {
		s.Get(ctx, u)
	}

	// A practice club (no lease) hosts events from Level 3; a booth can't.
	if _, err := s.Event(ctx, "ceo", EventInput{Club: "Kiel Booth", Level: 1, StartsAt: start}, now); !errors.Is(err, errRejected) {
		t.Fatalf("booth event: %v", err)
	}
	pub, err := s.Event(ctx, "ceo", EventInput{Club: "Simpruy club", Level: 5, StartsAt: start, Title: "Launch"}, now)
	if err != nil || pub.Minutes != 10 || pub.Club != "Simpruy club" || pub.Private || pub.Invite == "" || !pub.Mine {
		t.Fatalf("%+v %v", pub, err)
	}
	if _, err := s.Event(ctx, "ceo", EventInput{Club: "Simpruy club", Level: 5, StartsAt: start + 60}, now); !errors.Is(err, errConflict) {
		t.Fatalf("overlap: %v", err)
	}
	priv, err := s.Event(ctx, "ceo", EventInput{Club: "Simpruy club", Level: 5, StartsAt: start + 3600, Private: true}, now)
	if err != nil {
		t.Fatal(err)
	}

	// Strangers see the public one (without its invite code), not the private one.
	list, _ := s.Events(ctx, "stranger", now)
	if len(list) != 1 || list[0].ID != pub.ID || list[0].Invite != "" {
		t.Fatalf("stranger sees %+v", list)
	}
	if _, err := s.RSVP(ctx, "stranger", priv.ID, true, now); !errors.Is(err, errNotFound) {
		t.Fatalf("RSVP to a private event without the invite: %v", err)
	}

	// The invite link lists the private event for the guest and marks them as going.
	got, err := s.Invite(ctx, "guest", priv.Invite, now)
	if err != nil || got.ID != priv.ID || !got.IGo || got.Going != 1 {
		t.Fatalf("invite: %+v %v", got, err)
	}
	if list, _ = s.Events(ctx, "guest", now); len(list) != 2 {
		t.Fatalf("guest sees %d events", len(list))
	}
	if g, _ := s.RSVP(ctx, "guest", pub.ID, true, now); !g.IGo || g.Going != 1 {
		t.Fatalf("rsvp: %+v", g)
	}
	if g, _ := s.RSVP(ctx, "guest", pub.ID, false, now); g.IGo || g.Going != 0 {
		t.Fatalf("un-rsvp: %+v", g)
	}

	// Live once the host opens the club in its window; the room shows to guests only then.
	at := time.Unix(start-60, 0)
	if err := s.EventRoom(ctx, "guest", pub.ID, "ROOM42", at); !errors.Is(err, errNotFound) {
		t.Fatalf("someone else's event: %v", err)
	}
	if err := s.EventRoom(ctx, "ceo", pub.ID, "room42", at); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Events(ctx, "stranger", at); !list[0].Live || list[0].Room != "ROOM42" {
		t.Fatalf("live: %+v", list[0])
	}
	// A practice club's event doesn't pay the host from guests' spend (only city venues do).
	tx, _ := s.db.Begin()
	if h := partyHost(tx, "ROOM42", at); h != "" {
		t.Fatalf("practice event paid out to %q", h)
	}
	tx.Rollback()

	if err := s.CancelEvent(ctx, "guest", pub.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("cancel someone else's: %v", err)
	}
	if err := s.CancelEvent(ctx, "ceo", pub.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Events(ctx, "stranger", now); len(list) != 0 {
		t.Fatalf("cancelled still listed: %+v", list)
	}
}

func TestPrivateRoomsAreNotListed(t *testing.T) {
	rl := newRoomList()
	now := time.Now()
	rl.announce("a", "A", LiveRoom{Room: "PUBL1C", Club: "Open", Level: 3}, now)
	rl.announce("b", "B", LiveRoom{Room: "PR1VAT", Club: "Invite only", Level: 3, Private: true}, now)
	if l := rl.list(now); len(l) != 1 || l[0].Room != "PUBL1C" {
		t.Fatalf("%+v", l)
	}
}
