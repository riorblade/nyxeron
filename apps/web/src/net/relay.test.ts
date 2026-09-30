import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, KIND, pack, unpack } from "./relay";

describe("relay frames", () => {
  it("round-trips kind, peer id and payload", () => {
    const b = encodeFrame(KIND.to, 513, pack({ buy: "tsla", qty: 5 }));
    expect([b[0], b[1], b[2]]).toEqual([3, 2, 1]);
    const f = decodeFrame(b.buffer as ArrayBuffer)!;
    expect(f.kind).toBe(KIND.to);
    expect(f.peer).toBe(513);
    expect(unpack(f.payload)).toEqual({ buy: "tsla", qty: 5 });
  });
  it("rejects frames shorter than the header", () => {
    expect(decodeFrame(new Uint8Array([1, 0]).buffer)).toBeNull();
  });
});
