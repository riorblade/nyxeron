import { expect, test } from "vitest";
import type { Supply, SupplyRow } from "./demand";
import { checkContract, checkQuoteFor, locked, pick } from "./plan";

const row = (
  token: string,
  daysLeft: number,
  suggested: number,
): SupplyRow => ({
  token,
  ticker: token.toUpperCase(),
  onHand: 0,
  sold24h: 0,
  sold7d: 0,
  daysLeft,
  suggested,
});
const supply = (...tokens: SupplyRow[]): Supply => ({
  tokens,
  coverDays: 3,
  at: 0,
});

test("pick: only whitelisted tokens, whatever the demand for the others", () => {
  expect(pick(supply(row("tsla", 2, 10), row("nvda", 0.5, 40)))?.token).toBe(
    "tsla",
  );
  expect(
    pick(supply(row("nvda", 0.5, 40), row("us500", 1, 9))),
  ).toBeUndefined();
});

test("pick: nothing when the api suggests no restock", () => {
  expect(pick(supply(row("tsla", -1, 0)))).toBeUndefined();
});

test("locked: TSLA is in, baskets and other stocks are out", () => {
  expect(locked("tsla")?.symbol).toBe("TSLAB");
  expect(locked("nvda")).toBeUndefined();
  expect(locked("us500")).toBeUndefined();
});

test("checkContract: the locked address must match Binance's list", () => {
  const tsla = locked("tsla")!;
  expect(() => checkContract(tsla, tsla.contract.toUpperCase())).not.toThrow();
  expect(() =>
    checkContract(tsla, "0x0000000000000000000000000000000000000001"),
  ).toThrow(/not Binance's/);
  expect(() => checkContract(tsla, undefined)).toThrow(/not listed/);
});

// Review round 3 of #58, nit: the price per share is only right for a quote of the budget into the locked token.
test("checkQuoteFor: the quote must be for the budget (to the cent) and the locked token", () => {
  const tsla = locked("tsla")!;
  const q = (fromCoinAmount: string, toCoinSymbol = "TSLAB") => ({
    fromCoinSymbol: "USDC",
    fromCoinAmount,
    toCoinSymbol,
  });
  for (const ok of ["50", "50.000000", "50.004", "49.996"])
    expect(() => checkQuoteFor(q(ok), 50, tsla)).not.toThrow();
  for (const bad of ["500", "5", "50.01", "", "NaN", "Infinity"])
    expect(() => checkQuoteFor(q(bad), 50, tsla)).toThrow(/not the budget/);
  expect(() => checkQuoteFor(q("50", "AAPLB"), 50, tsla)).toThrow(/not TSLAB/);
});
