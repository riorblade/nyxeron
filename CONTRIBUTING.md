# Contributing

## Toolchain (required)

| Tool    | Version                                    | Notes                                                                                                                                                                                                                   |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js | 22 LTS (`.nvmrc`)                          | `nvm use` / `fnm use`                                                                                                                                                                                                   |
| pnpm    | 10 (`packageManager` in `package.json`)    | `corepack enable`, then `pnpm install`. **npm, yarn and bun are refused** by the preinstall check: the repo is one pnpm workspace with one lockfile (`pnpm-lock.yaml`), and Vercel, Docker and CI all install with pnpm |
| Go      | 1.26 (`go.mod`)                            | for `services/`                                                                                                                                                                                                         |
| Editor  | any, with EditorConfig + Prettier + ESLint | format on save; `pnpm format` fixes the whole repo                                                                                                                                                                      |

Add a dependency with `pnpm --filter <web|admin|@nyxeron/core> add <pkg>` (or `-w` for root tooling) and commit
the lockfile. New runtime dependencies need a reason in the PR (bundle size matters: the landing page must stay
light).

## Workflow

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`.
2. Small, focused commits. Message: an imperative summary line (≤ 72 chars), a blank line, then the why and any
   numbers that justify it (balance runs, sizes, timings).
3. Open a PR that follows the PR rules below. CI must be green: **PR checks** (title + description), lint, tests
   and builds for TypeScript; vet, gofmt and race tests for Go.
4. At least one approving review. Squash or rebase merge; delete the branch.

## Pull requests (mandatory)

Every PR uses `.github/pull_request_template.md`, and the **PR checks** workflow blocks the merge until it does.

**Title:** `type(scope): what changes, in the imperative`, ≤ 72 characters.

| Types  | `feat` · `fix` · `perf` · `refactor` · `docs` · `test` · `chore` · `ci` · `build` · `revert`                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Scopes | `core` · `web` · `admin` · `api` · `relay` · `deploy` · `docs` · `repo` · `city` · `economy` · `multiplayer` · `dj` · `venue` · `auth` |

Several scopes: `fix(api,web): …`. Breaking change: `feat(api)!: …`.

```
feat(city): let tenants rename their venue
fix(admin): keep the restock confirmation after the banner closes
perf(venue): merge furniture into one mesh per material
docs(repo): add the PR template
```

**Description:** every section filled in:

| Section         | What goes there                                                         |
| --------------- | ----------------------------------------------------------------------- |
| Summary         | one or two sentences: what changes, for whom                            |
| Type / Area     | tick the kind of change and every part of the product it touches        |
| Why             | the problem or goal, with a link and numbers when you have them         |
| What changed    | where: one line per file or module that matters                         |
| How to test     | steps a reviewer follows and what they should see; which tests cover it |
| Screenshots     | before/after for UI changes (N/A otherwise)                             |
| Risk & rollback | what could break and how to undo it                                     |
| Deploy notes    | migrations, env vars, `pnpm sync:gamedata`, deploy order (N/A if none)  |
| Checklist       | every box ticked (each item allows N/A)                                 |

Labels (`area: web`, `area: api`, `db migration`, `data / balance`…) are added automatically from the changed
paths. The rules live in `.github/scripts/check-pr.cjs` (tested in `check-pr.test.mjs`).

**Repo admins:** make the checks required in GitHub → Settings → Branches → `main` → _Require status checks to
pass_: "Title and description follow the template", "TypeScript (core, web, admin)", "Go (relay)", "Go (api)";
also _Require a pull request before merging_ with one approval.

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

## Frontend standard (apps/web, apps/admin)

**Stack:** React 19 function components + hooks, TypeScript strict, Vite, Tailwind v4, shadcn/ui primitives
(`components/ui`), zustand for client state, lucide-react icons. No class components, no CSS-in-JS, no other UI
kit, no state library besides zustand.

**Files and names**

| What            | Convention                                                                | Example                             |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| Component file  | `PascalCase.tsx`, one exported component (small private helpers below it) | `screens/CityPanels.tsx`            |
| Module (no JSX) | `camelCase.ts`                                                            | `api/city.ts`, `state/store.ts`     |
| Hook            | `useSomething`, in the module that owns the data                          | `useCity`, `useAccount`             |
| Test            | next to the code, `*.test.ts`                                             | `state/save.test.ts`                |
| Imports         | `@/…` alias across folders, `./…` within a folder                         | `import { city } from "@/api/city"` |

**Where things go** (game client; the back office mirrors it: `pages/`, `ui/`, `api.ts`)

- Screens in `screens/`, HUD pieces in `hud/`, 3D in `venue/`, DJ in `dj/`.
- **Every server call goes through `api/*`**: components never `fetch` directly.
- **Every game rule goes through `packages/core`**, called via `state/store.ts`: components never compute game
  outcomes or edit `GameState`.
- localStorage only through `state/` (account-scoped keys via `state/scope.ts`), wrapped in try/catch.
- Player-facing text only in `i18n/en.ts` (the back office is internal and may keep English inline).

**Styling**

- Tailwind utilities; shared looks as `@utility` in `index.css` (`glass`, `panel`, `btn`…). No inline `style`
  except dynamic values (positions, CSS variables).
- UI chrome is black and white with a subtle white glow, no gradients; colour only in game art and the venue.
- Mobile first: works at 390 px wide without horizontal scroll; check 390 / 1440 before opening a PR.

**Quality bar**

- Accessible: real `<button>`/`<a>`, labels or `aria-label` on inputs and icon buttons, focus visible, Esc closes
  overlays, no keyboard traps.
- Loading, empty and error states for anything that fetches.
- Heavy screens and SDKs are lazy (`React.lazy`): three.js, Privy, the studio.
- Effects clean up (timers, listeners, audio nodes); no `Date.now()`/`Math.random()` during render (React lint).

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
