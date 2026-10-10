import { describe, expect, it, vi } from "vitest";

const target = new EventTarget();
const store = new Map<string, string>();
const reload = vi.fn();
vi.stubGlobal("window", target);
vi.stubGlobal("location", { reload });
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
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
    reloadOnStaleChunks();
    expect(fire()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(fire()).toBe(false); // failed again right after reloading
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fire()).toBe(true); // a later deploy: reload again
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
