/**
 * Offline track analysis for the DJ studio: tempo (BPM), where the first downbeat sits, and a waveform overview.
 * Pure functions over raw samples, so they run on any decoded AudioBuffer channel and can be unit tested.
 */

const HOP = 0.01; // seconds per onset frame (10 ms)

/** Onset strength per 10 ms frame: positive jumps in short-term energy (kicks and snares stand out). */
export function onsets(samples: Float32Array, rate: number): Float32Array {
  const hop = Math.round(rate * HOP);
  const frames = Math.floor(samples.length / hop);
  const out = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) e += samples[i]! ** 2;
    e = Math.sqrt(e / hop);
    out[f] = Math.max(0, e - prev);
    prev = e;
  }
  return out;
}

/**
 * Tempo by autocorrelation of the onset curve over 70–180 BPM, folded into the club range (85–175), plus the phase
 * (seconds to the first beat) that lines the most onsets up with the grid.
 */
export function detectBpm(
  samples: Float32Array,
  rate: number,
): { bpm: number; offset: number } {
  const o = onsets(samples, rate);
  const minLag = Math.round(60 / 180 / HOP);
  const maxLag = Math.round(60 / 70 / HOP);
  let best = 0,
    bestLag = Math.round(60 / 124 / HOP);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < o.length; i++) sum += o[i]! * o[i + lag]!;
    // Tiny bias toward faster tempos breaks ties between a tempo and its half.
    sum *= 1 + (maxLag - lag) * 0.0005;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  let bpm = 60 / (bestLag * HOP);
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  // Refine: the period in frames at this tempo (fractional), then the phase with the strongest onsets.
  const period = 60 / bpm / HOP;
  let bestPhase = 0,
    bestScore = -1;
  for (let ph = 0; ph < period; ph++) {
    let score = 0;
    for (let t = ph; t < o.length; t += period) score += o[Math.round(t)] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = ph;
    }
  }
  return { bpm: Math.round(bpm * 10) / 10, offset: bestPhase * HOP };
}

/** Peak level per bucket (0..1), for drawing the waveform overview. */
export function peaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    for (
      let i = b * size, end = Math.min(samples.length, i + size);
      i < end;
      i += 4
    )
      m = Math.max(m, Math.abs(samples[i]!));
    out[b] = m;
  }
  return out;
}
