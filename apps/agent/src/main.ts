// The platform's stock agent, up to the quote: reads what the warehouse is short of, takes the whitelisted token
// (payments.json), checks its locked bStock contract against Binance's list and asks the Agentic Wallet what the
// budget buys. It does not trade yet.
//
//   AGENT_KEY=… pnpm agent              the whitelisted token the warehouse needs most
//   AGENT_KEY=… pnpm agent --token tsla  this whitelisted token, whatever the demand
import { payments, tokens, type TokenId } from "@nyxeron/core";
import { quote } from "./baw";
import { fetchDemand } from "./demand";
import { checkContract, locked, pick } from "./plan";
import { bstocks } from "./rwa";

const api = process.env.NYXERON_API ?? "http://localhost:8788";
const key = process.env.AGENT_KEY ?? "";
const usd = Number(process.env.AGENT_BUY_USD ?? 3);

const flag = process.argv.indexOf("--token");
const wanted = flag < 0 ? undefined : (process.argv[flag + 1] ?? "");

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
  console.log(
    JSON.stringify(
      {
        action: "quote",
        demand: row,
        usd,
        token: lock.symbol,
        contract: lock.contract,
        receive: q.toCoinAmount,
        slippage: q.slippage,
      },
      null,
      2,
    ),
  );
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
