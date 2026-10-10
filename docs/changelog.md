# Changelog

What shipped, newest first, with the numbers behind decisions. Add a line for anything a player, admin or
teammate would notice.

## 2026-10-10 · Stock agent: no double buys, reports that survive, a price floor

- **One swap at a time:** the agent records the swap it placed (`AGENT_STATE`) until the api has counted it; a run
  that ends early (order still pending, api down) is finished by the next run instead of a second purchase.
- **Reports retry** 5xx/network errors with backoff for up to 10 minutes; `pnpm agent --token tsla --report <tx>`
  counts a done swap without trading.
- **Price floor:** a quote more than 5 % per share above the api's spot price (`GET /api/quotes`), or with no fresh
  spot price, is refused (`payments.json` → `agent.maxPriceOverSpotPercent`, `agent.spotMaxAgeMinutes`).
- **Fails closed:** a missing `paused` flag or a missing/negative daily spend from the api stops the buy;
  `NYXERON_API` must be https (http only for localhost). Part of #55.
- **No double spend after review:** one `--buy`/`--report` run at a time (a run lock, never taken over when left
  behind); a FINISHED order without a tx hash keeps being followed instead of being dropped; the daily spend is
  re-read after the swap's slot is taken; a 200 counts only when it names this tx and numeric units; spot prices
  dated more than a minute ahead are refused; so are quotes more than 20 % under spot
  (`agent.maxPriceUnderSpotPercent`) or for a non-finite amount. In production, `AGENT_STATE` goes outside the repo
  (`deploy/README.md`).
- **Second review:** `--buy` and `--report` refuse to run without `AGENT_STATE` (a run on another path saw no
  record and no lock, and could buy again); a malformed wallet answer is an error that releases the run lock
  (it also goes on any exit and on SIGHUP); the quote must be for exactly the budget into the locked token; the
  record is fsynced before the swap; wallet calls time out after 90 s and api requests after 30 s.

## 2026-10-10 · Tougher sim: closed doors stay closed

- **Cover you can't pay = you go home:** a guest whose budget is below the cover is turned away instead of handing
  over the whole wallet. A huge cover now empties the club rather than out-earning a stocked bar. Balance moves a
  hair (only the poorest Level 5 locals are below the standard 2,500 cover).
- **Price ceiling:** a list price can be at most 100× the venue's default (`economy.json → maxPriceMultiple`); a
  huge price used to turn into Infinity after moving up and break the save. Old saves with a broken price load with
  a valid one.
- **After closing time** guest players can't walk in or buy (and not in a sealed venue), and the door can't be
  forced after 04:00. Once a career is over, nothing spends Coin or moves stock.
- **Moving up** never overfills the new stock room: what doesn't fit (old storage tiers stay behind) is left behind, and the office feed
  says how much of each token stayed (`stockTrimmed` event).
- Unknown ids, a bad dress code / happy-hour slot, or a NaN avatar are refused cleanly instead of writing NaN or
  bricking every later night; the AI CEO no longer hangs when handed a night. A house-rules change that leaves a
  field undefined keeps that rule, and an old save with a broken house rule loads with the default for that rule.
- **Tests:** `pnpm test` runs a smoke-sized fuzz of the sim (a few seconds); `pnpm test:brutal` runs the full
  hostile fuzz (80 seeds × 350 steps + 30 hostile-id runs, about a minute) and CI runs both.

## 2026-10-10 · Every real swap goes on the books

- **No more pauses from a swap the api refused:** a swap of less than one unit (0.001 share), or one bought while
  units were already short on chain, used to be refused after the USDC had left the Agentic Wallet, so the next
  hourly check paused payments for every player. Now any verified swap is booked once: the USDC always, and the
  whole units it bought. Fractions of a unit are carried per token and booked once they add up to a unit.
- **A missing unit still stops payments:** if the wallet holds fewer units than the books count when the agent
  reports a swap, the swap is booked but payments pause at once and the reconciliation keeps flagging the missing
  units until the team writes them off. An admin reporting the swap writes them off in the same step, as an
  explicit `loss` stock move with its reason, audited.
