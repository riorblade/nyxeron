import { detectBpm, peaks } from "./analyze";

export interface Track {
  id: string;
  title: string;
  buffer: AudioBuffer;
  /** The same audio backwards: Web Audio can't play a source in reverse, so reverse/backspin/scratch use this. */
  reversed: AudioBuffer;
  bpm: number;
  /** Seconds to the first beat (the beat grid starts here). */
  offset: number;
  peaks: Float32Array;
}

export async function loadTrack(
  ctx: AudioContext,
  id: string,
  title: string,
  data: ArrayBuffer,
): Promise<Track> {
  const buffer = await ctx.decodeAudioData(data);
  const reversed = ctx.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );
  for (let c = 0; c < buffer.numberOfChannels; c++)
    reversed.getChannelData(c).set(buffer.getChannelData(c).slice().reverse());
  const mono = buffer.getChannelData(0);
  // Tempo from the first ~90 s is plenty and keeps loading quick.
  const head = mono.subarray(0, Math.min(mono.length, buffer.sampleRate * 90));
  const { bpm, offset } = detectBpm(head, buffer.sampleRate);
  return {
    id,
    title,
    buffer,
    reversed,
    bpm,
    offset,
    peaks: peaks(mono, 1200),
  };
}

/**
 * Playhead motion since the last change: speed ramps linearly from r0 to r1 over T seconds (T = 0: constant), in
 * direction dir (1 forward, −1 reverse). Every change starts a new segment from the current position, so the
 * position is always exact without polling the audio thread.
 */
interface Segment {
  t0: number;
  p0: number;
  r0: number;
  r1: number;
  T: number;
  dir: 1 | -1;
}

/**
 * The speed a deck at `bpm` needs to match a deck playing at `targetBpm`: the same BPM when a ±50% fader can reach
 * it, else half/double time (a 87 BPM track against 174), whichever is nearer the original speed.
 */
export function syncSpeed(targetBpm: number, bpm: number): number {
  const r = targetBpm / bpm;
  if (Math.abs(r - 1) <= 0.5) return r;
  return [r / 2, r * 2].sort(
    (x, y) => Math.abs(Math.log(x)) - Math.abs(Math.log(y)),
  )[0]!;
}

export interface Mix {
  trim: number;
  high: number;
  mid: number;
  low: number;
  /** −1 low-pass … 0 off … 1 high-pass. */
  filter: number;
  echo: number;
  reverb: number;
  fader: number;
}
export const FLAT: Mix = {
  trim: 1,
  high: 0,
  mid: 0,
  low: 0,
  filter: 0,
  echo: 0,
  reverb: 0,
  fader: 1,
};

/** 3-band EQ range in dB (full kill at the bottom). */
export const EQ_MIN = -26;
export const EQ_MAX = 6;

/**
 * One deck plus its mixer channel: source → trim → 3-band EQ → filter → channel fader → crossfader side → bus.
 * Echo and reverb are sends taken after the filter.
 */
export class Deck {
  track: Track | null = null;
  playing = false;
  /** Pitch fader: playback speed (1 = original tempo). Pitch moves with it, like a turntable. */
  tempo = 1;
  /** Pitch fader range: ±16% (normal) or ±50% (wide, for tracks far apart in tempo). */
  range: 0.16 | 0.5 = 0.16;
  reverse = false;
  /** Main cue point and four hot cues (seconds). */
  cue = 0;
  hotCues: (number | null)[] = [null, null, null, null];
  loop: { start: number; end: number; beats: number } | null = null;
  /** A backspin / brake in progress (the deck stops when it ends). */
  private stopAt = 0;
  /** True during a brake or backspin (followers leave the deck alone until it ends). */
  get winding() {
    return this.stopAt > 0;
  }

  private src: AudioBufferSourceNode | null = null;
  private seg: Segment = { t0: 0, p0: 0, r0: 0, r1: 0, T: 0, dir: 1 };
  readonly trim: GainNode;
  readonly eq: {
    low: BiquadFilterNode;
    mid: BiquadFilterNode;
    high: BiquadFilterNode;
  };
  readonly filter: BiquadFilterNode;
  readonly fader: GainNode;
  readonly side: GainNode;
  readonly echoSend: GainNode;
  readonly reverbSend: GainNode;
  readonly meter: AnalyserNode;
  private meterBuf = new Float32Array(256);
  filterAmount = 0;

