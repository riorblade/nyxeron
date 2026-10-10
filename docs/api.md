# HTTP API

Base URL: `https://api.nyxeron.xyz` (dev: same origin, Vite proxies `/api` to `:8788`). JSON in and out.

## Conventions

- **Auth.** Player and admin endpoints need `Authorization: Bearer <Privy access token>`. The player is always
  the token's subject. Agent endpoints use `Authorization: Bearer <AGENT_KEY>`.
- **Errors.** `{"error": "<code>"}` with:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | malformed input or out of bounds |
| 401 | `missing_token`, `invalid_token` | no/invalid credentials |
| 403 | `forbidden`, `banned` | role too low / account suspended (writes only) |
| 404 | `not_found` | no such player, lease, party, document |
| 409 | `conflict`, `no_lease`, `sold_out`, `venue_limit` | already done/taken, no venue rented, warehouse short |
| 422 | `rejected` | breaks a game rule (can't afford, over storage, out of stock…) |
| 503 | `not_configured` | the service is missing a secret or database |

- **CORS.** Only the game's own origins (`CORS_ORIGINS`) may call from a browser.

## Public

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/quotes` | spot prices `{quotes: {TICKER: usd}, source, at}` (cached 30 s) |
| GET | `/api/announcement` | the dashboard banner `{text, active, updatedAt}` (cached 60 s) |
| GET | `/api/city` | venues, parties, rent, prices, warehouse supply (a token marks your own) |
| GET | `/api/rooms` | clubs open right now `[{room, club, level, host, players, night, since}]` |
| GET | `/healthz` | `ok` |

## Player

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/me` | — | verified id, email, embedded wallet |
| POST | `/api/rooms` | `{room, club, level, players, night, private?}` | announce / heartbeat your open club (every ~20 s; dropped 45 s after the last; a private club isn't listed) |
| DELETE | `/api/rooms/{room}` | — | your club closed |
| POST | `/api/relay/ticket` | — | `{ticket, exp}`: a 10-minute pass for the multiplayer relay (403 banned, 503 when `RELAY_TICKET_SECRET` isn't set); see docs/multiplayer.md |
| GET | `/api/profile` | — | profile (created with the starter wallet on first call) |
| POST | `/api/profile/import` | profile | once: this device's pre-account data, bounded |
| PATCH | `/api/profile` | `{name?, avatar?}` | |
| POST | `/api/wallet/refill` | — | only when the wallet is nearly empty |
| POST | `/api/nights` | `{cash, bought, pnl, room?}` | a night out as a guest (play money): every unit cost ≥ 1, `pnl` within what the market range allows, `room` a relay code or empty, one per account per minute (409 if sooner) |
| POST | `/api/gigs` | `{fee}` | a DJ gig played to the end (capped, rate-limited) |
| GET | `/api/topups` | — | `{credits, topups}`: the player's credit balance and last 20 top-ups |
| POST | `/api/topups` | `{tx}` | report a USDC/USDT transfer from your embedded wallet to the Agentic Wallet; the api reads it on BSC and credits it once it is final. 202 `{status:"pending"}` until then; errors `tx_failed`, `not_a_topup` (422), `no_wallet` (409), `too_soon` (429), `paused`, `chain_unavailable`, `auth_unavailable`, `not_configured` (503). Minimum and caps: `payments.json` (see [payments.md](payments.md)) |
| GET | `/api/docs/{kind}` | — | `[{slot, updatedAt, meta}]` |
| GET/PUT/DELETE | `/api/docs/{kind}/{slot}` | document | kinds: `saves` (auto, 1–3), `djsets` (main), `layouts`, `shoutouts` |

## City

The city runs on Credit (real money) only, so it is **shut until top-ups are live**: every write below (and
`POST /api/events` with a `lease`) answers 403 `{"error":"city_closed"}`, and `GET /api/city` reports `open:
false`. `CITY_OPEN=1` in the api's environment opens it.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/city/lease` | `{level, slot?, club, weeks}` | rent in credits (`payments.json → rentCredits`, the back office's table over it; slot 0 = first free; up to 5 venues) or extend yours at that slot |
| PUT | `/api/city/venue` | `{lease, club}` | rename one of your venues |
| PUT | `/api/city/shop` | `{lease, open}` | open/close that venue's shop (its menu: `PUT /api/city/shops/{lease}/prices`, below) |

Since the cutover a shop holds no stock: `GET /api/city` lists each shop's menu (`lease.stock`: token, the
warehouse's units, the tenant's price in credits) and the live `wholesale` per token with `maxMarkup`.

## Events

A night a CEO schedules at one of their clubs (a rented venue via `lease`, or a practice club by `club` + `level`),
public or private, Level 3+. Every event has an invite code; a private event is listed only for its host and for
players who opened its invite link (`/?event=<code>`).

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/events` | — | upcoming and live: public ones, mine (with invite codes), the ones I'm going to |
| GET | `/api/events/invite/{code}` | — | opens an invite: returns the event and marks me as going (lists private ones) |
| POST | `/api/events` | `{lease?, club?, level?, startsAt, minutes?, title?, private?}` | schedule (5–60 min, default 10; up to 7 days ahead; no overlap at the same club; ≤ 20 upcoming) |
| POST | `/api/events/{id}/rsvp` | `{going}` | going / not going (a private event needs its invite first) |
| DELETE | `/api/events/{id}` | — | cancel my event, only before it starts (409 `started` after: guests may have bought; only an admin voids sales) |
| PUT | `/api/events/{id}/room` | `{room}` | my event is live in this relay room (from 15 min before until it ends) |

Real stock in the city (`sales.go`, docs/payments.md §4–5): prices in credits per unit (0.001 share), between the
live wholesale price and `maxMarkup` × it; whitelisted tokens only.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/events/prices/{id}` | — | `{prices, wholesale, maxMarkup}` of a city party (public party: anyone; private: its host and the players who opened its invite, else 404) |
| PUT | `/api/events/{id}/prices` | `{prices: {token: credits}}` | host only, before it starts (`prices_locked` after) |
| POST | `/api/events/{id}/buy` | `{token, qty, maxPrice}` | `maxPrice` (required): the price the buyer saw, refused 409 `price_changed` if higher now; a private party sells only to its invited guests (else 404); while live: credits held, units reserved; settles at end + `settleGraceMinutes` → `{sale, credits}` |
| PUT | `/api/city/shops/{lease}/prices` | `{prices}` | the tenant's shop prices in credits |
| POST | `/api/city/shops/{lease}/buy-credit` | `{token, qty, maxPrice}` | settled at once: units to the buyer, margin to the tenant, wholesale to the platform |

## Back office

Role needed: **viewer** reads, **admin** changes players, venues, stock and settings, **owner** manages admins.
Every change requires `reason` (except announcement/admin role changes) and is written to the audit log.

| Method | Path | Body | Role |
| --- | --- | --- | --- |
| GET | `/api/admin/me` | — | viewer |
| GET | `/api/admin/stats` | — | viewer |
| GET | `/api/admin/users?q&sort&limit&offset` | — | viewer |
| GET | `/api/admin/users/{id}` | — | viewer |
| POST | `/api/admin/users/{id}/coins` | `{delta, reason}` | admin |
| PATCH | `/api/admin/users/{id}` | `{name?, unlockLevel?, banned?, banReason?, reason}` | admin |
| POST | `/api/admin/users/{id}/clear-saves` | `{reason}` | admin |
| GET | `/api/admin/city` | — | viewer |
| POST | `/api/admin/leases/{id}/end` | `{reason}` | admin |
| POST | `/api/admin/parties/{id}/cancel` | `{reason}` | admin |
| PUT | `/api/admin/rent` | `{rent: {"1": n, …}, reason}` | admin |
| PUT | `/api/admin/venues` | `{counts: {"1": n, …}, reason}` (not below a level's highest rented slot; ≤ 500) | admin |
| GET | `/api/admin/stock` | — | viewer |
| PUT | `/api/admin/stock/{token}` | `{tx, reason}` (a swap, verified on BSC) or `{delta < 0, reason}` (take units out) | admin |
| POST | `/api/admin/sales/{id}/void` | `{reason}` (a held party sale: credits back, units released) | admin |
| GET | `/api/admin/payments` | — (paused?, reconciliation history, top-ups incl. unknown senders, sales) | viewer |
| POST | `/api/admin/reconcile` | `{reason}` (check now against BSC; a match resumes paused payments) | admin |
| POST | `/api/admin/seed` | `{tx, reason}` (book USDC/USDT the team sent to the Agentic Wallet as the platform's own money; read on BSC, once; 409 `credited_to_a_player` for a player's transfer, credited or rejected; 422 `not_a_seed` if the wallet sent anything out in the tx) | admin |
| GET | `/api/admin/audit?target&before&limit` | — | viewer |
| GET/PUT | `/api/admin/announcement` | `{text, active}` | viewer / admin |
| GET/PUT | `/api/admin/admins` | `{email, role}` (`""` removes) | owner |

## Stock agent

For the platform's restocking agent (e.g. built with BNB Agent Studio). Secret: `AGENT_KEY` on the api.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/agent/demand` | — | per token: on hand, reserved, with CEOs, sold 24h/7d, shops, days left, suggested restock; last 100 movements |
| POST | `/api/agent/restock` | `{token, tx, note?}` | the api reads the swap on BSC (two RPCs, 15 confirmations), books the USDC paid as platform money out and adds the whole units of whitelisted bStock the Agentic Wallet received (fractions carried per token until they make a unit; `short` = units bought that the balance doesn't back: the agent's report adds them and pauses payments, `paused: true`, until the team writes them off; an admin's report writes them off as a `loss` move; other whitelisted bStocks in the same tx: `others`); the tx counts once (and never also as a seed); USDC paid within the agent's limits (`payments.json`); 202 `pending` until final; audited as `agent` |

Example:

```sh
curl -H "Authorization: Bearer $AGENT_KEY" https://api.nyxeron.xyz/api/agent/demand
curl -X POST -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"token":"tsla","tx":"0x…","note":"weekly restock"}' \
  https://api.nyxeron.xyz/api/agent/restock
```

## Configuration (api)

| Variable | Purpose |
| --- | --- |
| `ADDR` | listen address (default `:8788`) |
| `DB_PATH` | SQLite file (backups go next to it) |
| `CORS_ORIGINS` | comma-separated browser origins |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | verify sign-ins, look up email/wallet |
| `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_SECRET_KEY` | spot quotes |
| `ADMIN_EMAILS` | back-office owners |
| `AGENT_KEY` | stock agent secret (empty = agent API off) |
| `BSC_RPC_1`, `BSC_RPC_2` | BNB Smart Chain JSON-RPC, two independent providers that must agree (`bsc.go`); both needed |
| `RELAY_URL` | the relay's internal base URL, for live-room stats |
| `RELAY_TICKET_SECRET` | signs relay tickets (`POST /api/relay/ticket`); the relay has the same value (empty = no tickets) |
| `CITY_OPEN` | `1` opens the city (see [City](#city)); unset keeps it shut |
