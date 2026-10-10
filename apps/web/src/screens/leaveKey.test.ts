import { describe, expect, it } from "vitest";
import { escLeaving } from "./leaveKey";

describe("escLeaving", () => {
  it("opens the Leave dialog when it is closed", () => {
    expect(escLeaving(false, false)).toBe(true);
  });

  it("closes the Leave dialog when it is open (Esc = Stay, no keyboard trap)", () => {
    expect(escLeaving(true, false)).toBe(false);
  });

  it("leaves the end-of-night summary alone (it has no Stay to go back to)", () => {
    expect(escLeaving(false, true)).toBe(false);
    expect(escLeaving(true, true)).toBe(true);
  });
});
