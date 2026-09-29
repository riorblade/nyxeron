import { night } from "../data";
import { fail, type ActionResult } from "../result";
import { clamp, type CeoCall, type GameState } from "../state";

const isInside = (state: string) =>
  state === "idle" || state === "bar" || state === "dance";

/** CEO Call (Q), once per night: "Happy Hour" (+satisfaction, cheaper drinks) or "Close Door" (no more admissions). */
export function ceoCall(s: GameState, call: CeoCall): ActionResult {
  if (s.phase !== "night" || !s.night) return fail("wrongPhase");
  if (s.ceoCallUsed) return fail("alreadyActive");
  const n = s.night;
  const next =
    call === "happyHour"
      ? {
          ...n,
          happyHour: true,
          guests: n.guests.map((g) =>
            isInside(g.state)
              ? {
                  ...g,
                  satisfaction: clamp(
                    g.satisfaction + night.happyHourSatisfaction,
                  ),
                }
              : g,
          ),
        }
      : { ...n, doorClosedByCeo: true };
  return {
    ok: true,
    state: {
      ...s,
      ceoCallUsed: true,
      night: next,
      log: [...s.log, { day: s.day, minute: n.minute, kind: "ceoCall", call }],
    },
  };
}

/** Alert "Drunk guest [Send Security]": a guest at fight risk is escorted out before anything happens. */
export function escortGuest(s: GameState, guestId: number): ActionResult {
  if (s.phase !== "night" || !s.night) return fail("wrongPhase");
  if (s.staff.security <= 0) return fail("noStaff");
  const g = s.night.guests[guestId];
  if (!g || !isInside(g.state) || g.drunk < night.fightDrunkThreshold)
    return fail("invalidTarget");
  return {
    ok: true,
    state: {
      ...s,
      night: {
        ...s.night,
        guests: s.night.guests.map((x) =>
          x.id === guestId ? { ...x, state: "left" } : x,
        ),
      },
      log: [
        ...s.log,
        {
          day: s.day,
          minute: s.night.minute,
          kind: "guestEscorted",
          guest: guestId,
        },
      ],
    },
  };
}

export const isAtFightRisk = (g: { drunk: number; state: string }) =>
  isInside(g.state) && g.drunk >= night.fightDrunkThreshold;
