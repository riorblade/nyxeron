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
  | "office"
  | "pool"
  | "deck";

/** How the default furniture fills a seating area. */
export type FurnitureStyle =
  | "lounge" // sofa + low table + chairs
  | "vip" // sofa booths facing the DJ
  | "high" // high tables (near the dance floor)
  | "tables" // table + chairs (edges and corners)
  | "cabana"; // daybeds around the pool

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
  /** Raised floor (mezzanine / balcony) at this height, with railing and stairs. */
  elevation?: number;
  furniture?: FurnitureStyle;
}

/**
 * A landscape video screen on a wall. `at` = centre along the wall (x for n/s walls, z for w/e walls).
 * clip = dancer clips / club footage, ad = sponsor slot. Clip screens are 3 wide, ads 2.6.
 */
export interface ScreenSlot {
  wall: "n" | "w" | "e" | "s";
  at: number;
  kind: "clip" | "ad";
}

export interface Layout {
  /** Key for the player's saved furniture arrangement. */
  name: "booth" | "bar" | "club" | "superclub";
  w: number;
  h: number;
  /** Indoor hall depth when the rest (south) is an open-air deck; walls stop there. */
  hall?: number;
  /** Wall height (default 3.2); a superclub has a double-height hall. */
  wallHeight?: number;
  /** Span of the concert screen behind the DJ along the back wall (default: over the stage + DJ booth). */
  mainScreen?: { from: number; to: number };
  zones: Zone[];
  screens: ScreenSlot[];
}

