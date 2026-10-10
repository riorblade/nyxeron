import {
  isId,
  levelData,
  night,
  priceScale,
  promoters,
  strategy,
  type DressCode,
  type PromoterId,
  type SeatType,
  type StaffRole,
  type TacticId,
  type UpgradeId,
} from "../data";
import { createRng } from "../rng";
import { fail, type ActionResult } from "../result";
import {
  clamp,
  type GameState,
  type Guest,
  type HousePolicy,
  type NightState,
} from "../state";

/** House rules unlock with the bar (Level 3): a booth has no door to police. */
export const POLICY_MIN_LEVEL = 3;

const lerp = ([a, b]: number[], t: number) => a! + (b! - a!) * clamp(t, 0, 1);

// ---------- house rules (set by day) ----------

/** Ladies' night / dress code. Daytime only; stays in force until changed. */
export function setPolicy(
  s: GameState,
  patch: Partial<HousePolicy>,
): ActionResult {
  if (s.phase !== "day") return fail("wrongPhase");
  if (s.level < POLICY_MIN_LEVEL) return fail("levelLocked");
  // A key sent as undefined means "leave it": spreading it would wipe the rule (and crash the next night).
  patch = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<HousePolicy>;
  // Only house rules the game knows: an unknown dress code or happy-hour slot would break every night after.
  if (
    (patch.dressCode !== undefined &&
      !isId(strategy.dressCode, patch.dressCode)) ||
    (patch.happyHour !== undefined &&
      patch.happyHour !== "off" &&
      !isId(strategy.happyHour, patch.happyHour)) ||
    (patch.ladiesNight !== undefined && typeof patch.ladiesNight !== "boolean")
  )
    return fail("invalidTarget");
  if (
    patch.cover != null &&
    (!Number.isInteger(patch.cover) || patch.cover < 0)
  )
    return fail("invalidPrice");
  const policy = { ...s.policy, ...patch };
  return {
    ok: true,
    state: {
      ...s,
      policy,
      log: [...s.log, { day: s.day, kind: "policyChanged", policy }],
    },
  };
}

const policyOn = (s: GameState) => s.level >= POLICY_MIN_LEVEL;

/** Share of tonight's arrivals who are women. */
export const femaleShare = (s: GameState) =>
  strategy.femaleShare +
  (policyOn(s) && s.policy.ladiesNight
    ? strategy.ladiesNight.femaleShareBonus
    : 0);

/** Guest-count multiplier from house rules: ladies' night draws a bigger crowd, a dress code puts some off. */
export const policyDemand = (s: GameState) =>
  (policyOn(s) && s.policy.ladiesNight
    ? 1 + strategy.ladiesNight.demandBonus
    : 1) *
  dressCode(s).demand *
  coverDemand(s);

/** The standard entry price at this level, and the one the player set. */
export const standardCover = (s: GameState) => levelData(s.level).coverCharge;
export const coverPrice = (s: GameState) =>
  policyOn(s) && s.policy.cover != null ? s.policy.cover : standardCover(s);

/** Pricier door, fewer people bother; a cheap door pulls more in. 1 at the standard cover. */
export function coverDemand(s: GameState): number {
  const c = strategy.cover;
  const ref = c.reference * priceScale(s.level);
  return clamp(
    1 - (c.elasticity * (coverPrice(s) - standardCover(s))) / ref,
    c.minDemand,
    c.maxDemand,
  );
}

/** A cheap door brings a thriftier crowd; an expensive one, bigger spenders. 1 at the standard cover. */
export function coverBudget(s: GameState): number {
  const c = strategy.cover;
  const ref = c.reference * priceScale(s.level);
  return clamp(
    1 + (c.budgetElasticity * (coverPrice(s) - standardCover(s))) / ref,
    c.minBudget,
    c.maxBudget,
  );
}

