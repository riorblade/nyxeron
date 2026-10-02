import { syncHooks, userKey } from "@/state/scope";

/** Videotron shoutouts typed by the player: kept per account (and synced to it), no rendering here. */

const key = () => userKey("shoutouts", "nyxeron.shoutouts");
export const MAX_SHOUTOUTS = 8;
let list: string[] | null = null;
/** In someone else's live club: the host's messages are on the board, not ours. */
let hosted: string[] | null = null;
const listeners = new Set<(list: string[]) => void>();

export function setHostedShoutouts(next: string[] | null) {
  hosted =
    next?.filter((x) => typeof x === "string").slice(0, MAX_SHOUTOUTS) ?? null;
}

/** Tell `fn` whenever this player's messages change (the live host shares them with the room). */
export function onShoutouts(fn: (list: string[]) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function getShoutouts(): string[] {
  if (hosted) return hosted;
  if (!list)
    try {
      const v = JSON.parse(localStorage.getItem(key()) ?? "[]") as unknown;
      list = Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .slice(0, MAX_SHOUTOUTS)
        : [];
    } catch {
      list = [];
    }
  return list;
}

/** Another player signed in (or their messages came from the server): read the store again. */
export function resetShoutouts() {
  list = null;
}

export function setShoutouts(next: string[], fromServer = false) {
  list = next.slice(0, MAX_SHOUTOUTS);
  for (const fn of listeners) fn(list);
  try {
    const json = JSON.stringify(list);
    localStorage.setItem(key(), json);
    if (!fromServer) syncHooks.shoutouts?.(json);
  } catch {
    // ponytail: storage blocked — messages last this session only.
  }
}