/** Level 1–2: a drink booth on the street. */
const booth: Layout = {
  name: "booth",
  w: 8,
  h: 7,
  screens: [
    { wall: "n", at: 6.4, kind: "clip" },
    { wall: "w", at: 5, kind: "clip" },
    { wall: "e", at: 3, kind: "ad" },
    { wall: "s", at: 2.5, kind: "clip" },
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
    { wall: "n", at: 10.4, kind: "clip" },
    { wall: "e", at: 1.6, kind: "clip" },
    { wall: "e", at: 4.5, kind: "ad" },
    { wall: "e", at: 7.4, kind: "clip" },
    { wall: "s", at: 2.5, kind: "clip" },
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

/**
 * Level 4 "The Basement" nightclub. VIP booths flank the DJ (side view) and face it across the floor (front view);
 * high tables ring the dance floor, plain tables on the edges and corners, stools along the bar.
 */
const club: Layout = {
  name: "club",
  w: 20,
  h: 15,
  screens: [
    { wall: "n", at: 1.5, kind: "clip" },
    { wall: "n", at: 17.5, kind: "ad" },
    { wall: "w", at: 1.3, kind: "clip" },
    { wall: "w", at: 13, kind: "clip" },
    { wall: "e", at: 5, kind: "clip" },
    { wall: "e", at: 8.4, kind: "clip" },
    { wall: "e", at: 12.3, kind: "ad" },
    { wall: "s", at: 4, kind: "clip" },
    { wall: "s", at: 16, kind: "ad" },
  ],
  zones: [
    { id: "office", x: 0, y: 0, w: 3, h: 2, label: "CEO OFFICE" },
    { id: "vip", x: 3, y: 0, w: 5, h: 3, label: "VIP", furniture: "vip" },
    { id: "dj", x: 8, y: 0, w: 4, h: 2, label: "DJ BOOTH", solid: true },
    { id: "stage", x: 12, y: 0, w: 3, h: 2, label: "STAGE", solid: true },
    { id: "vip", x: 15, y: 0, w: 5, h: 3, label: "VIP", furniture: "vip" },
    { id: "backbar", x: 0, y: 3, w: 1, h: 8 },
    { id: "counter", x: 1, y: 3, w: 1, h: 8, label: "BAR", solid: true },
    { id: "barFront", x: 2, y: 3, w: 2, h: 8 },
    { id: "seating", x: 4, y: 3, w: 3, h: 7, furniture: "high" },
    { id: "dance", x: 7, y: 3, w: 7, h: 6, label: "DANCE FLOOR" },
    { id: "seating", x: 14, y: 3, w: 3, h: 7, furniture: "high" },
    {
      id: "seating",
      x: 17,
      y: 3,
      w: 3,
      h: 9,
      label: "TABLES",
      furniture: "tables",
    },
    {
      id: "vip",
      x: 7,
      y: 10,
      w: 7,
      h: 2,
      label: "VIP · FRONT ROW",
      furniture: "vip",
    },
    { id: "stock", x: 0, y: 11, w: 3, h: 4, label: "STOCK ROOM" },
    {
      id: "seating",
      x: 3,
      y: 11,
      w: 4,
      h: 4,
      label: "TABLES",
      furniture: "tables",
    },
    { id: "restroom", x: 17, y: 12, w: 3, h: 3, label: "RESTROOMS" },
    { id: "entrance", x: 8, y: 13, w: 4, h: 2, label: "ENTRANCE · ID CHECK" },
    {
      id: "queue",
      x: 8,
      y: 15,
      w: 4,
      h: 5,
      label: "STREET · QUEUE",
      outside: true,
    },
  ],
};

/**
 * Level 5 "Premium Venue": a two-level superclub opening onto a pool deck and the sea. VIP balconies hang either side
 * of the DJ over the floor; bars on both walls; cabanas around the pool.
 */
const superclub: Layout = {
  name: "superclub",
  w: 30,
  h: 26,
  hall: 16,
  wallHeight: 8,
  mainScreen: { from: 9, to: 21 },
  screens: [
    { wall: "n", at: 2, kind: "clip" },
    { wall: "n", at: 28, kind: "clip" },
    { wall: "w", at: 1.8, kind: "ad" },
    { wall: "w", at: 6, kind: "clip" },
    { wall: "w", at: 10, kind: "clip" },
    { wall: "e", at: 1.8, kind: "ad" },
    { wall: "e", at: 6, kind: "clip" },
    { wall: "e", at: 10, kind: "clip" },
    { wall: "e", at: 14, kind: "ad" },
  ],
  zones: [
    { id: "office", x: 0, y: 0, w: 4, h: 3, label: "CEO OFFICE" },
    {
      id: "vip",
      x: 4,
      y: 0,
      w: 7,
      h: 4,
      label: "VIP BALCONY",
      elevation: 2,
      furniture: "vip",
    },
    { id: "stage", x: 11, y: 0, w: 2, h: 3, label: "STAGE", solid: true },
    { id: "dj", x: 13, y: 0, w: 4, h: 3, label: "DJ", solid: true },
    {
      id: "vip",
      x: 19,
      y: 0,
      w: 7,
      h: 4,
      label: "VIP BALCONY",
      elevation: 2,
      furniture: "vip",
    },
    { id: "stock", x: 26, y: 0, w: 4, h: 3, label: "STOCK" },
    { id: "backbar", x: 0, y: 4, w: 1, h: 7 },
    { id: "counter", x: 1, y: 4, w: 1, h: 7, label: "WEST BAR", solid: true },
    { id: "barFront", x: 2, y: 4, w: 2, h: 7 },
    { id: "backbar", x: 29, y: 4, w: 1, h: 7 },
    { id: "counter", x: 28, y: 4, w: 1, h: 7, label: "EAST BAR", solid: true },
    { id: "barFront", x: 26, y: 4, w: 2, h: 7 },
    { id: "seating", x: 4, y: 5, w: 4, h: 8, furniture: "high" },
    { id: "dance", x: 8, y: 5, w: 14, h: 9, label: "MAIN FLOOR" },
    { id: "seating", x: 22, y: 5, w: 4, h: 8, furniture: "high" },
    { id: "entrance", x: 0, y: 12, w: 2, h: 3, label: "ENTRANCE" },
    {
      id: "queue",
      x: -6,
      y: 11,
      w: 6,
      h: 5,
      label: "STREET · QUEUE",
      outside: true,
    },
    { id: "restroom", x: 26, y: 12, w: 4, h: 4, label: "RESTROOMS" },
    { id: "deck", x: 0, y: 16, w: 30, h: 10, outside: true },
    {
      id: "seating",
      x: 1,
      y: 17,
      w: 6,
      h: 8,
      label: "CABANAS",
      furniture: "cabana",
    },
    { id: "pool", x: 9, y: 18, w: 12, h: 5, label: "POOL" },
    {
      id: "seating",
      x: 23,
      y: 17,
      w: 6,
      h: 8,
      label: "CABANAS",
      furniture: "cabana",
    },
    { id: "dance", x: 9, y: 16, w: 12, h: 2, label: "POOLSIDE" },
  ],
};

export const layoutFor = (level: Level): Layout =>
  level <= 2 ? booth : level === 3 ? bar : level === 4 ? club : superclub;

/** Where a guest in a given state stands. */
export const zoneFor: Record<GuestState, ZoneId> = {
  pending: "queue",
  queue: "queue",
  idle: "seating",
  bar: "barFront",
  dance: "dance",
  left: "entrance",
};
