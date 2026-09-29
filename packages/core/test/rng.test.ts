import { describe, expect, it } from "vitest";
import { nextRandom } from "../src/rng";

describe("rng", () => {
  it("is deterministic per seed and stays in [0,1)", () => {
    const run = (seed: number) => {
      const out: number[] = [];
      for (let i = 0; i < 100; i++) {
        const [v, s] = nextRandom(seed);
        out.push(v);
        seed = s;
      }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
    expect(run(42).every((v) => v >= 0 && v < 1)).toBe(true);
  });
});
