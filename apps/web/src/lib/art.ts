/** Art served from /public/art (token logos and basket images from Portir). Missing files just fall back to icons. */
export const art = {
  office: "/art/office.webp",
  token: (id: string) => `/art/token-${id}.webp`,
  dj: (id: string) => `/art/dj-${id}.webp`,
  band: (id: string) => `/art/band-${id}.webp`,
  staff: (role: string) => `/art/staff-${role}.webp`,
  venue: (level: number) => `/art/venue-${level}.webp`,
  door: "/landing-hero.webp",
  /** The neon office (generated art, art/ui): hero banner, cards, characters. */
  ui: {
    hero: "/art/ui/hero.webp",
    openClub: "/art/ui/open-club.webp",
    supplier: (id: string) => `/art/ui/supplier-${id}.webp`,
    crate: "/art/ui/crate.webp",
    chest: "/art/ui/chest.webp",
    ceo: "/art/ui/ceo.webp",
  },
};
