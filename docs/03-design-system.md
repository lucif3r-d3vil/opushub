# OpusHub — Design system (V1)

One sentence: *a private digital home, not an admin panel.* The interface should feel like a place
someone visited — an editorial homepage for your infrastructure — rather than a grid of floating
cards generated to fill space.

## Anti-goals (hard rules)

- No gradient headline text. Ever.
- No glassmorphism layering; translucency appears only on overlays (search, menus) and the nav rail.
- No purple/blue "AI" gradient washes anywhere; backgrounds are flat or a single muted, low-contrast
  field (e.g. a warm graphite horizon), never aurora blobs.
- Not every block is a card. Sections are delimited by **hairlines + spacing + typographic weight**;
  raised surfaces are reserved for things you interact with (tiles, menus, modals).
- Max two shadow tiers, both extremely subtle; in dark mode borders do the work instead of shadows.
- No badge spam; status is a 7px dot + optional word, never a pill with uppercase text.
- Animation budget: ≤180ms for state changes, ≤260ms for page-level; scale/fade/translate only;
  `prefers-reduced-motion` disables all non-essential motion.
- No decorative icons. An icon exists iff it encodes information (a service, an affordance, a type).

## Typography (the primary material)

- UI face: **Inter Variable** (opsz auto, `letter-spacing: -0.011em` on ≥20px).
- Display face: a **serif** (Source Serif 4) used *only* for: the Hub greeting, page hero titles on
  Stack/Service detail, and the "OpusHub" wordmark. Italic for the greeting's contextual word.
- Scale (desktop): display 40/1.05 · title 28/1.15 · section 17/1.3 semibold · body 14/1.6 ·
  meta 12.5/1.5 (tabular-nums for numbers, always). Compact density: −1 step, line-height −0.05.
- Hierarchy rules: one display moment per page; section headers set *left-aligned on the content
  grid* (not centered); metadata is 12.5px secondary color, never bold; large numbers 28–34px with
  tight tracking and `font-variant-numeric: tabular-nums`.
- Uppercase micro-labels only in two places: table column headers and the rail section labels —
  small (11px, +0.06em tracking), used as quiet structure, not decoration.

## Color

Neutral-first. Both modes are designed; nothing is "invert".

```
dark:  bg #0b0c0e · raised #131519 · overlay rgba(19,21,25,.86)+blur
       ink #eef0f2 · secondary #9aa1a9 · hairline rgba(238,240,242,.09)
light: bg #f7f7f5 (paper) · raised #fff · overlay rgba(255,255,255,.9)+blur
       ink #16181b · secondary #646a72 · hairline rgba(22,24,27,.10)
```

- Accent: single user-selectable hue (sage · slate · teal · amber · rose · clay), defaults to a
  calm sage-teal. Used for: focus ring, active nav marker, link underline on hover, sparkline
  stroke, selection. Not used for large fills.
- Status: `ok` #57a05f (dark: #6fbf7a), `warn` amber #c98a4b, `fail` #c95d56, `unavailable` =
  secondary gray with 55% opacity ring (it's *absence*, not error).
- Service identity color: derived deterministically from the icon/name for monogram fallbacks only.

## Space & composition

- 4px base; component paddings from {8,12,16,20,24,32,48,64,96}; section rhythm 48–64 desktop.
- Content column 1320 max, 24 gutter desktop / 16 tablet / 12 mobile. Hub rail is 1fr 380px.
- The page **starts with words, not widgets**: title row (large), optional 1-line description,
  meta row (right-aligned, e.g. "12 services · 4 stacks"), then content. Hairline under title row.
- Asymmetry on purpose: Hub = wide primary column (system strip → services) + narrow rail
  (weather/time → markets → news → activity); Services = per-group editorial sections with inline
  metadata, not uniform tile farms; System = full-width band sections with oversized numerals and
  charts spanning to the grid edge; Activity = single vertical rule timeline; Settings = docs-like
  two-column (nav 200px + pane) with form rows, not boxes.

## Components (few, honest)

- **Tile** (services): 1px hairline, radius 12, icon 28px, name 14.5 medium, hover: hairline→ink
  40%, translateY(-1px), 140ms; secondary affordance (details) fades in top-right. Open = click on
  a dedicated launch affordance or double-click — single click opens *detail page*, because the brief
  wants OpusHub service pages.
- **Meter**: 4px rounded bar, hairline track, fill uses measured value only; >85% warn, >95% fail.
- **AreaChart**: baseline = bottom hairline, stroke 1.5px accent, fill = accent@8%, y-axis implicit
  (no grid clutter), one max marker.
- **Timeline event**: 26px type glyph on the rule; time right-aligned micro-meta; no boxes.
- **Empty/Unavailable state**: 13px secondary sentence + the actual reason + (when actionable) a
  "Configure →" text link. No illustrations.
- **Command overlay**: 640px, top-third, translucent raised surface (the one place glass belongs),
  grouped results, 12px section headers.

## Motion

- Route change: 180ms fade + 4px rise of the main column. Menus: 140ms scale(.97→1)+fade.
- Drag: grabbed item lifts (shadow tier 2, scale 1.015, cursor grabbing), others shift 160ms.
- Numbers tick via CSS, not JS counting. Hover affordances fade in 120ms; never in, 90ms out.

## Surfaces & background

- Background modes: Quiet (flat), Horizon (single muted vertical ramp, no blobs), Photo (from
  config/backgrounds or URL; scrim + blur slider, text always ≥ 4.5:1 over scrim — scrim is
  automatic, min 55% on photos). Content never sits on raw imagery.
- The nav rail and command overlay get the only translucent materials; everything else is opaque.

## Accessibility

- Full keyboard order: rail → page actions → content; focus-visible 2px accent ring, offset 2.
- All interactive tiles are real buttons/links; palette traps focus; aria-live for provider status.
- Contrast: secondary text ≥ 4.6:1 both modes; charts pair color with shape/labels, never color-only.