/** Is the scheduled happy hour on at this minute? */
export function happyHourAt(s: GameState, minute: number): boolean {
  const slot = policyOn(s) ? s.policy.happyHour : "off";
  if (slot === "off") return false;
  const w = strategy.happyHour[slot];
  return minute >= w.start && minute < w.end;
}

/**
 * Men spend more in a room with women in it (buying rounds, impressing): budget multiplier for a male guest,
 * from tonight's expected female share above normal and the hosts on shift.
 */
export const maleBudget = (s: GameState) =>
  1 +
  strategy.impress.perFemaleShare * (femaleShare(s) - strategy.femaleShare) +
  Math.min(strategy.impress.maxHost, strategy.impress.perHost * s.staff.host);

export const dressCode = (s: GameState) =>
  strategy.dressCode[policyOn(s) ? s.policy.dressCode : ("none" as DressCode)];

/** Chance this guest is turned away for not meeting the dress code. */
export const dressReject = (s: GameState, g: Pick<Guest, "female">) =>
  g.female ? dressCode(s).rejectFemale : dressCode(s).rejectMale;

/** Cover this guest pays at the door (women free on ladies' night). */
/** Guest list and (on ladies' night) women get in free; everyone else pays the cover. */
export const coverFor = (
  s: GameState,
  g: Pick<Guest, "female" | "guestList">,
) =>
  g.guestList || (policyOn(s) && s.policy.ladiesNight && g.female)
    ? 0
    : coverPrice(s);

// ---------- promoters (guest list) ----------

/** What a promoter is paid for each guest-list guest who gets in. */
export const commissionOf = (_s: GameState, id: PromoterId) =>
  promoters[id].commission;

/** Book (or cancel) a promoter for tonight: their guest list arrives early and skips the cover; paid per head. */
export function bookPromoter(s: GameState, id: PromoterId): ActionResult {
  if (s.phase !== "day") return fail("wrongPhase");
  if (!isId(promoters, id)) return fail("invalidTarget");
  if (s.level < promoters[id].minLevel) return fail("levelLocked");
  if (s.promoters.includes(id))
    return {
      ok: true,
      state: { ...s, promoters: s.promoters.filter((p) => p !== id) },
    };
  return {
    ok: true,
    state: {
      ...s,
      promoters: [...s.promoters, id],
      log: [...s.log, { day: s.day, kind: "promoterBooked", promoter: id }],
    },
  };
}

// ---------- sound & lighting ----------

export const MAX_UPGRADE = 3;
/** Tiers an upgrade has (sound/lighting 3, the VIP lounge 1). */
export const upgradeTiers = (id: UpgradeId) =>
  strategy.upgrades[id].cost.length;
export const upgradeCost = (s: GameState, id: UpgradeId) =>
  s.upgrades[id] >= upgradeTiers(id)
    ? null
    : Math.round(
        strategy.upgrades[id].cost[s.upgrades[id]]! * priceScale(s.level),
      );

/** Next tier of the sound system or lighting rig (by day). A new venue starts with the house rig again. */
export function buyUpgrade(s: GameState, id: UpgradeId): ActionResult {
  if (s.phase !== "day") return fail("wrongPhase");
  if (!isId(strategy.upgrades, id)) return fail("invalidTarget");
  if (s.level < strategy.upgrades[id].minLevel) return fail("levelLocked");
  const cost = upgradeCost(s, id);
  if (cost === null) return fail("maxLevel");
  if (s.coin < cost) return fail("notEnoughCoin", cost - s.coin);
  const tier = s.upgrades[id] + 1;
  return {
    ok: true,
    state: {
      ...s,
      coin: s.coin - cost,
      upgrades: { ...s.upgrades, [id]: tier },
      log: [
        ...s.log,
        { day: s.day, kind: "upgradeBought", upgrade: id, tier, cost },
      ],
    },
  };
}

