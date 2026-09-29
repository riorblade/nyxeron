# NYXERON: Nightlife Empire · Build Plan

> Source of truth for game design: `Tugas02_KelompokEmpuy_Nyxeron_GDDv01.pdf` (GDD v0.1).
> This plan turns that GDD into code. All in-game text is **English**.

## 0. Key Decision: Web Stack Instead of Unity

The GDD v0.1 lists Unity. For building with Claude Code, a **TypeScript web stack** is recommended instead:

- Everything is code (no Unity Editor scene work Claude Code cannot see or edit).
- Management sims are UI-heavy (panels, tables, reports), which fits React.
- Web3 integration on Monad is native (viem / wagmi), no Unity-EVM bridge needed.
- Runs in the browser, easy to demo at UTS and share with the team.

**Action:** update GDD v0.2 Technical Specs to "Web (TypeScript), PC browser" once the team agrees.

## 1. Scope

### MVP (target: UTS conceptual prototype)

- Level 1 (Drink Booth) fully playable: stock, pricing, 1 promo channel, day/night loop.
- Level 4 (Nightclub "The Basement") one full night playable: DJ booking, promo channels, security, permits, guests, incidents, Night Report.
- Level-up flow from Level 1 to Level 2 (skeleton for 3 to 5).
- Save/load (local).
- No wallet required.

### Post-MVP

- Levels 2, 3, 5 full content, Career mode (60 days), Sandbox mode.
- Web3 layer on Monad ($NYX, Venue NFT, marketplace, season rewards).

### Non-goals (for now)

- Multiplayer, mobile layout, sound design beyond placeholders, final art.

## 2. Tech Stack

| Layer          | Choice                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces                                                                   |
| Sim core       | Pure TypeScript, deterministic, seeded RNG, zero DOM deps                         |
| App            | Vite + React + TypeScript                                                         |
| State          | Zustand (UI state) wrapping the sim core                                          |
| UI             | Tailwind + shadcn/ui, black and white palette, subtle glow, no neon, no gradients |
| Venue renderer | three.js 3D (orbit camera), billboard character sprites (was PixiJS isometric)    |
| Tests          | Vitest (core must be heavily tested)                                              |
| Contracts      | Foundry + OpenZeppelin                                                            |
| Web3 client    | viem + wagmi                                                                      |
| Chain          | Monad (testnet first; verify chain ID and RPC at docs.monad.xyz)                  |

## 3. Repo Structure

```
nyxeron/
├─ CLAUDE.md                 # rules for Claude Code (see section 9)
├─ plan.md
├─ docs/GDD_v01.pdf
├─ packages/
│  ├─ core/                  # simulation engine (no UI)
│  │  ├─ src/
│  │  │  ├─ state.ts         # GameState types
│  │  │  ├─ engine.ts        # tick(), runDay(), runNight()
│  │  │  ├─ rng.ts           # seeded RNG
│  │  │  ├─ rules/           # R1..R19, one file per rule group
│  │  │  ├─ systems/         # inventory, economy, talent, marketing,
│  │  │  │                   # legal, security, guestAI, reputation, progression
│  │  │  └─ data/            # JSON: drinks, djs, channels, permits, levels
│  │  └─ test/
│  └─ contracts/             # Foundry project (post-MVP)
└─ apps/
   └─ web/                   # React app
      ├─ src/screens/        # MainMenu, ClubSetup, Office, Venue, NightReport, Victory, Defeat, Pause
      ├─ src/hud/            # TopBar, SidePanel, ObjectivePanel, StockPanel, EventFeed, NowPlaying
      ├─ src/venue/          # Pixi isometric renderer
      └─ src/web3/           # wallet, contract hooks (post-MVP)
```

## 4. Core Data Model (from GDD)

```ts
type Level = 1 | 2 | 3 | 4 | 5;
type Phase = "day" | "night" | "report";

interface GameState {
  day: number; // 1..60
  phase: Phase;
  level: Level;
  coin: number; // start 10_000
  reputation: number; // 0..100, start 20
  hype: number; // 0..100, decays -10/day
  safety: number; // 0..100
  ceoEnergy: number; // 5 per day
  ceoCallUsed: boolean; // 1x per night
  violations: number; // 0..3, 3 = game over
  negativeCashDays: number; // 3 = bankrupt
  stock: Record<DrinkId, number>;
  pendingOrders: Order[]; // supplier lead time 0..2 days
  permits: Record<PermitId, { valid: boolean; expiresDay: number }>;
  bookedTalent: TalentId[];
  activePromos: ChannelId[];
  staff: Staff[];
  prices: Record<DrinkId, number>;
  log: GameEvent[]; // feeds Event Feed + Night Report
  seed: number;
}
```

