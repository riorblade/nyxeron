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
  /** The api's pass (POST /api/relay/ticket) on create/join/resume. */
  ticket?: string;
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

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((ok, no) => {
    const id = setTimeout(() => no(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(id), ok(v)),
      (e: unknown) => (clearTimeout(id), no(e)),
    );
  });

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

  /** Set after the relay refused a ticket: the next connect asks the api for a new one. */
  private freshTicket = false;
  /** The ticket this socket's hellos carry, and whether it was fetched fresh (refused again → give up). */
  private helloTicket = "";
  private sentFresh = false;
  private dialing = false;
  /** Ticket fetches in a row that failed (api away); a join/open still waiting gives up after 3. */
  private ticketFails = 0;

  /**
   * `ticket`: the api's pass for the relay (signed in, not banned); asked for on every (re)connect, `fresh` after
   * the relay refused the last one. Without it (dev, tests) hellos go out bare.
   */
  constructor(
    private url = relayUrl(),
    private ticket?: (fresh: boolean) => Promise<string>,
  ) {}

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

  /** The hello (create/resume/join), with this socket's ticket if there is one. */
  private sayHello() {
    if (!this.hello) return;
    this.helloOut = true;
    const t = this.helloTicket;
    this.sendControl(t ? { ...this.hello, ticket: t } : this.hello);
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
      if (this.ws?.readyState === WebSocket.OPEN) this.sayHello();
      else this.connect();
    });
  }

  private connect() {
    if (this.dialing || (this.ws && this.ws.readyState <= WebSocket.OPEN))
      return;
    if (!this.ticket) return this.dial();
    // The ticket first, then the socket: the relay's 10 s hello deadline only starts once we can talk.
    // "" = definitely none (signed out); a throw or no answer in 5 s = the api is away: try again later.
    this.dialing = true;
    this.sentFresh = this.freshTicket;
    this.freshTicket = false;
    const get = this.ticket;
    void withTimeout(
      Promise.resolve().then(() => get(this.sentFresh)),
      5000,
    ).then(
      (t) => {
        this.dialing = false;
        this.ticketFails = 0;
        this.helloTicket = t;
        if (this.open) this.dial();
      },
      () => {
        this.dialing = false;
        this.freshTicket = this.sentFresh;
        const w = this.waiting;
        // Nobody in a room yet (the Join form, "Opening…"): don't keep them waiting on an api that isn't there.
        if (w && ++this.ticketFails >= 3) {
          this.waiting = null;
          this.open = false;
          return w.fail(new Error("offline"));
        }
        if (this.open) this.later();
      },
    );
  }

  /** Try again after the backoff: 0.5 s → 8 s with equal jitter, so a restart isn't hit by every player at once. */
  private later() {
    const base = Math.min(8000, 500 * 2 ** this.retry++);
    const wait = base / 2 + (Math.random() * base) / 2;
    setTimeout(() => this.open && this.connect(), wait);
  }

  private dial() {
    this.openedAt = 0; // until this socket opens: a failed redial must not reset the backoff
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.onStatus?.(true);
      this.sayHello();
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
        return this.sayHello();
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
      if (answer && m.t === "error" && m.code === "bad_ticket") {
        // A cached ticket (expired, secret rotated): hang up and come back with a fresh one, even on a first join.
        // No ticket at all (signed out) won't get better with a retry.
        if (this.ticket && !this.sentFresh && this.helloTicket) {
          this.freshTicket = true;
          return ws.close();
        }
        this.open = false; // a fresh one refused too (signed out, banned): stop and say so
        ws.close();
      }
      const w = this.waiting;
      if (w && (m.t === w.want || m.t === "error")) {
        this.waiting = null;
        return m.t === "error" ? w.fail(new Error(m.code)) : w.ok(m);
      }
      // Turned away for now (full, busy, throttled) while reconnecting: hang up and try again after the backoff.
      // In a room, "rate_limited" only means slow down (the relay throttles messages too): stay.
      if (
        answer &&
        this.open &&
        m.t === "error" &&
        m.code &&
        retryable.has(m.code)
      )
        return ws.close();
      // Closed or kicked: don't walk straight back in.
      if (
        m.t === "closed" ||
        m.t === "kicked" ||
        (m.t === "error" &&
          (m.code === "room_not_found" ||
            m.code === "kicked" ||
            m.code === "replaced" ||
            m.code === "bad_ticket"))
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
      if (this.openedAt && Date.now() - this.openedAt > 10_000) this.retry = 0;
      // The host's hello is a resume, a player's a fresh join.
      this.later();
    };
  }
}
