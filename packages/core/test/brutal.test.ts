/**
 * Hostile tester: a seeded fuzz harness that throws thousands of random (and hostile) actions at the sim and checks
 * the invariants after every step, plus targeted exploit hunts. A failing test here is a bug report: its name says
 * what broke and its message carries the seed and the action trace to reproduce it.
 */
import { describe, expect, it } from "vitest";
import * as C from "../src";
import type { ActionResult, GameState, TokenId } from "../src";

type S = GameState;

// ---------------------------------------------------------------- helpers

const fuzzRng = (seed: number) => C.createRng((seed * 2654435761) >>> 0);
type Fz = ReturnType<typeof fuzzRng>;

const ok = (r: ActionResult): S => {
  if (!r.ok) throw new Error(`action failed: ${r.reason}`);
  return r.state;
};

const HOSTILE_NUMS = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  0,
  -0,
  0.5,
  1,
  2,
  7,
  50,
  333,
  999,
  1e6,
  1e15,
  2 ** 53 + 2,
  1e308,
  -1e308,
];
const BAD_IDS = ["nope", "", "__proto__", "constructor", "toString"];

const TOKENS = C.ids(C.tokens);
const SUPPLIERS = C.ids(C.suppliers);
const DJS = C.ids(C.djs);
const BANDS = C.ids(C.bands);
const CHANNELS = C.ids(C.channels);
const PERMITS = C.ids(C.permits);
const ROLES = C.ids(C.staffRoles);
const PROMOTERS = C.ids(C.promoters);
const UPGRADES = C.ids(C.strategy.upgrades);
const TACTICS = C.ids(C.strategy.tactics);
const SEATS = C.SEAT_TYPES;
const DRESS = C.ids(C.strategy.dressCode);
const HH = ["off", ...C.ids(C.strategy.happyHour)] as const;

const num = (r: Fz) => (r.chance(0.5) ? r.pick(HOSTILE_NUMS) : r.int(-5, 400));

