import * as THREE from "three";
import { canvasTexture } from "./assets";

/**
 * Stage pyrotechnics, fired on the DJ's beat: flame jets shooting up beside the stage and CO₂ / mist cannons blasting
 * down from the ceiling. One pooled particle cloud per effect (additive, camera-facing points).
 */
const FIRE_MAX = 1400;
const MIST_MAX = 1400;

class Cloud {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private next = 0;

  constructor(
    private max: number,
    size: number,
    tex: THREE.Texture,
    private tint: (t: number, out: THREE.Color) => void,
    private drag: number,
    private gravity: number,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size,
        map: tex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
  }

  emit(
    at: THREE.Vector3,
    v: [number, number, number],
    spread: number,
    life: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([at.x, at.y, at.z], i * 3);
    this.vel.set(
      [
        v[0] + (Math.random() - 0.5) * spread,
        v[1] + (Math.random() - 0.5) * spread * 0.4,
        v[2] + (Math.random() - 0.5) * spread,
      ],
      i * 3,
    );
    this.maxLife[i] = this.life[i] = life * (0.7 + Math.random() * 0.6);
  }

  update(dt: number) {
    const c = new THREE.Color();
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) {
        this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0;
        continue;
      }
      this.life[i]! -= dt;
      const k = i * 3;
      this.vel[k + 1]! += this.gravity * dt;
      for (let a = 0; a < 3; a++) {
        this.vel[k + a]! *= damp;
        this.pos[k + a]! += this.vel[k + a]! * dt;
      }
      this.tint(1 - Math.max(0, this.life[i]!) / this.maxLife[i]!, c);
      this.col.set([c.r, c.g, c.b], k);
    }
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.color!.needsUpdate = true;
  }
}

const soft = () =>
  canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });

export class StageFx {
  readonly group = new THREE.Group();
  private fire: Cloud;
  private mist: Cloud;
  private flames: {
    at: THREE.Vector3;
    light: THREE.PointLight;
    left: number;
  }[] = [];
  private cannons: THREE.Vector3[];
  private tex = soft();

  constructor(fireAt: THREE.Vector3[], mistAt: THREE.Vector3[]) {
    // Flame: white-hot core → yellow → orange → deep red, dimming as it rises.
    this.fire = new Cloud(
      FIRE_MAX,
      1.1,
      this.tex,
      (t, c) =>
        c
          .setRGB(
            1,
            Math.max(0.08, 0.72 - t * 0.9),
            Math.max(0, 0.28 - t * 1.4),
          )
          .multiplyScalar(Math.max(0, 1 - t) * 0.9),
      1.2,
      2.5, // hot gas keeps rising a little
    );
    // Mist: cool white-blue, lingers and drifts down.
    this.mist = new Cloud(
      MIST_MAX,
      2.6,
      this.tex,
      (t, c) =>
        c.setRGB(0.5, 0.6, 0.75).multiplyScalar(Math.sin(Math.PI * t) * 0.09),
      1.6,
      -0.6,
    );
    this.group.add(this.fire.points, this.mist.points);
    const base = new THREE.MeshStandardMaterial({
      color: 0x18161c,
      metalness: 0.7,
      roughness: 0.4,
    });
    for (const at of fireAt) {
      // The flame unit: a small steel box with a nozzle.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.35), base);
      box.position.set(at.x, 0.15, at.z);
      const light = new THREE.PointLight(0xff7a1a, 0, 7, 1.6);
      light.position.set(at.x, 1.4, at.z);
      this.group.add(box, light);
      this.flames.push({
        at: new THREE.Vector3(at.x, 0.32, at.z),
        light,
        left: 0,
      });
    }
    this.cannons = mistAt;
  }

  /** One flame burst from every jet (~0.8 s). */
  burstFire() {
    for (const f of this.flames) f.left = 0.7;
  }

  /** Every ceiling cannon blasts mist down and out in all directions. */
  burstMist() {
    for (const at of this.cannons)
      for (let i = 0; i < 110; i++) {
        const a = Math.random() * Math.PI * 2;
        const out = 2 + Math.random() * 3.5;
        this.mist.emit(
          at,
          [Math.cos(a) * out, -3 - Math.random() * 3, Math.sin(a) * out],
          1.2,
          2.2,
        );
      }
  }

  update(dt: number) {
    for (const f of this.flames) {
      if (f.left > 0) {
        f.left -= dt;
        // A jet is a stream: keep feeding the column while it fires.
        for (let i = 0; i < 16; i++) this.fire.emit(f.at, [0, 10, 0], 1.1, 0.9);
        f.light.intensity = 70;
      } else f.light.intensity *= Math.exp(-10 * dt);
    }
    this.fire.update(dt);
    this.mist.update(dt);
  }

  dispose() {
    this.tex.dispose();
    for (const c of [this.fire, this.mist]) {
      c.points.geometry.dispose();
      (c.points.material as THREE.Material).dispose();
    }
  }
}
