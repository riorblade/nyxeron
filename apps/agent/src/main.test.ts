// main.ts end to end with the wallet CLI (./baw) and Binance's list (./rwa) mocked, the api's fetch stubbed and
// fake timers: nothing is signed, broadcast or sent to a real network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { locked } from "./plan";

const TX = "0x" + "ab".repeat(32);
const swaps: unknown[][] = [];
let orderStatus: "PENDING" | "FINISHED" | "FAILED" = "FINISHED";
/** What the wallet quotes for the budget: 50 USDC → 0.125 TSLAB, $400 a share, the reference below. */
let received = "0.125";
let swapFails: Error | undefined;

vi.mock("./baw", async (orig) => {
  const real = await orig<typeof import("./baw")>();
  return {
    ...real,
    quote: vi.fn(async (usd: number) => ({
      fromCoinSymbol: "USDC",
      fromCoinAmount: String(usd),
      toCoinSymbol: "TSLAB",
      toCoinAmount: received,
      slippage: 0.01,
    })),
    swap: vi.fn(async (...a: unknown[]) => {
      if (swapFails) throw swapFails;
      swaps.push(a);
      return { orderId: `o${swaps.length}` };
    }),
    order: vi.fn(async (id: string) => ({
      orderId: id,
      status: orderStatus,
      txHash: orderStatus === "FINISHED" ? TX : null,
    })),
  };
});
vi.mock("./rwa", () => ({
  BSC: "56",
  bstocks: async () =>
    new Map([["TSLA", { symbol: "TSLAB", address: locked("tsla")!.contract }]]),
}));

type Api = {
  demand: unknown;
  quotes?: () => unknown;
  restock: () => Response;
};
let api: Api;
let restockCalls = 0;
let restockTx: string[] = [];
let calls: string[] = [];
let dir = "";

const restocked = () =>
  new Response(
    JSON.stringify({ token: "tsla", units: 125, usdCents: 5000, tx: TX }),
    { status: 200 },
  );
const quotes = (TSLA: number | undefined, at = Date.now()) => ({
  quotes: TSLA === undefined ? {} : { TSLA },
  source: "binance",
  at,
});

beforeEach(() => {
  swaps.length = 0;
  restockCalls = 0;
  restockTx = [];
  calls = [];
  orderStatus = "FINISHED";
  received = "0.125";
  swapFails = undefined;
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "agent-test-"));
  process.env.AGENT_STATE = join(dir, "agent-state.json");
  process.env.AGENT_KEY = "k";
  process.env.AGENT_BUY_USD = "50";
  process.env.NYXERON_API = "https://api.test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/api/agent/demand"))
        return new Response(JSON.stringify(api.demand), { status: 200 });
      if (url.endsWith("/api/quotes"))
        return new Response(
          JSON.stringify(api.quotes ? api.quotes() : quotes(400)),
          { status: 200 },
        );
      restockCalls++;
      restockTx.push((JSON.parse(String(init?.body)) as { tx: string }).tx);
      return api.restock();
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** One `pnpm agent …` run (default `--token tsla --buy`); resolves with the exit code and stderr. */
async function run(
  ...args: string[]
): Promise<{ code: number; err: string; out: string }> {
  process.argv = [
    "node",
    "main.ts",
    ...(args.length ? args : ["--token", "tsla", "--buy"]),
  ];
  vi.resetModules();
  let done!: (v: { code: number }) => void;
  const p = new Promise<{ code: number }>((r) => (done = r));
  let err = "";
  let out = "";
  vi.spyOn(console, "log").mockImplementation((m: string) => (out += m));
  vi.spyOn(console, "error").mockImplementation((m: string) => (err += m));
  vi.spyOn(process, "exit").mockImplementation(((c: number) => {
    done({ code: c });
  }) as never);
  const ok = setInterval(() => {}, 1 << 30);
  await import("./main");
  let result: { code: number } | undefined;
  void p.then((r) => (result = r));
  for (let i = 0; i < 200 && !result; i++)
    await vi.advanceTimersByTimeAsync(10_000);
  clearInterval(ok);
  return { code: result?.code ?? 0, err, out };
}

const row = {
  token: "tsla",
  ticker: "TSLA",
  onHand: 0,
  sold24h: 1,
  sold7d: 1,
  daysLeft: 0,
  suggested: 5,
};
const demand = (extra: Record<string, unknown> = {}) => ({
  tokens: [row],
  coverDays: 3,
  at: 0,
  agentSpentTodayCents: 0,
  paused: false,
  ...extra,
});
const state = () =>
  JSON.parse(readFileSync(process.env.AGENT_STATE!, "utf8")) as Record<
    string,
    unknown
  >;

