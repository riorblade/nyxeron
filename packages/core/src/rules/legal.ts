import {
  isId,
  legal,
  night,
  permits,
  requiredPermits,
  type PermitId,
} from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState } from "../state";

export const permitActive = (s: GameState, p: PermitId) =>
  s.permits[p].valid && s.day < s.permits[p].expiresDay;

/** Required permits for the current level that are missing or expired (crowd permit is handled by R7). */
export const missingPermits = (s: GameState) =>
  requiredPermits(s.level).filter((p) => !permitActive(s, p));

/** Apply or renew: an active permit is extended from its current expiry. */
export function applyPermit(s: GameState, permit: PermitId): ActionResult {
  if (s.outcome) return fail("wrongPhase"); // the game is over: the books are closed
  if (!isId(permits, permit)) return fail("invalidTarget");
  const p = permits[permit];
  if (s.level < p.minLevel) return fail("levelLocked");
  if (s.coin < p.cost) return fail("notEnoughCoin", p.cost - s.coin);
  const from = permitActive(s, permit) ? s.permits[permit].expiresDay : s.day;
  const expiresDay = from + p.durationDays;
  return {
    ok: true,
    state: {
      ...s,
      coin: s.coin - p.cost,
      permits: { ...s.permits, [permit]: { valid: true, expiresDay } },
      log: [
        ...s.log,
        { day: s.day, kind: "permitRenewed", permit, expiresDay },
      ],
    },
  };
}

/** R6 (+R17): chance an inspector shows up tonight. */
export function r06_inspectionChance(s: GameState): number {
  if (s.forcedInspection) return 1;
  const base =
    missingPermits(s).length > 0
      ? legal.inspectionChanceMissingPermit
      : legal.baseInspectionChance;
  // Fights get reported: a club with low safety draws inspectors.
  return s.safety < night.safety.riskyBelow
    ? Math.max(base, night.safety.riskyInspectionChance)
    : base;
}

/**
 * Inspection outcome. Fails on missing permits (R6) or underage guests let in without security (R8)
 * → fine + 1 violation. R16: on-premise drinking with only a takeaway liquor permit also seals the venue.
 */
export function inspect(s: GameState, underageAdmitted: number) {
  const missing = missingPermits(s);
  const underage = underageAdmitted > 0;
  const passed = missing.length === 0 && !underage;
  const r16 =
    missing.includes("liquorOnPremise") && permitActive(s, "liquorTakeaway")
      ? legal.sealedNightsOnTakeawayOnly
      : 0;
  return {
    passed,
    missing,
    underage,
    fine: passed ? 0 : legal.inspectionFine,
    sealNights: r16,
  };
}
