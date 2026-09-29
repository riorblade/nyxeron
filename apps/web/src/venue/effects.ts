import * as THREE from "three";

/**
 * Stage pyrotechnics from real footage (FootageCrate clips with alpha, in /public/effect): flame jets beside the stage,
 * CO₂ bursts down from the ceiling, low fog rolling over the floor. Each effect is one looping video shared by all its
 * emitters (camera-facing sprites), shown for a burst on the DJ's beat and faded out.
 * WebM VP9 alpha for Chrome/Firefox, HEVC alpha (.mov) for Safari.
 */
const src = (name: string) => {
  const probe = document.createElement("video");
  return probe.canPlayType('video/quicktime; codecs="hvc1"')
    ? `/effect/${name}.mov`
    : `/effect/${name}.webm`;
};

class ClipFx {
  private video = document.createElement("video");
  private sprites: THREE.Sprite[] = [];
  private textures: THREE.VideoTexture[] = [];
  private until = 0;

  constructor(
    name: string,
    /** Seconds into the clip a burst may start from (random in range). */
    private from: [number, number],
    private fadeMs: number,
    private blending: THREE.Blending,
  ) {
    Object.assign(this.video, {
      src: src(name),
      muted: true,
      loop: true,
      playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
    });
  }

  /** A sprite at `at`; `anchor` is the point of the clip that sits on `at`; `mirror` flips it left–right. */
  add(
    group: THREE.Group,
    at: THREE.Vector3,
    w: number,
    h: number,
    anchor: [number, number],
    mirror = false,
  ) {
    const tex = new THREE.VideoTexture(this.video);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (mirror) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      tex.offset.x = 1;
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: this.blending,
        opacity: 0,
      }),
    );
    sprite.center.set(mirror ? 1 - anchor[0] : anchor[0], anchor[1]);
    sprite.scale.set(w, h, 1);
    sprite.position.copy(at);
    sprite.visible = false;
    group.add(sprite);
    this.sprites.push(sprite);
    this.textures.push(tex);
  }

  /** Fire a burst lasting `ms` (a burst during a burst just extends it). */
  burst(now: number, ms: number) {
    const [a, b] = this.from;
    if (now > this.until) this.video.currentTime = a + Math.random() * (b - a);
    this.video.play().catch(() => {});
    this.until = now + ms;
  }

  update(now: number) {
    const left = this.until - now;
    const alpha = left <= 0 ? 0 : Math.min(1, left / this.fadeMs);
    for (const s of this.sprites) {
      s.visible = alpha > 0.01;
      (s.material as THREE.SpriteMaterial).opacity = alpha;
    }
    if (left <= 0 && !this.video.paused) this.video.pause();
  }

  dispose() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.textures.forEach((t) => t.dispose());
    this.sprites.forEach((s) => (s.material as THREE.Material).dispose());
  }
}

/** A flame unit: where it stands (its base height too, e.g. on a bar top) and whether it throws light. */
export interface FlameSpot {
  at: THREE.Vector3;
  lit?: boolean;
}

export class StageFx {
  readonly group = new THREE.Group();
  private fire = new ClipFx("fire", [0.3, 3.8], 250, THREE.AdditiveBlending);
  private fogDown = new ClipFx(
    "fog-down",
    [0.15, 0.3],
    600,
    THREE.NormalBlending,
  );
  private fogFloor = new ClipFx(
    "fog-floor",
    [0.8, 1.2],
    800,
    THREE.NormalBlending,
  );
  private lights: THREE.PointLight[] = [];
  private flashUntil = 0;
  private hazeUntil = 0;
  /** 0–1: how thick the room's haze is right now (the scene thickens its fog with it). */
  haze = 0;

  /**
   * @param flames flame units; those right of `midX` are mirrored so every jet leans toward the middle of the room.
   * @param ceilingAt CO₂ cannons (the burst falls from here).
   * @param floorAt low-fog machines.
   */
  constructor(
    flames: FlameSpot[],
    ceilingAt: THREE.Vector3[],
    floorAt: THREE.Vector3[],
    midX: number,
    ceiling: number,
  ) {
    const base = new THREE.MeshStandardMaterial({
      color: 0x18161c,
      metalness: 0.7,
      roughness: 0.4,
    });
    for (const { at, lit } of flames) {
      // The flame unit: a steel box; the clip's nozzle sits 20% in from its edge, on top of the box.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.35), base);
      box.position.set(at.x, at.y + 0.15, at.z);
      this.group.add(box);
      const h = Math.max(1.6, Math.min(4.5, ceiling - at.y - 0.3));
      this.fire.add(
        this.group,
        new THREE.Vector3(at.x, at.y + 0.3, at.z),
        h * (180 / 270),
        h,
        [0.2, 0],
        at.x > midX,
      );
      // Only a few units cast light (each light costs every pixel).
      if (lit) {
        const light = new THREE.PointLight(0xff7a1a, 0, 9, 1.6);
        light.position.set(at.x, at.y + 1.5, at.z);
        this.group.add(light);
        this.lights.push(light);
      }
    }
    // Big, overlapping clouds: two offset sprites per cannon so the bursts merge into a wall of fog.
    const fogW = Math.min(12, Math.max(7, ceiling * 2.4));
    for (const at of ceilingAt)
      for (const dx of [-0.8, 0.8])
        this.fogDown.add(
          this.group,
          new THREE.Vector3(at.x + dx, at.y, at.z + dx * 0.5),
          fogW,
          fogW * (270 / 480),
          [0.5, 1],
          dx > 0,
        );
    for (const at of floorAt)
      this.fogFloor.add(this.group, at, 8, 8 * (270 / 480), [0.5, 0.03]);
  }

  /** Flame jets (~1.2 s) with an orange flash. */
  burstFire() {
    const now = performance.now();
    this.fire.burst(now, 1200);
    this.flashUntil = now + 900;
  }

  /** CO₂ down from the ceiling, fog rolling over the floor, and the whole room hazes over for a while. */
  burstMist() {
    const now = performance.now();
    // Just the jet itself (the first second or two of the clip), not the whole cloud spreading out.
    this.fogDown.burst(now, 1800);
    this.fogFloor.burst(now, 2200);
    this.hazeUntil = now + 1000;
  }

  update() {
    const now = performance.now();
    this.fire.update(now);
    this.fogDown.update(now);
    this.fogFloor.update(now);
    const flash = now < this.flashUntil ? 40 + Math.random() * 40 : 0;
    for (const l of this.lights) l.intensity = flash;
    // Haze rolls in fast, holds about a second, and clears within another.
    const target = now < this.hazeUntil ? 1 : 0;
    this.haze += (target - this.haze) * (target > this.haze ? 0.15 : 0.06);
  }

  dispose() {
    this.fire.dispose();
    this.fogDown.dispose();
    this.fogFloor.dispose();
  }
}
