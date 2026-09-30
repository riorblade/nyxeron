import {
  visitorBuy,
  visitorJoin,
  visitorLeave,
  visitorPnl,
  visitorValue,
  type Visitor,
  type ActionResult,
  type GameState,
  type TokenId,
} from "@nyxeron/core";
import { create } from "zustand";
import { en, reasonText } from "@/i18n/en";
import { useGame } from "@/store";
import { packState, unpackState } from "./codec";
import { acquireEngine, getEngine, releaseEngine } from "@/dj/session";
import type { DjAct } from "@/dj/engine";
import { applyMix, mixSnapshot, type MixSync } from "@/dj/mixsync";
import { KIND, pack, Relay, unpack, type Frame } from "./relay";

/**
 * Live multiplayer on top of the relay. The CEO's browser is the host: it runs the sim, applies players' input and
 * broadcasts gzipped snapshots. Guests render those snapshots and send what they want to do.
 *
 * Player → host: {t:"hello",name,avatar,cash} · {t:"buy",token,qty} · {t:"bye"}
 * DJ → host:     {t:"djhello",name,avatar} · {t:"mix",m} (4×/s) · {t:"act",a} (pads, brake, backspin)
 * Host → player: {t:"welcome",ok,reason?,short?} · {t:"result",ok,reason?,short?,token,qty,cost} · {t:"dj",…}
 * Host → all:    state frames (gzipped GameState); events {t:"dj",on,name,avatar} · {t:"mix",m} · {t:"act",a}
 *
 * A live DJ's music isn't streamed: every player's browser plays the same crate tracks and follows the DJ's mix
 * state (dj/mixsync.ts), so the relay carries a few hundred bytes a second.
 */
type Hello = { name: string; avatar: number; cash: number };
type DjHello = { name: string; avatar: number };
type Input =
  | ({ t: "hello" } & Hello)
  | { t: "buy"; token: TokenId; qty: number }
  | { t: "bye" }
  | ({ t: "djhello" } & DjHello)
  | { t: "mix"; m: MixSync }
  | { t: "act"; a: DjAct };
type Live =
  | { t: "dj"; on: boolean; name?: string; avatar?: number }
  | { t: "mix"; m: MixSync }
  | { t: "act"; a: DjAct };
type Reply =
  | Live
  | { t: "welcome"; ok: boolean; reason?: string; short?: number }
  | {
      t: "result";
      ok: boolean;
      reason?: string;
      short?: number;
      token: TokenId;
      qty: number;
      cost: number;
    };

export interface Player {
  id: number;
  name: string;
  role: string;
  /** In the club right now (joined tonight's night as a visitor). */
  inside: boolean;
}

interface Net {
  role: "off" | "host" | "guest" | "dj";
  /** The player DJ live in this club (everyone knows, for the booth and the videotron). */
  dj: DjHello | null;
  room: string;
  status: "connecting" | "live" | "host-away" | "closed" | "error";
  error: string;
  /** Host: who is connected. */
  players: Record<number, Player>;
  /** Guest: the host's latest snapshot, and my player id in it. */
  remote: GameState | null;
  me: string;
  /** Guest: the host said no to my hello (e.g. can't afford the door); shown until the next try. */
  refused: string;
  /** Guest: me in the club at the last snapshot I was inside (for the night summary after the host moves on). */
  last: { v: Visitor; value: number; pnl: number } | null;
  /** Guest: I was inside and the host's night has ended. */
  ended: boolean;
}

export const useNet = create<Net>(() => ({
  role: "off",
  dj: null,
  room: "",
  status: "connecting",
  error: "",
  players: {},
  remote: null,
  me: "",
  refused: "",
  last: null,
  ended: false,
}));

const set = useNet.setState;
let relay: Relay | null = null;

/** A reason code from the host, as a sentence. */
const why = (reason?: string, short?: number) => {
  if (!reason) return "";
  if (reason === "dj_taken") return en.live.djTaken;
  try {
    return reasonText(reason as Parameters<typeof reasonText>[0], short);
  } catch {
    return reason;
  }
};

// ---------------- following a live DJ (host and guests) ----------------

let following = false;

/** Play along with the DJ's mix on this browser's own engine (it takes the room from the club's music). */
function follow(m: Live) {
  if (m.t === "dj") {
    set({ dj: m.on ? { name: m.name ?? "DJ", avatar: m.avatar ?? 1 } : null });
    if (!m.on) unfollow();
    return;
  }
  if (!following) {
    following = true;
    acquireEngine();
  }
  const e = getEngine();
  if (!e.ready) return;
  if (m.t === "mix") void applyMix(e, m.m);
  else if (m.a.t === "pad") e.pad(m.a.id);
  else if (m.a.t === "brake") (m.a.deck === "a" ? e.a : e.b).brake();
  else (m.a.deck === "a" ? e.a : e.b).backspin();
}

function unfollow() {
  if (!following) return;
  following = false;
  releaseEngine();
}

