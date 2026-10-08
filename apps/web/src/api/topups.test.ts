import { payments } from "@nyxeron/core";
import { describe, expect, it } from "vitest";
import { topupQuote, topupRoom } from "./topups";

describe("top-ups (web side)", () => {
  it("quotes like the api: 1% fee rounded up, the rest as Credit", () => {
    expect(topupQuote(300)).toEqual({ fee: 3, credits: 297 });
    expect(topupQuote(90676)).toEqual({ fee: 907, credits: 89769 });
  });

  it("caps what a player may still send: per 24 h and in total", () => {
    const day = payments.topup.capUsdPerDay * 100;
    const total = payments.topup.capUsdTotal * 100;
    expect(topupRoom({ day: 0, total: 0 })).toBe(day);
    expect(topupRoom({ day: 1500, total: 1500 })).toBe(day - 1500);
    // Earlier days count against the total only.
    expect(topupRoom({ day: 0, total: total - 500 })).toBe(500);
    expect(topupRoom({ day: day, total: day })).toBe(0);
    // A top-up still confirming counts too: no second send past the cap meanwhile.
    expect(topupRoom({ day: 0, total: 0 }, 1500)).toBe(day - 1500);
    expect(topupRoom({ day: 1500, total: 1500 }, 1000)).toBe(0);
  });
});
