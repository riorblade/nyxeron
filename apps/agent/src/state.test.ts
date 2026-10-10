import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claim, clear, load, lockRun, save } from "./state";

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-state-"));
  path = join(dir, "agent-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("claim takes the slot once; a second claim is refused until it is cleared", () => {
  expect(load(path)).toBeUndefined();
  const a = claim(path, { token: "tsla", usd: 3 });
  expect(load(path)).toEqual(a);
  expect(() => claim(path, { token: "tsla", usd: 3 })).toThrow(/outstanding/);
  clear(path, a);
  expect(load(path)).toBeUndefined();
  expect(readdirSync(dir)).toEqual([]); // no temporary files left behind
});

test("clear only removes the record it was given, not one another run put there since", () => {
  const a = claim(path, { token: "tsla", usd: 3 });
  clear(path, a);
  const b = claim(path, { token: "tsla", usd: 5 });
  clear(path, a);
  expect(load(path)).toEqual(b);
});

test("save replaces the record whole; an unreadable file is an error, never 'nothing outstanding'", () => {
  const a = claim(path, { token: "tsla", usd: 3 });
  save(path, { ...a, orderId: "o1", tx: "0xab" });
  expect(load(path)).toMatchObject({ orderId: "o1", tx: "0xab" });
  writeFileSync(path, "{not json");
  expect(() => load(path)).toThrow();
  writeFileSync(path, "{}");
  expect(() => load(path)).toThrow(/not an agent state file/);
});

// Review of #58, item 2: a run that resolved an older record can't write it back over a newer one.
test("save refuses to write over a record that isn't the one it was given", () => {
  const a = claim(path, { token: "tsla", usd: 3 });
  clear(path, a);
  const b = claim(path, { token: "tsla", usd: 5 });
  expect(() => save(path, { ...a, orderId: "o-old" })).toThrow(
    /not the record/,
  );
  expect(load(path)).toEqual(b);
  rmSync(path);
  expect(() => save(path, { ...b, orderId: "o1" })).toThrow(/not the record/);
  expect(load(path)).toBeUndefined();
});

test("lockRun: one holder at a time; a lock left behind is reported with its pid and age, never taken over", () => {
  const release = lockRun(path);
  expect(() => lockRun(path)).toThrow(/another agent run/);
  release();
  release(); // idempotent
  lockRun(path)();
  writeFileSync(
    `${path}.lock`,
    JSON.stringify({ pid: 999_999, at: Date.now() - 3 * 3600_000 }),
  );
  expect(() => lockRun(path)).toThrow(/999999.*180 min/s);
  expect(load(path)).toBeUndefined();
  writeFileSync(`${path}.lock`, "garbage");
  expect(() => lockRun(path)).toThrow(/lock/);
});
