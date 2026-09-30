import { audio } from "@/audio";
import type { Deck } from "./deck";
import type { DjEngine } from "./engine";
import {
  entryAt,
  sfxLeadBeats,
  transitionMix,
  type DjSet,
  type SetItem,
} from "./transitions";

/** Blends (fade/bass/filter) beat-match the next track only within this tempo gap; past it the move is a clash. */
export const BLEND_GAP = 0.08;
/** Seconds the old record needs for a backspin before its deck can take the next track. */
const SPIN_SEC = 1.2;

/**
 * Plays a planned set on the studio's decks: each track from its start cue for its bars, then the planned move into
 * the next (on the outgoing track's beat grid), with the pad on the drop. Loops back to the first track.
 * The DJ can still ride the mixer live; the next move takes over the faders again.
 */
export class AutoDj {
  index = 0;
  /** "move" while a transition is running (for the studio's status line). */
  state: "loading" | "playing" | "move" | "stopped" = "loading";
  private cur!: Deck;
  private next!: Deck;
  private nextReady = false;
  private started = false;
  private fired = false;
  /** Don't load into the old deck before its backspin has finished. */
  private loadAfter = 0;

  constructor(
    private e: DjEngine,
    readonly set: DjSet,
  ) {}

  get item(): SetItem {
    return this.set.items[this.index]!;
  }
  get upcoming(): SetItem {
    return this.set.items[(this.index + 1) % this.set.items.length]!;
  }

  async start() {
    const e = this.e;
    this.cur = e.a;
    this.next = e.b;
    e.setCrossfader(0);
    e.a.resetMix();
    e.b.resetMix();
    const it = this.item;
    await e.load(this.cur, it.track, it.title);
    if (this.state === "stopped") return;
    this.cur.setTempo(1);
    this.cur.seek(this.cur.snap(Math.max(it.start, 0)));
    this.cur.play();
    this.state = "playing";
    audio.setNowPlaying(it.title);
    void this.preload();
    e.emit();
  }

  stop() {
    this.state = "stopped";
    this.e.a.pause();
    this.e.b.pause();
    this.e.a.resetMix();
    this.e.b.resetMix();
    audio.setNowPlaying("");
    this.e.emit();
  }

  /** Where the current track's move ends and starts (seconds into it). */
  private window() {
    const d = this.cur;
    const it = this.item;
    const start = d.snap(Math.max(it.start, 0));
    const end = Math.min(d.duration - 0.5, start + it.bars * 4 * d.beat);
    return { end, from: end - it.beats * d.beat };
  }

  private async preload() {
    this.nextReady = false;
    const up = this.upcoming;
    const deck = this.next;
    await this.e.load(deck, up.track, up.title);
    // A stop or a finished move may have happened while it decoded.
    if (this.state !== "stopped" && deck === this.next) this.nextReady = true;
  }

  tick() {
    if (this.state !== "playing" && this.state !== "move") return;
    const now = this.e.ctx.currentTime;
    if (!this.nextReady) {
      if (this.loadAfter && now >= this.loadAfter) {
        this.loadAfter = 0;
        void this.preload();
      }
      return;
    }
    const it = this.item;
    const pos = this.cur.position();
    const { end, from } = this.window();
    const beat = this.cur.beat;

    // The pad: build-ups start early so they land on the drop.
    if (it.sfx && !this.fired && pos >= end - sfxLeadBeats(it.sfx) * beat) {
      this.fired = true;
      this.e.pad(it.sfx);
    }
    if (pos < from) return;

    const k = it.transition;
    const p = (pos - from) / (end - from);
    if (this.state !== "move") {
      this.state = "move";
      this.e.emit();
    }
    const m = transitionMix(k, p);
    if (!this.started && p >= entryAt(k)) this.bringIn(k);
    for (const key of ["fader", "low", "filter", "echo"] as const) {
      if (this.cur.mix[key] !== m.out[key]) this.cur.setMix(key, m.out[key]);
      if (this.started && this.next.mix[key] !== m.in[key])
        this.next.setMix(key, m.in[key]);
    }
    if (p >= 1) this.finish(k);
  }

  /** Start the incoming track on its cue: beat-matched for blends that are close enough, native tempo otherwise. */
  private bringIn(k: SetItem["transition"]) {
    const up = this.upcoming;
    const n = this.next;
    this.started = true;
    n.resetMix();
    const m = transitionMix(k, entryAt(k));
    for (const key of ["fader", "low", "filter", "echo"] as const)
      n.setMix(key, m.in[key]);
    n.setTempo(1);
    n.seek(n.snap(Math.max(up.start, 0)));
    n.play();
    const gap = Math.abs(this.cur.liveBpm / (n.track?.bpm ?? 1) - 1);
    if (entryAt(k) === 0 && gap <= BLEND_GAP) n.syncTo(this.cur);
  }

  private finish(k: SetItem["transition"]) {
    const old = this.cur;
    if (k === "spin") {
      old.backspin(SPIN_SEC);
      this.loadAfter = this.e.ctx.currentTime + SPIN_SEC + 0.2;
    } else {
      // Echo out: stopping the deck leaves its echoes ringing in the return.
      old.pause();
      this.loadAfter = this.e.ctx.currentTime + 0.05;
    }
    old.setMix("fader", 1);
    old.setMix("low", 0);
    old.setMix("filter", 0);
    // Leave the echo send up a moment for the tail, then close it.
    setTimeout(() => old.setMix("echo", 0), 50);
    this.cur = this.next;
    this.next = old;
    this.index = (this.index + 1) % this.set.items.length;
    this.nextReady = false;
    this.started = false;
    this.fired = false;
    this.state = "playing";
    audio.setNowPlaying(this.item.title);
    this.e.syncEcho();
    this.e.emit();
  }
}
