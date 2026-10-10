// The platform's stock agent: reads what the warehouse is short of, takes the whitelisted token (payments.json),
// checks its locked bStock contract against Binance's list and asks the Agentic Wallet what the budget buys, and
// checks that quote against the api's spot price. Only with --buy does it trade: it swaps with platform funds,
// follows the order to its tx, and reports the tx to the api, which reads the swap on BSC and adds the units it
// really bought. The swap it placed is recorded (AGENT_STATE) until the api has counted it: a run that ends early
// leaves it for the next run to finish, and no new swap is placed while one is outstanding.
//
//   AGENT_KEY=… pnpm agent                               the whitelisted token the warehouse needs most: a quote
//   AGENT_KEY=… pnpm agent --token tsla                   this whitelisted token, whatever the demand: a quote
//   AGENT_KEY=… AGENT_STATE=… pnpm agent --token tsla --buy         buy for AGENT_BUY_USD, restock the warehouse
//   AGENT_KEY=… AGENT_STATE=… pnpm agent --token tsla --report 0x…  report a done swap's tx again; no trade
// --buy and --report require AGENT_STATE (the same path on every run): the record and the run lock live there.
import { payments, tokens, type TokenId } from "@nyxeron/core";
import { BawRefused, order, outcome, quote, swap } from "./baw";
import {
  fetchDemand,
  fetchQuotes,
  ReportError,
  reportRestock,
  type Quotes,
  type Restocked,
} from "./demand";
import {
  apiBase,
  checkContract,
  checkPrice,
  checkQuoteFor,
  checkSpend,
  locked,
  pick,
} from "./plan";
import { bstocks } from "./rwa";
import {
  claim,
  clear,
  DEFAULT_STATE,
  load,
  lockRun,
  save,
  type Outstanding,
} from "./state";

const rawApi = process.env.NYXERON_API ?? "http://localhost:8788";
const key = process.env.AGENT_KEY ?? "";
const usd = Number(process.env.AGENT_BUY_USD ?? 3);
const stateSet = Boolean(process.env.AGENT_STATE);
const statePath = process.env.AGENT_STATE || DEFAULT_STATE;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const wanted = arg("--token");
const reportTx = arg("--report");
const buy = process.argv.includes("--buy");

/** How long a run keeps following a submitted order, and keeps reporting a done swap to the api. */
const FOLLOW_MS = 3 * 60_000;
const REPORT_MS = 10 * 60_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/**
 * Reports a tx until the api counts it, for up to REPORT_MS: again every 10 s while it isn't final (202), and with
 * backoff (5 s doubling to 60 s) on a 5xx or a network error. A 4xx is final and thrown at once.
 */
async function report(
  base: string,
  token: string,
  tx: string,
): Promise<Restocked | "counted"> {
  const until = Date.now() + REPORT_MS;
  let last: string;
  for (let backoff = 5000; ;) {
    let delay = 10_000;
    try {
      const got = await reportRestock(base, key, token, tx);
      if (got !== "pending") return got;
      last = "still pending (not final on BSC yet)";
    } catch (e) {
      if (e instanceof ReportError && !e.retry) throw e;
      last = (e as Error).message;
      delay = backoff;
      backoff = Math.min(backoff * 2, 60_000);
    }
    if (Date.now() + delay > until)
      throw new Error(
        `${last}: restock for ${tx} not counted yet; the swap is done. Report it with --token ${token} --report ${tx}`,
      );
    await wait(delay);
  }
}

/** Follows a submitted order for up to FOLLOW_MS: its tx, "failed", or undefined while still pending. */
async function follow(orderId: string): Promise<string | "failed" | undefined> {
  const until = Date.now() + FOLLOW_MS;
  for (;;) {
    const o = outcome(await order(orderId));
    if (o.state === "failed") return "failed";
    if (o.state === "done") return o.tx;
    if (Date.now() + 5000 > until) return undefined;
    await wait(5000);
  }
}

/**
 * Takes a recorded swap as far as it goes: its order to a tx, the tx to the api. Clears the record once the api
 * has counted it ("done") or the wallet says it failed ("failed", nothing spent); throws while it can't finish.
 */
async function settle(
  base: string,
  o: Outstanding,
): Promise<"done" | "failed"> {
  if (!o.orderId)
    throw new Error(
      `a $${o.usd} swap for ${o.token} was being submitted at ${new Date(o.at).toISOString()} and no order id was ` +
        `recorded: check \`baw market-order list\`; if it swapped, report its tx with --token ${o.token} --report <tx>; ` +
        `then remove ${statePath}`,
    );
  if (!o.tx) {
    const got = await follow(o.orderId);
    if (got === "failed") {
      clear(statePath, o);
      return "failed";
    }
    if (!got)
      throw new Error(
        `swap ${o.orderId} still pending: the next run follows it (recorded in ${statePath}); ` +
          `check it with baw market-order list`,
      );
    o.tx = got;
    save(statePath, o);
    log({
      action: "swapped",
      orderId: o.orderId,
      tx: o.tx,
      bscscan: `https://bscscan.com/tx/${o.tx}`,
    });
  }
  let got: Restocked | "counted";
  try {
    got = await report(base, o.token, o.tx);
  } catch (e) {
    if (e instanceof ReportError) {
      o.error = e.message;
      save(statePath, o);
      throw new Error(
        `${e.message}: the swap ${o.tx} is done but the api won't count it; check it in the back office, then ` +
          `remove ${statePath}`,
        { cause: e },
      );
    }
    throw e;
  }
  clear(statePath, o);
  log(
    got === "counted"
      ? { action: "counted", tx: o.tx }
      : { action: "restocked", ...got },
  );
  return "done";
}

