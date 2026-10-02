import { compactForSave, migrateState, type GameState } from "@nyxeron/core";
import { syncHooks, userKey } from "@/state/scope";

/** Bump when GameState shape changes; older saves are then ignored instead of crashing the game. */
export const SAVE_VERSION = 1;
export type Slot = "auto" | 1 | 2 | 3;
export interface SaveFile {
  v: number;
  savedAt: number;
  state: GameState;
}

export const serialize = (state: GameState, now = Date.now()) =>
  JSON.stringify({
    v: SAVE_VERSION,
    savedAt: now,
    state: compactForSave(state),
  } satisfies SaveFile);

export function deserialize(raw: string | null): SaveFile | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as SaveFile;
    // Same version, but saves from before house rules / new staff get the new fields filled in.
    return f.v === SAVE_VERSION && f.state && typeof f.state.day === "number"
      ? { ...f, state: migrateState(f.state) }
      : null;
  } catch {
    return null;
  }
}

/** Saves belong to the signed-in player (scope.ts); every write also goes to their account on the server. */
export const saveKey = (slot: Slot | string) =>
  userKey(`save:${slot}`, `nyxeron:save:${slot}`);
const key = saveKey;

export function writeSave(slot: Slot, state: GameState): boolean {
  try {
    const raw = serialize(state);
    localStorage.setItem(key(slot), raw);
    syncHooks.save?.(String(slot), raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every practice club the player runs lives in its own slot (up to four) and saves itself after each night and
 * when leaving the game. ponytail: a club closed on one device can come back from another device's copy at its
 * next sign-in (no tombstones); add them if players report it.
 */
export const CLUB_SLOTS: Slot[] = ["auto", 1, 2, 3];

export const listClubs = () =>
  CLUB_SLOTS.flatMap((slot) => {
    const file = readSave(slot);
    return file ? [{ slot, file }] : [];
  });

export const freeSlot = (): Slot | null =>
  CLUB_SLOTS.find((s) => !readSave(s)) ?? null;

export function deleteSave(slot: Slot) {
  try {
    localStorage.removeItem(key(slot));
  } catch {
    /* storage blocked */
  }
  syncHooks.save?.(String(slot), null);
}

export function readSave(slot: Slot): SaveFile | null {
  try {
    return deserialize(localStorage.getItem(key(slot)));
  } catch {
    return null;
  }
}
