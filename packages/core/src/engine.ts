import {
  channels,
  defaultPrice,
  djs,
  drinks,
  ids,
  legal,
  levelData,
  night,
  priceScale,
  promoters,
  segments,
  strategy,
  type DrinkId,
  type ChannelId,
  type SegmentId,
} from "./data";
import { createRng } from "./rng";
import type { ActionResult } from "./result";
import { r05_promote } from "./rules/marketing";
import { applyDayEvents, checkScenarioEnd } from "./scenario";
import {
  r13_checkDefeat,
  r12_newDay,
  r15_entertainmentTax,
} from "./rules/economy";
import { r02_serveDrink } from "./rules/inventory";
import { inspect, permitActive, r06_inspectionChance } from "./rules/legal";
import { r14_checkVictory } from "./rules/progression";
import { r11_reputationDelta } from "./rules/reputation";
import { r08_rejectAtDoor, r09_fightChance } from "./rules/security";
import { dominantGenre, r04_djMultiplier } from "./rules/talent";
import {
  active,
  barMultiplier,
  commissionOf,
  coverBudget,
  coverFor,
  danceMultiplier,
  dressCode,
  dressReject,
  energyTarget,
  femaleShare,
  happyHourAt,
  maleBudget,
  POLICY_MIN_LEVEL,
  policyDemand,
  relationsCoverage,
  roundChance,
  tablesFor,
  tableSpend,
  vipFor,
  vipSpend,
} from "./rules/strategy";
import {
  clamp,
  type GameEvent,
  type GameState,
  type Guest,
  type NightReport,
} from "./state";

const INSIDE = new Set<Guest["state"]>(["idle", "bar", "dance"]);
export const isInside = (g: Guest) => INSIDE.has(g.state);

/** Day 1 is a Sunday, so Day 7 is the Saturday event night (GDD 15.3). 0 = Sunday. */
export const weekday = (day: number) => (day - 1) % 7;

const busyFactor = (s: GameState) =>
  night.busyWeekdays.includes(weekday(s.day)) ? night.busyDayBonus : 1;

/** Guests expected tonight = f(hype, reputation, busy weekday, level demand). */
export function expectedGuests(s: GameState): number {
  const { base, hypeWeight, repWeight } = night.demand;
  const busy = night.busyWeekdays.includes(weekday(s.day))
    ? night.busyDayBonus
    : 1;
  const factor =
    base + (hypeWeight * s.hype) / 100 + (repWeight * s.reputation) / 100;
  return Math.round(
    levelData(s.level).demand * factor * busy * policyDemand(s),
  );
}

/** Base segment weights, with each active promo boosting its channel's audience (R5). */
function segmentWeights(s: GameState): Record<SegmentId, number> {
  const w = Object.fromEntries(
    ids(segments).map((id) => [id, segments[id].weight]),
  ) as Record<SegmentId, number>;
  for (const c of s.activePromos)
    w[channels[c].segment as SegmentId] += night.promoSegmentBoost;
  // A dress code attracts the big spenders.
  w.premium += dressCode(s).premiumWeight;
  return w;
}

/** One guest arriving at `arriveMinute`: segment by weight, genre, budget, stay. id is assigned by the caller. */
function makeGuest(
  rng: ReturnType<typeof createRng>,
  s: GameState,
  weights: Record<SegmentId, number>,
  arriveMinute: number,
  stay: readonly number[],
): Guest {
  const segment = rng.weighted(weights);
  const seg = segments[segment];
  const female = rng.chance(femaleShare(s));
  return {
    id: 0,
    segment,
    genre: rng.chance(night.clubGenreShare)
      ? s.clubGenre
      : rng.pick(seg.genres),
    budget: Math.round(
      rng.int(seg.budget[0]!, seg.budget[1]!) *
        priceScale(s.level) *
        dressCode(s).budgetMultiplier *
        coverBudget(s) *
        (female ? 1 : maleBudget(s)),
    ),
    drunk: 0,
    satisfaction: night.startSatisfaction,
    underage: rng.chance(night.underageChance),
    state: "pending",
    arriveMinute,
    leaveMinute: arriveMinute + rng.int(stay[0]!, stay[1]!),
    admitted: false,
    disappointed: false,
    female,
  };
}

