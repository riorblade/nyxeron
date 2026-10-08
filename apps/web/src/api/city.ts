import type { Level, TokenId } from "@nyxeron/core";
import { create } from "zustand";
import { en } from "@/i18n/en";
import { useGame } from "@/state/store";
import { useAccount } from "@/auth/account";
import { apply, call } from "@/api/player";
import { topups, useTopups } from "@/api/topups";

/**
 * The shared city (api: /api/city). It runs on Credit (real money): venues are rented by the week in Credit; a
 * tenant's shop resells real stock from the platform's warehouse at the tenant's Credit price while they're away;
 * from Level 3 the tenant schedules parties. The server settles everything; this module only asks and shows.
 */
/** One token on a shop's menu: the warehouse's units and the tenant's price in Credit. */
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
  /** What one unit (0.001 share) costs the platform now, in Credit: a shop's floor. Tokens with a live price. */
  wholesale?: Partial<Record<TokenId, number>>;
  /** A shop's ceiling: maxMarkup × wholesale. */
  maxMarkup?: number;
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
    act(async () => {
      await call("POST", "/city/lease", { level, slot, club, weeks });
      await topups.load(); // rent is paid in Credit
    }, en.city.rented),
  rename: (lease: number, club: string) =>
    act(() => call("PUT", "/city/venue", { lease, club }), en.city.renamed),
  shop: (lease: number, open: boolean) =>
    act(() => call("PUT", "/city/shop", { lease, open }), en.city.saved),
  /** The tenant's menu: a Credit price per token (blank = not sold). */
  prices: (lease: number, prices: Partial<Record<TokenId, number>>) =>
    act(
      () => call("PUT", `/city/shops/${lease}/prices`, { prices }),
      en.city.saved,
    ),
  /** Buy real stock at a shop, at most at the price shown; the Credit left comes back. */
  buy: (lease: number, token: TokenId, qty: number, maxPrice: number) =>
    act(
      async () => {
        const out = (await call("POST", `/city/shops/${lease}/buy-credit`, {
          token,
          qty,
          maxPrice,
        })) as unknown as { credits: number };
        useTopups.setState({ credits: out.credits });
      },
      en.city.bought(qty, token.toUpperCase()),
    ),
  /** Host a party now: a club at the venue's level, opened to players from the office. */
  host(p: Party) {
    useGame.getState().start({ mode: "party", name: p.club, level: p.level });
  },
};
