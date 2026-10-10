import { isId, night, tokens, type TokenId } from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState, NightState } from "../state";
import { marketPrice } from "./market";
import { platformFee } from "./quotes";
import { coverPrice } from "./strategy";

/**
 * A player who came to party, not to run the club: pays the door, then buys tokens at the desk at the live
 * market price. Buy-only: what a guest buys is theirs and goes home with them (the club never buys back).
 */
export interface Visitor {
  name: string;
  /** Guest sprite 1–10 (1–5 men, 6–10 women), picked on the dashboard. Cosmetic. */
  avatar: number;
  cash: number;
  /** Units held and what was paid for them in total. */
  holdings: Partial<Record<TokenId, { qty: number; cost: number }>>;
  /** Cash brought in (before the door), to measure the night's P&L. */
  startCash: number;
}

const ok = (state: GameState): ActionResult => ({ ok: true, state });
const withVisitor = (
  s: GameState,
  n: NightState,
  id: string,
  v: Visitor,
): GameState => ({
  ...s,
  night: { ...n, visitors: { ...n.visitors, [id]: v } },
});

/** The player `id` if they are in tonight's club. */
export const visitorOf = (s: GameState, id: string): Visitor | undefined => {
  const vs = s.night?.visitors;
  return vs && isId(vs, id) ? vs[id] : undefined;
};

/** The desk and the door only work while the club is open: tonight, before 04:00, and not sealed (R16). */
const clubOpen = (s: GameState) =>
  s.phase === "night" &&
  !!s.night &&
  s.night.minute < night.minutes &&
  !s.night.sealed &&
  !s.outcome;
const onMenu = (s: GameState, t: TokenId) => tokens[t].minLevel <= s.level;

/** Walk in: pay the club's cover from the wallet. `id` names the player (multiplayer: their relay id). */
export function visitorJoin(
  s: GameState,
  id: string,
  name: string,
  cash: number,
  avatar = 1,
): ActionResult {
  const n = s.night;
  if (!clubOpen(s) || !n || visitorOf(s, id)) return fail("wrongPhase");
  if (!Number.isFinite(cash) || cash < 0) return fail("invalidQty");
  const cover = coverPrice(s);
  if (cash < cover) return fail("notEnoughCoin", cover - cash);
  const v: Visitor = {
    name: name.slice(0, 24),
    avatar: Number.isFinite(avatar)
      ? Math.min(10, Math.max(1, Math.round(avatar)))
      : 1,
    cash: cash - cover,
    holdings: {},
    startCash: cash,
  };
  return ok({
    ...withVisitor(s, n, id, v),
    coin: s.coin + cover,
    nightRevenue: { ...s.nightRevenue, cover: s.nightRevenue.cover + cover },
  });
}

/** Buy at the live price; the club's stock goes down and its takings up. */
export function visitorBuy(
  s: GameState,
  id: string,
  t: TokenId,
  qty: number,
): ActionResult {
  const n = s.night;
  const v = visitorOf(s, id);
  if (!clubOpen(s) || !n || !v) return fail("wrongPhase");
  if (!isId(tokens, t)) return fail("invalidTarget");
  if (!onMenu(s, t)) return fail("levelLocked");
  if (!Number.isInteger(qty) || qty <= 0 || qty > s.stock[t])
    return fail("invalidQty");
  const cost = marketPrice(s, t) * qty;
  if (cost > v.cash) return fail("notEnoughCoin", cost - v.cash);
  const h = v.holdings[t] ?? { qty: 0, cost: 0 };
  const fee = platformFee(s, t, marketPrice(s, t)) * qty;
  return ok({
    ...withVisitor(s, n, id, {
      ...v,
      cash: v.cash - cost,
      holdings: {
        ...v.holdings,
        [t]: { qty: h.qty + qty, cost: h.cost + cost },
      },
    }),
    stock: { ...s.stock, [t]: s.stock[t] - qty },
    coin: s.coin + cost - fee,
    nightRevenue: {
      ...s.nightRevenue,
      bar: s.nightRevenue.bar + cost,
      platformFee: (s.nightRevenue.platformFee ?? 0) + fee,
    },
  });
}

/** Cash plus everything held, marked at the club's live price. */
export function visitorValue(s: GameState, id: string): number {
  const v = visitorOf(s, id);
  if (!v) return 0;
  let total = v.cash;
  for (const [t, h] of Object.entries(v.holdings))
    total += marketPrice(s, t as TokenId) * h!.qty;
  return total;
}

/** Tonight's result so far (door included). */
export function visitorPnl(s: GameState, id: string) {
  const v = visitorOf(s, id);
  return v ? visitorValue(s, id) - v.startCash : 0;
}

/** The player goes home (their tokens go with them; the club keeps what they paid). */
export function visitorLeave(s: GameState, id: string): GameState {
  const n = s.night;
  if (!n?.visitors || !visitorOf(s, id)) return s;
  const visitors = { ...n.visitors };
  delete visitors[id];
  return { ...s, night: { ...n, visitors } };
}
