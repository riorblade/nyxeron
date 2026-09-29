import { Assets, Texture } from "pixi.js";

/** Venue sprites/textures (Higgsfield GPT Image 2, trimmed to 256px tall WebP). */
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

export interface VenueAssets {
  guests: Texture[];
  dj?: Texture;
  dancers: Texture[];
  mc?: Texture;
  bartenders: Texture[];
  bouncers: Texture[];
  tex: Partial<Record<keyof typeof SPRITE.tex, Texture>>;
  glow: Texture;
}

/** Loads everything it can; any missing file just drops that element back to the simple fallback. */
export async function loadVenueAssets(): Promise<VenueAssets> {
  const one = (url: string) => Assets.load<Texture>(url).catch(() => undefined);
  const many = async (urls: string[]) =>
    (await Promise.all(urls.map(one))).filter((t): t is Texture => !!t);
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
  ]);
  return {
    guests,
    dj,
    dancers,
    mc,
    bartenders,
    bouncers,
    tex: { concrete, wood, asphalt },
    glow: glowTexture(),
  };
}

/** Soft round light (white core fading out), drawn once on a canvas; used additively for every light. */
function glowTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return Texture.from(c);
}
