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
| Wholesale price of a unit | live bStock price × 0.001 × 100, rounded up | quoted server-side |
| CEO's price | up to 3× wholesale (`city.json → shop.maxMarkup`) | set per party, before it starts |
| Top-up fee | 1% (min top-up $3) | covers gas sponsorship; the rest is revenue |
| Per-player top-up cap | $20 a day, $100 in total during the hackathon | there's no withdrawal yet |
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
the back office).

### 3. Warehouse restock (platform; replaces "CEO orders")

The agent keeps the warehouse stocked from demand (`GET /api/agent/demand`: on hand, reserved, sold 24 h/7 d,
suggested) and buys bStock in bulk with **platform funds** (fees, or a seed the team puts in), not with players'
credits. `POST /api/agent/restock {token, qty, tx}` adds units **only after the api verifies the swap on BSC**
(bStock received by the Agentic Wallet, amount from the logs, tx unused, 15 confirmations, two RPCs agree). Manual
restock in the back office becomes "report a tx" (same verification); typing a number no longer creates stock.

### 4. Party sales (dropship, settled at the end)

1. **Before the party**, the CEO sets a price per token for it (≤ 3× wholesale). Prices are locked for the party.
2. **During the party**, a guest's purchase is a server call (`POST /api/events/{id}/buy {token, qty}`), not just a
   message to the host's browser. In one transaction: check the guest's credits and the warehouse; **hold** the
   credits; **reserve** the units; record the sale (`pending`) with the CEO's price and the wholesale price at that
   moment. The host's game shows the sale as it does now (the sim is the show; the server is the money).
3. **When the party ends** (end time + `settleGraceMinutes`), one settlement job, per party, in one transaction:
   held credits are captured, reserved units move to the guest's real units, the wholesale amount goes to the
   platform, the margin goes to the CEO's credits, every line in the ledger and the audit log.
4. A sale can be voided by an admin before settlement (credits released, units unreserved). A host who disconnects
   doesn't cancel sales already made: they settle.

### 5. City shops (dropship, settled at once)

A shop open while the tenant is away has no "end": each purchase settles immediately with the same rules (credits
from guest, units from the warehouse, wholesale to the platform, margin to the tenant).

## Zero trust (unchanged from the proposal, plus)

- Before credits: Privy token verified; tx hash + log index unused; chain 56, success, ≥ 15 confirmations; Transfer
  log from the locked USDC/USDT contract; recipient = Agentic Wallet; sender = the player's stored wallet; amount
  from the log ≥ $3 and within the player's caps; two RPCs agree.
- Before restock units: as above for the bStock transfer into the Agentic Wallet; USDC spent ≤ the agent's limits.
- Before a sale: credits and warehouse checked and held in the same transaction; prices from the server, never from
  the browser.
- Always: every credit change goes through the ledger in the same transaction as its cause; secrets and addresses
  live in server config.

## Reconciliation (hourly; a mismatch pauses top-ups, sales and restocks and alerts the back office)

1. Credits are backed: Σ player credits (including held) ÷ 100 ≤ USDC + USDT in the Agentic Wallet − platform funds.
2. Units are backed, per token: (warehouse on hand + reserved + Σ players' real units) × 0.001 ≤ bStock held.

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
