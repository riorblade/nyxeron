# Game design

The rules the simulation implements, with the numbers they use today. Every number here comes from
`packages/core/src/data/*.json`; when you change one, update this page and run the balance scripts.

## Core loop (CEO career)

**Day** (office): stock tokens, set prices, book a DJ or band, post promos, hire staff, set house rules, renew
permits, build upgrades → **Night** (22:00–04:00, 360 in-game minutes): guests arrive, dance, buy tokens on a live
market, sometimes fight; inspectors may visit → **Report**: revenue, tax, satisfaction, reputation change →
next day (wages and rent, hype fades, safety recovers).

Win: reach Level 5 with reputation ≥ 80. Lose: Coin < 0 for 3 days, 3 violations, or reputation 0.
A career is 60 days.

## Rules

Each rule is a function in `packages/core/src/rules` with a unit test.

| ID | Rule | Where |
| --- | --- | --- |
| R1 | Order stock if Coin ≥ cost; it arrives after the supplier's lead time | `inventory.ts` |
| R2 | A guest buys a token: stock −1, Coin + price; out of stock → satisfaction hit, alert; a guest who hit it once only orders what's in stock, and stops queueing when nothing is | `inventory.ts` |
| R3 | Book a DJ if Coin ≥ fee and level ≥ the DJ's requirement → hype from the fanbase; not once the set slot (minute 60) has passed | `talent.ts` |
| R4 | DJ genre matches the crowd → dancing satisfaction +20%, else −15% | `engine.ts` |
| R5 | Promo if Coin ≥ cost and CEO Energy ≥ 1 → hype + a boost to that channel's audience | `marketing.ts` |
| R6 | Inspection chance a night: 5% base, 40% with a missing permit, ≥ 20% with safety under 40 | `legal.ts` |
| R7 | Over 150 guests without a crowd permit → may be shut down (revenue −50%, rep −10) | `engine.ts` |
| R8 | Underage guest at the door is rejected if security is present (below Level 3 the owner checks IDs) | `security.ts` |
| R9 | Tilt ≥ 80 and fewer than 1 guard per 40 guests → fight chance (safety −15, rep −5) | `security.ts` |
| R10 | Capacity reached → door closes; forcing it open is a violation | `security.ts` |
| R11 | Night report: avg satisfaction ≥ 70 → rep +3..+8; < 40 → rep −5 | `reputation.ts` |
| R12 | New day: CEO Energy back to 5, wages and rent paid | `economy.ts` |
| R13 | Defeat: Coin < 0 for 3 days, or 3 violations, or reputation 0 | `economy.ts` |
| R14 | Victory: Level 5 and reputation ≥ 80 (day 60 without it = survived); after a victory or survived run (or The Basement's week) the club plays on with no end date (`playOn`); a survived club can still win once | `progression.ts`, `engine.ts` |
| R15 | Entertainment tax on night revenue: L3 20%, L4 30%, L5 40% (none for booth/shop) | `economy.ts` |
| R16 | On-premise sales with only a takeaway liquor permit → violation, venue sealed | `legal.ts` |
| R17 | Controversial promo (daytime, rep > 20): hype +30, 25% chance rep −20 and a guaranteed inspection | `marketing.ts` |
| R18 | Move up a venue (daytime) if Coin ≥ cost and reputation ≥ requirement; stock moves at its value (count × old price scale ÷ new) | `progression.ts` |
| R19 | *Retired:* paid speed-ups. Value never buys progress; the economy is Coin + tokens (see the PRD) | — |

Beyond the R-rules: crowd energy and crowd moves (`strategy.ts`), house rules and reservations, promoters,
upgrades, the live token market and FOMO (`market.ts`), real spot prices (`quotes.ts`), guests as players
(`visitor.ts`), the city (`city.ts`) and stat explanations (`stats.ts`).

## Venues

| Lv | Venue | Cost | Rep | Capacity | Rent/day | Cover | Tax | Price scale | Storage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Token Booth | start | 0 | 20 | 100 | — | — | 1.5 | 1,000 |
| 2 | Token Shop | 50,000 | 20 | 40 | 500 | — | — | 4 | 1,500 |
| 3 | Token Bar & Live Music | 250,000 | 40 | 90 | 2,000 | — | 20% | 12 | 2,500 |
| 4 | Nightclub | 1,000,000 | 60 | 190 | 8,000 | 600 | 30% | 48 | 3,000 |
| 5 | Premium Venue | 5,000,000 | 75 | 500 | 30,000 | 2,500 | 40% | 60 | 5,000 |

`priceScale` sizes token prices, stock cost and guest budgets so income keeps pace with venue costs.

Staff unlock by level: desk broker (bartender) 2 · security, host, guest relations 3 · MC 4.

## Stats on the top bar

Every stat opens an explanation in the game (`hud/StatInfo.tsx`, history from `statHistory`).

| Stat | Range | Moves with | Affects |
| --- | --- | --- | --- |
| Coin | — | sales, door, tables; stock, wages, rent, tax, fines, upgrades | bankruptcy, moving up |
| Reputation | 0–100 | nightly satisfaction, fights, backfired promos, shutdowns | demand, bookings, moving up, win/lose |
| Hype | 0–100 | promos, DJs/bands (+), rivals (−), −10 every morning | tonight's demand |
| Safety | 0–100 | fights (−15), +10 every morning | demand (up to −25% at 0), inspections under 40 |
| CEO Energy | 0–5 | promos (−1), refills every morning | how many promos a day |
| Violations | 0–3 | failed inspections, forcing the door | 3 = game over |

## The night simulation

- 1 tick = 1 in-game minute; speed 1×/2×/3× changes ticks per second, not logic. A night simulates headless in
  milliseconds.
- Expected guests = level demand × (0.4 + hype + 0.4 × reputation) × busy weekday (Wed/Fri/Sat ×1.25) × house
  rules × safety.
- Each guest: segment, genre preference, gender, budget, satisfaction, tilt, state
  (`pending → queue → idle | bar | dance → left`).
- The live market moves each token every minute (volatility, crowd energy, pumps at the DJ start and the anthem);
  rising tokens raise the urge to buy (FOMO), and guests feel their P&L.

## The city (multiplayer)

The city runs on Credit (real money, 100 = $1; `docs/payments.md`). Venues from `city.json`, rent from
`payments.json → rentCredits`:

| Lv | Venues | Rent / week (Credit) |
| --- | --- | --- |
| 1 | 24 | 100 ($1) |
| 2 | 12 | 200 ($2) |
| 3 | 6 | 500 ($5) |
| 4 | 4 | 1,000 ($10) |
| 5 | 2 | 2,000 ($20) |

- Up to 5 venues per player (`maxVenuesPerPlayer`), rented in whole weeks, up to 4 ahead. The back office can
  change both the number of venues per level (never below a level's highest rented slot) and the weekly rent.
  Rent is the platform's money.
- Shops hold no stock: a shop's menu is a Credit price per token, for tokens whitelisted in `payments.json` that
  the venue's level may sell (`tokens.json → minLevel`). Each sale takes real units (0.001 share) from the
  platform's warehouse. The price must sit between the live wholesale price (`price × 0.001 × 100`, rounded up)
  and 3× it; the buyer takes up to 50 at once and pays at most the price they saw.
- Of each sale the platform gets wholesale, the tenant keeps the margin, the guest gets the units.
- Events (parties): at any club the player runs (city venue or Classic club), Level 3+, 5–60 minutes (default
  10), up to 7 days ahead, public or private with an invite link; the host opens the club from 15 minutes before
  and can cancel only until it starts. At a city venue the host sets Credit prices before the start; guests'
  purchases are held while it runs and settle when it ends. Guests' play-money spend pays the host nothing.

## Balance

Guard rail in CI: a sensible bot survives 30 days and reaches Level 2 (10 seeds). Full numbers:
`pnpm balance [runs]` (outcomes, day each level is reached) and `pnpm balance:levels [runs]` (fights, tax share,
profit per level). Latest (300 runs, 2026-10-02): Level 2/3/4/5 ≈ day 17 / 28 / 35 / 44; 0 fights a night at
Level 3; 100% victory for the bot. A sensible bot shouldn't lose; difficulty comes from player mistakes.
