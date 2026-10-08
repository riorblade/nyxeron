import { describe, expect, it } from "vitest";
import {
  canHostParty,
  city,
  levels,
  payments,
  shopTokens,
  spotFactorOf,
  venueCount,
  weeklyRent,
} from "../src";

describe("city rentals", () => {
  it("rent rises with the venue, and the back office can override it", () => {
    for (const l of [1, 2, 3, 4] as const)
      expect(weeklyRent((l + 1) as 2)).toBeGreaterThan(weeklyRent(l));
    expect(weeklyRent(5, { 5: 99 })).toBe(99);
    expect(weeklyRent(4, { 5: 99 })).toBe(payments.rentCredits[4]);
    // Few big venues: the Premium Venue is scarce.
    expect(venueCount(5)).toBeLessThan(venueCount(1));
  });

  it("club prices follow the real market", () => {
    expect(spotFactorOf({ TSLA: 300 }, { TSLA: 200 }, "tsla")).toBe(1.5);
    expect(spotFactorOf({}, {}, "tsla")).toBe(1);
    // Baskets weigh their legs.
    expect(
      spotFactorOf(
        { SPY: 2, QQQ: 1, IWM: 1 },
        { SPY: 1, QQQ: 1, IWM: 1 },
        "us500",
      ),
    ).toBeCloseTo(1.5);
  });

  it("small venues only sell; parties start at Level 3; menus grow with the venue", () => {
    expect(canHostParty(2)).toBe(false);
    expect(canHostParty(3)).toBe(true);
    expect(shopTokens(1).length).toBeLessThan(shopTokens(5).length);
    expect(Object.keys(city.venues)).toEqual(Object.keys(levels));
  });
});
