import { beforeEach, describe, expect, it, vi } from "vitest";

const acct = { account: { id: "A" } as { id: string } | null, token: () => {} };
let issued = 0;
vi.mock("@/auth/account", () => ({ useAccount: { getState: () => acct } }));
vi.mock("@/api/player", () => ({
  online: () => !!acct.account,
  call: async () => ({ ticket: `t-${acct.account!.id}-${++issued}` }),
}));

import { dropTicket, relayTicket } from "./ticket";

describe("relay ticket cache", () => {
  beforeEach(() => {
    dropTicket();
    acct.account = { id: "A" };
  });

  it("is reused for its own account only, and refetched after a refusal", async () => {
    const first = await relayTicket();
    expect(await relayTicket()).toBe(first); // cached
    acct.account = { id: "B" }; // signed out, signed in as someone else
    const b = await relayTicket();
    expect(b).toMatch(/^t-B-/);
    dropTicket(); // the relay refused it
    expect(await relayTicket()).not.toBe(b);
    acct.account = null;
    expect(await relayTicket()).toBe("");
  });
});
