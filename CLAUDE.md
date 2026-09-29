# NYXERON · Claude Code rules

- Read plan.md first. Follow the current phase only.
- Game design source: docs/GDD_v01.pdf. Rule IDs R1..R19 map to plan.md section 5.
- Sim logic only in packages/core (pure TS, deterministic, seeded RNG). UI never mutates state directly.
- All tunable numbers in packages/core/src/data/\*.json.
- Every rule/system change needs a Vitest test.
- All in-game text in English via apps/web/src/i18n/en.ts.
- UI style: UI chrome (panels, HUD, menus) stays black and white, shadcn/ui, subtle glow, no gradients. Game art and the venue scene are full colour (owner decision, 2026-09-29): characters, club lights, LED floor, DJ screen.
- Smart contracts: Foundry + OpenZeppelin only. Never Hardhat.
- Never trust client-side results for on-chain rewards.
- After each task: run pnpm test and pnpm lint, then summarize changes briefly.
