/** The back office talks to the same api as the game (/api/admin/*); the server checks the role on every call. */
let token: () => Promise<string | null> = async () => null;
export const setToken = (fn: typeof token) => (token = fn);

export class ApiError extends Error {}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(data.error ?? String(r.status));
  return data as T;
}

export type Role = "owner" | "admin" | "viewer";

export interface UserRow {
  id: string;
  email: string;
  walletAddress: string;
  name: string;
  avatar: number;
  coin: number;
  nights: number;
  gigs: number;
  unlockLevel: number;
  banned: boolean;
  createdAt: number;
  lastSeen: number;
}

export interface UserDetail {
  user: UserRow;
  profile: {
    portfolio: Record<string, { qty: number; cost: number }>;
    totalPnl: number;
    bestPnl: number;
    banReason?: string;
  };
  saves: {
    slot: string;
    updatedAt: number;
    meta: {
      day?: number;
      level?: number;
      clubName?: string;
      coin?: number;
      outcome?: string;
    };
  }[];
  ledger: {
    delta: number;
    balance: number;
    kind: string;
    actor: string;
    reason: string;
    at: number;
  }[];
  audit: AuditRow[];
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  reason: string;
  at: number;
}

export interface Stats {
  users: number;
  new24h: number;
  new7d: number;
  active24h: number;
  banned: number;
  coin: number;
  nights: number;
  gigs: number;
  saves: number;
  live: { rooms: number; conns: number } | null;
  quotes: { source: string; tickers: number };
  rent: { total: number; week: number; leases: number };
  lastBackup: number;
  dbBytes: number;
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
export const when = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleString() : "—";

export interface Lease {
  id: number;
  club: string;
  owner: string;
  ownerId: string;
  email: string;
  since: number;
  endsAt: number;
  open: boolean;
  stock: { token: string; qty: number; price: number }[];
}

export interface CityView {
  venues: { level: number; slot: number; lease: Lease | null }[];
  parties: {
    id: number;
    leaseId: number;
    level: number;
    club: string;
    owner: string;
    title: string;
    startsAt: number;
    minutes: number;
    room: string;
    live: boolean;
  }[];
  rent: Record<string, number>;
  counts: Record<string, number>;
  now: number;
}

export interface Supply {
  tokens: {
    token: string;
    ticker: string;
    onHand: number;
    /** Held for parties in progress. */
    reserved: number;
    inShops: number;
    sold24h: number;
    sold7d: number;
    shops: number;
    daysLeft: number;
    suggested: number;
  }[];
  moves: {
    id: number;
    token: string;
    delta: number;
    kind: string;
    userId?: string;
    actor: string;
    reason: string;
    tx?: string;
    at: number;
  }[];
  coverDays: number;
}

export interface Reconciliation {
  at: number;
  ok: boolean;
  verdict: string;
  owedCents: number;
  walletCents: number;
  platformCents: number;
  units: Record<string, { counted: number; onChain: number }>;
  problems: string[];
}

export interface Payments {
  /** Why payments are paused (the last reconciliation's problems), or null while they run. */
  paused: string[] | null;
  reconciliations: Reconciliation[];
  topups: {
    tx: string;
    logIndex: number;
    token: string;
    usdCents: number;
    fee: number;
    credits: number;
    status: "pending" | "credited" | "unknown" | "rejected";
    at: number;
    userId: string;
    email?: string;
    sender: string;
  }[];
  sales: {
    id: number;
    token: string;
    qty: number;
    price: number;
    wholesale: number;
    status: "held" | "settled" | "void";
    partyId?: number;
    leaseId?: number;
    buyer: string;
    seller: string;
    createdAt: number;
    settledAt?: number;
  }[];
}
