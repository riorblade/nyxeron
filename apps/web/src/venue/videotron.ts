import * as THREE from "three";
import { en } from "@/i18n/en";

// ---------- shoutouts (typed by the player, kept in this browser) ----------

const KEY = "nyxeron.shoutouts";
export const MAX_SHOUTOUTS = 8;
let list: string[] | null = null;

export function getShoutouts(): string[] {
  if (!list)
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
      list = Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .slice(0, MAX_SHOUTOUTS)
        : [];
    } catch {
      list = [];
    }
  return list;
}

export function setShoutouts(next: string[]) {
  list = next.slice(0, MAX_SHOUTOUTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ponytail: storage blocked — messages last this session only.
  }
}

// ---------- the LED board ----------

export interface VideotronData {
  dj: string | null;
  top: { name: string; spent: number }[];
}

interface Slide {
  kicker: string;
  text: string;
  hue: number;
}

const SLIDE_MS = 7000;
const W = 1536,
  H = 256;

/** Wide LED board above the DJ: shoutouts, tonight's top spenders, who's on the decks. */
export class Videotron {
  readonly tex: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private drawnAt = 0;
  private dots: CanvasPattern | null;

  constructor() {
    const c = document.createElement("canvas");
    [c.width, c.height] = [W, H];
    this.ctx = c.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // LED pixel grid laid over everything.
    const d = document.createElement("canvas");
    [d.width, d.height] = [4, 4];
    const dc = d.getContext("2d")!;
    dc.fillStyle = "rgba(0,0,0,.55)";
    dc.fillRect(3, 0, 1, 4);
    dc.fillRect(0, 3, 4, 1);
    this.dots = this.ctx.createPattern(d, "repeat");
  }

  private slides(data: VideotronData): Slide[] {
    const t = en.videotron;
    const out: Slide[] = getShoutouts().map((text, i) => ({
      kicker: t.shoutout,
      text,
      hue: 320 + i * 40,
    }));
    if (data.top.length)
      out.push({
        kicker: t.topSpenders,
        text: data.top
          .map(
            (g, i) =>
              `#${i + 1} ${g.name} ${g.spent.toLocaleString("en-US")} C`,
          )
          .join("   ·   "),
        hue: 45,
      });
    out.push(
      data.dj
        ? { kicker: t.nowPlaying, text: data.dj, hue: 190 }
        : { kicker: t.welcome, text: "NYXERON", hue: 280 },
    );
    return out;
  }

  draw(now: number, pulse: number, data: VideotronData) {
    if (now - this.drawnAt < 50) return; // ~20 fps
    this.drawnAt = now;
    const { ctx } = this;
    const slides = this.slides(data);
    const i = Math.floor(now / SLIDE_MS) % slides.length;
    const s = slides[i]!;
    const p = (now % SLIDE_MS) / SLIDE_MS;

    ctx.fillStyle = "#050308";
    ctx.fillRect(0, 0, W, H);
    // Frame that breathes on the kick.
    ctx.strokeStyle = `hsl(${s.hue} 95% ${45 + pulse * 25}%)`;
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, W - 16, H - 16);

    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = `hsl(${s.hue} 95% 70%)`;
    ctx.font = "700 38px ui-monospace, Menlo, monospace";
    ctx.fillText(s.kicker, W / 2, 58);

    ctx.font = "900 104px Inter Tight, sans-serif";
    const text = s.text.toUpperCase();
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = `hsl(${s.hue} 95% 60%)`;
    ctx.shadowBlur = 24;
    if (tw <= W - 80) {
      // Short text slides in, then holds.
      const k = Math.min(1, p * 6);
      ctx.fillText(text, W / 2 + (1 - k) ** 3 * W, 158);
    } else {
      // Long text scrolls right to left across the whole slide.
      ctx.textAlign = "left";
      ctx.fillText(text, W - p * (tw + W), 158);
    }
    ctx.shadowBlur = 0;
    if (this.dots) {
      ctx.fillStyle = this.dots;
      ctx.fillRect(0, 0, W, H);
    }
    this.tex.needsUpdate = true;
  }
}

export const VIDEOTRON_ASPECT = W / H;
