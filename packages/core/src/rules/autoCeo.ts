import {
  channels,
  defaultPrice,
  djs,
  ids,
  levels,
  permits,
  requiredPermits,
  scenarios,
  tokens,
  type Level,
} from "../data";
import { expectedGuests, genreForecast, startNight } from "../engine";
import type { ActionResult } from "../result";
import { createSandbox } from "../scenario";
import type { GameState } from "../state";
import { r01_orderStock } from "./inventory";
import { r05_promote } from "./marketing";
import { hireStaff } from "./security";
import { applyPermit, permitActive } from "./legal";
import { r03_bookDj } from "./talent";
import { r18_upgradeLevel } from "./progression";

const tryAct = (s: GameState, r: ActionResult) => (r.ok ? r.state : s);

/**
 * The AI CEO's day: keeps permits, stock and security up, promotes, books a matching DJ, upgrades when safe.
 * Runs the clubs guest players visit, and drives the balance bot.
 */
export function aiPrepare(s: GameState, grow = true): GameState {
  const lv = levels[s.level];

  // Upgrade when it leaves room for the new level's permits and ~10 days of rent.
  if (grow && s.level < 5) {
    const lvNext = (s.level + 1) as Level;
    const next = levels[lvNext];
    const permitCost = requiredPermits(lvNext)
      .filter((p) => !permitActive(s, p))
      .reduce((a, p) => a + permits[p].cost, 0);
    if (
      s.coin >= next.cost + permitCost + next.rentPerDay * 10 &&
      s.reputation >= next.repRequired
    )
      s = tryAct(s, r18_upgradeLevel(s));
  }

  for (const p of requiredPermits(s.level))
    if (!permitActive(s, p) || s.permits[p].expiresDay - s.day <= 1)
      s = tryAct(s, applyPermit(s, p));

  // Staff: security for the ID check and the 1:40 ratio, bartenders for bar throughput.
  if (s.level >= 4)
    while (s.staff.security < Math.ceil(lv.capacity / 40) && s.coin > 20_000)
      s = tryAct(s, hireStaff(s, "security"));
  if (s.level >= 2)
    while (s.staff.bartender < Math.ceil(lv.capacity / 60) && s.coin > 5_000)
      s = tryAct(s, hireStaff(s, "bartender"));

  // Promo: cheapest-per-hype first, while hype is low.
  const promos = ids(channels).sort(
    (a, b) =>
      channels[a].cost / channels[a].hype - channels[b].cost / channels[b].hype,
  );
  for (const c of promos)
    if (s.hype < 60 && s.coin > channels[c].cost * 4)
      s = tryAct(s, r05_promote(s, c));

  // DJ that matches the forecast crowd genre.
  if (s.level >= 4) {
    const top = Object.entries(genreForecast(s)).sort(
      (a, b) => b[1] - a[1],
    )[0]![0];
    const dj = ids(djs)
      .filter((d) => djs[d].genre === top && djs[d].minLevel <= s.level)
      .sort((a, b) => djs[a].fee - djs[b].fee)[0];
    if (dj && s.coin > djs[dj].fee * 5) s = tryAct(s, r03_bookDj(s, dj));
  }

  if (s.level >= 4 && expectedGuests(s) > 150 && !permitActive(s, "crowd"))
    s = tryAct(s, applyPermit(s, "crowd"));

  // Stock for ~3 tokens per expected guest, spread over the menu, from the instant supplier.
  const menu = ids(tokens).filter((d) => tokens[d].minLevel <= s.level);
  const perDrink = Math.ceil((expectedGuests(s) * 4) / menu.length); // bot over-stocks a bit vs stockForecast()
  for (const d of menu)
    if (s.stock[d] < perDrink)
      s = tryAct(s, r01_orderStock(s, d, perDrink - s.stock[d], "corner"));

  return s;
}

export type EventSpec = (typeof scenarios.events)[number];

/** Tonight's club night run by an AI CEO, doors open, for a guest player to walk into. */
export function createEvent(spec: EventSpec, seed: number): GameState {
  const base = createSandbox(seed);
  const level = spec.level as Level;
  const s: GameState = {
    ...base,
    coin: spec.coin,
    mode: "sandbox",
    clubName: spec.clubName,
    clubGenre: spec.genre,
    level,
    hype: spec.hype,
    reputation: spec.reputation,
    stock: Object.fromEntries(
      ids(tokens).map((t) => [t, 0]),
    ) as GameState["stock"],
    staff: { bartender: 0, security: 0, host: 0, relations: 0, mc: 0 },
    prices: Object.fromEntries(
      ids(tokens).map((t) => [t, defaultPrice(t, level)]),
    ) as GameState["prices"],
  };
  return startNight(aiPrepare(s, false));
}