// ---------------- host (the CEO) ----------------

/** The player DJ's relay id (one DJ at a time). */
let djPeer = 0;

const hellos = new Map<number, Hello>();
let unsubscribe: (() => void) | null = null;
let timer = 0;
let lastSent = 0;
/** Snapshots at most every 250 ms (the sim ticks 1–3×/s; actions in between are coalesced). */
const MIN_GAP = 250;

function broadcastSoon() {
  if (timer) return;
  const wait = Math.max(0, MIN_GAP - (Date.now() - lastSent));
  timer = window.setTimeout(async () => {
    timer = 0;
    const g = useGame.getState().game;
    if (!relay || !g) return;
    lastSent = Date.now();
    relay.state(await packState(g));
  }, wait);
}

/** Apply a player's action to the club; the next snapshot shows everyone the result. */
function act(fn: (g: GameState) => ActionResult): ActionResult | null {
  const { game, set: setGame } = useGame.getState();
  if (!game) return null;
  const r = fn(game);
  if (r.ok) setGame(r.state);
  return r;
}

function reply(peer: number, m: Reply) {
  relay?.to(peer, pack(m));
}

/** Let in players who said hello (at night; by day they wait for the doors). */
function admitWaiting() {
  const g = useGame.getState().game;
  if (!g || g.phase !== "night") return;
  for (const [peer, h] of hellos) {
    if (g.night?.visitors?.[String(peer)]) continue;
    const r = act((s) =>
      visitorJoin(s, String(peer), h.name, h.cash, h.avatar),
    );
    if (!r) continue;
    hellos.delete(peer);
    reply(
      peer,
      r.ok
        ? { t: "welcome", ok: true }
        : { t: "welcome", ok: false, reason: r.reason, short: r.short },
    );
    markInside(peer, r.ok);
  }
}

function markInside(peer: number, inside: boolean) {
  const p = useNet.getState().players[peer];
  if (p)
    set({
      players: { ...useNet.getState().players, [peer]: { ...p, inside } },
    });
}

function onHostFrame(f: Frame) {
  if (f.kind !== KIND.from) return;
  let m: Input;
  try {
    m = unpack<Input>(f.payload);
  } catch {
    return;
  }
  const id = String(f.peer);
  if (m.t === "hello") {
    const cash = Number(m.cash);
    hellos.set(f.peer, {
      name: String(m.name ?? "").slice(0, 24) || "Guest",
      avatar: Number(m.avatar) || 1,
      // ponytail: the wallet is the player's word for now (play money); validate server-side before real funds.
      cash: Number.isFinite(cash) && cash >= 0 ? Math.min(cash, 1e9) : 0,
    });
    admitWaiting();
  } else if (m.t === "buy") {
    const qty = Math.floor(Number(m.qty));
    const g = useGame.getState().game;
    const before = g?.night?.visitors?.[id]?.cash ?? 0;
    const r = act((s) => visitorBuy(s, id, m.token, qty));
    const after =
      useGame.getState().game?.night?.visitors?.[id]?.cash ?? before;
    reply(f.peer, {
      t: "result",
      ok: !!r?.ok,
      reason: r && !r.ok ? r.reason : undefined,
      short: r && !r.ok ? r.short : undefined,
      token: m.token,
      qty,
      cost: before - after,
    });
  } else if (m.t === "djhello") {
    if (djPeer && djPeer !== f.peer) {
      reply(f.peer, { t: "welcome", ok: false, reason: "dj_taken" });
      return;
    }
    djPeer = f.peer;
    const dj: Live = {
      t: "dj",
      on: true,
      name: String(m.name ?? "").slice(0, 24) || "DJ",
      avatar: Number(m.avatar) || 1,
    };
    relay?.event(pack(dj));
    follow(dj);
    reply(f.peer, { t: "welcome", ok: true });
    markInside(f.peer, true);
  } else if ((m.t === "mix" || m.t === "act") && f.peer === djPeer) {
    // Pass the DJ's mix to every player and play along here.
    relay?.event(pack(m));
    follow(m);
    return;
  } else if (m.t === "bye") {
    hellos.delete(f.peer);
    const g = useGame.getState().game;
    if (g) useGame.getState().set(visitorLeave(g, id));
    markInside(f.peer, false);
  }
  broadcastSoon();
}

