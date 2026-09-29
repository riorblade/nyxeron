import { useEffect } from "react";

/**
 * Club audio: music tracks (user-supplied files in /public/audio), a synthesized fallback beat for tracks that
 * don't exist yet, synthesized SFX, and a live "kick pulse" read from the music so the venue moves on the real beat.
 * Everything is Web Audio; no generated media.
 */

const VOLUME_KEY = "nyxeron:volume";
const MUTE_KEY = "nyxeron:muted";
const FADE = 0.6; // seconds

/**
 * Which file a track id plays (default `<id>.mp3`) and the title shown in Now Playing.
 * Ids: "landing" (main menu), "house" (pre-set lounge playlist), or a DJ id.
 */
export const TRACKS: Record<string, { file: string; title?: string }> = {
  rhea: { file: "shakalaka-boom", title: "Shakalaka Boom" },
  jax: { file: "papi-jarang-pulang", title: "Papi Jarang Pulang" },
  nova: { file: "dj-main-serong", title: "DJ Main Serong" },
};
/** One continuous lounge track: landing → office (muffled, the club downstairs) → the club before the DJ → report. */
export const LOUNGE = "landing";

const trackUrl = (id: string) => `/audio/${TRACKS[id]?.file ?? id}.mp3`;

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference just won't persist */
  }
}

/** Synthesized four-on-the-floor loop (kick, hats, clap, bass) used until a real track is supplied. */
class SynthBeat {
  private timer = 0;
  private next = 0;
  private step = 0;
  private kicks: number[] = [];
  private out: GainNode;
  private noise: AudioBuffer;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private bpm: number,
    private soft: boolean,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = soft ? 0.45 : 0.8;
    this.out.connect(dest);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    this.next = this.ctx.currentTime + 0.05;
    // Lookahead scheduler: every 25 ms, schedule the 16th notes falling in the next 120 ms.
    this.timer = window.setInterval(() => {
      const sixteenth = 60 / this.bpm / 4;
      while (this.next < this.ctx.currentTime + 0.12) {
        this.note(this.step % 16, this.next);
        this.next += sixteenth;
        this.step++;
      }
    }, 25);
  }

  stop(at: number) {
    clearInterval(this.timer);
    this.out.gain.setTargetAtTime(0, at, 0.15);
    setTimeout(() => this.out.disconnect(), 1500);
  }

  /** Seconds since the most recent kick that has already sounded (for the visual pulse). */
  sinceKick(now: number) {
    this.kicks = this.kicks.filter((t) => t > now - 2);
    const past = this.kicks.filter((t) => t <= now);
    return past.length ? now - past[past.length - 1]! : Infinity;
  }

  private note(s: number, t: number) {
    const c = this.ctx;
    if (s % 4 === 0) {
      // Kick: pitch-dropping sine.
      const o = c.createOscillator(),
        g = c.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.4);
      this.kicks.push(t);
    }
    if (!this.soft || s % 4 === 2)
      this.hit(t, s % 4 === 2 ? 0.25 : 0.1, 8000, 0.04); // hats, open on the off-beat
    if (!this.soft && (s === 4 || s === 12)) this.hit(t, 0.35, 1500, 0.12); // clap on 2 and 4
    if (s % 4 === 2) {
      // Off-beat bass stab, A minor-ish movement per bar.
      const root = [55, 55, 65.4, 49][Math.floor(this.step / 16) % 4]!;
      const o = c.createOscillator(),
        f = c.createBiquadFilter(),
        g = c.createGain();
      o.type = "sawtooth";
      o.frequency.value = root;
      f.type = "lowpass";
      f.frequency.value = this.soft ? 300 : 500;
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(f).connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.22);
    }
  }

  private hit(t: number, level: number, freq: number, len: number) {
    const src = this.ctx.createBufferSource(),
      f = this.ctx.createBiquadFilter(),
      g = this.ctx.createGain();
    src.buffer = this.noise;
    f.type = freq > 4000 ? "highpass" : "bandpass";
    f.frequency.value = freq;
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + len + 0.02);
  }
}

class ClubAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffle!: BiquadFilterNode;
  private analyser!: AnalyserNode;
  private bins!: Uint8Array<ArrayBuffer>;
  private el: HTMLAudioElement | null = null;
  private elGain: GainNode | null = null;
  private synth: SynthBeat | null = null;
  private current = "";
  /** A track was requested before the first user gesture; it starts on unlock. */
  private pending = false;
  private prevBass = 0;
  private fluxAvg = 0;
  private kickAt = 0;
  private lastProbe = 0;
  volume = Number(stored(VOLUME_KEY, "0.8"));
  muted = stored(MUTE_KEY, "0") === "1";
  private listeners = new Set<() => void>();

  /** Browsers only allow audio after a user gesture; the first click anywhere unlocks it. */
  unlock() {
    if (this.ctx) return void this.ctx.resume();
    this.create();
    if (this.pending) {
      this.pending = false;
      const id = this.current;
      this.current = "";
      this.play(id || null);
    }
    this.listeners.forEach((f) => f());
  }

  /** Has the browser let us make sound yet (first click / key press)? */
  get unlocked() {
    return !!this.ctx;
  }

  private create() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = "lowpass";
    this.muffle.frequency.value = 20000;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // Low smoothing so kick transients survive (the default 0.8 blurs them into the bassline).
    this.analyser.smoothingTimeConstant = 0.15;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.muffle
      .connect(this.analyser)
      .connect(this.master)
      .connect(ctx.destination);
    this.applyVolume();
  }

  /** Switch the music to a track (crossfade). Missing files fall back to the synthesized beat. */
  play(id: string | null) {
    if (id === this.current) return;
    this.current = id ?? "";
    if (!this.ctx) {
      this.pending = !!id; // browsers block sound until the first gesture; unlock() starts it
      return;
    }
    const now = this.ctx.currentTime;
    if (this.el && this.elGain) {
      const [el, g] = [this.el, this.elGain];
      g.gain.setTargetAtTime(0, now, FADE / 3);
      setTimeout(() => {
        el.pause();
        g.disconnect();
      }, FADE * 1500);
      this.el = this.elGain = null;
    }
    this.synth?.stop(now);
    this.synth = null;
    if (!id) return;

    const el = new Audio(trackUrl(id));
    el.loop = true;
    el.crossOrigin = "anonymous";
    const g = this.ctx.createGain();
    g.gain.value = 0;
    this.ctx.createMediaElementSource(el).connect(g).connect(this.muffle);
    this.el = el;
    this.elGain = g;
    el.addEventListener("error", () => {
      // No file for this DJ yet: keep the club going with the synth beat (softer for the lounge playlist).
      if (this.el !== el || !this.ctx) return;
      this.el = this.elGain = null;
      g.disconnect();
      this.synth = new SynthBeat(
        this.ctx,
        this.muffle,
        id === "house" ? 112 : 124,
        id === "house",
      );
      this.synth.start();
    });
    el.play()
      .then(() => g.gain.setTargetAtTime(1, this.ctx!.currentTime, FADE / 3))
      .catch(() => {});
  }

  stop() {
    this.play(null);
  }

  /** Pause menu / cutscene: the club sounds like it's behind a door. */
  setMuffled(on: boolean) {
    if (!this.ctx) return;
    this.muffle.frequency.setTargetAtTime(
      on ? 600 : 20000,
      this.ctx.currentTime,
      0.15,
    );
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    store(VOLUME_KEY, String(this.volume));
    this.applyVolume();
  }

  toggleMute() {
    this.muted = !this.muted;
    store(MUTE_KEY, this.muted ? "1" : "0");
    this.applyVolume();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** True while music is actually sounding (the venue then follows it instead of its own clock). */
  get live() {
    return (
      !!this.ctx &&
      this.ctx.state === "running" &&
      (!!this.synth || (!!this.el && !this.el.paused))
    );
  }

  /**
   * 0..1 kick pulse, sharp on the hit and decaying over ~0.35 s. Real tracks: bass-band energy spikes above its
   * running average. Synth fallback: its own scheduled kick times.
   */
  pulse(): number {
    if (!this.ctx || !this.live) return 0;
    const now = this.ctx.currentTime;
    if (this.synth)
      return Math.pow(Math.max(0, 1 - this.synth.sinceKick(now) / 0.35), 3);
    // Detect at most once per ~10 ms however often this is called (the renderer calls it every frame).
    if (now - this.lastProbe > 0.01) {
      this.lastProbe = now;
      this.analyser.getByteFrequencyData(this.bins);
      // Bins below ~150 Hz (bin width = sampleRate / fftSize).
      const top = Math.max(
        2,
        Math.floor(150 / (this.ctx.sampleRate / this.analyser.fftSize)),
      );
      let bass = 0;
      for (let i = 1; i <= top; i++) bass += this.bins[i]!;
      bass /= top;
      // Spectral flux on the bass band: a kick is a sudden jump, even over a loud sustained bassline.
      const flux = Math.max(0, bass - this.prevBass);
      this.prevBass = bass;
      // 0.33 s refractory gap: blocks off-beat bass stabs at club tempos, still allows up to ~180 BPM.
      if (flux > Math.max(8, this.fluxAvg * 2.5) && now - this.kickAt > 0.33)
        this.kickAt = now;
      this.fluxAvg += (flux - this.fluxAvg) * 0.05;
    }
    return Math.pow(Math.max(0, 1 - (now - this.kickAt) / 0.35), 3);
  }

  /** Cash register "ka-ching" for bar sales (two quick bell partials). */
  cash() {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime;
    for (const [f, d] of [
      [2093, 0],
      [2637, 0.06],
    ] as const) {
      const o = c.createOscillator(),
        g = c.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
      o.connect(g).connect(this.master);
      o.start(t + d);
      o.stop(t + d + 0.3);
    }
  }

  /** Two-tone alert for fights, inspections and stock-outs. */
  alert() {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime;
    [880, 660].forEach((f, i) => {
      const o = c.createOscillator(),
        g = c.createGain();
      o.type = "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.06, t + i * 0.14);
      g.gain.setTargetAtTime(0, t + i * 0.14 + 0.1, 0.02);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.14);
      o.stop(t + i * 0.14 + 0.14);
    });
  }

  private applyVolume() {
    if (this.ctx)
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime,
        0.05,
      );
    this.listeners.forEach((f) => f());
  }
}

export const audio = new ClubAudio();

/**
 * A screen's soundtrack. Screens sharing an id keep one track playing without restarting it (play() ignores the
 * current track), so the lounge flows from the landing into the game; `muffled` = heard through a wall.
 */
export function useMusic(id: string | null, muffled = false) {
  useEffect(() => audio.play(id), [id]);
  useEffect(() => audio.setMuffled(muffled), [muffled]);
}
if (typeof window !== "undefined")
  window.addEventListener("pointerdown", () => audio.unlock(), {
    capture: true,
  });
// Dev-only handle for automated browser checks; stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined")
  (window as unknown as { __audio: ClubAudio }).__audio = audio;