/** Day → Night ("Open Club"). Generates tonight's guests and rolls the inspection. */
export function startNight(s: GameState): GameState {
  if (s.phase !== "day" || s.outcome) return s;
  const rng = createRng(s.seed);
  const sealed = s.sealedNights > 0;

  const weights = segmentWeights(s);
  const stay = levelData(s.level).stayMinutes;
  const guests: Guest[] = [];
  const count = sealed ? 0 : expectedGuests(s);
  for (let i = 0; i < count; i++)
    guests.push(
      makeGuest(rng, s, weights, rng.int(0, night.arrivalWindow - 1), stay),
    );
  if (!sealed) {
    // Promoters' guest lists: their crowd, early, on the list.
    for (const pid of s.promoters) {
      const p = promoters[pid];
      const heads = rng.int(
        Math.round(p.heads * 0.8),
        Math.round(p.heads * 1.2),
      );
      const only = { [p.segment]: 1 } as Record<SegmentId, number>;
      for (let i = 0; i < heads; i++)
        guests.push({
          ...makeGuest(
            rng,
            s,
            only,
            rng.int(0, strategy.guestList.arriveWindow - 1),
            stay,
          ),
          guestList: pid,
        });
    }
    // Scheduled happy hour: early pulls part of the crowd in sooner, late keeps it longer.
    const hh = s.level >= POLICY_MIN_LEVEL ? s.policy.happyHour : "off";
    if (hh === "early") {
      const w = strategy.happyHour.early;
      for (const g of guests)
        if (g.arriveMinute >= w.end && rng.chance(w.arrivalShift)) {
          // They come early for the deal and stay on (leave time unchanged).
          g.arriveMinute = rng.int(w.start, w.end - 1);
        }
    } else if (hh === "late") {
      const w = strategy.happyHour.late;
      for (const g of guests)
        if (g.leaveMinute >= w.start - 60 && g.leaveMinute < w.end)
          g.leaveMinute = Math.min(
            night.minutes,
            g.leaveMinute + w.stayExtension,
          );
    }
  }
  guests
    .sort((a, b) => a.arriveMinute - b.arriveMinute)
    .forEach((g, i) => (g.id = i));

  const inspectionMinute = rng.chance(r06_inspectionChance(s))
    ? rng.int(0, night.minutes - 1)
    : null;
  return {
    ...s,
    seed: rng.seed,
    phase: "night",
    forcedInspection: false,
    sealedNights: Math.max(0, s.sealedNights - 1),
    nightRevenue: { bar: 0, cover: 0, table: 0 },
    night: {
      minute: 0,
      startCoin: s.coin,
      startReputation: s.reputation,
      guests,
      djMultiplier: night.noDjDanceFactor,
      inspectionMinute: sealed ? null : inspectionMinute,
      doorForced: false,
      doorClosedByCeo: false,
      happyHour: false,
      doorClosedLogged: false,
      crowdChecked: false,
      shutDown: false,
      sealed,
      underageAdmitted: 0,
      rejectedUnderage: 0,
      fights: 0,
      outOfStockHits: 0,
      slowServiceHits: 0,
      djMatch: null,
      violationsTonight: 0,
      finesTonight: 0,
      outOfStockLogged: [],
      energy: strategy.energy.start,
      energySum: 0,
      peakEnergy: 0,
      thinningLogged: false,
      tactics: {},
      tablesBooked: sealed ? 0 : tablesFor(s),
      vipBooked: sealed ? 0 : vipFor(s),
      rounds: 0,
      rejectedDress: 0,
      guestListIn: 0,
      commission: 0,
      bottles: 0,
    },
    log: sealed ? [...s.log, { day: s.day, kind: "venueSealed" }] : s.log,
  };
}

export const nightOver = (s: GameState) =>
  !s.night || s.night.minute >= night.minutes;

