// A guest walking the club themselves (WASD / joystick). Pure functions: the local step, the room's bounds and
// blockers, and the host's check on what a player claims (bounded, and no faster than running). Cosmetic only:
// positions never touch the game state, money or tokens.
import type { Layout } from "@/venue/layouts";
import { EMOTES, type Emote } from "./moves";

export interface Room {
  w: number;
  h: number;
  /** Counters, booths, the pool: walked around, not through. */
  blocks: { x: number; z: number; w: number; h: number }[];
}

export interface Roam {
  x: number;
  z: number;
  /** Facing (radians; 0 = +z). */
  yaw: number;
  /** The dance they picked (null = just standing). */
  emote: Emote | null;
  moving: boolean;
}

/** The walkable floor of a club layout: the room, minus counters, booths and the pool. */
export const roomOf = (l: Layout): Room => ({
  w: l.w,
  h: l.h,
  blocks: l.zones
    .filter((z) => (z.solid || z.id === "pool") && !z.outside && !z.elevation)
    .map((z) => ({ x: z.x, z: z.y, w: z.w, h: z.h })),
});

export const WALK = 1.6; // m/s, in the club's units
export const RUN = 3.2;
const MARGIN = 0.18;
const RADIUS = 0.14;

/** Keeps a point inside the room and outside every blocker (pushed out the nearest side). */
export function clampToRoom(
  x: number,
  z: number,
  room: Room,
): [number, number] {
  x = Math.min(room.w - MARGIN, Math.max(MARGIN, x));
  z = Math.min(room.h - MARGIN, Math.max(MARGIN, z));
  for (const b of room.blocks) {
    const l = b.x - RADIUS,
      r = b.x + b.w + RADIUS,
      t = b.z - RADIUS,
      d = b.z + b.h + RADIUS;
    if (x <= l || x >= r || z <= t || z >= d) continue;
    const out = [x - l, r - x, z - t, d - z];
    const k = out.indexOf(Math.min(...out));
    if (k === 0) x = l;
    else if (k === 1) x = r;
    else if (k === 2) z = t;
    else z = d;
  }
  return [x, z];
}

/**
 * One frame of walking: `fwd`/`side` in −1…1 (stick or keys), relative to where the camera looks (`camYaw`).
 * Walking faces the way you go; standing keeps the last facing.
 */
export function stepRoam(
  r: Roam,
  input: { fwd: number; side: number; run: boolean },
  camYaw: number,
  dtMs: number,
  room: Room,
): Roam {
  const len = Math.hypot(input.fwd, input.side);
  if (len < 0.08) return r.moving ? { ...r, moving: false } : r;
  const f = input.fwd / Math.max(1, len);
  const s = input.side / Math.max(1, len);
  // Camera forward is (sin yaw, cos yaw) on the floor; its right is (−cos yaw, sin yaw).
  const dx = Math.sin(camYaw) * f - Math.cos(camYaw) * s;
  const dz = Math.cos(camYaw) * f + Math.sin(camYaw) * s;
  const speed = (input.run ? RUN : WALK) * (dtMs / 1000);
  const [x, z] = clampToRoom(r.x + dx * speed, r.z + dz * speed, room);
  return { x, z, yaw: Math.atan2(dx, dz), emote: r.emote, moving: true };
}

/**
 * The host's check on a player's claimed position: inside the room, and no further from the last accepted one
 * than running allows (plus slack for jitter). A jump is cut short along the way, never teleported.
 */
export function acceptRoam(
  prev: Roam | undefined,
  next: Roam,
  dtMs: number,
  room: Room,
): Roam {
  const ok = Number.isFinite(next.x) && Number.isFinite(next.z);
  let [x, z] = clampToRoom(
    ok ? next.x : (prev?.x ?? room.w / 2),
    ok ? next.z : (prev?.z ?? room.h / 2),
    room,
  );
  if (prev) {
    const max = RUN * 1.5 * (Math.min(2000, Math.max(0, dtMs)) / 1000) + 0.05;
    const d = Math.hypot(x - prev.x, z - prev.z);
    if (d > max) {
      x = prev.x + ((x - prev.x) / d) * max;
      z = prev.z + ((z - prev.z) / d) * max;
      [x, z] = clampToRoom(x, z, room);
    }
  }
  const yaw = Number.isFinite(next.yaw)
    ? Math.atan2(Math.sin(next.yaw), Math.cos(next.yaw))
    : 0;
  const emote =
    typeof next.emote === "string" &&
    (EMOTES as readonly string[]).includes(next.emote)
      ? next.emote
      : null;
  return { x, z, yaw, emote, moving: !!next.moving };
}
