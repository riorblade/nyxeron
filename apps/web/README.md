# Game client (apps/web)

React 19 + Vite + Tailwind v4, three.js venue, Web Audio. Deployed to Vercel as `nyxeron.xyz`.

```sh
cp .env.example .env.local   # VITE_PRIVY_APP_ID
pnpm dev                     # from the repo root → http://localhost:5173
```

| Folder       | What                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `screens/`   | Landing, Dashboard (roles, city, events), Office (+ `office/` tabs), Night, NightReport, LiveGuest, LiveDj, GigNight, Studio… |
| `hud/`       | top bar + stat explanations, event feed, objectives, token detail, ticker, pyro, sampler, room panel                          |
| `venue/`     | three.js scene (`scene3d.ts`), layouts, furniture, wall screens, videotron, pyro footage                                      |
| `dj/`        | decks, mixer, sampler, BPM analysis, transitions, planned sets, auto DJ, live mix sync                                        |
| `net/`       | relay client, snapshot codec, live session (host / guest / DJ)                                                                |
| `api/`       | HTTP clients: `player` (profile, wallet, nights, gigs), `docs` (save sync), `city`, `quotes`                                  |
| `auth/`      | Privy shell (`AuthShell.tsx`) and the signed-in account                                                                       |
| `state/`     | zustand stores (`store` = the game, `profile`, `settings`), saves, per-account storage scope                                  |
| `audio/`     | club audio: music between areas, SFX, kick detection                                                                          |
| `i18n/en.ts` | every player-facing string                                                                                                    |
| `lib/`       | small helpers                                                                                                                 |

Rules: game logic belongs in `packages/core`; the UI calls core functions through `state/store.ts`. Static media
lives in `public/` (art, sprites, audio, video, effects); source footage stays out of git in `assets-src/`.