/** The CEO opens tonight's club to other players. Resolves to the room code. */
export async function hostOpen(clubName: string) {
  if (relay) return useNet.getState().room;
  relay = new Relay();
  set({ role: "host", status: "connecting", error: "", players: {} });
  relay.onStatus = (on) => set({ status: on ? "live" : "connecting" });
  relay.onFrame = onHostFrame;
  relay.onControl = (c) => {
    if (c.t !== "peer" || c.id == null) return;
    const players = { ...useNet.getState().players };
    if (c.on) {
      players[c.id] = {
        id: c.id,
        name: c.name ?? "",
        role: c.role ?? "guest",
        inside: false,
      };
      broadcastSoon(); // the newcomer needs a first snapshot
      const dj = useNet.getState().dj;
      if (dj) relay?.to(c.id, pack({ t: "dj", on: true, ...dj }));
    } else {
      if (c.id === djPeer) {
        djPeer = 0;
        relay?.event(pack({ t: "dj", on: false }));
        follow({ t: "dj", on: false });
      }
      delete players[c.id];
      hellos.delete(c.id);
      const g = useGame.getState().game;
      if (g) useGame.getState().set(visitorLeave(g, String(c.id)));
    }
    set({ players });
  };
  try {
    const room = await relay.host(clubName);
    set({ room, status: "live" });
    unsubscribe = useGame.subscribe((st, prev) => {
      if (st.game === prev.game) return;
      if (st.game?.phase === "night" && prev.game?.phase !== "night")
        admitWaiting();
      broadcastSoon();
    });
    broadcastSoon();
    return room;
  } catch (e) {
    set({ status: "error", error: (e as Error).message });
    hostClose();
    throw e;
  }
}

export function hostClose() {
  unsubscribe?.();
  unsubscribe = null;
  clearTimeout(timer);
  timer = 0;
  hellos.clear();
  relay?.close();
  relay = null;
  djPeer = 0;
  unfollow();
  set({ role: "off", room: "", players: {}, status: "closed", dj: null });
}

export const kick = (id: number) => relay?.kick(id);

// ---------------- guest ----------------

/** Join a CEO's live club with a room code: as a guest (bringing the wallet) or as its DJ. */
export async function guestJoin(
  code: string,
  hello: Hello,
  as: "guest" | "dj" = "guest",
) {
  guestLeave();
  relay = new Relay();
  set({
    role: as,
    room: code,
    status: "connecting",
    error: "",
    remote: null,
    refused: "",
    last: null,
    ended: false,
  });
  relay.onStatus = (on) => {
    if (useNet.getState().status !== "closed")
      set({ status: on ? "live" : "connecting" });
  };
  relay.onControl = (c) => {
    if (c.t === "host") set({ status: c.on ? "live" : "host-away" });
    if (c.t === "closed") set({ status: "closed" });
  };
  relay.onFrame = async (f) => {
    if (f.kind === KIND.state) {
      try {
        const remote = await unpackState(f.payload);
        const { me, last } = useNet.getState();
        const v = remote.night?.visitors?.[me];
        set({
          remote,
          last: v
            ? {
                v,
                value: visitorValue(remote, me),
                pnl: visitorPnl(remote, me),
              }
            : last,
          ended: !!last && !v && remote.phase !== "night",
        });
      } catch {
        /* a corrupt snapshot: wait for the next */
      }
      return;
    }
    const m = unpack<Reply>(f.payload);
    if (m.t === "dj" || m.t === "mix" || m.t === "act") {
      // The DJ doesn't follow their own mix.
      if (useNet.getState().role === "guest" || m.t === "dj") follow(m);
      return;
    }
    if (m.t === "welcome") set({ refused: m.ok ? "" : why(m.reason, m.short) });
    if (m.t === "result")
      useGame
        .getState()
        .notify(
          m.ok ? `+${m.qty} ${m.token.toUpperCase()}` : why(m.reason, m.short),
          !m.ok,
        );
  };
  try {
    const id = await relay.join(code.trim().toUpperCase(), hello.name, as);
    set({ me: String(id), status: "live" });
    relay.input(
      pack(
        as === "dj"
          ? { t: "djhello", name: hello.name, avatar: hello.avatar }
          : { t: "hello", ...hello },
      ),
    );
  } catch (e) {
    set({ status: "error", error: (e as Error).message });
    relay?.close();
    relay = null;
    throw e;
  }
}

export function guestBuy(token: TokenId, qty: number) {
  relay?.input(pack({ t: "buy", token, qty }));
}

export function guestLeave() {
  const { role } = useNet.getState();
  if (role !== "guest" && role !== "dj") return;
  relay?.input(pack({ t: "bye" }));
  relay?.close();
  relay = null;
  unfollow();
  stopMixing();
  set({
    role: "off",
    room: "",
    remote: null,
    me: "",
    status: "closed",
    dj: null,
  });
}

// ---------------- the live DJ ----------------

let mixTimer = 0;

/**
 * The DJ's decks go live: the mix state 4× a second, one-shot moves as they happen. The studio's engine must be
 * open (the DJ screen holds it).
 */
export function startMixing() {
  stopMixing();
  const e = getEngine();
  e.onAct = (a) => relay?.input(pack({ t: "act", a }));
  mixTimer = window.setInterval(() => {
    if (e.ready) relay?.input(pack({ t: "mix", m: mixSnapshot(e) }));
  }, 250);
}

export function stopMixing() {
  clearInterval(mixTimer);
  mixTimer = 0;
  getEngine().onAct = undefined;
}

// Dev-only handle for automated browser checks; stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined")
  (window as unknown as { __net: typeof useNet }).__net = useNet;
