import { audio } from "@/audio";
import { Deck, loadTrack, type Track } from "./deck";
import { playPad, type PadId } from "./sampler";
import { useSets } from "./sets";

export type DjAct =
  { t: "pad"; id: PadId } | { t: "brake" | "spin"; deck: "a" | "b" };

/**
 * The DJ studio's sound engine: two decks into a mixer (crossfader, per-channel EQ/filter/FX sends), an echo and a
 * reverb return, and the sampler, all feeding the club's audio chain (so the venue lights and pyro follow the mix).
 * open() takes the room from the club music and builds the graph; close() hands the room back. Reopening (React
 * StrictMode mounts twice) builds a fresh graph.
 */
export class DjEngine {
  ctx!: AudioContext;
  a!: Deck;
  b!: Deck;
  ready = false;
  /** Bumped on every change, for useSyncExternalStore. */
  version = 0;
  private bus!: GainNode;
  private echo!: DelayNode;
  private echoFb!: GainNode;
  private listeners = new Set<() => void>();
  private cache = new Map<string, Promise<Track>>();
  /** −1 = all deck A, 1 = all deck B. */
  crossfader = -1;

  open() {
    if (this.ready) return;
    const decks = { playing: () => this.a?.playing || this.b?.playing };
    const { ctx, input } = audio.takeOver(decks);
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.connect(input);

    // Echo return: a delay with feedback, darkened a little each repeat.
    this.echo = ctx.createDelay(2);
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.45;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 5000;
    this.echo.connect(tone).connect(this.echoFb).connect(this.echo);
    tone.connect(this.bus);

    // Reverb return: a convolver on a generated decaying-noise impulse (a big room).
    const reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    reverb.buffer = ir;
    reverb.connect(this.bus);

    this.a = new Deck(ctx, this.bus, this.echo, reverb);
    this.b = new Deck(ctx, this.bus, this.echo, reverb);
    this.setCrossfader(-1);
    this.ready = true;
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  /** Tell the UI something changed (buttons, loaded tracks). Positions and meters are polled per frame. */
  emit() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  /** Equal-power crossfade, so the middle isn't a dip in volume. */
  setCrossfader(x: number) {
    this.crossfader = Math.max(-1, Math.min(1, x));
    const t = ((this.crossfader + 1) / 2) * (Math.PI / 2);
    const now = this.ctx.currentTime;
    this.a.side.gain.setTargetAtTime(Math.cos(t), now, 0.01);
    this.b.side.gain.setTargetAtTime(Math.sin(t), now, 0.01);
  }

  /** Echo time follows the louder deck's tempo: 3/4 of a beat (a dotted-eighth feel). */
  syncEcho() {
    const d = this.louder();
    if (!d.track) return;
    this.echo.delayTime.setTargetAtTime(
      Math.min(1.9, (60 / d.liveBpm) * 0.75),
      this.ctx.currentTime,
      0.05,
    );
  }

  /** The deck the crowd mostly hears (for the sampler's tempo and the echo time). */
  louder(): Deck {
    return this.crossfader <= 0 ? this.a : this.b;
  }

  /** Load a club track from /public/audio, or any file the DJ brings. */
  /** Decode and analyse a track once (cached): a club track from /public/audio, or a file the DJ brings. */
  track(id: string, title: string, file?: File): Promise<Track> {
    let p = this.cache.get(id);
    if (!p) {
      p = (
        file
          ? file.arrayBuffer()
          : fetch(`/audio/${id}.mp3`).then((r) => {
              if (!r.ok) throw new Error(`${r.status}`);
              return r.arrayBuffer();
            })
      )
        .then((data) => loadTrack(this.ctx, id, title, data))
        .then((tr) => {
          // The DJ's own tempo correction for this track (×2 / ÷2), if any.
          tr.bpm *= useSets.getState().bpmFix[id] ?? 1;
          return tr;
        });
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id));
    }
    return p;
  }

  async load(deck: Deck, id: string, title: string, file?: File) {
    deck.load(await this.track(id, title, file));
    this.syncEcho();
    this.emit();
  }

  pad(id: PadId) {
    playPad(this.ctx, this.bus, id, this.louder().liveBpm || 124);
    this.onAct?.({ t: "pad", id });
  }

  /** One-shot moves that a follower can't infer from positions alone (live DJ → the club's other players). */
  onAct?: (a: DjAct) => void;

  /** A deck's vinyl brake or backspin, told to followers too. */
  brake(deck: Deck) {
    deck.brake();
    this.onAct?.({ t: "brake", deck: deck === this.a ? "a" : "b" });
  }
  backspin(deck: Deck) {
    deck.backspin();
    this.onAct?.({ t: "spin", deck: deck === this.a ? "a" : "b" });
  }

  tick() {
    const was = [
      this.a.playing,
      this.b.playing,
      this.a.reverse,
      this.b.reverse,
    ];
    this.a.tick();
    this.b.tick();
    // A brake, backspin or the end of a track stopped a deck: refresh the buttons.
    if (
      was.join() !==
      [this.a.playing, this.b.playing, this.a.reverse, this.b.reverse].join()
    )
      this.emit();
  }

  /** Stop the decks and give the room back to the club's own music. */
  close() {
    if (!this.ready) return;
    this.ready = false;
    this.a.dispose();
    this.b.dispose();
    this.bus.disconnect();
    audio.release();
    this.emit();
  }
}
