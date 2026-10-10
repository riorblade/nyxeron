import { describe, expect, it } from "vitest";
import { restockMessage } from "./restockMessage";

const ticker = (t: string) => t.toUpperCase();
const fmt = (n: number) => String(n);

describe("restockMessage", () => {
  it("a normal swap says how many units were added", () => {
    expect(restockMessage({ units: 8 }, "tsla", ticker, fmt)).toBe(
      "✓ Added 8 TSLA from the swap",
    );
  });
  it("a sub-unit swap is booked, not 'Added 0'", () => {
    expect(restockMessage({ units: 0 }, "tsla", ticker, fmt)).toBe(
      "✓ Swap booked: under one unit of TSLA, the fraction stays in the wallet",
    );
  });
  it("units that only covered a shortfall are explained", () => {
    expect(restockMessage({ units: 7, short: 1 }, "tsla", ticker, fmt)).toBe(
      "✓ Added 7 TSLA from the swap; 1 more covered units the wallet was short on chain",
    );
    expect(restockMessage({ units: 0, short: 3 }, "tsla", ticker, fmt)).toBe(
      "✓ Swap booked: no TSLA added; 3 more covered units the wallet was short on chain",
    );
  });
  it("other tokens the same swap bought are listed", () => {
    expect(
      restockMessage({ units: 2, others: { nvda: 5 } }, "tsla", ticker, fmt),
    ).toBe("✓ Added 2 TSLA from the swap; plus 5 NVDA");
  });
});
