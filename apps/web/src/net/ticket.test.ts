import { beforeEach, describe, expect, it, vi } from "vitest";

const acct = { account: { id: "A" } as { id: string } | null, token: () => {} };
let issued = 0;
let fail = "";
vi.mock("@/auth/account", () => ({ useAccount: { getState: () => acct } }));
vi.mock("@/api/player", () => ({
  online: () => !!acct.account,
  call: async () => {
    if (fail) throw new Error(fail);
    return { ticket: `t-${acct.account!.id}-${++issued}` };
  },
}));

import { dropTicket, relayTicket } from "./ticket";

describe("relay ticket cache", () => {
  beforeEach(() => {
    dropTicket();
    acct.account = { id: "A" };
    fail = "";
  });

  it("an api without the endpoint (404) means no ticket; a 502 means try again later", async () => {
    fail = "404";
    expect(await relayTicket()).toBe("");
    fail = "405"; // what the production api before tickets actually answers
    expect(await relayTicket()).toBe("");
    fail = "502";
    await expect(relayTicket()).rejects.toThrow("502");
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
