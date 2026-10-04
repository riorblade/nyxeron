import { city, ids, payments, tokens, type Level } from "../data";

/**
 * The shared city (multiplayer), on Credit (real money; docs/payments.md): venues are rented by the week in
 * credits, and that rent is the platform's income. Any rented venue can run a shop that resells real stock from
 * the platform's warehouse while its owner is away; from Level 3 up the tenant can also schedule parties. The api
 * settles all of it server-side with these same numbers (services/api/gamedata is a checked copy of this data).
 */
export const LEVELS = [1, 2, 3, 4, 5] as const;

/** One week's rent for a venue of this level, in credits (`override`: the back office's rent table). */
export const weeklyRent = (
  level: Level,
  override?: Partial<Record<string, number>>,
) => override?.[level] ?? payments.rentCredits[level];

/** How many venues of this level the city has. */
export const venueCount = (level: Level) => city.venues[level].count;

/** Tokens a venue of this level may sell. */
export const shopTokens = (level: Level) =>
  ids(tokens).filter((t) => tokens[t].minLevel <= level);

export const canHostParty = (level: Level) => level >= city.party.minLevel;
