import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";

const RELOADED = "nyxeron:reloaded-at";

/**
 * After a deploy, a tab still running the old build asks for chunks that no longer exist. Reload once to get the
 * new build; a second failure within a minute falls through to the boundary below (no reload loop).
 */
export function reloadOnStaleChunks() {
  window.addEventListener("vite:preloadError", (e) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOADED)) || 0;
    } catch {
      /* storage blocked: reload anyway, the boundary stops a loop */
    }
    if (Date.now() - last < 60_000) return; // just reloaded: let the error reach the boundary
    try {
      sessionStorage.setItem(RELOADED, String(Date.now()));
    } catch {
      /* ignore */
    }
    e.preventDefault();
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
