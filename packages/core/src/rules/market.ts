import { strategy, tokens, type TokenId } from "../data";
import type { createRng } from "../rng";
import { clamp, type GameState, type Guest, type NightState } from "../state";

/**
 * The live token market inside the club. Each token trades at a multiplier on its list price (1 = list). Every
 * minute it takes a random step sized by the token's volatility, drifts up with the room's energy (the party moves
 * the market), is pulled back toward list, and gets pumped by the DJ taking the decks and by the anthem.
 */
const M = strategy.market;

export const marketOf = (n: NightState | null | undefined, t: TokenId) =>
  n?.market?.[t] ?? 1;

/** What a guest pays for one token right now (list price × market). */
export const marketPrice = (s: GameState, t: TokenId, list = s.prices[t]) =>
  Math.max(1, Math.round(list * marketOf(s.night, t)));

/** Average multiplier across the menu (guests feel their P&L against this). */
export function marketIndex(n: NightState, menu: TokenId[]): number {
  if (!menu.length) return 1;
  return menu.reduce((a, t) => a + marketOf(n, t), 0) / menu.length;
}

/** FOMO: a token rising above its recent average draws buyers, a falling one puts them off. */
export function fomoFactor(n: NightState, t: TokenId): number {
  const m = marketOf(n, t);
  const ema = n.marketEma?.[t] ?? m;
  const [lo, hi] = M.fomoRange;
  return clamp(1 + M.momentumBuy * (m / ema - 1), lo!, hi!);
}

/** One minute of trading: step, drift with energy, revert toward list, pumps. Mutates `n`. */
export function tickMarket(
  rng: ReturnType<typeof createRng>,
  n: NightState,
  menu: TokenId[],
  pump: number,
) {
  const [lo, hi] = M.range;
  const market = { ...n.market };
  const ema = { ...n.marketEma };
  const hist = { ...n.marketHist };
  for (const t of menu) {
    const m = market[t] ?? 1;
    const shock = (rng.next() * 2 - 1) * tokens[t].volatility * 1.7;
    const drift =
      (M.energyDrift * (n.energy - 50)) / 50 - M.revert * (m - 1) + pump;
    const next = clamp(m * Math.exp(drift + shock), lo!, hi!);
    market[t] = next;
    ema[t] = (ema[t] ?? m) + (next - (ema[t] ?? m)) * M.emaFollow;
    hist[t] = [...(hist[t] ?? []), next];
  }
  n.market = market;
  n.marketEma = ema;
  n.marketHist = hist;
}

/** A guest's cost basis moves toward the market index at each purchase. */
export function recordBuy(g: Guest, index: number) {
  const bought = g.bought ?? 0;
  g.basis = ((g.basis ?? index) * bought + index) / (bought + 1);
  g.bought = bought + 1;
}

/** Holding tokens: gains cheer a guest up; losses sour the mood and tilt them. Mutates `g`. */
export function feelMarket(g: Guest, index: number) {
  if (!g.bought || !g.basis) return;
  const pnl = index / g.basis - 1;
  g.satisfaction += pnl * M.pnlSatisfaction;
  if (pnl < 0) g.tilt += -pnl * M.lossTilt;
}
