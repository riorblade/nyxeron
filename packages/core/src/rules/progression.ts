import {
  economy,
  levels,
  maxPrice,
  priceScale,
  type Level,
  type TokenId,
} from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState } from "../state";
import { endGame } from "./economy";
import { stockHeld, storageOf } from "./strategy";

/** R14: Level 5 and reputation ≥ 80 → victory. Day 60 without it → survived. */
export function r14_checkVictory(s: GameState): GameState {
  if (s.outcome || s.mode === "event" || s.freePlay === "victory") return s; // an AI-run night never ends a career
  if (s.level === 5 && s.reputation >= economy.victoryReputation)
    return endGame(s, "victory");
  if (s.day >= economy.maxDays && !s.freePlay) return endGame(s, "survived");
  return s;
}

/** R18: upgrade level if coin ≥ cost and rep ≥ requirement. */
export function r18_upgradeLevel(s: GameState): ActionResult {
  if (s.level === 5) return fail("maxLevel");
  if (s.phase !== "day") return fail("wrongPhase");
  const level = (s.level + 1) as Level;
  const { cost, repRequired } = levels[level];
  if (s.reputation < repRequired)
    return fail("notEnoughRep", repRequired - s.reputation);
  if (s.coin < cost) return fail("notEnoughCoin", cost - s.coin);
  const rescale = priceScale(s.level) / priceScale(level);
  const NO_UPGRADES = {
    sound: 0,
    lighting: 0,
    vip: 0,
    capacity: 0,
    storage: 0,
  };
  // Old stock moves at its value, not its count: no buying cheap and selling at the new venue's prices.
  const scaled = (
    g: Pick<GameState, "stock" | "pendingOrders">,
    k: number,
  ): Pick<GameState, "stock" | "pendingOrders"> => ({
    stock: Object.fromEntries(
      Object.entries(g.stock).map(([d, q]) => [d, Math.floor(q * k)]),
    ) as GameState["stock"],
    pendingOrders: g.pendingOrders.map((o) => ({
      ...o,
      qty: Math.floor(o.qty * k),
    })),
  });
  let goods = scaled(s, rescale);
  // The new venue's stock room comes without the old one's extra storage tiers: what doesn't fit stays behind.
  const room = storageOf({ ...s, level, upgrades: NO_UPGRADES });
  const held = stockHeld({ ...s, ...goods });
  if (held > room) goods = scaled(goods, room / held);
  return {
    ok: true,
    state: {
      ...s,
      level,
      coin: s.coin - cost,
      // A new venue comes with its own house rig.
      upgrades: NO_UPGRADES,
      ...goods,
      // Keep the player's markup: prices move with the venue's price scale (up to the new venue's ceiling).
      prices: Object.fromEntries(
        Object.entries(s.prices).map(([d, p]) => [
          d,
          Math.min(
            maxPrice(d as TokenId, level),
            Math.round((p * priceScale(level)) / priceScale(s.level)),
          ),
        ]),
      ) as GameState["prices"],
      log: [...s.log, { day: s.day, kind: "levelUp", level }],
    },
  };
}
