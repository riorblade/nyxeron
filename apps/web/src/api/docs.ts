import { create } from "zustand";
import { useSets } from "@/dj/sets";
import { en } from "@/i18n/en";
import { saveKey } from "@/state/save";
import { syncHooks } from "@/state/scope";
import { useGame } from "@/state/store";
import { layoutKey } from "@/venue/furniture";
import { getShoutouts, setShoutouts } from "@/venue/shoutouts";
import { useAccount } from "@/auth/account";

/**
 * Everything else that belongs to the account follows it to any device: CEO career saves, planned DJ sets, venue
 * layouts and videotron messages (api: /api/docs). At sign-in the two sides are merged (saves: the newer one wins;
 * the rest: the server's copy wins, a device's copy goes up if the server has none); afterwards every change goes
 * up as it happens.
 */
const SAVE_SLOTS = ["auto", "1", "2", "3"];

/** Bumped when synced data changed what this device shows (screens re-read saves). */
export const useDocsSync = create<{ version: number }>(() => ({ version: 0 }));
const changed = () => useDocsSync.setState((s) => ({ version: s.version + 1 }));

async function api(method: string, path: string, body?: string) {
  const token = await useAccount.getState().token?.();
  return fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api/docs/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
}

const put = (path: string, json: string) =>
  api("PUT", path, json).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
  });

const warn = () => useGame.getState().notify(en.auth.syncFailed, true);
const savedAt = (raw: string | null) => {
  try {
    return raw
      ? Number((JSON.parse(raw) as { savedAt: number }).savedAt) || 0
      : 0;
  } catch {
    return 0;
  }
};
const local = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked: this session only */
  }
};

type Info = { slot: string; updatedAt: number; meta: { savedAt?: number } };
async function list(kind: string): Promise<Info[]> {
  const r = await api("GET", kind);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as Info[];
}
async function get(path: string): Promise<string | null> {
  const r = await api("GET", path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

let unsubscribeSets: (() => void) | null = null;
let setsTimer = 0;
let applyingSets = false;

/** Merge this device with the account, then send every later change up. Call after sign-in. */
export async function syncDocs() {
  if (!useAccount.getState().account) return;
  try {
    await Promise.all([
      syncSaves(),
      syncSets(),
      syncLayouts(),
      syncShoutouts(),
    ]);
    changed();
  } catch {
    warn();
  }
  syncHooks.save = (slot, raw) =>
    void (
      raw ? put(`saves/${slot}`, raw) : api("DELETE", `saves/${slot}`)
    ).catch(warn);
  syncHooks.layout = (name, json) =>
    void (
      json ? put(`layouts/${name}`, json) : api("DELETE", `layouts/${name}`)
    ).catch(warn);
  syncHooks.shoutouts = (json) => void put("shoutouts/main", json).catch(warn);
  unsubscribeSets?.();
  unsubscribeSets = useSets.subscribe(() => {
    if (applyingSets) return;
    // Editing a set fires on every keystroke: send once the player pauses.
    clearTimeout(setsTimer);
    setsTimer = window.setTimeout(
      () => void put("djsets/main", setsJson()).catch(warn),
      800,
    );
  });
}

async function syncSaves() {
  const remote = new Map(
    (await list("saves")).map((d) => [d.slot, d.meta.savedAt ?? 0]),
  );
  await Promise.all(
    SAVE_SLOTS.map(async (slot) => {
      const mine = local(saveKey(slot));
      const theirs = remote.get(slot) ?? 0;
      if (theirs > savedAt(mine)) {
        const raw = await get(`saves/${slot}`);
        if (raw) store(saveKey(slot), raw);
      } else if (mine && savedAt(mine) > theirs)
        await put(`saves/${slot}`, mine);
    }),
  );
}

const setsJson = () => {
  const { sets, tonight, bpmFix } = useSets.getState();
  return JSON.stringify({ sets, tonight, bpmFix });
};

async function syncSets() {
  const raw = await get("djsets/main");
  if (!raw) return put("djsets/main", setsJson());
  const d = JSON.parse(raw) as {
    sets: ReturnType<typeof useSets.getState>["sets"];
    tonight: string | null;
    bpmFix: Record<string, number>;
  };
  applyingSets = true;
  useSets.setState({
    sets: d.sets ?? [],
    tonight: d.tonight ?? null,
    bpmFix: d.bpmFix ?? {},
  });
  applyingSets = false;
}

async function syncLayouts() {
  const remote = await list("layouts");
  const have = new Set(remote.map((d) => d.slot));
  await Promise.all(
    remote.map(async (d) => {
      const raw = await get(`layouts/${d.slot}`);
      if (raw) store(layoutKey(d.slot), raw);
    }),
  );
  // Layouts arranged on this device that the account doesn't have yet: keys "<prefix><name>.v2".
  const prefix = layoutKey("\0").split("\0")[0]!;
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(prefix) || !k.endsWith(".v2")) continue;
    const name = k.slice(prefix.length, -".v2".length);
    if (!have.has(name) && /^[a-z0-9-]{1,32}$/.test(name))
      await put(`layouts/${name}`, local(k)!);
  }
}

async function syncShoutouts() {
  const raw = await get("shoutouts/main");
  if (raw) setShoutouts(JSON.parse(raw) as string[], true);
  else if (getShoutouts().length)
    await put("shoutouts/main", JSON.stringify(getShoutouts()));
}
