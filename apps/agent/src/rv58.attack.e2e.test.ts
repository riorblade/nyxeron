// Adversarial re-review of #58 with real processes: `node --import tsx main.ts` against a fake `baw` on PATH, a
// local api (http on 127.0.0.1) and Binance's list stubbed by a preload. Real O_EXCL races, real signals, SIGKILL.
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { locked } from "./plan";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const STATE_TS = fileURLToPath(new URL("./state.ts", import.meta.url));
const TX = "0x" + "ab".repeat(32);

let dir = "";
let statePath = "";
let lockPath = "";
let bawLog = "";
let server: Server;
let api = "";
let restocks: string[] = [];

const FAKE_BAW = `#!/usr/bin/env node
const fs = require("fs");
const sub = process.argv[3];
fs.appendFileSync(process.env.BAW_LOG, JSON.stringify({ sub, pid: process.pid }) + "\\n");
const mode = process.env.BAW_MODE || "";
const out = (o) => process.stdout.write(JSON.stringify(o));
if (sub === "quote") {
  if (mode === "quote-null") { process.stdout.write("null"); process.exit(0); }
  if (mode === "quote-nosuccess") { out({ success: false }); process.exit(1); }
  out({ success: true, data: { fromCoinSymbol: "USDC", fromCoinAmount: mode === "quote-500" ? "500" : "50",
    toCoinSymbol: "TSLAB", toCoinAmount: "0.125", slippage: 0.01 } });
} else if (sub === "swap") {
  if (mode.startsWith("swap-hang")) { setTimeout(() => {}, 600000); return; }
  out({ success: true, data: { orderId: "o1" } });
} else if (sub === "list") {
  out({ success: true, data: { list: [{ orderId: "o1", status: "FINISHED", txHash: "${TX}" }] } });
}
`;

