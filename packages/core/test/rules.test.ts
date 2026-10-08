import { describe, expect, it } from "vitest";
import {
  applyPermit,
  createGameState,
  djs,
  dominantGenre,
  inspect,
  levels,
  night,
  missingPermits,
  r03_bookDj,
  r04_djMultiplier,
  r05_promote,
  r06_inspectionChance,
  r08_rejectAtDoor,
  r09_fightChance,
  r10_forceDoorOpen,
  r11_reputationDelta,
  r14_checkVictory,
  r17_controversialPromo,
  r18_upgradeLevel,
  fireStaff,
  hireStaff,
  runNight,
  startNight,
  type ActionResult,
  type GameState,
} from "../src";

const ok = (r: ActionResult): GameState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};
const club = (over: Partial<GameState> = {}): GameState => ({
  ...createGameState(7),
  level: 4,
  coin: 100_000,
  reputation: 60,
  ...over,
});

describe("R3 bookDj", () => {
  it("pays fee, adds hype from fanbase", () => {
    const s = ok(r03_bookDj(club(), "rhea"));
    expect(s.coin).toBe(100_000 - djs.rhea.fee);
    expect(s.hype).toBe(Math.round(djs.rhea.fanbase * 0.3));
    expect(s.bookedTalent).toEqual(["rhea"]);
  });
  it("level lock, coin, one DJ per night", () => {
    expect(r03_bookDj(club(), "orion")).toMatchObject({
      reason: "levelLocked",
    });
    expect(r03_bookDj(club({ coin: 1000 }), "rhea")).toMatchObject({
      reason: "notEnoughCoin",
      short: 5000,
    });
    expect(r03_bookDj(ok(r03_bookDj(club(), "rhea")), "kalu")).toMatchObject({
      reason: "alreadyBooked",
    });
  });
});

describe("R4 DJ match", () => {
  it("dominant genre and multiplier", () => {
    expect(
      dominantGenre([{ genre: "edm" }, { genre: "rnb" }, { genre: "edm" }]),
    ).toBe("edm");
    expect(dominantGenre([])).toBeNull();
    expect(r04_djMultiplier("edm", "edm")).toBeCloseTo(1.2);
    expect(r04_djMultiplier("edm", "techno")).toBeCloseTo(0.85);
  });
});

describe("R5 promote", () => {
  it("costs coin + 1 energy, adds hype, once per channel per day", () => {
    const s = ok(r05_promote(club(), "tiktok"));
    expect(s.coin).toBe(98_000);
    expect(s.ceoEnergy).toBe(4);
    expect(s.hype).toBe(14);
    expect(r05_promote(s, "tiktok")).toMatchObject({ reason: "alreadyActive" });
  });
  it("needs energy and level", () => {
    expect(r05_promote(club({ ceoEnergy: 0 }), "posters")).toMatchObject({
      reason: "notEnoughEnergy",
    });
    expect(r05_promote(createGameState(1), "tiktok")).toMatchObject({
      reason: "levelLocked",
    });
  });
  it("boosts its audience segment tonight", () => {
    const count = (s: GameState) =>
      startNight(s).night!.guests.filter((g) => g.segment === "premium").length;
    const base = club({ hype: 50, ...permitsOk() });
    expect(count({ ...base, activePromos: ["influencer"] })).toBeGreaterThan(
      count(base),
    );
  });
});

const permitsOk = (): Pick<GameState, "permits"> => ({
  permits: {
    business: { valid: true, expiresDay: 99 },
    liquorTakeaway: { valid: false, expiresDay: 0 },
    liquorOnPremise: { valid: true, expiresDay: 99 },
    crowd: { valid: true, expiresDay: 99 },
  },
});

describe("permits + R6 + R16", () => {
  it("apply, expire, renew extends", () => {
    let s = ok(applyPermit(club(), "crowd"));
    expect(s.permits.crowd).toEqual({ valid: true, expiresDay: 8 });
    s = ok(applyPermit(s, "crowd"));
    expect(s.permits.crowd.expiresDay).toBe(15);
    expect(missingPermits({ ...club(), ...permitsOk(), day: 99 })).toEqual([
      "business",
      "liquorOnPremise",
    ]);
  });
  it("inspection chance: 40% with missing permit, low otherwise, 100% if forced", () => {
    expect(r06_inspectionChance(club())).toBe(0.4);
    expect(r06_inspectionChance(club(permitsOk()))).toBe(0.05);
    expect(
      r06_inspectionChance(club({ ...permitsOk(), forcedInspection: true })),
    ).toBe(1);
  });
  it("R16: takeaway-only liquor permit at a club → fail + sealed", () => {
    const p = permitsOk().permits;
    const s = club({
      permits: {
        ...p,
        liquorOnPremise: { valid: false, expiresDay: 0 },
        liquorTakeaway: { valid: true, expiresDay: 99 },
      },
    });
    expect(inspect(s, 0)).toMatchObject({
      passed: false,
      missing: ["liquorOnPremise"],
      sealNights: 1,
    });
    expect(inspect(club(permitsOk()), 0)).toMatchObject({
      passed: true,
      fine: 0,
    });
    expect(inspect(club(permitsOk()), 2)).toMatchObject({
      passed: false,
      underage: true,
      sealNights: 0,
    });
  });
});