Permits: `business`, `liquorTakeaway`, `liquorOnPremise`, `crowd` (events over 150 guests).

## 5. Rules to Implement (GDD section 9.1)

Each rule gets its own function and a unit test. Naming: `r01_orderStock`, `r02_serveDrink`, etc.

| ID  | Rule (short)                                                                      | System           |
| --- | --------------------------------------------------------------------------------- | ---------------- |
| R1  | Order stock if coin ≥ cost; arrives after lead time                               | Inventory        |
| R2  | Guest orders drink: stock −1, coin +price; out of stock → satisfaction −10, alert | Inventory        |
| R3  | Book DJ if coin ≥ fee and level ≥ DJ requirement                                  | Talent           |
| R4  | DJ genre = dominant crowd genre → satisfaction +20%, else −15%                    | Talent           |
| R5  | Promo if coin ≥ cost and energy ≥ 1 → hype + segment boost                        | Marketing        |
| R6  | Club open with expired permit → 40% inspection chance/night                       | Legal            |
| R7  | Event > 150 guests without crowd permit → may be shut down                        | Legal            |
| R8  | Guest at door: security present → underage rejected                               | Security         |
| R9  | Drunk ≥ 80 and security ratio < 1:40 → fight chance                               | Security         |
| R10 | Guests ≥ capacity → door closes; forcing open = violation                         | Security         |
| R11 | Night Report: satisfaction ≥ 70% → rep +3..+8; < 40% → rep −5                     | Reputation       |
| R12 | New day: energy reset to 5, wages and rent deducted                               | Economy          |
| R13 | Coin < 0 for 3 days, or 3 violations, or rep 0 → Defeat                           | Economy          |
| R14 | Level 5 and rep ≥ 80 → Victory                                                    | Progression      |
| R15 | 40% entertainment tax on night revenue                                            | Economy          |
| R16 | Drinking on premise with takeaway-only liquor permit → violation                  | Legal            |
| R17 | Controversial promo: hype +30, 25% chance rep −20 + guaranteed inspection         | Marketing        |
| R18 | Upgrade level if coin ≥ cost and rep ≥ requirement                                | Progression      |
| R19 | Spend $NYX on speed-up (wallet required); 30% burned                              | Token (post-MVP) |

### Level table (data/levels.json)

| Lv  | Name             | Cost         | Rep req | Unlocks                                       | Revenue                 |
| --- | ---------------- | ------------ | ------- | --------------------------------------------- | ----------------------- |
| 1   | Drink Booth      | start 10,000 | 0       | stock, pricing, posters                       | per glass               |
| 2   | Drink Shop       | 50,000       | 20      | staff, suppliers, takeaway permit             | glass + bottle takeaway |
| 3   | Bar & Live Music | 250,000      | 40      | bands, on-premise permit, open table          | bar + table             |
| 4   | Nightclub        | 1,000,000    | 60      | DJs, security, full night phase, crowd permit | cover + bar + table     |
| 5   | Premium Venue    | 5,000,000    | 75      | VIP, bottle service, festivals                | bottle service + events |

All numbers are placeholders for balancing. Keep them in JSON, never hard-coded.

## 6. Night Simulation Design

- Night runs 22:00 to 04:00 in-game, about 6 real minutes at 1x.
- Fixed-step tick (e.g. 1 tick = 1 in-game minute). Speeds 1x/2x/3x change ticks per second, not logic.
- Guest arrivals = f(hype, reputation, day-of-week bonus Wed/Fri/Sat, level capacity).
- Each guest is a lightweight agent: `{ segment, genrePref, budget, drunk, satisfaction, state }`.
- States: `queue → door → inside(idle | bar | dance | seat) → leave`.
- Core runs headless so a full night can be simulated in tests in milliseconds.
- Renderer only reads state; it never mutates it.

## 7. Milestones

Each phase ends with passing tests and a short demo. Work in this order.

### P0 · Setup (0.5 day)

- pnpm monorepo, Vite React app, `packages/core`, Vitest, ESLint, Prettier.
- Tailwind + shadcn/ui with B&W theme tokens.
- CLAUDE.md in place.
- **Done when:** `pnpm test` and `pnpm dev` both run.

