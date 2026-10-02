# Back office (apps/admin)

React + Vite + Tailwind v4, Privy sign-in. Deployed to Vercel as `admin.nyxeron.xyz`. Black and white, no logic
of its own: every permission and rule is enforced by the api (`/api/admin/*`).

```sh
cp .env.example .env.local   # VITE_PRIVY_APP_ID (same Privy app as the game)
pnpm dev:admin               # from the repo root → http://localhost:5174 (needs pnpm dev:api)
```

Sign in with an email listed in the api's `ADMIN_EMAILS` (owner), or one an owner added in Settings → Admins.

| Page      | What                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| Overview  | players, activity, coin, rent revenue, live rooms, price feed, backups                                         |
| Players   | search; detail with portfolio, saves, coin ledger, history; grant coin, venue access, ban, rename, clear saves |
| Venues    | tenants, shops, live/scheduled parties; end lease, cancel party, weekly rent                                   |
| Stock     | platform warehouse, demand, suggested restock, movements; restock/correct                                      |
| Audit log | every back-office change                                                                                       |
| Settings  | dashboard announcement; admins (owners only)                                                                   |

`src/pages/*` one file per page, `src/ui/kit.tsx` shared pieces, `src/api.ts` the typed client.
