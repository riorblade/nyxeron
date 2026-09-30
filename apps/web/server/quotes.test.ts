import { describe, expect, it } from "vitest";
import { getQuotes, sign, toQuotes } from "./quotes";

describe("Binance RWA quotes proxy", () => {
  it("signs base64(HMAC-SHA256(ts + METHOD + path + body))", () => {
    // Vector from: printf '%s' "<preHash>" | openssl dgst -sha256 -hmac test-secret -binary | base64
    expect(
      sign(
        "test-secret",
        "2026-05-11T10:08:57.715Z",
        "get",
        "/build/api/v1/dex/market/rwa/tokens?binanceChainId=56",
      ),
    ).toBe("qi1JDOb/5OKUF6/NYwQ5LwfEpg8dSqgKFIODFA/Srfs=");
  });

  it("maps the token list to one price per underlying ticker", () => {
    const json = {
      data: {
        list: [
          {
            platformId: "ondo",
            underlyingTicker: "nvda",
            referencePrice: "180.5",
          },
          {
            platformId: "bstock",
            underlyingTicker: "NVDA",
            referencePrice: "999",
          },
          { platformId: "ondo", underlyingTicker: "TSLA", tokenPrice: "61.89" },
          { platformId: "ondo", underlyingTicker: "BAD", tokenPrice: "0" },
        ],
      },
    };
    expect(toQuotes(json)).toEqual({ NVDA: 180.5, TSLA: 61.89 });
  });

  it("without keys it answers with no quotes instead of failing", async () => {
    const r = await getQuotes({});
    expect(r).toMatchObject({ quotes: {}, source: "none" });
  });
});
