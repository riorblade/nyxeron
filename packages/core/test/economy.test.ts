import { describe, expect, it } from "vitest";
import {
  createGameState,
  r13_checkDefeat,
  levels,
  r12_newDay,
  r15_entertainmentTax,
  staffRoles,
} from "../src";

describe("R12 newDay", () => {
  it("resets energy, deducts wages + rent, decays hype, clears nightly bookings", () => {
    const s0 = {
      ...createGameState(1),
      level: 4 as const,
      ceoEnergy: 0,
      ceoCallUsed: true,
      hype: 25,
      staff: { bartender: 2, security: 4, host: 0, relations: 0, mc: 0 },
      bookedTalent: ["rhea" as const],
    };
    const s = r12_newDay(s0);
    const wages =
      2 * staffRoles.bartender.wagePerDay + 4 * staffRoles.security.wagePerDay;
    expect(s.day).toBe(2);
    expect(s.ceoEnergy).toBe(5);
    expect(s.ceoCallUsed).toBe(false);
    expect(s.coin).toBe(s0.coin - wages - levels[4].rentPerDay);
    expect(s.hype).toBe(15);
    expect(s.bookedTalent).toEqual([]);
    expect(s.log.at(-1)).toEqual({
      day: 2,
      kind: "upkeepPaid",
      wages,
      rent: levels[4].rentPerDay,
    });
  });

  it("hype never goes below 0 and coin may go negative", () => {
    const s = r12_newDay({ ...createGameState(1), hype: 3, coin: 0 });
    expect(s.hype).toBe(0);
    expect(s.coin).toBe(-levels[1].rentPerDay);
  });
});

describe("R15 entertainmentTax", () => {
  it("is tiered: none for booth/shop, then 20% / 30% / 40% at Level 3 / 4 / 5", () => {
    const at = (level: 1 | 2 | 3 | 4 | 5) =>
      r15_entertainmentTax({
        ...createGameState(1),
        level,
        nightRevenue: { bar: 1000, cover: 0, table: 0 },
      }).tax;
    expect([at(1), at(2), at(3), at(4), at(5)]).toEqual([0, 0, 200, 300, 400]);
  });

  it("takes the venue's rate of cover + table + bar", () => {
    const s0 = {
      ...createGameState(1),
      level: 5 as const,
      nightRevenue: { bar: 1000, cover: 500, table: 250 },
    };
    const { state, tax } = r15_entertainmentTax(s0);
    expect(tax).toBe(700);
    expect(state.coin).toBe(s0.coin - 700);
    expect(state.log.at(-1)).toEqual({
      day: 1,
      kind: "taxPaid",
      revenue: 1750,
      tax: 700,
    });
  });

  it("booth (Level 1) is not an entertainment venue: no tax", () => {
    const s0 = {
      ...createGameState(1),
      nightRevenue: { bar: 1000, cover: 0, table: 0 },
    };
    expect(r15_entertainmentTax(s0).tax).toBe(0);
  });
});

describe("R13 checkDefeat", () => {
  it("counts consecutive negative days and loses on the 3rd", () => {
    let s = { ...createGameState(1), coin: -1 };
    s = r13_checkDefeat(s);
    s = r13_checkDefeat(s);
    expect(s.outcome).toBeNull();
    expect(r13_checkDefeat({ ...s, coin: 5 }).negativeCashDays).toBe(0);
    expect(r13_checkDefeat(s).outcome).toBe("defeat");
  });

  it("loses on 3 violations or reputation 0", () => {
    expect(
      r13_checkDefeat({ ...createGameState(1), violations: 3 }).outcome,
    ).toBe("defeat");
    expect(
      r13_checkDefeat({ ...createGameState(1), reputation: 0 }).outcome,
    ).toBe("defeat");
    expect(r13_checkDefeat(createGameState(1)).outcome).toBeNull();
  });
});