- **One tx, one booking:** a tx booked as a restock can't also be booked as the team's seed, or the other way round.
  A tx in which the Agentic Wallet sent anything out is never accepted as the seed, and neither is a player's
  transfer, even a rejected one (#38).
- **Multi-token swaps:** a swap that bought two whitelisted bStocks adds both in one report.

## 2026-10-10 · A clear message when the 3D club can't start

- **No WebGL, no silent failure:** on a browser without WebGL (hardware acceleration off, some VMs and work
  laptops) the venue now says the 3D club needs WebGL and that the night still runs on the panels, instead of an
  empty room and an uncaught error. The night, guests, report and next day were already unaffected.

## 2026-10-10 · Top-up reports can't drain the chain quota

- **Bounded RPC cost per player:** reporting made-up transaction hashes to the top-up endpoint used to cost two paid
  BNB Chain lookups each, from the same quota top-ups, the scanner and reconciliation need. Each player now gets 20
  such misses per 10 minutes (then `429 too_many_misses`; the scanner still credits a real transfer), and a refused
  hash (`tx_failed`, `not_a_topup`) is answered again from memory. Anything that isn't shown to be the player's own
  transfer counts, including someone else's transaction still confirming, an unreadable (oversized) receipt and RPC
  errors. A real top-up that's still confirming can be re-reported as often as before: its transfer is already in
  the receipt.
- **The pace limit no longer resets:** past 10,000 players the per-player limiter forgot everyone at once; it now
  drops only stale entries, at least once per 10 minutes.

## 2026-10-10 · A paid band always plays

- **Booking a DJ at night no longer cancels the band:** a band booked by day plays its slot even if the CEO books a DJ
  during the night. Before, the late DJ moved the band to the opener slot (22:00), which had already passed, so the
  band's fee was spent and it never went on stage. The band's slot is now fixed when the night starts.

## 2026-10-10 · Esc closes the Leave dialog

- **Esc works both ways on guest and gig nights:** Esc opens Leave and Esc again closes it (Stay); on a gig the
  decks' own keys pause while the dialog is up, and Esc with the decks collapsed now opens Leave too.

## 2026-10-10 · Lighter landing page

- **Half the landing download:** the second landing video (the reveal clip) now loads only as you scroll towards it
  instead of with the page, so the first visit fetches about 1.1 MB of media instead of 2.1 MB.

## 2026-10-10 · Private parties stay private; sales check inside the sale

- **A private party sells only to its guests:** buying at a private party, or reading its price list, now needs its
  invite link opened first (the host always can). Public parties are unchanged.
- **An event can't point at a negative venue id** (it was stored as a city party); setting prices at a party with no
  venue is a 404, not a 500.
- **Cancels and evictions win their races:** settlement reads a party's cancelled flag inside its transaction, so an
  admin cancel just before it voids the sales instead of paying them out; a shop buy checks the lease (tenant, open,
  not ended) inside its transaction, so nothing sells after an eviction or a close.
- **A banned tenant's shop and parties sell nothing** (a ban already stopped them changing anything).

## 2026-10-10 · The office comes alive (neon UI)

- **A real game look:** the office is now a neon nightclub instead of black and white: violet glass panels, magenta
  and gold light, coloured icons for every tab and stat, a gold Open Club button over the club's entrance at night,
  illustrated supplier cards (Corner Store, City Wholesale, Harbor Imports), a supply crate for Fill to forecast, a
  reward chest on the objectives, the CEO's portrait on her tips, the booked DJ on Tonight, and new full-colour art
  for all five venues. All art is generated for NYXERON.

## 2026-10-10 · Sign-in that doesn't stall

- **Signing in no longer waits on Privy:** a key refresh runs in the background, one at a time, so a slow Privy (or
  someone sending made-up keys) can't freeze every signed-in request. Keys are refreshed every hour, so a key Privy
  retires stops working; and if Privy blips while the api starts, sign-ins work again within seconds, not a minute.

## 2026-10-10 · No blank screen after an update

- **A tab left open across an update recovers by itself:** if it asks for a part of the game that the new version
  replaced, it reloads once into the new version. Anything else that breaks while drawing a screen now shows "Something
  went wrong" with a Reload button instead of a blank page.

## 2026-10-10 · Relay: signed-in players only

- **Live clubs know who you are:** the api now hands signed-in players a short pass for the multiplayer relay, and the
  relay lets only those in (a suspended account gets none). Limits and kicks follow the account instead of the network,
  so kicking a troll no longer locks out their friend on the same Wi-Fi, and one account can have at most 8 clubs
  open. Joining a live club, even from an invite link, now needs a signed-in account; otherwise the game says it
  couldn't confirm your sign-in.

## 2026-10-10 · Relay: hardened for production

- **One player can no longer take the relay down:** what the relay holds for a client is capped in bytes (256 KB each,
  a shared budget for everyone), so a few clients that stop reading can't push it out of memory. Sockets are capped
  (in total and per IP), and one that doesn't join a room within 10 s is closed. A full server closes the
  longest-abandoned room instead of telling a real CEO "server full", and one network can have at most 8 clubs open,
  abandoned ones included. Guessing room codes is throttled per IP. A guest flooding input can no longer get the host
  dropped, a tab that lost the room to another tab stops fighting for it ("This club is open in another tab."), and a
  kicked player can't rejoin that club from the same network for 10 minutes. Players reconnect with growing, jittered
  waits instead of every 0.5 s in lockstep. Only the edge proxy's word about a player's IP is believed, and IPv6
  players count per /64. Load test: 10 clubs × 30 players, 100% of snapshots delivered, ~31 MB.

## 2026-10-09 · Web: a lighter first load

- **Landing loads without three.js:** the save sync imported the furniture storage key from the 3D venue module, so
  the venue chunk (three.js) was preloaded on every first visit. The key now lives in `state/scope.ts`; the first
  load's JavaScript drops from 787 KB to 566 KB (243 KB → 184 KB gzip, −24%) and three.js arrives with the night.

## 2026-10-09 · Multiplayer: reconnects that hold

- **Live clubs survive a bad connection:** a guest whose connection drops says hello again and gets their own seat
  back (cash and tokens; the host keeps it a minute), a reconnecting DJ is back on the decks even before the relay
  notices the old connection died, and a host back after more than 60 s reopens the room with the same code (for an
  hour) instead of a silent new one. **Kick** isn't undone by the auto-reconnect (the player can still rejoin by hand;
  it isn't a ban), **Close room** tells guests at once instead of "lost connection" for a minute, a guest whose club
  closes, who is kicked, or who comes back after their seat was let go still takes their cash and tokens home exactly
  once (Nights out counts), and an event goes live with the room as soon as it's on even if the CEO opened the club
  earlier. Server and City errors (server full, City closed, suspended, sign-in expired…) read as sentences.

## 2026-10-09 · CEO: rules that couldn't be gamed or trap you

- **Staff by day only:** hiring and firing are daytime actions, so a bouncer hired for one night and fired at 04:00
  no longer skips the wage. **Booking a DJ** stops once the set slot (minute 60) has passed, instead of charging a fee
  for a DJ who never plays. **Moving up** and the **controversial promo** are daytime only.
- **No more day-one loss from the stunt:** the controversial promo needs more than 20 rep, so one backfire can't end a
  fresh club (it starts at 20). Its price shows NP, not "C".
- **Empty bar:** a guest who found nothing in stock stops queueing instead of losing satisfaction every minute; an idle
  club no longer dies by Day 4. Leaving guests now free their spot for the fight ratio.
- **Move-up arbitrage closed:** stock moves to the new venue at its value (count × old price scale ÷ new), so buying
  cheap before moving up and selling at the new venue's prices (up to 4×) is gone. `pnpm balance 300`: still 100%
  victory, Level 2/3/4/5 at day 17.0/28.1/37.0/46.4 (was 17.0/27.7/35.2/43.9).

## 2026-10-08 · CEO: play on

- **Keep playing instead of a dead end:** a club that won or survived (The Basement after Day 7, a career at Level 5
  / Day 60) used to stop on the result screen for good. The result screen now has **Keep playing**: the club goes on
  to the next day as an ordinary club with no end date (its card reads "Day N", not "of 60", and keeps its Won /
  Finished tag). A survived club can still win at Level 5 with Rep 80. Defeat is still final. The Basement's late
  supplier now lasts its one day instead of the rest of the game.

## 2026-10-08 · The city runs on Credit (on-chain cutover)

- **Rent in Credit:** venue rent is paid in Credit at new, low weekly prices (`payments.json → rentCredits`:
  Level 1 100 · Level 2 200 · Level 3 500 · Level 4 1,000 · Level 5 2,000 Credit; the back office's rent table
  sets them). Coin-era prices would have made a Level 3 party venue cost $200 a week against a $100 top-up cap.
  Leases paid in Coin run to their end date; extending them costs Credit.
- **The Coin shop is closed:** shops are Credit menus over the warehouse (tokens by venue level). What CEOs still
  held on their Coin shelves was bought back in NYX Points at their own shelf price (migration 6, one ledger row
  `buyback` per player). A city party no longer pays its host Coin from guests' play nights.
- **Warehouse:** only units bought by swaps verified on BNB Chain remain; the 100 hand-typed units per token from
  2026-10-02 were removed by migration 6 (each removal is a stock move by `cutover`).
- **Back office:** Payments (hourly reconciliation, top-ups, unknown transfers, sales, seed); rent shown in Credit
  (rent is booked as the platform's money); Stock shows units sold to players instead of CEO shelves.

## 2026-10-08 · Top-ups

- **Top up Credit:** players send USDC from their game wallet to the platform's Agentic Wallet (no gas, 1% fee) and
  get Credit (100 = $1) once BNB Chain confirms it. Minimum $3; at most $20 a day and $100 in all during the
  hackathon. The api enforces the caps: it credits up to the room left and records the rest for a refund.

## 2026-10-08 · Real stock at parties and shops

- **Buy real stock with Credit:** at a live city party or an open shop, guests buy real tokenized stock (units of
  0.001 share) at the CEO's Credit price; the CEO keeps the margin over the live wholesale price, the platform gets
  wholesale. A party's sales are held while it runs and settle when it ends. Every buy carries the price the guest
  saw (`maxPrice`) and a guest buys one at a time.
- **Events can't be cancelled once they start** (guests may have bought); only an admin voids a sale.

## 2026-10-03 · CEO: your clubs

- **Classic and City (owner decision):** the play currency is now **NYX Points (NP)** everywhere (was "Coin" / C);
  practice clubs are **Classic** clubs, which always start at Level 1 (the Basement shortcut is gone; level grants
  from the back office stay for development). The **City** runs on Credit (real money) with real guests only, so it
  is **shut until top-ups are live**: the api answers 403 `city_closed` to every city write and city party
  (`CITY_OPEN=1` opens it, `GET /api/city` reports `open`), and the dashboard shows "City · coming soon".
- **Rented venue, one button:** the venue page is the venue's picture, its name and one big **Enter club** (a public
  party starting this minute, straight into the club in 3D; Level 1–2 venues say parties open at Level 3). Rent left,
  Extend (a button only in the last two days) and Schedule sit in one quiet line. The shop is one line with an
  on/off switch; Manage opens the shelf (only what's on it, a price and Restock +10 each, "+ Add a stock" for more).
  The first stock opens a closed shop by itself. On the CEO list, city venues have a Manage button and practice clubs
  are tagged "Practice · solo".
- **Follow us on X:** a "Follow on 𝕏" link on the landing page and a "Follow @nyxeron_xyz" button in the dashboard
  header (the only outbound link in the client). Link previews (Open Graph / X card) show the Premium Venue.
- **Tab icon everywhere:** PNG and ICO favicons next to the SVG (Safari and old caches showed the default icon);
  titles read "NYXERON · Nightclub Empire"; the landing footer reads "©2026 NYXERON".
- **X account:** [@nyxeron_xyz](https://x.com/nyxeron_xyz) with the Nightclub Empire bio (`docs/brand.md`).
- **Brand identity:** the NYXERON mark (the VIP diamond, no letters), app icons and favicons for the game and the
  back office, an X profile picture and an X header rendered from the Premium Venue (`docs/brand.md`).
- **Back office: venues per level.** Venues → "Venues per level" sets how many venues each level has, next to its
  weekly rent, in one save with a reason (audited). A level can't go below its highest rented venue; new venues can
  be rented at once and the game's rent list follows.
- **Events with invites:** CEOs schedule events at any club (Office → Events, or Events on a club card, or the city
  venue page): date and time picker, length (default 10 min), Public or Private. Every event has an invite link
  (`/?event=…`); guests mark "I'm going" and get a "… is live: Join now" banner once the host opens the club.
  A private event (or the host's Invite only switch) keeps the club off the public list. The Basement can host too.
  api migration 4 (events on any club, invites, RSVPs).
- **One show for the whole room:** every pyro burst in the CEO's club (auto on the beat, or the manual Fire / Fog /
  Both buttons), every sampler pad and the videotron messages now reach every guest and the live DJ at the same
  moment. Guests no longer run pyro of their own while in someone's club.
- **Guests find clubs:** a club is open to players while its CEO is in it (no button needed) and is listed under
  "Clubs open now" for guests (club, venue, host, players inside, join in one click). Fixes: a CEO's club never
  showed up for guests.
- **CEO home is one list of the clubs you run:** rented city venues (several allowed, up to 5) and offline practice
  clubs (up to 4, each in its own save slot, saved after every night and when leaving). Open one, close a practice
  club, rent a new venue or start a practice club; The Basement is a small challenge link.
- Removed: the sandbox (bigger venues are granted from the back office), "Continue", "Load a save" and the pause
  menu's save slots. Old sandbox saves load as normal careers; AI-run events use mode `event`.
- City: each venue is managed on its own (name, shop open/closed, parties); shop stock is shared across a
  player's venues with their storage combined.

## 2026-10-02 · Back office, city, warehouse, clearer HUD, balance

- **Back office Stock page reworked:** an empty warehouse shows a "Fill all tokens" banner; every token row has
  its own Restock (quick amounts, live "→ N in the warehouse" preview, reason prefilled, optional on-chain tx);
  corrections are a checkbox away; plain column names with a legend; the confirmation stays on screen.

- **Back office** (`apps/admin`, admin.nyxeron.xyz): roles owner (`ADMIN_EMAILS`) / admin / viewer, overview KPIs,
  player search and detail (portfolio, saves, coin ledger, admin history), grant/deduct coin, venue access
  (start a career at a bigger venue), ban/unban, rename, clear saves, announcements, audit log. api migration 1
  (identity, ledger, admins, audit, settings).
- **City:** venues rented weekly with account Coin (24/12/6/4/2 per level, 2k–150k a week), renamable; shops sell
  while the tenant is away; parties at Level 3+ (default 10 min) hosted live, guest spend goes to the tenant.
  Back office Venues page (end lease, cancel party, rent table) and rent revenue on the overview. Migration 2.
- **Platform warehouse:** CEOs stock shops from it (sold out = can't stock); back office Stock page (on hand, with
  CEOs, demand, days left, suggested restock, movements); stock agent API (`/api/agent/demand`,
  `/api/agent/restock` with the on-chain tx). Migration 3.
- **HUD:** every top-bar stat opens an explanation (what it is, what it does, how it moves, recent changes from
  the event log). Nightly reputation is logged (`nightRep`).
- **Safety matters:** low safety cuts walk-ins (up to −25% at 0) and under 40 draws inspectors (20% a night).
- **Balance:** security unlocks at Level 3 (was 4; bot careers had ~1 fight a night at the bar); tax tiered
  L3 20% / L4 30% / L5 40% (was a flat 40%). Bot (300 runs): Level 5 ≈ day 44 (was 55), 0 fights at L3, 100%
  victory. Level 3+ clubs without a guard get a "Hire security" objective.
- **Deployed:** api with SQLite (migrations 1–3, volume `nyxeron_api_data`), game on Vercel, back office on
  `admin.nyxeron.xyz` (Vercel project `nyxeron-admin`, root `apps/admin`).
- **Repo:** docs split into `docs/` (PRD, architecture, game design, API, multiplayer, roadmap, changelog), root
  README and CONTRIBUTING, CI on GitHub Actions, web client grouped into `api/`, `state/`, `auth/`, `audio/`,
  `lib/`; `pnpm sync:gamedata`.

## 2026-10-01 · Live multiplayer, accounts, data on the server

- **Live multiplayer, stage 1 (2026-10-01): CEO hosts, guests join.** In the night panel the CEO opens the club to players (room code + invite link `/?join=CODE`, player list, kick, close). Guests join from Dashboard → Guest → "Join a live club" (or the link). The CEO's browser is the host (`apps/web/src/net/session.ts`): it applies players' input to its sim (`visitorJoin/visitorBuy/visitorLeave`, core now keeps `night.visitors` by player id) and broadcasts gzipped snapshots (`net/codec.ts`, ≤4/s). Guests render those (`screens/LiveGuest.tsx` → `GuestNight` in online mode): same club, their buys go into the CEO's takings, every player's avatar and name in the venue ("YOU" for yourself). By day guests wait at the door and walk in when the CEO opens the club. Wallets are the client's word for now (play money). Next: stage 2, a player DJ live in the CEO's club.
- **Live multiplayer, stage 2 (2026-10-01): a player DJ in the CEO's club.** Dashboard → DJ → "Play a live club" (room code) opens `screens/LiveDj.tsx`: the club from the host's snapshots, the DJ's avatar at the booth, the studio live (crate tracks only). The mix isn't streamed: the DJ sends its mix state 4×/s (~300 B: track, playhead, tempo, EQ/filter/sends, faders, crossfader, loop, reverse) plus one-shot moves (pads, brake, backspin); the host rebroadcasts them as events and every player's own engine follows (`dj/mixsync.ts`: aims ~0.12 s ahead, seeks only past 0.25 s drift). One DJ per club; while one is live the CEO's own decks and planned set step aside. Tested with three browsers: DJ, CEO and guest on the same track within ~0.1–0.3 s; pause and leave follow. Not yet: the DJ's fee from the CEO, and the crowd reacting to the player's mix in the sim.
- **Hosting (2026-10-01):** frontend on **Vercel** (project `nyxeron`, `https://nyxeron.xyz`, `www` too; `vercel deploy --prod`). Backend on the VPS at **`api.nyxeron.xyz`** (`/ws` relay, `/api/*` api) behind the shared portir Caddy; only `relay` (~4 MB) and `api` (~5 MB) run there (`deploy/compose.backend.yml`), the old edge container is gone. Relay origins and API CORS allow `nyxeron.xyz` and `nyxeron.vercel.app` (`FRONTEND_EXTRA_HOST`). Backend update: `git archive HEAD | ssh root@201.18.211.8 'tar -x -C /opt/nyxeron'` then `docker compose -f deploy/compose.yml -f deploy/compose.backend.yml up -d --build relay api` in `/opt/nyxeron`. Verified end to end on nyxeron.xyz: CEO opens a room, a guest joins and buys, live Binance prices from the browser.
- **Accounts (2026-10-01): Privy, email or Google only** (every player has an email), embedded EVM wallet on BNB Chain created at first sign-in. Everything past the landing page goes through `apps/web/src/auth/AuthShell.tsx` (lazy, so the landing page stays light; without `VITE_PRIVY_APP_ID` dev runs signed-out). Per-player storage: profile, saves and DJ sets live under `nyxeron:u:<privy id>:…` (`auth/account.ts`; data saved before sign-in goes once to the first player who signs in on that device). Dashboard shows email, wallet (copy) and Sign out. Server: `GET /api/me` (api service) verifies the Privy access token itself (ES256 against the app's JWKS, iss/aud/exp; stdlib only, tested incl. forged and `alg: none` tokens) and returns the verified id, email and embedded wallet (Privy REST with the app secret, cached 5 min). Next: send the verified identity with multiplayer joins and use it for wallets/rewards.
- **Sign-in live (2026-10-01):** nyxeron.xyz requires a Privy account (email or Google) past the landing page; the api on `api.nyxeron.xyz` verifies every sign-in (`/api/me`, Dashboard badge "✓ verified"). Checked with a real account: email, embedded BNB Chain wallet and the device's earlier data carried over. Privy app is still in development mode (user cap): switch it to production in the Privy dashboard before opening to the public.
- **All account data on the server (2026-10-01):** besides the profile, the api keeps per-player documents (`/api/docs/{kind}/{slot}`, gzipped in SQLite): CEO career saves (auto + 3 slots), planned DJ sets, venue furniture layouts and videotron messages; each kind has whitelisted slots, a size cap and a shape check. The browser keeps a per-account cache (`apps/web/src/scope.ts`: every account-owned key is scoped; layouts and shoutouts were device-wide before), merges at sign-in (`auth/docs.ts`: saves newest-wins by savedAt, the rest server-wins, device copies go up if the server has none) and sends every change as it happens. Device preferences (volume, music, clips, intro) stay in the browser on purpose.
- **Data audit (2026-10-01):** `packages/core/test/persistence.test.ts`: over 60-day careers every visible number stays valid (no NaN; stock never negative or above storage; level, rep, hype, safety, prices, upgrades and staff in range); save → load gives the identical game (by day and mid-night) and it plays on identically; old saves (before upgrades, house rules, the market, multiplayer) load and play. Found and fixed: a 60-day save had grown to 452 KB (the finished night's guest list + an unbounded event log); saves are now compact (`compactForSave`: no finished night, last 7 days of log) and stay under 40 KB, with a test that the game continues exactly the same from a compact save.

## 2026-09-30 · Tokenized stocks, roles, DJ studio, servers

- Audio (Web Audio, no generated media): DJ tracks from `apps/web/public/audio/<dj>.mp3` + `house.mp3` (user-made, see Suno prompts); missing tracks fall back to a synthesized beat; venue pulse follows the live kick (bass-band flux); synthesized cash/alert SFX; mute [M], muffled when paused. Tracks present: jax (papi-jarang-pulang), rhea (shakalaka-boom), nova (dj-main-serong), landing (kalu / sable removed 2026-09-30; those DJs play from the crate) (starts on first click/key; one continuous lounge track: landing → office muffled → club before the DJ → report muffled).
- Club strategy (2026-09-30, `rules/strategy.ts`, numbers in `data/strategy.json`), all from Level 3:
  - Guests have a gender. House rules (by day): ladies' night (women free, more women and a bigger crowd, men spend more) and dress code none/smart/strict (turns some away, fewer come, bigger budgets, more premium guests).
  - New staff: host (fuller-looking room, men spend more and buy them drinks), guest relations (satisfaction, upsell, table reservations = bottle service revenue), MC. Their wages scale with the level's price scale.
  - Crowd energy 0–100 each minute (dancing share + fullness + active moves): drives dancing, bar spend and satisfaction; a flat room with unhappy guests empties early.
  - Crowd moves at night with cooldowns and fatigue: MC hype, hosts to the floor (best on an empty floor), DJ anthem (once a night, extends stays, stronger when the DJ matches the crowd).
  - Men buy rounds for women and hosts (extra sales). Night Report shows energy, rounds, tables, dress-code rejections and moves used.
  - Balance: a bot that ignores all of this still hits Level 2/3/4/5 ≈ day 17/28/43/56 (unchanged curve); each strategy nets roughly +20k to +90k per night at Level 4, all combined about +290k.
- More strategy (2026-09-30): cover price set by the player (cheaper door = more but thriftier guests), scheduled happy hour (early: arrive sooner and stay; late: stay till close), promoters with guest lists (`data/promoters.json`: early crowd, no cover, commission per head), sound system and lighting tiers (energy + satisfaction, reset with a new venue), sparkler parade (bottle service show: copycat tables order bottles, partly impulse spend), encore (a buzzing room keeps guests past their planned leave time). Balance at Level 4: standard cover is near the sweet spot (2× cover ≈ −63k/night); promoters ≈ +30–40k net; full rig ≈ +31k/night (≈ 9-night payback).
- Layouts (2026-09-30): the Nightclub (Level 4) is 20×15 with VIP booths either side of the DJ and a front VIP row facing it, high tables round the floor, plain tables on edges/corners, stools along the bar. The Premium Venue (Level 5) is its own superclub/beach club (30×26): VIP balconies on a second level either side of the DJ, bars on both walls, an open-air pool deck with cabanas facing the sea. Capacity 500, 24 tables.
- Performance pass (2026-09-30):
  - Assets: art/posters to WebP (1.9 MB → 0.76 MB), wall clips to 432×768 muted H.264 (14 MB → 7.7 MB), intro to 1600×900 (4.1 → 3.0 MB), kalu/sable/DJ Main Serong to 128 kbps without cover art. The landing hero stays all-intra (scroll scrubbing).
  - JS: the night screen (three.js + venue) is a lazy chunk, prefetched from the office along with the cutscene; the first load is 429 KB (136 KB gzip) instead of 1.08 MB.
  - Venue: furniture merged into one mesh per material outside the layout editor, all floor shadows in one instanced mesh, drunk markers created on demand with shared materials, a fixed share of guests drawn (~150 at full capacity; the sim still counts everyone), pixel ratio capped at 1.5 with a drop to 1 when frames sag, rendering paused while the office covers the venue, fewer flame lights. Superclub at max tiers: 1,527 → 381 draw calls, 2.6 → 0.7 ms render CPU per frame.
- **Tokenized-stock pivot (2026-09-30):** guests no longer buy drinks; the club stocks tokenized stocks and baskets (`data/tokens.json`: TSLA, US500, NVDA, BIGT, AISEMI, DIVI, SKHY, SPCX) and guests buy those. A live in-club market (`rules/market.ts`, `strategy.json` → `market`) moves each token's price every minute: a random step sized by volatility, drift with crowd energy, pull back to list, and pumps when the DJ starts and during the anthem. FOMO (price above its average) raises the chance to buy. Guests feel their P&L: gains lift satisfaction, losses sour it and add tilt (tilt replaces "drunk"; tilted guests start fights and get escorted). The sale price = list × market. Balance (20 runs): Level 2/3/4/5 ≈ day 16/26/41/51, 80% victory.
  - UI: token detail card with a live chart and basket weights (Portir baskets), a ticker tape on the night HUD, a live token board behind every bar (replaces the liquor cabinet), and a "Top movers" videotron slide. Art: Portir stock logos and basket images → `public/art/token-*.webp`; issuer logos in `public/logos`.
  - On-chain (BNB Chain, via xStocks / Ondo / bStocks) comes later.
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

## 2026-09-29 · Playable club management game

- Modes: Career (Level 1 → 5, 60 days) and Scenario "The Basement" (Level 4, Week 1).
- Design choices, all tunable in `packages/core/src/data/*.json`:
  - Entertainment tax (R15) applies from Level 3 (bars/clubs), not to the booth/shop.
  - Below Level 3 the owner checks IDs (R8); security unlocks at Level 3 (2026-10-02, was 4).
  - Each level has a `priceScale` (drink prices, stock cost, guest budgets) so income keeps pace with the venue costs (50k → 5M).
  - Bartenders add bar throughput; out-of-stock (R2) hits each guest once, then they order what's in stock.
  - Staff is stored as counts per role, not `Staff[]`.
- Balance (bot, 1,000 runs): Level 2 ≈ day 17, Level 3 ≈ 28, Level 4 ≈ 45, Level 5 ≈ 57; ~91% victory, 0% defeat. A sensible bot never loses, so difficulty comes from player mistakes.
- UI: glass/B&W design (MotionSites "Data Signal" + "Glow Features" references), logo + Home on every screen (leaving autosaves), Open Club cutscene `apps/web/public/intro.mp4` (Higgsfield Seedance 2.0, 8 s, skippable, "Don't show again").
- Landing: scroll-scrubbed cinematic one-pager ("Tokyo Nocturne" spec adapted: Greek glyph flicker for Nyx), Higgsfield videos `landing-hero.mp4` (all-intra encode, so no WebCodecs frame bank needed) + `landing-reveal.mp4`.
- Office game UI: sidebar nav, scene banner, character cards with 3D tilt (MotionSites "Animated Cards"), permit documents with stamps, venue ladder. Art in `apps/web/public/art` (22 pieces, Higgsfield GPT Image 2: office, 6 drinks, 8 DJs, 2 staff, 5 venues).
- Venue scene: 18 character sprites (10 guests, DJ at decks, 2 stage dancers, karaoke MC, 2 bartenders, 2 bodyguards) + floor textures in `apps/web/public/sprites`; LED dance floor on the beat, light beams, spotlights. Staff sprites follow hired counts; dancers/MC are cosmetic (no performer booking system yet).
- Colour venue (2026-09-29): full-colour characters, club lights, hue-sweeping LED floor, back wall with a concert LED screen playing the booked DJ's loop (`public/video/dj-*.mp4`, Seedance from each DJ portrait), each DJ's own character at the decks (`sprites/deck-*.webp`), bodyguards hold the door, patrol, and walk escorted/fighting guests out.
- Venue is 3D (three.js, `apps/web/src/venue/scene3d.ts`): drag rotate, right-drag/arrows pan, wheel zoom, walls cut away toward the camera, liquor cabinet + fridge behind every bar. Mid-night Office (O / button): clock waits, `nightPromote` adds extra guests for the rest of the night; Talent/Build are day-only.
- Wall screens: slots per layout (`layouts.ts` → `screens`: portrait / landscape / ad), clips from `apps/web/public/screens/playlist.json` (user-supplied mp4s, cover-cropped, rotating); empty lists show a beat visualizer / 'your brand here' ad placeholder. Main screen plays landscape clips between DJ sets.
- Wall screens are all landscape now (clip / ad slots); dancer clips play only at peak hours (00:00–03:00 with a DJ on, `isPeakTime`), per Settings. The landing track never plays inside the club (house warm-up → DJ).
- Settings (`apps/web/src/settings.ts`): volume, music outside / inside the club, SFX, clips (peak / always / off), ads, cutscene.
- Staff cards for host / guest relations / MC / promoter are composed in code from the existing character sprites (`art/staff-*.webp`), no generated media.
- Sandbox (landing menu): starts at the Premium Venue (Level 5) with 20M Coin, all permits, full crew and stock; no win or game over (`createSandbox`, `scenarios.json` → sandbox).
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
- Cinematic camera (C or the clapperboard button): drone-style shots in shuffled order, ~9 s each, cut like an edit: wide orbit, a crane reveal up out of the crowd, a screen hero shot framing the whole concert screen and the DJ, a banking flythrough from the door over the crowd to the stage, a rising orbit round the DJ, a top-down drop, a low crowd skim, and a pool fly-over (superclub) or a bar dolly; a small zoom kick on the beat. Any click, drag or wheel hands the camera back.
- Live bands (`data/bands.json`, `bookBand` / `bandSet` / `bandPlaying` in rules/talent.ts, tests): five acts (R&B, house, hip-hop from Level 3; live EDM and techno from Level 4), one a night, booked in the Talent tab (now open from Level 3). Without a DJ the band is the main act 22:30–01:00; with one it opens 22:00–23:00. Genre vs. crowd works like a DJ (dance multiplier) and the band lifts the room's energy. In the venue: drum kit, keys, amp and mic stand on the stage with the band, the concert screen shows the band's poster, the videotron says LIVE ON STAGE; the band plays a set from the crate. Band cards are composed from the character sprites (`art/band-*.webp`).
