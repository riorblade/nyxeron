# NYXERON · Product Requirements

| | |
| --- | --- |
| Product | NYXERON, a multiplayer nightclub management game on tokenized stocks |
| Chain | BNB Chain (tokenized equities via the RWA market) |
| Status | Live beta at nyxeron.xyz (Privy app in development mode) |
| Tagline | Nightclub Empire: build your nightclub empire on BNB Chain |
| Channels | [nyxeron.xyz](https://nyxeron.xyz) · X [@nyxeron_xyz](https://x.com/nyxeron_xyz) |
| Last updated | 2026-10-02 |

## 1. Problem and vision

Tokenized stocks are a real, growing asset class on BNB Chain, but most people meet them as a trading screen.
NYXERON wraps them in a social game people already understand, a night out: a club where the drinks on the menu
are tokenized equities, priced from the live market, bought in Coin, and kept by the guest.

**Vision:** the most fun place to discover tokenized stocks: you learn how prices move, what a basket is and what
a markup costs you by running or partying in a club, with friends, in real time.

## 2. Users and roles

| Role | Who | What they do |
| --- | --- | --- |
| **CEO** | Players who like management and strategy | Rent a venue, stock a shop, set prices and house rules, book DJs, host parties, grow a club |
| **Guest** | Players who like social play and light trading | Join live parties, buy tokens at the club's price, keep them in a portfolio, shop at open stores |
| **DJ** | Players who like music | Practise in the studio, play live sets in a CEO's club; the whole room hears the mix |
| **Admin** | The platform team | Manage players, coins, access, venues, rent, the warehouse, announcements; audit everything |
| **Stock agent** | An automated agent (BNB Agent Studio) | Watch demand, buy tokenized stock with the platform's agentic wallet, restock the warehouse |

## 3. Economy (the core loop)

- **Coin** is the medium of exchange. Every account has one server-side wallet (starter 20,000; a broke player
  may claim it again).
- **Tokens** (tokenized stocks and baskets) are the utility: what clubs sell, what guests collect.
- **Platform revenue:**
  1. **Venue rent**: venues are rented weekly in Coin (fixed supply per level; the scarce Premium Venue is the
     prize).
  2. **Warehouse sales**: CEOs buy shop stock from the platform's warehouse at the market price.
  3. **Fee on club sales**: a share of the spread over spot on token sales in single-player careers
     (`strategy.json → platform.feeShare`).
- **Flows:** guest Coin → CEO (party spend, shop purchases) · CEO Coin → platform (rent, stock) · platform →
  warehouse (agent buys real tokenized stock on-chain and reports it).

## 4. Features

### 4.1 Shipped

**Account and profile**
- Sign in with email or Google (Privy); embedded BNB Chain wallet created at first sign-in.
- Server profile: name, avatar, wallet, portfolio, night/gig record; career saves, DJ sets, layouts and videotron
  messages sync across devices.

**CEO**
- **Two modes, two currencies (owner decision, 2026-10-03):**
  - **Classic:** the club career with **NYX Points (NP)**, the play currency (farmed now for the NYX launch, never
    real money). Always starts at Level 1 (token booth) and climbs level by level; no level picker, no Basement
    shortcut. Bigger starting venues only through a back-office grant (for development). AI-hosted events are
    Classic too.
  - **City:** rented venues paid in **Credit** (real money only, see `payments.md`), real guests only. Bots may fill
    the room but never buy (they have no money). **Shut until Credit top-ups are live**: the api answers
    `city_closed` (`CITY_OPEN=1` opens it) and the client shows "City · coming soon".
- **Your clubs:** the CEO's Classic clubs (up to four, each saved on its own); City venues join the list once the
  city opens.
- Deep club sim: stock and pricing, live token market with FOMO, DJs and bands, promos, staff, house rules,
  reservations, permits and inspections, crowd energy, fights and security, tax, upgrades, VIP.
- Every top-bar stat explains itself (what it is, what it does, how it moves, what moved it lately).
- **City (multiplayer, shut until Credit is live):** rent a venue by the week, rename it, run a shop that sells
  while you're away.
- **Events:** schedule a night at any club (Level 3+): date and time picker, length (default 10 minutes), public or
  private with an invite link. Guests mark "I'm going" and get a one-click join the moment the host opens the club.

**Guest**
- Join live parties (room code, invite link or the city list); buy tokens at the club's live price; spend goes to
  the venue's tenant.
- Shop at open stores in the city; tokens go to the portfolio at what you paid.
- AI-hosted events for solo play (Classic, NYX Points).

**DJ**
- Studio: two decks (cue, hot cues, loops, sync, pitch, scratch, brake, backspin), mixer with EQ/filter/FX,
  sampler, planned sets with transitions and an auto DJ.
- Live sets in a CEO's club, synced to every player; paid gigs at AI clubs.

**Back office**
- Roles: owner (`ADMIN_EMAILS`), admin, viewer; owners manage admins.
- Overview KPIs (players, activity, coin in circulation, rent revenue, live rooms, price feed, backups).
- Players: search, detail (profile, portfolio, saves, coin ledger, admin history), grant/deduct coin, venue
  access, ban/unban, rename, clear saves.
- Venues: tenants, shops, live and scheduled parties, end a lease, cancel a party, weekly rent table.
- Stock: warehouse on hand, with CEOs, demand (24h/7d), days left, suggested restock, movements.
- Announcements on every player's dashboard; full audit log.

**Platform**
- Stock agent API: demand feed and restock (on-chain tx required).

### 4.2 Next (see [roadmap](roadmap.md))

- Agentic BNB wallet purchases wired to the warehouse; tokens settled on-chain for players.
- Venue supply controls in the back office (slots per level, waitlist).
- Verified identity on multiplayer joins; DJ fees paid by the hosting CEO.
- Privy production mode; public launch.

## 5. Requirements

### Functional

- A player can rent up to 5 venues; rent is paid weekly, up to 4 weeks ahead; an expired lease frees the venue.
- Shops sell only from stock; stock comes only from the warehouse; shelf price ≤ 3× the venue's usual price.
- Parties only at Level 3+, inside the lease, without overlap, up to 7 days ahead; guest spend at a live party goes
  to the tenant.
- Every admin mutation requires a reason and is audited atomically.
- A banned player can sign in and read, but cannot change anything.

### Non-functional

- **Trust:** the client is never trusted for value; all wallet/stock/rent movements are server-side and atomic.
- **Determinism:** the sim is seeded; a save reloads into the identical game.
- **Footprint:** relay ≤ 48 MB and api ≤ 48 MB RAM on a shared VPS; relay load-tested at 300 concurrent players.
- **Latency:** live state ≤ 4 snapshots/s per room; DJ sync within ~0.1–0.3 s across players.
- **Data safety:** SQLite in WAL mode, daily backups (7 kept), schema migrations that upgrade in place.

## 6. Success metrics

| Metric | Target (beta) |
| --- | --- |
| Weekly active players | grow week over week |
| Venues rented / available | ≥ 60% |
| Parties hosted per week | ≥ 1 per rented Level 3+ venue |
| Guest sessions per party | ≥ 5 |
| Rent revenue (Coin/week) | tracked on the back office overview |
| Warehouse sold-out hours | → 0 once the agent restocks |

## 7. Out of scope (for now)

- Real-money purchases of Coin; cash-out of Coin.
- Mobile-native apps (the web app is responsive).
- User-generated tokens; anything that isn't a tokenized real-world asset.
