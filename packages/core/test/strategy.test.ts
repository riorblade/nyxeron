import { describe, expect, it } from "vitest";
import {
  createGameState,
  createEvent,
  scenarios,
  bookPromoter,
  bandPlaying,
  bandSet,
  bookBand,
  securityStatus,
  bookingsFor,
  SEAT_TYPES,
  seatSpend,
  setAutoRefill,
  setMinSpend,
  standardSpend,
  capacityOf,
  r01_orderStock,
  storageOf,
  bottlePrice,
  buyUpgrade,
  commissionOf,
  coverBudget,
  coverDemand,
  crowdMove,
  DEFAULT_POLICY,
  happyHourAt,
  nextDay,
  r18_upgradeLevel,
  runNight,
  upgradeCost,
  vipFor,
  vipSpend,
  defaultPrice,
  tokens,
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
      ids(tokens).map((d) => [d, 9999]),
    ) as GameState["stock"],
    prices: Object.fromEntries(
      ids(tokens).map((d) => [d, defaultPrice(d, 4)]),
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
      ...DEFAULT_POLICY,
      ladiesNight: true,
    });
    expect(setPolicy(club({ level: 2 }), { ladiesNight: true }).ok).toBe(false);
    expect(setPolicy(startNight(club()), { dressCode: "smart" }).ok).toBe(
      false,
    );
  });

  it("ladies' night: more guests, more women, and women skip the cover", () => {
    const plain = club();
    const ladies = club({ policy: { ...DEFAULT_POLICY, ladiesNight: true } });
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
      policy: { ...DEFAULT_POLICY, dressCode: "strict" },
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
    ).toBe(levels[4].sofas + levels[4].tables);
    const before = ticks(
      startNight(gro),
      strategy.relations.tablesArriveMinute,
    );
    expect(before.nightRevenue.table).toBe(0);
    const after = tickNight(before);
    // Every booking (sofas, tables, walk-in bar seats) pays its minimum spend.
    const b = bookingsFor(gro);
    expect(after.nightRevenue.table).toBe(
      SEAT_TYPES.reduce((a, t) => a + b[t] * seatSpend(gro, t), 0),
    );
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

describe("cover price", () => {
  const cover = (c: number | null) =>
    club({ policy: { ...DEFAULT_POLICY, cover: c } });
  it("the standard cover changes nothing; pricier = fewer but richer guests", () => {
    expect(coverDemand(cover(null))).toBe(1);
    expect(coverDemand(cover(levels[4].coverCharge))).toBe(1);
    expect(coverDemand(cover(1800))).toBeLessThan(1);
    expect(coverDemand(cover(0))).toBeGreaterThan(1);
    expect(coverBudget(cover(1800))).toBeGreaterThan(1);
    expect(coverBudget(cover(0))).toBeLessThan(1);
    expect(expectedGuests(cover(1800))).toBeLessThan(expectedGuests(club()));
  });
  it("is what paying guests are charged at the door", () => {
    const s = ticks(startNight(cover(1000)), 60);
    const paid = s.night!.guests.filter((g) => g.admitted).length;
    expect(s.nightRevenue.cover).toBeLessThanOrEqual(paid * 1000);
    expect(s.nightRevenue.cover % 1000).toBe(0);
  });
  it("rejects a negative or fractional price", () => {
    expect(setPolicy(club(), { cover: -5 }).ok).toBe(false);
    expect(setPolicy(club(), { cover: 10.5 }).ok).toBe(false);
  });
  it("a guest who can't pay the cover is turned away; the guest list and ladies' night women still get in free", () => {
    const huge = 1e9;
    const s = ticks(
      startNight(
        club({
          policy: { ...DEFAULT_POLICY, cover: huge, ladiesNight: true },
        }),
      ),
      200,
    );
    const admitted = s.night!.guests.filter((g) => g.admitted);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.every((g) => g.female)).toBe(true);
    expect(s.nightRevenue.cover).toBe(0);
    // A man who reached the door went home with his budget intact.
    const men = s.night!.guests.filter(
      (g) => !g.female && g.state === "left" && !g.admitted,
    );
    expect(men.length).toBeGreaterThan(0);
    expect(men.every((g) => g.budget > 0)).toBe(true);
  });
  it("rejects an unknown dress code, happy-hour slot or a non-boolean ladies' night", () => {
    expect(setPolicy(club(), { dressCode: "toString" as never }).ok).toBe(
      false,
    );
    expect(setPolicy(club(), { happyHour: "__proto__" as never }).ok).toBe(
      false,
    );
    expect(setPolicy(club(), { ladiesNight: 1 as never }).ok).toBe(false);
    expect(
      setPolicy(club(), { dressCode: "strict", happyHour: "late" }).ok,
    ).toBe(true);
  });
});

