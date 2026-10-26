// Roblox-style blocky character: rigid parts on a 12-bone skeleton, merged into ONE SkinnedMesh (one draw call per
// character, one shared material). Clothing colours the body parts; hair, hats, glasses etc. are extra blocks on the
// head/chest bones. Built in code: no model files, no rigging tools. Bind pose height is 1 (scale the root).
import * as THREE from "three";
import { RoundedBoxGeometry as RoundedBox } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { itemOf, wardrobe, type Avatar, type Item } from "@nyxeron/core";

export const BONES = [
  "root",
  "hips",
  "chest",
  "head",
  "lArm",
  "lFore",
  "rArm",
  "rFore",
  "lThigh",
  "lShin",
  "rThigh",
  "rShin",
] as const;
export type BoneName = (typeof BONES)[number];
const B = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<
  BoneName,
  number
>;

/** Bind-pose joint positions (world, height 1) and parents. */
const JOINTS: Record<
  BoneName,
  { at: [number, number, number]; parent: BoneName | null }
> = {
  root: { at: [0, 0, 0], parent: null },
  hips: { at: [0, 0.46, 0], parent: "root" },
  chest: { at: [0, 0.6, 0], parent: "hips" },
  head: { at: [0, 0.8, 0], parent: "chest" },
  lArm: { at: [0.215, 0.77, 0], parent: "chest" },
  lFore: { at: [0.215, 0.61, 0], parent: "lArm" },
  rArm: { at: [-0.215, 0.77, 0], parent: "chest" },
  rFore: { at: [-0.215, 0.61, 0], parent: "rArm" },
  lThigh: { at: [0.075, 0.46, 0], parent: "hips" },
  lShin: { at: [0.075, 0.24, 0], parent: "lThigh" },
  rThigh: { at: [-0.075, 0.46, 0], parent: "hips" },
  rShin: { at: [-0.075, 0.24, 0], parent: "rThigh" },
};

type V3 = [number, number, number];
type Geo = THREE.BufferGeometry;

/** A coloured block bound rigidly to one bone. */
function block(
  size: V3,
  at: V3,
  color: string,
  bone: BoneName,
  round = 0.012,
): Geo {
  const r = Math.min(round, ...size.map((s) => s / 2 - 0.001));
  const g: Geo =
    r > 0.002
      ? new RoundedBox(size[0], size[1], size[2], 1, r)
      : new THREE.BoxGeometry(...size);
  return finish(g, at, color, bone);
}
function cylinder(
  radius: number,
  height: number,
  at: V3,
  color: string,
  bone: BoneName,
  radiusTop = radius,
): Geo {
  return finish(
    new THREE.CylinderGeometry(radiusTop, radius, height, 10),
    at,
    color,
    bone,
  );
}
function finish(g: Geo, at: V3, color: string, bone: BoneName): Geo {
  g.translate(...at);
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute("position").count;
  const c = new THREE.Color(color);
  geo.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(),
      3,
    ),
  );
  geo.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(
      new Array(n * 4).fill(0).map((_, i) => (i % 4 ? 0 : B[bone])),
      4,
    ),
  );
  geo.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      new Array(n * 4).fill(0).map((_, i) => (i % 4 ? 0 : 1)),
      4,
    ),
  );
  geo.deleteAttribute("uv");
  return geo;
}

const ARM_W = 0.1;
const LEG_W = 0.125;

