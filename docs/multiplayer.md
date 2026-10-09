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
`host_busy`, `kicked`, `too_many_rooms`, `too_many_connections` (the client backs off and retries the full/busy ones).

Limits (one relay process, all in memory; env in `deploy/compose.yml`):

| What | Default | Why |
| --- | --- | --- |
| Peers a room | 64 (`MAX_PEERS`) | |
| Sockets in total / per IP | 1000 / 100 (`MAX_CONNS`, `MAX_CONNS_PER_IP`) | memory: ~40 KB a socket; over the cap the socket is told `too_many_connections` and closed |
| Hello deadline | 10 s | a socket that never creates/joins/resumes is closed |
| Rooms per player | 8 (`MAX_ROOMS_PER_PLAYER`), abandoned ones in their grace period too | one client can't take every room |
| Server full | `MAX_ROOMS` | the room whose host has been gone longest closes early (still resumable) instead of refusing |
| Wrong room codes per IP | 20, then 12 a minute | codes can't be guessed by reconnecting |
| Queued bytes per client / all clients | 256 KB / 16 MB (`QUEUE_BUDGET_MB`) | a client that doesn't read is dropped, never pins memory; peer input may fill half the host's queue, so the host is never dropped for its guests' spam |
| Kick | that player can't rejoin that room for 10 min (`KICK_BAN_SEC`) | |

**Tickets.** With `RELAY_TICKET_SECRET` set (the api has the same value), every create, join and resume carries a
ticket from `POST /api/relay/ticket`: `v1.<base64url {"sub":account,"exp":unix}>.<base64url HMAC-SHA256>`, valid 10
minutes, issued only to signed-in, unbanned players. A missing, forged or expired ticket gets `bad_ticket`. A "player"
above is then the account, so a kick or the room cap never hits a friend behind the same router; without the secret
(dev) it is the IP. Sockets per IP and wrong room codes per IP stay per IP (they come before anyone says who they are).
A room only resumes for the account that opened it (a leaked room token isn't enough). The secret must be at least
32 bytes (`openssl rand -hex 32`); the relay won't start with a shorter one. Tickets are checked on create/join/resume,
so a ban keeps a player out of new rooms at once but doesn't drop one already inside (until they disconnect).

The client (`net/ticket.ts`) fetches the ticket before opening the socket (5 s timeout), keeps it 9 minutes for the
account it was issued to, and fetches a new one after `bad_ticket` (also on a first join). If the api is away it waits
and retries with the backoff; if a fresh ticket is refused too (signed out, banned) it stops with a message, and a host
closes its club.

`TRUST_PROXY` lists the proxies (container names, IPs or CIDRs) whose `X-Forwarded-For` is believed; the client IP is
its last hop (the one Caddy wrote). A header from anyone else on the Docker network is ignored. IPv6 clients are keyed
by their /64. Empty or wrong → every player shares the proxy's IP and the per-IP limits hit everyone; the relay logs a
warning at start.

The client (`relay.ts`) reconnects with exponential backoff and equal jitter (0.25–0.5 s, up to 4–8 s), resets it only
after a connection held 10 s, stops for good on closed/kicked/room gone, and stands down when another tab takes the
room over (`replaced`).

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

## The CEO's show

The host is the only source of the show: every pyro burst its venue fires (auto or manual,
`VenueScene.onBurst`), every sampler pad (`playPad`) and the videotron messages go out as reliable events
(`{t:"fx"}`, `{t:"pad"}`, `{t:"shout"}`; a newcomer gets the messages on joining). Guests and the DJ turn their own
auto pyro off and play exactly what arrives.

## Finding a club

A CEO's club is open to players whenever the CEO is in it (not the Basement challenge): the browser opens a relay
room on entering the game and announces it to the api every 20 s (`POST /api/rooms`, `apps/web/src/api/rooms.ts`);
guests see it under "Clubs open now" (`GET /api/rooms`) and join with one click. The api keeps the list in memory
and forgets a club 45 s after its last announcement.

## Events and invites

A CEO schedules events at any of their clubs (Office → Events, or Events on a club card): date and time, length,
public or private. Guests mark "I'm going"; a private event is reached through its invite link (`/?event=CODE`).
When the host opens the club in the event's window, the room is attached to the event (`PUT /api/events/{id}/room`)
and everyone going gets a "… is live: Join now" banner on the dashboard. A private event makes the club invite-only
(not listed under Clubs open now); the host can also switch the open club between Public and Invite only.

## Testing

`pnpm test` covers the codec and relay client; `pnpm test:go` runs the relay with the race detector. Load test:

```sh
cd services/relay && go run ./cmd/loadtest -url ws://127.0.0.1:8787/ws -rooms 10 -peers 30
```
