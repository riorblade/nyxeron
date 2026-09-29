import { economy, ids, legal, levelData, staffRoles, wageOf } from "../data";
import type { GameState } from "../state";
import { deliverOrders } from "./inventory";

export function dailyWages(s: GameState): number {
  return ids(staffRoles).reduce(
    (sum, r) => sum + s.staff[r] * wageOf(r, s.level),
    0,
  );
}

/**
 * R12: new day → CEO energy reset, wages + rent deducted.
 * Also: deliver due orders, hype decays, safety recovers, tonight's bookings/promos clear.
 */
export function r12_newDay(s: GameState): GameState {
  const day = s.day + 1;
  const wages = dailyWages(s);
  const rent = levelData(s.level).rentPerDay;
  return deliverOrders({
    ...s,
    day,
    phase: "day",
    ceoEnergy: economy.ceoEnergyPerDay,
    ceoCallUsed: false,
    coin: s.coin - wages - rent,
    hype: Math.max(0, s.hype - economy.hypeDecayPerDay),
    safety: Math.min(100, s.safety + economy.safetyRecoveryPerDay),
    bookedTalent: [],
    activePromos: [],
    nightRevenue: { bar: 0, cover: 0, table: 0 },
    night: null,
    log: [...s.log, { day, kind: "upkeepPaid", wages, rent }],
  });
}

/**
 * R15: entertainment tax on the night's revenue (cover + table + bar), deducted at the Night Report.
 * Rate is per level: 40% for bars and clubs (Level 3+), 0 for the booth and shop.
 */
export function r15_entertainmentTax(s: GameState): {
  state: GameState;
  tax: number;
} {
  const { bar, cover, table } = s.nightRevenue;
  const revenue = bar + cover + table;
  const tax = Math.round(revenue * levelData(s.level).entertainmentTaxRate);
  return {
    state: {
      ...s,
      coin: s.coin - tax,
      log: [...s.log, { day: s.day, kind: "taxPaid", revenue, tax }],
    },
    tax,
  };
}

/** R13: bankrupt (coin < 0 for 3 days), 3 violations, or reputation 0 → defeat. Call once per day end. */
export function r13_checkDefeat(s: GameState): GameState {
  const negativeCashDays = s.coin < 0 ? s.negativeCashDays + 1 : 0;
  const lost =
    negativeCashDays >= economy.bankruptAfterNegativeDays ||
    s.violations >= legal.maxViolations ||
    s.reputation <= 0;
  return lost
    ? endGame({ ...s, negativeCashDays }, "defeat")
    : { ...s, negativeCashDays };
}

export function endGame(
  s: GameState,
  outcome: NonNullable<GameState["outcome"]>,
): GameState {
  return {
    ...s,
    outcome,
    log: [...s.log, { day: s.day, kind: "gameOver", outcome }],
  };
}