async function main() {
  if (!key) throw new Error("AGENT_KEY is not set");
  const base = apiBase(rawApi);
  if (reportTx === undefined && !buy) {
    if (!stateSet)
      console.warn(
        `warning: AGENT_STATE is not set: an outstanding swap recorded elsewhere isn't shown (--buy and --report ` +
          "refuse to run without it)",
      );
    return run(base);
  }

  // The record and the run lock both live at AGENT_STATE: a run that falls back to another path sees no record
  // and no lock while another run's swap is still outstanding, and buys again (that swap isn't in the api's spend
  // yet, so the daily cap doesn't stop it). No fallback for a run that trades or clears a record, not even locally.
  if (!stateSet)
    throw new Error(
      "AGENT_STATE is not set: --buy and --report need the outstanding-swap record every run shares, e.g. " +
        "AGENT_STATE=/var/lib/nyxeron-agent/state.json (locally any path outside the repo, the same on every run)",
    );

  // A --buy or --report run holds the run lock throughout: no other run may touch the record meanwhile.
  const release = lockRun(statePath);
  // Also on any exit (process.exit, an uncaught exception): the record, not the lock, guards the money.
  const onExit = () => {
    try {
      release();
    } catch {
      // a lock that isn't ours stays for a person
    }
  };
  process.on("exit", onExit);
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const handlers = Object.entries(signals).map(([sig, code]) => {
    const h = () => {
      onExit();
      process.exit(code);
    };
    process.once(sig, h);
    return [sig, h] as const;
  });
  try {
    await run(base);
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
    process.off("exit", onExit);
    release();
  }
}

async function run(base: string) {
  if (reportTx !== undefined) {
    if (wanted === undefined || !locked(wanted))
      throw new Error(
        `--report needs --token of the payments.json whitelist: ${wanted ?? ""}`,
      );
    if (!/^0x[0-9a-fA-F]{64}$/.test(reportTx))
      throw new Error(
        `--report needs the swap's tx hash (0x + 64 hex): ${reportTx}`,
      );
    const got = await report(base, wanted, reportTx);
    const o = load(statePath);
    if (o?.tx?.toLowerCase() === reportTx.toLowerCase()) clear(statePath, o);
    log(
      got === "counted"
        ? { action: "counted", tx: reportTx }
        : { action: "restocked", ...got },
    );
    return;
  }

  if (!(usd > 0)) throw new Error("AGENT_BUY_USD must be a positive number");
  if (usd > payments.agent.maxUsdPerSwap)
    throw new Error(`AGENT_BUY_USD is over $${payments.agent.maxUsdPerSwap}`);
  if (wanted !== undefined && !locked(wanted))
    throw new Error(`not in the payments.json whitelist: ${wanted}`);

  // A swap from an earlier run comes first: finish it (or learn it failed) before anything new is bought.
  const earlier = load(statePath);
  if (earlier && buy) {
    if ((await settle(base, earlier)) === "failed")
      log({
        action: "cleared",
        reason: `earlier swap ${earlier.orderId} failed: nothing was bought`,
      });
  } else if (earlier) log({ outstanding: earlier });

  const supply = await fetchDemand(base, key);
  const row =
    wanted === undefined
      ? pick(supply)
      : supply.tokens.find((r) => r.token === wanted);
  if (!row) {
    console.log(
      JSON.stringify({ action: "none", reason: "nothing to restock" }),
    );
    return;
  }

  const lock = locked(row.token)!;
  const ticker = tokens[row.token as TokenId].ticker;
  checkContract(lock, (await bstocks()).get(ticker)?.address);
  const q = await quote(usd, lock.contract);
  checkQuoteFor(q, usd, lock);
  const spot: Partial<Quotes> = await fetchQuotes(base).catch((e: Error) => ({
    error: e.message,
  }));
  const price = checkPrice(usd, q.toCoinAmount, ticker, spot, Date.now());
  log({
    action: buy ? "buy" : "quote",
    demand: row,
    usd,
    token: lock.symbol,
    contract: lock.contract,
    receive: q.toCoinAmount,
    slippage: q.slippage,
    pricePerShare: price.price,
    spot: price.reference,
    overSpotPercent: price.overPercent,
    priceOk: price.ok,
  });
  if (!buy) return;
  checkSpend(supply, usd);
  if (!price.ok) throw new Error(price.reason);

  // Recorded before it is submitted: if this run dies anywhere after, the next one knows a swap may be out.
  const o = claim(statePath, { token: row.token, usd });
  // With the slot taken, today's spend is read again: a swap counted since the first read still binds the cap.
  try {
    checkSpend(await fetchDemand(base, key), usd);
  } catch (e) {
    clear(statePath, o); // nothing was submitted
    throw e;
  }
  try {
    o.orderId = (await swap(usd, lock.contract)).orderId;
  } catch (e) {
    // Even a structured refusal from the wallet doesn't prove no order went out (a timeout can be reported after
    // the submit), so the record stays: real money fails closed, and a person checks before the next swap.
    if (e instanceof BawRefused) {
      o.error = e.message;
      save(statePath, o);
    }
    (e as Error).message +=
      ` (the swap may have been placed: recorded in ${statePath}; check \`baw market-order list\`, report a placed ` +
      `swap with --token ${o.token} --report <tx>, then remove ${statePath}; no new swap until then)`;
    throw e;
  }
  save(statePath, o);
  if ((await settle(base, o)) === "failed")
    throw new Error(`swap ${o.orderId} failed: nothing bought`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
