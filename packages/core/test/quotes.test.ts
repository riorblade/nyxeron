import { describe, expect, it } from "vitest";
import {
  createGameState,
  orderCost,
  platformFee,
  r01_orderStock,
  setQuotes,
  spotFactor,
  spotUnitCost,
  standardPrice,
  strategy,
  type GameState,
} from "../src";

const base = () => ({ ...createGameState(1), level: 3 as const });

describe("spot quotes (Binance RWA feed)", () => {
  it("no feed = factor 1; the first quote is the reference", () => {
    const s = base();
    expect(spotFactor(s, "tsla")).toBe(1);
    const q = setQuotes(s, { TSLA: 400 });
    expect(spotFactor(q, "tsla")).toBe(1);
    expect(spotFactor(setQuotes(q, { TSLA: 440 }), "tsla")).toBeCloseTo(1.1);
  });

  it("ignores junk prices", () => {
    const q = setQuotes(base(), { TSLA: 0, NVDA: Number.NaN });
    expect(q.quotes).toEqual({});
  });

  it("a basket moves with the weighted average of its legs it has quotes for", () => {
    let s = setQuotes(base(), { SPY: 100, QQQ: 200 });
    s = setQuotes(s, { SPY: 110, QQQ: 200 }); // SPY +10% at weight 50, QQQ flat at 30, IWM unknown
    expect(spotFactor(s, "us500")).toBeCloseTo((1.1 * 50 + 1 * 30) / 80);
  });

  it("the CEO pays spot: order cost and the standard price follow the market", () => {
    let s: GameState = { ...setQuotes(base(), { TSLA: 400 }), coin: 1e6 };
    const before = orderCost("tsla", 10, "corner", 3);
    s = setQuotes(s, { TSLA: 600 });
    const r = r01_orderStock(s, "tsla", 10, "corner");
    if (!r.ok) throw new Error(r.reason);
    expect(s.coin - r.state.coin).toBe(Math.round(before * 1.5));
    expect(standardPrice(s, "tsla")).toBe(
      Math.round(standardPrice(base(), "tsla") * 1.5),
    );
  });

  it("the platform takes its share of the spread over spot, nothing at or under spot", () => {
    const s = base();
    const spot = spotUnitCost(s, "tsla");
    expect(platformFee(s, "tsla", Math.floor(spot))).toBe(0);
    expect(platformFee(s, "tsla", spot + 100)).toBe(
      Math.round(100 * strategy.platform.feeShare),
    );
  });
});
