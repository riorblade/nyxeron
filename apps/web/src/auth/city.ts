import type { Level, TokenId } from "@nyxeron/core";
import { create } from "zustand";
import { en } from "@/i18n/en";
import { useGame } from "@/store";
import { useAccount } from "./account";
import { apply, call } from "./remote";

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
  mine?: boolean;
}
export interface City {
  venues: Venue[];
  parties: Party[];
  rent: Record<string, number>;
  now: number;
  prices?: Record<
    string,
    Partial<Record<TokenId, { wholesale: number; shelf: number; max: number }>>
  >;
}

interface CityStore {
  city: City | null;
  error: string;
  /** The party I'm hosting right now (its relay room goes to the server when I open it). */
  hosting: number | null;
}
export const useCity = create<CityStore>(() => ({
  city: null,
  error: "",
  hosting: null,
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

export const myLease = (c: City | null) =>
  c?.venues.find((v) => v.lease?.mine) ?? null;

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
  stock: (token: TokenId, qty: number) =>
    act(() => call("POST", "/city/stock", { token, qty }), en.city.stocked),
  shop: (open?: boolean, prices?: Partial<Record<TokenId, number>>) =>
    act(() => call("PUT", "/city/shop", { open, prices }), en.city.saved),
  buy: (lease: number, token: TokenId, qty: number) =>
    act(
      () => call("POST", `/city/shops/${lease}/buy`, { token, qty }),
      en.city.bought(qty, token.toUpperCase()),
    ),
  party: (startsAt: number, minutes: number, title: string) =>
    act(
      () => call("POST", "/city/parties", { startsAt, minutes, title }),
      en.city.scheduled,
    ),
  cancel: (id: number) =>
    act(() => call("DELETE", `/city/parties/${id}`), en.city.cancelled),
  /** Host a party now: a club at the venue's level, opened to players from the office. */
  host(p: Party) {
    useCity.setState({ hosting: p.id });
    useGame.getState().start({
      mode: "career",
      name: p.club,
      genre: "edm",
      difficulty: "normal",
      level: p.level,
    });
  },
  /** The relay room for the party being hosted (RoomPanel calls this once the room is open). */
  async roomOpened(room: string) {
    const id = useCity.getState().hosting;
    if (!id) return;
    try {
      await call("PUT", `/city/parties/${id}/room`, { room });
    } catch (e) {
      say(en.city.failed((e as Error).message), true);
    }
  },
};
