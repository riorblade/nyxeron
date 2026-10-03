import { payments } from "@nyxeron/core";
import type { Supply, SupplyRow } from "./demand";

/** A token the paid economy allows: its bStock contract on BSC, locked in payments.json. */
export type Locked = { symbol: string; contract: string };

/** The whitelist entry for a game token, or undefined when it isn't in the paid economy. */
export const locked = (token: string): Locked | undefined =>
  (payments.tokens as Record<string, Locked>)[token];

/**
 * The token to restock next: of the whitelisted ones the api suggests restocking, the one that runs out soonest
 * (then the bigger shortfall).
 * ponytail: a plain rule until the LLM decides what and how much to buy.
 */
export function pick(supply: Supply): SupplyRow | undefined {
  return supply.tokens
    .filter((r) => r.suggested > 0 && locked(r.token))
    .sort((a, b) => a.daysLeft - b.daysLeft || b.suggested - a.suggested)[0];
}

/** Zero trust: the locked contract must be the one Binance lists for that ticker right now. */
export function checkContract(lock: Locked, listed: string | undefined) {
  if (listed?.toLowerCase() !== lock.contract.toLowerCase())
    throw new Error(
      `${lock.symbol}: locked contract ${lock.contract} is not Binance's (${listed ?? "not listed"})`,
    );
}
