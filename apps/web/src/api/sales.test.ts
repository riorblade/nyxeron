import { describe, expect, it } from "vitest";
import { menuOf, priceRange } from "./sales";

describe("party prices (web side)", () => {
  it("a CEO's price runs from wholesale to maxMarkup × wholesale", () => {
    const list = { prices: {}, wholesale: { tsla: 38 }, maxMarkup: 3 };
    expect(priceRange(list, "tsla")).toEqual({ min: 38, max: 114 });
    expect(priceRange(list, "nvda")).toEqual({ min: 0, max: 0 });
  });

  it("only the tokens with a price go on the menu", () => {
    expect(menuOf({ tsla: 50, nvda: 0 })).toEqual({ tsla: 50 });
  });
});
