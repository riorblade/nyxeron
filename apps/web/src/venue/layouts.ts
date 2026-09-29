import type { GuestState, Level } from "@nyxeron/core";

export type ZoneId =
  | "queue"
  | "entrance"
  | "counter"
  | "backbar"
  | "barFront"
  | "dance"
  | "dj"
  | "stage"
  | "seating"
  | "stock"
  | "vip"
  | "restroom"
  | "office";

export interface Zone {
  id: ZoneId;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  /** Drawn as a raised block (counters, booths) instead of floor. */
  solid?: boolean;
  outside?: boolean;
  lockedBelow?: Level;
}

/**
 * A video screen on a wall. `at` = centre along the wall (x for n/s walls, z for w/e walls).
 * portrait = 9:16 clips (e.g. dancer clips), landscape = 16:9 footage, ad = sponsor slot.
 */
export interface ScreenSlot {
  wall: "n" | "w" | "e" | "s";
  at: number;
  kind: "portrait" | "landscape" | "ad";
}

export interface Layout {
  /** Key for the player's saved furniture arrangement. */
  name: "booth" | "bar" | "club";
  w: number;
  h: number;
  zones: Zone[];
  screens: ScreenSlot[];
}

/** Level 1–2: a drink booth on the street. */
const booth: Layout = {
  name: "booth",
  w: 8,
  h: 7,
  screens: [
    { wall: "n", at: 6.4, kind: "portrait" },
    { wall: "w", at: 5, kind: "portrait" },
    { wall: "e", at: 3, kind: "ad" },
    { wall: "s", at: 2.5, kind: "landscape" },
  ],
  zones: [
    { id: "backbar", x: 0, y: 0, w: 4, h: 1 },
    {
      id: "counter",
      x: 0,
      y: 1,
      w: 4,
      h: 1,
      label: "DRINK BOOTH",
      solid: true,
    },
    { id: "barFront", x: 0, y: 2, w: 4, h: 2 },
    { id: "seating", x: 5, y: 0, w: 3, h: 5, label: "STANDING TABLES" },
    { id: "dance", x: 0, y: 4, w: 4, h: 3, label: "SPEAKER CORNER" },
    { id: "entrance", x: 5, y: 6, w: 3, h: 1, label: "ENTRANCE" },
    { id: "queue", x: 5, y: 7, w: 3, h: 3, label: "STREET", outside: true },
  ],
};

/** Level 3: bar with a live-music stage. */
const bar: Layout = {
  name: "bar",
  w: 12,
  h: 9,
  screens: [
    { wall: "n", at: 10.5, kind: "portrait" },
    { wall: "w", at: 8, kind: "portrait" },
    { wall: "e", at: 1.8, kind: "portrait" },
    { wall: "e", at: 4.6, kind: "ad" },
    { wall: "e", at: 7.4, kind: "portrait" },
    { wall: "s", at: 2.5, kind: "landscape" },
    { wall: "s", at: 10, kind: "ad" },
  ],
  zones: [
    { id: "backbar", x: 0, y: 1, w: 1, h: 6 },
    { id: "counter", x: 1, y: 1, w: 1, h: 6, label: "BAR", solid: true },
    { id: "barFront", x: 2, y: 1, w: 2, h: 6 },
    { id: "stage", x: 5, y: 0, w: 4, h: 2, label: "STAGE", solid: true },
    { id: "dance", x: 4, y: 3, w: 5, h: 4, label: "FLOOR" },
    { id: "seating", x: 9, y: 1, w: 3, h: 6, label: "OPEN TABLES" },
    { id: "stock", x: 0, y: 7, w: 3, h: 2, label: "STOCK" },
    { id: "entrance", x: 5, y: 8, w: 3, h: 1, label: "ENTRANCE" },
    { id: "queue", x: 5, y: 9, w: 3, h: 3, label: "STREET", outside: true },
  ],
};

/** Level 4–5: "The Basement" (GDD 15.1 blockout). */
const club: Layout = {
  name: "club",
  w: 16,
  h: 12,
  screens: [
    { wall: "n", at: 1.5, kind: "portrait" },
    { wall: "n", at: 13.5, kind: "ad" },
    { wall: "w", at: 10.5, kind: "portrait" },
    { wall: "e", at: 2, kind: "landscape" },
    { wall: "e", at: 5.2, kind: "portrait" },
    { wall: "e", at: 6.8, kind: "portrait" },
    { wall: "e", at: 10, kind: "ad" },
    { wall: "s", at: 3, kind: "landscape" },
    { wall: "s", at: 13, kind: "ad" },
  ],
  zones: [
    { id: "office", x: 0, y: 0, w: 3, h: 2, label: "CEO OFFICE" },
    { id: "stage", x: 3, y: 0, w: 3, h: 2, label: "STAGE", solid: true },
    { id: "dj", x: 6, y: 0, w: 4, h: 2, label: "DJ BOOTH", solid: true },
    { id: "vip", x: 11, y: 0, w: 5, h: 3, label: "VIP LOUNGE", lockedBelow: 5 },
    { id: "backbar", x: 0, y: 3, w: 1, h: 6 },
    { id: "counter", x: 1, y: 3, w: 1, h: 6, label: "BAR", solid: true },
    { id: "barFront", x: 2, y: 3, w: 2, h: 6 },
    { id: "dance", x: 5, y: 3, w: 6, h: 5, label: "DANCE FLOOR" },
    { id: "seating", x: 12, y: 4, w: 4, h: 5, label: "SEATING" },
    { id: "stock", x: 0, y: 9, w: 3, h: 3, label: "STOCK ROOM" },
    { id: "restroom", x: 12, y: 9, w: 4, h: 3, label: "RESTROOMS" },
    { id: "entrance", x: 6, y: 10, w: 4, h: 2, label: "ENTRANCE · ID CHECK" },
    {
      id: "queue",
      x: 6,
      y: 12,
      w: 4,
      h: 5,
      label: "STREET · QUEUE",
      outside: true,
    },
  ],
};

export const layoutFor = (level: Level): Layout =>
  level <= 2 ? booth : level === 3 ? bar : club;

/** Where a guest in a given state stands. */
export const zoneFor: Record<GuestState, ZoneId> = {
  pending: "queue",
  queue: "queue",
  idle: "seating",
  bar: "barFront",
  dance: "dance",
  left: "entrance",
};
