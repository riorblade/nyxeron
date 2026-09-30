import { AutoDj } from "./autodj";
import { DjEngine } from "./engine";
import type { DjSet } from "./transitions";

/**
 * One DJ engine shared by the studio and the auto set, so opening the studio during a planned set shows the same
 * decks (and the DJ can take over live). The engine owns the club's audio while anyone holds it.
 */
let engine: DjEngine | null = null;
let users = 0;
let timer = 0;
let auto: AutoDj | null = null;

/** The shared engine object (not opened: acquireEngine() does that). */
export const getEngine = () => (engine ??= new DjEngine());

export function acquireEngine(): DjEngine {
  const e = getEngine();
  if (users++ === 0) {
    e.open();
    // ponytail: a timer, not rAF, so a set keeps mixing with the studio closed; background tabs slow it down.
    timer = window.setInterval(() => {
      e.tick();
      auto?.tick();
    }, 25);
  }
  return e;
}

export function releaseEngine() {
  if (!engine || users === 0 || --users > 0) return;
  clearInterval(timer);
  engine.close();
}

export const currentAuto = () => auto;

/** Play a planned set (replacing one already playing). */
export function startAuto(set: DjSet) {
  stopAuto();
  if (!set.items.length) return;
  const e = acquireEngine();
  auto = new AutoDj(e, set);
  void auto.start();
}

export function stopAuto() {
  if (!auto) return;
  auto.stop();
  auto = null;
  releaseEngine();
}
