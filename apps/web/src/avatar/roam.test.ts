import { describe, expect, it } from "vitest";
import {
  acceptRoam,
  clampToRoom,
  RUN,
  stepRoam,
  WALK,
  type Roam,
  type Room,
} from "./roam";

const room: Room = { w: 10, h: 8, blocks: [{ x: 4, z: 3, w: 2, h: 2 }] };
const at = (x: number, z: number): Roam => ({
  x,
  z,
  yaw: 0,
  emote: null,
  moving: false,
});

describe("roam", () => {
  it("stays in the room and out of blockers", () => {
    expect(clampToRoom(-5, 99, room)).toEqual([0.18, 8 - 0.18]);
    const [x, z] = clampToRoom(4.3, 4, room); // just inside the block's left edge
    expect(x).toBeCloseTo(4 - 0.14);
    expect(z).toBe(4);
  });

  it("walks relative to the camera, at walking or running speed, and faces the way it goes", () => {
    const a = stepRoam(
      at(2, 2),
      { fwd: 1, side: 0, run: false },
      0,
      1000,
      room,
    );
    expect(a.z).toBeCloseTo(2 + WALK);
    expect(a.x).toBeCloseTo(2);
    expect(a.moving).toBe(true);
    const b = stepRoam(
      at(2, 2),
      { fwd: 1, side: 0, run: true },
      Math.PI / 2,
      500,
      room,
    );
    expect(b.x).toBeCloseTo(2 + RUN / 2);
    expect(b.yaw).toBeCloseTo(Math.PI / 2);
    const still = stepRoam(
      { ...a },
      { fwd: 0, side: 0, run: false },
      0,
      16,
      room,
    );
    expect(still.moving).toBe(false);
    expect(still.yaw).toBe(a.yaw);
  });

  it("the host cuts a teleport short and rejects junk", () => {
    const prev = at(1, 1);
    const r = acceptRoam(prev, { ...at(9, 7), moving: true }, 125, room);
    expect(Math.hypot(r.x - 1, r.z - 1)).toBeLessThanOrEqual(
      RUN * 1.5 * 0.125 + 0.051,
    );
    const junk = acceptRoam(
      prev,
      { x: NaN, z: Infinity, yaw: NaN, emote: "hack" as never, moving: true },
      125,
      room,
    );
    expect([junk.x, junk.z, junk.yaw, junk.emote]).toEqual([1, 1, 0, null]);
    expect(
      acceptRoam(undefined, { ...at(3, 3), emote: "pump" }, 0, room).emote,
    ).toBe("pump");
  });
});
