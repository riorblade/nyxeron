import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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

/** Quarter turn that points an item's front (+z at rot 0) from (x, z) toward (tx, tz). */
function facing(x: number, z: number, tx: number, tz: number): number {
  const dx = tx - x,
    dz = tz - z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}
/** Unit vector of a quarter turn's front, and of its right-hand side. */
const fwd = (rot: number): [number, number] =>
  [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ][rot]! as [number, number];

/**
 * Fill a zone with repeating "cells" laid out along the direction everything faces (depth) and across it (width);
 * `cell` puts the items for one cell centred at (cx, cz).
 */
function grid(
  z: Zone,
  rot: number,
  depth: number,
  width: number,
  cell: (cx: number, cz: number, out: Item[]) => void,
  out: Item[],
) {
  const alongX = rot === 1 || rot === 3; // facing ±x: rows run along z
  const [dw, dd] = alongX ? [z.h, z.w] : [z.w, z.h];
  const nw = Math.max(1, Math.floor(dw / width));
  const nd = Math.max(1, Math.floor(dd / depth));
  for (let a = 0; a < nw; a++)
    for (let b = 0; b < nd; b++) {
      const u = (a + 0.5) * (dw / nw); // across
      const v = (b + 0.5) * (dd / nd); // depth
      const [cx, cz] = alongX ? [z.x + v, z.y + u] : [z.x + u, z.y + v];
      cell(cx, cz, out);
    }
}

/** Sofa booth facing `rot`: sofa behind, low table in front. */
const booth = (rot: number) => (cx: number, cz: number, out: Item[]) => {
  const [fx, fz] = fwd(rot);
  out.push(
    { kind: "sofa", x: cx - fx * 0.45, z: cz - fz * 0.45, rot },
    { kind: "table", x: cx + fx * 0.5, z: cz + fz * 0.5, rot },
  );
};

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
  const first = (id: Zone["id"]) => layout.zones.find((z) => z.id === id);
  const center = (z: Zone | undefined): [number, number] | null =>
    z ? [z.x + z.w / 2, z.y + z.h / 2] : null;
  const dj = center(first("dj") ?? first("stage"));
  const pool = center(first("pool"));
  const floor = center(first("dance"));

  for (const z of layout.zones) {
    const [cx, cz] = [z.x + z.w / 2, z.y + z.h / 2];
    const style =
      z.furniture ??
      (z.id === "vip"
        ? "vip"
        : z.id === "seating"
          ? layout.name === "booth"
            ? "high"
            : "lounge"
          : null);
    if (!style) continue;
    if (style === "vip") {
      // Booths look straight at the DJ (from the side wings or across the floor).
      const [tx, tz] = dj ?? floor ?? [cx, 0];
      const rot = facing(cx, cz, tx, tz);
      grid(z, rot, 2, 1.8, booth(rot), out);
    } else if (style === "cabana") {
      const [tx, tz] = pool ?? [cx, cz + 1];
      const rot = facing(cx, cz, tx, tz);
      grid(z, rot, 2.4, 2, booth(rot), out);
    } else if (style === "high")
      grid(
        z,
        0,
        1.6,
        1.5,
        (x, y, o) => o.push({ kind: "highTable", x, z: y, rot: 0 }),
        out,
      );
    else if (style === "tables")
      grid(
        z,
        0,
        2,
        1.8,
        (x, y, o) =>
          o.push(
            { kind: "table", x, z: y, rot: 0 },
            { kind: "chair", x, z: y - 0.62, rot: 0 },
            { kind: "chair", x, z: y + 0.62, rot: 2 },
          ),
        out,
      );
    else loungeSets(z, out);
  }

  // Stools along the customer side of every bar counter.
  for (const counter of layout.zones.filter((z) => z.id === "counter")) {
    const front = layout.zones.find(
      (z) =>
        z.id === "barFront" &&
        (Math.abs(z.x - (counter.x + counter.w)) < 0.01 ||
          Math.abs(z.x + z.w - counter.x) < 0.01 ||
          Math.abs(z.y - (counter.y + counter.h)) < 0.01),
    );
    const vertical = counter.h > counter.w;
    const len = vertical ? counter.h : counter.w;
    const west = front ? front.x < counter.x : false;
    for (let t = 0.5; t < len; t += 0.85)
      out.push(
        vertical
          ? {
              kind: "stool",
              x: west ? counter.x - 0.3 : counter.x + counter.w + 0.3,
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

// v2: the club was redesigned (bigger, VIP wings), so older arrangements no longer fit.
const key = (layout: Layout) => `nyxeron.furniture.${layout.name}.v2`;

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

// Materials and geometries are shared across every piece (one per look / shape), so the whole room can be merged
// into a handful of draw calls (see mergeFurniture) and nothing is allocated per item.
const mats = new Map<string, THREE.MeshStandardMaterial>();
const mat = (color: number, rough = 0.7, metal = 0.1, emissive = 0) => {
  const key = `${color}|${rough}|${metal}|${emissive}`;
  let m = mats.get(key);
  if (!m)
    mats.set(
      key,
      (m = new THREE.MeshStandardMaterial({
        color,
        roughness: rough,
        metalness: metal,
        emissive,
        emissiveIntensity: emissive ? 1.4 : 0,
      })),
    );
  return m;
};
const geos = new Map<string, THREE.BufferGeometry>();
const geo = (key: string, make: () => THREE.BufferGeometry) => {
  let g = geos.get(key);
  if (!g) geos.set(key, (g = make()));
  return g;
};

const box = (
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
) => {
  const o = new THREE.Mesh(
    geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
    m,
  );
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
  const o = new THREE.Mesh(
    geo(
      `c${rt},${rb},${h},${seg}`,
      () => new THREE.CylinderGeometry(rt, rb, h, seg),
    ),
    m,
  );
  o.position.y = y + h / 2;
  return o;
};

/**
 * Bake every placed piece into one mesh per material (static furniture → a few draw calls instead of hundreds).
 * The per-piece groups stay around for picking and dragging in the layout editor.
 */
export function mergeFurniture(pieces: THREE.Object3D[]): THREE.Group {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const piece of pieces) {
    piece.updateWorldMatrix(true, true);
    piece.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const m = mesh.material as THREE.Material;
      buckets.set(m, [...(buckets.get(m) ?? []), g]);
    });
  }
  const out = new THREE.Group();
  for (const [m, list] of buckets) {
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    if (merged) out.add(new THREE.Mesh(merged, m));
  }
  return out;
}

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
      // A trading tablet glowing on the table (guests buy tokens, not drinks).
      const tablet = box(
        0.16,
        0.012,
        0.11,
        mat(0x0e1a24, 0.3, 0.1, 0x22d3ee),
        0.14,
        0.365,
      );
      g.add(cyl(0.05, 0.12, 0.34, chrome), top, rim, candle, tablet);
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
