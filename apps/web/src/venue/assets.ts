import { djs, ids } from "@nyxeron/core";
import * as THREE from "three";

/** Venue sprites/textures (trimmed WebP in /public/sprites). */
export const SPRITE = {
  guests: Array.from({ length: 10 }, (_, i) => `/sprites/guest-${i + 1}.webp`),
  dj: "/sprites/dj-deck.webp",
  dancers: ["/sprites/dancer-1.webp", "/sprites/dancer-2.webp"],
  mc: "/sprites/mc.webp",
  bartenders: ["/sprites/bartender-1.webp", "/sprites/bartender-2.webp"],
  bouncers: ["/sprites/bouncer-1.webp", "/sprites/bouncer-2.webp"],
  tex: {
    concrete: "/sprites/tex-concrete.webp",
    wood: "/sprites/tex-wood.webp",
    asphalt: "/sprites/tex-asphalt.webp",
  },
};

/** Each DJ's own character behind the decks, and their concert-screen loop. */
export const djDeck = (id: string) => `/sprites/deck-${id}.webp`;
export const djVideo = (id: string) => `/video/dj-${id}.mp4`;

export interface VenueAssets {
  guests: THREE.Texture[];
  decks: Partial<Record<string, THREE.Texture>>;
  dj?: THREE.Texture;
  dancers: THREE.Texture[];
  mc?: THREE.Texture;
  bartenders: THREE.Texture[];
  bouncers: THREE.Texture[];
  tex: Partial<Record<keyof typeof SPRITE.tex, THREE.Texture>>;
}

const loader = new THREE.TextureLoader();

/** Loads everything it can; any missing file just drops that element back to a simple fallback. */
export async function loadVenueAssets(): Promise<VenueAssets> {
  const one = (url: string): Promise<THREE.Texture | undefined> =>
    loader
      .loadAsync(url)
      .then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return t;
      })
      .catch(() => undefined);
  const many = async (urls: string[]) =>
    (await Promise.all(urls.map(one))).filter((t): t is THREE.Texture => !!t);
  const [
    guests,
    dj,
    dancers,
    mc,
    bartenders,
    bouncers,
    concrete,
    wood,
    asphalt,
    deckList,
  ] = await Promise.all([
    many(SPRITE.guests),
    one(SPRITE.dj),
    many(SPRITE.dancers),
    one(SPRITE.mc),
    many(SPRITE.bartenders),
    many(SPRITE.bouncers),
    one(SPRITE.tex.concrete),
    one(SPRITE.tex.wood),
    one(SPRITE.tex.asphalt),
    Promise.all(ids(djs).map((id) => one(djDeck(id)))),
  ]);
  const decks = Object.fromEntries(ids(djs).map((id, i) => [id, deckList[i]]));
  return {
    guests,
    decks,
    dj,
    dancers,
    mc,
    bartenders,
    bouncers,
    tex: { concrete, wood, asphalt },
  };
}

/** The booked DJ's screen loop as a muted, looping video texture; undefined if the file is missing. */
export function loadDjVideo(
  id: string,
): Promise<THREE.VideoTexture | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    Object.assign(v, {
      src: djVideo(id),
      muted: true,
      loop: true,
      playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
    });
    v.addEventListener(
      "canplay",
      () => {
        v.play().catch(() => {});
        const t = new THREE.VideoTexture(v);
        t.colorSpace = THREE.SRGBColorSpace;
        resolve(t);
      },
      { once: true },
    );
    v.addEventListener("error", () => resolve(undefined), { once: true });
    v.load();
  });
}

/** Small canvas-drawn textures: labels, the "!" alert, sale floats, blob shadows. */
export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function textTexture(
  text: string,
  opts: {
    size?: number;
    color?: string;
    weight?: string;
    font?: string;
    stroke?: boolean;
  } = {},
) {
  const size = opts.size ?? 64;
  const font = `${opts.weight ?? "600"} ${size}px ${opts.font ?? "ui-monospace, Menlo, monospace"}`;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width + size * 0.6);
  const h = Math.ceil(size * 1.4);
  const tex = canvasTexture(w, h, (ctx) => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (opts.stroke) {
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = "rgba(0,0,0,.85)";
      ctx.strokeText(text, w / 2, h / 2);
    }
    ctx.fillStyle = opts.color ?? "#fff";
    ctx.fillText(text, w / 2, h / 2);
  });
  return { tex, aspect: w / h };
}

export const shadowTexture = () =>
  canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(0,0,0,.7)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
