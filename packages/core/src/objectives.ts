import { levels, scenarios, staffRoles, type Level } from "./data";
import { permitActive } from "./rules/legal";
import type { GameState } from "./state";

export type ObjectiveId =
  | "orderStock"
  | "openClub"
  | "postPromo"
  | "reachGuests"
  | "bookDj"
  | "hireSecurity"
  | "renewLiquor"
  | "noViolationsTonight"
  | "noOutOfStock"
  | "crowdPermit"
  | "reachRep"
  | "saveCoin"
  | "noViolations";

export interface Objective {
  id: ObjectiveId;
  done: boolean;
  target?: number;
  current?: number;
}

const guestsTonight = (s: GameState) =>
  s.night?.guests.filter((g) => g.admitted).length ?? 0;
const nightDone = (s: GameState) => s.phase === "report";

/** Today's objectives: tutorial on career Day 1–2, GDD Week 1 flow in The Basement, level-up goal otherwise. */
export function objectives(s: GameState): Objective[] {
  const today = s.log.filter((e) => e.day === s.day);
  const guests = (target: number): Objective => {
    const current = guestsTonight(s);
    return { id: "reachGuests", target, current, done: current >= target };
  };
  const rep = (target: number): Objective => ({
    id: "reachRep",
    target,
    current: s.reputation,
    done: s.reputation >= target,
  });
  const orderStock = {
    id: "orderStock",
    done: today.some((e) => e.kind === "orderPlaced"),
  } as const;
  const openClub = { id: "openClub", done: s.phase !== "day" } as const;
  const postPromo = {
    id: "postPromo",
    done: s.activePromos.length > 0,
  } as const;
  const cleanNight = {
    id: "noViolationsTonight",
    done: nightDone(s) && (s.night?.violationsTonight ?? 0) === 0,
  } as const;

  if (s.mode === "basement") {
    const liquorExp = scenarios.basement.permitExpiresDay.liquorOnPremise;
    const byDay: Record<number, Objective[]> = {
      1: [orderStock, guests(40)],
      2: [{ id: "bookDj", done: s.bookedTalent.length > 0 }, postPromo],
      3: [guests(80), { id: "hireSecurity", done: s.staff.security > 0 }],
      4: [
        {
          id: "renewLiquor",
          done: s.permits.liquorOnPremise.expiresDay > liquorExp,
        },
        cleanNight,
      ],
      5: [postPromo, cleanNight],
      6: [
        orderStock,
        {
          id: "noOutOfStock",
          done: nightDone(s) && !today.some((e) => e.kind === "outOfStock"),
        },
      ],
      7: [
        guests(180),
        { id: "crowdPermit", done: permitActive(s, "crowd") },
        rep(scenarios.basement.goalReputation),
        { id: "noViolations", done: s.violations === 0 },
      ],
    };
    return byDay[s.day] ?? [];
  }

  if (s.day === 1) return [orderStock, openClub];
  if (s.day === 2) return [postPromo, guests(15)];
  // From the venue where security unlocks, the door needs a guard (underage ID checks, the 1:40 ratio).
  const guard: Objective[] =
    s.level >= staffRoles.security.minLevel && s.staff.security === 0
      ? [{ id: "hireSecurity", done: false }]
      : [];
  if (s.level === 5) return [...guard, rep(80)];
  const next = levels[(s.level + 1) as Level];
  return [
    ...guard,
    {
      id: "saveCoin",
      target: next.cost,
      current: s.coin,
      done: s.coin >= next.cost,
    },
    rep(next.repRequired),
  ];
}
