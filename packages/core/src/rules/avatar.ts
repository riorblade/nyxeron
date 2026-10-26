import { isId, wardrobe } from "../data";
import { createRng } from "../rng";

export type SkinId = keyof typeof wardrobe.skins;
export type ItemId = keyof typeof wardrobe.items;
export type Slot = keyof typeof wardrobe.presets.masc;
/** Slots in draw/encode order. */
export const SLOTS = wardrobe.slots as Slot[];
/** `price`: Coin in the item shop; no price = free for everyone (the starter wardrobe NPCs wear too). */
export type Item = (typeof wardrobe.items)[ItemId] & {
  accent?: string;
  price?: number;
};

/** What a character wears: a skin tone and at most one item per slot. Cosmetic only. */
export interface Avatar {
  skin: SkinId;
  items: Partial<Record<Slot, ItemId>>;
}

export const itemOf = (id: ItemId) => wardrobe.items[id] as Item;
export const priceOf = (id: ItemId) => itemOf(id).price ?? 0;
/** The shop items in `a` that `owned` doesn't have (the api refuses to save a look with any). */
export const unowned = (a: Avatar, owned: readonly string[]) =>
  Object.values(a.items).filter((id) => priceOf(id) > 0 && !owned.includes(id));
export const itemsFor = (slot: Slot) =>
  (Object.keys(wardrobe.items) as ItemId[]).filter(
    (id) => wardrobe.items[id].slot === slot,
  );

export const DEFAULT_AVATAR: Avatar = {
  skin: "sand",
  items: {
    shirt: "tee-white",
    pants: "jeans-blue",
    shoes: "sneakers-white",
    hair: "hair-short-black",
  },
};

/** A valid avatar: a known skin, every item in its own slot, and the required slots (shirt, pants, shoes) filled. */
export function isAvatar(a: unknown): a is Avatar {
  if (!a || typeof a !== "object") return false;
  const { skin, items } = a as Avatar;
  if (typeof skin !== "string" || !isId(wardrobe.skins, skin)) return false;
  if (!items || typeof items !== "object") return false;
  for (const [slot, id] of Object.entries(items)) {
    if (typeof id !== "string" || !isId(wardrobe.items, id)) return false;
    if (wardrobe.items[id].slot !== slot) return false;
  }
  return (wardrobe.required as Slot[]).every((s) => items[s]);
}

/** Equip `id` (in its own slot) or, with `null`, empty `slot`; required slots can't be emptied. */
export function equip(a: Avatar, slot: Slot, id: ItemId | null): Avatar {
  if (id === null)
    return (wardrobe.required as Slot[]).includes(slot)
      ? a
      : {
          ...a,
          items: Object.fromEntries(
            Object.entries(a.items).filter(([k]) => k !== slot),
          ),
        };
  if (itemOf(id).slot !== slot) return a;
  return { ...a, items: { ...a.items, [slot]: id } };
}

/** A believable random outfit (NPC guests), deterministic per seed. */
export function randomAvatar(seed: number, female: boolean): Avatar {
  const rng = createRng(seed >>> 0);
  const pool = female ? wardrobe.presets.fem : wardrobe.presets.masc;
  const chance = wardrobe.presets.chance as Partial<Record<Slot, number>>;
  const items: Avatar["items"] = {};
  for (const slot of SLOTS) {
    const list = pool[slot] as ItemId[];
    if (!list.length) continue;
    const p = chance[slot] ?? 1;
    if (p < 1 && !rng.chance(p)) continue;
    items[slot] = rng.pick(list);
  }
  // A dress already covers the legs' top half; shorts under it would poke out.
  if (items.shirt && itemOf(items.shirt).style === "dress" && items.pants) {
    const skirt = pool.pants.find(
      (id) => itemOf(id as ItemId).style === "skirt",
    );
    if (skirt) items.pants = skirt as ItemId;
  }
  return { skin: rng.pick(Object.keys(wardrobe.skins) as SkinId[]), items };
}

/** Compact text form for the wire and saves: `skin:item,item,…`. */
export const encodeAvatar = (a: Avatar) =>
  `${a.skin}:${SLOTS.map((s) => a.items[s])
    .filter(Boolean)
    .join(",")}`;

/** Parses `encodeAvatar` output; anything invalid falls back to `fallback`. */
export function decodeAvatar(
  text: unknown,
  fallback: Avatar = DEFAULT_AVATAR,
): Avatar {
  if (typeof text !== "string" || text.length > 400) return fallback;
  const [skin, list = ""] = text.split(":");
  const items: Avatar["items"] = {};
  for (const id of list.split(",").filter(Boolean)) {
    if (!isId(wardrobe.items, id)) return fallback;
    const slot = wardrobe.items[id].slot as Slot;
    if (items[slot]) return fallback;
    items[slot] = id;
  }
  const a = { skin, items } as Avatar;
  return isAvatar(a) ? a : fallback;
}

/** The outfit for an old sprite pick (1–5 men, 6–10 women), so players who never opened the wardrobe keep a look. */
export const legacyAvatar = (n: number): Avatar =>
  randomAvatar(7919 * Math.max(1, Math.min(10, Math.round(n) || 1)), n > 5);
