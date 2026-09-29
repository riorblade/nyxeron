import * as THREE from "three";
import type { Layout, Zone } from "./layouts";

/** Movable venue furniture, built from primitives. The player's arrangement is saved per layout in this browser. */
export const KINDS = ["sofa", "chair", "table", "stool", "highTable"] as const;
export type FurnitureKind = (typeof KINDS)[number];

export interface Item {
  kind: FurnitureKind;
  x: number;
  z: number;
  /** Quarter turns; 0 = the seat faces +z (toward the entrance). */
  rot: number;
}

/** Where guests sit, relative to the item's centre before rotation. */
const SEATS: Record<FurnitureKind, [number, number][]> = {
  sofa: [
    [-0.45, 0.1],
    [0, 0.1],
    [0.45, 0.1],
  ],
  chair: [[0, 0.05]],
  table: [],
  stool: [[0, 0.02]],
  highTable: [
    [-0.45, 0],
    [0.45, 0],
  ],
};

export function seatsOf(it: Item): [number, number][] {
  const a = (it.rot * Math.PI) / 2,
    c = Math.cos(a),
    s = Math.sin(a);
  // Same rotation three.js applies for rotation.y = a.
  return SEATS[it.kind].map(([x, z]) => [
    it.x + x * c + z * s,
    it.z - x * s + z * c,
  ]);
}

// ---------- defaults ----------

/** A lounge set: sofa behind a low table, two chairs across it. Takes ~2 × 2.2 tiles. */
function loungeSets(z: Zone, out: Item[]) {
  for (let cz = z.y + 1; cz + 1 <= z.y + z.h; cz += 2.4)
    for (let cx = z.x + 1; cx + 1 <= z.x + z.w; cx += 2) {
      out.push(
        { kind: "sofa", x: cx, z: cz - 0.6, rot: 0 },
        { kind: "table", x: cx, z: cz, rot: 0 },
        { kind: "chair", x: cx - 0.45, z: cz + 0.65, rot: 2 },
        { kind: "chair", x: cx + 0.45, z: cz + 0.65, rot: 2 },
      );
    }
}

export function defaultFurniture(layout: Layout): Item[] {
  const out: Item[] = [];
  const zone = (id: Zone["id"]) => layout.zones.find((z) => z.id === id);
  const seating = zone("seating");
  if (seating) {
    if (layout.name === "booth")
      for (let x = seating.x + 0.8; x < seating.x + seating.w; x += 1.5)
        for (let z = seating.y + 0.9; z < seating.y + seating.h; z += 1.6)
          out.push({ kind: "highTable", x, z, rot: 0 });
    else loungeSets(seating, out);
  }
  const vip = zone("vip");
  if (vip) loungeSets(vip, out);
  // Stools along the customer side of the counter.
  const counter = zone("counter");
  if (counter) {
    const vertical = counter.h > counter.w;
    const len = vertical ? counter.h : counter.w;
    for (let t = 0.5; t < len; t += 0.85)
      out.push(
        vertical
          ? {
              kind: "stool",
              x: counter.x + counter.w + 0.3,
              z: counter.y + t,
              rot: 0,
            }
          : {
              kind: "stool",
              x: counter.x + t,
              z: counter.y + counter.h + 0.3,
              rot: 0,
            },
      );
  }
  return out;
}

// ---------- persistence ----------

const key = (layout: Layout) => `nyxeron.furniture.${layout.name}`;

export function loadFurniture(layout: Layout): Item[] {
  try {
    const raw = localStorage.getItem(key(layout));
    if (!raw) return defaultFurniture(layout);
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return defaultFurniture(layout);
    return list.filter(
      (i): i is Item =>
        !!i &&
        KINDS.includes(i.kind) &&
        [i.x, i.z, i.rot].every(Number.isFinite) &&
        i.x >= 0 &&
        i.x <= layout.w &&
        i.z >= 0 &&
        i.z <= layout.h,
    );
  } catch {
    return defaultFurniture(layout);
  }
}

export function saveFurniture(layout: Layout, items: Item[] | null) {
  try {
    if (items) localStorage.setItem(key(layout), JSON.stringify(items));
    else localStorage.removeItem(key(layout));
  } catch {
    // ponytail: storage blocked (private mode) — the layout just lasts this session.
  }
}

// ---------- models ----------

const mat = (color: number, rough = 0.7, metal = 0.1, emissive = 0) =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: metal,
    emissive,
    emissiveIntensity: emissive ? 1.4 : 0,
  });

const box = (
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y + h / 2, z);
  return o;
};
const cyl = (
  rt: number,
  rb: number,
  h: number,
  m: THREE.Material,
  y = 0,
  seg = 20,
) => {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  o.position.y = y + h / 2;
  return o;
};

/** One mesh group per kind; `accent` is the LED colour underneath. */
export function buildFurniture(
  kind: FurnitureKind,
  accent: number,
): THREE.Group {
  const g = new THREE.Group();
  const chrome = mat(0xb8b8c8, 0.25, 0.9);
  const led = mat(accent, 0.4, 0, accent);
  switch (kind) {
    case "sofa": {
      const velvet = mat(0x4b1f6e, 0.95);
      g.add(
        box(1.5, 0.08, 0.66, mat(0x151018, 0.6), 0, 0.04),
        box(1.5, 0.02, 0.02, led, 0, 0.06, 0.33), // LED strip along the front
        box(1.4, 0.16, 0.6, velvet, 0, 0.12, 0.02),
        box(1.5, 0.42, 0.16, velvet, 0, 0.12, -0.25),
        box(0.12, 0.3, 0.66, velvet, -0.69, 0.12),
        box(0.12, 0.3, 0.66, velvet, 0.69, 0.12),
      );
      break;
    }
    case "chair": {
      const leather = mat(0x7a2140, 0.6);
      g.add(
        cyl(0.03, 0.03, 0.34, chrome, 0.04),
        cyl(0.16, 0.2, 0.04, chrome),
        box(0.46, 0.1, 0.44, leather, 0, 0.36),
        box(0.46, 0.36, 0.08, leather, 0, 0.44, -0.2),
      );
      break;
    }
    case "table": {
      const top = cyl(0.38, 0.38, 0.05, mat(0x0d0b12, 0.15, 0.5), 0.34, 32);
      const rim = cyl(0.39, 0.39, 0.015, led, 0.35, 32);
      const candle = cyl(
        0.035,
        0.035,
        0.07,
        mat(0xffc46b, 0.5, 0, 0xffa030),
        0.39,
        12,
      );
      const bottle = cyl(0.03, 0.045, 0.22, mat(0x2e7d4f, 0.1, 0.2), 0.39, 12);
      bottle.position.x = 0.14;
      g.add(cyl(0.05, 0.12, 0.34, chrome), top, rim, candle, bottle);
      break;
    }
    case "stool":
      g.add(
        cyl(0.15, 0.18, 0.03, chrome),
        cyl(0.025, 0.025, 0.6, chrome, 0.03),
        cyl(0.17, 0.17, 0.07, mat(0x2a1c24, 0.6), 0.63),
        cyl(0.172, 0.172, 0.012, led, 0.63),
      );
      break;
    case "highTable":
      g.add(
        cyl(0.2, 0.22, 0.03, chrome),
        cyl(0.035, 0.035, 0.92, chrome, 0.03),
        cyl(0.32, 0.32, 0.04, mat(0x0d0b12, 0.15, 0.5), 0.95, 28),
        cyl(0.33, 0.33, 0.012, led, 0.96, 28),
      );
      break;
  }
  return g;
}
