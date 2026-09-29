// Usage: pnpm balance [runs=1000]. Simulates seeded career runs with the bot and reports outcomes.
import { createGameState, economy, type GameState } from "../src";
import { botDay } from "./bot";

const runs = Number(process.argv[2] ?? 1000);
const outcomes: Record<string, number> = {};
const reachDay: Record<number, number[]> = { 2: [], 3: [], 4: [], 5: [] };
const defeats: Record<string, number> = {};
let coinSum = 0;

for (let seed = 1; seed <= runs; seed++) {
  let s: GameState = createGameState(seed, "edm");
  let level = 1;
  while (!s.outcome && s.day <= economy.maxDays) {
    s = botDay(s);
    if (s.level > level) reachDay[(level = s.level)]!.push(s.day);
  }
  outcomes[s.outcome ?? "none"] = (outcomes[s.outcome ?? "none"] ?? 0) + 1;
  if (s.outcome === "defeat") {
    const why =
      s.negativeCashDays >= 3
        ? "bankrupt"
        : s.violations >= 3
          ? "violations"
          : "reputation";
    defeats[why] = (defeats[why] ?? 0) + 1;
  }
  coinSum += s.coin;
}

const pct = (n: number) => `${((n / runs) * 100).toFixed(1)}%`;
const avg = (a: number[]) =>
  a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "—";
console.log(`runs: ${runs}`);
for (const [k, v] of Object.entries(outcomes))
  console.log(`${k.padEnd(9)} ${pct(v)}`);
for (const [k, v] of Object.entries(defeats))
  console.log(`  defeat/${k.padEnd(10)} ${pct(v)}`);
console.log("level  reached  avg day");
for (const lv of [2, 3, 4, 5])
  console.log(
    `${String(lv).padEnd(6)} ${pct(reachDay[lv]!.length).padStart(7)}  ${avg(reachDay[lv]!)}`,
  );
console.log(
  `avg final coin: ${Math.round(coinSum / runs).toLocaleString("en-US")}`,
);