/** Guests allowed inside: the venue's licence plus any expansion (each tier +15%). */
export const capacityOf = (s: GameState) =>
  Math.round(
    levelData(s.level).capacity *
      (1 + (s.upgrades.capacity ?? 0) * strategy.upgrades.capacity.perTier),
  );

/** Bottles the stock room holds (each tier +50%). Stock on hand and on order both count. */
export const storageOf = (s: GameState) =>
  Math.round(
    levelData(s.level).storage *
      (1 + (s.upgrades.storage ?? 0) * strategy.upgrades.storage.perTier),
  );
export const stockHeld = (s: GameState) =>
  Object.values(s.stock).reduce((a, n) => a + n, 0) +
  s.pendingOrders.reduce((a, o) => a + o.qty, 0);

/** Energy the rig adds to the room. */
export const rigEnergy = (s: GameState) =>
  s.upgrades.sound * strategy.upgrades.sound.energyPerTier +
  s.upgrades.lighting * strategy.upgrades.lighting.energyPerTier;

// ---------- staff effects ----------

/** Guest Relations' reach: 1 = every guest inside gets attention. */
export const relationsCoverage = (s: GameState, inside: number) =>
  inside <= 0
    ? 0
    : Math.min(
        1,
        (s.staff.relations * strategy.relations.guestsPerStaff) / inside,
      );

// ---------- reservations & minimum spend ----------

export const SEAT_TYPES: SeatType[] = ["vip", "sofa", "table", "bar"];

/** Minimum spend for a seat type: the player's price, or the venue's standard. */
export const standardSpend = (s: GameState, t: SeatType) =>
  Math.round(strategy.seats[t].defaultSpend * priceScale(s.level));
export const seatSpend = (s: GameState, t: SeatType) =>
  s.minSpend?.[t] ?? standardSpend(s, t);

/** Seats of each type this venue has (VIP only once the lounge is built). */
export function seatCount(s: GameState): Record<SeatType, number> {
  const l = levelData(s.level);
  return {
    vip: s.upgrades.vip ? l.vipTables : 0,
    sofa: l.sofas,
    table: l.tables,
    bar: l.barSeats,
  };
}

/**
 * Tonight's bookings per seat type. VIP, sofas and tables are booked by Guest Relations (more reputation, more
 * bookings); bar seats fill with walk-ins. A minimum spend above standard books fewer, below standard more.
 */
export function bookingsFor(s: GameState): Record<SeatType, number> {
  const seats = seatCount(s);
  const rep = 0.5 + s.reputation / 100;
  const out = {} as Record<SeatType, number>;
  for (const t of SEAT_TYPES) {
    const cfg = strategy.seats[t] as {
      elasticity: number;
      perStaff?: number;
      walkIn?: number;
    };
    const price = clamp(
      1 - cfg.elasticity * (seatSpend(s, t) / standardSpend(s, t) - 1),
      0,
      1.5,
    );
    const demand =
      cfg.walkIn !== undefined
        ? seats[t] * (cfg.walkIn + s.reputation / 200)
        : s.staff.relations * cfg.perStaff! * rep;
    out[t] = Math.min(seats[t], Math.round(demand * price));
  }
  return out;
}

/** Turn night-time auto-refill on or off (any time). */
export const setAutoRefill = (s: GameState, on: boolean): ActionResult => ({
  ok: true,
  state: { ...s, autoRefill: on },
});

/** Set a seat type's minimum spend (null = back to standard). By day. */
export function setMinSpend(
  s: GameState,
  t: SeatType,
  price: number | null,
): ActionResult {
  if (s.phase !== "day") return fail("wrongPhase");
  if (s.level < POLICY_MIN_LEVEL) return fail("levelLocked");
  if (!isId(strategy.seats, t)) return fail("invalidTarget");
  if (price !== null && (!Number.isInteger(price) || price < 0))
    return fail("invalidPrice");
  const minSpend = { ...s.minSpend };
  if (price === null) delete minSpend[t];
  else minSpend[t] = price;
  return { ok: true, state: { ...s, minSpend } };
}