/** One in-game minute. Renderer calls this N times per second depending on speed. */
export function tickNight(s: GameState): GameState {
  if (s.phase !== "night" || !s.night || nightOver(s)) return s;
  const rng = createRng(s.seed);
  const n = { ...s.night, guests: s.night.guests.map((g) => ({ ...g })) };
  const m = n.minute;
  const log: GameEvent[] = [];
  let st: GameState = s;
  const ev = (e: GameEvent) => log.push(e);
  const at = { day: s.day, minute: m };

  // Arrivals → queue.
  for (const g of n.guests)
    if (g.state === "pending" && g.arriveMinute <= m) g.state = "queue";

  // Door (R8 ID check, R10 capacity, cover charge).
  const { capacity } = levelData(s.level);
  let inside = n.guests.filter(isInside).length;
  let admittedNow = 0;
  for (const g of n.guests) {
    if (g.state !== "queue" || admittedNow >= night.doorRatePerMinute) continue;
    if (n.doorClosedByCeo) break;
    if (inside >= capacity && !n.doorForced) {
      if (!n.doorClosedLogged) ev({ ...at, kind: "doorClosed" });
      n.doorClosedLogged = true;
      break;
    }
    admittedNow++;
    if (r08_rejectAtDoor(st, g.underage)) {
      g.state = "left";
      n.rejectedUnderage++;
      continue;
    }
    // Dress code: some are turned away (no rng draw when there is no dress code).
    const dressOut = dressReject(st, g);
    if (dressOut > 0 && rng.chance(dressOut)) {
      g.state = "left";
      n.rejectedDress++;
      continue;
    }
    if (g.underage) n.underageAdmitted++;
    const pay = Math.min(coverFor(st, g), g.budget);
    g.budget -= pay;
    // The promoter is paid for every guest-list guest who gets in.
    const fee = g.guestList ? commissionOf(st, g.guestList) : 0;
    if (g.guestList) {
      n.guestListIn++;
      n.commission += fee;
    }
    st = {
      ...st,
      coin: st.coin + pay - fee,
      nightRevenue: { ...st.nightRevenue, cover: st.nightRevenue.cover + pay },
    };
    g.state = "idle";
    g.admitted = true;
    inside++;
  }

  // R7: over 150 inside without a crowd permit → may be shut down (rolled once).
  if (!n.crowdChecked && inside > legal.crowdPermitThreshold) {
    n.crowdChecked = true;
    if (!permitActive(st, "crowd") && rng.chance(legal.crowdShutdownChance)) {
      n.shutDown = true;
      n.minute = night.minutes;
      for (const g of n.guests) if (g.state !== "left") g.state = "left";
      ev({ ...at, kind: "crowdShutdown" });
      return { ...st, seed: rng.seed, night: n, log: [...s.log, ...log] };
    }
  }

  // DJ set start (R4).
  const dj = st.bookedTalent[0];
  if (dj && m === night.djSetStartMinute) {
    const crowdGenre =
      dominantGenre(n.guests.filter(isInside)) ??
      dominantGenre(n.guests) ??
      st.clubGenre;
    n.djMultiplier = r04_djMultiplier(djs[dj].genre, crowdGenre);
    n.djMatch = djs[dj].genre === crowdGenre;
    ev({
      ...at,
      kind: "djStarted",
      dj,
      crowdGenre,
      match: djs[dj].genre === crowdGenre,
    });
  }

  // Reserved tables arrive and pay their minimum spend (bottle service).
  const seated = n.tablesBooked + n.vipBooked;
  if (m === strategy.relations.tablesArriveMinute && seated > 0) {
    const revenue =
      n.tablesBooked * tableSpend(st) + n.vipBooked * vipSpend(st);
    st = {
      ...st,
      coin: st.coin + revenue,
      nightRevenue: {
        ...st.nightRevenue,
        table: st.nightRevenue.table + revenue,
      },
    };
    ev({ ...at, kind: "tablesSeated", tables: seated, revenue });
  }

  // Crowd energy follows how full the room looks and how many are dancing (plus any crowd move in play).
  const insideNow = n.guests.filter(isInside);
  const dancing = insideNow.filter((g) => g.state === "dance").length;
  const femaleInside = insideNow.length
    ? insideNow.filter((g) => g.female).length / insideNow.length
    : 0;
  n.energy +=
    (energyTarget(st, n, insideNow.length, dancing) - n.energy) *
    strategy.energy.follow;
  n.energySum += n.energy;
  n.peakEnergy = Math.max(n.peakEnergy, n.energy);
  const E = strategy.energy;
  if (
    st.level >= POLICY_MIN_LEVEL &&
    !n.thinningLogged &&
    m > night.djSetStartMinute &&
    insideNow.length >= 10 &&
    n.energy < E.leaveBelowEnergy
  ) {
    n.thinningLogged = true;
    ev({ ...at, kind: "crowdThinning", energy: Math.round(n.energy) });
  }
  const coverage = relationsCoverage(st, insideNow.length);
  // The vibe only matters once there is a floor to fill (Level 3+); the booth and shop just sell drinks.
  const vibe = st.level >= POLICY_MIN_LEVEL;
  const perMinute =
    (vibe
      ? ((n.energy - 50) / 50) * E.satisfactionPerMinute +
        st.upgrades.lighting * strategy.upgrades.lighting.satisfactionPerTier
      : 0) +
    coverage * strategy.relations.satisfactionPerMinute +
    (active(n, "mcHype")
      ? strategy.tactics.mcHype.satisfactionPerMinute * n.tactics.mcHype!.power
      : 0);
  const danceBoost = vibe ? danceMultiplier(n.energy) : 1;
  const barBoost =
    (vibe ? barMultiplier(n.energy) : 1) *
    (1 + strategy.relations.upsell * coverage);
  const rounds = roundChance(st, femaleInside);

  // Guests inside.
  const menu = ids(drinks).filter((d) => drinks[d].minLevel <= st.level);
  // Bar throughput: the owner serves alone at first; each bartender adds a serving slot.
  let barSlots = night.drinksServedPerMinute * (1 + st.staff.bartender);
  for (const g of n.guests) {
    if (!isInside(g)) continue;
    if (m >= g.leaveMinute) {
      // Encore: in a buzzing room some stay for one more round of songs.
      const enc = strategy.encore;
      if (
        vibe &&
        !g.encore &&
        n.energy >= enc.energy &&
        m + enc.minutes < night.minutes &&
        rng.chance(enc.chance)
      ) {
        g.encore = true;
        g.leaveMinute = m + enc.minutes;
      } else {
        g.state = "left";
        continue;
      }
    }
    g.drunk = Math.max(0, g.drunk - night.drunkDecayPerMinute);
    // A flat, unhappy room empties early.
    if (
      vibe &&
      n.energy < E.leaveBelowEnergy &&
      g.satisfaction < E.leaveBelowSatisfaction &&
      rng.chance(E.leaveChancePerMinute)
    ) {
      g.state = "left";
      inside--;
      continue;
    }
    g.satisfaction +=
      perMinute +
      (g.female ? 0 : st.staff.host * strategy.hosts.maleSatisfactionPerMinute);

    if (rng.chance(r09_fightChance(st, g.drunk, inside))) {
      g.state = "left";
      inside--;
      n.fights++;
      st = {
        ...st,
        safety: clamp(st.safety - night.fightSafetyPenalty),
        reputation: clamp(st.reputation - night.fightRepPenalty),
      };
      ev({ ...at, kind: "fight", guest: g.id });
      continue;
    }

    const inStock = menu.filter((d) => st.stock[d] > 0);
    const drink = rng.pick(g.disappointed && inStock.length ? inStock : menu);
    const price =
      n.happyHour || happyHourAt(st, m)
        ? Math.max(1, Math.round(st.prices[drink] * night.happyHourPriceFactor))
        : st.prices[drink];
    // Pricier than default → fewer orders; drunk guests slow down.
    const barChance =
      barBoost *
      night.barChancePerMinute *
      Math.min(1.5, defaultPrice(drink, st.level) / price) *
      Math.max(0.2, 1 - g.drunk / night.drunkSlowdown);
    const r = rng.next();
    if (r < barChance && g.budget >= price && barSlots <= 0) {
      g.state = "bar";
      g.satisfaction -= night.slowServicePenalty;
      n.slowServiceHits++;
    } else if (r < barChance && g.budget >= price) {
      barSlots--;
      const res = r02_serveDrink(st, drink, price);
      g.state = "bar";
      if (res.outOfStock) {
        g.disappointed = true;
        n.outOfStockHits++;
        if (!n.outOfStockLogged.includes(drink)) {
          n.outOfStockLogged = [...n.outOfStockLogged, drink];
          ev({ ...at, kind: "outOfStock", drink });
        }
      } else {
        st = res.state;
        g.budget -= price;
        g.drunk += drinks[drink].alcohol;
        g.satisfaction += night.drinkSatisfaction;
        // Buying a round: a man gets one for a woman in the crowd or a host.
        if (
          !g.female &&
          g.budget >= price &&
          barSlots > 0 &&
          rng.chance(rounds)
        ) {
          const again = r02_serveDrink(st, drink, price);
          if (!again.outOfStock) {
            barSlots--;
            st = again.state;
            g.budget -= price;
            g.satisfaction += strategy.rounds.satisfaction;
            n.rounds++;
          }
        }
      }
      g.satisfaction += res.satisfactionDelta;
    } else if (r < barChance + night.danceChancePerMinute * danceBoost) {
      g.state = "dance";
      g.satisfaction +=
        night.danceSatisfactionPerMinute *
        n.djMultiplier *
        (1 +
          st.upgrades.sound * strategy.upgrades.sound.danceSatisfactionPerTier);
    } else {
      g.state = "idle";
      g.satisfaction += night.idleSatisfactionPerMinute;
    }
    g.satisfaction = clamp(g.satisfaction);
  }

  // Inspection (R6, R8, R16).
  if (m === n.inspectionMinute) {
    const res = inspect(st, n.underageAdmitted);
    if (!res.passed) {
      n.violationsTonight++;
      n.finesTonight += res.fine;
      st = {
        ...st,
        violations: st.violations + 1,
        coin: st.coin - res.fine,
        sealedNights: st.sealedNights + res.sealNights,
      };
    }
    ev({
      ...at,
      kind: "inspection",
      passed: res.passed,
      missing: res.missing,
      underage: res.underage,
      fine: res.fine,
    });
  }

  n.minute = m + 1;
  if (n.minute >= night.minutes)
    for (const g of n.guests) if (g.state !== "left") g.state = "left";
  return { ...st, seed: rng.seed, night: n, log: [...st.log, ...log] };
}

