// Binance's tokenized-stock list, the one the Agentic Wallet skill resolves tickers with. type: 1 Ondo (…on),
// 2 xStocks (…x), 3 bStock (…B). Docs: github.com/binance/binance-skills-hub → binance-agentic-wallet/SKILL.md
import { payments } from "@nyxeron/core";
import { FETCH_TIMEOUT_MS } from "./demand";

const LIST =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
const BSTOCK = 3;
export const BSC = String(payments.chainId);

export type RwaToken = { symbol: string; address: string };

type Row = {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
};

/** bStock tokens on BSC by underlying ticker ("TSLA" → TSLAB). */
export async function bstocks(): Promise<Map<string, RwaToken>> {
  const res = await fetch(`${LIST}?type=${BSTOCK}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rwa list ${res.status}`);
  const { data } = (await res.json()) as { data?: Row[] };
  if (!Array.isArray(data)) throw new Error("rwa list: no data");
  return new Map(
    data
      .filter((r) => r.chainId === BSC)
      .map((r) => [r.ticker, { symbol: r.symbol, address: r.contractAddress }]),
  );
}