const PRELOAD = `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("binance.com"))
    return new Response(JSON.stringify({ data: [{ chainId: "56", contractAddress: ${JSON.stringify(
      locked("tsla")!.contract,
    )}, symbol: "TSLAB", ticker: "TSLA" }] }));
  return real(url, init);
};
`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/agent/demand")
        return res.end(
          JSON.stringify({
            tokens: [
              {
                token: "tsla",
                ticker: "TSLA",
                onHand: 0,
                sold24h: 1,
                sold7d: 1,
                daysLeft: 0,
                suggested: 5,
              },
            ],
            coverDays: 3,
            at: 0,
            agentSpentTodayCents: 0,
            paused: false,
          }),
        );
      if (req.url === "/api/quotes")
        return res.end(
          JSON.stringify({
            quotes: { TSLA: 400 },
            source: "x",
            at: Date.now(),
          }),
        );
      restocks.push((JSON.parse(body) as { tx: string }).tx);
      res.end(
        JSON.stringify({ token: "tsla", units: 125, usdCents: 5000, tx: TX }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const children: ChildProcess[] = [];
beforeEach(() => {
  restocks = [];
  dir = mkdtempSync(join(tmpdir(), "rv58e2e-"));
  statePath = join(dir, "state.json");
  lockPath = `${statePath}.lock`;
  bawLog = join(dir, "baw.log");
  writeFileSync(bawLog, "");
  writeFileSync(join(dir, "baw"), FAKE_BAW);
  chmodSync(join(dir, "baw"), 0o755);
  writeFileSync(join(dir, "preload.mjs"), PRELOAD);
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const l of bawCalls()) {
    try {
      process.kill(l.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const bawCalls = () =>
  existsSync(bawLog)
    ? readFileSync(bawLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { sub: string; pid: number })
    : [];
const swapsPlaced = () => bawCalls().filter((c) => c.sub === "swap").length;

type Ran = { code: number | null; signal: string | null; err: string };

function agent(mode: string, ...args: string[]) {
  const c = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      join(dir, "preload.mjs"),
      MAIN,
      ...(args.length ? args : ["--token", "tsla", "--buy"]),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}`,
        AGENT_STATE: statePath,
        AGENT_KEY: "k",
        AGENT_BUY_USD: "50",
        NYXERON_API: api,
        BAW_LOG: bawLog,
        BAW_MODE: mode,
      },
    },
  );
  children.push(c);
  let err = "";
  c.stderr!.on("data", (d: Buffer) => (err += d));
  const done = new Promise<Ran>((r) =>
    c.on("exit", (code, signal) => r({ code, signal, err })),
  );
  return { c, done };
}
const runAgent = (mode = "", ...args: string[]) => agent(mode, ...args).done;

async function until(cond: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const state = () =>
  JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;

test("e2e sanity: a plain buy swaps once, reports, clears record and lock", async () => {
  const r = await runAgent();
  expect(r.code).toBe(0);
  expect(swapsPlaced()).toBe(1);
  expect(restocks).toEqual([TX]);
  expect(existsSync(statePath)).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
});

test("attack: 8 processes race for the run lock at once; exactly one gets it (O_EXCL)", async () => {
  const script = `
    const { lockRun } = await import(${JSON.stringify(STATE_TS)});
    try { const rel = lockRun(${JSON.stringify(statePath)}); console.log("WON");
      await new Promise((r) => setTimeout(r, 3000)); rel(); }
    catch (e) { console.log("LOST"); }`;
  const ps = Array.from({ length: 8 }, () => {
    const c = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: ROOT },
    );
    children.push(c);
    let out = "";
    c.stdout!.on("data", (d: Buffer) => (out += d));
    return new Promise<string>((r) => c.on("exit", () => r(out.trim())));
  });
  const outs = await Promise.all(ps);
  expect(outs.filter((o) => o === "WON").length).toBe(1);
  expect(outs.filter((o) => o === "LOST").length).toBe(7);
  expect(existsSync(lockPath)).toBe(false);
}, 60_000);

test("attack: two real --buy runs at once: one swap, the other refused by the lock", async () => {
  const a = agent("swap-hang");
  await until(() => swapsPlaced() === 1);
  const b = await runAgent("swap-hang");
  expect(b.code).toBe(1);
  expect(b.err).toMatch(/holds .*\.lock \(pid \d+/);
  expect(swapsPlaced()).toBe(1);
  a.c.kill("SIGKILL");
  await a.done;
}, 60_000);

test("attack: SIGKILL mid-swap leaves lock + record (no order id); later runs never swap until a person clears both", async () => {
  const a = agent("swap-hang");
  await until(() => swapsPlaced() === 1);
  a.c.kill("SIGKILL");
  expect((await a.done).signal).toBe("SIGKILL");
  expect(existsSync(lockPath)).toBe(true);
  expect(state()).toMatchObject({ token: "tsla", usd: 50 });
  expect(state().orderId).toBeUndefined();
  // the lock names a dead pid (as after pid reuse or a reboot): still not taken over
  const b = await runAgent();
  expect(b.code).toBe(1);
  expect(b.err).toMatch(new RegExp(`pid ${a.c.pid}`));
  rmSync(lockPath);
  const c = await runAgent();
  expect(c.code).toBe(1);
  expect(c.err).toMatch(/no order id/);
  expect(swapsPlaced()).toBe(1);
  expect(existsSync(lockPath)).toBe(false);
}, 60_000);

for (const sig of ["SIGTERM", "SIGINT"] as const)
  test(`attack: ${sig} mid-swap releases the lock, keeps the record; the next run buys nothing`, async () => {
    const a = agent("swap-hang");
    await until(() => swapsPlaced() === 1);
    a.c.kill(sig);
    const r = await a.done;
    expect(r.code).toBe(sig === "SIGTERM" ? 143 : 130);
    expect(existsSync(lockPath)).toBe(false);
    expect(state().orderId).toBeUndefined();
    const b = await runAgent();
    expect(b.code).toBe(1);
    expect(b.err).toMatch(/no order id/);
    expect(swapsPlaced()).toBe(1);
  }, 60_000);

// ---- FINDINGS: these fail on the PR head ----

// FINDING (medium): a wallet answer that is valid JSON but not an object ("null", {success:false} without error)
// throws inside execFile's callback: an uncaught exception, so `finally { release() }` never runs. A harmless
// QUOTE glitch (no money moved) leaves the run lock behind and every later cron run refuses until a person
// deletes it by hand.
for (const mode of ["quote-null", "quote-nosuccess"])
  test(`FINDING medium: a malformed wallet quote answer (${mode}) must not leave the run lock behind`, async () => {
    const r = await runAgent(mode);
    expect(r.code).not.toBe(0);
    expect(swapsPlaced()).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false); // fails: lock left, agent bricked
  }, 60_000);

// FINDING (nit): SIGHUP (ssh session closed on a manual run) isn't handled: the default action kills the run and
// the lock stays behind.
test("FINDING nit: SIGHUP mid-swap releases the lock like SIGTERM", async () => {
  const a = agent("swap-hang");
  await until(() => swapsPlaced() === 1);
  a.c.kill("SIGHUP");
  await a.done;
  expect(existsSync(lockPath)).toBe(false); // fails: lock left
}, 60_000);

// FINDING (nit): the price check uses AGENT_BUY_USD / toCoinAmount and never checks what the quote was for: a
// quote for 500 USDC → 0.125 TSLAB (really $4000 a share, 10x spot) passes as $400.
test("FINDING nit: a quote whose fromCoinAmount isn't the budget is refused", async () => {
  const r = await runAgent("quote-500");
  expect(r.code).toBe(1); // fails: it buys
  expect(swapsPlaced()).toBe(0);
}, 60_000);

// FINDING (medium): AGENT_STATE unset is only a warning. The record and the run lock both hang off the state
// path, so a manual run that forgets AGENT_STATE (or a run from another checkout/host) sees "nothing outstanding"
// and no lock while cron's swap is still pending under /var/lib/...: it buys again, and the pending swap isn't
// in the api's spend yet, so the daily cap doesn't stop it either.
test("FINDING medium: a --buy that forgets AGENT_STATE must not buy while cron's swap is outstanding", async () => {
  const fallback = fileURLToPath(
    new URL("../agent-state.json", import.meta.url),
  );
  const a = agent("swap-hang"); // cron, AGENT_STATE set
  await until(() => swapsPlaced() === 1);
  a.c.kill("SIGTERM");
  await a.done;
  expect(state()).toMatchObject({ usd: 50 }); // swap outstanding
  try {
    const saved = statePath;
    statePath = ""; // the operator's shell: AGENT_STATE not exported
    const b = await runAgent();
    statePath = saved;
    expect(b.err).toMatch(/AGENT_STATE is not set/);
    expect(swapsPlaced()).toBe(1); // fails: 2 swaps, $100 out for one restock
  } finally {
    rmSync(fallback, { force: true });
    rmSync(`${fallback}.lock`, { force: true });
  }
}, 60_000);
