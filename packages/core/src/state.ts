import type { Visitor } from "./rules/visitor";
import {
  tokens,
  defaultPrice,
  maxPrice,
  economy,
  ids,
  isId,
  levels,
  permits,
  priceScale,
  requiredPermits,
  staffRoles,
  strategy,
  type BandId,
  type ChannelId,
  type DressCode,
  type TokenId,
  type HappyHourSlot,
  type Genre,
  type Level,
  type PermitId,
  type PromoterId,
  type SeatType,
  type SegmentId,
  type StaffRole,
  type SupplierId,
  type TacticId,
  type TalentId,
  type UpgradeId,
} from "./data";

export type Phase = "day" | "night" | "report";
export type Outcome = "victory" | "defeat" | "survived";
/** event: a club night run by the AI CEO (guests' events, DJ gigs): no win or loss. */
export type Mode = "career" | "basement" | "event";
export type Difficulty = "easy" | "normal" | "hard";
export type CeoCall = "happyHour" | "closeDoor";

/** House rules set by day; they stay until changed. */
export interface HousePolicy {
  /** Ladies' night: women get in free (more women come, and more men follow). */
  ladiesNight: boolean;
  dressCode: DressCode;
  /** Entry price; null = the level's standard cover. */
  cover: number | null;
  /** Scheduled happy hour: early pulls the crowd in sooner, late keeps it longer. */
  happyHour: HappyHourSlot;
}
export const DEFAULT_POLICY: HousePolicy = {
  ladiesNight: false,
  dressCode: "none",
  cover: null,
  happyHour: "off",
};

/** A crowd move's state tonight: active until `until`, usable again from `readyAt`. */
export interface TacticState {
  uses: number;
  until: number;
  readyAt: number;
  /** Effect strength this use (after fatigue / DJ match). */
  power: number;
}

export interface Order {
  drink: TokenId;
  qty: number;
  supplier: SupplierId;
  arrivesDay: number;
}

export interface Permit {
  valid: boolean;
  expiresDay: number;
}

type Ev<K extends string, T = object> = {
  day: number;
  minute?: number;
  kind: K;
} & T;
export type GameEvent =
  | Ev<
      "orderPlaced",
      { drink: TokenId; qty: number; cost: number; arrivesDay: number }
    >
  | Ev<"orderDelivered", { drink: TokenId; qty: number }>
  | Ev<"outOfStock", { drink: TokenId }>
  | Ev<"upkeepPaid", { wages: number; rent: number }>
  | Ev<"taxPaid", { revenue: number; tax: number }>
  | Ev<"djBooked", { dj: TalentId; hype: number }>
  | Ev<"promoPosted", { channel: ChannelId; hype: number }>
  | Ev<"controversialPromo", { hype: number; backfired: boolean }>
  | Ev<"permitRenewed", { permit: PermitId; expiresDay: number }>
  | Ev<"levelUp", { level: Level }>
  /** Moving up: stock (shelves + orders on the way) that didn't fit the new venue's stock room stayed behind. */
  | Ev<"stockTrimmed", { drink: TokenId; qty: number }>
  | Ev<"djStarted", { dj: TalentId; crowdGenre: Genre; match: boolean }>
  | Ev<"bandBooked", { band: BandId; hype: number }>
  | Ev<"bandStarted", { band: BandId; crowdGenre: Genre; match: boolean }>
  | Ev<"doorClosed">
  | Ev<"doorForced">
  | Ev<"fight", { guest: number }>
  | Ev<
      "inspection",
      { passed: boolean; missing: PermitId[]; underage: boolean; fine: number }
    >
  | Ev<"venueSealed">
  | Ev<"crowdShutdown">
  | Ev<"ceoCall", { call: CeoCall }>
  | Ev<"guestEscorted", { guest: number }>
  | Ev<"rivalPromo", { hype: number }>
  | Ev<"supplierDelay", { days: number }>
  | Ev<"tactic", { tactic: TacticId; power: number }>
  | Ev<"securityStretched", { waiting: number }>
  | Ev<"tablesSeated", { tables: number; revenue: number }>
  | Ev<"crowdThinning", { energy: number }>
  | Ev<"policyChanged", { policy: HousePolicy }>
  | Ev<"promoterBooked", { promoter: PromoterId }>
  | Ev<"upgradeBought", { upgrade: UpgradeId; tier: number; cost: number }>
  | Ev<"sparklerParade", { bottles: number; revenue: number }>
  | Ev<"nightRep", { delta: number; satisfaction: number }>
  | Ev<"gameOver", { outcome: Outcome }>;

