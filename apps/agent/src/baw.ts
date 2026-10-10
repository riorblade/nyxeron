import { execFile } from "node:child_process";
import { payments } from "@nyxeron/core";
import { BSC } from "./rwa";

// The platform's Binance Agentic Wallet, driven through its CLI (`baw`, npm @binance/agentic-wallet). The wallet
// is signed in on this machine from the Binance App (`baw auth signin`); no key ever reaches this process.

/** USDC on BSC: what the agent pays with. */
export const USDC = payments.topup.tokens.USDC;

/** The wallet answered and said no: nothing was done (unlike a crash or unreadable output, where it may have). */
export class BawRefused extends Error {}

/**
 * How long one `baw` call may take before it is killed (SIGTERM): a hung wallet call would hold the run lock for
 * good. A swap killed this way keeps its record (its outcome is unknown): fail closed, a person checks.
 */
export const BAW_TIMEOUT_MS = 90_000;

/**
 * Reads `baw`'s answer. Anything but `{success: true, data}` or `{success: false, error}` is an error here, never
 * a TypeError later: a malformed refusal (`{success: false}` without `error`) is still a refusal.
 */
export function readReply<T>(stdout: string, err: Error | null): T {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    throw err ?? new Error(`baw: unreadable output: ${stdout}`);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply))
    throw new Error(`baw: unexpected answer: ${stdout}`);
  const r = reply as {
    success?: unknown;
    data?: unknown;
    error?: { name?: unknown; message?: unknown } | null;
  };
  if (r.success === true && r.data && typeof r.data === "object")
    return r.data as T;
  if (r.success === false) {
    const e = r.error && typeof r.error === "object" ? r.error : {};
    throw new BawRefused(
      `${String(e.name ?? "Error")}: ${String(e.message ?? "the wallet refused without saying why")}`,
    );
  }
  throw new Error(`baw: unexpected answer: ${stdout}`);
}

/** Runs `baw <args> --json`. A refusal comes back as JSON on a non-zero exit, so stdout is read either way. */
function baw<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      "baw",
      [...args, "--json"],
      { timeout: BAW_TIMEOUT_MS },
      (err, stdout) => {
        // Nothing may throw inside this callback: an uncaught exception would skip the run's cleanup.
        try {
          if (err?.killed && err.signal)
            throw new Error(
              `baw ${args.slice(0, 2).join(" ")}: no answer within ${BAW_TIMEOUT_MS / 1000} s (killed)`,
            );
          resolve(readReply<T>(stdout, err));
        } catch (e) {
          reject(e as Error);
        }
      },
    );
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
  toToken?: string;
  fromTokenQty?: string;
};

const listOrders = async (args: string[]) => {
  const page = await baw<{ list: Order[] }>(["market-order", "list", ...args]);
  if (!Array.isArray(page.list))
    throw new Error(`baw: order list (${args.join(" ")}) has no list`);
  return page.list;
};

/**
 * A submitted swap as the wallet sees it now. The swap's answer can carry its 20-digit order id rounded through a
 * double (above 2^53: 26101000001955860851 came back as …860615), so the id the list knows is looked for among
 * recent swaps into the same token: the same double, the same USDC amount. More than one such order: an error
 * (a person checks), never a guess.
 */
export async function order(
  orderId: string,
  toToken?: string,
  usd?: number,
): Promise<Order | undefined> {
  const exact = (await listOrders(["--orderId", orderId])).find(
    (o) => o?.orderId === orderId,
  );
  if (exact || toToken === undefined || usd === undefined) return exact;
  const near = (
    await listOrders(["--toToken", toToken, "--pageSize", "50"])
  ).filter(
    (o) =>
      typeof o?.orderId === "string" &&
      Number(o.orderId) === Number(orderId) &&
      o.toToken?.toLowerCase() === toToken.toLowerCase() &&
      Number(o.fromTokenQty) === usd,
  );
  if (near.length > 1)
    throw new Error(
      `baw: ${near.length} orders match ${orderId} (${usd} USDC); check baw market-order list`,
    );
  return near[0];
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
