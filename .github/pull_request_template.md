<!--
  Every section below is required; the "PR checks" workflow blocks the merge until it's filled in.
  Title format:  type(scope): what changes, in the imperative
                 e.g.  feat(city): let tenants rename their venue
  Types:  feat · fix · perf · refactor · docs · test · chore · ci · build · revert
  Scopes: core · web · admin · api · relay · deploy · docs · repo · city · economy · multiplayer · dj · venue · auth
  Write "N/A" where a section truly doesn't apply. Delete these comments if you like.
-->

## Summary

<!-- One or two sentences a teammate can read in 10 seconds: what changes, for whom. -->

## Type

- [ ] Feature (new capability)
- [ ] Fix (something was broken)
- [ ] Performance
- [ ] Refactor (no behaviour change)
- [ ] Balance / tuning (numbers in `packages/core/src/data`)
- [ ] Docs
- [ ] Tooling / CI / deploy

## Area

<!-- Tick every part of the product this touches. -->

- [ ] Game: CEO (office, night, career)
- [ ] Game: Guest
- [ ] Game: DJ (studio, live sets)
- [ ] City (rent, shops, parties)
- [ ] Economy (Coin, tokens, prices, warehouse)
- [ ] Multiplayer (relay, live session)
- [ ] Accounts / auth
- [ ] Back office
- [ ] Simulation core (`packages/core`)
- [ ] API (`services/api`)
- [ ] Relay (`services/relay`)
- [ ] Infra / deploy
- [ ] Docs / repo

## Why

<!-- The problem or goal. Link the issue, task or conversation. Include numbers if you have them. -->

## What changed

<!-- Where the change lives and what it does. One line per file or module that matters, e.g.
- `services/api/city.go`: PUT /api/city/venue renames the tenant's venue
- `apps/web/src/screens/CityPanels.tsx`: Rename button on the venue card -->

## How to test

<!-- Steps a reviewer can follow, and what they should see. Which tests cover it. -->

## Screenshots

<!-- Required for UI changes (before / after). N/A otherwise. -->

## Risk & rollback

<!-- What could break, who is affected, and how to undo it (revert, flag, data fix). -->

## Deploy notes

<!-- Migrations, new env vars, `pnpm sync:gamedata`, data backfills, order of deploys (api before web?). N/A if none. -->

## Checklist

- [ ] Title follows `type(scope): summary`
- [ ] `pnpm lint` and `pnpm test` pass (and `pnpm test:go` if `services/` changed)
- [ ] New or changed rules/endpoints have tests
- [ ] Tunable numbers are in `packages/core/src/data/*.json` (`pnpm sync:gamedata` if the api uses them), or N/A
- [ ] Player-facing text is in `apps/web/src/i18n/en.ts`, or N/A
- [ ] UI follows the frontend standard (CONTRIBUTING.md) and was checked at 390 px and 1440 px, or N/A
- [ ] Schema changes are a new migration at the end of `services/api/migrate.go`, or N/A
- [ ] Anything that moves Coin, tokens or access is settled server-side, or N/A
- [ ] Docs updated (`docs/`, READMEs) and a `docs/changelog.md` line for anything players or admins notice, or N/A
- [ ] No secrets, keys or personal data in code, logs or screenshots
