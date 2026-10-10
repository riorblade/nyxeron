# Payments: top-up, credits and real stock

Status: **approved spec** (2026-10-03, owner decisions below), replacing the first proposal "Nyxeron — Top-up,
Credit & Stok" (its measurements on gas, fees, decimals and bStock quotes still stand). Hackathon deadline:
**Sun 11 Oct, 19:00 WIB**.

## Owner decisions

1. **A credit only exists if real money backs it.** Credits are minted only by a top-up verified on BSC. Nothing
   else creates credits: not the starter wallet, refill, imports, DJ gig fees or back-office grants.
2. **Only bStock tokens.** A token enters the paid economy only when (a) its bStock contract on BSC is locked in
   config and (b) a $3 USDC quote succeeded and is recorded. Today that's **TSLA**. Others are added one by one.
   Baskets (us500, bigtech, aisemis, dividend) and SKHY / SPCX stay out of the paid economy.
3. **Stock comes from the platform warehouse; the CEO is a reseller (dropshipper).** The CEO holds no stock and
   needs no capital: they throw a party and sell to guests at their own price, in credits. Every purchase holds the
   guest's credits and reserves units in the warehouse; **when the party ends, everything settles at once**: units
   to the guest, the wholesale price to the platform, the margin to the CEO.

## Two currencies

| | **Credit** (paid) | **Coin** (play) |
| --- | --- | --- |
| Comes from | verified top-ups only; sales to other players | starter wallet, refill, gigs, admin grants |
| Spent on | city: rent, party purchases, shop purchases | practice careers, AI events, everything else |
| Backed by | USDC/USDT in the Agentic Wallet | nothing (game money) |
| Can buy real stock | yes | **never** |

Stored apart: a new `credits` column (and ledger kinds) next to the existing `wallet` (Coin). Real units live apart
from the play portfolio too (a `backed_units` table): tokens bought at AI events or practice clubs are play units and
never count as real stock.

## Numbers (`packages/core/src/data/payments.json`, synced to the api)

| | Value | Note |
| --- | --- | --- |
| Credit | 1 USD = 100 credits | integers only |
| Unit | 1 unit = 0.001 share | integers only |
| Wholesale price of a unit | live bStock price × 0.001 × 100, rounded up (never below cost) | quoted server-side |
| CEO's price | up to 3× wholesale (`city.json → shop.maxMarkup`) | set per party, before it starts; checked again at each sale |
| Top-up fee | 1% (min top-up $3) | covers gas sponsorship; the rest is revenue |
| Per-player top-up cap | $20 a day, $100 in total during the hackathon | there's no withdrawal yet; the day counts by when a top-up is credited |
| Agent limits | $50 per swap, $500 a day | in code; Binance App limit is a backstop |
| Top-up tokens | USDC, USDT on BSC (18 decimals) | contract addresses locked in config |
| Tokens | TSLA (bStock) | whitelist with contract addresses |
| Agentic Wallet | `0xcDFa725242E29921468a7482E8F3990fc40E170f` | Wisnu's Binance account (key-person risk, noted) |

## Flows

### 1. Sign-in (exists)

Privy (Google/email) creates the embedded EVM wallet; the api stores email and wallet address (`users.email`,
`users.wallet_address`, migration 1). Top-ups are matched against this stored address, never one the browser sends.

### 2. Top-up (as proposed)

Fund the embedded wallet (Privy `useFundWallet`, card via MoonPay) → send USDC/USDT to the Agentic Wallet with gas
sponsorship → the browser posts **only the tx hash** to `POST /api/topups` → the api verifies on BSC (checks below)
→ in one database transaction: record the top-up (tx hash + log index unique), add `credits` (amount − 1% fee) ×
100, write the ledger. A scanner picks up top-ups whose browser closed. Unknown senders get no credits (flagged in
the back office). No single transaction or block can stop the scanner:

- Zero-value transfers are skipped.
- A player's transfer whose receipt both RPCs refuse (over 4 MB, malformed, or a JSON-RPC error from each) is
  recorded `unknown` with the reason, owed back in full, without credits.
- One block whose Transfer logs for a token both RPCs refuse (anyone can fill a block with ~10k zero-value transfers
  to the Agentic Wallet for a few dollars) is passed: at most 5 such blocks per pass, so a shared outage isn't swept
  away in one go.

