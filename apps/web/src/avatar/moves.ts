// Dance and idle moves as poses computed from the beat: no animation files, every guest gets its own move, tempo
// offset and energy from a seed, so a crowd never moves in lockstep. Angles in radians; arms and legs hang down
// (-y) in the bind pose, so a negative X rotation swings a limb forward, a positive Z lifts the left arm out.
import type { BoneName, Rig } from "./rig";

export const DANCES = [
  "bounce",
  "pump",
  "sway",
  "handsUp",
  "twoStep",
  "groove",
  "shuffle",
  "jump",
] as const;
export type Dance = (typeof DANCES)[number];
/** Shop moves (core wardrobe.json → celebrations): the hands throw cash or token coins (showers.ts). */
export const CELEBRATIONS = ["makeItRain", "tokenToss"] as const;
export type Celebration = (typeof CELEBRATIONS)[number];
/** What a player can pick to do: a dance, or a celebration they own. */
export const EMOTES = [...DANCES, ...CELEBRATIONS] as const;
export type Emote = (typeof EMOTES)[number];
export const isCelebration = (m: string): m is Celebration =>
  (CELEBRATIONS as readonly string[]).includes(m);
export type Move = Emote | "idle" | "walk";

type Pose = Partial<Record<BoneName, [number, number, number]>>;
const TAU = Math.PI * 2;

