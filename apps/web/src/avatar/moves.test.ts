import { describe, expect, it } from "vitest";
import { CELEBRATION_IDS } from "@nyxeron/core";
import { CELEBRATIONS, throwsBetween } from "./moves";
import { acceptRoam } from "./roam";

const count = (move: Parameters<typeof throwsBetween>[0], beats: number) => {
  let n = 0;
  for (let b = 0; b < beats; b += 1 / 60)
    n += throwsBetween(move, b, b + 1 / 60).length;
  return n;
};

describe("celebrations", () => {
  it("are the shop's celebrations (core wardrobe.json)", () => {
    expect([...CELEBRATIONS]).toEqual(CELEBRATION_IDS);
  });
  it("throw on the beat: bills twice a beat, coins every two beats, dances nothing", () => {
    expect(count("makeItRain", 8)).toBe(16);
    expect(count("tokenToss", 8)).toBe(4);
    expect(count("bounce", 8)).toBe(0);
    expect(throwsBetween("makeItRain", 1, 1)).toEqual([]);
    expect(throwsBetween("tokenToss", 0, 1.3)[0]).toMatchObject({
      kind: "coin",
      hands: ["l", "r"],
    });
  });
  it("the host relays a celebration but nothing made up", () => {
    const room = { w: 10, h: 10, blocks: [] };
    const r = { x: 5, z: 5, yaw: 0, moving: false };
    expect(
      acceptRoam(undefined, { ...r, emote: "makeItRain" }, 100, room).emote,
    ).toBe("makeItRain");
    expect(
      acceptRoam(undefined, { ...r, emote: "moneyGun" as never }, 100, room)
        .emote,
    ).toBe(null);
  });
});
