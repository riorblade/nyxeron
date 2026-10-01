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
- Audio (Web Audio, no generated media): DJ tracks from `apps/web/public/audio/<dj>.mp3` + `house.mp3` (user-made, see Suno prompts); missing tracks fall back to a synthesized beat; venue pulse follows the live kick (bass-band flux); synthesized cash/alert SFX; mute [M], muffled when paused. Tracks present: jax (papi-jarang-pulang), rhea (shakalaka-boom), nova (dj-main-serong), landing (kalu / sable removed 2026-09-30; those DJs play from the crate) (starts on first click/key; one continuous lounge track: landing → office muffled → club before the DJ → report muffled).
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
- Staff cards for host / guest relations / MC / promoter are composed in code from the existing character sprites (`art/staff-*.webp`), no generated media.
- Sandbox (landing menu): starts at the Premium Venue (Level 5) with 20M Coin, all permits, full crew and stock; no win or game over (`createSandbox`, `scenarios.json` → sandbox).
- Layouts (2026-09-30): the Nightclub (Level 4) is 20×15 with VIP booths either side of the DJ and a front VIP row facing it, high tables round the floor, plain tables on edges/corners, stools along the bar. The Premium Venue (Level 5) is its own superclub/beach club (30×26): VIP balconies on a second level either side of the DJ, bars on both walls, an open-air pool deck with cabanas facing the sea. Capacity 500, 24 tables.
- VIP lounge is built in Office → Build (Level 4+): up to 4 (club) / 10 (superclub) VIP tables a night at 3× a table's minimum spend, booked by Guest Relations; until built the area is roped off and says where to build it.
- Staff wages are flat and ordered bartender < security < host < guest relations < MC < DJ; promoter commission flat per head.
- Venue capacity (+15%/tier) and stock room (+50%/tier; orders past it fail) are upgradable with Coin in Build; storage per level in `levels.json`.
- Superclub hall walls are 8 m (per-layout `wallHeight`) with a 12 m concert screen behind the DJ (`mainScreen`).
- Stage pyro (`venue/effects.ts`): flame jets beside the stage and ceiling CO₂/mist cannons, fired on the DJ's detected kick (fire every 8 kicks, 4 at peak hours, 2 during the anthem; mist every 16 / 8).
- DJ sets mix several tracks: the booked DJ opens with their own track (if any), then mixes through the crate (`TRACKS`), rotating to the next track about every 45 s (4 s crossfade) and each turn on a track starts at its next cue point (`TRACKS[...].cues`: Papi Jarang Pulang 0:10 / 1:03, Shakalaka Boom 0:00 / 2:50) or, without cues, resumes where it left off; Now Playing shows the live track; missing files are skipped.
- Pyro follows the music (Web Audio loudness now vs. the last few seconds): bursts when the beat comes back after a break, on every detected drop, fire on the kick through loud lifting parts, nothing in quiet stretches; peak hours and the anthem add more. Without live audio it falls back to counting kicks.
- Clip screens are 3:4 (scaled up on tall walls) and play a live beat-cut "party edit": mostly one clip full-frame with a zoom punch on the kick, now and then a split or a 2×2 grid, a white flash on every cut; a few edits are shared round the room.
- Reservations & minimum spend: seat types VIP / sofa / table / bar seat (counts per level), each with a player-set minimum spend (House Rules; standard × priceScale by default). VIP, sofas and tables are booked by Guest Relations, bar seats fill with walk-ins; a pricier minimum books fewer, a cheaper one more. All pay at 23:30.
- Auto-refill (night HUD): when a drink drops to 15, 50 more from the corner store (if Coin and the stock room allow). Skip to 04:00 asks for confirmation. Drink prices are sliders (50–300% of standard); stock shows "in stock / tonight's forecast".
- Lighting tiers show in the venue (8 → 12 beams, a truss of moving heads, lasers, an LED ring and a strobe); sound tiers too (ground stacks, flown line arrays, a front sub row and delay towers).
- Pyro now uses real footage (FootageCrate, user-supplied): `public/effect/fire|fog-down|fog-floor` as VP9-alpha WebM (Chrome/Firefox) + HEVC-alpha .mov (Safari), converted from the ProRes originals (kept outside the build in `apps/web/assets-src/`, gitignored). Flames along the stage front (lit), on every bar top, round the pool and in the corners (all leaning inward); CO₂ cannons on a 5 m grid across the whole ceiling (two big overlapping clouds each); low fog round every dance floor, the stage front and the pool; a CO₂ burst also hazes the whole room (camera-relative fog) for about a second.
- Security is automatic: each free guard walks the drunkest at-risk guest out and is busy for `escortMinutes` (6); more drunk guests than free guards = they wait (fight risk) and the HUD warns "security stretched" (logged once a night). No manual escort button any more.
- Clean view: H (or the eye button in the top bar) hides the whole night HUD to just watch the venue; a small "Show UI · H" button brings it back.
- Performance pass (2026-09-30):
  - Assets: art/posters to WebP (1.9 MB → 0.76 MB), wall clips to 432×768 muted H.264 (14 MB → 7.7 MB), intro to 1600×900 (4.1 → 3.0 MB), kalu/sable/DJ Main Serong to 128 kbps without cover art. The landing hero stays all-intra (scroll scrubbing).
  - JS: the night screen (three.js + venue) is a lazy chunk, prefetched from the office along with the cutscene; the first load is 429 KB (136 KB gzip) instead of 1.08 MB.
  - Venue: furniture merged into one mesh per material outside the layout editor, all floor shadows in one instanced mesh, drunk markers created on demand with shared materials, a fixed share of guests drawn (~150 at full capacity; the sim still counts everyone), pixel ratio capped at 1.5 with a drop to 1 when frames sag, rendering paused while the office covers the venue, fewer flame lights. Superclub at max tiers: 1,527 → 381 draw calls, 2.6 → 0.7 ms render CPU per frame.
