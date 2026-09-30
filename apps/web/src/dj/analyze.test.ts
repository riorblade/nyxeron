import { describe, expect, it } from "vitest";
import { detectBpm, peaks } from "./analyze";

/** A click track: short decaying bursts every beat, starting `offset` seconds in. */
function clicks(bpm: number, offset: number, seconds = 20, rate = 22050) {
  const s = new Float32Array(seconds * rate);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const i0 = Math.round(t * rate);
    for (let k = 0; k < 400 && i0 + k < s.length; k++)
      s[i0 + k] = Math.sin(k * 0.3) * Math.exp(-k / 80);
  }
  return s;
}

describe("DJ track analysis", () => {
  it.each([96, 124, 128, 140, 170])("finds %i BPM", (bpm) => {
    expect(detectBpm(clicks(bpm, 0.3), 22050).bpm).toBeCloseTo(bpm, -0.5);
  });

  it("finds where the first beat is", () => {
    const { offset } = detectBpm(clicks(120, 0.25), 22050);
    expect(offset).toBeCloseTo(0.25, 1);
  });

  it("waveform peaks are 0..1 per bucket", () => {
    const p = peaks(clicks(120, 0), 100);
    expect(p).toHaveLength(100);
    expect(Math.max(...p)).toBeLessThanOrEqual(1);
    expect(Math.max(...p)).toBeGreaterThan(0.5);
  });
});
