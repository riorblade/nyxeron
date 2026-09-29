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

export class StageFx {
  readonly group = new THREE.Group();
  private fire = new ClipFx("fire", [0.3, 3.8], 250, THREE.AdditiveBlending);
  private fogDown = new ClipFx(
    "fog-down",
    [0, 0.4],
    1200,
    THREE.NormalBlending,
  );
  private fogFloor = new ClipFx(
    "fog-floor",
    [0, 1],
    1500,
    THREE.NormalBlending,
  );
  private lights: THREE.PointLight[] = [];
  private flashUntil = 0;

  /**
   * @param fireAt flame units on the floor; those right of `midX` are mirrored so both sides lean inward.
   * @param ceilingAt CO₂ cannons (the burst falls from here).
   * @param floorAt low-fog machines along the dance floor.
   */
  constructor(
    fireAt: THREE.Vector3[],
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
    const flameH = Math.min(3.6, ceiling - 0.2);
    for (const at of fireAt) {
      // The flame unit: a steel box; the clip's nozzle sits 20% in from its edge, on top of the box.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.35), base);
      box.position.set(at.x, 0.15, at.z);
      this.group.add(box);
      this.fire.add(
        this.group,
        new THREE.Vector3(at.x, 0.3, at.z),
        flameH * (180 / 270),
        flameH,
        [0.2, 0],
        at.x > midX,
      );
      const light = new THREE.PointLight(0xff7a1a, 0, 8, 1.6);
      light.position.set(at.x, 1.5, at.z);
      this.group.add(light);
      this.lights.push(light);
    }
    const fogW = Math.min(6, ceiling * 1.6);
    for (const at of ceilingAt)
      this.fogDown.add(this.group, at, fogW, fogW * (270 / 480), [0.5, 1]);
    for (const at of floorAt)
      this.fogFloor.add(this.group, at, 5, 5 * (270 / 480), [0.5, 0.03]);
  }

  /** Flame jets (~1.2 s) with an orange flash. */
  burstFire() {
    const now = performance.now();
    this.fire.burst(now, 1200);
    this.flashUntil = now + 900;
  }

  /** CO₂ down from the ceiling and fog rolling over the floor. */
  burstMist() {
    const now = performance.now();
    this.fogDown.burst(now, 3500);
    this.fogFloor.burst(now, 6000);
  }

  update() {
    const now = performance.now();
    this.fire.update(now);
    this.fogDown.update(now);
    this.fogFloor.update(now);
    const flash = now < this.flashUntil ? 40 + Math.random() * 40 : 0;
    for (const l of this.lights) l.intensity = flash;
  }

  dispose() {
    this.fire.dispose();
    this.fogDown.dispose();
    this.fogFloor.dispose();
  }
}
