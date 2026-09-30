import { EQ_MIN, type Mix } from "./deck";
import type { PadId } from "./sampler";

/**
 * The transitions an auto set can use between two tracks (the standard DJ moves, easiest first). Each is a curve
 * over the transition window, p = 0 → 1, measured in the outgoing track's beats.
 */
export type TransitionId = "fade" | "cut" | "bass" | "filter" | "echo" | "spin";
export const TRANSITIONS: TransitionId[] = [
  "fade",
  "cut",
  "bass",
  "filter",
  "echo",
  "spin",
];

/**
 * When the incoming track starts, as a fraction of the window: blends bring it in at the start, the "one-shot"
 * moves (cut, echo out, backspin) drop it in on the last beat.
 */
export const entryAt = (k: TransitionId) =>
  k === "fade" || k === "bass" || k === "filter" ? 0 : 1;

type Channel = Pick<Mix, "fader" | "low" | "filter" | "echo">;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Mixer settings for the outgoing and incoming channel at progress p (0..1) through a transition. */
export function transitionMix(
  k: TransitionId,
  p: number,
): { out: Channel; in: Channel } {
  p = clamp01(p);
  const flat: Channel = { fader: 1, low: 0, filter: 0, echo: 0 };
  switch (k) {
    case "fade":
      // Equal-power fade: no dip in the middle.
      return {
        out: { ...flat, fader: Math.cos((p * Math.PI) / 2) },
        in: { ...flat, fader: Math.sin((p * Math.PI) / 2) },
      };
    case "bass":
      // Bass swap: the new track comes in without its bass; halfway the basses trade places (never two at once).
      return {
        out: {
          ...flat,
          low: p < 0.5 ? 0 : EQ_MIN,
          fader: p < 0.85 ? 1 : (1 - p) / 0.15,
        },
        in: { ...flat, low: p < 0.5 ? EQ_MIN : 0, fader: clamp01(p / 0.25) },
      };
    case "filter":
      // The old track thins out through a rising high-pass while the new one opens up from dark.
      return {
        out: { ...flat, filter: p * 0.9, fader: p < 0.8 ? 1 : (1 - p) / 0.2 },
        in: { ...flat, filter: -(1 - p) * 0.7, fader: clamp01(p * 1.5) },
      };
    case "echo":
      // Echo out: the old track feeds more and more echo, then stops on the last beat and its echoes ring out.
      return {
        out: { ...flat, echo: Math.min(0.85, p * 1.2) },
        in: { ...flat, fader: p >= 1 ? 1 : 0 },
      };
    case "cut":
    case "spin":
      // Hard cut on the downbeat (spin = the old record is spun back as the new one drops).
      return { out: flat, in: { ...flat, fader: p >= 1 ? 1 : 0 } };
  }
}

/** One track in a planned set, and the move into the next one. */
export interface SetItem {
  track: string;
  title: string;
  /** Where the track starts (seconds; snapped to the beat grid on load). */
  start: number;
  /** How long it plays before the move into the next one ends (bars of 4 beats). */
  bars: number;
  transition: TransitionId;
  /** Length of the move, in beats. */
  beats: number;
  sfx: PadId | null;
}

export interface DjSet {
  id: string;
  name: string;
  items: SetItem[];
}

/**
 * When a pad fires within the move: build-ups (riser, snare roll) end on the drop, so they start a bar early;
 * the rest hit on the drop.
 */
export const sfxLeadBeats = (pad: PadId) =>
  pad === "riser" || pad === "roll" ? 4 : 0;
