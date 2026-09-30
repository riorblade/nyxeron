import {
  defaultPrice,
  priceScale,
  strategy,
  tokens,
  type TokenId,
} from "../data";
import { clamp, type GameState } from "../state";

/**
 * Real-world spot prices for the tokenized stocks (USD per share of the underlying, from Binance's RWA feed).
 * The game keeps its own Coin scale per venue level, but costs follow the real market: a token's lot costs its
 * usual price times (spot now / spot when this club first saw it). No feed (offline, tests) = factor 1.
 */
const P = strategy.platform;

/** The underlying tickers a token tracks, with weights (a stock is its own ticker at 100). */
export const legsOf = (t: TokenId): [string, number][] =>
  (tokens[t] as { legs?: [string, number][] }).legs ?? [
    [tokens[t].ticker, 100],
  ];

/** Merge fresh quotes; the first quote seen for a ticker becomes its reference. */
export function setQuotes(
  s: GameState,
  quotes: Record<string, number>,
): GameState {
  const fresh = Object.fromEntries(
    Object.entries(quotes).filter(([, p]) => Number.isFinite(p) && p > 0),
  );
  return {
    ...s,
    quotes: { ...s.quotes, ...fresh },
    quoteRef: { ...fresh, ...s.quoteRef },
  };
}

/** How far the real market has moved this token since the club started watching it (weighted over its legs). */
export function spotFactor(s: GameState, t: TokenId): number {
  let sum = 0,
    w = 0;
  for (const [ticker, weight] of legsOf(t)) {
    const now = s.quotes?.[ticker];
    const ref = s.quoteRef?.[ticker];
    if (!now || !ref) continue;
    sum += (now / ref) * weight;
    w += weight;
  }
  return w ? clamp(sum / w, P.spotFactorRange[0]!, P.spotFactorRange[1]!) : 1;
}

/** What one lot costs at spot right now (suppliers add their margin on top). */
export const spotUnitCost = (s: GameState, t: TokenId) =>
  tokens[t].buyCost * priceScale(s.level) * spotFactor(s, t);

/** This level's standard sale price, following spot. */
export const standardPrice = (s: GameState, t: TokenId) =>
  Math.max(1, Math.round(defaultPrice(t, s.level) * spotFactor(s, t)));

/** The platform's cut of one sale: a share of the spread the CEO charges over spot. */
export const platformFee = (s: GameState, t: TokenId, price: number) =>
  Math.round(Math.max(0, price - spotUnitCost(s, t)) * P.feeShare);