  constructor(
    private ctx: AudioContext,
    bus: AudioNode,
    echo: AudioNode,
    reverb: AudioNode,
  ) {
    const c = ctx;
    this.trim = c.createGain();
    const low = c.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 220;
    const mid = c.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;
    const high = c.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 4500;
    this.eq = { low, mid, high };
    this.filter = c.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 22000;
    this.fader = c.createGain();
    this.side = c.createGain();
    this.echoSend = c.createGain();
    this.echoSend.gain.value = 0;
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 0;
    this.meter = c.createAnalyser();
    this.meter.fftSize = 256;
    this.trim.connect(low).connect(mid).connect(high).connect(this.filter);
    this.filter.connect(this.fader).connect(this.side).connect(bus);
    this.filter.connect(this.meter);
    this.filter.connect(this.echoSend).connect(echo);
    this.filter.connect(this.reverbSend).connect(reverb);
  }

  get duration() {
    return this.track?.buffer.duration ?? 0;
  }
  /** Seconds per beat in track time. */
  get beat() {
    return 60 / (this.track?.bpm ?? 120);
  }
  /** The tempo the room hears (track BPM × pitch fader). */
  get liveBpm() {
    return (this.track?.bpm ?? 0) * this.tempo;
  }

  /** Where the playhead is (seconds into the track). */
  position(now = this.ctx.currentTime): number {
    const { t0, p0, r0, r1, T, dir } = this.seg;
    const dt = Math.max(0, now - t0);
    const moved =
      T > 0 && dt < T
        ? r0 * dt + ((r1 - r0) * dt * dt) / (2 * T)
        : (T > 0 ? ((r0 + r1) / 2) * T : 0) + r1 * (dt - T);
    let p = p0 + dir * moved;
    if (this.loop && dir > 0 && p > this.loop.end)
      p =
        this.loop.start +
        ((p - this.loop.start) % (this.loop.end - this.loop.start));
    return Math.min(this.duration, Math.max(0, p));
  }

  /** Beat phase 0..1 at the playhead (0 = on the beat). */
  phase(p = this.position()) {
    const b = (p - (this.track?.offset ?? 0)) / this.beat;
    return b - Math.floor(b);
  }

  /** Called every frame: ends finished brakes/backspins and tracks that ran out. */
  tick() {
    const now = this.ctx.currentTime;
    if (this.stopAt && now >= this.stopAt) {
      this.stopAt = 0;
      this.pause();
    }
    if (
      this.playing &&
      !this.reverse &&
      !this.loop &&
      this.position(now) >= this.duration - 0.02
    )
      this.pause();
    if (this.playing && this.reverse && this.position(now) <= 0.02)
      this.pause();
  }

  level(): number {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (const v of this.meterBuf) m = Math.max(m, Math.abs(v));
    return Math.min(1, m);
  }

  load(track: Track) {
    this.stopSource();
    this.track = track;
    this.playing = false;
    this.reverse = false;
    this.loop = null;
    this.stopAt = 0;
    this.cue = track.offset;
    this.hotCues = [null, null, null, null];
    this.seg = {
      t0: this.ctx.currentTime,
      p0: track.offset,
      r0: 0,
      r1: 0,
      T: 0,
      dir: 1,
    };
  }

  play() {
    if (!this.track || this.playing) return;
    this.playing = true;
    this.startAt(this.position(), this.tempo);
  }

  pause() {
    const p = this.position();
    this.playing = false;
    this.stopAt = 0;
    this.stopSource();
    this.seg = { t0: this.ctx.currentTime, p0: p, r0: 0, r1: 0, T: 0, dir: 1 };
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** CDJ-style cue: while stopped it sets the cue point here; while playing it jumps back to it and stops. */
  cueButton() {
    if (!this.track) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
    } else this.cue = this.snap(this.position());
  }

  seek(p: number) {
    p = Math.min(this.duration, Math.max(0, p));
    if (this.playing) this.startAt(p, this.tempo);
    else
      this.seg = { ...this.seg, t0: this.ctx.currentTime, p0: p, r0: 0, r1: 0 };
  }

  /** Hot cue: set it here (snapped to the beat) if empty, else jump there (and keep playing). */
  hotCue(i: number, clear = false) {
    if (!this.track) return;
    if (clear) this.hotCues[i] = null;
    else if (this.hotCues[i] == null)
      this.hotCues[i] = this.snap(this.position());
    else this.seek(this.hotCues[i]!);
  }

