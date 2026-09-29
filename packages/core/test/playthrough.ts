import {
  applyPermit,
  createGameState,
  nextDay,
  r01_orderStock,
  r03_bookDj,
  r05_promote,
  runNight,
  hireStaff,
  type ActionResult,
  type GameState,
  type NightReport,
} from "../src";

const ok = (r: ActionResult): GameState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};

/** Scripted Week 1 at The Basement (Level 4). Shared by the test and ad-hoc balancing runs. */
export function playWeek(seed: number): {
  state: GameState;
  reports: NightReport[];
} {
  const reports: NightReport[] = [];
  let s: GameState = {
    ...createGameState(seed, "edm"),
    level: 4,
    coin: 5_000_000,
    reputation: 60,
  };
  for (const p of ["liquorOnPremise", "crowd"] as const)
    s = ok(applyPermit(s, p));
  for (let i = 0; i < 5; i++) s = ok(hireStaff(s, "security"));
  for (let i = 0; i < 5; i++) s = ok(hireStaff(s, "bartender"));

  for (let day = 1; day <= 7 && !s.outcome; day++) {
    for (const d of [
      "beer",
      "vodka",
      "whisky",
      "cocktail",
      "softDrink",
      "wine",
    ] as const)
      if (s.stock[d] < 150)
        s = ok(r01_orderStock(s, d, 150 - s.stock[d], "corner"));
    if (day % 7 === 0) s = ok(applyPermit(s, "crowd")); // weekly crowd permit renewal
    s = ok(r03_bookDj(s, "rhea"));
    s = ok(r05_promote(s, "tiktok"));
    s = ok(r05_promote(s, "instagram"));
    s = runNight(s);
    reports.push(s.lastReport!);
    s = nextDay(s);
  }
  return { state: s, reports };
}
