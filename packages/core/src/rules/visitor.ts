import { strategy, tokens, type TokenId } from "../data";
import { fail, type ActionResult } from "../result";
import type { GameState, NightState } from "../state";
import { marketPrice } from "./market";
import { platformFee } from "./quotes";
import { coverPrice } from "./strategy";

/**
 * A player who came to party, not to run the club: pays the door, then buys and sells tokens at the desk at the
 * live market price. The club earns on every buy and pays out on every sell (minus the desk spread).
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

const V = strategy.visitor;
const ok = (state: GameState): ActionResult => ({ ok: true, state });
const withVisitor = (s: GameState, n: NightState, v: Visitor): GameState => ({
  ...s,
  night: { ...n, visitor: v },
});
const onMenu = (s: GameState, t: TokenId) => tokens[t].minLevel <= s.level;

/** Walk in: pay the club's cover from the wallet. */
export function visitorJoin(
  s: GameState,
  name: string,
  cash: number,
  avatar = 1,
): ActionResult {
  const n = s.night;
  if (s.phase !== "night" || !n || n.visitor) return fail("wrongPhase");
  const cover = coverPrice(s);
  if (cash < cover) return fail("notEnoughCoin", cover - cash);
  const v: Visitor = {
    name,
    avatar: Math.min(10, Math.max(1, Math.round(avatar))),
    cash: cash - cover,
    holdings: {},
    startCash: cash,
  };
  return ok({
    ...withVisitor(s, n, v),
    coin: s.coin + cover,
    nightRevenue: { ...s.nightRevenue, cover: s.nightRevenue.cover + cover },
  });
}

/** Buy at the live price; the club's stock goes down and its takings up. */
export function visitorBuy(
  s: GameState,
  t: TokenId,
  qty: number,
): ActionResult {
  const n = s.night;
  const v = n?.visitor;
  if (!n || !v) return fail("wrongPhase");
  if (!onMenu(s, t)) return fail("levelLocked");
  if (!Number.isInteger(qty) || qty <= 0 || qty > s.stock[t])
    return fail("invalidQty");
  const cost = marketPrice(s, t) * qty;
  if (cost > v.cash) return fail("notEnoughCoin", cost - v.cash);
  const h = v.holdings[t] ?? { qty: 0, cost: 0 };
  const fee = platformFee(s, t, marketPrice(s, t)) * qty;
  return ok({
    ...withVisitor(s, n, {
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

/** What the desk pays per unit right now (live price minus the spread). */
export const sellPrice = (s: GameState, t: TokenId) =>
  Math.floor(marketPrice(s, t) * (1 - V.sellSpread));

/** Sell back to the desk; the units return to the club's stock. */
export function visitorSell(
  s: GameState,
  t: TokenId,
  qty: number,
): ActionResult {
  const n = s.night;
  const v = n?.visitor;
  const h = v?.holdings[t];
  if (!n || !v) return fail("wrongPhase");
  if (!h || !Number.isInteger(qty) || qty <= 0 || qty > h.qty)
    return fail("invalidQty");
  const pay = sellPrice(s, t) * qty;
  const left = h.qty - qty;
  const holdings = { ...v.holdings };
  if (left)
    holdings[t] = { qty: left, cost: Math.round((h.cost * left) / h.qty) };
  else delete holdings[t];
  return ok({
    ...withVisitor(s, n, { ...v, cash: v.cash + pay, holdings }),
    stock: { ...s.stock, [t]: s.stock[t] + qty },
    coin: s.coin - pay,
    nightRevenue: { ...s.nightRevenue, bar: s.nightRevenue.bar - pay },
  });
}

/** Cash plus everything held, sold back at tonight's desk price. */
export function visitorValue(s: GameState): number {
  const v = s.night?.visitor;
  if (!v) return 0;
  let total = v.cash;
  for (const [t, h] of Object.entries(v.holdings))
    total += sellPrice(s, t as TokenId) * h!.qty;
  return total;
}

/** Tonight's result so far (door included). */
export const visitorPnl = (s: GameState) =>
  s.night?.visitor ? visitorValue(s) - s.night.visitor.startCash : 0;
