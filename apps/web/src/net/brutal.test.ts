/**
 * Adversarial tests for the multiplayer client (relay.ts, session.ts). Tests that FAIL document a real bug; the
 * rest are attacks that held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settle = vi.fn();
vi.mock("@/api/player", () => ({
  player: { settle },
  online: () => false, // signed out: no relay ticket
  call: vi.fn(),
}));
vi.mock("@/state/store", () => {
  const st = { game: null, notify: vi.fn(), set: vi.fn() };
  return { useGame: { getState: () => st, subscribe: () => () => {} } };
});
vi.mock("@/dj/session", () => ({
  acquireEngine: vi.fn(),
  releaseEngine: vi.fn(),
  getEngine: () => ({ ready: false }),
}));
vi.mock("@/dj/mixsync", () => ({ applyMix: vi.fn(), mixSnapshot: vi.fn() }));
vi.mock("@/audio", () => ({ audio: { pad: vi.fn() } }));
vi.mock("@/venue/pyro", () => ({ firePyro: vi.fn() }));
vi.mock("@/venue/shoutouts", () => ({
  getShoutouts: () => [],
  onShoutouts: () => () => {},
  setHostedShoutouts: vi.fn(),
}));
vi.mock("./codec", () => ({
  packState: vi.fn(),
  unpackState: async (p: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(p)) as unknown,
}));
vi.mock("@nyxeron/core", async (orig) => ({
  ...(await orig<object>()),
  visitorValue: () => 1000,
  visitorPnl: () => 50,
}));

import { encodeFrame, KIND, pack, Relay, type Control } from "./relay";

/** A stand-in socket (seats.test.ts pattern) that the "relay" can close with a reason. */
class FakeWS {
  static all: FakeWS[] = [];
  static OPEN = 1;
  /** The relay is down: new sockets fail before they open. */
  static refuse = false;
  readyState = 0;
  sent: (Control | Uint8Array)[] = [];
  at = Date.now();
  droppedAt = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string | ArrayBuffer }) => void;
  onclose?: (e?: { code: number; reason: string }) => void;
  constructor() {
    FakeWS.all.push(this);
    queueMicrotask(() => {
      if (FakeWS.refuse) return this.drop();
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string | Uint8Array) {
    this.sent.push(typeof s === "string" ? (JSON.parse(s) as Control) : s);
  }
  say(m: Control) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  frame(kind: number, payload: unknown) {
    const b = encodeFrame(kind as 1, 0, pack(payload));
    this.onmessage?.({ data: b.buffer });
  }
  /** The relay hangs up (reason as the relay's close frame carries it). */
  drop(reason = "") {
    this.readyState = 3;
    this.droppedAt = Date.now();
    this.onclose?.({ code: 1000, reason });
  }
  close() {
    this.drop();
  }
}

const store = new Map<string, string>();
vi.stubGlobal("WebSocket", FakeWS);
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
});
vi.stubGlobal("window", globalThis);
vi.stubGlobal("location", { protocol: "http:", host: "x" });

