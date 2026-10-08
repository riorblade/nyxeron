import { describe, expect, it } from "vitest";
import {
  createGameState,
  expectedGuests,
  night,
  objectives,
  r06_inspectionChance,
  runNight,
  staffRoles,
  statHistory,
  type GameState,
} from "../src";

describe("HUD stats do something and can be explained", () => {
  it("low safety keeps guests away and draws inspectors", () => {
    const s = createGameState(1);
    const unsafe: GameState = { ...s, safety: 0 };
    expect(expectedGuests(unsafe)).toBeLessThan(expectedGuests(s));
    expect(expectedGuests(unsafe)).toBeGreaterThanOrEqual(
      Math.floor(expectedGuests(s) * night.safety.demandFloor) - 1,
    );
    expect(r06_inspectionChance({ ...s, safety: 39 })).toBe(
      night.safety.riskyInspectionChance,
    );
    expect(r06_inspectionChance(s)).toBeLessThan(
      night.safety.riskyInspectionChance,
    );
  });

  it("every reputation change after a night is in the history, and adds up", () => {
    const s: GameState = { ...createGameState(3), coin: 50_000 };
    const after = runNight(s);
    const rep = statHistory(after, "reputation", 100).filter(
      (c) => c.day === s.day,
    );
    expect(after.log.some((e) => e.kind === "nightRep")).toBe(true);
    // Fights, shutdowns and the night's satisfaction explain the whole move (clamped to 0–100).
    const sum = rep.reduce((a, c) => a + c.delta, 0);
    expect(after.reputation).toBe(
      Math.max(0, Math.min(100, s.reputation + sum)),
    );
  });

  it("fights show up under safety and reputation; violations under violations", () => {
    const s = createGameState(1);
    const fought: GameState = {
      ...s,
      log: [
        { day: 1, minute: 30, kind: "fight", guest: 4 },
        { day: 1, kind: "doorForced" },
      ],
    };
    expect(statHistory(fought, "safety")[0]!.delta).toBe(
      -night.fightSafetyPenalty,
    );
    expect(statHistory(fought, "reputation")[0]!.delta).toBe(
      -night.fightRepPenalty,
    );
    expect(statHistory(fought, "violations")).toHaveLength(1);
    expect(statHistory(fought, "hype")).toHaveLength(0);
  });
});

describe("security unlocks with the bar", () => {
  it("a Level 3 club without a guard is asked to hire one; with one, it isn't", () => {
    const s = createGameState(2, "edm", { level: 3 });
    const day3 = { ...s, day: 3 };
    expect(objectives(day3).map((o) => o.id)).toContain("hireSecurity");
    expect(
      objectives({ ...day3, staff: { ...day3.staff, security: 1 } }).map(
        (o) => o.id,
      ),
    ).not.toContain("hireSecurity");
    expect(staffRoles.security.minLevel).toBe(3);
  });
});
