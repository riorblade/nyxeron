import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay, type Control } from "./relay";
import { Seats } from "./seats";

describe("seats", () => {
  it("gives a reconnecting player their own visitor back by key", () => {
    const s = new Seats();
    const v = "a1";
    s.seat(1, v, "secret");
    expect(s.of(1)).toBe(v);
    expect(s.held("secret")).toBe(v);
    expect(s.held("guess")).toBeUndefined();
    expect(s.held("")).toBeUndefined();
    // Back on a new connection before the relay noticed the old one died.
    s.bind(7, v);
    expect(s.of(7)).toBe(v);
    expect(s.drop(1)).toBeUndefined();
    expect(s.drop(7)).toBe(v);
    s.seat(2, "b2", "");
    expect(s.held("")).toBeUndefined();
    s.clear();
    expect([s.of(2), s.held("secret")]).toEqual([undefined, undefined]);
  });
});

/** A stand-in socket: records what the client sends, lets the test answer. */
class FakeWS {
  static all: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Control[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  constructor() {
    FakeWS.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string) {
    this.sent.push(JSON.parse(s) as Control);
  }
  say(m: Control) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("relay reconnects", () => {
  vi.stubGlobal("WebSocket", FakeWS);
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  afterEach(() => {
    FakeWS.all = [];
    store.clear();
    vi.useRealTimers();
  });

  it("a player's new id after a reconnect reaches the app; a kick stops it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = new Relay("ws://x");
    const seen: Control[] = [];
    r.onControl = (m) => seen.push(m);
    const joined = r.join("ROOM01", "Ana", "guest");
    await Promise.resolve();
    FakeWS.all[0]!.say({ t: "joined", room: "ROOM01", id: 3 });
    expect(await joined).toBe(3);

    FakeWS.all[0]!.close();
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(FakeWS.all[1]!.sent[0]).toMatchObject({ t: "join", room: "ROOM01" });
    FakeWS.all[1]!.say({ t: "joined", room: "ROOM01", id: 9 });
    expect(r.id).toBe(9);
    expect(seen.at(-1)).toMatchObject({ t: "joined", id: 9 });

    FakeWS.all[1]!.say({ t: "kicked" });
    FakeWS.all[1]!.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("a player whose club closed while they were away stops reconnecting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = new Relay("ws://x");
    const seen: Control[] = [];
    r.onControl = (m) => seen.push(m);
    const joined = r.join("ROOM01", "Ana", "guest");
    await Promise.resolve();
    FakeWS.all[0]!.say({ t: "joined", room: "ROOM01", id: 3 });
    await joined;

    FakeWS.all[0]!.close();
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    FakeWS.all[1]!.say({ t: "error", code: "room_not_found" });
    expect(seen.at(-1)).toMatchObject({ code: "room_not_found" });
    FakeWS.all[1]!.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("in a room, rate_limited means slow down, not reconnect; replaced (in a message) stands down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = new Relay("ws://x");
    const seen: Control[] = [];
    r.onControl = (m) => seen.push(m);
    const room = r.host("Club");
    await Promise.resolve();
    FakeWS.all[0]!.say({ t: "created", room: "AAAAAA", token: "t1" });
    await room;
    FakeWS.all[0]!.say({ t: "error", code: "rate_limited" });
    expect(FakeWS.all[0]!.readyState).toBe(1);

    FakeWS.all[0]!.say({ t: "error", code: "replaced" });
    expect(seen.at(-1)).toMatchObject({ code: "replaced" });
    FakeWS.all[0]!.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("a host whose room expired opens a fresh one and says so", async () => {
    const r = new Relay("ws://x");
    const seen: Control[] = [];
    r.onControl = (m) => seen.push(m);
    const room = r.host("Club");
    await tick();
    FakeWS.all[0]!.say({ t: "created", room: "AAAAAA", token: "t1" });
    expect(await room).toBe("AAAAAA");

    // Reconnect: resume with the token; the relay forgot the room.
    FakeWS.all[0]!.readyState = 3;
    FakeWS.all[0]!.onclose?.();
    await new Promise((r) => setTimeout(r, 600));
    const ws = FakeWS.all[1]!;
    expect(ws.sent[0]).toMatchObject({ t: "resume", token: "t1" });
    ws.say({ t: "error", code: "room_not_found" });
    expect(ws.sent[1]).toMatchObject({ t: "create", name: "Club" });
    ws.say({ t: "created", room: "BBBBBB", token: "t2" });
    expect(r.room).toBe("BBBBBB");
    expect(seen.at(-1)).toMatchObject({ t: "created", room: "BBBBBB" });

    // Closing tells the relay to close the room now.
    r.close();
    expect(ws.sent.at(-1)).toEqual({ t: "close" });
  });
});
