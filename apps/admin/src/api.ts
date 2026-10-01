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
  lastBackup: number;
  dbBytes: number;
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
export const when = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleString() : "—";
