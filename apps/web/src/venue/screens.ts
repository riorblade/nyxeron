import * as THREE from "three";

/**
 * Wall screens, all landscape. Clips are user-supplied files in /public/screens, listed in /public/screens/playlist.json:
 * "landscape" and "portrait" both feed the clip screens (portrait clips are cropped to fill), "ads" the sponsor slots.
 * A kind with no clips shows a built-in animated fallback (visualizer, or a "your brand here" ad placeholder).
 */
export type ScreenKind = "clip" | "ad";
interface Playlist {
  clip: string[];
  ad: string[];
}

/** Clip screens are 3:4 (between landscape and a phone's portrait); ads stay 16:9. Scaled up on tall walls. */
export const SCREEN_SIZE: Record<ScreenKind, { w: number; h: number }> = {
  clip: { w: 2.1, h: 2.8 },
  ad: { w: 2.6, h: 1.46 },
};
const MAX_PLAYERS = 6; // one decoder per clip; more costs more than it adds
/** Screens cut between these many live edits (neighbouring screens show different ones). */
const EDITORS = 3;

let playlist: Promise<Playlist> | null = null;
/** Fetched once per session; a missing or broken file just means "no clips yet". */
export function loadPlaylist(): Promise<Playlist> {
  playlist ??= fetch("/screens/playlist.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((j: Record<string, unknown>) => {
      const list = (k: string) =>
        Array.isArray(j[k])
          ? (j[k] as unknown[]).filter(
              (x): x is string => typeof x === "string" && !!x,
            )
          : [];
      return {
        clip: [...list("landscape"), ...list("portrait")],
        ad: list("ads"),
      };
    });
  return playlist;
}

/** One muted video element cycling through a list of clips. */
class Player {
  readonly video = document.createElement("video");
  aspect = 16 / 9;
  private i: number;
  private failures = 0;
  onAspect?: () => void;

  constructor(
    private list: string[],
    start: number,
  ) {
    this.i = start % list.length;
    const v = this.video;
    Object.assign(v, {
      muted: true,
      playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
      loop: list.length === 1,
    });
    v.addEventListener("ended", () => this.next());
    v.addEventListener("loadedmetadata", () => {
      this.failures = 0;
      this.aspect = v.videoWidth / v.videoHeight || this.aspect;
      this.onAspect?.();
    });
    // Skip a missing or broken file, but give up if every clip in the list fails.
    v.addEventListener("error", () => {
      if (++this.failures < this.list.length) this.next();
    });
    this.load();
  }

  private load() {
    this.video.src = `/screens/${encodeURIComponent(this.list[this.i]!)}`;
    this.video.play().catch(() => {});
  }

  private next() {
    this.i = (this.i + 1) % this.list.length;
    this.load();
  }

  setPlaying(on: boolean) {
    if (on) this.video.play().catch(() => {});
    else this.video.pause();
  }

  dispose() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

/** Animated canvas used when a kind has no clips: an equalizer on the beat, or an ad placeholder. */
class Fallback {
  readonly tex: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private drawnAt = 0;

  constructor(private kind: ScreenKind) {
    const c = document.createElement("canvas");
    [c.width, c.height] = kind === "clip" ? [240, 320] : [320, 180];
    this.ctx = c.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
  }

