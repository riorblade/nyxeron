import { expect, test } from "vitest";
import { BawRefused, outcome, readReply } from "./baw";

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

// Review round 3 of #58, item 2: a malformed answer is an error here, never a TypeError inside execFile's callback.
test("readReply: only {success:true,data} is data; a malformed answer is an error, a bare refusal is BawRefused", () => {
  expect(readReply('{"success":true,"data":{"orderId":"o1"}}', null)).toEqual({
    orderId: "o1",
  });
  for (const bad of ["null", "[]", "3", '"x"', "{}", '{"success":true}'])
    expect(() => readReply(bad, null)).toThrow(/unexpected answer/);
  expect(() => readReply('{"success":false}', null)).toThrow(BawRefused);
  expect(() => readReply('{"success":false,"error":null}', null)).toThrow(
    BawRefused,
  );
  expect(() =>
    readReply('{"success":false,"error":{"name":"E","message":"no"}}', null),
  ).toThrow("E: no");
  const crash = new Error("exit 1");
  expect(() => readReply("", crash)).toThrow(crash);
});