/** Sofas + tables booked tonight. */
export const tablesFor = (s: GameState) => {
  const b = bookingsFor(s);
  return b.sofa + b.table;
};
export const vipFor = (s: GameState) => bookingsFor(s).vip;
export const vipSpend = (s: GameState) => seatSpend(s, "vip");
/** A regular table's minimum spend (what a sparkler-parade bottle is priced from). */
export const tableSpend = (s: GameState) => seatSpend(s, "table");

/** Chance a man who just bought a drink buys another for someone (a woman in the crowd, or a host). */
export function roundChance(s: GameState, femaleShareInside: number): number {
  const r = strategy.rounds;
  return Math.min(
    r.max,
    r.base + r.perFemaleShare * femaleShareInside + r.perHost * s.staff.host,
  );
}

// ---------- crowd energy ----------

/** Where the room's energy is heading this minute: dancing share, fullness (hosts count), and active crowd moves. */
export function energyTarget(
  s: GameState,
  n: NightState,
  inside: number,
  dancing: number,
): number {
  const e = strategy.energy;
  const cap = capacityOf(s);
  const crowd = inside + s.staff.host * strategy.hosts.crowdEquivalent;
  const full = Math.min(1, crowd / (cap * e.fullAtCapacityShare));
  const dance = inside ? Math.min(1, dancing / inside / e.danceShareForMax) : 0;
  let target =
    100 * (e.danceWeight * dance + e.fullWeight * full) + rigEnergy(s);
  // A live band on stage lifts the room (more when its genre suits the crowd).
  if (n.bandMultiplier) target += night.band.energy * n.bandMultiplier;
  const t = strategy.tactics;
  if (active(n, "sparkler"))
    target += t.sparkler.energy * n.tactics.sparkler!.power;
  if (active(n, "mcHype")) target += t.mcHype.energy * n.tactics.mcHype!.power;
  if (active(n, "djAnthem"))
    target += t.djAnthem.energy * n.tactics.djAnthem!.power;
  if (active(n, "hostsFloor"))
    // Social proof works best on an empty floor.
    target +=
      Math.min(
        t.hostsFloor.maxEnergy,
        t.hostsFloor.energyPerHost * s.staff.host,
      ) *
      n.tactics.hostsFloor!.power *
      (1 - n.energy / 200);
  return clamp(target);
}

export const danceMultiplier = (energy: number) =>
  lerp(strategy.energy.danceMultiplier, energy / 100);
export const barMultiplier = (energy: number) =>
  lerp(strategy.energy.barMultiplier, energy / 100);

// ---------- crowd moves (at night) ----------

export const active = (n: NightState, id: TacticId) =>
  (n.tactics[id]?.until ?? -1) > n.minute;

export type TacticBlock =
  "wrongPhase" | "noStaff" | "noDj" | "noTables" | "cooldown" | null;

/** Price of one bottle bought by a copycat after the sparkler parade. */
export const bottlePrice = (s: GameState) =>
  Math.round(tableSpend(s) * strategy.tactics.sparkler.bottleShare);
export const sparklerCost = (s: GameState) =>
  Math.round(strategy.tactics.sparkler.cost * priceScale(s.level));

/** Why a crowd move can't be used right now (null = ready). */
export function tacticBlock(s: GameState, id: TacticId): TacticBlock {
  const n = s.night;
  if (s.phase !== "night" || !n) return "wrongPhase";
  const t = strategy.tactics[id];
  if (t.staff && s.staff[t.staff as StaffRole] <= 0) return "noStaff";
  if (
    id === "djAnthem" &&
    (!s.bookedTalent.length || n.minute < night.djSetStartMinute)
  )
    return "noDj";
  if (
    id === "sparkler" &&
    (n.bookings.vip + n.bookings.sofa + n.bookings.table <= 0 ||
      n.minute < strategy.relations.tablesArriveMinute)
  )
    return "noTables";
  if ((n.tactics[id]?.readyAt ?? 0) > n.minute) return "cooldown";
  return null;
}

