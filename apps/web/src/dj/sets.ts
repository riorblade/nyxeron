import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DjSet, SetItem } from "./transitions";

/**
 * The player's DJ sets (planned before an event) and which one plays at the club tonight. Also the tempo fixes the
 * DJ made (×2 / ÷2) per track, so a track read at half speed stays corrected. Saved on this device.
 */
interface Sets {
  sets: DjSet[];
  /** The set the CEO's club plays when the DJ slot starts (null = the booked DJ's own music). */
  tonight: string | null;
  bpmFix: Record<string, number>;
  save(set: DjSet): void;
  remove(id: string): void;
  setTonight(id: string | null): void;
  fixBpm(track: string, k: number): void;
}

export const item = (track: string, title: string): SetItem => ({
  track,
  title,
  start: 0,
  bars: 32,
  transition: "bass",
  beats: 16,
  sfx: null,
});

/**
 * A starter set from the club's crate. Their tempos are far apart (≈120 / 95 / 87 BPM), so it uses the moves that
 * don't need beat-matching: echo out, backspin and a cut, each with a pad on the drop.
 */
const DEMO: DjSet = {
  id: "demo",
  name: "Warm-up to peak",
  items: [
    {
      ...item("papi-jarang-pulang", "Papi Jarang Pulang"),
      start: 63,
      transition: "echo",
      beats: 8,
      sfx: "impact",
    },
    {
      ...item("dj-main-serong", "DJ Main Serong"),
      transition: "spin",
      beats: 4,
      sfx: "riser",
    },
    {
      ...item("shakalaka-boom", "Shakalaka Boom"),
      transition: "cut",
      beats: 4,
      sfx: "horn",
    },
  ],
};

export const useSets = create<Sets>()(
  persist(
    (set) => ({
      sets: [DEMO],
      tonight: null,
      bpmFix: {},
      save: (s) =>
        set((st) => ({
          sets: st.sets.some((x) => x.id === s.id)
            ? st.sets.map((x) => (x.id === s.id ? s : x))
            : [...st.sets, s],
        })),
      remove: (id) =>
        set((st) => ({
          sets: st.sets.filter((x) => x.id !== id),
          tonight: st.tonight === id ? null : st.tonight,
        })),
      setTonight: (tonight) => set({ tonight }),
      fixBpm: (track, k) =>
        set((st) => ({
          bpmFix: { ...st.bpmFix, [track]: (st.bpmFix[track] ?? 1) * k },
        })),
    }),
    { name: "nyxeron:dj-sets" },
  ),
);
