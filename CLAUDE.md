# NYXERON · Claude Code rules

- Start from README.md and docs/ (PRD.md for the product, architecture.md for how parts fit, game-design.md for
  rules R1–R19 and numbers, api.md for endpoints, roadmap.md for what's next). Follow CONTRIBUTING.md.
- Sim logic only in packages/core (pure TS, deterministic, seeded RNG). UI never mutates state directly.
- All tunable numbers in packages/core/src/data/\*.json. If the api settles with them, run `pnpm sync:gamedata`.
- Every rule/system change needs a Vitest test; every api change a Go test. Balance changes come with numbers
  (`pnpm balance`, `pnpm balance:levels`).
- All in-game text in English via apps/web/src/i18n/en.ts.
- Web client layout: screens/ hud/ venue/ dj/ net/ api/ auth/ state/ audio/ i18n/ lib/ (see docs/architecture.md).
- Anything that moves Coin, tokens or access is settled in services/api, never trusted from the client. Schema
  changes are new migrations at the end of services/api/migrate.go.
- Back-office mutations need a reason and write an audit row in the same transaction.
- UI style: UI chrome (panels, HUD, menus, back office) stays black and white, shadcn/ui, subtle glow, no
  gradients. Game art and the venue scene are full colour (owner decision, 2026-09-29).
- Smart contracts: Foundry + OpenZeppelin only. Never Hardhat.
- After each task: run pnpm test and pnpm lint (and pnpm test:go if services/ changed), add a docs/changelog.md
  line for anything a player or admin would notice, then summarize changes briefly.
