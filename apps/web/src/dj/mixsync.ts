import type { Deck, Mix } from "./deck";
import type { DjEngine } from "./engine";

/**
 * Live DJ over the network without streaming audio: the DJ's browser sends the state of the mix a few times a
 * second (~300 bytes); every other player plays the same tracks from the shared crate on their own engine and
 * follows it. One-shot moves (pads, brake, backspin) travel separately (DjAct).
 */
export interface DeckSync {
  track: string;
  title: string;
  playing: boolean;
  /** Playhead (seconds into the track) when sent. */
  pos: number;
  tempo: number;
  reverse: boolean;
  loop: [number, number, number] | null;
  mix: Mix;
}
export interface MixSync {
  a: DeckSync | null;
  b: DeckSync | null;
  xf: number;
}

/** Followers correct their playhead only past this (seconds): small drift is inaudible, seeks are not. */
export const DRIFT = 0.25;
/** Assumed one-way delay DJ → relay → player (seconds); the follower aims this far ahead. */
export const LATENCY = 0.12;

const deckSync = (d: Deck): DeckSync | null =>
  d.track
    ? {
        track: d.track.id,
        title: d.track.title,
        playing: d.playing,
        pos: Math.round(d.position() * 1000) / 1000,
        tempo: d.tempo,
        reverse: d.reverse,
        loop: d.loop ? [d.loop.start, d.loop.end, d.loop.beats] : null,
        mix: d.mix,
      }
    : null;

export const mixSnapshot = (e: DjEngine): MixSync => ({
  a: deckSync(e.a),
  b: deckSync(e.b),
  xf: e.crossfader,
});

/** Where the follower's playhead should be now, and whether it is far enough off to seek. */
export function followTarget(
  local: number,
  remote: DeckSync,
  latency = LATENCY,
): { target: number; seek: boolean } {
  const dir = remote.reverse ? -1 : 1;
  const target = remote.playing
    ? remote.pos + dir * latency * remote.tempo
    : remote.pos;
  return { target, seek: Math.abs(local - target) > DRIFT };
}

/** Tracks a follower is loading, so a burst of syncs doesn't start the same load twice. */
const loading = new WeakMap<Deck, string>();

async function followDeck(e: DjEngine, d: Deck, r: DeckSync | null) {
  if (!r) {
    if (d.playing) d.pause();
    return;
  }
  if (d.track?.id !== r.track) {
    if (loading.get(d) === r.track) return;
    loading.set(d, r.track);
    try {
      await e.load(d, r.track, r.title);
    } catch {
      return; // not in this player's crate (or offline): stay quiet on this deck
    } finally {
      loading.delete(d);
    }
  }
  if (d.winding) return; // a brake / backspin is playing out
  for (const k of Object.keys(r.mix) as (keyof Mix)[])
    if (d.mix[k] !== r.mix[k]) d.setMix(k, r.mix[k]);
  if (Math.abs(d.tempo - r.tempo) > 1e-4) d.setTempo(r.tempo);
  if (d.reverse !== r.reverse) d.setReverse(r.reverse);
  const beats = r.loop?.[2] ?? null;
  if ((d.loop?.beats ?? null) !== beats) d.setLoop(beats);
  const { target, seek } = followTarget(d.position(), r);
  if (r.playing && !d.playing) {
    d.seek(target);
    d.play();
  } else if (!r.playing && d.playing) {
    d.pause();
    d.seek(target);
  } else if (seek) d.seek(target);
}

/** Bring a follower's engine in line with the DJ's latest mix. */
export async function applyMix(e: DjEngine, m: MixSync) {
  if (Math.abs(e.crossfader - m.xf) > 1e-3) e.setCrossfader(m.xf);
  await Promise.all([followDeck(e, e.a, m.a), followDeck(e, e.b, m.b)]);
  e.emit();
}
