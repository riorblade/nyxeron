# Deploy

Production today: **frontends on Vercel**, **backend on one VPS** (Docker Compose behind a shared Caddy).

| Piece                      | Where                                                    | Image / size         | RAM cap |
| -------------------------- | -------------------------------------------------------- | -------------------- | ------- |
| game (`apps/web`)          | Vercel project `nyxeron` → `nyxeron.xyz`                 | static               | —       |
| back office (`apps/admin`) | Vercel project (root `apps/admin`) → `admin.nyxeron.xyz` | static               | —       |
| `relay`                    | VPS → `api.nyxeron.xyz/ws`                               | Go, `scratch`, ~4 MB | 48 MB   |
| `api`                      | VPS → `api.nyxeron.xyz/api/*`, SQLite volume `api_data`  | Go, `scratch`, ~5 MB | 48 MB   |

Secrets live in `deploy/.env` on the VPS (from `.env.example`: Privy, Binance, `ADMIN_EMAILS`, `AGENT_KEY`,
`DOMAIN`, `FRONTEND_EXTRA_HOST`, `ADMIN_HOST`). Database migrations run automatically when the api starts.

`compose.yml` alone can also self-host everything on one machine with its own Caddy `edge` (below).

## Self-hosted: everything on one VPS (Ubuntu + Docker)

1. Point your domain's A (and AAAA) record at the VPS IP. Open ports 80 and 443 (TCP) and 443 (UDP, HTTP/3).
2. On the VPS:
   ```sh
   git clone <repo> nyxeron && cd nyxeron
   cp deploy/.env.example deploy/.env   # set DOMAIN, and the Binance keys if you have them
   docker compose -f deploy/compose.yml up -d --build
   ```
   Caddy gets the certificate by itself on the first request.

## Production today: frontend on Vercel, backend on the VPS

- `nyxeron.xyz` → Vercel (`vercel.json`; `apps/web/.env.production` points the game at the backend host).
- `api.nyxeron.xyz` → the VPS: the shared Caddy (it already owns 80/443 for other projects) routes `/ws` to the
  relay and `/api/*` to the api. Only those two containers run here:

```sh
docker compose -f deploy/compose.yml -f deploy/compose.backend.yml up -d --build relay api
```

Caddy block (on the proxy's Docker network, `GATEWAY_NETWORK`, default `deploy_default`):

```
api.nyxeron.xyz {
	handle /ws {
		reverse_proxy nyxeron-relay:8787
	}
	handle /api/* {
		reverse_proxy nyxeron-api:8788
	}
	handle {
		respond 404
	}
}
```

Frontend deploy: `vercel deploy --prod` from the repo root (project `nyxeron`).

## Update

```sh
git pull && docker compose -f deploy/compose.yml up -d --build   # self-hosted, edge included
```

## Check

```sh
docker compose -f deploy/compose.yml ps        # all healthy
docker stats --no-stream                        # memory per service
docker compose -f deploy/compose.yml logs -f relay
```

## Local

`pnpm dev` (game) plus `pnpm dev:relay` and `pnpm dev:api` (Go; Vite proxies `/ws` and `/api` to them).
Load test the relay: `cd services/relay && go run ./cmd/loadtest -url ws://127.0.0.1:8787/ws -rooms 10 -peers 30`.
