# Brand

The NYXERON mark is the **VIP diamond**: four sweeping wings meet at two sharp points (the club, the night), and
inside a slanted blade between two facets rises like a chart (tokenized stocks going up). Mirror-symmetric outside,
point-symmetric inside. No letters: the mark stands on its own.

## Name and voice

- **Name:** NYXERON (after Nyx, the goddess of the night). Tagline: **Nightclub Empire**.
- **One-liner:** Build your nightclub empire on BNB Chain.

## Channels

| Channel | Handle | Notes |
| --- | --- | --- |
| Website | [nyxeron.xyz](https://nyxeron.xyz) | the game |
| X | [@nyxeron_xyz](https://x.com/nyxeron_xyz) | profile picture `x-avatar.png`, header `x-banner.png` |

X profile:

| Field | Value |
| --- | --- |
| Name | `NYXERON · Nightclub Empire` |
| Bio | `Build your nightclub empire on BNB Chain. Rent the venue, drop the beat, trade tokenized stocks while the crowd goes wild. 🌙` |
| Location | `Veltra City` (the game's city) |
| Website | `nyxeron.xyz` |

## Files (`apps/web/public/brand/`)

| File | Use |
| --- | --- |
| `mark.svg` | the mark, `currentColor` (inline in UI) |
| `mark-white.svg`, `mark-black.svg` | the mark on dark / light backgrounds |
| `icon.svg` | app icon: white mark on a black rounded square (also `favicon.svg` for the game and the back office) |
| `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` | home-screen / PWA icons |
| `x-avatar.png` (400×400) | X / social profile picture (circle-safe, soft glow) |
| `x-banner.png` (1500×500), `x-banner@2x.png` | X header: the Premium Venue at peak, rendered from the game's own 3D scene |

In code: `Mark` in `apps/web/src/components/Brand.tsx` (same paths, 100×100 viewBox).

## Rules

- White on black (or black on white). The mark carries a soft white glow on dark UI; never a gradient fill,
  never recoloured.
- Keep clear space of at least a quarter of the mark's width around it.
- Smallest size: 16 px (favicon). Below 24 px use `icon.svg` (the tile reads better than the bare mark).

## Origin

Concept generated with Higgsfield (Recraft V4.1, vector), then redrawn by hand as clean, symmetric Bézier geometry
(the AI trace had stepped edges). The banner is a frame of the live game: the Premium Venue (Level 5) at 00:30
with the full rig and a pyro burst, composited with the mark in the night sky; X's profile picture sits in the
dark lower left.