### P1 · Sim Core (3 to 4 days)

- GameState, seeded RNG, data JSON loaders.
- Systems: inventory, economy, marketing, talent, legal, security, guestAI, reputation, progression.
- Rules R1 to R18 with unit tests.
- `runNight(state)` headless, returns new state + event log.
- **Done when:** a scripted 7-day playthrough test at Level 4 passes and produces a deterministic report for a given seed.

### P2 · UI Shell (2 to 3 days)

- Screen flow: Main Menu → Club Setup → Office → Venue → Night Report → Victory/Defeat, plus Pause (Esc).
- Office tabs: Stock, Talent, Promo, Staff, Permits (match GDD wireframe 14.4).
- Night HUD: top bar, side panel, objectives, capacity, stock bars, event feed, now playing, CEO Call (match GDD wireframe 14.3).
- Controls: Space pause, 1/2/3 speed, Tab panel, Q CEO Call, Esc pause.
- **Done when:** one full day and night can be played with a placeholder venue view.

### P3 · Venue Renderer (2 to 3 days)

- PixiJS isometric grid for "The Basement" (layout from GDD 15.1).
- Guests as simple sprites moving between zones; floating alerts ("!") clickable.
- Floating "+Coin" on sales.
- Camera pan (WASD / right-drag) and 3 zoom levels.
- **Done when:** a night looks alive and alerts can be resolved by clicking.

### P4 · Progression & Save (1 to 2 days)

- Level 1 booth scene (simple), level-up flow, unlock gating in UI.
- Autosave after each Night Report + 3 manual slots (localStorage, versioned schema).
- **Done when:** a player can go from Level 1 to Level 2 and reload the game.

### P5 · Onboarding & Balancing (ongoing)

- Tutorial folded into Day 1 and Day 2.
- Week 1 challenge flow for Level 4 (GDD 15.3).
- Balancing script: simulate 1,000 seeded runs, report bankruptcy rate and average days to each level.
- **Done when:** UTS demo is stable.

### P6 · Web3 on Monad (post-MVP)

- **Contracts (Foundry + OpenZeppelin):**
  - `NyxToken` (ERC-20, burnable, capped supply).
  - `VenueNFT` (ERC-721, one per owned Level 5 venue, metadata = venue stats snapshot).
  - `NyxSpend`: pay $NYX for speed-ups and cosmetics; 30% burn, 70% to Treasury.
  - `Treasury`: receives spend share and 5% marketplace fee; funds RewardPool.
  - `RewardPool`: season-capped Merkle distributor for achievement rewards.
  - `Marketplace`: list/buy VenueNFT and cosmetics, 5% fee.
- **Security rule:** the sim runs client-side, so never mint rewards from client-reported results. Season rewards are computed by a backend that validates runs (replay by seed + action log) and publishes a Merkle root.
- Anti pay-to-win: $NYX can never buy levels or reputation.
- Venue NFT is never burned on bankruptcy (venue just closes).
- Tests: Foundry unit tests + invariant tests for supply cap and burn split.
- **Done when:** testnet deploy, wallet connect is optional in the app, one speed-up purchase and one reward claim work end to end.

### P7 · Deploy

- Web app on Vercel; contracts verified on Monad explorer.
- Compliance review for Indonesia before any public token sale (TBD).

## 8. Definition of Done (every task)

- Logic lives in `packages/core`, never in React components.
- New rule or system = new unit test.
- No magic numbers; values come from `data/*.json`.
- All player-facing strings in English, kept in `apps/web/src/i18n/en.ts` (ready for future localization).
- `pnpm test` and `pnpm lint` pass.

## 9. CLAUDE.md (paste into repo root)

```md
# NYXERON · Claude Code rules

- Read plan.md first. Follow the current phase only.
- Game design source: docs/GDD_v01.pdf. Rule IDs R1..R19 map to plan.md section 5.
- Sim logic only in packages/core (pure TS, deterministic, seeded RNG). UI never mutates state directly.
- All tunable numbers in packages/core/src/data/\*.json.
- Every rule/system change needs a Vitest test.
- All in-game text in English via apps/web/src/i18n/en.ts.
- UI style: black and white, shadcn/ui, subtle glow, no neon, no gradients.
- Smart contracts: Foundry + OpenZeppelin only. Never Hardhat.
- Never trust client-side results for on-chain rewards.
- After each task: run pnpm test and pnpm lint, then summarize changes briefly.
```

