import type { GameState } from "./state";

/** Player actions can fail; `reason` is an i18n key, `short` is the missing amount if any. */
export type ActionResult =
  | { ok: true; state: GameState }
  | {
      ok: false;
      reason:
        | "notEnoughCoin"
        | "notEnoughEnergy"
        | "notEnoughRep"
        | "levelLocked"
        | "maxLevel"
        | "invalidQty"
        | "invalidPrice"
        | "alreadyBooked"
        | "alreadyActive"
        | "noStaff"
        | "invalidTarget"
        | "wrongPhase";
      short?: number;
    };

export const fail = (
  reason: Extract<ActionResult, { ok: false }>["reason"],
  short?: number,
): ActionResult =>
  short === undefined ? { ok: false, reason } : { ok: false, reason, short };
