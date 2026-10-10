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

/**
 * The api's base URL, only over https: AGENT_KEY goes out in its Authorization header. Plain http is allowed for
 * this machine (localhost, 127.0.0.1, ::1), where `pnpm dev:api` runs.
 */
export function apiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NYXERON_API is not a URL: must be https://…`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error(
      `NYXERON_API must be https (plain http only for localhost): ${url.origin}`,
    );
  return raw.replace(/\/+$/, "");
}

/**
 * The api's spend guards, failing closed: `paused` must be false and today's spend a known, non-negative number,
 * else nothing is bought. Then the swap must fit the daily limit.
 */
export function checkSpend(supply: Supply, usd: number) {
  const { paused, agentSpentTodayCents: spent } = supply;
  if (paused !== false)
    throw new Error(
      paused === true
        ? "payments are paused (reconciliation mismatch): not buying; see the back office's Payments page"
        : "the api didn't say whether payments are paused: not buying",
    );
  if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0)
    throw new Error(
      `the api's agentSpentTodayCents is not a usable number (${String(spent)}): not buying`,
    );
  // The daily limit binds the swap itself: the api would refuse to count one over it.
  if (spent + usd * 100 > payments.agent.maxUsdPerDay * 100)
    throw new Error(
      `over the agent's daily limit: $${spent / 100} spent today of $${payments.agent.maxUsdPerDay}`,
    );
}

export type PriceCheck = {
  /** USD per share the quote implies (1 bStock token = 1 share). */
  price: number;
  /** The api's spot price for the ticker, or undefined when it has none usable. */
  reference?: number;
  /** How far the quote is above the reference, in percent (negative: cheaper). */
  overPercent?: number;
  ok: boolean;
  reason?: string;
};

/** How far ahead of this machine's clock the api's spot price may be dated (clock skew), in ms. */
const SPOT_AHEAD_MS = 60_000;

/**
 * The quote against the api's spot price (GET /api/quotes): refused when it costs more than
 * agent.maxPriceOverSpotPercent above it or more than agent.maxPriceUnderSpotPercent below it (a quote that
 * good is a broken quote or reference, and the swap itself is a separate market order), when the amount isn't a
 * finite positive number, or when there is no fresh reference (dated within [-1 min, spotMaxAgeMinutes] of now).
 */
export function checkPrice(
  usd: number,
  received: string,
  ticker: string,
  spot: { quotes?: Record<string, number>; at?: number; error?: string },
  now: number,
): PriceCheck {
  const shares = Number(received);
  const price = shares > 0 && Number.isFinite(shares) ? usd / shares : Infinity;
  if (!(price > 0 && price < Infinity))
    return {
      price,
      ok: false,
      reason: `quote: ${received} ${ticker} for $${usd}`,
    };
  const reference = spot.quotes?.[ticker];
  const age = now - (spot.at ?? 0);
  if (
    spot.error ||
    typeof reference !== "number" ||
    !(reference > 0) ||
    !Number.isFinite(reference) ||
    !(age <= payments.agent.spotMaxAgeMinutes * 60_000) ||
    !(age >= -SPOT_AHEAD_MS)
  )
    return {
      price,
      ok: false,
      reason: `no fresh reference price for ${ticker} from the api${spot.error ? ` (${spot.error})` : ""}: not buying`,
    };
  const { maxPriceOverSpotPercent: over, maxPriceUnderSpotPercent: under } =
    payments.agent;
  const overPercent = (price / reference - 1) * 100;
  const ok = overPercent <= over && overPercent >= -under;
  return {
    price,
    reference,
    overPercent,
    ok,
    reason: ok
      ? undefined
      : overPercent > over
        ? `quote: $${price.toFixed(2)} a share is ${overPercent.toFixed(1)}% over the reference $${reference} (max ${over}%)`
        : `quote: $${price} a share is ${(-overPercent).toFixed(1)}% under the reference $${reference} (max ${under}%): a broken quote or reference, not buying`,
  };
}
