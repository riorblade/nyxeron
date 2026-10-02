# Multiplayer

## Model

- **Host-authoritative.** A room belongs to the CEO's browser, which runs the simulation. Guests and a DJ send
  intents; the host applies them to its `GameState` and broadcasts the result.
- **Dumb relay.** `services/relay` routes opaque binary frames and a few JSON control messages. It never parses
  game data and has no database, so it stays tiny (≈ 5 MB idle, ≈ 24 MB at 300 players).

## Wire format

Binary frames: `[kind u8][peer u16 big-endian][payload…]`

| Kind | Value | Direction | Delivery |
| --- | --- | --- | --- |
| state | 1 | host → all peers | latest wins: a slow peer skips stale snapshots |
| event | 2 | host → all peers | reliable, in order |
| to | 3 | host → one peer (`peer` = target) | reliable |
| from | 4 | peer → host | the relay overwrites `peer` with the sender (no spoofing) |

JSON control (text frames):

```
→ {"t":"create","name":"…"}                          ← {"t":"created","room":"K7QX9P","token":"…"}
→ {"t":"resume","room":"…","token":"…"}              host reconnects within 60 s
→ {"t":"join","room":"…","name":"…","role":"guest|dj"} ← {"t":"joined","room":"…","id":N}
→ {"t":"kick","id":N}                                host only
← {"t":"peer","id":N,"name":"…","role":"…","on":bool}  to the host
← {"t":"host","on":bool} · {"t":"closed"} · {"t":"error","code":"…"}
```

Error codes: `room_not_found`, `room_full`, `server_full`, `bad_request`, `already_in_room`, `rate_limited`,
`host_busy`. Limits: 64 peers a room, per-connection rate limits, frame size caps, bounded queues.

## Session layer (apps/web/src/net)

- `relay.ts`: connection, framing, host resume, reconnect with backoff.
- `codec.ts`: gzipped snapshots (`CompressionStream`); the public state keeps the last 40 log entries.
- `session.ts`: the three roles.
  - **Host:** `hostOpen` → room code + invite link (`/?join=CODE`); applies `visitorJoin/visitorBuy/visitorLeave`
    by player id (`night.visitors`); broadcasts ≤ 4 snapshots/s.
  - **Guest:** `guestJoin(code)`; renders snapshots; buys are intents; on leaving, the night settles to the api
    (`/api/nights`, with the room so a city party's tenant is paid).
  - **DJ:** sends mix state 4×/s (~300 B: track, playhead, tempo, EQ/filter/sends, faders, crossfader, loop) plus
    one-shot moves (pads, brake, backspin). Everyone's own engine follows (`dj/mixsync.ts`): aim ~0.12 s ahead,
    seek only past 0.25 s drift.

## Finding a club

A CEO's club is open to players whenever the CEO is in it (not the Basement challenge): the browser opens a relay
room on entering the game and announces it to the api every 20 s (`POST /api/rooms`, `apps/web/src/api/rooms.ts`);
guests see it under "Clubs open now" (`GET /api/rooms`) and join with one click. The api keeps the list in memory
and forgets a club 45 s after its last announcement.

## City parties

A scheduled party becomes live when its host opens a room in the party window; the room code is stored on the
party (`PUT /api/city/parties/{id}/room`) and shown in the city list for guests to join.

## Testing

`pnpm test` covers the codec and relay client; `pnpm test:go` runs the relay with the race detector. Load test:

```sh
cd services/relay && go run ./cmd/loadtest -url ws://127.0.0.1:8787/ws -rooms 10 -peers 30
```