/** Night → Report (04:00). Tax (R15), R7 penalty, reputation (R11), then R13/R14. */
export function endNight(s: GameState): GameState {
  if (s.phase !== "night" || !s.night || !nightOver(s)) return s;
  const n = s.night;
  const taxed = r15_entertainmentTax(s);
  const { tax } = taxed;
  let st = taxed.state;

  const { bar, cover, table } = st.nightRevenue;
  if (n.shutDown) {
    st = {
      ...st,
      coin:
        st.coin -
        Math.round((bar + cover + table) * legal.shutdownRevenuePenalty),
      reputation: clamp(st.reputation - legal.shutdownRepPenalty),
    };
  }

  const admitted = n.guests.filter((g) => g.admitted);
  const avgSatisfaction = admitted.length
    ? Math.round(
        admitted.reduce((a, g) => a + g.satisfaction, 0) / admitted.length,
      )
    : 0;
  if (admitted.length)
    st = {
      ...st,
      reputation: clamp(st.reputation + r11_reputationDelta(avgSatisfaction)),
    };

  const report: NightReport = {
    day: s.day,
    guests: admitted.length,
    rejectedUnderage: n.rejectedUnderage,
    revenue: st.nightRevenue,
    tax,
    profit: st.coin - n.startCoin,
    fines: n.finesTonight,
    avgSatisfaction,
    repDelta: st.reputation - n.startReputation,
    fights: n.fights,
    outOfStockHits: n.outOfStockHits,
    slowServiceHits: n.slowServiceHits,
    djMatch: n.djMatch,
    violations: n.violationsTonight,
    shutDown: n.shutDown,
    sealed: n.sealed,
    avgEnergy: Math.round(n.energySum / Math.max(1, n.minute)),
    peakEnergy: Math.round(n.peakEnergy),
    rounds: n.rounds,
    tables: n.tablesBooked,
    vipTables: n.vipBooked,
    rejectedDress: n.rejectedDress,
    tacticsUsed: Object.keys(n.tactics) as NightReport["tacticsUsed"],
    guestListIn: n.guestListIn,
    commission: n.commission,
    bottles: n.bottles,
  };
  return checkScenarioEnd(
    r14_checkVictory(
      r13_checkDefeat({ ...st, phase: "report", lastReport: report }),
    ),
  );
}

