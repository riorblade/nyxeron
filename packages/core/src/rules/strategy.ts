import {
  levelData,
  night,
  priceScale,
  strategy,
  type DressCode,
  type StaffRole,
  type TacticId,
} from "../data";
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
    : 1) * dressCode(s).demand;

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
export const coverFor = (s: GameState, g: Pick<Guest, "female">) =>
  policyOn(s) && s.policy.ladiesNight && g.female
    ? 0
    : levelData(s.level).coverCharge;

// ---------- staff effects ----------

/** Guest Relations' reach: 1 = every guest inside gets attention. */
export const relationsCoverage = (s: GameState, inside: number) =>
  inside <= 0
    ? 0
    : Math.min(
        1,
        (s.staff.relations * strategy.relations.guestsPerStaff) / inside,
      );

/** Tables Guest Relations booked for tonight (bottle service); more reputation, more bookings. */
export function tablesFor(s: GameState): number {
  const r = strategy.relations;
  return Math.min(
    levelData(s.level).tables,
    Math.round(
      s.staff.relations * r.tablesPerStaff * (0.5 + s.reputation / 100),
    ),
  );
}

/** Minimum spend of one reserved table. */
export const tableSpend = (s: GameState) =>
  Math.round(strategy.relations.tableMinSpend * priceScale(s.level));

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
  const cap = levelData(s.level).capacity;
  const crowd = inside + s.staff.host * strategy.hosts.crowdEquivalent;
  const full = Math.min(1, crowd / (cap * e.fullAtCapacityShare));
  const dance = inside ? Math.min(1, dancing / inside / e.danceShareForMax) : 0;
  let target = 100 * (e.danceWeight * dance + e.fullWeight * full);
  const t = strategy.tactics;
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

export type TacticBlock = "wrongPhase" | "noStaff" | "noDj" | "cooldown" | null;

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
  if ((n.tactics[id]?.readyAt ?? 0) > n.minute) return "cooldown";
  return null;
}

/**
 * MC hype (sing-alongs, hands up), hosts to the dance floor, or the DJ's signature anthem. Each runs for a while and
 * then needs a cooldown; repeating a move tires the crowd (weaker each time). The anthem also keeps guests longer.
 */
export function crowdMove(s: GameState, id: TacticId): ActionResult {
  const block = tacticBlock(s, id);
  if (block === "wrongPhase") return fail("wrongPhase");
  if (block === "noStaff" || block === "noDj") return fail("noStaff");
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
  const power2 = Math.round(power * 100) / 100;
  return {
    ok: true,
    state: {
      ...s,
      night: {
        ...n,
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
        ...s.log,
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
