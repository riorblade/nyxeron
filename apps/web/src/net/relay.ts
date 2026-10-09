/**
 * Browser client for the multiplayer relay (services/relay). The relay only connects players: a host (the CEO's
 * browser, which runs the sim) and peers (guests, DJs). Game data travels as opaque binary frames:
 * [kind u8][peer u16 BE][payload]. See services/relay/protocol.go for the full protocol.
 */
export const KIND = { state: 1, event: 2, to: 3, from: 4 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];
export type Role = "guest" | "dj";

export interface Control {
  t: string;
  room?: string;
  token?: string;
  name?: string;
  role?: Role;
  id?: number;
  on?: boolean;
  code?: string;
}

export interface Frame {
  kind: Kind;
  /** For `to`: the target; for `from`: the sender (stamped by the relay). */
  peer: number;
  payload: Uint8Array;
}

export function encodeFrame(kind: Kind, peer: number, payload: Uint8Array) {
  const b = new Uint8Array(3 + payload.length);
  b[0] = kind;
  b[1] = peer >> 8;
  b[2] = peer & 0xff;
  b.set(payload, 3);
  return b;
}

export function decodeFrame(buf: ArrayBuffer): Frame | null {
  const b = new Uint8Array(buf);
  if (b.length < 3) return null;
  return {
    kind: b[0] as Kind,
    peer: (b[1]! << 8) | b[2]!,
    payload: b.subarray(3),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
/** JSON in/out of a frame payload. */
export const pack = (v: unknown) => enc.encode(JSON.stringify(v));
export const unpack = <T>(p: Uint8Array): T => JSON.parse(dec.decode(p)) as T;

/**
 * Production: VITE_RELAY_URL (the frontend is on a CDN, the relay on the backend host). Dev: same origin, where
 * Vite proxies /ws to the local relay.
 */
export const relayUrl = () =>
  import.meta.env.VITE_RELAY_URL ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const TOKEN_KEY = "nyxeron:relay-host";

/** Errors that mean "not right now": on a reconnect the client backs off and tries again. */
const retryable = new Set([
  "room_full",
  "server_full",
  "rate_limited",
  "too_many_connections",
]);

/**
 * One connection to the relay. `host()` opens a room (and resumes it after a drop, within the relay's grace
 * period); `join()` enters one. Reconnects with backoff while `open`.
 */
export class Relay {
  onControl?: (m: Control) => void;
  onFrame?: (f: Frame) => void;
  onStatus?: (connected: boolean) => void;
  room = "";
  id = 0;
  private ws: WebSocket | null = null;
  private open = true;
  private retry = 0;
  private openedAt = 0;
  /** A (re)connect's hello is out and unanswered: only then is "not right now" a reason to hang up and retry. */
  private helloOut = false;
  private hello: Control | null = null;
  private waiting: {
    ok: (m: Control) => void;
    fail: (e: Error) => void;
    want: string;
  } | null = null;

  constructor(private url = relayUrl()) {}

  /** Open a room as its host. */
  host(name: string) {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    return this.hello_(
      saved
        ? { t: "resume", name, ...JSON.parse(saved) }
        : { t: "create", name },
      "created",
    ).then((m) => m.room!);
  }

  /** Join a room as a guest or DJ. */
  join(room: string, name: string, role: Role) {
    return this.hello_({ t: "join", room, name, role }, "joined").then((m) => {
      this.id = m.id ?? 0;
      return this.id;
    });
  }

  /** Host: the latest snapshot for everyone (a slow player skips stale ones). */
  state(payload: Uint8Array) {
    this.send(encodeFrame(KIND.state, 0, payload));
  }
  /** Host: a message everyone must get, in order. */
  event(payload: Uint8Array) {
    this.send(encodeFrame(KIND.event, 0, payload));
  }
  /** Host: a message for one player. */
  to(peer: number, payload: Uint8Array) {
    this.send(encodeFrame(KIND.to, peer, payload));
  }
  /** Player: input for the host (the relay stamps who sent it). */
  input(payload: Uint8Array) {
    this.send(encodeFrame(KIND.from, 0, payload));
  }
  kick(id: number) {
    this.sendControl({ t: "kick", id });
  }

  close() {
    this.open = false;
    // Host: the room closes now (its players are told) instead of waiting out the grace period.
    if (this.hello?.t === "resume") this.sendControl({ t: "close" });
    sessionStorage.removeItem(TOKEN_KEY);
    this.ws?.close();
  }

  private send(b: Uint8Array<ArrayBuffer>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(b);
  }
  private sendControl(m: Control) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Send the hello (create/resume/join) and wait for its answer; it is re-sent on every reconnect. */
  private hello_(m: Control, want: string) {
    this.hello = m;
    return new Promise<Control>((ok, fail) => {
      this.waiting = { ok, fail, want };
      if (this.ws?.readyState === WebSocket.OPEN) this.sendControl(m);
      else this.connect();
    });
  }

  private connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.onStatus?.(true);
      if (this.hello) {
        this.helloOut = true;
        this.sendControl(this.hello);
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const f = decodeFrame(e.data as ArrayBuffer);
        if (f) this.onFrame?.(f);
        return;
      }
      const m = JSON.parse(e.data) as Control;
      // The room expired while the host was away (also on a reconnect): start a fresh room instead.
      if (
        m.t === "error" &&
        m.code === "room_not_found" &&
        this.hello?.t === "resume"
      ) {
        sessionStorage.removeItem(TOKEN_KEY);
        this.hello = { t: "create", name: this.hello.name ?? "" };
        this.helloOut = true;
        return this.sendControl(this.hello);
      }
      // Every (re)connect is answered: a reconnecting player gets a new id, a host maybe a new room.
      if (m.t === "joined") this.id = m.id ?? this.id;
      if (m.t === "created") {
        const { room, token } = m;
        this.hello = { t: "resume", name: this.hello?.name, room, token };
        sessionStorage.setItem(
          TOKEN_KEY,
          JSON.stringify({ room: m.room, token: m.token }),
        );
      }
      this.room = m.room ?? this.room;
      const answer =
        this.helloOut &&
        (m.t === "error" || m.t === "joined" || m.t === "created");
      if (answer) this.helloOut = false;
      const w = this.waiting;
      if (w && (m.t === w.want || m.t === "error")) {
        this.waiting = null;
        return m.t === "error" ? w.fail(new Error(m.code)) : w.ok(m);
      }
      // Turned away for now (full, busy, throttled) while reconnecting: hang up and try again after the backoff.
      // In a room, "rate_limited" only means slow down (the relay throttles messages too): stay.
      if (answer && m.t === "error" && m.code && retryable.has(m.code))
        return ws.close();
      // Closed or kicked: don't walk straight back in.
      if (
        m.t === "closed" ||
        m.t === "kicked" ||
        (m.t === "error" &&
          (m.code === "room_not_found" ||
            m.code === "kicked" ||
            m.code === "replaced"))
      )
        this.open = false;
      this.onControl?.(m);
    };
    ws.onclose = (e?: { reason?: string }) => {
      this.onStatus?.(false);
      // Another tab took over this room (same saved token): stand down instead of taking it back forever.
      if (e?.reason === "replaced" && this.open) {
        this.open = false;
        this.onControl?.({ t: "error", code: "replaced" });
      }
      if (!this.open) return;
      // Only a connection that held for a while resets the backoff (accept-then-drop must not spin at 2 Hz).
      if (Date.now() - this.openedAt > 10_000) this.retry = 0;
      // Backoff 0.5 s → 8 s with equal jitter, so a relay restart isn't hit by every player at the same instant.
      // The host's hello is a resume, a player's a fresh join.
      const base = Math.min(8000, 500 * 2 ** this.retry++);
      const wait = base / 2 + (Math.random() * base) / 2;
      setTimeout(() => this.open && this.connect(), wait);
    };
  }
}
