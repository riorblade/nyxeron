import { describe, expect, it } from "vitest";
import {
  createGameState,
  createRng,
  feelMarket,
  fomoFactor,
  marketPrice,
  recordBuy,
  startNight,
  night,
  strategy,
  tickMarket,
  tokens,
  type TokenId,
  type Guest,
  type NightState,
} from "../src";

const M = strategy.market;
const nightAt = (energy: number): NightState => ({
  ...startNight({ ...createGameState(1), coin: 100_000 }).night!,
  energy,
});
/** Mean multiplier of TSLA after `minutes` of trading, over many seeds. */
const meanAfter = (energy: number, pump = 0, minutes = 30) => {
  let sum = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const n = nightAt(energy);
    const rng = createRng(seed);
    for (let i = 0; i < minutes; i++) tickMarket(rng, n, ["tsla"], pump);
    sum += n.market.tsla!;
  }
  return sum / 50;
};

describe("token market", () => {
  it("stays inside its range even under a huge pump", () => {
    const n = nightAt(100);
    const rng = createRng(7);
    for (let i = 0; i < 600; i++) tickMarket(rng, n, ["tsla", "us500"], 1);
    expect(n.market.tsla).toBeLessThanOrEqual(M.range[1]!);
    expect(n.market.us500).toBeGreaterThanOrEqual(M.range[0]!);
    expect(n.marketHist.tsla).toHaveLength(600);
  });

  // The api cuts a guest's night P&L to what this move allows (services/api nightValueCap).
  it("within one night no token rises more than maxNightMove-fold, even in a packed room", () => {
    const menu = Object.keys(tokens) as TokenId[];
    let worst = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const n = nightAt(100);
      const rng = createRng(seed);
      for (let i = 0; i < night.minutes; i++)
        tickMarket(
          rng,
          n,
          menu,
          (i === 1 ? M.djStartPump : 0) + M.anthemPumpPerMinute,
        );
      for (const t of menu) {
        const h = [1, ...n.marketHist[t]!];
        worst = Math.max(worst, h.at(-1)! / Math.min(...h));
      }
    }
    expect(worst).toBeLessThan(M.maxNightMove);
  });

  it("a hot room drives prices up, a dead one down; the DJ pump lifts them", () => {
    expect(meanAfter(100)).toBeGreaterThan(meanAfter(0));
    expect(meanAfter(50, M.djStartPump, 1)).toBeGreaterThan(
      meanAfter(50, 0, 1),
    );
  });

  it("the sale price is the list price times the market", () => {
    const s = startNight({ ...createGameState(1), coin: 100_000 });
    const hot = { ...s, night: { ...s.night!, market: { tsla: 1.5 } } };
    expect(marketPrice(hot, "tsla", 100)).toBe(150);
    expect(marketPrice(s, "tsla", 100)).toBe(100);
  });

  it("FOMO: a token above its average draws buyers, below it puts them off", () => {
    const n = { ...nightAt(50), marketEma: { tsla: 1 } };
    expect(fomoFactor({ ...n, market: { tsla: 1.1 } }, "tsla")).toBeGreaterThan(
      1,
    );
    expect(fomoFactor({ ...n, market: { tsla: 0.9 } }, "tsla")).toBeLessThan(1);
  });

  it("a guest in the red loses mood and tilts; in the green cheers up", () => {
    const g = { satisfaction: 50, tilt: 0 } as Guest;
    recordBuy(g, 1);
    feelMarket(g, 0.8);
    expect(g.satisfaction).toBeLessThan(50);
    expect(g.tilt).toBeGreaterThan(0);
    const w = { satisfaction: 50, tilt: 0 } as Guest;
    recordBuy(w, 1);
    feelMarket(w, 1.2);
    expect(w.satisfaction).toBeGreaterThan(50);
    expect(w.tilt).toBe(0);
  });
});
