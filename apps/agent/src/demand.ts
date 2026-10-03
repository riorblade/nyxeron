/** One warehouse row of GET /api/agent/demand (services/api/supply.go). */
export type SupplyRow = {
  token: string;
  ticker: string;
  onHand: number;
  inShops: number;
  sold24h: number;
  sold7d: number;
  shops: number;
  /** At the last 7 days' pace; -1: no demand yet. */
  daysLeft: number;
  suggested: number;
};

export type Supply = { tokens: SupplyRow[]; coverDays: number; at: number };

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
