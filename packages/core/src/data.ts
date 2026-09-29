import channelsJson from "./data/channels.json";
import djsJson from "./data/djs.json";
import drinksJson from "./data/drinks.json";
import economyJson from "./data/economy.json";
import legalJson from "./data/legal.json";
import levelsJson from "./data/levels.json";
import nightJson from "./data/night.json";
import permitsJson from "./data/permits.json";
import segmentsJson from "./data/segments.json";
import scenariosJson from "./data/scenarios.json";
import staffJson from "./data/staff.json";
import strategyJson from "./data/strategy.json";
import suppliersJson from "./data/suppliers.json";

// ponytail: ids are the JSON keys, so adding an entry to a JSON file is the whole change.
export const drinks = drinksJson;
export const suppliers = suppliersJson;
export const permits = permitsJson;
export const channels = channelsJson;
export const djs = djsJson;
export const staffRoles = staffJson;
export const segments = segmentsJson;
export const levels = levelsJson;
export const economy = economyJson;
export const legal = legalJson;
export const night = nightJson;
export const scenarios = scenariosJson;
export const strategy = strategyJson;

export type DrinkId = keyof typeof drinks;
export type SupplierId = keyof typeof suppliers;
export type PermitId = keyof typeof permits;
export type ChannelId = keyof typeof channels;
export type TalentId = keyof typeof djs;
export type StaffRole = keyof typeof staffRoles;
export type SegmentId = keyof typeof segments;
export type DressCode = keyof typeof strategy.dressCode;
export type TacticId = keyof typeof strategy.tactics;
export type Genre = string;
export type Level = 1 | 2 | 3 | 4 | 5;

export const ids = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];
export const levelData = (level: Level) => levels[level];

/** Bigger venues charge more, pay more for stock and draw guests with deeper pockets. */
export const priceScale = (level: Level) => levels[level].priceScale;
export const defaultPrice = (drink: DrinkId, level: Level) =>
  Math.round(drinks[drink].defaultPrice * priceScale(level));
export const requiredPermits = (level: Level) =>
  levels[level].requiredPermits as PermitId[];

/** Some roles are paid like the venue earns: their wage grows with the level's price scale. */
export const wageOf = (role: StaffRole, level: Level) => {
  const r = staffRoles[role] as { wagePerDay: number; wageScales?: boolean };
  return r.wageScales
    ? Math.round(r.wagePerDay * priceScale(level))
    : r.wagePerDay;
};