describe("R8 / R9 / R10 security", () => {
  it("R8 rejects underage only with security", () => {
    expect(
      r08_rejectAtDoor(
        club({
          staff: { bartender: 0, security: 1, host: 0, relations: 0, mc: 0 },
        }),
        true,
      ),
    ).toBe(true);
    expect(r08_rejectAtDoor(club(), true)).toBe(false);
    expect(
      r08_rejectAtDoor(
        club({
          staff: { bartender: 0, security: 1, host: 0, relations: 0, mc: 0 },
        }),
        false,
      ),
    ).toBe(false);
  });
  it("R9 fight chance depends on tilt and 1:40 ratio", () => {
    const s = club({
      staff: { bartender: 0, security: 2, host: 0, relations: 0, mc: 0 },
    });
    expect(r09_fightChance(s, 79, 100)).toBe(0);
    expect(r09_fightChance(s, 80, 80)).toBe(night.fightChancePerMinute.staffed);
    expect(r09_fightChance(s, 80, 81)).toBe(
      night.fightChancePerMinute.understaffed,
    );
  });
  it("R10 forcing door open is a violation, only at night, only once", () => {
    expect(r10_forceDoorOpen(club())).toMatchObject({ reason: "wrongPhase" });
    const s = ok(r10_forceDoorOpen(startNight(club(permitsOk()))));
    expect(s.violations).toBe(1);
    expect(s.night!.doorForced).toBe(true);
    expect(r10_forceDoorOpen(s)).toMatchObject({ reason: "alreadyActive" });
  });
});

describe("R11 reputation delta", () => {
  it("≥70 → +3..+8, <40 → −5, else 0", () => {
    expect(r11_reputationDelta(70)).toBe(3);
    expect(r11_reputationDelta(100)).toBe(8);
    expect(r11_reputationDelta(55)).toBe(0);
    expect(r11_reputationDelta(39)).toBe(-5);
  });
});

describe("R14 / R18 progression", () => {
  it("upgrade needs coin and rep", () => {
    const s = ok(
      r18_upgradeLevel({ ...createGameState(1), coin: 60_000, reputation: 20 }),
    );
    expect(s.level).toBe(2);
    expect(s.coin).toBe(60_000 - levels[2].cost);
    expect(
      r18_upgradeLevel({ ...createGameState(1), coin: 60_000, reputation: 10 }),
    ).toMatchObject({
      reason: "notEnoughRep",
      short: 10,
    });
    expect(r18_upgradeLevel(createGameState(1))).toMatchObject({
      reason: "notEnoughCoin",
      short: 40_000,
    });
    expect(r18_upgradeLevel({ ...createGameState(1), level: 5 })).toMatchObject(
      { reason: "maxLevel" },
    );
  });
  it("victory at Level 5 with rep ≥ 80; survived at day 60", () => {
    expect(
      r14_checkVictory({ ...createGameState(1), level: 5, reputation: 80 })
        .outcome,
    ).toBe("victory");
    expect(
      r14_checkVictory({ ...createGameState(1), level: 5, reputation: 79 })
        .outcome,
    ).toBeNull();
    expect(r14_checkVictory({ ...createGameState(1), day: 60 }).outcome).toBe(
      "survived",
    );
  });
});

describe("R17 controversial promo", () => {
  it("hype +30; backfire (25%) costs rep 20 and forces inspection, deterministically per seed", () => {
    const results = Array.from({ length: 200 }, (_, seed) =>
      ok(r17_controversialPromo(club({ seed }))),
    );
    const backfired = results.filter((s) => s.forcedInspection);
    expect(results.every((s) => s.hype === 30)).toBe(true);
    expect(backfired.every((s) => s.reputation === 40)).toBe(true);
    expect(backfired.length / 200).toBeGreaterThan(0.15);
    expect(backfired.length / 200).toBeLessThan(0.35);
    expect(ok(r17_controversialPromo(club({ seed: 5 })))).toEqual(
      ok(r17_controversialPromo(club({ seed: 5 }))),
    );
  });
});

describe("audit: actions locked to the right phase", () => {
  it("staff are hired and fired by day only (no one-night hires that skip wages)", () => {
    const s = club();
    const n = startNight(ok(hireStaff(s, "security")));
    expect(hireStaff(n, "security")).toMatchObject({ reason: "wrongPhase" });
    expect(fireStaff(n, "security")).toMatchObject({ reason: "wrongPhase" });
    expect(
      ok(fireStaff(ok(hireStaff(s, "security")), "security")).staff.security,
    ).toBe(s.staff.security);
  });
  it("no DJ booking once the set slot has passed, no level-up or stunt at night", () => {
    const n = startNight(club());
    expect(
      r03_bookDj(
        { ...n, night: { ...n.night!, minute: night.djSetStartMinute } },
        "rhea",
      ),
    ).toMatchObject({ reason: "wrongPhase" });
    expect(r03_bookDj(n, "rhea").ok).toBe(true);
    expect(r18_upgradeLevel({ ...n, coin: 10_000_000 })).toMatchObject({
      reason: "wrongPhase",
    });
    expect(r17_controversialPromo(n)).toMatchObject({ reason: "wrongPhase" });
  });
  it("the stunt needs more rep than a backfire costs", () => {
    expect(r17_controversialPromo(club({ reputation: 20 }))).toMatchObject({
      reason: "notEnoughRep",
      short: 1,
    });
  });
  it("level-up carries stock at its value, not its count", () => {
    const s = ok(
      r18_upgradeLevel({
        ...createGameState(1),
        coin: 60_000,
        reputation: 20,
        stock: { ...createGameState(1).stock, tsla: 800 },
      }),
    );
    expect(s.stock.tsla).toBe(
      Math.floor((800 * levels[1].priceScale) / levels[2].priceScale),
    );
  });
});

describe("audit: an empty bar", () => {
  it("a guest who found nothing to buy stops queueing (one out-of-stock hit each at most)", () => {
    const r = runNight({ ...createGameState(3), coin: 50_000 }).lastReport!;
    expect(r.guests).toBeGreaterThan(0);
    expect(r.outOfStockHits).toBeLessThanOrEqual(r.guests);
  });
});
