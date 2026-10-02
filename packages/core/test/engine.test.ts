import { describe, expect, it } from "vitest";
import {
  createGameState,
  ids,
  tokens,
  endNight,
  expectedGuests,
  isInside,
  isPeakTime,
  night,
  levels,
  nightOver,
  runNight,
  startNight,
  tickNight,
  type GameState,
} from "../src";
import { playWeek } from "./playthrough";

const permits = (crowd: boolean): GameState["permits"] => ({
  business: { valid: true, expiresDay: 99 },
  liquorTakeaway: { valid: false, expiresDay: 0 },
  liquorOnPremise: { valid: true, expiresDay: 99 },
  crowd: { valid: crowd, expiresDay: crowd ? 99 : 0 },
});
const club = (over: Partial<GameState> = {}): GameState => ({
  ...createGameState(3),
  level: 4,
  coin: 100_000,
  reputation: 60,
  hype: 60,
  permits: permits(true),
  ...over,
});

describe("night engine", () => {
  it("expected guests follow hype, rep and busy weekdays", () => {
    expect(expectedGuests(club({ hype: 80 }))).toBeGreaterThan(
      expectedGuests(club({ hype: 20 })),
    );
    expect(expectedGuests(club({ day: 7 }))).toBeGreaterThan(
      expectedGuests(club({ day: 2 })),
    );
  });

  it("runs 22:00 → 04:00 and ends in the report phase with everyone gone", () => {
    const s = runNight(club());
    expect(s.phase).toBe("report");
    expect(s.night!.minute).toBe(360);
    expect(s.night!.guests.every((g) => g.state === "left")).toBe(true);
    expect(s.lastReport!.guests).toBeGreaterThan(0);
    expect(s.lastReport!.revenue.cover).toBe(
      s.lastReport!.guests * levels[4].coverCharge,
    );
  });

  it("R10: never exceeds capacity unless the door is forced", () => {
    let s = startNight(club({ hype: 100, reputation: 100, day: 7 }));
    let peak = 0;
    while (!nightOver(s)) {
      s = tickNight(s);
      peak = Math.max(peak, s.night!.guests.filter(isInside).length);
    }
    expect(peak).toBe(levels[4].capacity);
    expect(s.log.some((e) => e.kind === "doorClosed")).toBe(true);
  });

  it("R7: over 150 guests without crowd permit can be shut down; never with the permit", () => {
    const busy = { hype: 100, reputation: 100, day: 7 };
    const noPermit = Array.from({ length: 20 }, (_, seed) =>
      runNight(club({ ...busy, seed, permits: permits(false) })),
    );
    const shut = noPermit.filter((s) => s.lastReport!.shutDown);
    expect(shut.length).toBeGreaterThan(0);
    expect(shut[0]!.reputation).toBeLessThan(100);
    const withPermit = Array.from({ length: 20 }, (_, seed) =>
      runNight(club({ ...busy, seed })),
    );
    expect(withPermit.some((s) => s.lastReport!.shutDown)).toBe(false);
  });

  it("R8: without security underage guests get in; with security they are rejected", () => {
    const noSec = startNight(club());
    const s1 = runNight(club());
    const underage = noSec.night!.guests.filter((g) => g.underage).length;
    expect(underage).toBeGreaterThan(0);
    expect(s1.night!.underageAdmitted).toBe(underage);
    const s2 = runNight(
      club({
        staff: { bartender: 0, security: 5, host: 0, relations: 0, mc: 0 },
      }),
    );
    expect(s2.night!.underageAdmitted).toBe(0);
    expect(s2.lastReport!.rejectedUnderage).toBe(underage);
  });

  it("R6 + R16: forced inspection with takeaway-only permit → violation, fine, sealed next night", () => {
    const p = {
      ...permits(true),
      liquorOnPremise: { valid: false, expiresDay: 0 },
      liquorTakeaway: { valid: true, expiresDay: 99 },
    };
    const s = runNight(
      club({
        permits: p,
        forcedInspection: true,
        staff: { bartender: 0, security: 5, host: 0, relations: 0, mc: 0 },
      }),
    );
    expect(s.violations).toBe(1);
    expect(s.lastReport!.fines).toBe(5000);
    expect(s.sealedNights).toBe(1);
    const sealed = runNight({ ...s, phase: "day" });
    expect(sealed.lastReport!.sealed).toBe(true);
    expect(sealed.lastReport!.guests).toBe(0);
  });

  it("endNight is a no-op mid-night; startNight is a no-op outside the day phase", () => {
    const s = tickNight(startNight(club()));
    expect(endNight(s)).toBe(s);
    expect(startNight(s)).toBe(s);
  });
});

