import { payments } from "@nyxeron/core";
import { create } from "zustand";
import { useAccount } from "@/auth/account";

/**
 * Top-ups: the player sends USDC from their embedded wallet to the platform's Agentic Wallet, then reports only
 * the tx hash. The api reads the transfer on BNB Chain itself and mints Credit (real money, 1 = $0.01) once it is
 * final; until then POST /api/topups answers 202 and we ask again. The minimum and the caps (payments.json) are
 * checked here before anything is sent, and again by the api, which credits only up to the caps (the rest is
 * recorded for a refund).
 */
export interface Topup {
  tx: string;
  logIndex: number;
  token: string;
  usdCents: number;
  fee: number;
  credits: number;
  status: "pending" | "credited" | "unknown" | "rejected";
  /** What wasn't credited and why (over the caps, under the minimum). */
  reason?: string;
  at: number;
}

type Phase = "idle" | "sending" | "confirming" | "done" | "error";

/** What the player has topped up, in cents (the api's sums: last 24 h, all time). */
export interface Topped {
  day: number;
  total: number;
}

interface TopupStore {
  open: boolean;
  /** Null until the api answered. */
  credits: number | null;
  topped: Topped;
  list: Topup[];
  phase: Phase;
  /** An api error code or a wallet message, when phase is "error". */
  error: string;
  /** The last top-up's tx, while it is being confirmed and after. */
  tx: string;
  /** Cents sent but not credited yet: they count against the caps until the api has them. */
  pending: number;
}

export const useTopups = create<TopupStore>(() => ({
  open: false,
  credits: null,
  topped: { day: 0, total: 0 },
  list: [],
  phase: "idle",
  error: "",
  tx: "",
  pending: 0,
}));

const base = import.meta.env.VITE_API_BASE ?? "";
const POLL_MS = 5000;
const POLL_TRIES = 60; // ~5 minutes: 15 confirmations on BNB Chain take well under one

async function call(method: string, body?: unknown) {
  const token = await useAccount.getState().token?.();
  const r = await fetch(`${base}/api/topups`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await r.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
    credits?: number;
    topped?: Topped;
    topups?: Topup[];
  };
  return { code: r.status, json };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const topups = {
  open: () => {
    useTopups.setState({ open: true });
    void topups.load();
  },
  close: () =>
    useTopups.setState((s) => ({
      open: false,
      // A finished or failed attempt is cleared; one still confirming keeps going in the background.
      ...(s.phase === "done" || s.phase === "error"
        ? { phase: "idle" as const, error: "" }
        : {}),
    })),

  async load() {
    try {
      const { code, json } = await call("GET");
      if (code === 200) useTopups.setState(fromApi(json));
    } catch {
      /* offline: keep what we have */
    }
  },

  sending: (cents: number) =>
    useTopups.setState((s) => ({
      phase: "sending",
      error: "",
      tx: "",
      pending: s.pending + cents,
    })),
  /** Nothing left the wallet: its cents no longer count against the caps. */
  notSent: (cents: number, error: string) =>
    useTopups.setState((s) => ({
      phase: "error",
      error,
      pending: Math.max(0, s.pending - cents),
    })),

  /** Report a sent transfer and wait until the api has credited it. */
  async report(tx: string) {
    useTopups.setState({ phase: "confirming", error: "", tx });
    for (let i = 0; i < POLL_TRIES; i++) {
      try {
        const { code, json } = await call("POST", { tx });
        if (code === 200) {
          // The api's sums now include it (credited, in full or up to the caps, or rejected for a refund).
          useTopups.setState({
            ...fromApi(json),
            pending: 0,
            ...(json.status === "rejected"
              ? { phase: "error" as const, error: "rejected" }
              : { phase: "done" as const }),
          });
          return;
        }
        // 202: not final yet. 503: the chain couldn't be read just now. 429: asked too fast. 409 no_wallet: the
        // wallet isn't known to the api yet. All of them: ask again.
        const again =
          code === 202 ||
          code === 503 ||
          code === 429 ||
          (code === 409 && json.error === "no_wallet");
        if (!again) {
          useTopups.setState({
            phase: "error",
            error: json.error ?? String(code),
            pending: 0,
          });
          return;
        }
      } catch {
        /* network blip: ask again */
      }
      await wait(POLL_MS);
    }
    // Still not credited: the api's scanner picks it up within minutes anyway.
    useTopups.setState({ phase: "error", error: "slow" });
  },
};

const fromApi = (json: {
  credits?: number;
  topped?: Topped;
  topups?: Topup[];
}) => ({
  credits: json.credits ?? 0,
  topped: json.topped ?? { day: 0, total: 0 },
  list: json.topups ?? [],
});

/**
 * How much this player may still top up, in cents: payments.json's caps over 24 h and in total, less what was
 * sent but isn't credited yet (`pending`).
 */
export function topupRoom(topped: Topped, pending = 0) {
  return Math.max(
    0,
    Math.min(
      payments.topup.capUsdPerDay * 100 - topped.day,
      payments.topup.capUsdTotal * 100 - topped.total,
    ) - pending,
  );
}

/** The fee on a top-up of `cents` (rounded up, as the api does) and the Credit it gives. */
export function topupQuote(cents: number) {
  const fee = Math.ceil((cents * payments.topup.feePercent) / 100);
  return { fee, credits: (cents * payments.creditsPerUsd) / 100 - fee };
}
