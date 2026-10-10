import { expect, test } from "vitest";
import { outcome } from "./baw";

test("outcome: wait while pending, report a finished swap's tx, give up on a failed one", () => {
  expect(outcome(undefined).state).toBe("wait");
  expect(outcome({ orderId: "1", status: "PENDING", txHash: null }).state).toBe(
    "wait",
  );
  expect(outcome({ orderId: "1", status: "FINISHED", txHash: "0xab" })).toEqual(
    { state: "done", tx: "0xab" },
  );
  // FINISHED: the USDC is spent. Without a tx hash yet it is not a failure (a deleted record would buy again).
  expect(
    outcome({ orderId: "1", status: "FINISHED", txHash: null }).state,
  ).toBe("wait");
  expect(outcome({ orderId: "1", status: "FINISHED", txHash: "" }).state).toBe(
    "wait",
  );
  expect(outcome({ orderId: "1", status: "FAILED", txHash: null }).state).toBe(
    "failed",
  );
  // A status the wallet may add later is not a failure: the swap may still land.
  const unknown = { orderId: "1", status: "PROCESSING", txHash: null };
  expect(
    outcome(unknown as unknown as Parameters<typeof outcome>[0]).state,
  ).toBe("wait");
});