/** Every number anywhere in the value is finite. */
function badNumbers(
  v: unknown,
  path = "s",
  out: string[] = [],
  skip?: Set<string>,
): string[] {
  if (out.length > 5) return out;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(`${path}=${v}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => badNumbers(x, `${path}[${i}]`, out, skip));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v))
      if (!skip?.has(k)) badNumbers(x, `${path}.${k}`, out, skip);
  }
  return out;
}

const SKIP_HEAVY = new Set(["guests", "marketHist", "log"]);

function invariants(s: S, full: boolean): string[] {
  const e: string[] = [];
  e.push(...badNumbers(s, "s", [], full ? undefined : SKIP_HEAVY));
  if (typeof s.coin !== "number" || !Number.isFinite(s.coin))
    e.push(`coin ${s.coin}`);
  for (const k of ["reputation", "hype", "safety"] as const)
    if (!(s[k] >= 0 && s[k] <= 100)) e.push(`${k}=${s[k]}`);
  for (const t of TOKENS)
    if (!Number.isInteger(s.stock[t]) || s.stock[t] < 0)
      e.push(`stock.${t}=${s.stock[t]}`);
  for (const [t, p] of Object.entries(s.prices))
    if (!Number.isInteger(p) || p < 1) e.push(`price.${t}=${p}`);
  for (const r of ROLES)
    if (!Number.isInteger(s.staff[r]) || s.staff[r] < 0)
      e.push(`staff.${r}=${s.staff[r]}`);
  if (s.phase === "day" && C.stockHeld(s) > C.storageOf(s))
    e.push(`storage ${C.stockHeld(s)} > ${C.storageOf(s)}`);
  for (const [id, v] of Object.entries(s.night?.visitors ?? {})) {
    if (!(v.cash >= 0) || !Number.isFinite(v.cash))
      e.push(`visitor ${id} cash=${v.cash}`);
    if (!(v.avatar >= 1 && v.avatar <= 10))
      e.push(`visitor ${id} avatar=${v.avatar}`);
  }
  return e;
}

const json = (s: S) => JSON.stringify(s);
/** JSON with sorted keys: a save that only reorders fields is the same save. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
/** Path and values of the first difference between two JSON values (key order counts, like JSON.stringify). */
function firstDiff(a: unknown, b: unknown, path = "s"): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "";
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${path} keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const d = firstDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}
const roundTrip = (s: S): S =>
  C.migrateState(JSON.parse(JSON.stringify(C.compactForSave(s))) as S);
const withoutLog = (s: S) => canon({ ...s, log: [] });

/** Plays the rest of the current night/report/day forward to the next day's start (bounded: must terminate). */
function finishDay(s: S): S {
  let guard = 0;
  if (s.phase === "day") s = C.startNight(s);
  while (s.phase === "night" && !C.nightOver(s)) {
    s = C.tickNight(s);
    if (++guard > C.night.minutes + 5) throw new Error("night never ends");
  }
  if (s.phase === "night") s = C.endNight(s);
  if (s.phase === "report") s = s.outcome ? C.playOn(s) : C.nextDay(s);
  return s;
}

/** Stock value at the venue's spot cost (what level-up must not inflate). */
const stockValue = (s: S) =>
  TOKENS.reduce(
    (a, t) =>
      a +
      (s.stock[t] +
        s.pendingOrders
          .filter((o) => o.drink === t)
          .reduce((x, o) => x + o.qty, 0)) *
        C.spotUnitCost(s, t),
    0,
  );

// ---------------------------------------------------------------- the action menu

interface Act {
  name: string;
  args: unknown[];
  run: (s: S) => S | ActionResult;
}

const COIN_UP_OK = new Set([
  "tickNight",
  "advance",
  "crowdMove",
  "visitorJoin",
  "visitorBuy",
  "runNight",
]);

function genAction(r: Fz, s: S, hostileIds: boolean): Act {
  const id = <T extends string>(xs: readonly T[]): T =>
    (hostileIds && r.chance(0.15) ? r.pick(BAD_IDS) : r.pick(xs)) as T;
  const visitorIds = Object.keys(s.night?.visitors ?? {});
  const vid = () =>
    visitorIds.length && r.chance(0.8)
      ? r.pick(visitorIds)
      : r.pick(["a", "b", "me", ...(hostileIds ? BAD_IDS : [])]);
  const choices: (() => Act)[] = [
    () => {
      const a = [id(TOKENS), num(r), id(SUPPLIERS)] as const;
      return {
        name: "orderStock",
        args: [...a],
        run: (x) => C.r01_orderStock(x, a[0], a[1], a[2]),
      };
    },
    () => {
      const a = [id(TOKENS), num(r)] as const;
      return {
        name: "setPrice",
        args: [...a],
        run: (x) => C.setPrice(x, a[0], a[1]),
      };
    },
    () => {
      const d = id(DJS);
      return { name: "bookDj", args: [d], run: (x) => C.r03_bookDj(x, d) };
    },
    () => {
      const b = id(BANDS);
      return { name: "bookBand", args: [b], run: (x) => C.bookBand(x, b) };
    },
    () => {
      const c = id(CHANNELS);
      return { name: "promote", args: [c], run: (x) => C.r05_promote(x, c) };
    },
    () => {
      const c = id(CHANNELS);
      return {
        name: "nightPromote",
        args: [c],
        run: (x) => C.nightPromote(x, c),
      };
    },
    () => ({
      name: "controversialPromo",
      args: [],
      run: (x) => C.r17_controversialPromo(x),
    }),
    () => {
      const p = id(PERMITS);
      return {
        name: "applyPermit",
        args: [p],
        run: (x) => C.applyPermit(x, p),
      };
    },
    () => {
      const p = id(ROLES);
      return { name: "hireStaff", args: [p], run: (x) => C.hireStaff(x, p) };
    },
    () => {
      const p = id(ROLES);
      return { name: "fireStaff", args: [p], run: (x) => C.fireStaff(x, p) };
    },
    () => ({
      name: "forceDoorOpen",
      args: [],
      run: (x) => C.r10_forceDoorOpen(x),
    }),
    () => {
      const c = r.pick(["happyHour", "closeDoor"] as const);
      return { name: "ceoCall", args: [c], run: (x) => C.ceoCall(x, c) };
    },
    () => {
      const g = r.chance(0.5)
        ? r.int(-2, (s.night?.guests.length ?? 3) + 2)
        : num(r);
      return {
        name: "escortGuest",
        args: [g],
        run: (x) => C.escortGuest(x, g),
      };
    },
    () => {
      const patch: Record<string, unknown> = {};
      if (r.chance(0.5)) patch.ladiesNight = r.chance(0.5);
      if (r.chance(0.5))
        patch.dressCode = hostileIds ? id(DRESS) : r.pick(DRESS);
      if (r.chance(0.5)) patch.cover = r.chance(0.3) ? null : num(r);
      if (r.chance(0.5))
        patch.happyHour = hostileIds && r.chance(0.15) ? "nope" : r.pick(HH);
      return {
        name: "setPolicy",
        args: [patch],
        run: (x) => C.setPolicy(x, patch as Partial<C.HousePolicy>),
      };
    },
    () => {
      const p = id(PROMOTERS);
      return {
        name: "bookPromoter",
        args: [p],
        run: (x) => C.bookPromoter(x, p),
      };
    },
    () => {
      const u = id(UPGRADES);
      return { name: "buyUpgrade", args: [u], run: (x) => C.buyUpgrade(x, u) };
    },
    () => {
      const on = r.chance(0.5);
      return {
        name: "setAutoRefill",
        args: [on],
        run: (x) => C.setAutoRefill(x, on),
      };
    },
    () => {
      const t = id(SEATS);
      const p = r.chance(0.2) ? null : num(r);
      return {
        name: "setMinSpend",
        args: [t, p],
        run: (x) => C.setMinSpend(x, t, p),
      };
    },
    () => {
      const t = id(TACTICS);
      return { name: "crowdMove", args: [t], run: (x) => C.crowdMove(x, t) };
    },
    () => ({
      name: "upgradeLevel",
      args: [],
      run: (x) => C.r18_upgradeLevel(x),
    }),
    () => {
      const a = [
        vid(),
        "Guest" + r.int(0, 9),
        r.chance(0.6) ? r.int(1000, 200_000) : num(r),
        r.chance(0.7) ? r.int(1, 10) : num(r),
      ] as const;
      return {
        name: "visitorJoin",
        args: [...a],
        run: (x) => C.visitorJoin(x, a[0], a[1], a[2], a[3]),
      };
    },
    () => {
      const a = [
        vid(),
        id(TOKENS),
        r.chance(0.6) ? r.int(1, 5) : num(r),
      ] as const;
      return {
        name: "visitorBuy",
        args: [...a],
        run: (x) => C.visitorBuy(x, a[0], a[1], a[2]),
      };
    },
    () => {
      const v = vid();
      return {
        name: "visitorLeave",
        args: [v],
        run: (x) => C.visitorLeave(x, v),
      };
    },
    () => {
      const q: Record<string, number> = {};
      for (const t of ["TSLA", "NVDA", "SPY", "AAPL", "SPCX"])
        if (r.chance(0.5)) q[t] = r.chance(0.3) ? num(r) : 50 + r.int(0, 400);
      return { name: "setQuotes", args: [q], run: (x) => C.setQuotes(x, q) };
    },
    () => ({ name: "startNight", args: [], run: (x) => C.startNight(x) }),
    () => {
      const k = r.int(1, 40);
      return {
        name: "tickNight",
        args: [k],
        run: (x) => {
          for (let i = 0; i < k; i++) x = C.tickNight(x);
          return x;
        },
      };
    },
    () => ({ name: "endNight", args: [], run: (x) => C.endNight(x) }),
    () => ({ name: "nextDay", args: [], run: (x) => C.nextDay(x) }),
    () => ({ name: "playOn", args: [], run: (x) => C.playOn(x) }),
  ];
  // Keep the run moving: often just advance the clock.
  if (r.chance(0.3))
    return {
      name: "advance",
      args: [],
      run: (x) => {
        if (x.phase === "day") return C.startNight(x);
        if (x.phase === "night") {
          for (let i = 0; i < 60 && !C.nightOver(x); i++) x = C.tickNight(x);
          return C.nightOver(x) ? C.endNight(x) : x;
        }
        return x.outcome ? C.playOn(x) : C.nextDay(x);
      },
    };
  return r.pick(choices)();
}

// ---------------------------------------------------------------- the fuzz run

interface Finding {
  key: string;
  msg: string;
}

function startState(seed: number): S {
  const r = fuzzRng(seed ^ 0xbeef);
  const pick = r.int(0, 9);
  if (pick === 0) return C.createBasement(seed);
  if (pick === 1) return C.createEvent(r.pick(C.scenarios.events), seed);
  const level = r.int(1, 5) as C.Level;
  let s = C.createGameState(seed, "edm", {
    level,
    difficulty: r.pick(["easy", "normal", "hard"] as const),
  });
  // Some runs get a fat purse so level-ups, upgrades and big orders are reachable.
  if (r.chance(0.5))
    s = { ...s, coin: s.coin * r.int(5, 400), reputation: r.int(20, 95) };
  return s;
}

function fuzzRun(
  seed: number,
  steps: number,
  hostileIds: boolean,
  findings: Map<string, Finding>,
): { final: S; trace: string } {
  const r = fuzzRng(seed);
  let s = startState(seed);
  const trace: string[] = [];
  let prevInv = new Set<string>();
  const note = (key: string, msg: string) => {
    if (!findings.has(key))
      findings.set(key, {
        key,
        msg: `${msg}\n  seed=${seed} hostile=${hostileIds} trace(last 8): ${trace.slice(-8).join(" | ")}`,
      });
  };
  for (let i = 0; i < steps; i++) {
    const act = genAction(r, s, hostileIds);
    trace.push(
      `${act.name}(${act.args.map((a) => JSON.stringify(a) ?? String(a)).join(",")})`,
    );
    const before = s;
    let out: S | ActionResult;
    try {
      out = act.run(s);
    } catch (err) {
      note(`throw:${act.name}`, `${act.name} threw: ${(err as Error).message}`);
      continue;
    }
    const res: S = "ok" in out ? (out.ok ? out.state : before) : (out as S);

    // ---- invariants after every step
    // Only violations this step introduced (a broken value carried forward is reported once, at its source).
    const full =
      act.name === "advance" || act.name === "endNight" || i % 25 === 0;
    const now = new Set(
      invariants(res, full).map((v) => v.replace(/[=>].*/, "")),
    );
    for (const v of now)
      if (!prevInv.has(v)) {
        const what = v.replace(
          /\.(a|b|me|v\d|nope|constructor|toString|__proto__)\b/g,
          ".<id>",
        );
        note(
          `inv:${what}`,
          `${act.name} introduced: ${invariants(res, full).find((x) => x.startsWith(v))}`,
        );
      }
    prevInv = now;

    // ---- outcome monotonic: defeat is final; a result only changes by endNight or playOn
    if (before.outcome === "defeat" && res.outcome !== "defeat")
      note(`outcome:defeat-undone:${act.name}`, `defeat undone by ${act.name}`);
    if (
      before.outcome !== res.outcome &&
      !["endNight", "advance", "playOn", "tickNight"].includes(act.name)
    )
      note(
        `outcome:changed:${act.name}`,
        `${act.name} changed outcome ${before.outcome}→${res.outcome}`,
      );

    // ---- no Coin from thin air outside the night's sales
    if (res.coin > before.coin && !COIN_UP_OK.has(act.name))
      note(
        `coinup:${act.name}`,
        `${act.name} raised coin ${before.coin}→${res.coin}`,
      );

    // ---- once the game is over, the club's books are closed
    if (
      before.outcome &&
      act.name !== "playOn" &&
      json(res) !== json(before) &&
      res.outcome === before.outcome
    )
      if (
        res.coin !== before.coin ||
        JSON.stringify(res.stock) !== JSON.stringify(before.stock)
      )
        note(
          `afterOver:${act.name}`,
          `${act.name} moved coin/stock after outcome=${before.outcome}`,
        );

    // ---- visitor money conservation
    if (act.name === "visitorBuy" && "ok" in out && out.ok) {
      const [vId, t, qty] = act.args as [string, TokenId, number];
      const v0 = before.night!.visitors![vId]!;
      const v1 = res.night!.visitors![vId]!;
      const paid = v0.cash - v1.cash;
      const fee =
        (res.nightRevenue.platformFee ?? 0) -
        (before.nightRevenue.platformFee ?? 0);
      if (!(paid > 0) || paid > v0.cash)
        note("visitor:paid", `visitor paid ${paid} with cash ${v0.cash}`);
      if (res.coin - before.coin !== paid - fee)
        note(
          "visitor:conservation",
          `club got ${res.coin - before.coin}, visitor paid ${paid}, fee ${fee}`,
        );
      if (before.stock[t] - res.stock[t] !== qty)
        note(
          "visitor:stock",
          `stock moved ${before.stock[t] - res.stock[t]} for qty ${qty}`,
        );
      if (before.phase !== "night" || C.nightOver(before))
        note(
          "visitor:afterHours",
          `visitorBuy succeeded in phase=${before.phase} minute=${before.night?.minute}`,
        );
      if (before.night?.sealed)
        note("visitor:sealed", `visitorBuy succeeded in a sealed venue`);
    }
    if (act.name === "visitorJoin" && "ok" in out && out.ok) {
      if (C.nightOver(before))
        note(
          "visitor:joinAfterHours",
          `visitorJoin succeeded at minute ${before.night?.minute} (night over)`,
        );
      if (before.night?.sealed)
        note("visitor:joinSealed", `visitorJoin succeeded in a sealed venue`);
    }

    // ---- phase locks
    if ("ok" in out && out.ok) {
      if (
        [
          "hireStaff",
          "fireStaff",
          "buyUpgrade",
          "controversialPromo",
          "upgradeLevel",
          "setPolicy",
          "setMinSpend",
          "bookBand",
          "bookPromoter",
        ].includes(act.name) &&
        before.phase !== "day"
      )
        note(
          `phase:${act.name}`,
          `${act.name} allowed in phase ${before.phase}`,
        );
      if (
        act.name === "bookDj" &&
        (before.phase === "report" ||
          (before.night && before.night.minute >= C.night.djSetStartMinute))
      )
        note(
          "phase:bookDj",
          `DJ booked at phase ${before.phase} minute ${before.night?.minute}`,
        );
      if (
        act.name === "forceDoorOpen" &&
        (before.phase !== "night" || C.nightOver(before))
      )
        note(
          "phase:forceDoorOpen",
          `door forced (violation +1) in phase ${before.phase} minute ${before.night?.minute}`,
        );
    }

    // ---- level-up never creates value
    if (act.name === "upgradeLevel" && "ok" in out && out.ok) {
      const v0 = stockValue(before);
      const v1 = stockValue(res);
      if (v1 > v0 + 1e-6) note("levelup:value", `stock value ${v0} → ${v1}`);
      if (C.stockHeld(res) > C.storageOf(res))
        note(
          "levelup:storage",
          `after level-up stock ${C.stockHeld(res)} > storage ${C.storageOf(res)} (L${before.level}→L${res.level})`,
        );
    }

    // ---- save → load round trip
    if (i % 37 === 0) {
      try {
        const loaded = roundTrip(res);
        if (canon(loaded) !== canon(C.compactForSave(res)))
          note(
            "save:roundtrip",
            `save→load changed: ${firstDiff(JSON.parse(canon(C.compactForSave(res))), JSON.parse(canon(loaded)))}`,
          );
        else if (i % 111 === 0) {
          const a = finishDay(C.compactForSave(res));
          const b = finishDay(loaded);
          if (withoutLog(a) !== withoutLog(b))
            note(
              "save:continue",
              `a loaded save plays differently: ${firstDiff(JSON.parse(withoutLog(a)), JSON.parse(withoutLog(b)))}; loaded prices ${JSON.stringify(loaded.prices)}`,
            );
        }
      } catch (err) {
        note(
          "save:throw",
          `save/load or finishing the day threw: ${(err as Error).message}`,
        );
      }
    }
    s = res;
  }
  return { final: s, trace: trace.join("\n") };
}

const report = (f: Map<string, Finding>) =>
  [...f.values()].map((x) => `[${x.key}] ${x.msg}`).join("\n\n");

// ---------------------------------------------------------------- tests

describe("brutal fuzz: valid ids, hostile numbers, every action in every phase", () => {
  const SEEDS = 120;
  const STEPS = 350;
  const findings = new Map<string, Finding>();
  const finals: S[] = [];
  for (let seed = 1; seed <= SEEDS; seed++)
    finals.push(fuzzRun(seed, STEPS, false, findings).final);

  const pick = (prefix: string) =>
    new Map([...findings].filter(([k]) => k.startsWith(prefix)));

  it("no action ever throws (valid ids)", () => {
    expect(report(pick("throw:"))).toBe("");
  });
  it("state invariants hold after every step (finite, stock ints ≥ 0, 0–100 stats, storage)", () => {
    expect(report(pick("inv:"))).toBe("");
  });
  it("outcome is monotonic: defeat final, results only change at night end / playOn", () => {
    expect(report(pick("outcome:"))).toBe("");
  });
  it("no Coin appears from day-time actions", () => {
    expect(report(pick("coinup:"))).toBe("");
  });
  it("visitorBuy conserves money and only works while the club is open", () => {
    expect(report(pick("visitor:"))).toBe("");
  });
  it("phase locks hold (hire/fire/upgrade/stunt by day, DJ before minute 60)", () => {
    expect(report(pick("phase:"))).toBe("");
  });
  it("level-up rescale never creates value nor overfills the stock room", () => {
    expect(report(pick("levelup:"))).toBe("");
  });
  it("save → load round trip is exact and plays on identically", () => {
    expect(report(pick("save:"))).toBe("");
  });
  it("nothing moves the books after the game is over", () => {
    expect(report(pick("afterOver:"))).toBe("");
  });
  it("same seed + same actions → identical state (determinism)", () => {
    const again = new Map<string, Finding>();
    for (let seed = 1; seed <= SEEDS; seed += 7) {
      const a = fuzzRun(seed, STEPS, false, again);
      expect(json(a.final), `seed ${seed}`).toBe(json(finals[seed - 1]!));
    }
  });
});

describe("brutal fuzz: hostile ids (unknown / prototype keys)", () => {
  const findings = new Map<string, Finding>();
  for (let seed = 1001; seed <= 1060; seed++)
    fuzzRun(seed, 250, true, findings);
  it("no action throws on an unknown id", () => {
    const f = new Map([...findings].filter(([k]) => k.startsWith("throw:")));
    expect([...f.keys()].sort()).toEqual([]);
  });
  it("an unknown id never puts NaN / garbage into the state", () => {
    const f = new Map([...findings].filter(([k]) => k.startsWith("inv:")));
    expect(report(f)).toBe("");
  });
});

// ---------------------------------------------------------------- targeted exploit / bug hunts

const tokenOnMenu = (s: S) =>
  TOKENS.find((t) => C.tokens[t].minLevel <= s.level && s.stock[t] > 0)!;

function openEvent(seed = 3): S {
  return C.createEvent(C.scenarios.events[1]!, seed);
}

describe("visitor path (multiplayer guests)", () => {
  it("visitorBuy is refused once the night is over (04:00) and after the report", () => {
    let s = ok(C.visitorJoin(openEvent(), "v1", "Ana", 1e6));
    while (!C.nightOver(s)) s = C.tickNight(s);
    const t = tokenOnMenu(s);
    expect(C.visitorBuy(s, "v1", t, 1).ok, "at minute 360").toBe(false);
    const rep = C.endNight(s);
    expect(rep.phase).toBe("report");
    const after = C.visitorBuy(rep, "v1", t, 1);
    // Bought after the report was written: untaxed, missing from lastReport.
    expect(after.ok, "in the report phase").toBe(false);
  });

  it("revenue from a visitor sale after the report escapes the entertainment tax", () => {
    let s = ok(C.visitorJoin(openEvent(), "v1", "Ana", 1e7));
    while (!C.nightOver(s)) s = C.tickNight(s);
    s = C.endNight({ ...s, stock: { ...s.stock, tsla: 50 } });
    expect(s.phase).toBe("report");
    const taxRate = C.levelData(s.level).entertainmentTaxRate; // L4: 30%
    const r = C.visitorBuy(s, "v1", "tsla", 5);
    const gained = r.ok ? r.state.coin - s.coin : 0;
    // Any sale the club books should be taxed like the rest of the night: at most (1 - rate) of it stays.
    expect(gained).toBeLessThanOrEqual(
      Math.round(C.marketPrice(s, "tsla") * 5 * (1 - taxRate)),
    );
    expect(r.ok ? r.state.lastReport!.revenue.bar : 0).toBe(
      s.lastReport!.revenue.bar,
    );
  });

  it("visitorJoin is refused after closing time (no cover for a closed club)", () => {
    let s = openEvent();
    while (!C.nightOver(s)) s = C.tickNight(s);
    expect(C.visitorJoin(s, "late", "Late", 1e6).ok).toBe(false);
  });

  it("a sealed venue (R16) sells nothing, not even to visitors", () => {
    const base = { ...openEvent(), phase: "day" as const, night: null };
    const sealed = C.startNight({
      ...base,
      sealedNights: 1,
      stock: { ...base.stock, tsla: 50 },
    });
    expect(sealed.night!.sealed).toBe(true);
    const j = C.visitorJoin(sealed, "v1", "Ana", 1e6);
    const bought = j.ok ? C.visitorBuy(j.state, "v1", "tsla", 1).ok : false;
    expect({ join: j.ok, buy: bought }).toEqual({ join: false, buy: false });
  });

  it("can't buy with insufficient cash, NaN/fractional/negative qty, or more than stock", () => {
    let s = ok(C.visitorJoin(openEvent(), "v1", "Ana", 1000));
    const t = tokenOnMenu(s);
    for (const q of [0, -1, 0.5, NaN, Infinity, 1e9, s.stock[t] + 1])
      expect(C.visitorBuy(s, "v1", t, q).ok, `qty ${q}`).toBe(false);
    s = ok(C.visitorJoin(s, "poor", "Poor", C.coverPrice(s)));
    expect(C.visitorBuy(s, "poor", t, 1).ok).toBe(false);
  });

  it("a visitor id that is an Object.prototype key (toString) fails cleanly: no throw, no stock or Coin moved", () => {
    let s = ok(C.visitorJoin(openEvent(), "v1", "Ana", 1e6)); // visitors map now exists
    const t = tokenOnMenu(s);
    const coin0 = s.coin;
    const r = C.visitorBuy(s, "toString", t, 3);
    if (r.ok) s = r.state;
    expect({ ok: r.ok, coinDelta: s.coin - coin0 }).toEqual({
      ok: false,
      coinDelta: 0,
    });
  });

  it("visitorJoin with a NaN avatar keeps the state finite", () => {
    const s = ok(C.visitorJoin(openEvent(), "v1", "Ana", 1e6, NaN));
    expect(badNumbers(s.night!.visitors)).toEqual([]);
  });

  it("visitor money is conserved over a whole night of random buys", () => {
    let s = openEvent(9);
    const r = fuzzRng(77);
    const start = 50_000;
    for (const v of ["a", "b", "c"]) s = ok(C.visitorJoin(s, v, v, start));
    let sales = 0;
    let fees = 0;
    while (!C.nightOver(s)) {
      for (const v of ["a", "b", "c"]) {
        const t = r.pick(TOKENS);
        const before = s;
        const res = C.visitorBuy(s, v, t, r.int(1, 4));
        if (res.ok) {
          s = res.state;
          sales +=
            before.night!.visitors![v]!.cash - s.night!.visitors![v]!.cash;
          fees +=
            (s.nightRevenue.platformFee ?? 0) -
            (before.nightRevenue.platformFee ?? 0);
        }
      }
      s = C.tickNight(s);
    }
    const cashLeft = ["a", "b", "c"].reduce(
      (a, v) => a + s.night!.visitors![v]!.cash,
      0,
    );
    const cover = C.coverPrice(s) * 3;
    expect(cashLeft + sales + cover).toBe(start * 3);
    for (const v of ["a", "b", "c"]) {
      const x = s.night!.visitors![v]!;
      const held = Object.values(x.holdings).reduce((a, h) => a + h!.cost, 0);
      expect(x.cash + held + C.coverPrice(s)).toBe(start);
    }
    expect(fees).toBeGreaterThanOrEqual(0);
  });
});

describe("CEO career exploits", () => {
  it("R18: moving up a venue never leaves the stock room overfilled (L4 → L5 with storage tiers)", () => {
    let s = C.createGameState(1, "edm", { level: 4 });
    s = { ...s, coin: 1e9, reputation: 90 };
    for (let i = 0; i < 3; i++) s = ok(C.buyUpgrade(s, "storage"));
    // Fill the room.
    s = ok(
      C.r01_orderStock(s, "tsla", C.storageOf(s) - C.stockHeld(s), "corner"),
    );
    const up = ok(C.r18_upgradeLevel(s));
    expect(C.stockHeld(up)).toBeLessThanOrEqual(C.storageOf(up));
  });

  it("R18: level-up rescale never creates value (every level, with pending orders)", () => {
    for (let lv = 1 as C.Level; lv < 5; lv = (lv + 1) as C.Level) {
      let s = C.createGameState(lv, "edm", { level: lv });
      s = { ...s, coin: 1e10, reputation: 99 };
      for (const t of TOKENS.filter((x) => C.tokens[x].minLevel <= lv)) {
        const o = C.r01_orderStock(s, t, 37, "corner");
        if (o.ok) s = o.state;
        if (lv >= 2) {
          const p = C.r01_orderStock(s, t, 13, "import");
          if (p.ok) s = p.state;
        }
      }
      const up = ok(C.r18_upgradeLevel(s));
      expect(stockValue(up)).toBeLessThanOrEqual(stockValue(s));
      // and selling it all at the new list price is never better than at the old one, scaled
      const v = (x: S) =>
        TOKENS.reduce((a, t) => a + x.stock[t] * x.prices[t], 0);
      expect(v(up) / C.priceScale(up.level)).toBeLessThanOrEqual(
        v(s) / C.priceScale(s.level) + TOKENS.length,
      );
    }
  });

  it("a cover above a guest's budget doesn't empty their wallet at the door (guests who can't pay don't get in)", () => {
    let s = C.createGameState(1, "edm", { level: 4 });
    s = { ...s, hype: 50, reputation: 60 };
    s = ok(C.setPolicy(s, { cover: 1e12 }));
    let n = C.startNight(s);
    for (let i = 0; i < 200; i++) n = C.tickNight(n);
    const admitted = n.night!.guests.filter((g) => g.admitted && !g.guestList);
    // visitorJoin refuses a player who can't pay the cover; NPC guests should follow the same rule.
    expect(admitted.length).toBe(0);
  });

  it("wallet-grab cover (1e12) never out-earns the standard door with a stocked bar", () => {
    const night = (cover: number | null, seed: number) => {
      let s = C.createGameState(seed, "edm", { level: 4 });
      s = {
        ...s,
        hype: 50,
        reputation: 60,
        staff: { ...s.staff, security: 5, bartender: 4 },
      };
      s = ok(C.setPolicy(s, { cover }));
      if (cover === null)
        for (const t of TOKENS.filter((x) => C.tokens[x].minLevel <= 4)) {
          const o = C.r01_orderStock(s, t, 300, "corner");
          if (o.ok) s = o.state;
        }
      const start = s;
      const e = C.runNight(s);
      // profit net of the stock actually sold (at what it cost)
      const used = TOKENS.reduce(
        (a, t) =>
          a + (start.stock[t] - e.stock[t]) * C.orderCost(t, 1, "corner", 4),
        0,
      );
      return e.coin - start.coin - used;
    };
    let normal = 0;
    let grab = 0;
    for (let seed = 1; seed <= 8; seed++) {
      normal += night(null, seed);
      grab += night(1e12, seed);
    }
    expect(grab).toBeLessThanOrEqual(normal);
  });

  it("setPolicy rejects an unknown dress code / happy-hour slot (else every night after throws)", () => {
    const s = { ...C.createGameState(1, "edm", { level: 3 }), hype: 40 };
    const bad1 = C.setPolicy(s, { dressCode: "nope" as never });
    const bad2 = C.setPolicy(s, { happyHour: "nope" as never });
    const brick = (r: ActionResult) => {
      if (!r.ok) return "refused";
      try {
        C.runNight(r.state);
        return "plays";
      } catch {
        return "bricked";
      }
    };
    expect([brick(bad1), brick(bad2)]).toEqual(["refused", "refused"]);
  });

  it("setPrice has an upper bound: a huge price never becomes Infinity (level-up) nor null after save/load", () => {
    let s = { ...C.createGameState(1, "edm"), coin: 1e9, reputation: 99 };
    const r = C.setPrice(s, "tsla", 1e308);
    if (!r.ok) return; // bounded: fine
    s = ok(C.r18_upgradeLevel(r.state));
    expect(Number.isFinite(s.prices.tsla)).toBe(true);
    expect(roundTrip(s).prices.tsla).toBe(s.prices.tsla);
  });

  it("aiPrepare (AI CEO) terminates outside the day phase", () => {
    // hireStaff is now day-only; aiPrepare's `while (security < target && coin > 20k) tryAct(hireStaff)` never exits
    // if it is handed a night/report state. Prove the loop condition can't change instead of hanging the runner.
    const s = C.startNight({
      ...C.createGameState(1, "edm", { level: 4 }),
      coin: 1e6,
    });
    const target = Math.ceil(C.levels[4].capacity / 40);
    const wouldSpin =
      s.staff.security < target &&
      s.coin > 20_000 &&
      !C.hireStaff(s, "security").ok;
    expect(wouldSpin, "aiPrepare(nightState) loops forever").toBe(false);
  });

  it("forcing the door after closing / in the report is refused (it costs a violation for nothing)", () => {
    let s = C.startNight(C.createGameState(1, "edm", { level: 4 }));
    while (!C.nightOver(s)) s = C.tickNight(s);
    expect(C.r10_forceDoorOpen(s).ok, "minute 360").toBe(false);
    expect(C.r10_forceDoorOpen(C.endNight(s)).ok, "report").toBe(false);
  });

  it("nothing spends Coin or moves stock after a defeat", () => {
    const s: S = {
      ...C.createGameState(1),
      phase: "report",
      outcome: "defeat",
    };
    const r = C.r01_orderStock(s, "tsla", 5, "corner");
    expect(r.ok).toBe(false);
  });

  it("unknown ids fail cleanly instead of throwing or writing NaN", () => {
    const s = { ...C.createGameState(1, "edm", { level: 5 }), coin: 1e9 };
    const tries: [string, () => ActionResult][] = [
      [
        "orderStock(nope)",
        () => C.r01_orderStock(s, "nope" as TokenId, 1, "corner"),
      ],
      [
        "orderStock(constructor)",
        () => C.r01_orderStock(s, "constructor" as TokenId, 1, "corner"),
      ],
      [
        "orderStock(supplier nope)",
        () => C.r01_orderStock(s, "tsla", 1, "nope" as never),
      ],
      ["bookDj(nope)", () => C.r03_bookDj(s, "nope" as never)],
      ["bookBand(nope)", () => C.bookBand(s, "nope" as never)],
      ["promote(nope)", () => C.r05_promote(s, "nope" as never)],
      ["applyPermit(nope)", () => C.applyPermit(s, "nope" as never)],
      ["hireStaff(nope)", () => C.hireStaff(s, "nope" as never)],
      ["fireStaff(nope)", () => C.fireStaff(s, "nope" as never)],
      ["bookPromoter(nope)", () => C.bookPromoter(s, "nope" as never)],
      ["buyUpgrade(nope)", () => C.buyUpgrade(s, "nope" as never)],
      ["setPrice(nope)", () => C.setPrice(s, "nope" as TokenId, 5)],
    ];
    const bad: string[] = [];
    for (const [name, f] of tries) {
      try {
        const r = f();
        if (r.ok && badNumbers(r.state).length)
          bad.push(`${name}: NaN ${badNumbers(r.state)[0]}`);
        else if (r.ok) bad.push(`${name}: accepted`);
      } catch (e) {
        bad.push(`${name}: threw ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("playOn: only after victory/survived, defeat stays final, a won club never wins again", () => {
    const won: S = {
      ...C.createGameState(1, "edm", { level: 5 }),
      phase: "report",
      outcome: "victory",
      reputation: 100,
    };
    const p = C.playOn(won);
    expect(p.outcome).toBeNull();
    expect(p.freePlay).toBe("victory");
    expect(C.playOn(p)).toBe(p); // nothing to play on from
    let s = p;
    for (let d = 0; d < 5; d++) {
      s = C.runNight({ ...s, reputation: 100 });
      expect(s.outcome === "victory").toBe(false);
      if (s.outcome) break;
      s = C.nextDay(s);
    }
    const lost: S = { ...won, outcome: "defeat" };
    expect(C.playOn(lost)).toBe(lost);
    expect(C.nextDay(lost)).toBe(lost);
    expect(C.startNight({ ...lost, phase: "day" }).phase).toBe("day");
  });

  it("happy hour + price 1 + max minSpend: one night can't print unbounded Coin", () => {
    let s = C.createGameState(4, "edm", { level: 5 });
    s = {
      ...s,
      coin: 1e8,
      hype: 100,
      reputation: 100,
      staff: {
        ...s.staff,
        relations: 200,
        security: 20,
        bartender: 20,
        host: 20,
      },
    };
    s = ok(C.buyUpgrade(s, "vip"));
    for (const t of SEATS) s = ok(C.setMinSpend(s, t, 2 ** 31));
    s = ok(C.setPolicy(s, { happyHour: "early", cover: 0 }));
    const e = C.runNight(s);
    // Bounded by the crowd's wallets + seats × standard spend: far below 1e12.
    expect(e.coin - s.coin).toBeLessThan(1e9);
    expect(Number.isFinite(e.coin)).toBe(true);
  });
});
