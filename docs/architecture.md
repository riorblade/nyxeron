# Architecture

## Overview

```
                ┌────────────────────────── Vercel ──────────────────────────┐
 Player ──────▶ │ apps/web  (nyxeron.xyz)            apps/admin  (admin.…)   │ ◀── Admin
                └───────┬───────────────────────────────────┬────────────────┘
                        │ HTTPS /api/*  ·  WSS /ws           │ HTTPS /api/admin/*
                        ▼                                    ▼
                ┌──────────────── VPS · Caddy (api.nyxeron.xyz) ─────────────┐
                │  /ws ──▶ relay (Go)          /api/* ──▶ api (Go) ── SQLite  │
                └──────────────────────────────────────┬────────────────────┘
                                                        │
                       Privy (identity, JWKS) ◀─────────┤
                       Binance Web3 RWA quotes ◀────────┤
                       Stock agent (Bearer AGENT_KEY) ──▶ /api/agent/*
```

| Part | Runs | Owns |
| --- | --- | --- |
| `packages/core` | in the browser (and Node for tests/bots) | The simulation: rules, data, deterministic state transitions |
| `apps/web` | browser (Vercel) | Screens, HUD, three.js venue, Web Audio, the live session host/guest |
| `apps/admin` | browser (Vercel) | Back office UI (no logic; every check is server-side) |
| `services/relay` | VPS container | Rooms and frame routing. No game logic, no database |
| `services/api` | VPS container | Accounts, wallets, documents, city, warehouse, back office, quotes |

## The simulation core

- **Pure functions over a single `GameState`.** `startNight`, `tickNight` (one in-game minute), `endNight`,
  `nextDay`, plus one function per player action (`r01_orderStock`, `bookDj`, `postPromo`, …) returning
  `ActionResult` (`{ ok, state }` or a typed failure).
- **Seeded RNG** (`rng.ts`) stored in the state, so a save reloads into the identical game and a night replays
  bit-for-bit.
- **Data-driven.** Every number lives in `src/data/*.json`; `data.ts` types them.
- **Event log.** Every notable change is a typed `GameEvent` in `state.log`; the HUD feed, the night report and
  the stat explanations (`statHistory`) read it.
- **Bots.** `rules/autoCeo.ts` is the AI CEO (hosts AI events, powers the balance scripts).

## The client (apps/web)

```
src/
├─ screens/   one component per screen (Landing, Dashboard, Office, Night, NightReport, City…)
├─ hud/       night/day HUD pieces (TopBar + StatInfo, feed, objectives, token detail, pyro, sampler, room)
├─ venue/     three.js scene, layouts, furniture, screens/videotron, pyro footage
├─ dj/        DJ engine (decks, mixer, sampler), analysis, sets, auto DJ, mix sync
├─ net/       relay client, snapshot codec, live session (host / guest / DJ)
├─ api/       HTTP clients: player (profile + wallet), docs (save sync), city, quotes
├─ auth/      Privy shell and the signed-in account
├─ state/     zustand stores: game, profile, settings; saves; per-account storage scope
├─ audio/     club audio: music, mixing between areas, SFX, beat detection
├─ i18n/      every player-facing string (English)
└─ lib/       small helpers (art paths, class names)
```

- **Game state** lives in `state/store.ts` (zustand). Screens call actions that run core functions; the UI never
  edits `GameState` by hand.
- **Per-account storage.** Everything an account owns is cached in localStorage under `nyxeron:u:<privy id>:…`
  (`state/scope.ts`) and synced to the api (`api/docs.ts`): saves newest-wins, the rest server-wins.
- **Lazy loading.** The landing page is light; Privy, the night screen (three.js) and the studio are lazy chunks.

## Live multiplayer

The CEO's browser is the **authority**: it runs `tickNight` and applies players' intents (`visitorJoin`,
`visitorBuy`, `visitorLeave`). The relay only moves bytes. Guests render the host's snapshots; a live DJ sends mix
state, and every player's own audio engine follows it. Details: [multiplayer.md](multiplayer.md).

## The api and its trust model

- **Identity.** Every player request carries a Privy access token. The api verifies it itself (ES256 against the
  app's JWKS: issuer, audience, expiry) and uses the token's subject as the player id; ids in request bodies are
  never trusted. Email and embedded wallet come from Privy's REST API (app secret, cached 5 min).
- **Server-settled value.** Wallet, portfolio, rent, shop stock and sales, party payouts and the warehouse are
  changed only inside SQL transactions that check the rules (affordable, in stock, within limits, owner only).
  Guests' nights are bounded: the wallet can't grow and tokens can't cost more than was spent.
- **Coin ledger.** Every wallet change writes a ledger row with the balance after it (import, refill, night, gig,
  rent, stock, shop, sale, party, admin).
- **Back office.** Roles come from the verified email: owners from `ADMIN_EMAILS`, others from the `admins`
  table. Every mutation writes an `audit` row (actor, target, before/after, reason) in the same transaction.
- **Agent.** `/api/agent/*` uses a separate bearer secret (`AGENT_KEY`, constant-time compare); it can read
  demand and add stock, only with an on-chain transaction reference.
- **Game numbers.** The api embeds `services/api/gamedata/*.json`, an exact copy of the core data it settles with
  (a test fails if they drift; `pnpm sync:gamedata`).

### Storage

SQLite (pure-Go driver, WAL, one connection) on a Docker volume. Schema changes are numbered migrations
(`migrate.go`, `PRAGMA user_version`), each in a transaction, so a live database upgrades in place. A daily
`VACUUM INTO` backup keeps the last 7.

| Table | Holds |
| --- | --- |
| `users` | profile, wallet, record, identity (email, wallet address), access level, ban, last seen |
| `portfolio` | tokens each player holds (qty, cost) |
| `docs` | per-player documents (saves, DJ sets, layouts, shoutouts), gzipped |
| `ledger` | every wallet change with the balance after it |
| `leases`, `parties`, `shop_prices`, `party_prices` | the city (shop and party menus in Credit) |
| `topups`, `sales`, `platform_ledger` | real money: top-ups, sales of real stock, the platform's own credits |
| `platform_stock`, `stock_moves` | the warehouse and every movement in or out |
| `admins`, `audit`, `settings` | back office (roles, audit log, announcement, rent table, price references) |

## Prices

The api signs requests to Binance Web3's RWA endpoint and caches the answer (`/api/quotes`). The game turns a
spot price into Coin with a **spot factor**: spot now ÷ the first spot seen per club in a career, weighted over a
basket's legs and clamped (`strategy.json → platform.spotFactorRange`). The city prices real stock in Credit from
the live spot itself (wholesale per 0.001 share; quotes older than 10 minutes aren't sold against).

## Deployment

Frontends on Vercel; `relay` and `api` as two small `scratch` containers behind the VPS's Caddy. See
[deploy/README.md](../deploy/README.md).
