import { compactForSave, migrateState, type GameState } from "@nyxeron/core";
import { syncHooks, userKey } from "./scope";

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

export function readSave(slot: Slot): SaveFile | null {
  try {
    return deserialize(localStorage.getItem(key(slot)));
  } catch {
    return null;
  }
}