  /** Nearest beat on the grid. */
  snap(p: number) {
    const off = this.track?.offset ?? 0;
    return off + Math.round((p - off) / this.beat) * this.beat;
  }

  setTempo(t: number) {
    this.tempo = Math.min(1 + this.range, Math.max(1 - this.range, t));
    if (this.playing && !this.stopAt) this.startAt(this.position(), this.tempo);
  }

  /** Jog wheel nudge: bend the speed for a moment to line the beats up by ear (+ ahead, − behind). */
  nudge(amount: number) {
    if (!this.playing || !this.src || this.stopAt) return;
    const now = this.ctx.currentTime;
    const p = this.position(now);
    this.src.playbackRate.setValueAtTime(this.tempo * (1 + amount), now);
    this.src.playbackRate.setValueAtTime(this.tempo, now + 0.25);
    // The bend moves the playhead by tempo × amount × 0.25 s; book it up front.
    this.seg = {
      t0: now,
      p0: p + this.tempo * amount * 0.25,
      r0: this.tempo,
      r1: this.tempo,
      T: 0,
      dir: 1,
    };
  }

  /** Play backwards (or forwards again) from here. */
  setReverse(on: boolean) {
    if (on === this.reverse) return;
    this.reverse = on;
    if (on) this.loop = null;
    if (this.playing) this.startAt(this.position(), this.tempo);
  }

  /**
   * Scratch: the platter is held and moved. `speed` is how fast the record turns (1 = normal, negative =
   * backwards, 0 = held still).
   */
  scratch(speed: number) {
    if (!this.track) return;
    const p = this.position();
    const back = speed < 0;
    const r = Math.min(4, Math.abs(speed));
    if (r < 0.02) {
      this.stopSource();
      this.seg = {
        t0: this.ctx.currentTime,
        p0: p,
        r0: 0,
        r1: 0,
        T: 0,
        dir: 1,
      };
      return;
    }
    if (!this.src || back !== this.reverse) {
      this.reverse = back;
      this.startAt(p, r);
    } else {
      this.src.playbackRate.setValueAtTime(r, this.ctx.currentTime);
      this.seg = {
        t0: this.ctx.currentTime,
        p0: p,
        r0: r,
        r1: r,
        T: 0,
        dir: back ? -1 : 1,
      };
    }
  }

  /** Let go of the platter: carry on as before the scratch. */
  release(wasPlaying: boolean) {
    this.reverse = false;
    if (wasPlaying) {
      this.playing = true;
      this.startAt(this.position(), this.tempo);
    } else {
      this.playing = true;
      this.pause();
    }
  }

  /** Vinyl brake: the platter winds down to a stop over `sec` seconds. */
  brake(sec = 0.9) {
    if (!this.playing || !this.src) return;
    const now = this.ctx.currentTime;
    const p = this.position(now);
    const r0 = this.src.playbackRate.value;
    this.src.playbackRate.setValueAtTime(r0, now);
    this.src.playbackRate.linearRampToValueAtTime(0.01, now + sec);
    this.seg = {
      t0: now,
      p0: p,
      r0,
      r1: 0.01,
      T: sec,
      dir: this.reverse ? -1 : 1,
    };
    this.stopAt = now + sec;
  }

  /** Backspin / rewind: the record is spun back fast and slows to a stop (the classic "wheel up"). */
  backspin(sec = 1.2) {
    if (!this.track) return;
    const now = this.ctx.currentTime;
    const p = this.position(now);
    this.playing = true;
    this.reverse = true;
    this.loop = null;
    this.startAt(p, 3.2);
    this.src!.playbackRate.setValueAtTime(3.2, now);
    this.src!.playbackRate.linearRampToValueAtTime(0.01, now + sec);
    this.seg = { t0: now, p0: p, r0: 3.2, r1: 0.01, T: sec, dir: -1 };
    this.stopAt = now + sec;
    // Next play goes forwards again from where the spin stopped.
    setTimeout(() => (this.reverse = false), sec * 1000 + 20);
  }

