/** One warehouse row of GET /api/agent/demand (services/api/supply.go). */
export type SupplyRow = {
  token: string;
  ticker: string;
  onHand: number;
  sold24h: number;
  sold7d: number;
  /** At the last 7 days' pace; -1: no demand yet. */
  daysLeft: number;
  suggested: number;
};

export type Supply = {
  tokens: SupplyRow[];
  coverDays: number;
  at: number;
  /** What the agent's restocks paid in the last 24 h, in cents. */
  agentSpentTodayCents?: number;
  /** A reconciliation mismatch stands: buy nothing until it clears. */
  paused?: boolean;
};

/** What the warehouse holds and what CEOs are buying. */
export async function fetchDemand(base: string, key: string): Promise<Supply> {
  const res = await fetch(`${base}/api/agent/demand`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`demand ${res.status} ${body.error ?? ""}`.trim());
  }
  return (await res.json()) as Supply;
}

/** What a verified restock added (POST /api/agent/restock). */
export type Restocked = {
  token: string;
  units: number;
  usdCents: number;
  tx: string;
};

/** The api answered no to a report. `retry`: worth asking again (5xx); a 4xx won't change by itself. */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

/**
 * Reports a swap to the api, which reads it on BSC and adds the units it bought. "pending": not final yet
 * (15 confirmations), report it again later. "counted": the api already counted this tx (409 tx_used). A network
 * error is thrown as is (worth retrying).
 */
export async function reportRestock(
  base: string,
  key: string,
  token: string,
  tx: string,
): Promise<Restocked | "pending" | "counted"> {
  const res = await fetch(`${base}/api/agent/restock`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, tx, note: "agent swap" }),
  });
  const body = (await res.json().catch(() => ({}))) as Restocked & {
    error?: string;
  };
  if (res.status === 202) return "pending";
  if (res.status === 409 && body.error === "tx_used") return "counted";
  if (!res.ok)
    throw new ReportError(
      `restock ${res.status} ${body.error ?? ""}`.trim(),
      res.status >= 500,
    );
  return body;
}

/** GET /api/quotes: spot USD prices per underlying ticker (services/api/quotes.go). */
export type Quotes = {
  quotes: Record<string, number>;
  source: string;
  at: number;
  error?: string;
};

export async function fetchQuotes(base: string): Promise<Quotes> {
  const res = await fetch(`${base}/api/quotes`);
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  return (await res.json()) as Quotes;
}
