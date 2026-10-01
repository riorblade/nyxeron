import { describe, expect, it } from "vitest";
import { FLAT } from "./deck";
import { DRIFT, followTarget, type DeckSync } from "./mixsync";

const deck = (over: Partial<DeckSync> = {}): DeckSync => ({
  track: "t",
  title: "T",
  playing: true,
  pos: 10,
  tempo: 1,
  reverse: false,
  loop: null,
  mix: FLAT,
  ...over,
});

describe("live DJ follow", () => {
  it("aims ahead of the DJ by the network delay, scaled by tempo and direction", () => {
    expect(followTarget(0, deck(), 0.1).target).toBeCloseTo(10.1);
    expect(followTarget(0, deck({ tempo: 1.2 }), 0.1).target).toBeCloseTo(
      10.12,
    );
    expect(followTarget(0, deck({ reverse: true }), 0.1).target).toBeCloseTo(
      9.9,
    );
    expect(followTarget(0, deck({ playing: false }), 0.1).target).toBe(10);
  });
  it("only seeks when the drift is audible", () => {
    expect(followTarget(10.1 + DRIFT / 2, deck(), 0.1).seek).toBe(false);
    expect(followTarget(10.1 + DRIFT * 2, deck(), 0.1).seek).toBe(true);
  });
});
