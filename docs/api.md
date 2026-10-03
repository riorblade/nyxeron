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
| GET | `/api/profile` | — | profile (created with the starter wallet on first call) |
| POST | `/api/profile/import` | profile | once: this device's pre-account data, bounded |
| PATCH | `/api/profile` | `{name?, avatar?}` | |
| POST | `/api/wallet/refill` | — | only when the wallet is nearly empty |
| POST | `/api/nights` | `{cash, bought, pnl, room?}` | a night out as a guest; at a live city party the tenant is paid the spend |
| POST | `/api/gigs` | `{fee}` | a DJ gig played to the end (capped, rate-limited) |
| GET | `/api/docs/{kind}` | — | `[{slot, updatedAt, meta}]` |
| GET/PUT/DELETE | `/api/docs/{kind}/{slot}` | document | kinds: `saves` (auto, 1–3), `djsets` (main), `layouts`, `shoutouts` |

## City

The city runs on Credit (real money) only, so it is **shut until top-ups are live**: every write below (and
`POST /api/events` with a `lease`) answers 403 `{"error":"city_closed"}`, and `GET /api/city` reports `open:
false`. `CITY_OPEN=1` in the api's environment opens it.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/city/lease` | `{level, slot?, club, weeks}` | rent (slot 0 = first free; up to 5 venues) or extend yours at that slot |
| PUT | `/api/city/venue` | `{lease, club}` | rename one of your venues |
| POST | `/api/city/stock` | `{token, qty}` | buy shop stock from the warehouse at the market price |
| PUT | `/api/city/shop` | `{lease, open?, prices?}` | open/close that venue's shop, set your shelf prices (≤ 3× usual) |
| POST | `/api/city/shops/{lease}/buy` | `{token, qty}` | buy from someone's open shop (≤ 50) |

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
| DELETE | `/api/events/{id}` | — | cancel my event |
| PUT | `/api/events/{id}/room` | `{room}` | my event is live in this relay room (from 15 min before until it ends) |

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
| PUT | `/api/admin/stock/{token}` | `{delta, reason, tx?}` | admin |
| GET | `/api/admin/audit?target&before&limit` | — | viewer |
| GET/PUT | `/api/admin/announcement` | `{text, active}` | viewer / admin |
| GET/PUT | `/api/admin/admins` | `{email, role}` (`""` removes) | owner |

## Stock agent

For the platform's restocking agent (e.g. built with BNB Agent Studio). Secret: `AGENT_KEY` on the api.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/agent/demand` | — | per token: on hand, with CEOs, sold 24h/7d, shops, days left, suggested restock; last 100 movements |
| POST | `/api/agent/restock` | `{token, qty, tx, note?}` | adds stock; `qty > 0` and the on-chain `tx` are required; audited as `agent` |

Example:

```sh
curl -H "Authorization: Bearer $AGENT_KEY" https://api.nyxeron.xyz/api/agent/demand
curl -X POST -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"token":"tsla","qty":500,"tx":"0x…","note":"weekly restock"}' \
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
| `RELAY_URL` | the relay's internal base URL, for live-room stats |
