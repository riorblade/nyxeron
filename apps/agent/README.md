# Stock agent (apps/agent)

The platform's restocking agent. It reads what the warehouse is short of (`GET /api/agent/demand`), takes a token
from the `payments.json` whitelist (today TSLA → TSLAB), checks its locked bStock contract against Binance's list
and asks the platform's Binance Agentic Wallet what the budget buys.

**It stops at the quote: nothing is traded and nothing is reported to the api yet.**

```sh
npm install --global @binance/agentic-wallet    # the `baw` CLI
baw auth signin --json                           # confirm in the Binance App, then `baw auth verify`

# Locally: the api needs the same AGENT_KEY (any value), else /api/agent/* answers 503 not_configured.
AGENT_KEY=dev DB_PATH=services/api/dev.db pnpm dev:api   # terminal 1
AGENT_KEY=dev pnpm agent --token tsla                    # terminal 2, repo root: a $3 quote for TSLAB
AGENT_KEY=dev pnpm agent                                 # the whitelisted token most needed
```

With an empty warehouse (no sales yet) the plain run prints `nothing to restock`; `--token tsla` quotes anyway.

| Variable        | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `AGENT_KEY`     | the api's stock agent secret (required)          |
| `NYXERON_API`   | api base URL (default `http://localhost:8788`)   |
| `AGENT_BUY_USD` | budget per restock, in USDC on BSC (default `3`) |

Fees, minimums, the agent's limits and the token addresses live in one file:
`packages/core/src/data/payments.json` (`agent.maxUsdPerSwap` caps `AGENT_BUY_USD`). Copy `.env.example` to `.env`
(gitignored) and load it with `set -a; . apps/agent/.env; set +a` before `pnpm agent`.

| File        | What                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `demand.ts` | the api's demand view                                                    |
| `plan.ts`   | the whitelist, which token to restock, the contract check (pure, tested) |
| `rwa.ts`    | bStock tokens on BSC by underlying ticker (Binance's RWA token list)     |
| `baw.ts`    | the Agentic Wallet CLI: quotes                                           |
| `main.ts`   | one run, printed as JSON                                                 |

Tokens outside the whitelist (other stocks, baskets) are refused. If Binance's list no longer shows the locked
contract for a ticker, the run stops instead of using another address.