test("a plain buy: swaps once, reports the tx, clears its record", async () => {
  api = { demand: demand(), restock: restocked };
  const a = await run();
  expect(a.err).toBe("");
  expect(a.code).toBe(0);
  expect(swaps.length).toBe(1);
  expect(restockTx).toEqual([TX]);
  expect(() => state()).toThrow(/ENOENT/);
});

// F1 (#55): the outstanding swap is remembered, so the next run follows it instead of buying again.
test("a swap still PENDING after the run is remembered: the next run follows it, it doesn't buy again", async () => {
  api = {
    demand: demand(),
    restock: () => new Response("{}", { status: 202 }),
  };
  orderStatus = "PENDING";
  const a = await run();
  expect(a.code).toBe(1);
  expect(a.err).toMatch(/still pending/);
  expect(state()).toMatchObject({ orderId: "o1", token: "tsla", usd: 50 });
  // The api still says $0 spent today; the record is what stops a 2nd $50.
  const b = await run();
  expect(b.err).toMatch(/still pending/);
  expect(swaps.length).toBe(1);
  // The order lands: the next run reports it, then (with the api's spend now counting it) buys as usual.
  orderStatus = "FINISHED";
  api.restock = restocked;
  api.demand = demand({ agentSpentTodayCents: 5000 });
  const c = await run();
  expect(c.err).toBe("");
  expect(restockTx[0]).toBe(TX);
  expect(swaps.length).toBe(2);
});

test("an outstanding swap the wallet reports FAILED is cleared: nothing was spent", async () => {
  api = { demand: demand(), restock: restocked };
  orderStatus = "PENDING";
  await run();
  orderStatus = "FAILED";
  const b = await run();
  // The failed one cleared; this run bought (o2) and, still FAILED in the mock, cleared that too.
  expect(b.err).toMatch(/swap o2 failed/);
  expect(swaps.length).toBe(2);
  expect(() => state()).toThrow(/ENOENT/);
});

test("a swap whose submit outcome is unknown blocks every later buy until someone checks", async () => {
  api = { demand: demand(), restock: restocked };
  swapFails = new Error("baw: unreadable output: ");
  const a = await run();
  expect(a.code).toBe(1);
  expect(state()).toMatchObject({ token: "tsla", usd: 50 });
  swapFails = undefined;
  const b = await run();
  expect(b.code).toBe(1);
  expect(b.err).toMatch(/no order id/);
  expect(swaps.length).toBe(0);
});

test("a swap the wallet refused clears its record: nothing was placed", async () => {
  api = { demand: demand(), restock: restocked };
  const { BawRefused } = await import("./baw");
  swapFails = new BawRefused("InsufficientBalance: not enough USDC");
  const a = await run();
  expect(a.err).toMatch(/InsufficientBalance/);
  expect(() => state()).toThrow(/ENOENT/);
});

test("two runs at once: the second can't take the slot the first holds", async () => {
  api = { demand: demand(), restock: restocked };
  orderStatus = "PENDING";
  const { claim } = await import("./state");
  // Another run claimed the slot (record without an order id yet): this one must not swap.
  claim(process.env.AGENT_STATE!, { token: "tsla", usd: 50 });
  const a = await run();
  expect(a.code).toBe(1);
  expect(swaps.length).toBe(0);
});

// F2 (#55): a done swap's report survives transient api errors, and can be finished without a new trade.
test("a 503 from the api after a FINISHED swap is retried; a rerun reports, it doesn't buy again", async () => {
  api = {
    demand: demand(),
    restock: () =>
      new Response(JSON.stringify({ error: "chain_unavailable" }), {
        status: 503,
      }),
  };
  const a = await run();
  expect(a.code).toBe(1);
  expect(a.err).toMatch(/restock 503 chain_unavailable/);
  expect(restockCalls).toBeGreaterThan(1);
  expect(state()).toMatchObject({ orderId: "o1", tx: TX });
  const before = restockCalls;
  await run();
  expect(swaps.length).toBe(1);
  expect(restockCalls).toBeGreaterThan(before);
});

test("network errors are retried too, and a later 200 finishes the report", async () => {
  let n = 0;
  api = {
    demand: demand(),
    restock: () => {
      if (++n < 3) throw new TypeError("fetch failed");
      return restocked();
    },
  };
  const a = await run();
  expect(a.err).toBe("");
  expect(n).toBe(3);
  expect(() => state()).toThrow(/ENOENT/);
});

