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

/**
 * Reports a swap to the api, which reads it on BSC and adds the units it bought. "pending": not final yet
 * (15 confirmations), report it again later.
 */
export async function reportRestock(
  base: string,
  key: string,
  token: string,
  tx: string,
): Promise<Restocked | "pending"> {
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
  if (!res.ok)
    throw new Error(`restock ${res.status} ${body.error ?? ""}`.trim());
  return body;
}
