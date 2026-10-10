# Deploy

Production today: **frontends on Vercel**, **backend on one VPS** (Docker Compose behind a shared Caddy).

| Piece                      | Where                                                    | Image / size         | RAM cap |
| -------------------------- | -------------------------------------------------------- | -------------------- | ------- |
| game (`apps/web`)          | Vercel project `nyxeron` → `nyxeron.xyz`                 | static               | —       |
| back office (`apps/admin`) | Vercel project (root `apps/admin`) → `admin.nyxeron.xyz` | static               | —       |
| `relay`                    | VPS → `api.nyxeron.xyz/ws`                               | Go, `scratch`, ~4 MB | 48 MB   |
| `api`                      | VPS → `api.nyxeron.xyz/api/*`, SQLite volume `api_data`  | Go, `scratch`, ~5 MB | 48 MB   |

Secrets live in `deploy/.env` on the VPS (from `.env.example`: Privy, Binance, `ADMIN_EMAILS`, `AGENT_KEY`,
`BSC_RPC_1`, `BSC_RPC_2`, `DOMAIN`, `FRONTEND_EXTRA_HOST`, `ADMIN_HOST`, `CITY_OPEN`). Database migrations run automatically when the api starts.

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

Frontend deploys, from the repo root:

```sh
vercel deploy --prod                                   # game (project `nyxeron`, linked in .vercel/)
VERCEL_ORG_ID=team_cko9ZAcGcicfQ0g8cxsLyuLW VERCEL_PROJECT_ID=prj_DJcEwp93WG1PdYK1NYbDESGxlrW9 \
  vercel deploy --prod                                 # back office (project `nyxeron-admin`, root apps/admin)
```

Backend deploys ship a clean tree (files removed from the repo don't linger) and keep `deploy/.env`:

```sh
git archive HEAD | ssh root@<vps> 'rm -rf /opt/nyxeron.new && mkdir /opt/nyxeron.new && tar -x -C /opt/nyxeron.new'
ssh root@<vps> 'cp -p /opt/nyxeron/deploy/.env /opt/nyxeron.new/deploy/ && rm -rf /opt/nyxeron.prev &&
  mv /opt/nyxeron /opt/nyxeron.prev && mv /opt/nyxeron.new /opt/nyxeron && cd /opt/nyxeron &&
  docker compose -f deploy/compose.yml -f deploy/compose.backend.yml up -d --build relay api'
```

## Stock agent (`apps/agent`)

The agent is not a compose service: it runs from a checkout on the machine where the Binance Agentic Wallet is
signed in (`apps/agent/README.md`). Its outstanding-swap record must live **outside the repo**, or a fresh clone,
a `git archive` deploy or `git clean -fdX` deletes it silently and the next `--buy` buys a swap the api hasn't
counted yet a second time:

```sh
sudo install -d -o <agent-user> -m 700 /var/lib/nyxeron-agent
AGENT_STATE=/var/lib/nyxeron-agent/state.json AGENT_KEY=… NYXERON_API=https://api.nyxeron.xyz \
  pnpm agent --token tsla --buy
```

`--buy` and `--report` refuse to start without `AGENT_STATE`: set the same path for cron and for every manual run
(`apps/agent/.env.example` has it). Every `--buy`/`--report` run also holds `/var/lib/nyxeron-agent/state.json.lock`;
a run killed with SIGKILL leaves it behind and later runs stop until a person removes it.

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

### Stock agent (Agentic Wallet)

The agent and `baw` run in a one-off container (`agent` profile; never started by `up`). The wallet owner signs the
server in once by scanning a QR in the Binance App; the session and the agent's swap record stay on the `agent_home`
volume. `AGENT_KEY` comes from `deploy/.env`; the api is `https://api.$DOMAIN`.

```sh
C="docker compose -f deploy/compose.yml -f deploy/compose.backend.yml --profile agent"
$C build agent
$C run --rm --entrypoint baw agent auth signin          # QR/link → the owner scans it in the Binance App
$C run --rm --entrypoint baw agent auth verify --qrCodeId <id>
$C run --rm --entrypoint baw agent wallet address       # must be payments.json → agenticWallet
$C run --rm agent --token tsla                          # quote only, no money moves
$C run --rm agent --token tsla --buy                    # a real swap: only after the wallet owner's go
```
