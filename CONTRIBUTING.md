# Contributing

## Workflow

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`.
2. Small, focused commits. Message: an imperative summary line (≤ 72 chars), a blank line, then the why and any
   numbers that justify it (balance runs, sizes, timings).
3. Open a PR (the template has the checklist). CI must be green: lint, tests and builds for TypeScript; vet,
   gofmt and race tests for Go.
4. Squash or rebase merge; delete the branch.

## Where code goes

| Change                                     | Place                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| A game rule, formula or system             | `packages/core/src/rules/*.ts` (+ a test in `packages/core/test`)         |
| A tunable number                           | `packages/core/src/data/*.json`, never hard-coded                         |
| Player-facing text                         | `apps/web/src/i18n/en.ts`                                                 |
| Game screen / HUD / venue                  | `apps/web/src/screens`, `hud`, `venue`                                    |
| Talking to the api                         | `apps/web/src/api/*` (one module per area: player, docs, city, quotes)    |
| Client state (zustand) and local storage   | `apps/web/src/state/*`                                                    |
| Multiplayer session / relay client         | `apps/web/src/net/*`                                                      |
| Anything that moves Coin, tokens or access | `services/api` (server-settled), with a Go test                           |
| Database schema                            | a new entry at the end of `services/api/migrate.go` (never edit old ones) |
| Back office page                           | `apps/admin/src/pages/*`                                                  |

## Rules of the codebase

- **The sim is pure.** `packages/core` has no DOM, no network, no `Date.now()`/`Math.random()`: state in,
  state out, seeded RNG. The UI never mutates game state directly.
- **Data, not magic numbers.** Every tunable lives in `packages/core/src/data/*.json`. If the api settles with it
  (tokens, levels, city, strategy), run `pnpm sync:gamedata`; a Go test fails until you do.
- **Every rule change has a test.** For balance changes, run `pnpm balance` / `pnpm balance:levels` and put the
  before/after numbers in the PR.
- **Never trust the client for value.** Wallets, rent, shop sales, party payouts, stock and anything on-chain are
  decided by the api. The browser asks; the server answers.
- **Admin changes are audited.** Every back-office mutation writes an audit row with actor, before/after and a
  required reason, in the same transaction.
- **UI style.** UI chrome (panels, HUD, menus, back office) is black and white with a subtle white glow, no
  gradients. Game art and the venue scene are full colour.
- **Contracts.** Foundry + OpenZeppelin only.
- **Secrets** live in `deploy/.env` and `apps/*/.env.local` (gitignored). Never commit them, never print them in
  logs or PRs.

## Definition of done

- `pnpm lint` and `pnpm test` pass; `pnpm test:go` passes if `services/` changed.
- New rules/systems/endpoints have tests; balance changes have numbers.
- Docs updated where behaviour changed (`docs/api.md`, `docs/game-design.md`, the relevant README) and a line in
  `docs/changelog.md` for anything a player or admin would notice.
