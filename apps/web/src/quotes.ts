import { create } from "zustand";

/** Live spot prices from the /api/quotes proxy (Binance RWA). Empty when offline or without an API key. */
interface QuoteFeed {
  quotes: Record<string, number>;
  live: boolean;
  at: number;
}
export const useQuotes = create<QuoteFeed>(() => ({
  quotes: {},
  live: false,
  at: 0,
}));

export async function fetchQuotes(): Promise<Record<string, number>> {
  try {
    const r = await fetch("/api/quotes");
    const j = (await r.json()) as { quotes?: Record<string, number> };
    const quotes = j.quotes ?? {};
    useQuotes.setState({
      quotes,
      live: Object.keys(quotes).length > 0,
      at: Date.now(),
    });
    return quotes;
  } catch {
    // Static hosting without the proxy, or offline: the game runs on its own numbers.
    return useQuotes.getState().quotes;
  }
}