- Cinematic camera (C or the clapperboard button): drone-style shots in shuffled order, ~9 s each, cut like an edit: wide orbit, a crane reveal up out of the crowd, a screen hero shot framing the whole concert screen and the DJ, a banking flythrough from the door over the crowd to the stage, a rising orbit round the DJ, a top-down drop, a low crowd skim, and a pool fly-over (superclub) or a bar dolly; a small zoom kick on the beat. Any click, drag or wheel hands the camera back.
- Live bands (`data/bands.json`, `bookBand` / `bandSet` / `bandPlaying` in rules/talent.ts, tests): five acts (R&B, house, hip-hop from Level 3; live EDM and techno from Level 4), one a night, booked in the Talent tab (now open from Level 3). Without a DJ the band is the main act 22:30–01:00; with one it opens 22:00–23:00. Genre vs. crowd works like a DJ (dance multiplier) and the band lifts the room's energy. In the venue: drum kit, keys, amp and mic stand on the stage with the band, the concert screen shows the band's poster, the videotron says LIVE ON STAGE; the band plays a set from the crate. Band cards are composed from the character sprites (`art/band-*.webp`).
- **Tokenized-stock pivot (2026-09-30):** guests no longer buy drinks; the club stocks tokenized stocks and baskets (`data/tokens.json`: TSLA, US500, NVDA, BIGT, AISEMI, DIVI, SKHY, SPCX) and guests buy those. A live in-club market (`rules/market.ts`, `strategy.json` → `market`) moves each token's price every minute: a random step sized by volatility, drift with crowd energy, pull back to list, and pumps when the DJ starts and during the anthem. FOMO (price above its average) raises the chance to buy. Guests feel their P&L: gains lift satisfaction, losses sour it and add tilt (tilt replaces "drunk"; tilted guests start fights and get escorted). The sale price = list × market. Balance (20 runs): Level 2/3/4/5 ≈ day 16/26/41/51, 80% victory.
  - UI: token detail card with a live chart and basket weights (Portir baskets), a ticker tape on the night HUD, a live token board behind every bar (replaces the liquor cabinet), and a "Top movers" videotron slide. Art: Portir stock logos and basket images → `public/art/token-*.webp`; issuer logos in `public/logos`.
  - On-chain (BNB Chain, via xStocks / Ondo / bStocks) comes later; P6 below still describes the old Monad plan and needs rewriting before starting it.
