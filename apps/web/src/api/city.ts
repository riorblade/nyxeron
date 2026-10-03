import type { Level, TokenId } from "@nyxeron/core";
import { create } from "zustand";
import { en } from "@/i18n/en";
import { useGame } from "@/state/store";
import { useAccount } from "@/auth/account";
import { apply, call } from "@/api/player";

/**
 * The shared city (api: /api/city). Venues are rented by the week with the account's Coin; a tenant's shop
 * sells to other players while they're away; from Level 3 the tenant schedules parties. The server settles
 * everything; this module only asks and shows.
 */
export interface Shelf {
  token: TokenId;
  qty: number;
  price: number;
}
export interface Lease {
  id: number;
  club: string;
  owner: string;
  since: number;
  endsAt: number;
  open: boolean;
  mine?: boolean;
  stock: Shelf[];
}
export interface Venue {
  level: Level;
  slot: number;
  lease: Lease | null;
}
export interface Party {
  id: number;
  leaseId: number;
  level: Level;
  slot: number;
  club: string;
  owner: string;
  title: string;
  startsAt: number;
  minutes: number;
  room: string;
  live: boolean;
  /** Private: listed only for its host and the players who opened its invite link. */
  private: boolean;
  /** The host's invite code (`/?event=<invite>`). */
  invite?: string;
  going: number;
  iGo?: boolean;
  mine?: boolean;
}
export interface City {
  venues: Venue[];
  parties: Party[];
  rent: Record<string, number>;
  /** How many venues each level has (the back office can change it). */
  counts?: Record<string, number>;
  now: number;
  prices?: Record<
    string,
    Partial<Record<TokenId, { wholesale: number; shelf: number; max: number }>>
  >;
  /** What the platform's warehouse holds per token (shops restock from it). */
  supply?: Partial<Record<TokenId, number>>;
  /** Renting, shops and city parties are on (they run on Credit; shut until top-ups are live). */
  open?: boolean;
}

interface CityStore {
  city: City | null;
  error: string;
}
export const useCity = create<CityStore>(() => ({
  city: null,
  error: "",
}));

const base = import.meta.env.VITE_API_BASE ?? "";

export async function loadCity() {
  try {
    const token = await useAccount.getState().token?.();
    const r = await fetch(`${base}/api/city`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(String(r.status));
    useCity.setState({ city: (await r.json()) as City, error: "" });
  } catch (e) {
    useCity.setState({ error: (e as Error).message });
  }
}

/** The venues the signed-in player rents (a player may run several). */
export const myVenues = (c: City | null) =>
  c?.venues.filter((v) => v.lease?.mine) ?? [];

const say = (msg: string, bad = false) => useGame.getState().notify(msg, bad);

/** Run a city action: the server's profile comes back for wallet changes; then the city reloads. */
async function act(fn: () => Promise<unknown>, ok: string) {
  try {
    const p = await fn();
    if (p && typeof p === "object" && "wallet" in p)
      apply(p as Parameters<typeof apply>[0]);
    say(ok);
  } catch (e) {
    say(en.city.failed((e as Error).message), true);
  }
  await loadCity();
}

export const city = {
  lease: (level: Level, club: string, weeks: number, slot = 0) =>
    act(
      () => call("POST", "/city/lease", { level, slot, club, weeks }),
      en.city.rented,
    ),
  rename: (lease: number, club: string) =>
    act(() => call("PUT", "/city/venue", { lease, club }), en.city.renamed),
  stock: (token: TokenId, qty: number) =>
    act(() => call("POST", "/city/stock", { token, qty }), en.city.stocked),
  shop: (
    lease: number,
    open?: boolean,
    prices?: Partial<Record<TokenId, number>>,
  ) =>
    act(
      () => call("PUT", "/city/shop", { lease, open, prices }),
      en.city.saved,
    ),
  buy: (lease: number, token: TokenId, qty: number) =>
    act(
      () => call("POST", `/city/shops/${lease}/buy`, { token, qty }),
      en.city.bought(qty, token.toUpperCase()),
    ),
  /** Host a party now: a club at the venue's level, opened to players from the office. */
  host(p: Party) {
    useGame.getState().start({ mode: "party", name: p.club, level: p.level });
  },
};
