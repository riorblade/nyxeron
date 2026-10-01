import { describe, expect, it } from "vitest";
import {
  capacityOf,
  compactForSave,
  createGameState,
  nextDay,
  runNight,
  createGig,
  migrateState,
  scenarios,
  stockHeld,
  storageOf,
  tickNight,
  startNight,
  type GameState,
} from "../src";
import { botDay } from "../scripts/bot";

/**
 * Data audit: what a save holds must survive saving and loading exactly, older saves must still load and play,
 * and a long career must never corrupt the numbers players see (progress, level, stock, storage, upgrades…).
 */

const roundTrip = (s: GameState) =>
  migrateState(JSON.parse(JSON.stringify(s)) as GameState);

/** Every number anywhere in the state is finite (no NaN / Infinity sneaking into a save). */
function badNumbers(v: unknown, path = "state", out: string[] = []): string[] {
  if (typeof v === "number" && !Number.isFinite(v)) out.push(path);
  else if (Array.isArray(v))
    v.forEach((x, i) => badNumbers(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) badNumbers(x, `${path}.${k}`, out);
  return out;
}

/** The rules a player can see must always hold. */
function invariants(s: GameState): string[] {
  const e: string[] = [];
  const pct = (name: string, v: number) =>
    (v < 0 || v > 100) && e.push(`${name} out of 0–100: ${v}`);
  e.push(...badNumbers(s).map((p) => `not a number: ${p}`));
  if (s.level < 1 || s.level > 5) e.push(`level ${s.level}`);
  pct("reputation", s.reputation);
  pct("hype", s.hype);
  pct("safety", s.safety);
  for (const [t, n] of Object.entries(s.stock)) {
    if (n < 0 || !Number.isInteger(n)) e.push(`stock ${t} = ${n}`);
  }
  for (const [t, p] of Object.entries(s.prices))
    if (p < 1 || !Number.isInteger(p)) e.push(`price ${t} = ${p}`);
  for (const [k, tier] of Object.entries(s.upgrades))
    if (tier < 0 || tier > 3 || !Number.isInteger(tier))
      e.push(`upgrade ${k} = ${tier}`);
  for (const [role, n] of Object.entries(s.staff))
    if (n < 0 || !Number.isInteger(n)) e.push(`staff ${role} = ${n}`);
  if (s.phase === "day" && stockHeld(s) > storageOf(s))
    e.push(`stock held ${stockHeld(s)} > storage ${storageOf(s)}`);
  if (s.night) {
    const inside = s.night.guests.filter(
      (g) => g.state !== "queue" && g.state !== "left" && g.state !== "pending",
    ).length;
    if (inside > capacityOf(s) && !s.night.doorForced)
      e.push(`${inside} inside > capacity ${capacityOf(s)}`);
  }
  return e;
}

describe("save data", () => {
  it("a long career keeps every visible number valid, every day", () => {
    for (const seed of [1, 2, 3]) {
      let s: GameState = createGameState(seed, "edm");
      while (!s.outcome && s.day <= 60) {
        s = botDay(s);
        const bad = invariants(s);
        expect(bad, `seed ${seed} day ${s.day}`).toEqual([]);
      }
    }
  });

  it("save → load gives back exactly the same game (by day and mid-night)", () => {
    let s: GameState = createGameState(7, "techno");
    for (let d = 0; d < 30; d++) s = botDay(s);
    expect(roundTrip(s)).toEqual(s);
    let n = startNight(s);
    for (let m = 0; m < 90; m++) n = tickNight(n);
    expect(roundTrip(n)).toEqual(n);
    // …and the loaded game plays on identically (the sim is deterministic).
    let a = n,
      b = roundTrip(n);
    for (let m = 0; m < 60; m++) {
      a = tickNight(a);
      b = tickNight(b);
    }
    expect(b).toEqual(a);
  });

  it("an old save (before upgrades, house rules, the market, multiplayer) loads and plays", () => {
    let s: GameState = createGameState(9, "house");
    for (let d = 0; d < 12; d++) s = botDay(s);
    const old = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    for (const k of [
      "upgrades",
      "policy",
      "promoters",
      "bookedBand",
      "minSpend",
      "autoRefill",
      "quotes",
      "quoteRef",
    ])
      delete old[k];
    (old.staff as Record<string, number>) = { bartender: 1, security: 0 };
    let loaded = migrateState(old as unknown as GameState);
    expect(invariants(loaded)).toEqual([]);
    for (let d = 0; d < 5; d++) loaded = botDay(loaded);
    expect(invariants(loaded)).toEqual([]);
  });

  it("an old mid-night save (no market, no visitors) loads and plays the night out", () => {
    const n = startNight({ ...createGameState(4), coin: 50_000 });
    const old = JSON.parse(JSON.stringify(n)) as GameState;
    const night = old.night as unknown as Record<string, unknown>;
    for (const k of [
      "market",
      "marketEma",
      "marketHist",
      "visitors",
      "tactics",
    ])
      delete night[k];
    let s = migrateState(old);
    for (let m = 0; m < 360; m++) s = tickNight(s);
    expect(invariants(s)).toEqual([]);
  });

  it("a compact save stays small and plays on exactly like the full game", () => {
    let s: GameState = createGameState(5, "edm");
    while (!s.outcome && s.day <= 60) {
      s = botDay(s);
      // Like the autosave: right after the night, at the report.
      const report = runNight(s);
      const saved = roundTrip(compactForSave(report));
      expect(JSON.stringify(saved).length).toBeLessThan(40_000);
      // Next day from the save = next day from the live game (apart from the trimmed log). A finished career
      // has no next day (the game-over screen reads the outcome, not the night).
      if (report.outcome) break;
      const a = nextDay(report),
        b = nextDay(saved);
      expect({ ...b, log: [] }).toEqual({ ...a, log: [] });
      expect(b.log).toEqual(a.log.slice(a.log.length - b.log.length));
    }
  });

  it("a DJ gig's mid-night state round-trips too", () => {
    const g = createGig(scenarios.events[1]!, 3);
    expect(roundTrip(g)).toEqual(g);
  });
});