- **Two roles, multiplayer direction (2026-09-30):** Landing → **Dashboard** (profile name, guest wallet, party record, your CEO club) → **Enter game** → pick a role.
  - **CEO:** the existing game (continue, new career, The Basement, sandbox, load).
  - **Guest:** join a live event (`scenarios.json` → `events`), pay the door from the wallet, buy tokens at the desk at the live price (`rules/visitor.ts`, buy-only: guests keep what they buy), leave or stay till 04:00; the cash left returns to the wallet and the tokens join the Dashboard portfolio (`apps/web/src/profile.ts`, localStorage, play money).
  - Events are run by an **AI CEO** for now (`rules/autoCeo.ts`: `aiPrepare` is the same brain as the balance bot; `createEvent` opens the doors). A guest's buys are the club's bar revenue, and sells are paid out of it.
  - Next for real multiplayer: a CEO player hosts a live night (host-authoritative, the host's client runs `tickNight` and broadcasts the night), guests send buy/sell intents, and the host applies them with `visitorBuy`/`visitorSell`. Needs a realtime backend (not chosen yet). Wallet and on-chain rewards stay server-validated (never trust the client).
- **Real spot prices + revenue share (2026-09-30):**
  - Spot prices come from Binance Web3 RWA Data (`/build/api/v1/dex/market/rwa/tokens?binanceChainId=56`), fetched server-side by `apps/web/server/quotes.ts` (HMAC-SHA256 signed; keys in `apps/web/.env.local`, see `.env.example`) and served as `GET /api/quotes` by a Vite middleware (dev + preview; deploy needs the same handler as a serverless function). No key or offline = game prices.
  - Core `rules/quotes.ts`: the CEO's lot cost = usual cost × (spot now / spot when the club first saw it), per token (baskets = weighted legs, `tokens.json` → `legs`). The standard sale price follows spot too. The CEO sets the sale price (their markup). On every sale the platform takes `strategy.json` → `platform.feeShare` of the spread over spot (shown in the Night Report).
  - Balance: feeShare 0.05 keeps the curve (90% victory, Level 5 ≈ day 56). 0.1 → 30%, 0.2 → 0% unless the economy is retuned.
  - Guest avatar: pick one of the 10 guest sprites on the Dashboard (1–5 men, 6–10 women); on guest nights it dances on the floor with a YOU tag and walks to the token desk after each trade.
- Stage pyro has two modes (CEO night panel, Level 4+, saved in Settings): **Auto** fires on the DJ's beat and drops; **Manual** fires only on the Fire / Fog / Both buttons (keys F / G / B).
- **DJ Studio (2026-09-30, `apps/web/src/dj/`):** a third role on the Dashboard (DJ, practice room) and **Take the decks** in the CEO's night view (live: the studio takes the room from the club music via `audio.takeOver()`, and the venue's lights, LED floor and pyro follow the mix).
  - Decks (`deck.ts`): play/pause, CDJ cue, 4 hot cues, auto loops 1/2/4/8 beats, beat jump ±4, pitch fader ±16% / ±50%, SYNC (tempo + beat phase, half/double time when needed), nudge, reverse, vinyl brake, backspin/rewind, scratch on the platter (drag round either way), BPM ×2/÷2 correction. BPM and first beat detected on load (`analyze.ts`, tested).
  - Mixer: gain, 3-band EQ with kill, one-knob filter (low-pass ↔ high-pass), echo (¾-beat, tempo-synced) and reverb sends, channel faders, equal-power crossfader, meters.
  - Sampler (`sampler.ts`, synthesized, no files): air horn, siren, riser, downlifter, impact, sub drop, laser, snare roll (keys 1–8).
  - Crate: the club tracks, plus any audio file the DJ brings.
  - **Planned sets** (Studio → Sets, `dj/transitions.ts`, `autodj.ts`, `sets.ts`): tracks in order, each with a start cue and length in bars, and the move into the next one (fade, cut, bass swap, filter, echo out, backspin; 4–32 beats) plus a pad on the drop (build-ups start a bar early). The Auto DJ runs it on the outgoing track's beat grid and loops. Blends beat-match only within 8% tempo; the planner warns when a blend would clash and suggests cut / echo / backspin. Preview in the studio; tick **Play at my club tonight** (or pick it in Office → Talent) and it plays from the DJ slot (23:00, `night.json` → djSetStartMinute). Taking the decks during it shows the AUTO line and lets the CEO ride the mix live. Sets and per-track BPM fixes are saved on the device (uploaded tracks are live-only).
  - Not yet: booking another player as the DJ (needs multiplayer), and the crowd reacting to the player's mixing in the sim.
