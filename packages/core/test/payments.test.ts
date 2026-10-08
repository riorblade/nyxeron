import { describe, expect, it } from "vitest";
import { payments, tokens } from "../src";

const address = /^0x[0-9a-fA-F]{40}$/;

describe("payments.json (real money)", () => {
  it("whitelists only game tokens with a bStock contract and a recorded $3 quote", () => {
    const listed = Object.entries(payments.tokens);
    expect(listed.length).toBeGreaterThan(0);
    for (const [id, t] of listed) {
      expect(Object.keys(tokens)).toContain(id);
      expect(t.contract).toMatch(address);
      expect(t.quote.usdc).toBe(3);
      expect(Number(t.quote.received)).toBeGreaterThan(0);
    }
  });

  it("locks the wallet and top-up token addresses", () => {
    expect(payments.agenticWallet).toMatch(address);
    for (const a of Object.values(payments.topup.tokens))
      expect(a).toMatch(address);
  });
});
