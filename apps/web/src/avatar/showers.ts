// Cash and token coins thrown by the celebration emotes: bills flutter down, coins (each with a token's art) spin up
// and fall, then both lie on the floor a moment and shrink away. One InstancedMesh per kind, so a club full of
// celebrating players stays a handful of draw calls. Cosmetic only.
import * as THREE from "three";
import type { Rig } from "./rig";
import { throwsBetween, type Move } from "./moves";

const TOKENS = [
  "nvda",
  "tsla",
  "spcx",
  "us500",
  "bigtech",
  "aisemis",
  "skhy",
  "dividend",
];
const CAP = 160; // per mesh
const REST = 2.2; // seconds on the floor

interface Bit {
  mesh: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  size: number;
  floor: number;
  rest: number;
  bill: boolean;
}

function billTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3fae5a";
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = "#d9f99d";
  g.lineWidth = 4;
  g.strokeRect(5, 5, 118, 54);
  g.fillStyle = "#14532d";
  g.beginPath();
  g.ellipse(64, 32, 18, 20, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#d9f99d";
  g.font = "bold 30px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("$", 64, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A gold coin face with the token's art clipped round (drawn once the image loads). */
function coinTexture(token: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const rim = () => {
    g.fillStyle = "#f5b301";
    g.beginPath();
    g.arc(64, 64, 63, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#7c5a00";
    g.beginPath();
    g.arc(64, 64, 54, 0, Math.PI * 2);
    g.fill();
  };
  rim();
  const img = new Image();
  img.onload = () => {
    rim();
    g.save();
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.clip();
    g.drawImage(img, 12, 12, 104, 104);
    g.restore();
    t.needsUpdate = true;
  };
  img.src = `/art/token-${token}.webp`;
  return t;
}

const hand = new THREE.Vector3();
const chest = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const sc = new THREE.Vector3();

export class Showers {
  private meshes: THREE.InstancedMesh[] = [];
  private bits: Bit[] = [];
  private textures: THREE.Texture[] = [];
  private beats = new WeakMap<Rig, number>();
  /** The cash stack in a make-it-rain left hand; dropped when that rig stops celebrating. */
  private stackGeo = new THREE.BoxGeometry(0.17, 0.07, 0.09);
  private stackMat: THREE.Material[] = [];
  private held = new Map<Rig, { mesh: THREE.Mesh; seen: boolean }>();

  constructor(private parent: THREE.Object3D) {
    const bill = billTexture();
    this.textures.push(bill);
    this.add(
      new THREE.PlaneGeometry(1, 0.5),
      new THREE.MeshBasicMaterial({ map: bill, side: THREE.DoubleSide }),
    );
    const paper = new THREE.MeshBasicMaterial({ color: "#2f8f47" });
    const top = new THREE.MeshBasicMaterial({ map: bill });
    this.stackMat = [paper, paper, top, paper, paper, paper];
    const coin = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 18);
    const side = new THREE.MeshBasicMaterial({ color: "#c98f00" });
    for (const tok of TOKENS) {
      const face = coinTexture(tok);
      this.textures.push(face);
      const top = new THREE.MeshBasicMaterial({ map: face });
      this.add(coin, [side, top, top]);
    }
  }

  private add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
  ) {
    const m = new THREE.InstancedMesh(geo, mat, CAP);
    m.count = 0;
    m.frustumCulled = false;
    this.parent.add(m);
    this.meshes.push(m);
  }

  /**
   * Called each frame for an avatar doing `move` at beat `beat`: throws what that move throws since its last frame.
   * `floor` is the height they stand on (parent space).
   */
  emit(rig: Rig, move: Move, beat: number, floor = 0) {
    if (move === "makeItRain") this.hold(rig);
    const last = this.beats.get(rig) ?? beat;
    this.beats.set(rig, beat);
    const out = throwsBetween(move, last, beat);
    if (!out.length) return;
    rig.mesh.updateMatrixWorld(true);
    const h = rig.mesh.scale.y;
    rig.bones.chest.getWorldPosition(chest);
    this.parent.worldToLocal(chest);
    for (const o of out)
      for (const side of o.hands) {
        rig.bones[side === "l" ? "lFore" : "rFore"].localToWorld(
          hand.set(0, -0.17, 0),
        );
        this.parent.worldToLocal(hand);
        const away = hand.clone().sub(chest).setY(0);
        if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
        away.normalize();
        for (let i = 0; i < o.n; i++)
          this.spawn(o.kind === "bill", hand, away, h, floor);
      }
  }

  private hold(rig: Rig) {
    const h = this.held.get(rig);
    if (h) {
      h.seen = true;
      return;
    }
    const mesh = new THREE.Mesh(this.stackGeo, this.stackMat);
    mesh.position.set(0, -0.21, 0.06);
    mesh.rotation.x = Math.PI / 2;
    rig.bones.lFore.add(mesh);
    this.held.set(rig, { mesh, seen: true });
  }

  private spawn(
    bill: boolean,
    at: THREE.Vector3,
    away: THREE.Vector3,
    h: number,
    floor: number,
  ) {
    if (this.bits.length >= CAP * 4) this.bits.shift();
    const r = Math.random;
    const v = bill
      ? away
          .clone()
          .multiplyScalar((0.6 + r() * 0.9) * h)
          .add(
            new THREE.Vector3(
              (r() - 0.5) * 0.7 * h,
              (1.0 + r() * 1.1) * h,
              (r() - 0.5) * 0.7 * h,
            ),
          )
      : new THREE.Vector3(
          (r() - 0.5) * h,
          (2.8 + r() * 1.4) * h,
          (r() - 0.5) * h,
        ).addScaledVector(away, 0.35 * h);
    this.bits.push({
      mesh: bill ? 0 : 1 + Math.floor(r() * TOKENS.length),
      p: at.clone(),
      v,
      rot: new THREE.Euler(r() * 6, r() * 6, r() * 6),
      spin: new THREE.Vector3(
        (r() - 0.5) * 14,
        (r() - 0.5) * 14,
        (r() - 0.5) * 14,
      ),
      size: (bill ? 0.17 : 0.14) * h,
      floor: floor + 0.004 + r() * 0.004,
      rest: REST + r(),
      bill,
    });
  }

  update(dtMs: number) {
    const dt = Math.min(0.05, dtMs / 1000);
    for (const [rig, h] of this.held) {
      if (!h.seen) {
        h.mesh.removeFromParent();
        this.held.delete(rig);
      } else h.seen = false;
    }
    const counts = this.meshes.map(() => 0);
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i]!;
      const onFloor = b.p.y <= b.floor;
      if (onFloor) {
        b.rest -= dt;
        if (b.rest <= 0) {
          this.bits.splice(i, 1);
          continue;
        }
        b.p.y = b.floor;
        b.rot.x = Math.PI / 2;
        b.rot.y = 0;
      } else if (b.bill) {
        // Paper: heavy air drag, a slow sideways flutter.
        b.v.multiplyScalar(Math.exp(-3.2 * dt));
        b.v.y -= 2.4 * dt;
        b.v.y = Math.max(b.v.y, -0.55);
        b.p.x += Math.sin(b.rest * 9 + b.p.y * 6) * 0.25 * dt;
        b.p.addScaledVector(b.v, dt);
        b.rot.x += b.spin.x * dt * 0.4;
        b.rot.z += b.spin.z * dt * 0.4;
      } else {
        b.v.y -= 7 * dt;
        b.p.addScaledVector(b.v, dt);
        b.rot.x += b.spin.x * dt;
        b.rot.z += b.spin.z * dt;
      }
      const k = Math.min(1, b.rest / 0.4);
      const n = counts[b.mesh]!;
      if (n >= CAP) continue;
      counts[b.mesh] = n + 1;
      q.setFromEuler(b.rot);
      sc.setScalar(b.size * k);
      if (onFloor && b.bill)
        q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, b.rot.z));
      if (onFloor && !b.bill) q.identity();
      this.meshes[b.mesh]!.setMatrixAt(n, m4.compose(b.p, q, sc));
    }
    this.meshes.forEach((m, i) => {
      m.count = counts[i]!;
      m.instanceMatrix.needsUpdate = true;
    });
  }

  dispose() {
    for (const h of this.held.values()) h.mesh.removeFromParent();
    this.held.clear();
    this.stackGeo.dispose();
    this.stackMat.forEach((m) => m.dispose());
    for (const m of this.meshes) {
      this.parent.remove(m);
      m.dispose();
    }
    this.meshes[0]?.geometry.dispose();
    this.meshes[1]?.geometry.dispose();
    const mats = new Set(
      this.meshes.flatMap((m) =>
        Array.isArray(m.material) ? m.material : [m.material],
      ),
    );
    mats.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