/** All the blocks for one avatar. */
function parts(a: Avatar): Geo[] {
  const skin = wardrobe.skins[a.skin];
  const get = (slot: keyof Avatar["items"]): Item | undefined =>
    a.items[slot] ? itemOf(a.items[slot]!) : undefined;
  const shirt = get("shirt");
  const pants = get("pants");
  const shoes = get("shoes");
  const hair = get("hair");
  const hat = get("hat");
  const glasses = get("glasses");
  const facial = get("facial");
  const neck = get("neck");
  const out: Geo[] = [];
  const add = (...g: Geo[]) => out.push(...g);

  // Torso.
  const top = shirt?.color ?? "#e5e5e5";
  const ss = shirt?.style;
  const torsoColor = ss === "jacket" ? (shirt!.accent ?? "#f4f4f5") : top;
  add(block([0.3, 0.33, 0.16], [0, 0.635, 0], torsoColor, "chest", 0.02));
  if (ss === "jacket")
    for (const x of [-0.085, 0.085])
      add(block([0.13, 0.335, 0.03], [x, 0.635, 0.075], top, "chest", 0.008));
  if (ss === "hoodie")
    add(block([0.22, 0.07, 0.08], [0, 0.78, -0.09], top, "chest", 0.02));
  if (ss === "tank")
    for (const x of [-0.11, 0.11])
      add(block([0.06, 0.06, 0.161], [x, 0.77, 0], skin, "chest", 0.004));
  // Hips band (belt line) in the pants colour, or the dress.
  const low = ss === "dress" ? top : (pants?.color ?? "#333");
  add(block([0.29, 0.06, 0.15], [0, 0.47, 0], low, "hips", 0.01));

  // Arms: sleeves by style.
  const longSleeve = ss === "longsleeve" || ss === "hoodie" || ss === "jacket";
  const upper = ss === "tank" || ss === "dress" ? skin : top;
  for (const [side, x] of [
    ["l", 0.215],
    ["r", -0.215],
  ] as const) {
    add(block([ARM_W, 0.17, ARM_W], [x, 0.69, 0], upper, `${side}Arm`));
    add(
      block(
        [ARM_W * 0.96, 0.13, ARM_W * 0.96],
        [x, 0.545, 0],
        longSleeve ? top : skin,
        `${side}Fore`,
      ),
    );
    add(
      block(
        [ARM_W * 0.9, 0.06, ARM_W * 0.9],
        [x, 0.455, 0],
        skin,
        `${side}Fore`,
        0.02,
      ),
    );
  }

  // Legs.
  const ps = pants?.style;
  const pc = pants?.color ?? "#333";
  for (const [side, x] of [
    ["l", 0.075],
    ["r", -0.075],
  ] as const) {
    add(
      block(
        [LEG_W, 0.22, LEG_W],
        [x, 0.35, 0],
        ps === "skirt" ? skin : pc,
        `${side}Thigh`,
      ),
    );
    add(
      block(
        [LEG_W * 0.96, 0.18, LEG_W * 0.96],
        [x, 0.15, 0],
        ps === "pants" ? pc : skin,
        `${side}Shin`,
      ),
    );
    // Shoes.
    const fc = shoes?.color ?? "#222";
    const st = shoes?.style;
    if (st === "boots")
      add(
        block(
          [LEG_W * 1.04, 0.1, LEG_W * 1.04],
          [x, 0.1, 0.005],
          fc,
          `${side}Shin`,
        ),
      );
    if (st === "heels") {
      add(
        block(
          [LEG_W * 0.9, 0.04, 0.16],
          [x, 0.03, 0.025],
          fc,
          `${side}Shin`,
          0.01,
        ),
      );
      add(
        block([0.02, 0.035, 0.02], [x, 0.0175, -0.045], fc, `${side}Shin`, 0),
      );
    } else {
      add(
        block(
          [LEG_W * 1.02, 0.06, 0.17],
          [x, 0.03, 0.02],
          fc,
          `${side}Shin`,
          0.015,
        ),
      );
      if (st === "sneakers")
        add(
          block(
            [LEG_W * 1.03, 0.015, 0.172],
            [x, 0.008, 0.02],
            shoes!.accent ?? "#fff",
            `${side}Shin`,
            0,
          ),
        );
    }
  }
  if (ps === "skirt" || ss === "dress")
    add(
      cylinder(
        0.2,
        0.17,
        [0, 0.38, 0],
        ss === "dress" ? top : pc,
        "hips",
        0.155,
      ),
    );

  // Head and face.
  add(block([0.19, 0.19, 0.18], [0, 0.9, 0], skin, "head", 0.035));
  add(block([0.07, 0.04, 0.07], [0, 0.805, 0], skin, "head", 0.01)); // neck
  for (const x of [-0.042, 0.042])
    add(block([0.024, 0.03, 0.01], [x, 0.915, 0.09], "#1b1b1f", "head", 0.004));
  add(block([0.05, 0.012, 0.01], [0, 0.86, 0.09], "#7a3b33", "head", 0.003));

  // Hair (a hat hides the top layer).
  if (hair) {
    const hc = hair.color;
    const h = hair.style;
    const onTop = !hat || h === "afro";
    if (h === "buzz" && onTop)
      add(block([0.196, 0.025, 0.186], [0, 0.99, 0], hc, "head", 0.01));
    if (h === "short" || h === "bun" || h === "bob" || h === "long") {
      if (onTop)
        add(block([0.205, 0.05, 0.195], [0, 0.99, -0.002], hc, "head", 0.02));
      add(block([0.2, 0.12, 0.04], [0, 0.93, -0.083], hc, "head", 0.015));
    }
    if (h === "bob")
      for (const x of [-0.1, 0.1])
        add(block([0.03, 0.13, 0.17], [x, 0.91, -0.005], hc, "head", 0.012));
    if (h === "long") {
      add(block([0.21, 0.23, 0.045], [0, 0.84, -0.09], hc, "head", 0.02));
      for (const x of [-0.1, 0.1])
        add(block([0.03, 0.16, 0.12], [x, 0.89, -0.03], hc, "head", 0.012));
    }
    if (h === "bun" && onTop)
      add(block([0.08, 0.07, 0.08], [0, 1.04, -0.04], hc, "head", 0.03));
    if (h === "mohawk" && onTop)
      add(block([0.045, 0.09, 0.19], [0, 1.03, -0.005], hc, "head", 0.012));
    if (h === "afro")
      add(block([0.28, 0.17, 0.26], [0, 0.99, -0.02], hc, "head", 0.07));
  }

  // Hats.
  if (hat) {
    const c = hat.color;
    const lift = hair?.style === "afro" ? 0.07 : 0;
    if (hat.style === "cap") {
      add(block([0.205, 0.06, 0.195], [0, 1.005 + lift, 0], c, "head", 0.025));
      add(
        block([0.17, 0.015, 0.09], [0, 0.985 + lift, 0.12], c, "head", 0.006),
      );
    }
    if (hat.style === "beanie")
      add(block([0.21, 0.085, 0.2], [0, 1.01 + lift, 0], c, "head", 0.035));
    if (hat.style === "bucket") {
      add(cylinder(0.16, 0.02, [0, 0.975 + lift, 0], c, "head"));
      add(cylinder(0.11, 0.07, [0, 1.02 + lift, 0], c, "head", 0.1));
    }
    if (hat.style === "tophat") {
      add(cylinder(0.15, 0.015, [0, 0.995 + lift, 0], c, "head"));
      add(cylinder(0.085, 0.15, [0, 1.075 + lift, 0], c, "head"));
      add(
        cylinder(
          0.087,
          0.025,
          [0, 1.015 + lift, 0],
          hat.accent ?? "#ff2bd6",
          "head",
        ),
      );
    }
  }

  // Glasses, facial hair, neck.
  if (glasses?.style === "shades")
    add(
      block(
        [0.17, 0.045, 0.02],
        [0, 0.915, 0.097],
        glasses.color,
        "head",
        0.008,
      ),
    );
  if (glasses?.style === "round") {
    for (const x of [-0.045, 0.045])
      add(
        block(
          [0.055, 0.045, 0.012],
          [x, 0.915, 0.098],
          glasses.color,
          "head",
          0.01,
        ),
      );
    add(block([0.04, 0.008, 0.01], [0, 0.92, 0.098], glasses.color, "head", 0));
  }
  if (facial?.style === "moustache")
    add(
      block(
        [0.075, 0.018, 0.016],
        [0, 0.875, 0.094],
        facial.color,
        "head",
        0.006,
      ),
    );
  if (facial?.style === "beard") {
    add(
      block([0.195, 0.07, 0.04], [0, 0.835, 0.075], facial.color, "head", 0.02),
    );
    add(
      block(
        [0.075, 0.018, 0.016],
        [0, 0.875, 0.094],
        facial.color,
        "head",
        0.006,
      ),
    );
  }
  if (neck?.style === "chain")
    add(
      block([0.12, 0.012, 0.012], [0, 0.73, 0.085], neck.color, "chest", 0.004),
    );
  if (neck?.style === "bowtie")
    for (const x of [-0.022, 0.022])
      add(
        block(
          [0.04, 0.03, 0.02],
          [x, 0.785, 0.085],
          neck.color,
          "chest",
          0.006,
        ),
      );
  return out;
}

