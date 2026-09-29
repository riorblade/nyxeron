/** Generated art (Higgsfield GPT Image 2), served from /public/art. Missing files just fall back to icons. */
export const art = {
  office: "/art/office.webp",
  drink: (id: string) => `/art/drink-${id}.webp`,
  dj: (id: string) => `/art/dj-${id}.webp`,
  band: (id: string) => `/art/band-${id}.webp`,
  staff: (role: string) => `/art/staff-${role}.webp`,
  venue: (level: number) => `/art/venue-${level}.webp`,
  door: "/landing-hero.webp",
};