export interface NightRevenue {
  bar: number;
  cover: number;
  table: number;
  /** The platform's share of the spread over spot on token sales (already out of the club's coin). */
  platformFee?: number;
}

export type GuestState =
  "pending" | "queue" | "idle" | "bar" | "dance" | "left";

export interface Guest {
  id: number;
  segment: SegmentId;
  genre: Genre;
  budget: number;
  tilt: number;
  satisfaction: number;
  underage: boolean;
  state: GuestState;
  arriveMinute: number;
  leaveMinute: number;
  /** false for guests who never got in (rejected at the door or still queued at close). */
  admitted: boolean;
  /** Hit an out-of-stock drink once (R2); afterwards only orders what is in stock. */
  disappointed: boolean;
  female: boolean;
  /** Tokens bought tonight and their average market index at purchase (their P&L is felt against it). */
  bought?: number;
  basis?: number;
  /** On a promoter's guest list: arrives early, skips the cover, the promoter is paid per head. */
  guestList?: PromoterId;
  /** Already stayed on once past their planned leave time (encore). */
  encore?: boolean;
}

export interface NightState {
  minute: number;
  startCoin: number;
  startReputation: number;
  guests: Guest[];
  djMultiplier: number;
  /** Live token market: multiplier on list price per token, and its slow average (for momentum). */
  market: Partial<Record<TokenId, number>>;
  marketEma: Partial<Record<TokenId, number>>;
  /** The market multiplier at the end of every minute so far tonight (for the charts). */
  marketHist: Partial<Record<TokenId, number[]>>;
  /** Players who came to party tonight (guest role), by player id: "me" offline, the relay peer id online. */
  visitors?: Record<string, Visitor>;
  /** Live band's dance multiplier while its set runs (null = not playing). */
  bandMultiplier: number | null;
  inspectionMinute: number | null;
  doorForced: boolean;
  /** CEO Call "Close Door": no more admissions tonight. */
  doorClosedByCeo: boolean;
  /** CEO Call "Happy Hour": cheaper tokens for the rest of the night. */
  happyHour: boolean;
  doorClosedLogged: boolean;
  crowdChecked: boolean;
  shutDown: boolean;
  sealed: boolean;
  underageAdmitted: number;
  rejectedUnderage: number;
  fights: number;
  /** Satisfaction factors for the Night Report ("no mysterious numbers"). */
  outOfStockHits: number;
  slowServiceHits: number;
  djMatch: boolean | null;
  violationsTonight: number;
  finesTonight: number;
  outOfStockLogged: TokenId[];
  /** Crowd energy 0–100: how full and how moving the room is. */
  energy: number;
  energySum: number;
  peakEnergy: number;
  thinningLogged: boolean;
  tactics: Partial<Record<TacticId, TacticState>>;
  /** Reservations tonight per seat type; seated (and paid their minimum spend) at tablesArriveMinute. */
  bookings: Record<SeatType, number>;
  /** Drinks guests bought for someone else. */
  rounds: number;
  rejectedDress: number;
  guestListIn: number;
  commission: number;
  bottles: number;
  /** Guards busy walking a tilt guest out, each until `until`. */
  escorts: { guest: number; until: number }[];
  escorted: number;
  stretchedLogged: boolean;
}

export interface NightReport {
  day: number;
  guests: number;
  rejectedUnderage: number;
  revenue: NightRevenue;
  tax: number;
  /** Coin change over the night (sales − tax − fines − penalties). Wages/rent are charged at new day. */
  profit: number;
  fines: number;
  avgSatisfaction: number;
  repDelta: number;
  fights: number;
  outOfStockHits: number;
  slowServiceHits: number;
  djMatch: boolean | null;
  violations: number;
  shutDown: boolean;
  sealed: boolean;
  avgEnergy: number;
  peakEnergy: number;
  rounds: number;
  tables: number;
  vipTables: number;
  barSeats: number;
  rejectedDress: number;
  tacticsUsed: TacticId[];
  guestListIn: number;
  commission: number;
  bottles: number;
  escorted: number;
}