/**
 * MC hype (sing-alongs, hands up), hosts to the dance floor, or the DJ's signature anthem. Each runs for a while and
 * then needs a cooldown; repeating a move tires the crowd (weaker each time). The anthem also keeps guests longer.
 */
export function crowdMove(s: GameState, id: TacticId): ActionResult {
  if (!isId(strategy.tactics, id)) return fail("invalidTarget");
  const block = tacticBlock(s, id);
  if (block === "wrongPhase") return fail("wrongPhase");
  if (block === "noStaff" || block === "noDj" || block === "noTables")
    return fail("noStaff");
  if (id === "sparkler" && s.coin < sparklerCost(s))
    return fail("notEnoughCoin", sparklerCost(s) - s.coin);
  if (block === "cooldown") return fail("alreadyActive");
  const n = s.night!;
  const t = strategy.tactics[id];
  const uses = n.tactics[id]?.uses ?? 0;
  let power = Math.max(0.2, 1 - t.fatigue * uses);
  if (id === "djAnthem")
    power =
      n.djMatch === true
        ? strategy.tactics.djAnthem.matchFactor
        : n.djMatch === false
          ? strategy.tactics.djAnthem.mismatchFactor
          : 1;
  let guests = n.guests;
  if (id === "djAnthem") {
    const a = strategy.tactics.djAnthem;
    guests = guests.map((g) =>
      g.state === "idle" || g.state === "bar" || g.state === "dance"
        ? {
            ...g,
            satisfaction: clamp(g.satisfaction + a.satisfaction * power),
            // Stay longer, up to closing (never shorter than planned).
            leaveMinute: Math.max(
              g.leaveMinute,
              Math.min(
                night.minutes,
                g.leaveMinute + Math.round(a.stayExtension * power),
              ),
            ),
          }
        : g,
    );
  }
  // Sparkler parade: the bottles go out lit up; other big spenders want theirs too.
  let coin = s.coin;
  let seed = s.seed;
  let table = s.nightRevenue.table;
  let bottles = 0;
  const log = [...s.log];
  if (id === "sparkler") {
    const sp = strategy.tactics.sparkler;
    const price = bottlePrice(s);
    const rng = createRng(s.seed);
    coin -= sparklerCost(s);
    guests = guests.map((g) => {
      const inside =
        g.state === "idle" || g.state === "bar" || g.state === "dance";
      if (!inside) return g;
      const copy = g.budget >= price && rng.chance(sp.copycat * power);
      if (copy) bottles++;
      return {
        ...g,
        // Showing off: most of the bottle is an impulse on top of what they planned to spend.
        budget: copy
          ? g.budget - Math.round(price * (1 - sp.splurge))
          : g.budget,
        satisfaction: clamp(
          g.satisfaction + (copy ? sp.satisfaction : 2) * power,
        ),
      };
    });
    seed = rng.seed;
    coin += bottles * price;
    table += bottles * price;
    log.push({
      day: s.day,
      minute: n.minute,
      kind: "sparklerParade",
      bottles,
      revenue: bottles * price,
    });
  }
  const power2 = Math.round(power * 100) / 100;
  return {
    ok: true,
    state: {
      ...s,
      coin,
      seed,
      nightRevenue: { ...s.nightRevenue, table },
      night: {
        ...n,
        bottles: n.bottles + bottles,
        guests,
        tactics: {
          ...n.tactics,
          [id]: {
            uses: uses + 1,
            until: n.minute + t.duration,
            readyAt: n.minute + t.cooldown,
            power: power2,
          },
        },
      },
      log: [
        ...log,
        {
          day: s.day,
          minute: n.minute,
          kind: "tactic",
          tactic: id,
          power: power2,
        },
      ],
    },
  };
}
