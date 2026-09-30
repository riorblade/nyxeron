import { describe, expect, it } from "vitest";
import {
  applyPermit,
  ceoCall,
  createBasement,
  createGameState,
  endNight,
  escortGuest,
  isInside,
  nextDay,
  nightOver,
  nightPromote,
  objectives,
  r05_promote,
  r01_orderStock,
  runNight,
  startNight,
  tickNight,
  type ActionResult,
  type GameState,
} from "../src";

const ok = (r: ActionResult): GameState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};
const tickTo = (s: GameState, minute: number) => {
  while (s.night!.minute < minute) s = tickNight(s);
  return s;
};

describe("CEO Call", () => {
  const night = () => startNight({ ...createBasement(1), hype: 60 });

  it("once per night, only at night", () => {
    expect(ceoCall(createBasement(1), "happyHour")).toMatchObject({
      reason: "wrongPhase",
    });
    const s = ok(ceoCall(night(), "closeDoor"));
    expect(ceoCall(s, "happyHour")).toMatchObject({ reason: "alreadyActive" });
  });

  it("Close Door stops admissions", () => {
    let s = tickTo(night(), 30);
    s = ok(ceoCall(s, "closeDoor"));
    const admitted = s.night!.guests.filter((g) => g.admitted).length;
    s = tickTo(s, 200);
    expect(s.night!.guests.filter((g) => g.admitted).length).toBe(admitted);
  });

  it("Happy Hour: +satisfaction now, cheaper tokens → more sales, less margin per drink", () => {
    const plenty = { ...createBasement(1), hype: 60 };
    for (const d of Object.keys(plenty.stock) as (keyof typeof plenty.stock)[])
      plenty.stock[d] = 10_000;
    const base = tickTo(startNight(plenty), 60);
    const hh = ok(ceoCall(base, "happyHour"));
    const inside = base.night!.guests.filter(isInside);
    expect(hh.night!.guests[inside[0]!.id]!.satisfaction).toBeGreaterThan(
      inside[0]!.satisfaction,
    );
    const sold = (s: GameState) =>
      Object.values(s.stock).reduce((a, b) => a + b, 0);
    expect(sold(tickTo(hh, 300))).toBeLessThan(sold(tickTo(base, 300)));
  });
});

describe("escortGuest", () => {
  it("removes a tilt guest; needs security and a valid target", () => {
    let s = startNight({ ...createBasement(1), hype: 60 });
    s = tickTo(s, 30);
    const g = s.night!.guests.find(isInside)!;
    expect(
      escortGuest({ ...s, staff: { ...s.staff, security: 2 } }, g.id),
    ).toMatchObject({
      reason: "invalidTarget",
    });
    const tilt = {
      ...s,
      night: {
        ...s.night!,
        guests: s.night!.guests.map((x) =>
          x.id === g.id ? { ...x, tilt: 90 } : x,
        ),
      },
    };
    expect(escortGuest(tilt, g.id)).toMatchObject({ reason: "noStaff" });
    const withSec = { ...tilt, staff: { ...tilt.staff, security: 2 } };
    expect(ok(escortGuest(withSec, g.id)).night!.guests[g.id]!.state).toBe(
      "left",
    );
  });
});

describe("The Basement scenario", () => {
  it("starts at Level 4 with a liquor permit about to expire", () => {
    const s = createBasement(1);
    expect(s.mode).toBe("basement");
    expect(s.level).toBe(4);
    expect(s.permits.liquorOnPremise.expiresDay).toBe(5);
    expect(s.stock.tsla).toBeGreaterThan(0);
  });

  it("day events: rival promo (Day 5), late supplier (Day 6), inspector (Day 7)", () => {
    let s = createBasement(1);
    const advance = () => (s = nextDay(runNight(s)));
    for (let d = 1; d < 5; d++) advance();
    expect(s.log.some((e) => e.kind === "rivalPromo" && e.day === 5)).toBe(
      true,
    );
    advance();
    expect(s.supplierDelay).toBe(1);
    expect(
      ok(r01_orderStock(s, "tsla", 10, "corner")).pendingOrders[0]!.arrivesDay,
    ).toBe(7);
    advance();
    expect(s.forcedInspection).toBe(true);
  });

  it("ends after Day 7 with victory or survived", () => {
    let s = createBasement(1);
    s = ok(applyPermit(s, "liquorOnPremise"));
    for (let d = 1; d <= 7 && !s.outcome; d++) {
      s = runNight(s);
      if (d < 7) s = nextDay(s);
    }
    expect(["victory", "survived", "defeat"]).toContain(s.outcome);
    expect(nextDay(s)).toBe(s);
  });
});

describe("objectives", () => {
  it("career Day 1 tutorial: order stock, then open the booth", () => {
    let s = createGameState(1);
    expect(objectives(s).map((o) => o.done)).toEqual([false, false]);
    s = ok(r01_orderStock(s, "tsla", 20, "corner"));
    expect(objectives(s).map((o) => o.done)).toEqual([true, false]);
    s = startNight(s);
    expect(objectives(s).every((o) => o.done)).toBe(true);
  });

  it("career later days point at the next level", () => {
    const s = { ...createGameState(1), day: 3 };
    expect(objectives(s)).toEqual([
      { id: "saveCoin", target: 50_000, current: 10_000, done: false },
      { id: "reachRep", target: 20, current: 20, done: true },
    ]);
  });

  it("basement Day 1 counts tonight's guests", () => {
    let s = startNight({ ...createBasement(1), hype: 80 });
    while (!nightOver(s)) s = tickNight(s);
    s = endNight(s);
    const g = objectives(s).find((o) => o.id === "reachGuests")!;
    expect(g.current).toBe(s.lastReport!.guests);
  });
});

describe("nightPromote (it's quiet, post a promo)", () => {
  const night = (minute: number) => {
    const s = startNight({ ...createBasement(4), hype: 20 });
    return { ...s, night: { ...s.night!, minute } };
  };

  it("mid-night: pays like R5 and brings extra guests who arrive later tonight", () => {
    const s = night(90);
    const r = nightPromote(s, "tiktok");
    if (!r.ok) throw new Error(r.reason);
    const added = r.state.night!.guests.slice(s.night!.guests.length);
    expect(added.length).toBeGreaterThan(0);
    expect(r.state.coin).toBeLessThan(s.coin);
    expect(r.state.ceoEnergy).toBe(s.ceoEnergy - 1);
    expect(
      added.every(
        (g, i) => g.id === s.night!.guests.length + i && g.arriveMinute > 90,
      ),
    ).toBe(true);
    // The added guests really show up.
    let t = r.state;
    while (!nightOver(t)) t = tickNight(t);
    expect(
      t.night!.guests.slice(s.night!.guests.length).some((g) => g.admitted),
    ).toBe(true);
  });

  it("last hour: still pays, but nobody new is coming", () => {
    const s = night(330);
    const r = nightPromote(s, "tiktok");
    expect(r.ok && r.state.night!.guests.length).toBe(s.night!.guests.length);
  });

  it("by day it is just R5", () => {
    const s = createBasement(4);
    expect(nightPromote(s, "tiktok")).toEqual(r05_promote(s, "tiktok"));
  });
});