export interface GameState {
  /** Live spot prices (USD per share, by underlying ticker) and the first ones seen (see rules/quotes.ts). */
  quotes?: Record<string, number>;
  quoteRef?: Record<string, number>;
  mode: Mode;
  clubName: string;
  day: number;
  phase: Phase;
  level: Level;
  clubGenre: Genre;
  coin: number;
  reputation: number;
  hype: number;
  safety: number;
  ceoEnergy: number;
  ceoCallUsed: boolean;
  violations: number;
  negativeCashDays: number;
  stock: Record<TokenId, number>;
  prices: Record<TokenId, number>;
  pendingOrders: Order[];
  permits: Record<PermitId, Permit>;
  bookedTalent: TalentId[];
  /** Live band on the stage tonight (cleared each day). */
  bookedBand: BandId | null;
  activePromos: ChannelId[];
  staff: Record<StaffRole, number>;
  policy: HousePolicy;
  /** Minimum spend per seat type; a missing entry = the standard price for this venue. */
  minSpend: Partial<Record<SeatType, number>>;
  /** Restock a drink automatically at night when it runs low (instant supplier). */
  autoRefill: boolean;
  /** Promoters booked for tonight (cleared each day). */
  promoters: PromoterId[];
  /** Sound system / lighting rig tier (0–3); a new venue starts from scratch. */
  upgrades: Record<UpgradeId, number>;
  forcedInspection: boolean;
  sealedNights: number;
  /** Extra lead-time days on supplier orders today (scenario event). */
  supplierDelay: number;
  nightRevenue: NightRevenue;
  night: NightState | null;
  lastReport: NightReport | null;
  outcome: Outcome | null;
  /** Played on after this result: no end date any more; a survived club can still win once (defeat still ends it). */
  freePlay?: "victory" | "survived";
  log: GameEvent[];
  seed: number;
}

const fill = <K extends string, V>(keys: K[], v: (k: K) => V) =>
  Object.fromEntries(keys.map((k) => [k, v(k)])) as Record<K, V>;

export const clamp = (v: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, v));

export function createGameState(
  seed: number,
  clubGenre: Genre = "edm",
  opts: { clubName?: string; difficulty?: Difficulty; level?: Level } = {},
): GameState {
  const s = newCareer(seed, clubGenre, opts);
  return opts.level && opts.level > 1 ? startAt(s, opts.level) : s;
}

/**
 * A career that starts at a venue the player was given access to (back office): the venue's permits, its prices,
 * the reputation it asks for, and a purse scaled like its prices (Level 5: 400K at normal).
 */
function startAt(s: GameState, level: Level): GameState {
  return {
    ...s,
    level,
    coin: Math.round((s.coin * priceScale(level)) / priceScale(1)),
    reputation: Math.max(s.reputation, levels[level].repRequired),
    // Like climbing there: prices move with the venue's price scale (r18).
    prices: fill(ids(tokens), (d) =>
      Math.round((s.prices[d] * priceScale(level)) / priceScale(1)),
    ),
    permits: fill(ids(permits), (p) =>
      requiredPermits(level).includes(p)
        ? { valid: true, expiresDay: 1 + permits[p].durationDays }
        : { valid: false, expiresDay: 0 },
    ),
  };
}

function newCareer(
  seed: number,
  clubGenre: Genre,
  opts: { clubName?: string; difficulty?: Difficulty },
): GameState {
  return {
    mode: "career",
    clubName: opts.clubName ?? "NYXERON",
    day: 1,
    phase: "day",
    level: 1,
    clubGenre,
    coin: Math.round(
      economy.startCoin *
        economy.difficulty[opts.difficulty ?? "normal"].coinMultiplier,
    ),
    reputation: economy.startReputation,
    hype: economy.startHype,
    safety: economy.startSafety,
    ceoEnergy: economy.ceoEnergyPerDay,
    ceoCallUsed: false,
    violations: 0,
    negativeCashDays: 0,
    stock: fill(ids(tokens), () => 0),
    prices: fill(ids(tokens), (d) => tokens[d].defaultPrice),
    pendingOrders: [],
    // The booth starts with a business permit; everything else is bought later.
    permits: fill(ids(permits), (p) =>
      p === "business"
        ? { valid: true, expiresDay: 1 + permits.business.durationDays }
        : { valid: false, expiresDay: 0 },
    ),
    bookedTalent: [],
    bookedBand: null,
    activePromos: [],
    staff: fill(ids(staffRoles), () => 0),
    policy: DEFAULT_POLICY,
    minSpend: {},
    autoRefill: false,
    promoters: [],
    upgrades: { sound: 0, lighting: 0, vip: 0, capacity: 0, storage: 0 },
    forcedInspection: false,
    sealedNights: 0,
    supplierDelay: 0,
    nightRevenue: { bar: 0, cover: 0, table: 0 },
    night: null,
    lastReport: null,
    outcome: null,
    log: [],
    seed,
  };
}

