import { describe, expect, it } from "vitest";
import { EQ_MIN } from "./deck";
import { entryAt, transitionMix, TRANSITIONS } from "./transitions";

describe("auto-set transitions", () => {
  it("every move ends with the old track gone and the new one at full volume", () => {
    for (const k of TRANSITIONS) {
      const end = transitionMix(k, 1);
      expect(end.in.fader).toBeCloseTo(1);
      expect(end.in.low).toBe(0);
      if (k !== "echo" && k !== "cut" && k !== "spin")
        expect(end.out.fader).toBeCloseTo(0);
    }
  });

  it("bass swap never plays both basses at once", () => {
    for (let p = 0; p <= 1; p += 0.05) {
      const m = transitionMix("bass", p);
      const bothFull =
        m.out.low === 0 && m.in.low === 0 && m.in.fader > 0 && m.out.fader > 0;
      expect(bothFull).toBe(false);
      expect(Math.min(m.out.low, m.in.low)).toBe(EQ_MIN);
    }
  });

  it("an equal-power fade keeps the level up in the middle", () => {
    const m = transitionMix("fade", 0.5);
    expect(m.out.fader ** 2 + m.in.fader ** 2).toBeCloseTo(1);
  });

  it("echo out feeds more echo as it goes; one-shot moves drop the new track at the end", () => {
    expect(transitionMix("echo", 0.8).out.echo).toBeGreaterThan(
      transitionMix("echo", 0.2).out.echo,
    );
    for (const k of ["cut", "echo", "spin"] as const) {
      expect(entryAt(k)).toBe(1);
      expect(transitionMix(k, 0.99).in.fader).toBe(0);
    }
    expect(entryAt("bass")).toBe(0);
  });
});
