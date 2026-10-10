# Stock agent (apps/agent)

The platform's restocking agent. It reads what the warehouse is short of (`GET /api/agent/demand`), takes a token
from the `payments.json` whitelist (today TSLA → TSLAB), checks its locked bStock contract against Binance's list
and asks the platform's Binance Agentic Wallet what the budget buys.

**It only trades with `--buy`:** then it swaps `AGENT_BUY_USD` of USDC (platform funds, slippage 1%), follows the
order until the wallet reports its tx, and reports the tx to `POST /api/agent/restock`. The api reads the swap on
BSC itself and adds the units the Agentic Wallet really received; the agent's own numbers count for nothing.

Before it swaps, a `--buy` run refuses when:

- the quote costs more than `agent.maxPriceOverSpotPercent` (5 %) per share above the api's spot price for the
  ticker (`GET /api/quotes`), or more than `agent.maxPriceUnderSpotPercent` (20 %) below it (a broken quote or
  reference), or quotes an amount that isn't a finite positive number;
- the api has no spot price for the ticker dated within the last `agent.spotMaxAgeMinutes` (10) and at most a
  minute ahead of this machine's clock;
- the api says payments are paused, or doesn't say (`paused` missing), or today's spend
  (`agentSpentTodayCents`) is missing, not a number or negative, or the swap would go over `agent.maxUsdPerDay`.
  The spend is read again after the swap's record is taken, just before the swap;
- a swap from an earlier run is still outstanding (below), or another `--buy`/`--report` run holds the run lock.

**One swap at a time, remembered.** The swap is recorded in `AGENT_STATE` before it is submitted, then with its
order id and tx, and the record is removed only once the api has counted the tx (or the wallet says the swap
FAILED: nothing spent; a FINISHED order without a tx hash yet is still followed, never treated as failed). The next run finishes an outstanding swap first (follows the order, reports the tx) and
only then may buy; while it can't, it buys nothing. A record without an order id means the submit's outcome is
unknown, even when the wallet answered with an error (a timeout can be reported after the submit): check
`baw market-order list`, report its tx if it swapped, then delete the file. A record with a tx and an `error` is a
tx the api refused (4xx): check it in the back office, then delete the file.

**One run at a time.** A `--buy` or `--report` run holds `<AGENT_STATE>.lock` from start to end (released on exit,
an error, Ctrl-C or SIGTERM); a second run refuses to start, and a run only ever rewrites or removes the record it
holds. A run killed outright (SIGKILL, power loss) leaves the lock behind: the next run reports its pid and age and
stops, never takes it over. Check that no agent is running (`ps`), then delete the `.lock` file.

**Production: set `AGENT_STATE` outside the repo** (e.g. `/var/lib/nyxeron-agent/state.json`, a directory the
agent's user can write). The default sits in the checkout, gitignored: a fresh clone, a `git archive` deploy or
`git clean -fdX` deletes it silently, and a missing record means "no swap outstanding", so a swap the api hasn't
counted yet would be bought again. The agent prints a warning when it runs with the default.

**Reporting retries.** A not-yet-final tx (202) is reported again every 10 s, a 5xx or network error with backoff
(5 s doubling to 60 s), for up to 10 minutes; a 4xx stops at once. `409 tx_used` means it already counted. A
200 counts only when its body names this tx and a numeric `units` (a proxy's page is retried, the record stays).
To finish a done swap without trading: `pnpm agent --token tsla --report 0x…`.

```sh
npm install --global @binance/agentic-wallet    # the `baw` CLI
baw auth signin --json                           # confirm in the Binance App, then `baw auth verify`

# Locally: the api needs the same AGENT_KEY (any value), else /api/agent/* answers 503 not_configured.
AGENT_KEY=dev DB_PATH=services/api/dev.db pnpm dev:api   # terminal 1
AGENT_KEY=dev pnpm agent --token tsla                    # terminal 2, repo root: a $3 quote for TSLAB
AGENT_KEY=dev pnpm agent                                 # the whitelisted token most needed
AGENT_KEY=… NYXERON_API=… pnpm agent --token tsla --buy  # a real swap on mainnet + verified restock
AGENT_KEY=… NYXERON_API=… pnpm agent --token tsla --report 0x…  # report a done swap's tx again, no trade
```

With an empty warehouse (no sales yet) the plain run prints `nothing to restock`; `--token tsla` quotes anyway.

| Variable        | Purpose                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `AGENT_KEY`     | the api's stock agent secret (required)                                              |
| `NYXERON_API`   | api base URL (default `http://localhost:8788`); https, plain http only for localhost |
| `AGENT_BUY_USD` | budget per restock, in USDC on BSC (default `3`)                                     |
| `AGENT_STATE`   | the outstanding-swap record; production: outside the repo (default in the checkout)  |

Fees, minimums, the agent's limits and the token addresses live in one file:
`packages/core/src/data/payments.json` (`agent.maxUsdPerSwap` caps `AGENT_BUY_USD`; `agent.maxPriceOverSpotPercent`,
`agent.maxPriceUnderSpotPercent` and `agent.spotMaxAgeMinutes` bound the quote). Copy `.env.example` to `.env`
(gitignored) and load it with `set -a; . apps/agent/.env; set +a` before `pnpm agent`.

| File        | What                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `demand.ts` | the api: demand, spot quotes, restock reports                                                       |
| `plan.ts`   | the whitelist, which token to restock, the contract, spend, price and api URL checks (pure, tested) |
| `state.ts`  | the outstanding-swap record, written atomically, and the run lock                                   |
| `rwa.ts`    | bStock tokens on BSC by underlying ticker (Binance's RWA token list)                                |
| `baw.ts`    | the Agentic Wallet CLI: quotes, swaps, orders                                                       |
| `main.ts`   | one run, printed as JSON                                                                            |

Tokens outside the whitelist (other stocks, baskets) are refused. If Binance's list no longer shows the locked
contract for a ticker, the run stops instead of using another address.