describe("7-day Level 4 playthrough (The Basement, Week 1)", () => {
  it("is deterministic for a seed", () => {
    expect(playWeek(42)).toEqual(playWeek(42));
    expect(playWeek(42).reports).not.toEqual(playWeek(43).reports);
  });

  it("survives the week with a sane report every night", () => {
    const { state, reports } = playWeek(42);
    expect(state.outcome).toBeNull();
    expect(state.day).toBe(8);
    expect(reports).toHaveLength(7);
    for (const r of reports) {
      expect(r.guests).toBeGreaterThan(0);
      expect(r.guests).toBeLessThanOrEqual(
        expectedGuests({
          ...state,
          hype: 100,
          reputation: 100,
          safety: 100,
          day: 7,
        }),
      );
      expect(r.tax).toBe(
        Math.round(
          (r.revenue.bar + r.revenue.cover + r.revenue.table) *
            levels[4].entertainmentTaxRate,
        ),
      );
      expect(r.avgSatisfaction).toBeGreaterThanOrEqual(0);
      expect(r.avgSatisfaction).toBeLessThanOrEqual(100);
      expect(r.shutDown).toBe(false);
    }
    // Saturday (Day 7) is the busy event night.
    expect(reports[6]!.guests).toBeGreaterThan(reports[1]!.guests);
  });
});

describe("genreForecast", () => {
  it("sums to 1, favours the club genre, and shifts with promos", async () => {
    const { genreForecast } = await import("../src");
    const f = genreForecast(club({ clubGenre: "techno" }));
    expect(Object.values(f).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Math.max(...Object.values(f))).toBe(f.techno);
    const withGenZ = genreForecast(club({ activePromos: ["tiktok"] }));
    expect(withGenZ.hiphop!).toBeGreaterThan(genreForecast(club()).hiphop!);
  });
});

describe("night report factors + stock forecast", () => {
  it("counts stockouts and slow service; forecast covers the menu", async () => {
    const { stockForecast } = await import("../src");
    const dry = runNight(club({ hype: 80 })); // no stock, no bartenders
    expect(dry.lastReport!.outOfStockHits).toBeGreaterThan(0);
    expect(dry.lastReport!.djMatch).toBeNull();
    const f = stockForecast(club());
    // Every token on this level's menu (and nothing locked above it).
    expect(Object.keys(f).sort()).toEqual(
      ids(tokens)
        .filter((t) => tokens[t].minLevel <= 4)
        .sort(),
    );
    expect(f.tsla).toBeGreaterThan(0);
  });
});

describe("isPeakTime", () => {
  const at = (minute: number, dj: boolean) => {
    const s = startNight(club({ bookedTalent: dj ? ["sable"] : [] }));
    return { ...s, night: { ...s.night!, minute } };
  };
  it("is true only inside the peak window with a DJ booked", () => {
    expect(isPeakTime(at(night.peakStartMinute - 1, true))).toBe(false);
    expect(isPeakTime(at(night.peakStartMinute, true))).toBe(true);
    expect(isPeakTime(at(night.peakEndMinute - 1, true))).toBe(true);
    expect(isPeakTime(at(night.peakEndMinute, true))).toBe(false);
    expect(isPeakTime(at(night.peakStartMinute, false))).toBe(false);
  });
  it("is false by day", () => {
    expect(isPeakTime(club({ bookedTalent: ["sable"] }))).toBe(false);
  });
});
