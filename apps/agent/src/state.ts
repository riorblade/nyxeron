// The agent's memory between runs: the one swap it placed and hasn't got counted yet. Written before the swap is
// submitted and updated as it moves (order id, then tx), so a run that times out, crashes or loses the api leaves
// a record the next run resolves before it may buy again. Nothing secret is in it.
import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

/** Default: apps/agent/agent-state.json (gitignored), whatever the working directory. */
export const DEFAULT_STATE = fileURLToPath(
  new URL("../agent-state.json", import.meta.url),
);

export type Outstanding = {
  /** This record, so a run only ever clears the one it resolved. */
  id: string;
  token: string;
  usd: number;
  /** When the swap was about to be submitted (ms). */
  at: number;
  /** Set once the wallet accepted the swap; missing: the submit's outcome is unknown. */
  orderId?: string;
  /** Set once the wallet reported the swap's tx. */
  tx?: string;
  /** The api's last refusal that retrying won't fix, for the person who checks. */
  error?: string;
};

/** The outstanding swap, or undefined when there is none. An unreadable file is an error, never "none". */
export function load(path: string): Outstanding | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const o = JSON.parse(text) as Outstanding;
  if (!o || typeof o.token !== "string" || typeof o.usd !== "number")
    throw new Error(`${path}: not an agent state file`);
  return o;
}

const tmp = (path: string) => `${path}.${process.pid}.${randomUUID()}.tmp`;

/**
 * Takes the slot for a new swap: the record is written in full to a temporary file, then linked into place,
 * which fails if a record is already there (another run's, or one not resolved yet).
 */
export function claim(
  path: string,
  s: { token: string; usd: number },
): Outstanding {
  const o: Outstanding = { id: randomUUID(), at: Date.now(), ...s };
  const t = tmp(path);
  writeFileSync(t, JSON.stringify(o, null, 2) + "\n", { flag: "wx" });
  try {
    linkSync(t, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `an outstanding swap is recorded in ${path} (another run?): not buying`,
        { cause: e },
      );
    throw e;
  } finally {
    unlinkSync(t);
  }
  return o;
}

/**
 * Updates the record atomically (write a temporary file, rename over), only while the file still holds this
 * record: a run must never write an older record back over a newer one (or recreate one a person removed).
 */
export function save(path: string, o: Outstanding) {
  const current = load(path);
  if (current?.id !== o.id)
    throw new Error(
      `${path} is not the record this run holds (${o.id}; found ${current?.id ?? "none"}): not overwriting it`,
    );
  const t = tmp(path);
  writeFileSync(t, JSON.stringify(o, null, 2) + "\n", { flag: "wx" });
  renameSync(t, path);
}

/** Removes the record once resolved, unless it has been replaced by another run's meanwhile. */
export function clear(path: string, o: Outstanding) {
  if (load(path)?.id !== o.id) return;
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Takes the run lock (`<state>.lock`) for a whole --buy or --report run and returns its release. Created
 * exclusively; one that is already there is refused with its pid and age, never taken over: a run killed
 * outright (SIGKILL, power loss) leaves it behind, and a person checks that no agent runs, then removes it.
 */
export function lockRun(statePath: string): () => void {
  const path = `${statePath}.lock`;
  const id = randomUUID();
  try {
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, at: Date.now(), id }) + "\n",
      { flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let held = "unreadable";
    try {
      const l = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: unknown;
        at?: unknown;
      };
      if (typeof l.pid === "number" && typeof l.at === "number")
        held = `pid ${l.pid}, taken ${Math.round((Date.now() - l.at) / 60_000)} min ago`;
    } catch {
      // held stays "unreadable"
    }
    throw new Error(
      `another agent run holds ${path} (${held}): not running. If no agent is running (a killed run leaves it ` +
        `behind), remove it`,
      { cause: e },
    );
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try {
      // Only our own lock: if a person removed it and another run took it since, that one stays.
      const l = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
      if (l.id === id) unlinkSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") throw e; // a garbled lock (not ours) stays for a person
    }
  };
}