## 10. Suggested First Prompts for Claude Code

1. "Read plan.md and CLAUDE.md. Do P0: scaffold the pnpm monorepo exactly as section 3. Stop when pnpm test and pnpm dev work."
2. "Do P1 part 1: GameState types, seeded RNG, data JSON (drinks, levels, permits, channels, djs) and rules R1, R2, R12, R15 with tests."
3. "Do P1 part 2: rules R3 to R11, R16, R17 and runNight() headless. Add the 7-day Level 4 playthrough test."
4. "Do P2: screen flow and Office tabs matching the GDD wireframes."

## 11. Open Questions

- Team agrees on switching from Unity to web? (update GDD v0.2)
- Art direction for sprites: pixel art or flat isometric?
- Does the Web3 layer need to appear in the UTS demo, or only in the GDD?
- Who owns which phase among the three members?

## 12. Status (2026-09-29)

P0–P5 done (MVP playable). P6 Web3 and P7 deploy not started.

- Run: `pnpm dev` · `pnpm test` · `pnpm lint` (includes typecheck) · `pnpm balance [runs]`.
- Modes: Career (Level 1 → 5, 60 days) and Scenario "The Basement" (Level 4, GDD 15.3 Week 1).
- Deviations from this plan, all tunable in `packages/core/src/data/*.json`:
  - Entertainment tax (R15) applies from Level 3 (bars/clubs), not to the booth/shop.
  - Below Level 4 the owner checks IDs (R8), since security only unlocks at Level 4.
  - Each level has a `priceScale` (drink prices, stock cost, guest budgets) so income keeps pace with the GDD ladder costs (50k → 5M).
  - Bartenders add bar throughput; out-of-stock (R2) hits each guest once, then they order what's in stock.
  - Staff is stored as counts per role, not `Staff[]`.
- Balance (bot, 1,000 runs): Level 2 ≈ day 17, Level 3 ≈ 28, Level 4 ≈ 45, Level 5 ≈ 57; ~91% victory, 0% defeat. A sensible bot never loses, so difficulty comes from player mistakes. Tighten in P5 if playtests feel easy.
- UI: glass/B&W design (MotionSites "Data Signal" + "Glow Features" references), logo + Home on every screen (leaving autosaves), Open Club cutscene `apps/web/public/intro.mp4` (Higgsfield Seedance 2.0, 8 s, skippable, "Don't show again").
- Landing: scroll-scrubbed cinematic one-pager ("Tokyo Nocturne" spec adapted: Greek glyph flicker for Nyx), Higgsfield videos `landing-hero.mp4` (all-intra encode, so no WebCodecs frame bank needed) + `landing-reveal.mp4`.
- Office game UI: sidebar nav, scene banner, character cards with 3D tilt (MotionSites "Animated Cards"), permit documents with stamps, venue ladder. Art in `apps/web/public/art` (22 pieces, Higgsfield GPT Image 2: office, 6 drinks, 8 DJs, 2 staff, 5 venues).
- Venue scene: 18 character sprites (10 guests, DJ at decks, 2 stage dancers, karaoke MC, 2 bartenders, 2 bodyguards) + floor textures in `apps/web/public/sprites`; LED dance floor on the beat, light beams, spotlights. Staff sprites follow hired counts; dancers/MC are cosmetic (no performer booking system yet).
- Colour venue (2026-09-29): full-colour characters, club lights, hue-sweeping LED floor, back wall with a concert LED screen playing the booked DJ's loop (`public/video/dj-*.mp4`, Seedance from each DJ portrait), each DJ's own character at the decks (`sprites/deck-*.webp`), bodyguards hold the door, patrol, and walk escorted/fighting guests out.
- Audio (Web Audio, no generated media): DJ tracks from `apps/web/public/audio/<dj>.mp3` + `house.mp3` (user-made, see Suno prompts); missing tracks fall back to a synthesized beat; venue pulse follows the live kick (bass-band flux); synthesized cash/alert SFX; mute [M], muffled when paused. Tracks present: kalu, sable, jax (papi-jarang-pulang), rhea (shakalaka-boom), nova (dj-main-serong), landing (starts on first click/key; one continuous lounge track: landing → office muffled → club before the DJ → report muffled).
- Venue is 3D (three.js, `apps/web/src/venue/scene3d.ts`): drag rotate, right-drag/arrows pan, wheel zoom, walls cut away toward the camera, liquor cabinet + fridge behind every bar. Mid-night Office (O / button): clock waits, `nightPromote` adds extra guests for the rest of the night; Talent/Build are day-only.
- Wall screens: slots per layout (`layouts.ts` → `screens`: portrait / landscape / ad), clips from `apps/web/public/screens/playlist.json` (user-supplied mp4s, cover-cropped, rotating); empty lists show a beat visualizer / 'your brand here' ad placeholder. Main screen plays landscape clips between DJ sets.
- Wall screens are all landscape now (clip / ad slots); dancer clips play only at peak hours (00:00–03:00 with a DJ on, `isPeakTime`), per Settings. The landing track never plays inside the club (house warm-up → DJ).
- Settings (`apps/web/src/settings.ts`): volume, music outside / inside the club, SFX, clips (peak / always / off), ads, cutscene.
- Club strategy (2026-09-30, `rules/strategy.ts`, numbers in `data/strategy.json`), all from Level 3:
  - Guests have a gender. House rules (by day): ladies' night (women free, more women and a bigger crowd, men spend more) and dress code none/smart/strict (turns some away, fewer come, bigger budgets, more premium guests).
  - New staff: host (fuller-looking room, men spend more and buy them drinks), guest relations (satisfaction, upsell, table reservations = bottle service revenue), MC. Their wages scale with the level's price scale.
  - Crowd energy 0–100 each minute (dancing share + fullness + active moves): drives dancing, bar spend and satisfaction; a flat room with unhappy guests empties early.
  - Crowd moves at night with cooldowns and fatigue: MC hype, hosts to the floor (best on an empty floor), DJ anthem (once a night, extends stays, stronger when the DJ matches the crowd).
  - Men buy rounds for women and hosts (extra sales). Night Report shows energy, rounds, tables, dress-code rejections and moves used.
  - Balance: a bot that ignores all of this still hits Level 2/3/4/5 ≈ day 17/28/43/56 (unchanged curve); each strategy nets roughly +20k to +90k per night at Level 4, all combined about +290k.
