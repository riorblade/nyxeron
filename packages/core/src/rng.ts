/** mulberry32: small, fast, deterministic. State is a single uint32 so it serializes into GameState. */
export function nextRandom(seed: number): [value: number, nextSeed: number] {
  const s = (seed + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** Mutable cursor over the seed for use inside one pure function; write `rng.seed` back to state when done. */
export function createRng(seed: number) {
  const rng = {
    seed,
    next(): number {
      const [v, s] = nextRandom(rng.seed);
      rng.seed = s;
      return v;
    },
    chance: (p: number) => rng.next() < p,
    /** Inclusive integer range. */
    int: (min: number, max: number) =>
      min + Math.floor(rng.next() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T =>
      arr[Math.floor(rng.next() * arr.length)]!,
    weighted<T extends string>(weights: Record<T, number>): T {
      const entries = Object.entries(weights) as [T, number][];
      let r = rng.next() * entries.reduce((a, [, w]) => a + w, 0);
      for (const [k, w] of entries) if ((r -= w) < 0) return k;
      return entries[entries.length - 1]![0];
    },
  };
  return rng;
}
