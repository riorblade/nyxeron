/**
 * The sampler pads: classic club transition sounds, synthesized with Web Audio (no sample files). Timed to the
 * tempo where it matters (risers and snare rolls last a bar).
 */
export type PadId =
  "horn" | "siren" | "riser" | "down" | "impact" | "sub" | "laser" | "roll";

export const PADS: PadId[] = [
  "horn",
  "siren",
  "riser",
  "down",
  "impact",
  "sub",
  "laser",
  "roll",
];

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf?.sampleRate === ctx.sampleRate) return noiseBuf;
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (noiseBuf = b);
}

function env(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  a: number,
  peak: number,
  hold: number,
  rel: number,
) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  g.connect(out);
  return g;
}

function osc(
  ctx: AudioContext,
  type: OscillatorType,
  f: number,
  t: number,
  len: number,
  to: AudioNode,
) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.connect(to);
  o.start(t);
  o.stop(t + len + 0.05);
  return o;
}

function noiseSrc(ctx: AudioContext, t: number, len: number, to: AudioNode) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  n.loop = true;
  n.connect(to);
  n.start(t);
  n.stop(t + len + 0.05);
  return n;
}

/** Fire a pad now. `bpm` sizes the bar-long sounds. */
export function playPad(
  ctx: AudioContext,
  out: AudioNode,
  pad: PadId,
  bpm = 124,
) {
  const t = ctx.currentTime + 0.005;
  const bar = (60 / bpm) * 4;
  switch (pad) {
    case "horn": {
      // Air horn: a detuned sawtooth chord through a nasal band-pass, three short blasts and a long one.
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1200;
      band.Q.value = 1.2;
      band.connect(out);
      [0, 0.16, 0.32, 0.5].forEach((dt, i) => {
        const len = i === 3 ? 0.9 : 0.1;
        const g = env(ctx, band, t + dt, 0.01, 0.35, len, 0.08);
        for (const f of [415, 440, 523, 659]) {
          const o = osc(ctx, "sawtooth", f, t + dt, len + 0.1, g);
          o.frequency.linearRampToValueAtTime(f * 0.97, t + dt + len);
        }
      });
      break;
    }
    case "siren": {
      // Dub siren: a square wave swept up and down by a fast LFO.
      const g = env(ctx, out, t, 0.02, 0.18, 1.6, 0.3);
      const o = osc(ctx, "square", 700, t, 2, g);
      const lfo = osc(ctx, "triangle", 5, t, 2, ctx.createGain());
      const depth = ctx.createGain();
      depth.gain.value = 350;
      lfo.disconnect();
      lfo.connect(depth).connect(o.frequency);
      break;
    }
    case "riser": {
      // Uplifter: white noise through a band-pass sweeping up, plus a rising tone, over one bar.
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 3;
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(9000, t + bar);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.02, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + bar);
      g.gain.linearRampToValueAtTime(0, t + bar + 0.05);
      bp.connect(g).connect(out);
      noiseSrc(ctx, t, bar, bp);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0, t);
      tg.gain.linearRampToValueAtTime(0.12, t + bar);
      tg.gain.linearRampToValueAtTime(0, t + bar + 0.05);
      tg.connect(out);
      osc(
        ctx,
        "sawtooth",
        110,
        t,
        bar,
        tg,
      ).frequency.exponentialRampToValueAtTime(880, t + bar);
      break;
    }
    case "down": {
      // Downlifter: the riser in reverse, falling away after a drop.
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(8000, t);
      bp.frequency.exponentialRampToValueAtTime(200, t + bar);
      const g = env(ctx, out, t, 0.005, 0.45, 0, bar);
      bp.connect(g);
      noiseSrc(ctx, t, bar, bp);
      break;
    }
    case "impact": {
      // Impact: a pitched-down boom and a noise crack, for the first beat of a drop.
      const g = env(ctx, out, t, 0.002, 0.9, 0.05, 1.4);
      osc(ctx, "sine", 120, t, 1.5, g).frequency.exponentialRampToValueAtTime(
        35,
        t + 0.6,
      );
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(6000, t);
      lp.frequency.exponentialRampToValueAtTime(300, t + 0.5);
      const ng = env(ctx, out, t, 0.001, 0.5, 0.02, 0.6);
      lp.connect(ng);
      noiseSrc(ctx, t, 0.7, lp);
      break;
    }
    case "sub": {
      // Sub drop: a long sine falling an octave and a half.
      const g = env(ctx, out, t, 0.01, 0.8, 0.2, 1.8);
      osc(ctx, "sine", 90, t, 2, g).frequency.exponentialRampToValueAtTime(
        28,
        t + 1.8,
      );
      break;
    }
    case "laser": {
      // Laser zaps: fast falling square sweeps.
      for (let i = 0; i < 3; i++) {
        const s = t + i * 0.12;
        const g = env(ctx, out, s, 0.002, 0.16, 0.02, 0.1);
        osc(
          ctx,
          "square",
          2400,
          s,
          0.14,
          g,
        ).frequency.exponentialRampToValueAtTime(120, s + 0.12);
      }
      break;
    }
    case "roll": {
      // Snare roll build: hits get faster through the bar (8ths → 16ths → 32nds) and louder.
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1200;
      hp.connect(out);
      const beat = bar / 4;
      const hits: number[] = [];
      for (let b = 0; b < 2; b++) hits.push(b * beat, b * beat + beat / 2);
      for (let k = 0; k < 4; k++) hits.push(2 * beat + (k * beat) / 4);
      for (let k = 0; k < 8; k++) hits.push(3 * beat + (k * beat) / 8);
      hits.forEach((dt, i) => {
        const g = env(
          ctx,
          hp,
          t + dt,
          0.001,
          0.12 + (i / hits.length) * 0.35,
          0.01,
          0.08,
        );
        noiseSrc(ctx, t + dt, 0.1, g);
      });
      break;
    }
  }
}
