import { describe, expect, it } from "vitest";
import { revealLoadAt } from "./landingMedia";

describe("revealLoadAt", () => {
  it("starts loading the reveal clip one viewport of scroll before the split opens", () => {
    // 4000px runway, 800px viewport, split opens at 84% → load from 64%.
    expect(revealLoadAt(0.84, 4000, 800)).toBeCloseTo(0.64);
  });

  it("keeps the reveal clip unloaded at the top of the page", () => {
    expect(revealLoadAt(0.84, 4000, 800)).toBeGreaterThan(0);
  });

  it("loads straight away when the runway is shorter than the lead", () => {
    expect(revealLoadAt(0.35, 600, 900)).toBe(0);
  });
});
