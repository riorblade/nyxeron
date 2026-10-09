# NYXERON · Nightclub Empire

**Build your nightclub empire on BNB Chain.** A multiplayer nightclub management game where the drinks are
tokenized stocks.

Players run clubs, host parties and trade tokenized equities (TSLA, NVDA, US500 baskets…) priced live from
BNB Chain's RWA market. CEOs rent venues in a shared city, stock their shops from the platform's warehouse and
throw parties; guests walk in, buy tokens at the club's price and keep what they buy; DJs play live sets for the
whole room. Coin is how value changes hands, tokens are the utility.

Live: **[nyxeron.xyz](https://nyxeron.xyz)** · X: **[@nyxeron_xyz](https://x.com/nyxeron_xyz)** · Back office:
**admin.nyxeron.xyz** · API: `api.nyxeron.xyz`

---

## Highlights

- **Deterministic simulation core.** The whole club (guests, crowd energy, market, fights, inspections, tax) is a
  pure, seeded TypeScript engine. A night simulates headless in milliseconds, so every rule is unit-tested and a
  balance bot plays thousands of careers.
- **Real market prices.** Spot quotes come from Binance Web3's RWA feed (signed server-side). Club and shop
  prices follow the underlying (baskets weigh their legs).
- **Live multiplayer.** The CEO's browser is authoritative; a tiny Go relay routes binary frames between the
  host, guests and a live DJ (mix state, not audio, is synced: ~300 B, 4×/s).
- **Server-settled economy.** Wallets, rent, shop sales, party payouts and the platform warehouse are settled by
  the API; the browser only asks. Nothing that pays out real value trusts the client.
- **Back office.** Roles (owner/admin/viewer), player search, coin grants, venue access, bans, venue and party
  oversight, rent table, platform stock, and an audit log of every change.
- **Agent-ready supply chain.** The platform's stock agent reads demand and restocks the warehouse through an
  authenticated API, recording each on-chain purchase.

## Monorepo

```
nyxeron/
├─ apps/
│  ├─ web/        Game client: React 19, Vite, Tailwind v4, three.js venue, Web Audio DJ studio
│  └─ admin/      Back office: React, Privy sign-in, role-gated
├─ packages/
│  └─ core/       Simulation engine + game data (pure TS, seeded RNG, no DOM)
├─ services/
│  ├─ api/        Go: accounts, wallets, city (rent/shops/parties), warehouse, back office, quotes
│  └─ relay/      Go: multiplayer rooms and frame routing only (no game logic, no DB)
├─ deploy/        Docker Compose + Caddy for the VPS
├─ docs/          PRD, architecture, game design, API reference, roadmap, changelog
└─ scripts/       Repo tooling (e.g. sync game data into the api)
```

Each app, package and service has its own README.

## Quick start

Requirements: Node 22 (`.nvmrc`), **pnpm 10 only** (`corepack enable`; npm/yarn/bun are refused), Go 1.26.

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local       # add VITE_PRIVY_APP_ID (optional: without it, signed-out dev)
pnpm dev                                            # game → http://localhost:5173
```

Full stack (accounts, multiplayer, back office):

```sh
cp deploy/.env.example deploy/.env                  # Privy app id + secret, ADMIN_EMAILS, Binance keys (optional)
set -a; . deploy/.env; set +a
DB_PATH=services/api/dev.db pnpm dev:api            # api   → :8788
pnpm dev:relay                                      # relay → :8787
pnpm dev:admin                                      # back office → http://localhost:5174
```

Vite proxies `/api` and `/ws` to the local services, so no CORS setup is needed in development.

## Scripts

| Command                      | What                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `pnpm dev` / `dev:admin`     | Game / back office dev servers                                   |
| `pnpm dev:api` / `dev:relay` | Go services (`go run`)                                           |
| `pnpm test`                  | Vitest: core rules, persistence, balance guard rail, web units   |
| `pnpm test:go`               | Go tests with the race detector (relay + api)                    |
| `pnpm lint`                  | Typecheck (core, web, admin) + ESLint + Prettier check           |
| `pnpm build`                 | Production builds                                                |
| `pnpm balance [runs]`        | Bot careers: outcomes and the day each venue level is reached    |
| `pnpm balance:levels [runs]` | Per level: fights a night, tax share, profit                     |
| `pnpm sync:gamedata`         | Copy core data the api settles with into `services/api/gamedata` |

## Documentation

| Doc                                          | For                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                   | Product: vision, users, features, economy, success                         |
| [docs/architecture.md](docs/architecture.md) | System design, data flow, trust model                                      |
| [docs/game-design.md](docs/game-design.md)   | Rules (R1–R19), levels, night simulation, balance                          |
| [docs/api.md](docs/api.md)                   | HTTP API: player, city, back office, agent                                 |
| [docs/multiplayer.md](docs/multiplayer.md)   | Relay protocol and live session sync                                       |
| [docs/roadmap.md](docs/roadmap.md)           | What's next                                                                |
| [docs/changelog.md](docs/changelog.md)       | What shipped, when, and the numbers behind it                              |
| [docs/site/](docs/site)                      | Public docs (Mintlify): the game, the engine as formulas, on-chain economy |
| [deploy/README.md](deploy/README.md)         | Running it on a VPS and Vercel                                             |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Workflow, conventions, definition of done                                  |

## Tech

TypeScript · React 19 · Vite · Tailwind v4 · Zustand · three.js · Web Audio · Vitest · Go 1.26 · SQLite
(modernc, pure Go) · coder/websocket · Privy (email/Google, embedded BNB Chain wallet) · Binance Web3 RWA data ·
Docker · Caddy · Vercel.
