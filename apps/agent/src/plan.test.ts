import { expect, test } from "vitest";
import type { Supply, SupplyRow } from "./demand";
import { checkContract, locked, pick } from "./plan";

const row = (
  token: string,
  daysLeft: number,
  suggested: number,
): SupplyRow => ({
  token,
  ticker: token.toUpperCase(),
  onHand: 0,
  inShops: 0,
  sold24h: 0,
  sold7d: 0,
  shops: 0,
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