/** A pose for `move` at beat `b` (1 = one beat), with `e` energy 0–1 (how big the moves are). */
function pose(
  move: Move,
  b: number,
  e: number,
): { pose: Pose; lift: number; sway: number } {
  const ph = b * TAU;
  const s = Math.sin(ph);
  const half = Math.sin(ph / 2);
  const bob = (1 - Math.cos(ph)) / 2; // 0..1 on every beat
  const knee = 0.25 + 0.35 * e;
  const legsBounce: Pose = {
    lThigh: [-knee * bob * 0.6, 0, 0],
    rThigh: [-knee * bob * 0.6, 0, 0],
    lShin: [knee * bob * 1.1, 0, 0],
    rShin: [knee * bob * 1.1, 0, 0],
  };
  const drop = -0.035 * e * bob;
  switch (move) {
    case "idle":
      return {
        pose: {
          chest: [0.02 * Math.sin(ph / 4), 0, 0],
          lArm: [0, 0, 0.06],
          rArm: [0, 0, -0.06],
          lFore: [-0.15, 0, 0],
          rFore: [-0.15, 0, 0],
          head: [0, 0.15 * Math.sin(ph / 8), 0],
        },
        lift: 0,
        sway: 0,
      };
    case "walk":
      return {
        pose: {
          lThigh: [0.55 * s, 0, 0],
          rThigh: [-0.55 * s, 0, 0],
          lShin: [0.5 * Math.max(0, -s), 0, 0],
          rShin: [0.5 * Math.max(0, s), 0, 0],
          lArm: [-0.45 * s, 0, 0.05],
          rArm: [0.45 * s, 0, -0.05],
          lFore: [-0.3, 0, 0],
          rFore: [-0.3, 0, 0],
        },
        lift: 0.012 * Math.abs(s),
        sway: 0,
      };
    case "bounce":
      return {
        pose: {
          ...legsBounce,
          lArm: [-0.4 * s * e, 0, 0.15],
          rArm: [0.4 * s * e, 0, -0.15],
          lFore: [-1.1, 0, 0],
          rFore: [-1.1, 0, 0],
          head: [0.12 * bob, 0, 0],
          chest: [0.08 * bob, 0, 0],
        },
        lift: drop,
        sway: 0,
      };
    case "pump":
      return {
        pose: {
          ...legsBounce,
          rArm: [0, 0, -2.75],
          rFore: [-0.4 - 0.7 * bob, 0, 0],
          lArm: [-0.3, 0, 0.2],
          lFore: [-1.2, 0, 0],
          head: [0.15 * bob, 0, 0.1],
          chest: [0.05 * bob, 0.15, 0],
        },
        lift: drop,
        sway: 0,
      };
    case "sway":
      return {
        pose: {
          chest: [0, 0.2 * half, 0.12 * half],
          head: [0, -0.15 * half, -0.12 * half],
          lArm: [-0.2, 0, 0.35 + 0.2 * half],
          rArm: [-0.2, 0, -0.35 + 0.2 * half],
          lFore: [-0.9, 0, 0],
          rFore: [-0.9, 0, 0],
          lThigh: [-0.15 * Math.max(0, half), 0, 0],
          rThigh: [-0.15 * Math.max(0, -half), 0, 0],
          lShin: [0.3 * Math.max(0, half), 0, 0],
          rShin: [0.3 * Math.max(0, -half), 0, 0],
        },
        lift: 0,
        sway: 0.035 * half,
      };
    case "handsUp":
      return {
        pose: {
          ...legsBounce,
          lArm: [0, 0, 2.7 + 0.25 * half],
          rArm: [0, 0, -2.7 + 0.25 * half],
          lFore: [-0.25, 0, 0],
          rFore: [-0.25, 0, 0],
          head: [-0.2 + 0.1 * bob, 0, 0],
          chest: [-0.06, 0, 0.08 * half],
        },
        lift: drop,
        sway: 0.02 * half,
      };
    case "twoStep": {
      const l = Math.max(0, half);
      const r = Math.max(0, -half);
      return {
        pose: {
          lThigh: [-0.7 * l * e, 0, 0],
          lShin: [1.0 * l * e, 0, 0],
          rThigh: [-0.7 * r * e, 0, 0],
          rShin: [1.0 * r * e, 0, 0],
          lArm: [0.35 * half, 0, 0.2],
          rArm: [-0.35 * half, 0, -0.2],
          lFore: [-1.3, 0, 0],
          rFore: [-1.3, 0, 0],
          chest: [0.05, 0.12 * half, 0],
          head: [0.1 * bob, 0, 0],
        },
        lift: 0.015 * (l + r),
        sway: 0.03 * half,
      };
    }
    case "groove":
      return {
        pose: {
          ...legsBounce,
          chest: [0.06 * bob, 0.28 * s, 0],
          hips: [0, -0.12 * s, 0],
          lArm: [-0.5, 0, 0.25],
          rArm: [-0.5, 0, -0.25],
          lFore: [-1.4 + 0.3 * s, 0, 0],
          rFore: [-1.4 - 0.3 * s, 0, 0],
          head: [0.15 * bob, -0.2 * s, 0],
        },
        lift: drop,
        sway: 0,
      };
    case "shuffle": {
      const k = Math.sin(ph * 2);
      return {
        pose: {
          lThigh: [-0.5 * Math.max(0, k), 0, 0.1],
          rThigh: [-0.5 * Math.max(0, -k), 0, -0.1],
          lShin: [0.3 * Math.max(0, k), 0, 0],
          rShin: [0.3 * Math.max(0, -k), 0, 0],
          lArm: [-0.6 * s, 0, 0.3],
          rArm: [0.6 * s, 0, -0.3],
          lFore: [-0.8, 0, 0],
          rFore: [-0.8, 0, 0],
          chest: [0.1, 0, 0],
        },
        lift: 0.02 * Math.abs(k),
        sway: 0.02 * s,
      };
    }
    case "makeItRain": {
      // Left hand holds the stack at the chest; the right sweeps bills off it and flings them out, twice a beat.
      const u = (((b * 2) % 1) + 1) % 1;
      const out = u < 0.3 ? u / 0.3 : 1 - (u - 0.3) / 0.7; // fast fling, slow return
      return {
        pose: {
          ...legsBounce,
          lArm: [-1.05, 0, 0.12],
          lFore: [-1.15, 0, 0],
          rArm: [-1.0 - 0.35 * out, 0, 0.35 - 1.35 * out],
          rFore: [-1.1 + 0.9 * out, 0, 0],
          chest: [0.06 * bob, -0.25 * out + 0.1, 0],
          head: [0.1 * bob, -0.3 * out + 0.15, 0],
        },
        lift: drop,
        sway: 0,
      };
    }
    case "tokenToss": {
      // Scoop low, then throw both hands up: a burst of token coins every two beats.
      const u = (((b / 2) % 1) + 1) % 1;
      const scoop = u < 0.5 ? Math.sin((u / 0.5) * Math.PI * 0.5) : 0;
      const up =
        u < 0.5
          ? 0
          : u < 0.62
            ? (u - 0.5) / 0.12
            : 1 - ((u - 0.62) / 0.38) * 0.7;
      const crouch = scoop * 0.8;
      return {
        pose: {
          lThigh: [-0.6 * crouch, 0, 0],
          rThigh: [-0.6 * crouch, 0, 0],
          lShin: [1.1 * crouch, 0, 0],
          rShin: [1.1 * crouch, 0, 0],
          chest: [0.35 * crouch - 0.12 * up, 0, 0],
          lArm: [-0.5 * scoop - 2.7 * up, 0, 0.15 + 0.35 * up],
          rArm: [-0.5 * scoop - 2.7 * up, 0, -0.15 - 0.35 * up],
          lFore: [-0.5 * scoop - 0.2, 0, 0],
          rFore: [-0.5 * scoop - 0.2, 0, 0],
          head: [0.2 * crouch - 0.3 * up, 0, 0],
        },
        lift: -0.07 * crouch + 0.03 * up,
        sway: 0,
      };
    }
    case "jump": {
      const up = Math.max(0, Math.sin(ph));
      return {
        pose: {
          lArm: [0, 0, 2.6 * up + 0.2],
          rArm: [0, 0, -2.6 * up - 0.2],
          lFore: [-0.3, 0, 0],
          rFore: [-0.3, 0, 0],
          lThigh: [-0.3 * (1 - up), 0, 0],
          rThigh: [-0.3 * (1 - up), 0, 0],
          lShin: [0.6 * (1 - up), 0, 0],
          rShin: [0.6 * (1 - up), 0, 0],
          head: [-0.15 * up, 0, 0],
        },
        lift: 0.09 * up * e - 0.02 * (1 - up),
        sway: 0,
      };
    }
  }
}

