import { night, staffRoles, type StaffRole } from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState } from "../state";

export function hireStaff(s: GameState, role: StaffRole): ActionResult {
  if (s.level < staffRoles[role].minLevel) return fail("levelLocked");
  return {
    ok: true,
    state: { ...s, staff: { ...s.staff, [role]: s.staff[role] + 1 } },
  };
}

export function fireStaff(s: GameState, role: StaffRole): ActionResult {
  if (s.staff[role] <= 0) return fail("noStaff");
  return {
    ok: true,
    state: { ...s, staff: { ...s.staff, [role]: s.staff[role] - 1 } },
  };
}

/**
 * R8: underage guest at the door is rejected only if security is present.
 * Before security unlocks (Level 4) the owner checks IDs at the counter, so the risk starts with the club.
 */
export const r08_rejectAtDoor = (s: GameState, underage: boolean) =>
  underage && (s.staff.security > 0 || s.level < staffRoles.security.minLevel);

/** R9: per-minute fight chance for a guest; high when tilt ≥ 80 and security:guests < 1:40. */
export function r09_fightChance(
  s: GameState,
  tilt: number,
  guestsInside: number,
): number {
  if (tilt < night.fightTiltThreshold) return 0;
  const understaffed =
    s.staff.security * night.guestsPerSecurity < guestsInside;
  return understaffed
    ? night.fightChancePerMinute.understaffed
    : night.fightChancePerMinute.staffed;
}

/** R10: door closes at capacity unless the player forces it open (which is a violation, applied once). */
export function r10_forceDoorOpen(s: GameState): ActionResult {
  if (!s.night) return fail("wrongPhase");
  if (s.night.doorForced) return fail("alreadyActive");
  return {
    ok: true,
    state: {
      ...s,
      violations: s.violations + 1,
      night: {
        ...s.night,
        doorForced: true,
        violationsTonight: s.night.violationsTonight + 1,
      },
      log: [
        ...s.log,
        { day: s.day, minute: s.night.minute, kind: "doorForced" },
      ],
    },
  };
}

/** Security on shift tonight: guards busy with an escort, and tilt guests at fight risk still waiting for one. */
export function securityStatus(s: GameState): {
  total: number;
  busy: number;
  waiting: number;
} {
  const n = s.night;
  const busy = n ? n.escorts.filter((e) => e.until > n.minute).length : 0;
  const waiting = n
    ? n.guests.filter(
        (g) =>
          (g.state === "idle" || g.state === "bar" || g.state === "dance") &&
          g.tilt >= night.fightTiltThreshold,
      ).length
    : 0;
  return { total: s.staff.security, busy, waiting };
}