/** Let queued microtasks (socket opens) run under fake timers. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  FakeWS.all = [];
  FakeWS.refuse = false;
  store.clear();
  settle.mockClear();
  vi.useRealTimers();
});

async function hosted(r: Relay) {
  const room = r.host("Club");
  await flush();
  FakeWS.all.at(-1)!.say({ t: "created", room: "AAAAAA", token: "t1" });
  return room;
}

describe("relay client under a hostile network", () => {
  it("BUG: backoff resets on every open, so accept-then-drop is a 2 Hz reconnect storm forever", async () => {
    const r = new Relay("ws://x");
    await hosted(r);
    // The relay accepts every socket and drops it right away (overloaded, "too slow", a proxy restarting…).
    for (let i = 0; i < 12; i++) {
      FakeWS.all.at(-1)!.drop("too slow");
      await vi.advanceTimersByTimeAsync(8_000);
      await flush();
    }
    const gaps = FakeWS.all
      .slice(1)
      .map((w, i) => w.at - FakeWS.all[i]!.droppedAt);
    // Healthy: the wait grows towards the 8 s cap. Main: every gap is 500 ms.
    expect(Math.max(...gaps.slice(-4))).toBeGreaterThanOrEqual(4_000);
  });

  it("a relay that is down after a long session: failed redials keep backing off", async () => {
    const r = new Relay("ws://x");
    await hosted(r);
    await vi.advanceTimersByTimeAsync(11_000); // a connection that held: the next drop starts from 0.5 s
    FakeWS.refuse = true; // every redial fails before it opens
    FakeWS.all.at(-1)!.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    FakeWS.refuse = false;
    const gaps = FakeWS.all
      .slice(1)
      .map((w, i) => w.at - FakeWS.all[i]!.droppedAt);
    expect(Math.min(...gaps.slice(-3))).toBeGreaterThanOrEqual(4_000);
  });

  it("a join waiting on a relay that never opens gives up with offline", async () => {
    FakeWS.refuse = true;
    const r = new Relay("ws://x");
    const failed = r
      .join("ROOM01", "Ana", "guest")
      .catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await failed).toBe("offline");
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(n); // nothing keeps dialing
  });

  it("BUG: no jitter, so every player of a dropped relay reconnects in lockstep", async () => {
    const a = new Relay("ws://x");
    const b = new Relay("ws://x");
    const ja = a.join("ROOM01", "A", "guest");
    const jb = b.join("ROOM01", "B", "guest");
    await flush();
    FakeWS.all[0]!.say({ t: "joined", room: "ROOM01", id: 1 });
    FakeWS.all[1]!.say({ t: "joined", room: "ROOM01", id: 2 });
    await Promise.all([ja, jb]);
    // Two different random draws for the two waits: with jitter they reconnect at different times, without it at
    // the same one. (Unstubbed, two uniform waits could land on the same ms and fail the test now and then.)
    const random = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);
    FakeWS.all[0]!.drop();
    FakeWS.all[1]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    random.mockRestore();
    expect(FakeWS.all).toHaveLength(4);
    expect(FakeWS.all[3]!.at).not.toBe(FakeWS.all[2]!.at);
  });

  it("BUG: two tabs with the same saved token (duplicate tab) fight for the room forever", async () => {
    const a = new Relay("ws://x");
    await hosted(a); // token saved to sessionStorage, which a duplicated tab copies
    const b = new Relay("ws://x");
    void b.host("Club"); // resumes with the same token
    await flush();
    // Simulated relay: each resume replaces the other tab's socket.
    let swaps = 0;
    const replaceOthers = () => {
      for (const w of FakeWS.all)
        if (w.readyState === 1 && w !== FakeWS.all.at(-1)) {
          swaps++;
          w.drop("replaced");
        }
    };
    for (let i = 0; i < 20; i++) {
      replaceOthers();
      await vi.advanceTimersByTimeAsync(600);
      await flush();
    }
    // A host told "replaced" should stand down; main keeps resuming, flapping every guest's host on/off.
    expect(swaps).toBeLessThanOrEqual(1);
  });

  it("BUG: closing the club during a reconnect backoff resumes the room 500 ms later (zombie host)", async () => {
    const r = new Relay("ws://x");
    await hosted(r);
    FakeWS.all[0]!.drop(); // network blip; reconnect scheduled in 500 ms
    r.close(); // the CEO closes the club meanwhile
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    const zombie = FakeWS.all[1];
    expect(
      zombie ? zombie.sent : [],
      "a closed relay reconnected and re-sent its hello",
    ).toEqual([]);
  });

  it("BUG: a host whose fallback create hits server_full still shows the dead room as live", async () => {
    const r = new Relay("ws://x");
    const seen: Control[] = [];
    r.onControl = (m) => seen.push(m);
    await hosted(r);
    FakeWS.all[0]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    const ws = FakeWS.all[1]!;
    ws.say({ t: "error", code: "room_not_found" }); // expired: client falls back to create
    ws.say({ t: "error", code: "server_full" });
    await vi.advanceTimersByTimeAsync(60_000);
    // Nothing retries and nothing clears the room: the CEO's screen keeps "AAAAAA" live with no room behind it.
    const retried = FakeWS.all.length > 2 || ws.sent.length > 2;
    expect(retried || r.room === "").toBe(true);
  });

  it("BUG: a guest refused on a rejoin (room_full) sits on an open socket forever, never retried", async () => {
    const r = new Relay("ws://x");
    const j = r.join("ROOM01", "Ana", "guest");
    await flush();
    FakeWS.all[0]!.say({ t: "joined", room: "ROOM01", id: 3 });
    await j;
    FakeWS.all[0]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    FakeWS.all[1]!.say({ t: "error", code: "room_full" });
    await vi.advanceTimersByTimeAsync(120_000);
    const joins = FakeWS.all.flatMap((w) =>
      w.sent.filter((m) => (m as Control).t === "join"),
    );
    expect(joins.length).toBeGreaterThan(2);
  });

  it("held: a kick or a close stops reconnects even under a drop storm", async () => {
    const r = new Relay("ws://x");
    const j = r.join("ROOM01", "Ana", "guest");
    await flush();
    FakeWS.all[0]!.say({ t: "joined", room: "ROOM01", id: 3 });
    await j;
    FakeWS.all[0]!.say({ t: "kicked" });
    for (let i = 0; i < 5; i++) FakeWS.all[0]!.drop("kicked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("held: garbage from the relay doesn't break the client", async () => {
    const r = new Relay("ws://x");
    const frames: unknown[] = [];
    r.onFrame = (f) => frames.push(f);
    const j = r.join("ROOM01", "Ana", "guest");
    await flush();
    const ws = FakeWS.all[0]!;
    ws.say({ t: "joined", room: "ROOM01", id: 3 });
    await j;
    ws.onmessage?.({ data: new Uint8Array([1]).buffer }); // short frame: ignored
    ws.onmessage?.({ data: new ArrayBuffer(0) });
    expect(frames).toHaveLength(0);
    expect(() => ws.onmessage?.({ data: "{not json" })).toThrow(); // only that message is lost
    ws.say({ t: "host", on: true });
    expect(r.id).toBe(3);
  });
});

describe("guest settle under a hostile network", () => {
  const remote = (inside: boolean) => ({
    phase: "night",
    night: { visitors: inside ? { v1: { cash: 700, holdings: {} } } : {} },
  });

  it("held: kicked + closed + room_not_found + seat_lost settle the night once", async () => {
    const { guestJoin, useNet } = await import("./session");
    const p = guestJoin("ROOM01", { name: "Ana", avatar: 1, cash: 1000 });
    await flush();
    const ws = FakeWS.all.at(-1)!;
    ws.say({ t: "joined", room: "ROOM01", id: 3 });
    await p;
    ws.frame(KIND.to, { t: "welcome", ok: true, me: "v1" });
    ws.frame(KIND.state, remote(true));
    await vi.waitFor(() => expect(useNet.getState().last).not.toBeNull());
    ws.say({ t: "kicked" });
    ws.say({ t: "closed" });
    ws.say({ t: "error", code: "room_not_found" });
    ws.frame(KIND.to, { t: "welcome", ok: true, me: "v2" });
    ws.frame(KIND.state, remote(true)); // a late snapshot must not bring the night back
    await flush();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(700, {}, 50);
  });
});
