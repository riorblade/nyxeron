import { djs, economy, night, type Genre, type TalentId } from "../data";
import { fail, type ActionResult } from "../result";
import { clamp, type GameState, type Guest } from "../state";

/** R3: book DJ if coin ≥ fee and level ≥ DJ requirement → hype + fanbase share. */
export function r03_bookDj(s: GameState, dj: TalentId): ActionResult {
  const d = djs[dj];
  if (s.level < d.minLevel) return fail("levelLocked");
  if (s.bookedTalent.length >= economy.maxDjsPerNight)
    return fail("alreadyBooked");
  if (s.coin < d.fee) return fail("notEnoughCoin", d.fee - s.coin);
  const hype = Math.round(d.fanbase * economy.djHypeFactor);
  return {
    ok: true,
    state: {
      ...s,
      coin: s.coin - d.fee,
      hype: clamp(s.hype + hype),
      bookedTalent: [...s.bookedTalent, dj],
      log: [...s.log, { day: s.day, kind: "djBooked", dj, hype }],
    },
  };
}

/** Most common genre among the given guests (ties → first seen). */
export function dominantGenre(guests: Pick<Guest, "genre">[]): Genre | null {
  const counts = new Map<Genre, number>();
  for (const g of guests) counts.set(g.genre, (counts.get(g.genre) ?? 0) + 1);
  let best: Genre | null = null;
  for (const [genre, n] of counts)
    if (best === null || n > counts.get(best)!) best = genre;
  return best;
}

/** R4: DJ genre = dominant crowd genre → dance satisfaction ×1.2, else ×0.85. */
export function r04_djMultiplier(
  djGenre: Genre,
  crowdGenre: Genre | null,
): number {
  return djGenre === crowdGenre
    ? 1 + night.djMatchBonus
    : 1 - night.djMismatchPenalty;
}
