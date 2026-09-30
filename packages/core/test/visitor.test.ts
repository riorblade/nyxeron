import { describe, expect, it } from "vitest";
import {
  coverPrice,
  createEvent,
  scenarios,
  marketPrice,
  tickNight,
  visitorBuy,
  visitorJoin,
  visitorPnl,
  visitorValue,
  type ActionResult,
  type GameState,
} from "../src";

const must = (r: ActionResult): GameState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};
const club = () => createEvent(scenarios.events[1]!, 7);

describe("AI-run event", () => {
  it("opens the doors with stock, staff and a DJ ready", () => {
    const s = club();
    expect(s.phase).toBe("night");
    expect(s.level).toBe(4);
    expect(s.stock.tsla).toBeGreaterThan(0);
    expect(s.staff.security).toBeGreaterThan(0);
    expect(s.bookedTalent.length).toBe(1);
  });
});

describe("guest player", () => {
  it("pays the cover to get in", () => {
    const s = club();
    const r = must(visitorJoin(s, "Kiel", 20_000));
    expect(r.night!.visitor!.cash).toBe(20_000 - coverPrice(s));
    expect(r.nightRevenue.cover).toBe(s.nightRevenue.cover + coverPrice(s));
    expect(visitorJoin(s, "Broke", 0).ok).toBe(false);
  });

  it("buys at the live price: stock down, club takings up", () => {
    const s = must(visitorJoin(club(), "Kiel", 20_000));
    const price = marketPrice(s, "tsla");
    const r = must(visitorBuy(s, "tsla", 3));
    expect(r.stock.tsla).toBe(s.stock.tsla - 3);
    expect(r.nightRevenue.bar).toBe(s.nightRevenue.bar + 3 * price);
    expect(r.night!.visitor!.holdings.tsla).toEqual({
      qty: 3,
      cost: 3 * price,
    });
    expect(visitorBuy(s, "tsla", 10_000).ok).toBe(false);
    expect(visitorBuy(s, "spcx", 1).ok).toBe(false); // Level 5 token
  });

  it("is buy-only: holdings are valued at the live price and nothing sells back", async () => {
    const src = await import("../src");
    expect("visitorSell" in src).toBe(false);
    let s = must(
      visitorBuy(must(visitorJoin(club(), "Kiel", 20_000)), "nvda", 4),
    );
    for (let i = 0; i < 30; i++) s = tickNight(s);
    expect(visitorValue(s)).toBe(
      s.night!.visitor!.cash + 4 * marketPrice(s, "nvda"),
    );
    expect(visitorPnl(s)).toBe(visitorValue(s) - 20_000);
  });
});