- **DJ gigs (2026-09-30):** Dashboard → DJ shows the studio (practice) and **gig invites** from the AI-run clubs that have a DJ booth (`scenarios.json` → events → `djFee`). Accepting opens the night at the DJ slot (`createGig`: the AI CEO's event fast-forwarded to 23:00) with the player's avatar and name at the decks (the scene's `setGuestDj`), the studio live over the club (collapsible; the decks keep playing), energy / crowd / time left, and pause. At 04:00 the fee goes to the wallet (`profile.payGig`); leaving early pays nothing. The set runs at 2 s per in-game minute (~10 min real time). The sim keeps its booked DJ for the crowd maths.
- **CEO sampler (2026-09-30):** the CEO's night panel (Level 4+) has the 8 sampler pads under Pyro (Shift+1…8). They play through the club's audio chain over the resident DJ's music (`audio.pad`), sized to the club's tempo estimated from the detected kicks (`audio.bpm`, default 124).
- **Servers (2026-09-30, `services/`, `deploy/`):** three separate containers on one VPS (Hostinger, Docker Compose), only the edge public.
  - `relay` (Go, `scratch` image ~9 MB): multiplayer connector only. Rooms with a host (the CEO's browser runs the sim) and up to 64 guests/DJs. It routes opaque binary frames by a 3-byte header (state = latest-wins snapshot to all, event = reliable to all, to = one player, from = player → host, sender stamped by the relay) and small JSON control messages (create/resume/join/kick). Host reconnect within 60 s keeps the room. Per-connection rate limits, frame size caps, bounded queues (a slow client never grows memory; a busy host answers players `host_busy`). Load test 10 rooms × 30 players, 2 KB snapshots at 10 Hz: 100% delivered, ~24 MB RAM.
  - `api` (Go): spot quotes (Binance RWA, signed server-side; replaces the old Vite middleware). Later: accounts, wallet, validated rewards.
  - `edge` (Caddy): automatic HTTPS, zstd/gzip, static game with correct caching (hashed assets immutable, app shell no-cache, media 1 day), proxies `/ws` and `/api`.
  - Web client: `apps/web/src/net/relay.ts` (frames, JSON pack/unpack, host resume, reconnect with backoff). Not wired into the game screens yet: next is the CEO hosting a live night and guests/DJs joining it.
  - Run: `deploy/README.md`. Go tests: `pnpm test:go`.
- **Deployed (2026-09-30):** VPS `201.18.211.8` (shared with portir and matocard), code in `/opt/nyxeron` (sent with `git archive HEAD | ssh … tar -x`, `deploy/.env` copied separately, chmod 600), running `compose.yml` + `compose.behind-proxy.yml`. Portir's Caddy (`deploy-caddy-1`, holds 80/443) forwards `nyxeron.xyz` to `nyxeron-edge:80` (block added to `/opt/portir/apps/portiragent/deploy/Caddyfile` and to the portir repo; backup `Caddyfile.bak-20260930-104643`). Live Binance quotes work from the VPS (448 tickers, all 20 the game uses). Live at **https://nyxeron.xyz** since 2026-09-30 (Let's Encrypt via portir's Caddy; `www.` redirects to the apex). Verified from the internet: HTTP/2 + zstd, landing in ~0.3 s, live quotes, guest buy, relay 100% delivered over `wss://nyxeron.xyz/ws`, foreign origins refused (403); portir's agent unaffected. Update: `git archive HEAD | ssh root@201.18.211.8 'tar -x -C /opt/nyxeron'` then `docker compose -f deploy/compose.yml -f deploy/compose.behind-proxy.yml up -d --build` in `/opt/nyxeron`. Local dev can't reach Binance on an Indonesian ISP (blocked by Internet Positif) unless WARP is on.
- **Live multiplayer, stage 1 (2026-10-01): CEO hosts, guests join.** In the night panel the CEO opens the club to players (room code + invite link `/?join=CODE`, player list, kick, close). Guests join from Dashboard → Guest → "Join a live club" (or the link). The CEO's browser is the host (`apps/web/src/net/session.ts`): it applies players' input to its sim (`visitorJoin/visitorBuy/visitorLeave`, core now keeps `night.visitors` by player id) and broadcasts gzipped snapshots (`net/codec.ts`, ≤4/s). Guests render those (`screens/LiveGuest.tsx` → `GuestNight` in online mode): same club, their buys go into the CEO's takings, every player's avatar and name in the venue ("YOU" for yourself). By day guests wait at the door and walk in when the CEO opens the club. Wallets are the client's word for now (play money). Next: stage 2, a player DJ live in the CEO's club.
- **Live multiplayer, stage 2 (2026-10-01): a player DJ in the CEO's club.** Dashboard → DJ → "Play a live club" (room code) opens `screens/LiveDj.tsx`: the club from the host's snapshots, the DJ's avatar at the booth, the studio live (crate tracks only). The mix isn't streamed: the DJ sends its mix state 4×/s (~300 B: track, playhead, tempo, EQ/filter/sends, faders, crossfader, loop, reverse) plus one-shot moves (pads, brake, backspin); the host rebroadcasts them as events and every player's own engine follows (`dj/mixsync.ts`: aims ~0.12 s ahead, seeks only past 0.25 s drift). One DJ per club; while one is live the CEO's own decks and planned set step aside. Tested with three browsers: DJ, CEO and guest on the same track within ~0.1–0.3 s; pause and leave follow. Not yet: the DJ's fee from the CEO, and the crowd reacting to the player's mix in the sim.
- **Hosting (2026-10-01):** frontend on **Vercel** (project `nyxeron`, `https://nyxeron.xyz`, `www` too; `vercel deploy --prod`). Backend on the VPS at **`api.nyxeron.xyz`** (`/ws` relay, `/api/*` api) behind the shared portir Caddy; only `relay` (~4 MB) and `api` (~5 MB) run there (`deploy/compose.backend.yml`), the old edge container is gone. Relay origins and API CORS allow `nyxeron.xyz` and `nyxeron.vercel.app` (`FRONTEND_EXTRA_HOST`). Backend update: `git archive HEAD | ssh root@201.18.211.8 'tar -x -C /opt/nyxeron'` then `docker compose -f deploy/compose.yml -f deploy/compose.backend.yml up -d --build relay api` in `/opt/nyxeron`. Verified end to end on nyxeron.xyz: CEO opens a room, a guest joins and buys, live Binance prices from the browser.
- **Accounts (2026-10-01): Privy, email or Google only** (every player has an email), embedded EVM wallet on BNB Chain created at first sign-in. Everything past the landing page goes through `apps/web/src/auth/AuthShell.tsx` (lazy, so the landing page stays light; without `VITE_PRIVY_APP_ID` dev runs signed-out). Per-player storage: profile, saves and DJ sets live under `nyxeron:u:<privy id>:…` (`auth/account.ts`; data saved before sign-in goes once to the first player who signs in on that device). Dashboard shows email, wallet (copy) and Sign out. Server: `GET /api/me` (api service) verifies the Privy access token itself (ES256 against the app's JWKS, iss/aud/exp; stdlib only, tested incl. forged and `alg: none` tokens) and returns the verified id, email and embedded wallet (Privy REST with the app secret, cached 5 min). Next: send the verified identity with multiplayer joins and use it for wallets/rewards.
