import { beforeEach, expect, test, vi } from "vitest";

// The wallet as seen in production on 2026-10-10: the swap answered order id …860615, the list knows …860851
// (the same double), and `list --orderId …860615` is empty.
const TSLAB = "0x5b1910eAaD6450E50f816082Aa078C41F10C292f";
let orders: object[] = [];
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, out: string) => void,
  ) => {
    const at = args.indexOf("--orderId");
    const list =
      at >= 0
        ? orders.filter(
            (o) => (o as { orderId: string }).orderId === args[at + 1],
          )
        : orders;
    cb(null, JSON.stringify({ success: true, data: { list } }));
  },
}));
const { order } = await import("./baw");

const real = {
  orderId: "26101000001955860851",
  status: "FINISHED",
  txHash: "0x4eb8b500e2f3ed5a638a49e73117b1ac98e0192214aa5dfc3d80dfb1e7efdb91",
  toToken: TSLAB,
  fromTokenQty: "3.000000000000000000",
};
beforeEach(() => {
  orders = [real];
});

test("a rounded order id still finds its swap: same double, same token, same amount", async () => {
  expect(await order("26101000001955860851")).toEqual(real); // exact
  expect(await order("26101000001955860615")).toBeUndefined(); // no token/amount given: no guessing
  expect(await order("26101000001955860615", TSLAB.toLowerCase(), 3)).toEqual(
    real,
  );
});

test("no match on another amount, token or a different double; two matches is an error", async () => {
  expect(await order("26101000001955860615", TSLAB, 5)).toBeUndefined();
  expect(
    await order("26101000001955860615", "0x" + "1".repeat(40), 3),
  ).toBeUndefined();
  expect(await order("26101000001955900000", TSLAB, 3)).toBeUndefined();
  orders = [
    real,
    { ...real, orderId: "26101000001955860700", txHash: "0xother" },
  ];
  await expect(order("26101000001955860615", TSLAB, 3)).rejects.toThrow(
    /2 orders match/,
  );
});
