import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR,
  decodeAvatar,
  encodeAvatar,
  equip,
  isAvatar,
  itemOf,
  randomAvatar,
  legacyAvatar,
  wardrobe,
  type Avatar,
  type ItemId,
  SLOTS,
  priceOf,
  CELEBRATION_IDS,
  celebrationOf,
  unowned,
} from "../src";

describe("avatar", () => {
  it("every item sits in a known slot, and presets only name items of that slot", () => {
    for (const [id, it] of Object.entries(wardrobe.items))
      expect(wardrobe.slots, id).toContain(it.slot);
    for (const pool of [wardrobe.presets.masc, wardrobe.presets.fem])
      for (const [slot, list] of Object.entries(pool))
        for (const id of list as ItemId[])
          expect(itemOf(id).slot, id).toBe(slot);
  });

  it("validates skin, slots and the required shirt, pants and shoes", () => {
    expect(isAvatar(DEFAULT_AVATAR)).toBe(true);
    expect(isAvatar({ ...DEFAULT_AVATAR, skin: "green" })).toBe(false);
    expect(
      isAvatar({
        skin: "sand",
        items: { shirt: "tee-white", pants: "jeans-blue" },
      }),
    ).toBe(false);
    expect(
      isAvatar({
        ...DEFAULT_AVATAR,
        items: { ...DEFAULT_AVATAR.items, hat: "tee-black" },
      }),
    ).toBe(false);
    expect(isAvatar(null)).toBe(false);
  });

  it("equips into the item's own slot and never empties a required one", () => {
    const a = equip(DEFAULT_AVATAR, "hat", "cap-gold");
    expect(a.items.hat).toBe("cap-gold");
    expect(equip(a, "hat", null).items.hat).toBeUndefined();
    expect(equip(a, "shirt", null)).toBe(a);
    expect(equip(a, "hat", "tee-black")).toBe(a);
  });

  it("random outfits are deterministic, valid, and dresses go with skirts", () => {
    expect(randomAvatar(42, true)).toEqual(randomAvatar(42, true));
    for (let i = 0; i < 400; i++) {
      const a = randomAvatar(i, i % 2 === 0);
      expect(isAvatar(a), JSON.stringify(a)).toBe(true);
      if (itemOf(a.items.shirt!).style === "dress")
        expect(itemOf(a.items.pants!).style).toBe("skirt");
    }
  });

  it("round-trips through the text form and rejects junk", () => {
    const a: Avatar = equip(
      equip(DEFAULT_AVATAR, "glasses", "shades-neon"),
      "neck",
      "chain-gold",
    );
    expect(decodeAvatar(encodeAvatar(a))).toEqual(a);
    expect(
      decodeAvatar("sand:tee-white,tee-black,jeans-blue,sneakers-white"),
    ).toBe(DEFAULT_AVATAR);
    expect(decodeAvatar("sand:nope")).toBe(DEFAULT_AVATAR);
    expect(decodeAvatar(7)).toBe(DEFAULT_AVATAR);
    expect(decodeAvatar("x".repeat(500))).toBe(DEFAULT_AVATAR);
    expect(SLOTS.length).toBe(8);
  });

  it("an old sprite pick maps to a fixed, valid outfit", () => {
    expect(legacyAvatar(3)).toEqual(legacyAvatar(3));
    expect(isAvatar(legacyAvatar(8))).toBe(true);
    expect(legacyAvatar(99)).toEqual(legacyAvatar(10));
  });

  it("shop items cost Coin, NPCs and old sprite picks never wear one, and unowned lists what's missing", () => {
    const shop = (Object.keys(wardrobe.items) as ItemId[]).filter(
      (id) => priceOf(id) > 0,
    );
    expect(shop.length).toBeGreaterThan(10);
    for (const id of shop) expect(Number.isInteger(priceOf(id))).toBe(true);
    for (const pool of [wardrobe.presets.masc, wardrobe.presets.fem])
      for (const list of Object.values(pool))
        for (const id of list as ItemId[]) expect(priceOf(id), id).toBe(0);
    for (let n = 1; n <= 10; n++)
      expect(unowned(legacyAvatar(n), [])).toEqual([]);
    const a = equip(
      equip(DEFAULT_AVATAR, "hat", "tophat-gold"),
      "neck",
      "chain-diamond",
    );
    expect(unowned(a, [])).toEqual(["tophat-gold", "chain-diamond"]);
    expect(unowned(a, ["chain-diamond"])).toEqual(["tophat-gold"]);
    expect(unowned(DEFAULT_AVATAR, [])).toEqual([]);
  });

  it("celebrations are shop moves with a Coin price, never wardrobe items", () => {
    expect(CELEBRATION_IDS).toEqual(["makeItRain", "tokenToss"]);
    for (const id of CELEBRATION_IDS) {
      expect(celebrationOf(id).price).toBeGreaterThan(0);
      expect(Object.keys(wardrobe.items)).not.toContain(id);
    }
  });
});