describe("scheduled happy hour", () => {
  it("runs only in its window", () => {
    const early = club({ policy: { ...DEFAULT_POLICY, happyHour: "early" } });
    expect(happyHourAt(early, 30)).toBe(true);
    expect(happyHourAt(early, 90)).toBe(false);
    expect(happyHourAt(club(), 30)).toBe(false);
  });
  it("early pulls arrivals into the first hour; late keeps guests longer", () => {
    const arrivals = (s: GameState) =>
      startNight(s).night!.guests.filter((g) => g.arriveMinute < 60).length;
    const early = club({ policy: { ...DEFAULT_POLICY, happyHour: "early" } });
    expect(arrivals(early)).toBeGreaterThan(arrivals(club()));
    const stay = (s: GameState) =>
      startNight(s).night!.guests.reduce(
        (a, g) => a + g.leaveMinute - g.arriveMinute,
        0,
      );
    const late = club({ policy: { ...DEFAULT_POLICY, happyHour: "late" } });
    expect(stay(late)).toBeGreaterThan(stay(club()));
  });
});

describe("promoters", () => {
  it("are booked by day, cleared the next day", () => {
    const r = bookPromoter(club(), "campus");
    expect(r.ok && r.state.promoters).toEqual(["campus"]);
    if (!r.ok) return;
    const cancel = bookPromoter(r.state, "campus");
    expect(cancel.ok && cancel.state.promoters).toEqual([]);
    expect(nextDay(runNight(r.state)).promoters).toEqual([]);
    expect(bookPromoter(club({ level: 3 }), "elite").ok).toBe(false);
  });
  it("bring an early guest list that skips the cover; paid per head", () => {
    const s = club({ promoters: ["social"] });
    const list = startNight(s).night!.guests.filter((g) => g.guestList);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((g) => g.segment === "urban25")).toBe(true);
    expect(list.every((g) => g.arriveMinute < 75)).toBe(true);
    const r = playNight(s).lastReport!;
    expect(r.guestListIn).toBeGreaterThan(0);
    expect(r.commission).toBe(r.guestListIn * commissionOf(s, "social"));
  });
});

