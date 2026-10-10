import { describe, expect, it, vi } from "vitest";

const target = new EventTarget();
const store = new Map<string, string>();
let blocked = false;
const reload = vi.fn();
vi.stubGlobal("window", target);
vi.stubGlobal("location", { reload });
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => {
    if (blocked) throw new Error("SecurityError");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => store.set(k, v),
});

const { reloadOnStaleChunks } = await import("./Crash");

const fire = () => {
  const e = new Event("vite:preloadError", { cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("stale chunks after a deploy", () => {
  it("reload once, then let the error reach the boundary (no reload loop)", () => {
    vi.useFakeTimers();
    const saved = vi.fn();
    reloadOnStaleChunks(saved);
    expect(fire()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledTimes(1); // the club is saved before reloading
    vi.advanceTimersByTime(5_000);
    expect(fire()).toBe(false); // failed again right after reloading
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fire()).toBe(true); // a later deploy: reload again
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("with storage blocked, never reloads by itself (no guard against a loop): the boundary shows", () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(120_000);
    blocked = true;
    reload.mockClear();
    for (let i = 0; i < 5; i++) expect(fire()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    blocked = false;
    vi.useRealTimers();
  });
});
