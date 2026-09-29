import { describe, expect, it } from "vitest";
import {
  createGameState,
  crowdMove,
  defaultPrice,
  drinks,
  endNight,
  energyTarget,
  expectedGuests,
  ids,
  isInside,
  levels,
  maleBudget,
  migrateState,
  night,
  nightOver,
  roundChance,
  setPolicy,
  startNight,
  strategy,
  tablesFor,
  tableSpend,
  tacticBlock,
  tickNight,
  type GameState,
} from "../src";

const club = (over: Partial<GameState> = {}): GameState => {
  const s0 = createGameState(11);
  return {
    ...s0,
    level: 4,
    coin: 1_000_000,
    reputation: 60,
    hype: 60,
    permits: Object.fromEntries(
      Object.keys(s0.permits).map((k) => [k, { valid: true, expiresDay: 99 }]),
    ) as GameState["permits"],
    stock: Object.fromEntries(
      ids(drinks).map((d) => [d, 9999]),
    ) as GameState["stock"],
    prices: Object.fromEntries(
      ids(drinks).map((d) => [d, defaultPrice(d, 4)]),
    ) as GameState["prices"],
    staff: { bartender: 4, security: 6, host: 0, relations: 0, mc: 0 },
    bookedTalent: ["sable"],
    ...over,
  };
};
const ticks = (s: GameState, n: number) => {
  for (let i = 0; i < n && !nightOver(s); i++) s = tickNight(s);
  return s;
};
const playNight = (s: GameState) => endNight(ticks(startNight(s), 9999));
const at = (s: GameState, minute: number) => {
  const st = startNight(s);
  return { ...st, night: { ...st.night!, minute } };
};

describe("house rules", () => {
  it("are set by day from Level 3 and stay in force", () => {
    const r = setPolicy(club(), { ladiesNight: true });
    expect(r.ok && r.state.policy).toEqual({
      ladiesNight: true,
      dressCode: "none",
    });
    expect(setPolicy(club({ level: 2 }), { ladiesNight: true }).ok).toBe(false);
    expect(setPolicy(startNight(club()), { dressCode: "smart" }).ok).toBe(
      false,
    );
  });

  it("ladies' night: more guests, more women, and women skip the cover", () => {
    const plain = club();
    const ladies = club({ policy: { ladiesNight: true, dressCode: "none" } });
    expect(expectedGuests(ladies)).toBeGreaterThan(expectedGuests(plain));
    const women = (s: GameState) => {
      const g = startNight(s).night!.guests;
      return g.filter((x) => x.female).length / g.length;
    };
    expect(women(ladies)).toBeGreaterThan(women(plain));
    // Every admitted woman got in free: cover = men admitted × cover charge.
    const done = ticks(startNight(ladies), 200);
    const menIn = done.night!.guests.filter(
      (g) => g.admitted && !g.female,
    ).length;
    expect(done.nightRevenue.cover).toBeLessThanOrEqual(
      menIn * levels[4].coverCharge,
    );
  });

  it("dress code: fewer guests, some turned away, deeper pockets", () => {
    const strict = club({
      policy: { ladiesNight: false, dressCode: "strict" },
    });
    expect(expectedGuests(strict)).toBeLessThan(expectedGuests(club()));
    const avgBudget = (s: GameState) => {
      const g = startNight(s).night!.guests;
      return g.reduce((a, x) => a + x.budget, 0) / g.length;
    };
    expect(avgBudget(strict)).toBeGreaterThan(avgBudget(club()) * 1.2);
    expect(playNight(strict).lastReport!.rejectedDress).toBeGreaterThan(0);
    expect(playNight(club()).lastReport!.rejectedDress).toBe(0);
  });
});

describe("staff strategies", () => {
  it("hosts make men spend more and the room look fuller", () => {
    const hosts = club({
      staff: { bartender: 4, security: 6, host: 4, relations: 0, mc: 0 },
    });
    expect(maleBudget(hosts)).toBeGreaterThan(maleBudget(club()));
    const n = startNight(club()).night!;
    expect(energyTarget(hosts, n, 40, 10)).toBeGreaterThan(
      energyTarget(club(), n, 40, 10),
    );
    expect(roundChance(hosts, 0.4)).toBeGreaterThan(roundChance(club(), 0.4));
  });

  it("guest relations book tables (capped by the venue) that pay on arrival", () => {
    const gro = club({
      staff: { bartender: 4, security: 6, host: 0, relations: 2, mc: 0 },
    });
    expect(tablesFor(club())).toBe(0);
    expect(tablesFor(gro)).toBeGreaterThan(0);
    expect(
      tablesFor({
        ...gro,
        staff: { ...gro.staff, relations: 99 },
      }),
    ).toBe(levels[4].tables);
    const before = ticks(
      startNight(gro),
      strategy.relations.tablesArriveMinute,
    );
    expect(before.nightRevenue.table).toBe(0);
    const after = tickNight(before);
    expect(after.nightRevenue.table).toBe(tablesFor(gro) * tableSpend(gro));
  });

  it("men buy rounds for women and hosts", () => {
    expect(playNight(club()).lastReport!.rounds).toBeGreaterThan(0);
  });
});

