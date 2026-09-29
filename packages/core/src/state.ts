import {
  drinks,
  economy,
  ids,
  permits,
  staffRoles,
  type ChannelId,
  type DressCode,
  type DrinkId,
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
/** sandbox: free play at a chosen venue, no win or loss. */
export type Mode = "career" | "basement" | "sandbox";
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
  drink: DrinkId;
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
      { drink: DrinkId; qty: number; cost: number; arrivesDay: number }
    >
  | Ev<"orderDelivered", { drink: DrinkId; qty: number }>
  | Ev<"outOfStock", { drink: DrinkId }>
  | Ev<"upkeepPaid", { wages: number; rent: number }>
  | Ev<"taxPaid", { revenue: number; tax: number }>
  | Ev<"djBooked", { dj: TalentId; hype: number }>
  | Ev<"promoPosted", { channel: ChannelId; hype: number }>
  | Ev<"controversialPromo", { hype: number; backfired: boolean }>
  | Ev<"permitRenewed", { permit: PermitId; expiresDay: number }>
  | Ev<"levelUp", { level: Level }>
  | Ev<"djStarted", { dj: TalentId; crowdGenre: Genre; match: boolean }>
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
  | Ev<"gameOver", { outcome: Outcome }>;

export interface NightRevenue {
  bar: number;
  cover: number;
  table: number;
}

export type GuestState =
  "pending" | "queue" | "idle" | "bar" | "dance" | "left";

export interface Guest {
  id: number;
  segment: SegmentId;
  genre: Genre;
  budget: number;
  drunk: number;
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
  inspectionMinute: number | null;
  doorForced: boolean;
  /** CEO Call "Close Door": no more admissions tonight. */
  doorClosedByCeo: boolean;
  /** CEO Call "Happy Hour": cheaper drinks for the rest of the night. */
  happyHour: boolean;
  doorClosedLogged: boolean;
  crowdChecked: boolean;
  shutDown: boolean;
  sealed: boolean;
  underageAdmitted: number;
  rejectedUnderage: number;
  fights: number;
  /** Satisfaction factors for the Night Report ("no mysterious numbers", GDD 8). */
  outOfStockHits: number;
  slowServiceHits: number;
  djMatch: boolean | null;
  violationsTonight: number;
  finesTonight: number;
  outOfStockLogged: DrinkId[];
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
  /** Guards busy walking a drunk guest out, each until `until`. */
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
  stock: Record<DrinkId, number>;
  prices: Record<DrinkId, number>;
  pendingOrders: Order[];
  permits: Record<PermitId, Permit>;
  bookedTalent: TalentId[];
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
  opts: { clubName?: string; difficulty?: Difficulty } = {},
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
    stock: fill(ids(drinks), () => 0),
    prices: fill(ids(drinks), (d) => drinks[d].defaultPrice),
    pendingOrders: [],
    // The booth starts with a business permit; everything else is bought later.
    permits: fill(ids(permits), (p) =>
      p === "business"
        ? { valid: true, expiresDay: 1 + permits.business.durationDays }
        : { valid: false, expiresDay: 0 },
    ),
    bookedTalent: [],
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
};

/**
 * Fills in fields added after a save was written (house rules, new staff roles, crowd energy), so older saves load.
 */
export function migrateState(s: GameState): GameState {
  const staff = { ...fill(ids(staffRoles), () => 0), ...s.staff };
  const n = s.night;
  return {
    ...s,
    staff,
    policy: { ...DEFAULT_POLICY, ...s.policy },
    promoters: s.promoters ?? [],
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
