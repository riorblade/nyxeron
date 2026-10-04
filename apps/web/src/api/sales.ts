import type { TokenId } from "@nyxeron/core";
import { create } from "zustand";
import { useAccount } from "@/auth/account";
import { useTopups } from "./topups";

/**
 * Real stock at a city party (api: sales.go). The CEO sets a price per token in Credit before the party starts
 * (between the live wholesale price and maxMarkup × it); while it's on, a guest's purchase is a server call that
 * holds their Credit and reserves the units; the party settles when it ends.
 */
export interface PriceList {
  prices: Partial<Record<TokenId, number>>;
  /** What one unit costs the platform now, in Credit (the CEO's floor). */
  wholesale: Partial<Record<TokenId, number>>;
  maxMarkup: number;
}

interface SalesStore {
  /** The price list of the party this guest is at (by event id). */
  party: { id: number; list: PriceList } | null;
}
export const useSales = create<SalesStore>(() => ({ party: null }));

const base = import.meta.env.VITE_API_BASE ?? "";

async function call<T>(method: string, path: string, body?: unknown) {
  const token = await useAccount.getState().token?.();
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? String(r.status));
  return json;
}

export const sales = {
  prices: (event: number) => call<PriceList>("GET", `/events/prices/${event}`),

  /** The guest joined this party: its menu, if it sells real stock. */
  async enter(event: number) {
    try {
      const list = await sales.prices(event);
      useSales.setState({
        party: Object.keys(list.prices).length ? { id: event, list } : null,
      });
    } catch {
      useSales.setState({ party: null });
    }
  },
  leave: () => useSales.setState({ party: null }),

  setPrices: (event: number, prices: Partial<Record<TokenId, number>>) =>
    call<{ prices: PriceList["prices"] }>("PUT", `/events/${event}/prices`, {
      prices,
    }),

  /** Buy at the party's price (refused if it is above `maxPrice`, the one shown): the api holds the Credit and
   *  reserves the units. Returns the Credit left. */
  async buy(event: number, token: TokenId, qty: number, maxPrice: number) {
    const out = await call<{ credits: number }>(
      "POST",
      `/events/${event}/buy`,
      { token, qty, maxPrice },
    );
    useTopups.setState({ credits: out.credits });
    return out.credits;
  },
};

/** The prices a CEO sends: only the tokens they sell (blank or 0 = not on the menu). */
export const menuOf = (draft: Partial<Record<TokenId, number>>) =>
  Object.fromEntries(
    Object.entries(draft).filter(([, p]) => (p ?? 0) > 0),
  ) as Partial<Record<TokenId, number>>;

/** The CEO's allowed range for a token's price, in Credit. */
export function priceRange(list: PriceList, token: TokenId) {
  const w = list.wholesale[token] ?? 0;
  return { min: w, max: Math.floor(w * list.maxMarkup) };
}