/** What leaves the hands between beat `from` and `to` (a frame): bills from the right hand twice a beat, or a burst
 *  of coins from both hands at the top of each throw. */
export function throwsBetween(
  move: Move,
  from: number,
  to: number,
): { kind: "bill" | "coin"; hands: ("l" | "r")[]; n: number }[] {
  const crossed = (period: number, at: number) =>
    to > from &&
    Math.floor((to - at * period) / period) >
      Math.floor((from - at * period) / period);
  if (move === "makeItRain" && crossed(0.5, 0.28))
    return [{ kind: "bill", hands: ["r"], n: 4 }];
  if (move === "tokenToss" && crossed(2, 0.6))
    return [{ kind: "coin", hands: ["l", "r"], n: 7 }];
  return [];
}

/** Puts `rig` in `move` at beat `b`. Every bone not in the pose goes back to rest. */
export function applyMove(rig: Rig, move: Move, b: number, energy = 0.7) {
  const { pose: p, lift, sway } = pose(move, b, energy);
  for (const name of Object.keys(rig.bones) as BoneName[]) {
    const bone = rig.bones[name];
    const r = p[name];
    if (r) bone.rotation.set(r[0], r[1], r[2]);
    else bone.rotation.set(0, 0, 0);
  }
  const hips = rig.bones.hips;
  hips.position.copy(rig.rest.hips);
  hips.position.y += lift;
  hips.position.x += sway;
}

/** A guest's own dance, tempo offset and energy, stable per seed. */
export function styleFor(seed: number) {
  const h = (n: number) => {
    const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    dance: DANCES[Math.floor(h(1) * DANCES.length)]!,
    offset: h(2),
    energy: 0.5 + 0.5 * h(3),
    /** Changes move every 8–16 beats. */
    every: 8 + Math.floor(h(4) * 9),
  };
}

/** The move a seeded guest is doing at beat `b` (it changes moves now and then). */
export function danceAt(
  seed: number,
  b: number,
): { move: Dance; beat: number; energy: number } {
  const st = styleFor(seed);
  const beat = b + st.offset;
  const round = Math.floor(beat / st.every);
  const move =
    round === 0
      ? st.dance
      : DANCES[
          Math.floor(
            ((Math.sin((seed + round) * 91.7) + 1) / 2) * DANCES.length,
          ) % DANCES.length
        ]!;
  return { move, beat, energy: st.energy };
}
