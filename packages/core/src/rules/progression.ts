import { economy, levels, priceScale, type Level } from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState } from "../state";
import { endGame } from "./economy";

/** R14: Level 5 and reputation ≥ 80 → victory. Day 60 without it → survived. */
export function r14_checkVictory(s: GameState): GameState {
  if (s.outcome) return s;
  if (s.level === 5 && s.reputation >= economy.victoryReputation)
    return endGame(s, "victory");
  if (s.day >= economy.maxDays) return endGame(s, "survived");
  return s;
}

/** R18: upgrade level if coin ≥ cost and rep ≥ requirement. */
export function r18_upgradeLevel(s: GameState): ActionResult {
  if (s.level === 5) return fail("maxLevel");
  const level = (s.level + 1) as Level;
  const { cost, repRequired } = levels[level];
  if (s.reputation < repRequired)
    return fail("notEnoughRep", repRequired - s.reputation);
  if (s.coin < cost) return fail("notEnoughCoin", cost - s.coin);
  return {
    ok: true,
    state: {
      ...s,
      level,
      coin: s.coin - cost,
      // A new venue comes with its own house rig.
      upgrades: { sound: 0, lighting: 0 },
      // Keep the player's markup: prices move with the venue's price scale.
      prices: Object.fromEntries(
        Object.entries(s.prices).map(([d, p]) => [
          d,
          Math.round((p * priceScale(level)) / priceScale(s.level)),
        ]),
      ) as GameState["prices"],
      log: [...s.log, { day: s.day, kind: "levelUp", level }],
    },
  };
}
