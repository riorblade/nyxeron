# api (Go)

Accounts, wallets, per-player documents, the city, the platform warehouse, the back office and spot quotes.
Single binary on a `scratch` image (~5 MB), SQLite on a volume. Endpoints: [docs/api.md](../../docs/api.md).

```sh
set -a; . ../../deploy/.env; set +a
DB_PATH=dev.db go run .      # :8788
go test -race ./...
```

| File         | What                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `main.go`    | config, routes, CORS, daily backup, graceful shutdown                           |
| `auth.go`    | Privy token verification (ES256/JWKS, stdlib) and user lookup                   |
| `store.go`   | schema, profile, wallet rules (starter, refill, nights, gigs), ledger           |
| `migrate.go` | numbered schema migrations (append only)                                        |
| `profile.go` | player endpoints                                                                |
| `docs.go`    | per-player documents (saves, DJ sets, layouts, shoutouts)                       |
| `city.go`    | leases, shops, parties, city prices; embeds `gamedata/`                         |
| `supply.go`  | platform warehouse and the stock agent API                                      |
| `admin.go`   | back-office roles, stats, players, city controls, audit, announcement           |
| `quotes.go`  | Binance Web3 RWA spot quotes (signed, cached)                                   |
| `gamedata/`  | copy of core data the api settles with (`pnpm sync:gamedata`; a test checks it) |

Configuration: see the table at the end of [docs/api.md](../../docs/api.md).
