# Roadmap

Ordered by priority. Each item ends with passing tests and a short demo.

## Now: launch readiness

- [x] Deploy the back office, city and warehouse (2026-10-02: api migrations 1–3, admin on
      `admin.nyxeron.xyz`).
- [ ] Seed the warehouse from the back office so CEOs can stock shops.
- [ ] Privy app to production mode (removes the user cap).
- [ ] Verified identity on multiplayer joins (the relay/host trusts the api's verified player, not a name).

## Next: on-chain stock

- [ ] Stock agent (BNB Agent Studio): reads `/api/agent/demand`, buys tokenized stock with the platform's agentic
      wallet on BNB Chain, reports each purchase to `/api/agent/restock`.
- [ ] Players' tokens settled on-chain (custody model and redemption to be decided), never from client-reported
      results.
- [ ] Contracts (Foundry + OpenZeppelin) where the model needs them; testnet first.

## Then: city depth

- [ ] Venue supply in the back office (slots per level) and a waitlist when a level is full.
- [ ] DJ fees paid by the hosting CEO; booking a player DJ for a scheduled party.
- [ ] The crowd reacting to a live player DJ's mix in the simulation.
- [ ] Party discovery: reminders, favourites, a city map.

## Later

- [ ] Seasons and leaderboards (rewards validated server-side by replaying runs from seed + action log).
- [ ] Localization (all strings are already in `apps/web/src/i18n/en.ts`).
- [ ] Mobile layout pass for the night HUD.
