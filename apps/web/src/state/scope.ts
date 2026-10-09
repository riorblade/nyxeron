/**
 * Whose data this browser is showing: the signed-in player's storage scope ("" signed out / no auth in dev).
 * Every account-owned key goes through userKey, so two players on one browser never share data, and sync hooks
 * tell the server about every change (api/docs.ts sets them after sign-in).
 */
let scope = "";
export const setScope = (s: string) => {
  scope = s;
};
export const hasScope = () => scope !== "";

/** `base` under the player's scope, or the pre-account key when signed out. */
export const userKey = (base: string, legacy: string) =>
  scope ? `nyxeron:u:${scope}:${base}` : legacy;

/** Where a venue's furniture layout is saved (venue/furniture.ts), kept here so api/docs.ts can sync it without
 * pulling three.js into the first load. */
export const layoutKey = (name: string) =>
  userKey(`furniture.${name}.v2`, `nyxeron.furniture.${name}.v2`);

/** Called after the browser saved something that belongs to the account. */
export const syncHooks: {
  save?: (slot: string, raw: string | null) => void;
  layout?: (name: string, json: string | null) => void;
  shoutouts?: (json: string) => void;
} = {};
