import { create } from "zustand";
import { persist } from "zustand/middleware";

/** When the venue's wall screens play the dancer / club clips. */
export type ClipMode = "peak" | "always" | "off";

export interface Settings {
  /** Lounge music on the landing, office, reports. */
  menuMusic: boolean;
  /** Music inside the club (house warm-up, then the DJ). */
  venueMusic: boolean;
  /** Cash register and alert sounds. */
  sfx: boolean;
  clips: ClipMode;
  /** Sponsor slots on the venue walls; off = they show club visuals instead. */
  ads: boolean;
  /** The "Open Club" cutscene. */
  intro: boolean;
  /** The Settings dialog (not persisted). */
  open: boolean;
  setOpen(open: boolean): void;
  set(patch: Partial<Omit<Settings, "set" | "open" | "setOpen">>): void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      menuMusic: true,
      venueMusic: true,
      sfx: true,
      clips: "peak",
      ads: true,
      intro: true,
      open: false,
      setOpen: (open) => set({ open }),
      set: (patch) => set(patch),
    }),
    {
      name: "nyxeron:settings",
      partialize: (s) => ({
        menuMusic: s.menuMusic,
        venueMusic: s.venueMusic,
        sfx: s.sfx,
        clips: s.clips,
        ads: s.ads,
        intro: s.intro,
      }),
    },
  ),
);