/** Report → next Day (R12). No-op once the game is over. */
export function nextDay(s: GameState): GameState {
  if (s.phase !== "report" || s.outcome) return s;
  return applyDayEvents(r12_newDay(s));
}

/** Headless full night: Open Club → 04:00 → Night Report. */
export function runNight(s: GameState): GameState {
  let st = startNight(s);
  while (st.phase === "night" && !nightOver(st)) st = tickNight(st);
  return endNight(st);
}

/** Expected share of each genre in tonight's crowd (club genre + segment mix incl. promo boosts). Sums to 1. */
export function genreForecast(s: GameState): Record<string, number> {
  const weights = segmentWeights(s);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = { [s.clubGenre]: night.clubGenreShare };
  for (const id of ids(segments)) {
    const share =
      ((1 - night.clubGenreShare) * weights[id]) /
      total /
      segments[id].genres.length;
    for (const g of segments[id].genres) out[g] = (out[g] ?? 0) + share;
  }
  return out;
}

/** Suggested stock per drink for tonight: expected guests × drinks per guest, spread over the menu. */
export function stockForecast(s: GameState): Partial<Record<DrinkId, number>> {
  const menu = ids(drinks).filter((d) => drinks[d].minLevel <= s.level);
  const perDrink = Math.ceil(
    (expectedGuests(s) * night.forecastDrinksPerGuest) / menu.length,
  );
  return Object.fromEntries(menu.map((d) => [d, perDrink]));
}

