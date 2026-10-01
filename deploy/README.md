# Deploy (one VPS, Docker)

Three containers, only `edge` is public:

| service | what                                                                        | image                 | RAM (idle → 310 players) | cap   |
| ------- | --------------------------------------------------------------------------- | --------------------- | ------------------------ | ----- |
| `edge`  | Caddy: HTTPS (automatic), the game's static files, proxies `/ws` and `/api` | caddy:2-alpine + dist | ~19 → ~40 MB             | 64 MB |
| `relay` | multiplayer: rooms + message routing only (no game logic, no DB)            | Go, `scratch`, ~9 MB  | ~5 → ~24 MB              | 48 MB |
| `api`   | game backend: spot quotes (Binance RWA), later accounts                     | Go, `scratch`, ~9 MB  | ~7 MB                    | 32 MB |

## First time (Hostinger VPS, Ubuntu + Docker)

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
