// The platform's stock agent: reads what the warehouse is short of, takes the whitelisted token (payments.json),
// checks its locked bStock contract against Binance's list and asks the Agentic Wallet what the budget buys.
// Only with --buy does it trade: it swaps with platform funds, follows the order to its tx, and reports the tx to
// the api, which reads the swap on BSC and adds the units it really bought.
//
//   AGENT_KEY=… pnpm agent                    the whitelisted token the warehouse needs most: a quote
//   AGENT_KEY=… pnpm agent --token tsla        this whitelisted token, whatever the demand: a quote
//   AGENT_KEY=… pnpm agent --token tsla --buy  buy it for AGENT_BUY_USD and restock the warehouse
import { payments, tokens, type TokenId } from "@nyxeron/core";
import { order, outcome, quote, swap } from "./baw";
import { fetchDemand, reportRestock } from "./demand";
import { checkContract, locked, pick } from "./plan";
import { bstocks } from "./rwa";

const api = process.env.NYXERON_API ?? "http://localhost:8788";
const key = process.env.AGENT_KEY ?? "";
const usd = Number(process.env.AGENT_BUY_USD ?? 3);

const flag = process.argv.indexOf("--token");
const wanted = flag < 0 ? undefined : (process.argv[flag + 1] ?? "");
const buy = process.argv.includes("--buy");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main() {
  if (!key) throw new Error("AGENT_KEY is not set");
  if (!(usd > 0)) throw new Error("AGENT_BUY_USD must be a positive number");
  if (usd > payments.agent.maxUsdPerSwap)
    throw new Error(`AGENT_BUY_USD is over $${payments.agent.maxUsdPerSwap}`);
  if (wanted !== undefined && !locked(wanted))
    throw new Error(`not in the payments.json whitelist: ${wanted}`);

  const supply = await fetchDemand(api, key);
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
  log({
    action: buy ? "buy" : "quote",
    demand: row,
    usd,
    token: lock.symbol,
    contract: lock.contract,
    receive: q.toCoinAmount,
    slippage: q.slippage,
  });
  if (!buy) return;
  // The daily limit binds the swap itself: the api would refuse to count one over it.
  const spent = supply.agentSpentTodayCents ?? 0;
  if (spent + usd * 100 > payments.agent.maxUsdPerDay * 100)
    throw new Error(
      `over the agent's daily limit: $${spent / 100} spent today of $${payments.agent.maxUsdPerDay}`,
    );

  // Submitted is not done: follow the order until the wallet says FINISHED (with its tx) or FAILED.
  const { orderId } = await swap(usd, lock.contract);
  let tx = "";
  for (let i = 0; i < 36 && !tx; i++) {
    const o = outcome(await order(orderId));
    if (o.state === "failed")
      throw new Error(`swap ${orderId} failed: nothing bought`);
    if (o.state === "done") tx = o.tx;
    else await wait(5000);
  }
  if (!tx)
    throw new Error(
      `swap ${orderId} still pending: check it with baw market-order list`,
    );
  log({
    action: "swapped",
    orderId,
    tx,
    bscscan: `https://bscscan.com/tx/${tx}`,
  });

  // The api adds units only once the swap is final on BSC (15 confirmations): report until it counts.
  for (let i = 0; i < 30; i++) {
    const got = await reportRestock(api, key, row.token, tx);
    if (got !== "pending") {
      log({ action: "restocked", ...got });
      return;
    }
    await wait(10_000);
  }
  throw new Error(
    `restock for ${tx} still pending: report it again later (the swap is done)`,
  );
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
