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
      else reject(new Error(`${reply.error.name}: ${reply.error.message}`));
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
