import {
  defaultPrice,
  drinks,
  ids,
  permits,
  scenarios,
  type DrinkId,
  type PermitId,
} from "./data";
import { clamp, createGameState, type GameState } from "./state";

const basement = scenarios.basement;
type DayEvent = {
  rivalHype?: number;
  supplierDelay?: number;
  forcedInspection?: boolean;
};

/** Level 4 "The Basement", Week 1 challenge (GDD 15.3). */
export function createBasement(seed: number): GameState {
  const s = createGameState(seed, basement.clubGenre, {
    clubName: basement.clubName,
  });
  const stock = { ...s.stock };
  for (const d of ids(drinks))
    stock[d] = (basement.stock as Record<DrinkId, number>)[d] ?? 0;
  const perm = { ...s.permits };
  for (const p of ids(permits)) {
    const exp = (
      basement.permitExpiresDay as Partial<Record<PermitId, number>>
    )[p];
    perm[p] = exp
      ? { valid: true, expiresDay: exp }
      : { valid: false, expiresDay: 0 };
  }
  return applyDayEvents({
    ...s,
    mode: "basement",
    level: 4,
    prices: Object.fromEntries(
      ids(drinks).map((d) => [d, defaultPrice(d, 4)]),
    ) as GameState["prices"],
    coin: basement.coin,
    reputation: basement.reputation,
    hype: basement.hype,
    stock,
    staff: { ...s.staff, ...basement.staff },
    permits: perm,
  });
}

/** Sandbox: jump straight into the Premium Venue (Level 5) with money, permits, staff and stock. No win or loss. */
export function createSandbox(seed: number): GameState {
  const sb = scenarios.sandbox;
  const s = createGameState(seed, sb.clubGenre, { clubName: sb.clubName });
  const level = sb.level as GameState["level"];
  return {
    ...s,
    mode: "sandbox",
    level,
    coin: sb.coin,
    reputation: sb.reputation,
    hype: sb.hype,
    prices: Object.fromEntries(
      ids(drinks).map((d) => [d, defaultPrice(d, level)]),
    ) as GameState["prices"],
    stock: { ...s.stock, ...(sb.stock as Record<DrinkId, number>) },
    staff: { ...s.staff, ...sb.staff },
    permits: Object.fromEntries(
      ids(permits).map((p) => [
        p,
        { valid: true, expiresDay: 1 + sb.permitDays },
      ]),
    ) as GameState["permits"],
  };
}

/** Scripted events for the current day (rival promo, late supplier, surprise inspector). */
export function applyDayEvents(s: GameState): GameState {
  if (s.mode !== "basement") return s;
  const e = (basement.events as Record<string, DayEvent>)[s.day];
  if (!e) return s;
  const log = [...s.log];
  let next = { ...s };
  if (e.rivalHype) {
    next.hype = clamp(next.hype + e.rivalHype);
    log.push({ day: s.day, kind: "rivalPromo", hype: e.rivalHype });
  }
  if (e.supplierDelay) {
    next.supplierDelay = e.supplierDelay;
    log.push({ day: s.day, kind: "supplierDelay", days: e.supplierDelay });
  }
  if (e.forcedInspection) next.forcedInspection = true;
  next = { ...next, log };
  return next;
}

/** Basement ends after Day 7: goal = rep ≥ 60 and zero violations → victory, else survived. */
export function checkScenarioEnd(s: GameState): GameState {
  if (s.mode !== "basement" || s.outcome || s.day < basement.lastDay) return s;
  const outcome =
    s.reputation >= basement.goalReputation && s.violations === 0
      ? "victory"
      : "survived";
  return {
    ...s,
    outcome,
    log: [...s.log, { day: s.day, kind: "gameOver", outcome }],
  };
}