const NO_UPGRADES = { sound: 0, lighting: 0, vip: 0, capacity: 0, storage: 0 };

const NIGHT_DEFAULTS = {
  energy: 30,
  energySum: 0,
  peakEnergy: 0,
  thinningLogged: false,
  tactics: {},
  bookings: { vip: 0, sofa: 0, table: 0, bar: 0 },
  rounds: 0,
  rejectedDress: 0,
  guestListIn: 0,
  commission: 0,
  bottles: 0,
  escorts: [],
  escorted: 0,
  stretchedLogged: false,
  bandMultiplier: null,
  market: {},
  marketEma: {},
  marketHist: {},
};

/**
 * Fills in fields added after a save was written (house rules, new staff roles, crowd energy), so older saves load.
 */
/** Days of event log a save keeps (screens only show today's; objectives look at today). */
export const SAVE_LOG_DAYS = 7;

/**
 * What a save needs: the night is over once the report shows (the report reads lastReport), so its guest list and
 * price history are dropped, and only the last week of the event log is kept. Keeps a 60-day career's save small.
 */
export function compactForSave(s: GameState): GameState {
  return {
    ...s,
    night: s.phase === "report" ? null : s.night,
    log: s.log.filter((e) => e.day > s.day - SAVE_LOG_DAYS),
  };
}

/** List prices a save can hold: a positive integer up to the venue's ceiling (an old save may carry null/huge ones). */
function repairPrices(s: GameState): GameState["prices"] {
  const ok = (d: TokenId) => {
    const p = s.prices?.[d];
    return Number.isInteger(p) && p > 0 && p <= maxPrice(d, s.level);
  };
  if (ids(tokens).every(ok)) return s.prices;
  return fill(ids(tokens), (d) =>
    ok(d)
      ? s.prices[d]
      : Number.isFinite(s.prices?.[d]) && s.prices[d] > 0
        ? Math.max(1, Math.min(maxPrice(d, s.level), Math.round(s.prices[d])))
        : defaultPrice(d, s.level),
  );
}

/** House rules a save can hold: an old save with an unknown dress code / slot would crash every night after. */
function repairPolicy(p: Partial<HousePolicy> | undefined): HousePolicy {
  const d = DEFAULT_POLICY;
  return {
    ladiesNight:
      typeof p?.ladiesNight === "boolean" ? p.ladiesNight : d.ladiesNight,
    dressCode: isId(strategy.dressCode, p?.dressCode)
      ? p.dressCode
      : d.dressCode,
    cover:
      p?.cover === null ||
      (Number.isInteger(p?.cover) && (p?.cover as number) >= 0)
        ? (p?.cover ?? null)
        : d.cover,
    happyHour:
      p?.happyHour === "off" || isId(strategy.happyHour, p?.happyHour)
        ? p!.happyHour!
        : d.happyHour,
  };
}

export function migrateState(s: GameState): GameState {
  const staff = { ...fill(ids(staffRoles), () => 0), ...s.staff };
  const n = s.night;
  return {
    ...s,
    // The old player sandbox is gone (venue access comes from the back office): its saves play on as careers.
    mode: (s.mode as string) === "sandbox" ? "career" : s.mode,
    staff,
    prices: repairPrices(s),
    policy: repairPolicy(s.policy),
    promoters: s.promoters ?? [],
    bookedBand: s.bookedBand ?? null,
    minSpend: s.minSpend ?? {},
    autoRefill: s.autoRefill ?? false,
    upgrades: { ...NO_UPGRADES, ...s.upgrades },
    night: n && {
      ...NIGHT_DEFAULTS,
      ...n,
      guests: n.guests.map((g) => ({ ...g, female: g.female ?? false })),
    },
  };
}