Both are recorded in `scan_retries` and read again on later passes: right away, then after 1, 2, 4 … 128 minutes,
10 reads in all (about 4 h). What reads is credited like any scanned transfer; what never reads is `given_up`. The back
office's Payments page lists the open and given-up ones ("Unread on chain") and each top-up's reason; a player's own
report (`POST /api/topups`) still credits such a deposit meanwhile. One RPC failing alone still stops the scan, so an
outage never skips a transfer. A transfer recorded `unknown` and claimed later counts against the daily cap when it is
credited (`credited_at`; `created_at` stays when it was first seen). A tx booked as the team's seed is never credited
to a player (recorded `rejected`, reason `seed`), and a tx a player's wallet sent is never booked as the seed: neither
the wallet stored now nor any of the tx's own top-up rows with a player (credited or rejected, so owed back).

### 3. Warehouse restock (platform; replaces "CEO orders")

The agent keeps the warehouse stocked from demand (`GET /api/agent/demand`: on hand, reserved, sold 24 h/7 d,
suggested) and buys bStock in bulk with **platform funds** (fees, or a seed the team puts in), not with players'
credits. `POST /api/agent/restock {token, tx}` adds units **only after the api verifies the swap on BSC**
(bStock received by the Agentic Wallet, amount from the logs, tx unused, 15 confirmations, two RPCs agree). Manual
restock in the back office becomes "report a tx" (same verification); typing a number no longer creates stock.
The agent places one swap at a time and records it until the api has counted its tx (a run that times out
finishes it next time instead of buying again), holds a run lock so only one `--buy`/`--report` run touches that
record (both at `AGENT_STATE`, required for `--buy`/`--report`), retries reports on 5xx/network errors, refuses a quote more than `agent.maxPriceOverSpotPercent` above or
`agent.maxPriceUnderSpotPercent` below the api's spot price, re-reads the daily spend just before the swap, and
buys nothing when the api's `paused`/spend fields are missing (`apps/agent/README.md`).

Every verified swap is booked exactly once, as a restock or as the team's seed, never both: the USDC/USDT it paid
always goes on the books as platform money out (otherwise the next reconciliation would pause payments). Whole units
go to the warehouse; fractions of a unit are carried per token and booked once they add up to a whole unit (until
then they sit in the wallet as surplus). When units are already missing on chain (the wallet holds fewer than the
books count), the spend is still booked but the loss is never absorbed silently: the agent's report adds what it
bought and **pauses payments** at once (`paused`, `short` in the answer), so every reconciliation keeps flagging the
missing units until the team writes them off (stock adjust, with a reason); an admin's report of the swap writes them
off itself, as an explicit `loss` stock move with its reason, audited. A swap that bought several whitelisted bStocks
adds all of them in one report. The seed only ever comes in: a tx in which the Agentic Wallet sent anything out
(stablecoin or bStock) is refused as a seed (`not_a_seed`), and so is any transfer a player sent, credited or
rejected.

### 4. Party sales (dropship, settled at the end)

1. **Before the party**, the CEO sets a price per token for it (≤ 3× wholesale). Prices are locked for the party.
2. **During the party**, a guest's purchase is a server call (`POST /api/events/{id}/buy {token, qty}`), not just a
   message to the host's browser. In one transaction: check the party (live, not cancelled; a private one only for
   its invited guests; its host not banned), the guest's credits and the warehouse; **hold** the
   credits; **reserve** the units; record the sale (`pending`) with the CEO's price and the wholesale price at that
   moment. The host's game shows the sale as it does now (the sim is the show; the server is the money).
3. **When the party ends** (end time + `settleGraceMinutes`), one settlement job, per party, in one transaction:
   a party cancelled by then (read inside that transaction) has its sales voided instead; otherwise
   held credits are captured, reserved units move to the guest's real units, the wholesale amount goes to the
   platform, the margin goes to the CEO's credits, every line in the ledger and the audit log.
4. A sale can be voided by an admin before settlement (credits released, units unreserved). A host who disconnects
   doesn't cancel sales already made: they settle.

### 5. City shops (dropship, settled at once)

A shop open while the tenant is away has no "end": each purchase settles immediately with the same rules (credits
from guest, units from the warehouse, wholesale to the platform, margin to the tenant). The shop's lease (its tenant,
open, not ended) is checked inside that same transaction; a banned tenant's shop sells nothing.

## Zero trust (unchanged from the proposal, plus)

- Before credits: Privy token verified; tx hash + log index unused; chain 56, success, ≥ 15 confirmations; Transfer
  log from the locked USDC/USDT contract; recipient = Agentic Wallet; sender = the player's stored wallet; amount
  from the log ≥ $3 and within the player's caps (credited up to the room left; what isn't credited is recorded as
  `rejected`, or as the row's `refund_cents`, for the back office to refund and then mark refunded); two RPCs agree.