/**
 * R5 during the night ("it's quiet, post a promo"): same cost, energy and hype as by day, and the new hype pulls in
 * extra guests spread over the rest of the night. No new arrivals in the last hour before close.
 */
export function nightPromote(s: GameState, channel: ChannelId): ActionResult {
  const r = r05_promote(s, channel);
  if (!r.ok || s.phase !== "night" || !s.night) return r;
  const n = s.night;
  const lastArrival = night.minutes - night.lateArrivalCutoff;
  const share = Math.max(
    0,
    Math.min(1, (lastArrival - n.minute) / lastArrival),
  );
  const gained = r.state.hype - s.hype;
  const extra = Math.round(
    ((levelData(s.level).demand * night.demand.hypeWeight * gained) / 100) *
      busyFactor(s) *
      share,
  );
  if (extra <= 0) return r;
  const rng = createRng(r.state.seed);
  const weights = segmentWeights(r.state);
  const stay = levelData(s.level).stayMinutes;
  const guests = [...n.guests];
  for (let i = 0; i < extra; i++) {
    const g = makeGuest(
      rng,
      r.state,
      weights,
      rng.int(n.minute + 1, Math.max(n.minute + 1, lastArrival)),
      stay,
    );
    guests.push({ ...g, id: guests.length }); // id = index (escortGuest looks guests up by id)
  }
  return {
    ok: true,
    state: { ...r.state, seed: rng.seed, night: { ...n, guests } },
  };
}

/** Peak hours: a DJ is on and the clock is inside the peak window (the venue saves its dancer clips for this). */
export function isPeakTime(s: GameState): boolean {
  const m = s.night?.minute;
  return (
    m !== undefined &&
    s.bookedTalent.length > 0 &&
    m >= night.peakStartMinute &&
    m < night.peakEndMinute
  );
}
