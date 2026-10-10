import { execFile } from "node:child_process";
import { payments } from "@nyxeron/core";
import { BSC } from "./rwa";

// The platform's Binance Agentic Wallet, driven through its CLI (`baw`, npm @binance/agentic-wallet). The wallet
// is signed in on this machine from the Binance App (`baw auth signin`); no key ever reaches this process.

/** USDC on BSC: what the agent pays with. */
export const USDC = payments.topup.tokens.USDC;

type Reply<T> =
  | { success: true; data: T }
  | { success: false; error: { name: string; message: string } };

/** The wallet answered and said no: nothing was done (unlike a crash or unreadable output, where it may have). */
export class BawRefused extends Error {}

/** Runs `baw <args> --json`. A refusal comes back as JSON on a non-zero exit, so stdout is read either way. */
function baw<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile("baw", [...args, "--json"], (err, stdout) => {
      let reply: Reply<T>;
      try {
        reply = JSON.parse(stdout) as Reply<T>;
      } catch {
        return reject(err ?? new Error(`baw: unreadable output: ${stdout}`));
      }
      if (reply.success) resolve(reply.data);
      else
        reject(new BawRefused(`${reply.error.name}: ${reply.error.message}`));
    });
  });
}

export type Quote = {
  fromCoinSymbol: string;
  fromCoinAmount: string;
  toCoinSymbol: string;
  toCoinAmount: string;
  slippage: number;
};

/** What `usd` of USDC buys of a token right now. Nothing is traded. */
export const quote = (usd: number, toToken: string) =>
  baw<Quote>([
    "market-order",
    "quote",
    "--fromTokenQty",
    String(usd),
    "--fromToken",
    USDC,
    "--toToken",
    toToken,
    "--binanceChainId",
    BSC,
  ]);

// Slippage the agent accepts on a swap, in percent: always explicit, never the wallet's "auto".
export const SLIPPAGE = "1";

/** Swaps `usd` of USDC for a token at market. Only submits: the result is an order to follow with `order`. */
export const swap = (usd: number, toToken: string) =>
  baw<{ orderId: string }>([
    "market-order",
    "swap",
    "--fromTokenQty",
    String(usd),
    "--fromToken",
    USDC,
    "--toToken",
    toToken,
    "--binanceChainId",
    BSC,
    "--slippage",
    SLIPPAGE,
  ]);

export type Order = {
  orderId: string;
  status: "PENDING" | "FINISHED" | "FAILED";
  txHash: string | null;
};

/** A submitted swap as the wallet sees it now. */
export async function order(orderId: string): Promise<Order | undefined> {
  const page = await baw<{ list: Order[] }>([
    "market-order",
    "list",
    "--orderId",
    orderId,
  ]);
  return page.list.find((o) => o.orderId === orderId);
}

/**
 * Where a followed swap stands: "wait" (still pending), "done" with its tx, or "failed" (the wallet says FAILED:
 * nothing spent). A FINISHED order without a tx hash yet is "wait": its USDC is spent, so its record must stay
 * until the tx shows up and is reported.
 */
export function outcome(o: Order | undefined) {
  if (o?.status === "FINISHED" && o.txHash)
    return { state: "done" as const, tx: o.txHash };
  if (o?.status === "FAILED") return { state: "failed" as const };
  return { state: "wait" as const }; // PENDING, FINISHED without a tx yet, or any status the wallet adds later
}
