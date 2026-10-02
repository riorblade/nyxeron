# @nyxeron/core

The simulation engine: pure, deterministic TypeScript (no DOM, no network, no clock), seeded RNG, every number in
JSON. Used by the game client, the balance bots and tests; the api embeds a copy of the data it settles with.

```
src/
├─ state.ts        GameState, events, new career (createGameState), save compaction, migrations
├─ engine.ts       the night: startNight → tickNight (1 in-game minute) → endNight; nextDay; expectedGuests
├─ rules/          one module per system (inventory, economy, talent, marketing, legal, security, reputation,
│                  progression, strategy, market, quotes, visitor, city, stats, autoCeo, ceo)
├─ objectives.ts   today's objectives
├─ scenario.ts     The Basement and sandbox
├─ data/*.json     every tunable number (levels, tokens, staff, permits, night, strategy, city…)
├─ data.ts         typed access to the data
└─ rng.ts          seeded RNG
scripts/           bot.ts (the AI CEO day), balance.ts, levelstats.ts
test/              rules, engine, persistence, balance guard rail, city, stats…
```

```ts
import { createGameState, runNight, nextDay, aiPrepare } from "@nyxeron/core";

let s = createGameState(42, "edm");
s = nextDay(runNight(aiPrepare(s))); // one bot day, deterministic for the seed
```

Run `pnpm test` (all) or `pnpm balance [runs]` / `pnpm balance:levels [runs]` from the repo root. After editing
`tokens`, `levels`, `city` or `strategy` JSON, run `pnpm sync:gamedata`.
