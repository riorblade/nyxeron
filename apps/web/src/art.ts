/** Generated art (Higgsfield GPT Image 2), served from /public/art. Missing files just fall back to icons. */
export const art = {
  office: "/art/office.jpg",
  drink: (id: string) => `/art/drink-${id}.png`,
  dj: (id: string) => `/art/dj-${id}.jpg`,
  staff: (role: string) => `/art/staff-${role}.jpg`,
  venue: (level: number) => `/art/venue-${level}.jpg`,
  door: "/landing-hero.jpg",
};