/**
 * The characters' material (vertex colours). They glow a little on their own, like the painted sprites they
 * replace, so a dim club never turns them into silhouettes; lights still shape them. `color` tints the whole body.
 */
export function avatarMaterial(glow = 0.55) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * ${glow.toFixed(2)};`,
    );
  };
  return m;
}
const shared = avatarMaterial(0.15);

export interface Rig {
  mesh: THREE.SkinnedMesh;
  bones: Record<BoneName, THREE.Bone>;
  /** Bind-pose local positions, so poses can offset and reset them. */
  rest: Record<BoneName, THREE.Vector3>;
  dispose(): void;
}

/** Builds a character. Add `rig.mesh` to the scene and drive `rig.bones` (see moves.ts). */
export function buildRig(a: Avatar): Rig {
  const geo = mergeGeometries(parts(a))!;
  geo.computeBoundingSphere();
  const bones = {} as Record<BoneName, THREE.Bone>;
  const rest = {} as Record<BoneName, THREE.Vector3>;
  for (const name of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    const { at, parent } = JOINTS[name];
    const p: V3 = parent ? JOINTS[parent].at : [0, 0, 0];
    b.position.set(at[0] - p[0], at[1] - p[1], at[2] - p[2]);
    rest[name] = b.position.clone();
    if (parent) bones[parent].add(b);
    bones[name] = b;
  }
  const mesh = new THREE.SkinnedMesh(geo, shared);
  mesh.add(bones.root);
  mesh.bind(new THREE.Skeleton(BONES.map((n) => bones[n])));
  mesh.frustumCulled = false; // bones move the parts outside the bind-pose bounds
  return { mesh, bones, rest, dispose: () => geo.dispose() };
}