  /** Auto loop of `beats` beats from the nearest beat; the same size again ends it. */
  setLoop(beats: number | null) {
    if (!this.track) return;
    if (beats == null || this.loop?.beats === beats) {
      this.loop = null;
      if (this.src) this.src.loop = false;
      return;
    }
    const p = this.position();
    const start = Math.min(this.snap(p), p);
    this.loop = { start, end: start + beats * this.beat, beats };
    this.reverse = false;
    if (this.playing) this.startAt(p, this.tempo);
  }

  /** Beat jump: move the playhead by whole beats (negative = back). */
  jump(beats: number) {
    this.seek(this.position() + beats * this.beat);
  }

  /** Match the other deck's tempo and line our beats up with its beats. */
  syncTo(other: Deck) {
    if (!this.track || !other.track) return;
    const target = syncSpeed(other.liveBpm, this.track.bpm);
    // Too far for the normal fader: switch to the wide range, like a CDJ's ±50%.
    if (Math.abs(target - 1) > this.range) this.range = 0.5;
    this.setTempo(target);
    let d = other.phase() - this.phase();
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    this.seek(this.position() + d * this.beat);
  }

  /** Switch the pitch fader between ±16% and ±50% (the tempo is clamped into the new range). */
  toggleRange() {
    this.range = this.range === 0.16 ? 0.5 : 0.16;
    this.setTempo(this.tempo);
  }

  /** Beat detection can land on half or double the real tempo; the DJ corrects it (×2 / ÷2). */
  scaleBpm(k: 2 | 0.5) {
    if (!this.track) return;
    this.track.bpm = Math.round(this.track.bpm * k * 10) / 10;
  }

  /** The channel's knob and fader positions (what the mixer shows; automation and the DJ both set them). */
  mix: Mix = { ...FLAT };

  setMix(k: keyof Mix, x: number) {
    this.mix = { ...this.mix, [k]: x };
    const now = this.ctx.currentTime;
    if (k === "trim") this.trim.gain.setTargetAtTime(x, now, 0.02);
    else if (k === "high" || k === "mid" || k === "low") this.setEq(k, x);
    else if (k === "filter") this.setFilter(x);
    else if (k === "echo") this.echoSend.gain.setTargetAtTime(x, now, 0.02);
    else if (k === "reverb")
      this.reverbSend.gain.setTargetAtTime(x * 0.8, now, 0.02);
    // Squared: the fader's travel feels even to the ear.
    else this.fader.gain.setTargetAtTime(x * x, now, 0.01);
  }

  /** Back to a flat channel: fader up, EQ and filter centred, no sends. */
  resetMix() {
    for (const k of Object.keys(FLAT) as (keyof Mix)[]) this.setMix(k, FLAT[k]);
  }

  setEq(band: "low" | "mid" | "high", db: number) {
    this.eq[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
  }

  /** One knob filter: < 0 low-pass (darker), > 0 high-pass (thinner), 0 = off. */
  setFilter(x: number) {
    this.filterAmount = x;
    const f = this.filter;
    const now = this.ctx.currentTime;
    if (Math.abs(x) < 0.03) {
      f.type = "lowpass";
      f.frequency.setTargetAtTime(22000, now, 0.02);
      f.Q.value = 0.7;
    } else if (x < 0) {
      f.type = "lowpass";
      f.frequency.setTargetAtTime(22000 * Math.pow(150 / 22000, -x), now, 0.02);
      f.Q.value = 4;
    } else {
      f.type = "highpass";
      f.frequency.setTargetAtTime(20 * Math.pow(6000 / 20, x), now, 0.02);
      f.Q.value = 4;
    }
  }

  dispose() {
    this.stopSource();
    this.trim.disconnect();
    this.side.disconnect();
  }

  // ---------- internals ----------

  private startAt(p: number, rate: number) {
    const t = this.track!;
    const now = this.ctx.currentTime;
    this.stopSource();
    const back = this.reverse;
    const src = this.ctx.createBufferSource();
    src.buffer = back ? t.reversed : t.buffer;
    src.playbackRate.value = rate;
    if (this.loop && !back) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(this.trim);
    src.start(now, back ? Math.max(0, t.buffer.duration - p) : p);
    this.src = src;
    this.seg = { t0: now, p0: p, r0: rate, r1: rate, T: 0, dir: back ? -1 : 1 };
  }

  private stopSource() {
    if (!this.src) return;
    try {
      this.src.stop();
    } catch {
      /* already stopped */
    }
    this.src.disconnect();
    this.src = null;
  }
}
