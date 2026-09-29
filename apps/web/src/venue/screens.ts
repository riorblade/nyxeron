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

export const SCREEN_SIZE: Record<ScreenKind, { w: number; h: number }> = {
  clip: { w: 3, h: 1.69 },
  ad: { w: 2.6, h: 1.46 },
};
const MAX_PLAYERS = 4; // decoding more videos at once costs more than it adds

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
    [c.width, c.height] = [320, 180];
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
      const bars = 16;
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

export class ScreenWall {
  private players: Record<ScreenKind, Player[]> = { clip: [], ad: [] };
  private fallbacks: Record<ScreenKind, Fallback>;
  private used = { clip: 0, ad: 0 };
  private textures: THREE.Texture[] = [];

  constructor(list: Playlist, slots: Record<ScreenKind, number>) {
    this.fallbacks = { clip: new Fallback("clip"), ad: new Fallback("ad") };
    for (const k of ["clip", "ad"] as const) {
      // Spread start points so neighbouring screens don't show the same clip.
      const n = Math.min(MAX_PLAYERS, list[k].length, Math.max(1, slots[k]));
      for (let i = 0; i < n && list[k].length; i++)
        this.players[k].push(
          new Player(list[k], i * Math.max(1, Math.floor(list[k].length / n))),
        );
    }
  }

  /** True when this kind has real clips (not just the fallback). */
  has(kind: ScreenKind) {
    return this.players[kind].length > 0;
  }

  /** Texture for the next screen of this kind, cropped to `planeAspect`. */
  texture(kind: ScreenKind, planeAspect: number): THREE.Texture {
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

  tick(now: number, pulse: number) {
    for (const f of Object.values(this.fallbacks)) f.draw(now, pulse);
  }

  dispose() {
    for (const k of ["clip", "ad"] as const)
      this.players[k].forEach((p) => p.dispose());
    this.textures.forEach((t) => t.dispose());
    for (const f of Object.values(this.fallbacks)) f.tex.dispose();
  }
}
