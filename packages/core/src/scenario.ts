import {
  defaultPrice,
  tokens,
  ids,
  permits,
  scenarios,
  type TokenId,
  type PermitId,
} from "./data";
import { clamp, createGameState, type GameState } from "./state";

const basement = scenarios.basement;
type DayEvent = {
  rivalHype?: number;
  supplierDelay?: number;
  forcedInspection?: boolean;
};

/** Level 4 "The Basement", Week 1 challenge. */
export function createBasement(seed: number): GameState {
  const s = createGameState(seed, basement.clubGenre, {
    clubName: basement.clubName,
  });
  const stock = { ...s.stock };
  for (const d of ids(tokens))
    stock[d] = (basement.stock as Record<TokenId, number>)[d] ?? 0;
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
      ids(tokens).map((d) => [d, defaultPrice(d, 4)]),
    ) as GameState["prices"],
    coin: basement.coin,
    reputation: basement.reputation,
    hype: basement.hype,
    stock,
    staff: { ...s.staff, ...basement.staff },
    permits: perm,
  });
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
