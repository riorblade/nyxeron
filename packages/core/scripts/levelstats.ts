// Usage: pnpm tsx packages/core/scripts/levelstats.ts [runs=300]. Per venue level, over bot careers: fights a
// night, tax as a share of revenue, profit a night, and how careers end. For tuning security and tax.
import { createGameState, economy, type GameState } from "../src";
import { botDay } from "./bot";

const runs = Number(process.argv[2] ?? 300);
type Row = {
  nights: number;
  fights: number;
  revenue: number;
  tax: number;
  profit: number;
};
const by: Record<number, Row> = {};
const outcomes: Record<string, number> = {};
for (let seed = 1; seed <= runs; seed++) {
  let s: GameState = createGameState(seed, "edm");
  while (!s.outcome && s.day <= economy.maxDays) {
    s = botDay(s);
    const r = s.lastReport;
    if (!r) continue;
    const level = s.level;
    const row = (by[level] ??= {
      nights: 0,
      fights: 0,
      revenue: 0,
      tax: 0,
      profit: 0,
    });
    row.nights++;
    row.fights += r.fights;
    row.revenue += r.revenue.bar + r.revenue.cover + r.revenue.table;
    row.tax += r.tax;
    row.profit += r.profit;
  }
  const why =
    s.outcome !== "defeat"
      ? (s.outcome ?? "none")
      : s.negativeCashDays >= 3
        ? "defeat/bankrupt"
        : s.violations >= 3
          ? "defeat/violations"
          : "defeat/reputation";
  outcomes[why] = (outcomes[why] ?? 0) + 1;
}
console.log("level nights fights/night tax%rev profit/night");
for (const [lv, r] of Object.entries(by))
  console.log(
    lv.padEnd(5),
    String(r.nights).padStart(6),
    (r.fights / r.nights).toFixed(2).padStart(12),
    ((r.tax / Math.max(1, r.revenue)) * 100).toFixed(0).padStart(7) + "%",
    Math.round(r.profit / r.nights)
      .toLocaleString("en-US")
      .padStart(12),
  );
for (const [k, v] of Object.entries(outcomes))
  console.log(k.padEnd(18), ((v / runs) * 100).toFixed(1) + "%");
