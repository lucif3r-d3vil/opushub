# OpusHub — Design system (V1.2)

## V1.2 decisions (Phase 2 real-data review, 2026-09-12)

Validated against live Engine-shaped data (via the mock-engine harness — no real Engine exists in
this sandbox; see `01-audit.md`) and real `/proc` host metrics. No redesign; only problems caused
by real data were fixed:

- **Socket paths never reach the browser — not even under Details.** This supersedes the V1.1
  rule that parked probe text in a disclosure. Docker-off copy stays one human sentence +
  "Configure Docker →"; the Details disclosure (where kept) shows only the generic public reason.
  Rationale: §4 — the API enforces the boundary, not the UI's discretion.
- **First-run is one banner, not a wizard and not a wall of empty states.** `SetupBanner`
  (Hub, above search): "Welcome to OpusHub / Your control center is ready — N of 3 connected",
  a Connected checklist (System · Configuration · Docker) + an Optional checklist
  (Weather · News · Markets), one contextual Configure → and Dismiss. It appears only while a
  *required* piece is missing (Docker off or zero services) and dismissal persists in
  `layout.json` (`hub.setupDismissed`). Optional integrations keep their quiet one-line empty
  states and never summon the banner.
- **Optional ≠ failed, restated.** `unconfigured` renders as a plain sentence ("Not set up
  yet." + gentle reason + Configure →), never the dashed `.alert` box. The alert box is reserved
  for a *configured* provider that actually failed (all feeds down, daemon erroring).
- **Discovered vs configured is typographic, not badged.** Auto-discovered compose projects get
  their own "Discovered" section and a quiet `auto` note; standalone containers get a static
  "Standalone containers" section (name · image · status · logs affordance, no fake detail
  links). No pills, per the badge-spam rule.
- **Real-data truncation rules.** Tiles: name ellipsizes, app/description clamps to 2 lines.
  Stack rows: name/description ellipsize. Member image column ellipsizes. Detail titles and `kv`
  values wrap (`overflow-wrap: anywhere`). Port/volume rows wrap; long host paths break at any
  point. Log drawer wraps long lines, strips ANSI/control chars, caps rendered lines at 500
  (with a "showing the last N" note), offers a timestamps toggle, and scrolls to the bottom on
  first load only (never yanks the scroll on refresh).
- **Unhealthy is amber, never red.** A degraded container (unhealthy, paused, restarting) gets
  the `unhealthy` dot + word treatment; red is reserved for genuinely failed states
  (exited-unexpectedly surfaces as Offline/down wording, errors as alerts). No exaggerated
  error treatment for degraded-but-alive.
- **Health honesty.** List-level status is running-state only (the list API carries no health);
  health appears where inspect data exists (service page, stack-detail members). The UI never
  implies a health verdict it cannot know.

One sentence: *a private digital home, not an admin panel.* The interface should feel like a place
someone visited — an editorial homepage for your infrastructure — rather than a grid of floating
cards generated to fill space.

## V1.1 decisions (Phase 1 visual/product review, 2026-09-12)

Reviewed every route in light + dark at 1440/1024/768/390 and fixed the deviations found. New
rules and their rationale:

- **Status dot states are `status-dot.<state>` compound classes; the "absent" state is
  `.status-dot.absent`.** The old `unavailable` state class collided with the `.unavailable`
  provider-note box and every absent dot rendered as a 34px dashed rounded square. Any future
  class added to a status dot must never equal a standalone class used elsewhere in the
  vocabulary.
- **Absence is quiet; only failure is boxed.** `.unavailable` no longer has a dashed border or
  padding — an unconfigured/unavailable provider is a short sentence ("Not set up yet." /
  "Unavailable."), a one-line reason, and an accent "Configure →" link. The dashed border is
  reserved for `.unavailable.alert` (real errors, e.g. unreadable config entries) and for the
  "Collecting samples…" chart placeholder. Raw technical detail (socket paths, fetch errors)
  goes under a `Details` disclosure, never in the main sentence.
- **Docker-off copy is one human sentence + a fix.** "Docker isn't connected. OpusHub can't see
  containers, so live status, stats and logs stay off." + "Configure Docker →" (Settings →
  System). The exact probe failure text (env vars, socket path) is available under Details.
  Pages must not dump raw provider reasons in footers — the Stacks list footer now just says
  "updated X".
- **Timeline markers: one glyph on the rule per event.** The type glyph renders in a 22px
  circular chip centered on the vertical rule (the chip's background masks the line); the old
  plain dot is gone. Absolute + relative time sit in a single right-aligned tabular group
  ("7:14 AM · 19 min ago"). Filter chips use a real `.chip.active` state class, not inline
  style duplication.
- **System KV lists are two-column** (label left 130px secondary / value right-aligned,
  tabular) — the old markup (dt/dd) and CSS (`.r/.k/.v`) disagreed and rendered as a stacked
  text pile. `sys-kv` now styles dt/dd directly.
- **Chart tick labels anchor inside the frame** (`text-anchor: start` first, `end` last) so the
  first/last time labels never clip at the SVG edge.
- **Row actions on mobile get their own line** (`.svc-row .row-actions { grid-column: 1/-1;
  justify-content: flex-end }` under 860px) instead of wrapping mid-row.
- **ISO week is real.** Hub's "week N" uses the standard ISO 8601 algorithm (Thursday-anchored
  week 1); the previous approximation was off by one for most of the year.
- **Icon resolution: `hidden` (deprecated-but-present) bundled icons still resolve.** A user who
  asked for `lucide:waves` gets it; search ranking may still prefer the successor icon.
- **Route lookups are case-insensitive** (`/services/media/stream` ≡ `/services/Media/Stream`)
  on the server; canonical casing still drives config files and in-app links.
- **CSP: the pre-hydration theme script in index.html is allowlisted by sha256 hash**
  (`script-src 'self' 'sha256-…'`). If that inline script changes, recompute the hash and update
  `server/index.js` — otherwise the browser blocks it and saved-theme flash returns.
- **Service detail receives the full stack projection** (`members`, `status`, `containerCount`)
  from the API — the previous raw shape crashed the page (`members` undefined) for any service
  in a stack. Stack detail member names link to their service page (Stack → Services
  relationship, per the composition brief).
- **Component hygiene:** `humanEvent` wording lives in `src/lib/events.ts` (not exported from a
  page); no page renders a literal `0` from a `(count || …) && <el>` expression — use
  boolean guards (`!!(…)`); `ServiceDetail` reports freshness through the shared `Freshness`
  component instead of a hardcoded "every 10s" string.

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
- **Hub zones**: `main` (composition, section-sized titles) and `rail` (sidebar, 380px, uppercase
  micro-labels). Spacing is a composition choice, not a slider: cozy 32 / comfortable 48 / airy 96.
  Below 1180px the rail becomes a two-column band under the main column instead of a stack of
  full-width blocks; below 860px the header stacks and the launcher drops to one column.
- **Widget frames are not cards**: a title, an optional one-line note of real state, and controls
  that appear on hover/focus (always visible where there is no hover). Structure comes from
  hairlines, whitespace and type weight; a surface appears only where you can interact with
  something. Each widget picks the form its information wants — a clock is typography, markets is a
  compact table, news is a list of headlines with source and age, system is a status strip of
  labelled values with hairline meters, activity is a timeline, bookmarks are chips, and the
  attention widget is the only list that is empty when everything is healthy.

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
- **Live preview** (Settings → Hub layout): the real Hub component at reduced scale inside a framed
  surface, labelled *Preview*, non-interactive (no drag handles, no menus) so it cannot be mistaken
  for the page. Never a second renderer, never a mock.

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
