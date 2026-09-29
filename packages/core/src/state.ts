import {
  drinks,
  economy,
  ids,
  permits,
  staffRoles,
  type ChannelId,
  type DrinkId,
  type Genre,
  type Level,
  type PermitId,
  type SegmentId,
  type StaffRole,
  type SupplierId,
  type TalentId,
} from "./data";

export type Phase = "day" | "night" | "report";
export type Outcome = "victory" | "defeat" | "survived";
export type Mode = "career" | "basement";
export type Difficulty = "easy" | "normal" | "hard";
export type CeoCall = "happyHour" | "closeDoor";

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
