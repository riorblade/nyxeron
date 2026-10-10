import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";

const RELOADED = "nyxeron:reloaded-at";

/**
 * After a deploy, a tab still running the old build asks for chunks that no longer exist. Reload once to get the
 * new build (`beforeReload` saves the club first); a second failure within a minute falls through to the boundary
 * below. Without sessionStorage there is no guard against a loop, so no automatic reload: the boundary's button.
 */
export function reloadOnStaleChunks(beforeReload: () => void = () => {}) {
  window.addEventListener("vite:preloadError", (e) => {
    try {
      const last = Number(sessionStorage.getItem(RELOADED)) || 0;
      if (Date.now() - last < 60_000) return; // just reloaded: let the error reach the boundary
      sessionStorage.setItem(RELOADED, String(Date.now()));
    } catch {
      return; // storage blocked: can't tell a loop apart
    }
    e.preventDefault();
    try {
      beforeReload();
    } catch {
      /* reload anyway: a stale build can't go on */
    }
    location.reload();
  });
}

/** Anything that still throws while rendering: a message and a reload button instead of a blank page. */
export class Crash extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-black px-4 text-center text-white">
        <p className="text-sm text-white/70">{en.crash.title}</p>
        <Button variant="outline" onClick={() => location.reload()}>
          {en.crash.reload}
        </Button>
      </main>
    );
  }
}
