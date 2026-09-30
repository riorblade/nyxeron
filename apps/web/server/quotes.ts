import { createHmac } from "node:crypto";

/**
 * Server-side proxy for Binance Web3 RWA prices (tokenized stocks on BNB Chain). The API needs an HMAC-signed key,
 * so the secret stays here and the browser only ever sees GET /api/quotes → { quotes: { TSLA: 412.3, … } }.
 * Docs: https://web3.binance.com/en/dev-docs/authentication and …/rest-api/rwa-data
 */
const BASE = "https://web3.binance.com";
const BSC = "56";
const TTL_MS = 60_000;

export interface QuotesResponse {
  quotes: Record<string, number>;
  source: "binance" | "none";
  at: number;
  error?: string;
}

let cache: QuotesResponse | null = null;

/** preHash = ISO timestamp + METHOD + /build/path?query + body; X-OC-SIGN = base64(HMAC-SHA256(preHash, secret)). */
export function sign(
  secret: string,
  ts: string,
  method: string,
  path: string,
  body = "",
) {
  return createHmac("sha256", secret)
    .update(ts + method.toUpperCase() + path + body)
    .digest("base64");
}

async function signedGet(key: string, secret: string, path: string) {
  const ts = new Date().toISOString();
  const res = await fetch(BASE + path, {
    headers: {
      "X-OC-APIKEY": key,
      "X-OC-TIMESTAMP": ts,
      "X-OC-SIGN": sign(secret, ts, "GET", path),
    },
  });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json() as Promise<unknown>;
}

/** The token list may come as data[], data.list[] or data.tokens[]: take the first array found. */
function rows(json: unknown): Record<string, unknown>[] {
  const d = (json as { data?: unknown })?.data ?? json;
  if (Array.isArray(d)) return d;
  for (const v of Object.values((d as object) ?? {}))
    if (Array.isArray(v)) return v;
  return [];
}

/**
 * One price per underlying ticker (the game only uses ratios over time, so any consistent price works).
 * Prefers the underlying's reference price, falls back to the token price. Sorted by platform so the result is
 * stable when a ticker has several issuers (later wins: ondo over bstock).
 */
export function toQuotes(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const list = rows(json).sort((a, b) =>
    String(a.platformId).localeCompare(String(b.platformId)),
  );
  for (const r of list) {
    const ticker = String(r.underlyingTicker ?? "").toUpperCase();
    const price = Number(r.referencePrice) || Number(r.tokenPrice);
    if (ticker && price > 0) out[ticker] = price;
  }
  return out;
}

export async function getQuotes(env: {
  key?: string;
  secret?: string;
}): Promise<QuotesResponse> {
  if (!env.key || !env.secret)
    return { quotes: {}, source: "none", at: Date.now(), error: "no API key" };
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const json = await signedGet(
      env.key,
      env.secret,
      `/build/api/v1/dex/market/rwa/tokens?binanceChainId=${BSC}`,
    );
    cache = { quotes: toQuotes(json), source: "binance", at: Date.now() };
    return cache;
  } catch (e) {
    // Serve the last good prices if there are any; the game falls back to its own numbers otherwise.
    return (
      cache ?? {
        quotes: {},
        source: "none",
        at: Date.now(),
        error: (e as Error).message,
      }
    );
  }
}
