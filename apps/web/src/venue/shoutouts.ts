import { syncHooks, userKey } from "@/scope";

/** Videotron shoutouts typed by the player: kept per account (and synced to it), no rendering here. */

const key = () => userKey("shoutouts", "nyxeron.shoutouts");
export const MAX_SHOUTOUTS = 8;
let list: string[] | null = null;

export function getShoutouts(): string[] {
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
  try {
    const json = JSON.stringify(list);
    localStorage.setItem(key(), json);
    if (!fromServer) syncHooks.shoutouts?.(json);
  } catch {
    // ponytail: storage blocked — messages last this session only.
  }
}
