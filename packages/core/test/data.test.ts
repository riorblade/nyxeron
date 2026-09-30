import { describe, expect, it } from "vitest";
import { channels, djs, tokens, levels, permits, suppliers } from "../src";

// Guards against typos when balancing JSON by hand.
describe("data", () => {
  it("every minLevel is 1..5 and every number is non-negative", () => {
    for (const table of [tokens, suppliers, permits, channels, djs])
      for (const row of Object.values(table)) {
        expect(row.minLevel).toBeGreaterThanOrEqual(1);
        expect(row.minLevel).toBeLessThanOrEqual(5);
        for (const v of Object.values(row))
          if (typeof v === "number") expect(v).toBeGreaterThanOrEqual(0);
      }
  });

  it("levels cost and rep requirements increase", () => {
    const l = Object.values(levels);
    for (let i = 1; i < l.length; i++) {
      expect(l[i]!.cost).toBeGreaterThan(l[i - 1]!.cost);
      expect(l[i]!.repRequired).toBeGreaterThan(l[i - 1]!.repRequired);
    }
  });
});
