import type { TokenId } from "@nyxeron/core";
import { en } from "@/i18n/en";
import { useProfile, type Profile } from "@/profile";
import { useNet } from "@/net/session";
import { useGame } from "@/store";
import { useAccount } from "./account";

/**
 * The player's profile lives on the server (api: SQLite, keyed by the verified Privy id). The local store is a
 * cache: changes show at once, go to the server, and the server's answer (which applies the game rules to the
 * wallet) becomes the truth. Signed out / no auth configured (dev): local only, as before.
 */
type Holdings = Partial<Record<TokenId, { qty: number; cost: number }>>;
type ServerProfile = Pick<
  Profile,
  "name" | "avatar" | "wallet" | "nights" | "gigs" | "totalPnl" | "bestPnl"
> & {
  id: string;
  portfolio: Holdings;
  imported: boolean;
  unlockLevel: number;
  banned: boolean;
  banReason?: string;
};

export const online = () =>
  !!useAccount.getState().account && !!useAccount.getState().token;

export async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<ServerProfile> {
  const token = await useAccount.getState().token?.();
  const r = await fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok)
    throw new Error(
      ((await r.json().catch(() => ({}))) as { error?: string }).error ??
        String(r.status),
    );
  return (await r.json()) as ServerProfile;
}

/** The server's word replaces the cache. */
export function apply(p: ServerProfile) {
  useProfile.setState({
    name: p.name,
    avatar: p.avatar,
    wallet: p.wallet,
    portfolio: p.portfolio ?? {},
    nights: p.nights,
    gigs: p.gigs,
    totalPnl: p.totalPnl,
    bestPnl: p.bestPnl,
  });
  useAccount.setState({
    access: {
      unlockLevel: p.unlockLevel || 1,
      banned: p.banned,
      banReason: p.banReason ?? "",
    },
  });
}

/** A change the server refused (or couldn't take): reload its truth and say so. */
async function recover() {
  useGame.getState().notify(en.auth.syncFailed, true);
  try {
    apply(await call("GET", "/profile"));
  } catch {
    /* offline: keep the cache until the next sign-in */
  }
}

/**
 * After sign-in: load the player's server profile. A new server account takes this device's data once (the
 * server bounds it), so nobody loses what they played before accounts existed.
 */
export async function syncProfile() {
  if (!online()) return;
  try {
    let p = await call("GET", "/profile");
    const local = useProfile.getState();
    const hasLocal =
      local.nights > 0 ||
      local.gigs > 0 ||
      Object.keys(local.portfolio).length > 0 ||
      local.wallet !== p.wallet;
    if (!p.imported && hasLocal)
      p = await call("POST", "/profile/import", {
        name: local.name,
        avatar: local.avatar,
        wallet: Math.max(0, Math.round(local.wallet)),
        portfolio: local.portfolio,
        nights: local.nights,
        gigs: local.gigs,
        totalPnl: Math.round(local.totalPnl),
        bestPnl: Math.round(local.bestPnl),
      });
    // A brand-new account keeps the name picked from Google / the email.
    if (!p.name && local.name)
      p = await call("PATCH", "/profile", { name: local.name });
    apply(p);
  } catch {
    useGame.getState().notify(en.auth.syncFailed, true);
  }
}

let nameTimer = 0;

/** Every profile change goes through here: shown at once, confirmed (or corrected) by the server. */
export const player = {
  setName(name: string) {
    useProfile.getState().setName(name);
    if (!online()) return;
    // Typing: send once the player pauses.
    clearTimeout(nameTimer);
    nameTimer = window.setTimeout(() => {
      call("PATCH", "/profile", {
        name: useProfile.getState().name.trim(),
      }).catch(recover);
    }, 700);
  },
  setAvatar(avatar: number) {
    useProfile.getState().setAvatar(avatar);
    if (online()) call("PATCH", "/profile", { avatar }).then(apply, recover);
  },
  refill() {
    if (!online()) return useProfile.getState().refill();
    call("POST", "/wallet/refill").then(apply, recover);
  },
  /** Back from a night out as a guest: cash left and the tokens bought (the server checks they add up). */
  settle(cash: number, bought: Holdings, pnl: number) {
    useProfile.getState().settle(cash, bought, pnl);
    if (online())
      call("POST", "/nights", {
        cash: Math.round(cash),
        bought,
        pnl: Math.round(pnl),
        // A live party at a rented venue: the tenant is paid what this guest spent.
        room: useNet.getState().role === "guest" ? useNet.getState().room : "",
      }).then(apply, recover);
  },
  payGig(fee: number) {
    useProfile.getState().payGig(fee);
    if (online()) call("POST", "/gigs", { fee }).then(apply, recover);
  },
};
