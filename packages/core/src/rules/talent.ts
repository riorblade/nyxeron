import {
  bands,
  djs,
  economy,
  isId,
  night,
  type BandId,
  type Genre,
  type TalentId,
} from "../data";
import { fail, type ActionResult } from "../result";
import { clamp, type GameState, type Guest } from "../state";

/** R3: book DJ if coin ≥ fee and level ≥ DJ requirement → hype + fanbase share. */
export function r03_bookDj(s: GameState, dj: TalentId): ActionResult {
  if (s.outcome) return fail("wrongPhase");
  if (!isId(djs, dj)) return fail("invalidTarget");
  const d = djs[dj];
  if (s.level < d.minLevel) return fail("levelLocked");
  // Too late once tonight's set slot has passed.
  if (
    s.phase === "report" ||
    (s.night && s.night.minute >= night.djSetStartMinute)
  )
    return fail("wrongPhase");
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

/** Book tonight's live band (one per night): costs its fee, brings its fans (hype). */
export function bookBand(s: GameState, band: BandId): ActionResult {
  if (s.phase !== "day") return fail("wrongPhase");
  if (!isId(bands, band)) return fail("invalidTarget");
  const b = bands[band];
  if (s.level < b.minLevel) return fail("levelLocked");
  if (s.bookedBand) return fail("alreadyBooked");
  if (s.coin < b.fee) return fail("notEnoughCoin", b.fee - s.coin);
  const hype = Math.round(b.fanbase * economy.djHypeFactor);
  return {
    ok: true,
    state: {
      ...s,
      coin: s.coin - b.fee,
      hype: clamp(s.hype + hype),
      bookedBand: band,
      log: [...s.log, { day: s.day, kind: "bandBooked", band, hype }],
    },
  };
}

/**
 * When the band plays tonight, in night minutes [start, end): the main act from 22:30 without a DJ, or the opening
 * act 22:00–23:00 when a DJ follows.
 */
export function bandSet(s: GameState): [number, number] | null {
  if (!s.bookedBand) return null;
  const b = night.band;
  return s.bookedTalent.length
    ? [b.openerStart, b.openerStart + b.openerLength]
    : [b.start, b.start + b.length];
}

export const bandPlaying = (s: GameState) => {
  const w = bandSet(s);
  const m = s.night?.minute;
  return !!w && m !== undefined && m >= w[0] && m < w[1];
};
