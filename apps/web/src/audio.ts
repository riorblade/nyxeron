import { night, type GameState } from "@nyxeron/core";
import { useEffect } from "react";
import { useSettings } from "./settings";

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
  kalu: { file: "kalu", title: "Kalu" },
  sable: { file: "sable", title: "Sable" },
};
/** Every club track the DJs can mix from. */
const CRATE = [...new Set(Object.values(TRACKS).map((t) => t.file))];
const titleOf = (file: string) =>
  Object.values(TRACKS).find((t) => t.file === file)?.title ?? file;
/** Seconds of overlap when the DJ mixes into the next track. */
const XFADE = 4;
/** How long the DJ stays on one track before rotating to the next (seconds). */
const SEGMENT = 60;

/** A DJ's set: their own track first (if they have one), then the rest of the crate. */
export const setFor = (dj: string) => {
  const own = TRACKS[dj]?.file;
  return own ? [own, ...CRATE.filter((f) => f !== own)] : CRATE;
};
/** One continuous lounge track outside the club: landing → setup → office by day (muffled) → report. */
export const LOUNGE = "landing";
/** Inside the club before the DJ: the house warm-up (never the landing track). */
export const HOUSE = "house";

/** What plays at the club right now: the booked DJ's set (several tracks, mixed) once it starts, the house warm-up before. */
export const nightTrack = (s: GameState) =>
  s.bookedTalent[0] && s.night && s.night.minute >= night.djSetStartMinute
    ? `set:${s.bookedTalent[0]}`
    : HOUSE;

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
  private loudShort = 0;
  private loudLong = 0;
  private quietAt = -99;
  /** Music loudness now relative to the last few seconds (≈1 steady, >1.15 lifting). */
  intensity = 1;
  /** AudioContext time of the last detected drop. */
  dropAt = -99;
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

  /**
   * Switch the music (crossfade). An id is a track ("landing", a DJ id) or "set:<dj>", a DJ set that mixes through the
   * crate. Missing files are skipped in a set, or fall back to the synthesized beat.
   */
  play(id: string | null) {
    if (id === this.current) return;
    this.current = id ?? "";
    if (!this.ctx) {
      this.pending = !!id; // browsers block sound until the first gesture; unlock() starts it
      return;
    }
    this.fadeOutCurrent(FADE / 3);
    this.synth?.stop(this.ctx.currentTime);
    this.synth = null;
    this.set = null;
    this.nowPlaying = "";
    if (!id) return this.listeners.forEach((f) => f());
    if (id.startsWith("set:")) {
      this.set = {
        files: setFor(id.slice(4)),
        i: 0,
        failed: 0,
        id,
        positions: {},
      };
      this.startFile(this.set.files[0]!, false, id);
    } else this.startFile(TRACKS[id]?.file ?? id, true, id);
  }

  /** Title of the track sounding now (for Now Playing); "" for the lounge or the synth. */
  nowPlaying = "";
  private set: {
    files: string[];
    i: number;
    failed: number;
    id: string;
    /** Where each track was when the DJ rotated away from it. */
    positions: Record<string, number>;
  } | null = null;

  private fadeOutCurrent(tau: number) {
    if (!this.el || !this.elGain || !this.ctx) return;
    const [el, g] = [this.el, this.elGain];
    g.gain.setTargetAtTime(0, this.ctx.currentTime, tau);
    setTimeout(() => {
      el.pause();
      g.disconnect();
    }, tau * 5000);
    this.el = this.elGain = null;
  }

  private startFile(
    file: string,
    loop: boolean,
    id: string,
    fadeIn = FADE / 3,
  ) {
    const ctx = this.ctx!;
    const el = new Audio(`/audio/${file}.mp3`);
    el.loop = loop;
    el.crossOrigin = "anonymous";
    const g = ctx.createGain();
    g.gain.value = 0;
    ctx.createMediaElementSource(el).connect(g).connect(this.muffle);
    this.el = el;
    this.elGain = g;
    if (this.set) {
      this.nowPlaying = titleOf(file);
      this.listeners.forEach((f) => f());
      // Pick up where this track left off last time round, so each rotation plays a new part of it.
      const resume = this.set.positions[file] ?? 0;
      let start = 0;
      el.addEventListener(
        "loadedmetadata",
        () => {
          // Too close to the end for a full turn: start the track over.
          if (resume < el.duration - SEGMENT / 2)
            el.currentTime = start = resume;
        },
        { once: true },
      );
      // Rotate after about a minute (or a few seconds before the track ends), mixing into the next one.
      el.addEventListener("timeupdate", () => {
        if (this.el !== el || !el.duration) return;
        const ending = el.duration - el.currentTime < XFADE;
        if (el.currentTime - start >= SEGMENT - XFADE || ending) {
          this.set!.positions[file] = ending ? 0 : el.currentTime + XFADE;
          this.nextInSet();
        }
      });
    }
    el.addEventListener("playing", () => this.set && (this.set.failed = 0));
    el.addEventListener("error", () => {
      if (this.el !== el || !this.ctx) return;
      // In a set, skip a missing track; if the whole crate is missing, keep the club going on the synth beat.
      if (this.set && ++this.set.failed < this.set.files.length)
        return this.nextInSet(true);
      this.el = this.elGain = null;
      g.disconnect();
      this.nowPlaying = "";
      this.synth = new SynthBeat(
        this.ctx,
        this.muffle,
        id === HOUSE ? 112 : 124,
        id === HOUSE,
      );
      this.synth.start();
    });
    el.play()
      .then(() => g.gain.setTargetAtTime(1, ctx.currentTime, fadeIn))
      .catch(() => {});
  }

  private nextInSet(skip = false) {
    const s = this.set;
    if (!s) return;
    s.i = (s.i + 1) % s.files.length;
    this.fadeOutCurrent(skip ? 0.05 : XFADE / 3);
    this.startFile(s.files[s.i]!, false, s.id, skip ? FADE / 3 : XFADE / 4);
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
      // Loudness now vs. the last few seconds: >1 = the track is lifting (a drop, a big chorus).
      let all = 0;
      const upTo = Math.floor(this.bins.length / 3);
      for (let i = 1; i < upTo; i++) all += this.bins[i]!;
      all /= upTo;
      this.loudShort += (all - this.loudShort) * 0.15;
      this.loudLong += (all - this.loudLong) * 0.003;
      const ratio = this.loudLong > 1 ? this.loudShort / this.loudLong : 1;
      this.intensity = ratio;
      // A drop: the room was quiet (breakdown / build-up) within the last few seconds and now it slams back.
      if (ratio < 0.8) this.quietAt = now;
      if (ratio > 1.2 && now - this.quietAt < 4 && now - this.dropAt > 8)
        this.dropAt = now;
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
    if (!c || this.muted || !useSettings.getState().sfx) return;
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
    if (!c || this.muted || !useSettings.getState().sfx) return;
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
 * `scope` picks which Settings switch applies: menu music (outside the club) or venue music (inside).
 */
export function useMusic(
  id: string | null,
  muffled = false,
  scope: "menu" | "venue" = "menu",
) {
  const on = useSettings((s) =>
    scope === "venue" ? s.venueMusic : s.menuMusic,
  );
  useEffect(() => audio.play(on ? id : null), [id, on]);
  useEffect(() => audio.setMuffled(muffled), [muffled]);
}
if (typeof window !== "undefined")
  window.addEventListener("pointerdown", () => audio.unlock(), {
    capture: true,
  });
// Dev-only handle for automated browser checks; stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined")
  (window as unknown as { __audio: ClubAudio }).__audio = audio;
