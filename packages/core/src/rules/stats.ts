import { economy, legal, night } from "../data";
import type { GameEvent, GameState } from "../state";

/**
 * Where a HUD number came from: the logged events that moved it, newest first. The UI explains each stat with
 * this (and the rules that move it), so nothing on the top bar is a mystery.
 */
export type Stat = "coin" | "reputation" | "hype" | "safety" | "violations";
export interface StatChange {
  day: number;
  minute?: number;
  delta: number;
  event: GameEvent;
}

function deltaOf(stat: Stat, e: GameEvent): number {
  switch (stat) {
    case "reputation":
      if (e.kind === "nightRep") return e.delta;
      if (e.kind === "fight") return -night.fightRepPenalty;
      if (e.kind === "controversialPromo" && e.backfired)
        return -legal.controversialPromo.repPenalty;
      if (e.kind === "crowdShutdown") return -legal.shutdownRepPenalty;
      return 0;
    case "safety":
      return e.kind === "fight" ? -night.fightSafetyPenalty : 0;
    case "violations":
      return (e.kind === "inspection" && !e.passed) || e.kind === "doorForced"
        ? 1
        : 0;
    case "hype":
      if (
        e.kind === "promoPosted" ||
        e.kind === "controversialPromo" ||
        e.kind === "djBooked" ||
        e.kind === "bandBooked" ||
        e.kind === "rivalPromo"
      )
        return e.hype;
      return 0;
    case "coin":
      if (e.kind === "orderPlaced") return -e.cost;
      if (e.kind === "upkeepPaid") return -(e.wages + e.rent);
      if (e.kind === "taxPaid") return -e.tax;
      if (e.kind === "upgradeBought") return -e.cost;
      if (e.kind === "inspection") return -e.fine;
      if (e.kind === "tablesSeated" || e.kind === "sparklerParade")
        return e.revenue;
      return 0;
  }
}

export function statHistory(s: GameState, stat: Stat, limit = 8): StatChange[] {
  const out: StatChange[] = [];
  for (let i = s.log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = s.log[i]!;
    const delta = deltaOf(stat, e);
    if (delta) out.push({ day: e.day, minute: e.minute, delta, event: e });
  }
  return out;
}

/** What moves each stat every day, without an event: hype fades, safety recovers. */
export const dailyDrift = {
  hype: -economy.hypeDecayPerDay,
  safety: economy.safetyRecoveryPerDay,
};
