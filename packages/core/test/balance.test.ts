import { describe, expect, it } from "vitest";
import { createGameState, type GameState } from "../src";
import { botDay } from "../scripts/bot";

// Guard rail for JSON tuning: a sensible player must be able to progress. Full report: `pnpm balance`.
describe("balance", () => {
  it("a sensible bot survives the first 30 days and reaches Level 2", () => {
    for (let seed = 1; seed <= 10; seed++) {
      let s: GameState = createGameState(seed);
      while (!s.outcome && s.day <= 30) s = botDay(s);
      expect(s.outcome).toBeNull();
      expect(s.level).toBeGreaterThanOrEqual(2);
    }
  });
});
