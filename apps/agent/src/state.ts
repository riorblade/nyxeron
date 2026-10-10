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

/** Updates the record atomically (write a temporary file, rename over). */
export function save(path: string, o: Outstanding) {
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
