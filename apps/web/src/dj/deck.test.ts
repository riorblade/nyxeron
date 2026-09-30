import { describe, expect, it } from "vitest";
import { syncSpeed } from "./deck";

describe("sync", () => {
  it("matches the same BPM when the fader can reach it", () => {
    expect(syncSpeed(128, 124)).toBeCloseTo(128 / 124);
    expect(syncSpeed(120, 174)).toBeCloseTo(120 / 174);
  });
  it("falls back to half/double time for tracks far apart", () => {
    expect(syncSpeed(174, 87 / 1.02)).toBeCloseTo(174 / (87 / 1.02) / 2);
    expect(syncSpeed(60, 140)).toBeCloseTo((60 / 140) * 2);
  });
});