- Top-up reports can't burn the shared paid RPC quota: one report per player per 2 s (`429 too_soon`); at most
  20 *misses* per player per 10 minutes, then `429 too_many_misses` until they age out, while the scanner still
  credits a real transfer. A miss is any report whose receipt the RPCs couldn't show to hold a USDC/USDT transfer
  from the player's wallet to the Agentic Wallet: no transaction yet, a failed one, someone else's (final or still
  confirming), and any RPC error (oversized receipt, mismatch, provider down). A settled refusal (`tx_failed`,
  `not_a_topup`) is answered again for 10 minutes without RPC calls. The player's own transfer still confirming
  (`202`) is never a miss: it is in the receipt from its first block. Stale limiter entries are swept every 10
  minutes. Constants in `services/api/topups.go`.
- Before restock units: as above for the bStock transfer into the Agentic Wallet; USDC spent ≤ the agent's limits;
  units the wallet's balance doesn't back are written off (admin) or pause payments (agent); the tx not already
  booked as a restock or a seed.
- Before a sale: credits and warehouse checked and held in the same transaction; prices from the server, never from
  the browser; the price must still be within wholesale … 3× wholesale at today's quote (a shop priced before the
  market fell doesn't sell until its tenant reprices).
- The pause is read inside the transaction that moves the money (sale or top-up credit), so a reconciliation that
  pauses meanwhile stops it.
- Always: every credit change goes through the ledger in the same transaction as its cause; secrets and addresses
  live in server config.

## Reconciliation (hourly; a mismatch pauses top-ups, sales and restocks and alerts the back office)

1. Credits are backed: Σ player credits (including held) ÷ 100 + money owed back to senders ≤ USDC + USDT in the
   Agentic Wallet − platform funds. Money owed back = unknown senders' transfers, rejected top-ups and the part of a
   top-up over the caps, until the back office marks it refunded (`POST /api/admin/topups/refund`). It is in the
   wallet but belongs to its senders, so it never backs credits. Not owed: stablecoin coming back in a tx where the
   Agentic Wallet itself paid a positive amount of stablecoin out (a swap's change; the scanner records it with
   nothing to refund), nor anything in a tx booked as a restock or seed (already netted in platform funds; the back
   office shows it with nothing owed and won't mark it refunded). The scanner reads no receipt for a transfer from a
   non-player: whether the wallet paid out in its tx comes from one `eth_getLogs` per token for the whole range, and
   a zero-value "payout" (anyone can log `transferFrom(agenticWallet, x, 0)`) doesn't count.
2. Units are backed, per token: (warehouse on hand + reserved + Σ players' real units) × 0.001 ≤ bStock held.

**Before deploying migration 7** (money owed back), list the transfers its backfill will count as owed in full: an
unknown sender's transfer outside any booked restock or seed. A swap's change from a swap that was never booked shows
up here and would pause payments at the first reconciliation; book that swap (report it as a restock) first. Anything
else listed is a stranger's money, owed back.

```sql
SELECT tx, log_index, sender, token, usd_cents, datetime(created_at, 'unixepoch') AS at
FROM topups
WHERE status = 'unknown'
  AND lower(tx) NOT IN (SELECT lower(ref) FROM platform_ledger WHERE kind IN ('restock', 'seed'))
ORDER BY created_at;
```

**Migration 8** (`credited_at`, `scan_retries`, the `platform_ledger(lower(ref))` index) needs no data check: it
backfills `credited_at` for credited rows from `updated_at` and only adds a table and an index. After deploying it,
`GET /api/admin/payments` answers `scanRetries` (empty at first).

Balances are read from BSC, never from the database.

## What gets built (one PR each, tests in every one)

1. `apps/agent` into the repo as it is (quote only), plus `payments.json` (numbers, token whitelist with contracts).
2. BSC reader: transactions and logs through two RPCs, receipts, confirmations; unit tests with recorded fixtures.
3. Migration 5: `credits` + ledger kinds, `backed_units`, `topups`, `sales` (party/shop, held/settled/void).
4. Top-up: `POST /api/topups`, verification, caps, scanner; web top-up button and status.
5. Warehouse on real stock: verified `POST /api/agent/restock`, back office "report a tx", reservations.
6. Party sales: price list per party, `POST /api/events/{id}/buy`, settlement job, admin void; shop sales on credits.
7. Reconciliation job and back office pages (top-ups, sales, unknown transfers, reconciliation).
8. **Cutover, in one PR:** city switches from Coin to credits, the warehouse's unverified units are zeroed (the
   100 per token added by hand on 2026-10-02 are not real stock), back-office Coin grants stay Coin-only.

## Open questions

- How much USDC the platform seeds for the first warehouse stock, and who sends it.
- Settlement grace: 30 minutes after the party (`settleGraceMinutes`) unless the team wants it shorter.
- Withdrawals and selling units back: next phase (until then, the per-player caps stay).
- Legal review before any public launch with real money.
