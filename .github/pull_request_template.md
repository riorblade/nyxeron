## What

<!-- One or two sentences: what changes for players, admins or the team. -->

## Why

## How it was checked

- [ ] `pnpm lint` and `pnpm test` pass
- [ ] `pnpm test:go` passes (if `services/` changed)
- [ ] Rule or system change → Vitest test added (`packages/core/test`)
- [ ] Tunable numbers live in `packages/core/src/data/*.json` (and `pnpm sync:gamedata` if the api uses them)
- [ ] Player-facing text in `apps/web/src/i18n/en.ts`
- [ ] Database change → a new migration in `services/api/migrate.go` (never edit a shipped one)
- [ ] Screenshots for UI changes

## Notes for reviewers
