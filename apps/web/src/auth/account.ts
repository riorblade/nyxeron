import { create } from "zustand";
import { useSets } from "@/dj/sets";
import { useProfile } from "@/profile";
import { setSaveScope } from "@/save";

/**
 * The signed-in player (Privy: email or Google, plus an embedded wallet on BNB Chain). Each player's profile,
 * saves and DJ sets live under their own storage key, so two people on one browser never see each other's data.
 */
export interface Account {
  /** Privy user id (DID), the server-verifiable identity. */
  id: string;
  email: string;
  /** Embedded EVM wallet (created at first sign-in; may arrive a moment later). */
  wallet: string;
  /** Display name from Google, if any. */
  name: string;
}

interface AccountStore {
  account: Account | null;
  /** The game API's check of this sign-in (GET /api/me): "ok" when it matches, else why not. */
  server: "checking" | "ok" | "mismatch" | "failed" | null;
  /** Set by the auth shell: Privy's logout. */
  logout: (() => Promise<void>) | null;
  /** Fresh Privy access token for our API (Authorization: Bearer). */
  token: (() => Promise<string | null>) | null;
}

export const useAccount = create<AccountStore>(() => ({
  account: null,
  server: null,
  logout: null,
  token: null,
}));

/** Storage-safe part of a Privy DID ("did:privy:abc" → "abc"). */
export const scopeOf = (id: string) =>
  id
    .split(":")
    .pop()!
    .replace(/[^\w-]/g, "");

const CLAIMED = "nyxeron:legacy-claimed";
const LEGACY = ["nyxeron:profile", "nyxeron:dj-sets"];

/**
 * Data saved on this device before sign-in existed goes to the first player who signs in here (once), so
 * nobody loses their club; later players start fresh.
 */
function claimLegacy(scope: string) {
  try {
    if (localStorage.getItem(CLAIMED)) return;
    for (const k of Object.keys(localStorage)) {
      const base = LEGACY.includes(k) || k.startsWith("nyxeron:save:");
      if (!base) continue;
      const to = k.replace(/^nyxeron:/, `nyxeron:u:${scope}:`);
      if (localStorage.getItem(to) == null)
        localStorage.setItem(to, localStorage.getItem(k)!);
      localStorage.removeItem(k);
    }
    localStorage.setItem(CLAIMED, scope);
  } catch {
    /* storage blocked: nothing to move */
  }
}

/** Point a persisted store at this player's key, loading their data or starting from defaults. */
async function rescope<S>(
  store: {
    persist: {
      setOptions(o: { name: string }): void;
      rehydrate(): Promise<void> | void;
    };
    setState(s: S, replace: true): void;
    getInitialState(): S;
  },
  name: string,
) {
  store.persist.setOptions({ name });
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(name);
  } catch {
    /* blocked */
  }
  // Reset first: never let the previous player's state carry over into this one's key.
  if (saved == null) store.setState(store.getInitialState(), true);
  else await store.persist.rehydrate();
}

/** Switch every per-player store to this account. */
export async function signedIn(a: Account) {
  const scope = scopeOf(a.id);
  claimLegacy(scope);
  setSaveScope(scope);
  await rescope(useProfile, `nyxeron:u:${scope}:profile`);
  await rescope(useSets, `nyxeron:u:${scope}:dj-sets`);
  // First visit: the name from Google (or the email), until the player picks one.
  if (!useProfile.getState().name)
    useProfile.getState().setName(a.name || a.email.split("@")[0] || "");
  useAccount.setState({ account: a });
  void checkServer();
}

/**
 * Ask the game API who we are: it verifies the Privy token itself and reads email + wallet from Privy. Rewards
 * and anything on-chain will trust only this, never what the browser says.
 */
export async function checkServer() {
  const { token, account } = useAccount.getState();
  if (!token || !account) return;
  useAccount.setState({ server: "checking" });
  try {
    const t = await token();
    const r = await fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api/me`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!r.ok) return useAccount.setState({ server: "failed" });
    const me = (await r.json()) as {
      id: string;
      email: string;
      wallet: string;
    };
    const same =
      me.id === account.id &&
      me.email.toLowerCase() === account.email.toLowerCase() &&
      (!account.wallet ||
        me.wallet.toLowerCase() === account.wallet.toLowerCase());
    useAccount.setState({ server: same ? "ok" : "mismatch" });
  } catch {
    useAccount.setState({ server: "failed" });
  }
}