test("a 4xx is not retried: the record stays for a person to check", async () => {
  api = {
    demand: demand(),
    restock: () =>
      new Response(JSON.stringify({ error: "not_a_restock" }), {
        status: 422,
      }),
  };
  const a = await run();
  expect(a.err).toMatch(/restock 422 not_a_restock/);
  expect(restockCalls).toBe(1);
  expect(state()).toMatchObject({ tx: TX });
  await run();
  expect(swaps.length).toBe(1);
});

test("409 tx_used means it already counted: the record clears", async () => {
  api = {
    demand: demand(),
    restock: () =>
      new Response(JSON.stringify({ error: "tx_used" }), { status: 409 }),
  };
  const a = await run();
  expect(a.code).toBe(0);
  expect(() => state()).toThrow(/ENOENT/);
});

test("--report <tx> reports a done swap without trading, and clears the record it matches", async () => {
  api = {
    demand: demand(),
    restock: () =>
      new Response(JSON.stringify({ error: "chain_unavailable" }), {
        status: 503,
      }),
  };
  await run();
  api.restock = restocked;
  const b = await run("--token", "tsla", "--report", TX);
  expect(b.err).toBe("");
  expect(swaps.length).toBe(1);
  expect(restockTx.at(-1)).toBe(TX);
  expect(() => state()).toThrow(/ENOENT/);
  // A malformed tx or a token outside the whitelist is refused before any call.
  expect((await run("--token", "tsla", "--report", "0x12")).err).toMatch(
    /tx hash/,
  );
  expect((await run("--token", "nvda", "--report", TX)).err).toMatch(
    /whitelist/,
  );
});

// F3 (#55): the spend guards fail closed.
test("a negative or missing spend, or a missing paused flag, buys nothing", async () => {
  api = {
    demand: demand({ agentSpentTodayCents: -100_000_000 }),
    restock: restocked,
  };
  for (let i = 0; i < 12; i++) await run();
  expect(swaps.length).toBe(0);
  for (const d of [
    { tokens: [row] },
    demand({ paused: undefined }),
    demand({ agentSpentTodayCents: undefined }),
    demand({ agentSpentTodayCents: "0" }),
    demand({ agentSpentTodayCents: Number.NaN }),
    demand({ paused: "false" }),
  ]) {
    api.demand = d;
    const r = await run();
    expect(r.code).toBe(1);
  }
  expect(swaps.length).toBe(0);
  api.demand = demand({ paused: true });
  expect((await run()).err).toMatch(/paused/);
  api.demand = demand({ agentSpentTodayCents: 45_001 }); // + $50 > $500
  expect((await run()).err).toMatch(/daily limit/);
  expect(swaps.length).toBe(0);
});

// F4 (#55): the quote must be near the api's spot price for the ticker.
test("a quote far worse than the reference spot price is refused", async () => {
  api = { demand: demand(), restock: restocked };
  received = "0.0001"; // 50 USDC for 0.0001 share ≈ $500k a share
  expect((await run()).err).toMatch(/quote/);
  received = "0.1"; // $500 a share vs $400: 25 % over
  expect((await run()).err).toMatch(/quote/);
  received = "0"; // nothing for the money
  expect((await run()).err).toMatch(/quote/);
  expect(swaps.length).toBe(0);
  received = "0.13"; // a better price than the reference is fine
  expect((await run()).code).toBe(0);
  expect(swaps.length).toBe(1);
});

test("no reference price (missing, zero, an api error, stale) means no buy", async () => {
  api = { demand: demand(), restock: restocked };
  for (const q of [
    quotes(undefined),
    quotes(0),
    { quotes: {}, source: "none", at: Date.now(), error: "no API key" },
    quotes(400, Date.now() - 60 * 60_000),
  ]) {
    api.quotes = () => q;
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/reference/);
  }
  expect(swaps.length).toBe(0);
});

test("a quote-only run prints the check but trades nothing", async () => {
  api = { demand: demand(), restock: restocked };
  received = "0.0001";
  const a = await run("--token", "tsla");
  expect(a.code).toBe(0);
  expect(a.out).toMatch(/"priceOk": false/);
  expect(swaps.length).toBe(0);
});

// F6 (#55): AGENT_KEY only travels over https (plain http to this machine is fine for dev).
test("NYXERON_API must be https unless it is this machine", async () => {
  api = { demand: demand(), restock: restocked };
  for (const url of [
    "http://api.nyxeron.xyz",
    "http://localhost.evil.test",
    "ftp://x",
    "nonsense",
  ]) {
    process.env.NYXERON_API = url;
    const r = await run("--token", "tsla");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/https/);
  }
  expect(calls).toEqual([]);
  for (const url of [
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://[::1]:8788",
  ]) {
    process.env.NYXERON_API = url;
    expect((await run("--token", "tsla")).code).toBe(0);
  }
});
