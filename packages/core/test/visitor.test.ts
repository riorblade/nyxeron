import { describe, expect, it } from "vitest";
import {
  coverPrice,
  encodeAvatar,
  legacyAvatar,
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
    const r = must(visitorJoin(s, "me", "Kiel", 20_000));
    expect(r.night!.visitors!.me!.cash).toBe(20_000 - coverPrice(s));
    expect(r.nightRevenue.cover).toBe(s.nightRevenue.cover + coverPrice(s));
    expect(visitorJoin(s, "b", "Broke", 0).ok).toBe(false);
  });

  it("keeps a valid outfit and replaces a forged one", () => {
    const look = "ebony:tank-gold,skirt-black,heels-gold,hair-afro";
    expect(
      must(visitorJoin(club(), "me", "Kiel", 20_000, 7, look)).night!.visitors!
        .me!.look,
    ).toBe(look);
    const forged = must(
      visitorJoin(club(), "me", "Kiel", 20_000, 7, "sand:<script>"),
    );
    expect(forged.night!.visitors!.me!.look).toBe(
      encodeAvatar(legacyAvatar(7)),
    );
    expect(
      must(visitorJoin(club(), "me", "Kiel", 20_000)).night!.visitors!.me!.look,
    ).toBeUndefined();
  });

  it("buys at the live price: stock down, club takings up", () => {
    const s = must(visitorJoin(club(), "me", "Kiel", 20_000));
    const price = marketPrice(s, "tsla");
    const r = must(visitorBuy(s, "me", "tsla", 3));
    expect(r.stock.tsla).toBe(s.stock.tsla - 3);
    expect(r.nightRevenue.bar).toBe(s.nightRevenue.bar + 3 * price);
    expect(r.night!.visitors!.me!.holdings.tsla).toEqual({
      qty: 3,
      cost: 3 * price,
    });
    expect(visitorBuy(s, "me", "tsla", 10_000).ok).toBe(false);
    expect(visitorBuy(s, "me", "spcx", 1).ok).toBe(false); // Level 5 token
  });

  it("is buy-only: holdings are valued at the live price and nothing sells back", async () => {
    const src = await import("../src");
    expect("visitorSell" in src).toBe(false);
    let s = must(
      visitorBuy(
        must(visitorJoin(club(), "me", "Kiel", 20_000)),
        "me",
        "nvda",
        4,
      ),
    );
    for (let i = 0; i < 30; i++) s = tickNight(s);
    expect(visitorValue(s, "me")).toBe(
      s.night!.visitors!.me!.cash + 4 * marketPrice(s, "nvda"),
    );
    expect(visitorPnl(s, "me")).toBe(visitorValue(s, "me") - 20_000);
  });
});

describe("several players at once", () => {
  it("each guest has their own wallet; leaving takes them out, the club keeps the takings", async () => {
    const { visitorLeave } = await import("../src");
    let s = must(visitorJoin(club(), "1", "Ana", 20_000, 7));
    s = must(visitorJoin(s, "2", "Budi", 5_000, 2));
    expect(visitorJoin(s, "1", "Ana again", 20_000).ok).toBe(false);
    s = must(visitorBuy(s, "2", "tsla", 1));
    expect(s.night!.visitors!["1"]!.holdings).toEqual({});
    expect(s.night!.visitors!["2"]!.holdings.tsla!.qty).toBe(1);
    const coin = s.coin;
    s = visitorLeave(s, "2");
    expect(s.night!.visitors!["2"]).toBeUndefined();
    expect(s.coin).toBe(coin);
    expect(visitorBuy(s, "2", "tsla", 1).ok).toBe(false);
    expect(visitorBuy(s, "1", "nope" as never, 1).ok).toBe(false);
  });
});

describe("DJ gig", () => {
  it("opens the AI-run night at the DJ slot, crowd already in", async () => {
    const { createGig, night, isInside } = await import("../src");
    const s = createGig(scenarios.events[1]!, 5);
    expect(s.night!.minute).toBe(night.djSetStartMinute);
    expect(s.night!.guests.filter(isInside).length).toBeGreaterThan(0);
    expect(s.bookedTalent.length).toBe(1);
  });
});
