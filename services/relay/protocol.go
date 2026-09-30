// Package main is the NYXERON multiplayer relay: it only connects players. A room belongs to one host (the CEO's
// browser, which runs the simulation); guests and DJs join it. The relay never reads game data: it routes opaque
// binary frames by a 3-byte header and speaks a few small JSON control messages.
//
// Binary frames: [kind u8][peer u16 big-endian][payload…]
//
//	kindState  host → every peer. Latest wins: a slow peer skips stale snapshots instead of queueing them.
//	kindEvent  host → every peer, reliable (queued, in order).
//	kindTo     host → one peer (peer = target id).
//	kindFrom   peer → host. The relay overwrites `peer` with the sender's id (peers can't spoof it).
//
// Control (text, JSON), client → relay:
//
//	{"t":"create","name":"…"}                     host opens a room → {"t":"created","room":"K7QX9P","token":"…"}
//	{"t":"resume","room":"…","token":"…"}          host reconnects within the grace period → {"t":"created",…}
//	{"t":"join","room":"…","name":"…","role":"guest|dj"} → {"t":"joined","room":"…","id":N}
//	{"t":"kick","id":N}                            host only
//
// Relay → clients: {"t":"peer","id":N,"name":"…","role":"…","on":true|false} (to the host),
// {"t":"host","on":true|false} (to peers), {"t":"closed"}, {"t":"error","code":"…"}.
// Error codes: room_not_found, room_full, server_full, bad_request, already_in_room, rate_limited, host_busy.
package main

const (
	kindState byte = 1
	kindEvent byte = 2
	kindTo    byte = 3
	kindFrom  byte = 4

	headerLen = 3
)

// control is every JSON control message, in and out (unused fields are omitted).
type control struct {
	T     string `json:"t"`
	Room  string `json:"room,omitempty"`
	Token string `json:"token,omitempty"`
	Name  string `json:"name,omitempty"`
	Role  string `json:"role,omitempty"`
	ID    uint16 `json:"id,omitempty"`
	On    *bool  `json:"on,omitempty"`
	Code  string `json:"code,omitempty"`
}

func boolp(b bool) *bool { return &b }