describe("crowd moves", () => {
  const crew = club({
    staff: { bartender: 4, security: 6, host: 3, relations: 0, mc: 1 },
  });

  it("need the right staff (MC, hosts) and, for the anthem, a DJ on", () => {
    const early = at(club(), 30);
    expect(tacticBlock(early, "mcHype")).toBe("noStaff");
    expect(tacticBlock(early, "hostsFloor")).toBe("noStaff");
    expect(tacticBlock(at(crew, 30), "djAnthem")).toBe("noDj");
    expect(tacticBlock(at(crew, night.djSetStartMinute), "djAnthem")).toBe(
      null,
    );
    expect(crowdMove(club(), "mcHype").ok).toBe(false); // daytime
  });

  it("have a cooldown, and repeating one tires the crowd", () => {
    const s = at(crew, 120);
    const r1 = crowdMove(s, "mcHype");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(crowdMove(r1.state, "mcHype").ok).toBe(false);
    const later = {
      ...r1.state,
      night: {
        ...r1.state.night!,
        minute: 120 + strategy.tactics.mcHype.cooldown,
      },
    };
    const r2 = crowdMove(later, "mcHype");
    expect(r2.ok && r2.state.night!.tactics.mcHype!.power).toBeLessThan(
      r1.state.night!.tactics.mcHype!.power,
    );
  });

  it("MC hype lifts the room's energy", () => {
    const s = ticks(startNight(crew), 150);
    const r = crowdMove(s, "mcHype");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ticks(r.state, 15).night!.energy).toBeGreaterThan(
      ticks(s, 15).night!.energy,
    );
  });

  it("the DJ anthem cheers everyone up and keeps them longer, once a night", () => {
    const s = ticks(startNight(crew), 200);
    const r = crowdMove(s, "djAnthem");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = s.night!.guests.filter(isInside);
    const after = r.state.night!.guests;
    for (const g of before) {
      expect(after[g.id]!.leaveMinute).toBeGreaterThanOrEqual(g.leaveMinute);
      expect(after[g.id]!.satisfaction).toBeGreaterThanOrEqual(g.satisfaction);
    }
    expect(before.some((g) => after[g.id]!.leaveMinute > g.leaveMinute)).toBe(
      true,
    );
    expect(tacticBlock(ticks(r.state, 100), "djAnthem")).toBe("cooldown");
  });
});

describe("crowd energy", () => {
  it("a flat, unhappy room empties early", () => {
    const s = ticks(startNight(club()), 150);
    const mood = (energy: number): GameState => ({
      ...s,
      night: {
        ...s.night!,
        energy,
        guests: s.night!.guests.map((g) => ({ ...g, satisfaction: 10 })),
      },
    });
    // Guests gone before their planned leave time.
    const early = (x: GameState) =>
      x.night!.guests.filter(
        (g) =>
          g.state === "left" && g.admitted && g.leaveMinute > x.night!.minute,
      ).length;
    expect(early(ticks(mood(0), 5))).toBeGreaterThan(
      early(ticks(mood(100), 5)),
    );
  });

  it("is reported with the night", () => {
    const r = playNight(club()).lastReport!;
    expect(r.avgEnergy).toBeGreaterThan(0);
    expect(r.peakEnergy).toBeGreaterThanOrEqual(r.avgEnergy);
  });
});

describe("migrateState", () => {
  it("fills in house rules, new staff roles and night fields for old saves", () => {
    const old = startNight(club()) as unknown as Record<string, unknown>;
    delete old.policy;
    old.staff = { bartender: 1, security: 1 };
    const n = old.night as Record<string, unknown>;
    delete n.energy;
    delete n.tactics;
    const m = migrateState(old as unknown as GameState);
    expect(m.policy.dressCode).toBe("none");
    expect(m.staff.host).toBe(0);
    expect(m.night!.energy).toBeGreaterThanOrEqual(0);
    expect(m.night!.tactics).toEqual({});
  });
});
