import { night } from "../data";

/** R11: avg satisfaction ≥ 70 → rep +3..+8 (linear up to 100); < 40 → rep −5; otherwise 0. */
export function r11_reputationDelta(avgSatisfaction: number): number {
  const [lo, hi] = night.repGainRange as [number, number];
  if (avgSatisfaction >= night.goodNightSatisfaction) {
    const t =
      (avgSatisfaction - night.goodNightSatisfaction) /
      (100 - night.goodNightSatisfaction);
    return Math.round(lo + t * (hi - lo));
  }
  return avgSatisfaction < night.badNightSatisfaction
    ? -night.repLossBadNight
    : 0;
}