- More strategy (2026-09-30): cover price set by the player (cheaper door = more but thriftier guests), scheduled happy hour (early: arrive sooner and stay; late: stay till close), promoters with guest lists (`data/promoters.json`: early crowd, no cover, commission per head), sound system and lighting tiers (energy + satisfaction, reset with a new venue), sparkler parade (bottle service show: copycat tables order bottles, partly impulse spend), encore (a buzzing room keeps guests past their planned leave time). Balance at Level 4: standard cover is near the sweet spot (2× cover ≈ −63k/night); promoters ≈ +30–40k net; full rig ≈ +31k/night (≈ 9-night payback).
- Staff cards for host / guest relations / MC / promoter are composed in code from the existing character sprites (`art/staff-*.jpg`), no generated media.
- Sandbox (landing menu): starts at the Premium Venue (Level 5) with 20M Coin, all permits, full crew and stock; no win or game over (`createSandbox`, `scenarios.json` → sandbox).
- Layouts (2026-09-30): the Nightclub (Level 4) is 20×15 with VIP booths either side of the DJ and a front VIP row facing it, high tables round the floor, plain tables on edges/corners, stools along the bar. The Premium Venue (Level 5) is its own superclub/beach club (30×26): VIP balconies on a second level either side of the DJ, bars on both walls, an open-air pool deck with cabanas facing the sea. Capacity 500, 24 tables.
- VIP lounge is built in Office → Build (Level 4+): up to 4 (club) / 10 (superclub) VIP tables a night at 3× a table's minimum spend, booked by Guest Relations; until built the area is roped off and says where to build it.
- Staff wages are flat and ordered bartender < security < host < guest relations < MC < DJ; promoter commission flat per head.
- Venue capacity (+15%/tier) and stock room (+50%/tier; orders past it fail) are upgradable with Coin in Build; storage per level in `levels.json`.
- Superclub hall walls are 8 m (per-layout `wallHeight`) with a 12 m concert screen behind the DJ (`mainScreen`).
- Stage pyro (`venue/effects.ts`): flame jets beside the stage and ceiling CO₂/mist cannons, fired on the DJ's detected kick (fire every 8 kicks, 4 at peak hours, 2 during the anthem; mist every 16 / 8).
- Not built yet: performers/bands.
