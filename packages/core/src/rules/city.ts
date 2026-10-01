import {
  city,
  defaultPrice,
  ids,
  priceScale,
  tokens,
  type Level,
  type TokenId,
} from "../data";

/**
 * The shared city (multiplayer): venues are rented by the week with the account's Coin, and that rent is the
 * platform's income. Any rented venue can run a shop that sells while its owner is away (as long as there is
 * stock); from Level 3 up the tenant can also schedule parties. The api settles all of it server-side with these
 * same numbers (services/api/gamedata is a checked copy of this data).
 *
 * `factor` is the token's spot factor (spotFactorOf): city prices follow the real market like a club's do.
 */
export const LEVELS = [1, 2, 3, 4, 5] as const;

/** One week's rent for a venue of this level (`override`: the back office's rent table). */
export const weeklyRent = (
  level: Level,
  override?: Partial<Record<string, number>>,
) => override?.[level] ?? city.venues[level].weeklyRent;

/** How many venues of this level the city has. */
export const venueCount = (level: Level) => city.venues[level].count;

/** What the tenant pays the market for one unit of stock. */
export const wholesale = (t: TokenId, level: Level, factor = 1) =>
  Math.max(1, Math.round(tokens[t].buyCost * priceScale(level) * factor));

/** The usual shelf price at this venue; the tenant may charge up to maxMarkup times it. */
export const shelfPrice = (t: TokenId, level: Level, factor = 1) =>
  Math.max(1, Math.round(defaultPrice(t, level) * factor));
export const maxShelfPrice = (t: TokenId, level: Level, factor = 1) =>
  shelfPrice(t, level, factor) * city.shop.maxMarkup;

/** Tokens a venue of this level may sell. */
export const shopTokens = (level: Level) =>
  ids(tokens).filter((t) => tokens[t].minLevel <= level);

export const canHostParty = (level: Level) => level >= city.party.minLevel;
