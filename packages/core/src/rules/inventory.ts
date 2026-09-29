import {
  drinks,
  priceScale,
  type Level,
  economy,
  suppliers,
  type DrinkId,
  type SupplierId,
} from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState } from "../state";
import { stockHeld, storageOf } from "./strategy";

export function orderCost(
  drink: DrinkId,
  qty: number,
  supplier: SupplierId,
  level: Level = 1,
): number {
  return Math.round(
    drinks[drink].buyCost *
      priceScale(level) *
      qty *
      suppliers[supplier].costMultiplier,
  );
}

/** R1: order stock if coin ≥ cost; arrives after supplier lead time (0 = now). Also allowed at night (emergency restock). */
export function r01_orderStock(
  s: GameState,
  drink: DrinkId,
  qty: number,
  supplier: SupplierId,
): ActionResult {
  if (!Number.isInteger(qty) || qty <= 0) return fail("invalidQty");
  if (
    s.level < drinks[drink].minLevel ||
    s.level < suppliers[supplier].minLevel
  )
    return fail("levelLocked");
  // The stock room only holds so much (stock on hand + already on the way).
  const room = storageOf(s) - stockHeld(s);
  if (qty > room) return fail("storageFull", Math.max(0, room));
  const cost = orderCost(drink, qty, supplier, s.level);
  if (s.coin < cost) return fail("notEnoughCoin", cost - s.coin);

  const arrivesDay = s.day + suppliers[supplier].leadDays + s.supplierDelay;
  const next: GameState = {
    ...s,
    coin: s.coin - cost,
    pendingOrders: [...s.pendingOrders, { drink, qty, supplier, arrivesDay }],
    log: [
      ...s.log,
      { day: s.day, kind: "orderPlaced", drink, qty, cost, arrivesDay },
    ],
  };
  return { ok: true, state: deliverOrders(next) };
}

/** Moves every order whose arrivesDay has come into stock. */
export function deliverOrders(s: GameState): GameState {
  const due = s.pendingOrders.filter((o) => o.arrivesDay <= s.day);
  if (due.length === 0) return s;
  const stock = { ...s.stock };
  for (const o of due) stock[o.drink] += o.qty;
  return {
    ...s,
    stock,
    pendingOrders: s.pendingOrders.filter((o) => o.arrivesDay > s.day),
    log: [
      ...s.log,
      ...due.map((o) => ({
        day: s.day,
        kind: "orderDelivered" as const,
        drink: o.drink,
        qty: o.qty,
      })),
    ],
  };
}

/**
 * R2: guest orders a drink. In stock → stock −1, coin +price (bar revenue).
 * Out of stock → satisfaction −10; the caller raises the "Out of Stock" alert (once per drink per night).
 */
export function r02_serveDrink(
  s: GameState,
  drink: DrinkId,
  price = s.prices[drink],
): { state: GameState; satisfactionDelta: number; outOfStock: boolean } {
  if (s.stock[drink] <= 0)
    return {
      state: s,
      satisfactionDelta: -economy.outOfStockSatisfactionPenalty,
      outOfStock: true,
    };
  return {
    state: {
      ...s,
      stock: { ...s.stock, [drink]: s.stock[drink] - 1 },
      coin: s.coin + price,
      nightRevenue: { ...s.nightRevenue, bar: s.nightRevenue.bar + price },
    },
    satisfactionDelta: 0,
    outOfStock: false,
  };
}

export function setPrice(
  s: GameState,
  drink: DrinkId,
  price: number,
): ActionResult {
  if (!Number.isInteger(price) || price <= 0) return fail("invalidPrice");
  return { ok: true, state: { ...s, prices: { ...s.prices, [drink]: price } } };
}