  draw(t: number, pulse: number) {
    if (t - this.drawnAt < 66) return; // ~15 fps is plenty for a wall screen
    this.drawnAt = t;
    const { ctx } = this;
    const { width: W, height: H } = ctx.canvas;
    const s = t / 1000;
    ctx.fillStyle = "#0b0914";
    ctx.fillRect(0, 0, W, H);
    if (this.kind === "ad") {
      const hue = (s * 30) % 360;
      ctx.strokeStyle = `hsl(${hue} 90% 60%)`;
      ctx.lineWidth = 4;
      ctx.strokeRect(6, 6, W - 12, H - 12);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "800 30px Inter Tight, sans-serif";
      ctx.fillText("YOUR BRAND HERE", W / 2, H / 2 + 4);
      ctx.fillStyle = `hsl(${hue} 90% 70%)`;
      ctx.font = "600 13px ui-monospace, monospace";
      ctx.fillText("ADVERTISE AT NYXERON", W / 2, H / 2 + 30);
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.textAlign = "left";
      ctx.fillText("AD", 16, 26);
    } else {
      const bars = this.kind === "clip" ? 9 : 16;
      const bw = W / bars;
      for (let i = 0; i < bars; i++) {
        const level =
          (0.25 +
            0.55 * Math.abs(Math.sin(s * (1.7 + (i % 5) * 0.3) + i * 0.8))) *
          (0.7 + pulse * 0.5);
        const h = Math.min(0.92, level) * (H - 40);
        ctx.fillStyle = `hsl(${(s * 40 + i * 22) % 360} 90% 58%)`;
        ctx.fillRect(i * bw + 3, H - 10 - h, bw - 6, h);
      }
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.textAlign = "center";
      ctx.font = "800 26px Inter Tight, sans-serif";
      ctx.fillText("NYXERON", W / 2, 34);
    }
    this.tex.needsUpdate = true;
  }
}

/** Crop a texture to fill a plane without stretching (CSS object-fit: cover). Tall clips keep their upper part, where the faces are. */
function cover(tex: THREE.Texture, source: number, plane: number) {
  if (source > plane) {
    tex.repeat.set(plane / source, 1);
    tex.offset.set((1 - plane / source) / 2, 0);
  } else {
    tex.repeat.set(1, source / plane);
    tex.offset.set(0, (1 - source / plane) * 0.62);
  }
}

type Rect = [number, number, number, number];
const SHOTS: { rects: Rect[]; weight: number }[] = [
  { rects: [[0, 0, 1, 1]], weight: 6 }, // one clip, full frame
  {
    rects: [
      [0, 0, 0.5, 1],
      [0.5, 0, 0.5, 1],
    ],
    weight: 2,
  }, // split
  {
    rects: [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
    weight: 2,
  }, // 2×2 grid
];

/**
 * A live "party edit" on one canvas: cuts on the beat between full-frame clips, and now and then a split or a 2×2
 * grid, with a white flash on every cut and a zoom punch on every kick.
 */
class Editor {
  readonly tex: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private drawnAt = 0;
  private prevPulse = 0;
  private kicks = 0;
  private nextCut = 4;
  private cutAt = 0;
  private shot: { rects: Rect[]; vids: number[] } = {
    rects: [[0, 0, 1, 1]],
    vids: [0],
  };
  private flash = 0;
  private punch = 0;

  constructor(
    private videos: HTMLVideoElement[],
    private seed: number,
  ) {
    const c = document.createElement("canvas");
    [c.width, c.height] = [480, 640];
    this.ctx = c.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.cut(0);
  }

  private cut(now: number) {
    const total = SHOTS.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total;
    const pick = SHOTS.find((s) => (r -= s.weight) < 0) ?? SHOTS[0]!;
    // Different clips in each panel, and a different lead clip from the last shot.
    const n = this.videos.length;
    const start =
      (this.shot.vids[0]! +
        1 +
        Math.floor(Math.random() * Math.max(1, n - 1))) %
      n;
    this.shot = {
      rects: pick.rects,
      vids: pick.rects.map((_, i) => (start + i + this.seed) % n),
    };
    this.flash = 1;
    this.kicks = 0;
    this.cutAt = now;
    // A full clip holds a bar or two; splits and grids are quick hits.
    this.nextCut =
      pick.rects.length > 1 ? 4 : [4, 8, 8, 16][Math.floor(Math.random() * 4)]!;
  }

  draw(now: number, pulse: number) {
    if (now - this.drawnAt < 33) return; // ~30 fps
    this.drawnAt = now;
    if (pulse > 0.8 && this.prevPulse < 0.4) {
      this.kicks++;
      this.punch = 1;
      if (this.kicks >= this.nextCut) this.cut(now);
    }
    this.prevPulse = pulse;
    // No beat to follow (music off): keep cutting on a clock.
    if (now - this.cutAt > 6000) this.cut(now);

    const { ctx } = this;
    const { width: W, height: H } = ctx.canvas;
    ctx.fillStyle = "#050308";
    ctx.fillRect(0, 0, W, H);
    const zoom = 1 + this.punch * (this.shot.rects.length === 1 ? 0.07 : 0.03);
    this.shot.rects.forEach(([x, y, w, h], i) => {
      const v = this.videos[this.shot.vids[i]!]!;
      drawCover(ctx, v, x * W, y * H, w * W, h * H, zoom);
    });
    if (this.shot.rects.length > 1) {
      // Hairline gutters between panels.
      ctx.fillStyle = "#000";
      ctx.fillRect(W / 2 - 2, 0, 4, H);
      if (this.shot.rects.length === 4) ctx.fillRect(0, H / 2 - 2, W, 4);
    }
    if (this.flash > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.7})`;
      ctx.fillRect(0, 0, W, H);
    }
    this.flash *= 0.72;
    this.punch *= 0.8;
    this.tex.needsUpdate = true;
  }
}

/** Draw a video cropped to fill the rectangle (cover), optionally zoomed in from the centre. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
) {
  if (v.readyState < 2 || !v.videoWidth) {
    ctx.fillStyle = "#0b0914";
    ctx.fillRect(x, y, w, h);
    return;
  }
  const src = v.videoWidth / v.videoHeight,
    dst = w / h;
  let sw = v.videoWidth,
    sh = v.videoHeight;
  if (src > dst) sw = sh * dst;
  else sh = sw / dst;
  sw /= zoom;
  sh /= zoom;
  ctx.drawImage(
    v,
    (v.videoWidth - sw) / 2,
    (v.videoHeight - sh) * 0.4,
    sw,
    sh,
    x,
    y,
    w,
    h,
  );
}

export class ScreenWall {
  private players: Record<ScreenKind, Player[]> = { clip: [], ad: [] };
  private fallbacks: Record<ScreenKind, Fallback>;
  private used = { clip: 0, ad: 0 };
  private editors: Editor[] = [];
  private clipsOn = true;
  private textures: THREE.Texture[] = [];

  constructor(list: Playlist, slots: Record<ScreenKind, number>) {
    this.fallbacks = { clip: new Fallback("clip"), ad: new Fallback("ad") };
    // Clips: one looping player per clip, cut together live by a few editors.
    for (const clip of list.clip.slice(0, MAX_PLAYERS))
      this.players.clip.push(new Player([clip], 0));
    if (this.players.clip.length)
      for (let i = 0; i < Math.min(EDITORS, Math.max(1, slots.clip)); i++)
        this.editors.push(
          new Editor(
            this.players.clip.map((p) => p.video),
            i,
          ),
        );
    // Ads: rotate through the list, start points spread so neighbouring screens differ.
    const n = Math.min(MAX_PLAYERS, list.ad.length, Math.max(1, slots.ad));
    for (let i = 0; i < n && list.ad.length; i++)
      this.players.ad.push(
        new Player(list.ad, i * Math.max(1, Math.floor(list.ad.length / n))),
      );
  }

  /** Texture for the next screen of this kind, cropped to `planeAspect`. */
  texture(kind: ScreenKind, planeAspect: number): THREE.Texture {
    if (kind === "clip")
      return this.editors.length
        ? this.editors[this.used.clip++ % this.editors.length]!.tex
        : this.fallbacks.clip.tex;
    const pool = this.players[kind];
    if (!pool.length) return this.fallbacks[kind].tex;
    const p = pool[this.used[kind]++ % pool.length]!;
    const tex = new THREE.VideoTexture(p.video);
    tex.colorSpace = THREE.SRGBColorSpace;
    const fit = () => cover(tex, p.aspect, planeAspect);
    fit();
    const prev = p.onAspect;
    p.onAspect = () => {
      prev?.();
      fit();
    };
    this.textures.push(tex);
    return tex;
  }

  /** The animated stand-in for this kind (visualizer / ad placeholder). */
  fallback(kind: ScreenKind): THREE.Texture {
    return this.fallbacks[kind].tex;
  }

  /** Hidden clips stop decoding. */
  setPlaying(kind: ScreenKind, on: boolean) {
    if (kind === "clip") this.clipsOn = on;
    this.players[kind].forEach((p) => p.setPlaying(on));
  }

  tick(now: number, pulse: number) {
    for (const f of Object.values(this.fallbacks)) f.draw(now, pulse);
    if (this.clipsOn) this.editors.forEach((e) => e.draw(now, pulse));
  }

  dispose() {
    for (const k of ["clip", "ad"] as const)
      this.players[k].forEach((p) => p.dispose());
    this.textures.forEach((t) => t.dispose());
    this.editors.forEach((e) => e.tex.dispose());
    for (const f of Object.values(this.fallbacks)) f.tex.dispose();
  }
}