describe("sound & lighting", () => {
  it("tiers cost more each step, max 3, and reset with a new venue", () => {
    let s = club({ level: 3, reputation: 90, coin: 50_000_000 });
    const costs: number[] = [];
    for (let i = 0; i < 3; i++) {
      costs.push(upgradeCost(s, "sound")!);
      const r = buyUpgrade(s, "sound");
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(costs[1]).toBeGreaterThan(costs[0]!);
    expect(buyUpgrade(s, "sound").ok).toBe(false);
    const up = r18_upgradeLevel(s);
    expect(up.ok && up.state.upgrades.sound).toBe(0);
  });
  it("lift the room's energy", () => {
    const rig = club({
      upgrades: { sound: 3, lighting: 3, vip: 0, capacity: 0, storage: 0 },
    });
    const n = startNight(club()).night!;
    expect(energyTarget(rig, n, 40, 10)).toBeGreaterThan(
      energyTarget(club(), n, 40, 10),
    );
  });
});

describe("sparkler parade", () => {
  const gro = club({
    coin: 5_000_000,
    staff: { bartender: 4, security: 6, host: 0, relations: 3, mc: 0 },
  });
  it("needs seated tables", () => {
    expect(tacticBlock(at(club(), 120), "sparkler")).toBe("noTables");
    expect(tacticBlock(at(gro, 30), "sparkler")).toBe("noTables");
  });
  it("sells bottles to copycats, as table revenue", () => {
    const s = ticks(startNight(gro), 120);
    const r = crowdMove(s, "sparkler");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bottles = r.state.night!.bottles;
    expect(bottles).toBeGreaterThan(0);
    expect(r.state.nightRevenue.table - s.nightRevenue.table).toBe(
      bottles * bottlePrice(s),
    );
  });
});

describe("encore", () => {
  it("in a buzzing room some guests stay past their planned leave time", () => {
    const s = ticks(startNight(club()), 150);
    const set = (energy: number): GameState => ({
      ...s,
      night: { ...s.night!, energy },
    });
    const stayed = (x: GameState) =>
      x.night!.guests.filter((g) => g.encore && isInside(g)).length;
    expect(stayed(ticks(set(100), 3))).toBeGreaterThan(0);
    expect(stayed(ticks(set(10), 3))).toBe(0);
  });
});

describe("AI-run events", () => {
  it("are licensed for the night and never end in a win or a loss", () => {
    const s = createEvent(scenarios.events[2]!, 5);
    expect(s.mode).toBe("event");
    expect(Object.values(s.permits).every((p) => p.valid)).toBe(true);
    const broke = endNight(
      ticks({ ...s, coin: -1e9, negativeCashDays: 5, violations: 9 }, 9999),
    );
    expect(broke.outcome).toBe(null);
  });

  it("an old player sandbox save loads as a normal career", () => {
    const old = {
      ...createGameState(5),
      mode: "sandbox",
    } as unknown as GameState;
    expect(migrateState(old).mode).toBe("career");
  });
});

describe("VIP lounge", () => {
  const gro = (vip: number) =>
    club({
      coin: 50_000_000,
      upgrades: { sound: 0, lighting: 0, vip, capacity: 0, storage: 0 },
      staff: { bartender: 4, security: 6, host: 0, relations: 3, mc: 0 },
    });
  it("is built once in the Build tab from Level 4", () => {
    expect(buyUpgrade(club({ level: 3 }), "vip").ok).toBe(false);
    const r = buyUpgrade(gro(0), "vip");
    expect(r.ok && r.state.upgrades.vip).toBe(1);
    if (r.ok) expect(buyUpgrade(r.state, "vip").ok).toBe(false);
  });
  it("adds VIP tables (booked by guest relations) worth more than regular ones", () => {
    expect(vipFor(gro(0))).toBe(0);
    expect(vipFor(gro(1))).toBeGreaterThan(0);
    expect(vipFor(gro(1))).toBeLessThanOrEqual(levels[4].vipTables);
    expect(vipSpend(gro(1))).toBeGreaterThan(tableSpend(gro(1)));
    const minute = strategy.relations.tablesArriveMinute;
    const paid = (s: GameState) =>
      tickNight(ticks(startNight(s), minute)).nightRevenue.table;
    expect(paid(gro(1)) - paid(gro(0))).toBe(vipFor(gro(1)) * vipSpend(gro(1)));
  });
});

describe("venue capacity and storage", () => {
  const rich = club({ coin: 50_000_000 });
  it("capacity grows with each expansion tier and caps the door", () => {
    const r = buyUpgrade(rich, "capacity");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(capacityOf(r.state)).toBeGreaterThan(capacityOf(rich));
    // Peak crowd inside over the busiest part of a packed night.
    const inside = (s: GameState) => {
      let st = startNight({ ...s, hype: 100, reputation: 100 });
      let peak = 0;
      for (let i = 0; i < 200; i++) {
        st = tickNight(st);
        peak = Math.max(peak, st.night!.guests.filter(isInside).length);
      }
      return peak;
    };
    expect(inside(rich)).toBeLessThanOrEqual(capacityOf(rich));
  });
  it("the stock room caps orders; storage upgrades make room", () => {
    const full = { ...rich, stock: { ...rich.stock } };
    for (const d of ids(tokens)) full.stock[d] = 0;
    full.stock.tsla = storageOf(full) - 5;
    const tooMuch = r01_orderStock(full, "tsla", 10, "corner");
    expect(tooMuch.ok).toBe(false);
    expect(!tooMuch.ok && tooMuch.reason).toBe("storageFull");
    expect(r01_orderStock(full, "tsla", 5, "corner").ok).toBe(true);
    const up = buyUpgrade(full, "storage");
    expect(up.ok && r01_orderStock(up.state, "tsla", 10, "corner").ok).toBe(
      true,
    );
  });
});

describe("minimum spend", () => {
  const gro = club({
    staff: { bartender: 4, security: 6, host: 0, relations: 3, mc: 0 },
    reputation: 40,
  });
  it("defaults to the venue standard and is set per seat type by day", () => {
    expect(seatSpend(gro, "sofa")).toBe(standardSpend(gro, "sofa"));
    const r = setMinSpend(gro, "sofa", 20_000);
    expect(r.ok && seatSpend(r.state, "sofa")).toBe(20_000);
    if (r.ok) {
      const back = setMinSpend(r.state, "sofa", null);
      expect(back.ok && seatSpend(back.state, "sofa")).toBe(
        standardSpend(gro, "sofa"),
      );
    }
    expect(setMinSpend(startNight(gro), "sofa", 1).ok).toBe(false);
    expect(setMinSpend(gro, "sofa", -1).ok).toBe(false);
  });
  it("a pricier minimum books fewer seats, a cheaper one more", () => {
    const at = (t: "sofa" | "bar", k: number) =>
      bookingsFor({
        ...gro,
        minSpend: { [t]: Math.round(standardSpend(gro, t) * k) },
      })[t];
    expect(at("sofa", 2)).toBeLessThan(at("sofa", 1));
    expect(at("bar", 2)).toBeLessThan(at("bar", 1));
    expect(at("bar", 0.5)).toBeGreaterThanOrEqual(at("bar", 1));
  });
  it("bar seats fill with walk-ins even without guest relations", () => {
    expect(bookingsFor(club()).bar).toBeGreaterThan(0);
    expect(bookingsFor(club()).sofa).toBe(0);
  });
});

describe("auto-refill", () => {
  const low = (on: boolean) => {
    const s = club({ autoRefill: on });
    // Realistic stock (the helper's 9999 of everything would fill the stock room).
    const stock = { ...s.stock };
    for (const d of ids(tokens)) stock[d] = 100;
    return { ...s, stock: { ...stock, tsla: 3 } };
  };
  it("tops up a drink that runs low at night, only when switched on", () => {
    expect(tickNight(startNight(low(true))).stock.tsla).toBeGreaterThan(3);
    expect(tickNight(startNight(low(false))).stock.tsla).toBeLessThanOrEqual(3);
    expect(setAutoRefill(club(), true).ok).toBe(true);
  });
  it("stops when there is no Coin", () => {
    const broke = { ...low(true), coin: 0 };
    expect(tickNight(startNight(broke)).stock.tsla).toBeLessThanOrEqual(3);
  });
});

describe("security works on its own", () => {
  // Three tilt guests inside at minute 100.
  const drunkNight = (security: number) => {
    const s = ticks(startNight(club()), 100);
    let k = 0;
    const guests = s.night!.guests.map((g) =>
      isInside(g) && k++ < 3 ? { ...g, tilt: 95 } : g,
    );
    return {
      ...s,
      staff: { ...s.staff, security },
      // A clean slate for security: nobody escorted yet tonight.
      night: {
        ...s.night!,
        guests,
        escorts: [],
        escorted: 0,
        stretchedLogged: false,
      },
    };
  };
  const drunkInside = (s: GameState) =>
    s.night!.guests.filter(
      (g) => isInside(g) && g.tilt >= night.fightTiltThreshold,
    ).length;

  it("free guards walk tilt guests out without being asked", () => {
    const after = tickNight(drunkNight(6));
    expect(after.night!.escorted).toBeGreaterThanOrEqual(3);
    expect(securityStatus(after).busy).toBeGreaterThanOrEqual(3);
  });

  it("each escort keeps a guard busy; too few guards and the rest wait (with a warning)", () => {
    const after = tickNight(drunkNight(2));
    expect(after.night!.escorted).toBe(2);
    expect(securityStatus(after).waiting).toBeGreaterThanOrEqual(1);
    expect(after.log.some((e) => e.kind === "securityStretched")).toBe(true);
    // Guards stay busy for escortMinutes, then take the next one.
    const later = ticks(after, night.escortMinutes);
    expect(later.night!.escorted).toBeGreaterThan(2);
  });

  it("no security, no escorts", () => {
    const after = tickNight(drunkNight(0));
    expect(after.night!.escorted).toBe(0);
    expect(drunkInside(after)).toBeGreaterThan(0);
  });
});

describe("live bands", () => {
  const bar = (over: Partial<GameState> = {}) =>
    club({ level: 3, bookedTalent: [], ...over });
  it("are booked by day, one a night, from their level; bring hype; clear the next day", () => {
    const r = bookBand(bar(), "soulAvenue");
    expect(r.ok && r.state.bookedBand).toBe("soulAvenue");
    if (!r.ok) return;
    expect(r.state.hype).toBeGreaterThan(bar().hype);
    expect(bookBand(r.state, "brasshouse").ok).toBe(false);
    expect(bookBand(bar(), "neonPulse").ok).toBe(false); // Level 4 act
    expect(nextDay(runNight(r.state)).bookedBand).toBe(null);
  });
  it("play the main set without a DJ, and open for one when a DJ is booked", () => {
    const main = bandSet(bar({ bookedBand: "brasshouse" }))!;
    const opener = bandSet(club({ bookedBand: "brasshouse" }))!;
    expect(main[0]).toBe(night.band.start);
    expect(opener[1]).toBeLessThanOrEqual(night.djSetStartMinute);
    expect(bandSet(bar())).toBe(null);
  });
  it("lift the dance floor and the room's energy while they play", () => {
    const s = bar({ bookedBand: "brasshouse" });
    const [start, end] = bandSet(s)!;
    const on = ticks(startNight(s), start + 1);
    expect(on.night!.bandMultiplier).toBeGreaterThan(0);
    expect(on.log.some((e) => e.kind === "bandStarted")).toBe(true);
    expect(bandPlaying(on)).toBe(true);
    const n = on.night!;
    expect(energyTarget(on, n, 40, 10)).toBeGreaterThan(
      energyTarget(on, { ...n, bandMultiplier: null }, 40, 10),
    );
    expect(ticks(on, end - start).night!.bandMultiplier).toBe(null);
  });
});
