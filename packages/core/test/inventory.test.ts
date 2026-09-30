import { describe, expect, it } from "vitest";
import {
  orderCost,
  createGameState,
  r01_orderStock,
  r02_sellToken,
  r12_newDay,
  type GameState,
} from "../src";

const ok = (r: ReturnType<typeof r01_orderStock>): GameState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};

describe("R1 orderStock", () => {
  it("corner store (lead 0): coin down, stock up immediately", () => {
    const s = ok(r01_orderStock(createGameState(1), "tsla", 10, "corner"));
    expect(s.coin).toBe(10_000 - orderCost("tsla", 10, "corner"));
    expect(s.stock.tsla).toBe(10);
    expect(s.pendingOrders).toEqual([]);
  });

  it("lead time > 0: stock arrives on the right day", () => {
    const s0 = { ...createGameState(1), level: 2 as const };
    let s = ok(r01_orderStock(s0, "nvda", 5, "import")); // lead 2
    expect(s.stock.nvda).toBe(0);
    s = r12_newDay(s);
    expect(s.stock.nvda).toBe(0);
    s = r12_newDay(s);
    expect(s.stock.nvda).toBe(5);
    expect(s.pendingOrders).toEqual([]);
  });

  it("fails without enough coin, reporting the shortfall", () => {
    const s = { ...createGameState(1), coin: 5 };
    expect(r01_orderStock(s, "tsla", 1, "corner")).toEqual({
      ok: false,
      reason: "notEnoughCoin",
      short: orderCost("tsla", 1, "corner") - 5,
    });
  });

  it("fails for locked drink/supplier and bad qty", () => {
    const s = createGameState(1);
    expect(r01_orderStock(s, "nvda", 1, "corner")).toMatchObject({
      reason: "levelLocked",
    });
    expect(r01_orderStock(s, "tsla", 1, "wholesale")).toMatchObject({
      reason: "levelLocked",
    });
    expect(r01_orderStock(s, "tsla", 0, "corner")).toMatchObject({
      reason: "invalidQty",
    });
    expect(r01_orderStock(s, "tsla", 1.5, "corner")).toMatchObject({
      reason: "invalidQty",
    });
  });
});

describe("R2 serveDrink", () => {
  it("in stock: stock −1, coin + price, bar revenue tracked", () => {
    const s0 = {
      ...createGameState(1),
      stock: { ...createGameState(1).stock, tsla: 2 },
    };
    const { state, satisfactionDelta } = r02_sellToken(s0, "tsla");
    expect(state.stock.tsla).toBe(1);
    expect(state.coin).toBe(s0.coin + s0.prices.tsla);
    expect(state.nightRevenue.bar).toBe(s0.prices.tsla);
    expect(satisfactionDelta).toBe(0);
  });

  it("out of stock: satisfaction −10, flagged for the alert, state unchanged", () => {
    const s0 = createGameState(1);
    const { state, satisfactionDelta, outOfStock } = r02_sellToken(s0, "tsla");
    expect(satisfactionDelta).toBe(-10);
    expect(outOfStock).toBe(true);
    expect(state).toBe(s0);
  });
});
