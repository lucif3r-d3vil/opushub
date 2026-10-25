# OpusHub UI overhaul: design direction

Status: **slice 1 is built** (shell and Home, branch `rebuild/1-shell-home`; see "Slice 1" below). The
other pages are still the old ones, running inside the new shell. This extends
[`../03-design-system.md`](../03-design-system.md) and says where it proposes to overrule it, and why.

Two static mockups illustrate it. Open them straight from disk, no build step:

| File | What it shows |
|---|---|
| [`home.html`](home.html) | Home: greeting, host vitals (each stat expands to a 1 h / 24 h / 7 d chart), needs attention, launch tiles by stack, updates, uptime summary, bookmarks |
| [`uptime.html`](uptime.html) | Uptime: summary, pulse ribbons for 12 services, 24 h / 7 d, hover scrub, incidents, compact defaults panel |
| [`containers.html`](containers.html) | Containers: list by stack with start, stop, restart, recreate, logs and update; detail drawer; confirmation dialogs; "Add compose block" editor with live validation and a three-step confirm |
| [`bell.html`](bell.html) | The bell panel in four states (needs you, filtered, all clear, phone width), with acknowledge and expandable activity |
| [`settings.html`](settings.html) | Settings: five compact sections (Docker connection, Notifications, Monitoring defaults, Appearance, Account) |
| [`wizard.html`](wizard.html) | First run: create the administrator, confirm Docker, done |
| `mock.css`, `mock.js` | Shared tokens, six backgrounds, fake data. Every page reads the same fake homelab, so their numbers agree |

Useful URL switches (for review and screenshots): `?bg=graphite|dusk|forest|ember|ridge|city`,
`?static` (settled frame, no motion), `?bell=1`, `?menu=1` (account menu), `?user=name` (placeholder name). Per page: Home `?expand=cpu&hrange=24h&hover=0.6`; Uptime `?range=7d&pop=1&scrub=0.62&row=2`; Containers `?open=immich`, `?confirm=recreate:immich`, `?compose=bad|review|confirm`; Settings `?docker=fail&adv=1&pw=1`; Wizard `?step=2|3`, `?docker=fail`, `?demo=1`.
The background picker now lives in the account menu (avatar, top right) and in Settings → Appearance; both share one state.

Mockup limits, so nothing surprises you: the two "photos" are generated stand-ins (SVG ridges and CSS
bokeh); links go nowhere; the Containers page is not drawn; fonts load from `node_modules` if the repo is
installed and fall back to the system stack otherwise.

## Slice 1: what was built, and where it differs from the mockup

Built: the top bar, account menu (theme, background, accent, Settings, Sign out), design tokens, four
gradient backgrounds, Home (greeting, host strip with 1 h / 24 h / 7 d charts, needs attention, tiles by
stack, rail), the host sampler's `diskUsedPct` and its 5-minute and hourly tiers, and
`scripts/contrast.mjs` (part of `npm run check`).

Differences, all because the page may only show data that exists:

- **Backgrounds:** graphite, dusk, forest and ember (gradients), plus `photo`, which is
  `config/background.jpg` and is offered only when that file exists (at most 6 MB, served read-only at
  `/api/appearance/background`). Ridge and City are not built; there are no bundled photos yet.
- **Needs attention** reads container health, Docker's own status text, auto-heal recoveries the
  observer saw, and monitors that are down. A stopped container offers **Start**, a running one that is
  unhealthy offers **Restart**, both only when the session may run them. Auto-heal is named only when it
  acted. The band is not drawn when empty.
- **Updates available** lists the notices already received (Diun). Diun reports the tag it watched, so
  "from → to" is shown only when the two tags differ; otherwise the row shows the image and says a newer
  image exists. The card is not drawn when there are none.
- **Uptime** shows today's figure across enabled monitors (the engine's current day window, not 7 days)
  and lists any that are not up. The mini ribbons wait for the Uptime page rebuild. Not drawn with no monitors.
- **Host strip:** a reading the host does not report says "Not reported". Sparklines redraw when new
  samples arrive; they do not tick on a timer. Memory, disk and temperature come from the host, so in a
  container they describe what the container can see.
- **Photo backgrounds** are checked against the worst possible image (pure white), which is why the photo
  scrim is .50 to .62 and tiles are .78 opaque. `--ink-3` was lightened to `#949ba3` (it was 3.7:1 on tiles).
- The tile menu has Details, Open in new tab, Review update, Start/Restart and Copy address. Logs wait for
  the Containers page. Start and Restart still use the existing confirmation dialog; dropping it for those two
  (a round 2 decision) lands with the Containers slice, which owns that flow.
- Stacks, System and Activity are listed in the account menu as "until rebuilt" so nothing becomes unreachable.

## 1. Direction

OpusHub should feel like **a page you visit**, not a panel you operate. Five principles:

1. **Open, don't navigate.** A launch tile is the whole interaction: one click opens the service. Detail
   is one step away, never in the way.
2. **Glanceable in three seconds.** Greeting line, host vitals, "needs attention", then tiles. If
   everything is fine, the attention band disappears and the page gets quieter.
3. **Honest, as before.** Unavailable stays unavailable; a degraded service is amber, not red; the host
   strip shows measured numbers only. Nothing here invents data.
4. **Depth from light, not chrome.** A real background, translucent tiles, soft hover light. Hairlines
   and spacing still do the structural work.
5. **Motion explains.** Things rise in once, respond to the pointer, and tell you something is alive
   (sparklines, a pulsing amber dot). Nothing moves for decoration, and all of it stops for
   `prefers-reduced-motion`.

## 2. What changes from `03-design-system.md`, and why

| Rule today | Proposal | Why |
|---|---|---|
| Left icon rail (76 px) | **Top bar**: wordmark, Home, Containers, Uptime, search, bell, settings | A horizontal header reads as a website; the rail reads as an app. With three destinations a rail wastes 76 px and an icon legend. Mobile keeps the same bar. |
| Backgrounds flat or one muted field; "no aurora blobs" | **Six built-in backgrounds**, large soft gradients plus film grain, two photos. Still no hard shapes, no banding blobs, no gradient text | The brief asks for a beautiful background. The anti-goal was written for a single quiet field; its real intent (no loud decoration, content stays legible) is kept by the scrim and contrast rules in section 4. |
| "No glassmorphism; translucency only on overlays and the rail" | **Translucent tiles and bars over the background**, blur 16 px, one level deep | On a photo, opaque tiles look like a pasted grid and flat tiles lose legibility. Translucency is the cheapest way to keep both. Limit: never stack glass on glass, and the contrast floor in section 4 applies. |
| Single click opens the *detail page*; double-click opens the service | **Click launches** (opens the service URL). Details live behind a small `⋯` menu on the tile | This is the product's main job (Homepage replacement). Detail is the exception. |
| Animation ≤ 180 ms, ≤ 260 ms page-level | Interaction stays ≤ 200 ms. **Entrances up to 420 ms** (staggered, total under 700 ms). **Ambient** motion allowed: background drift, sparkline tick, dot pulse | Entrances are what make a page feel composed rather than dumped. Ambient motion is slow and cheap (transform and opacity only). |
| Serif only for greeting, hero titles on detail pages, wordmark | Serif also for **top-level page titles** (Home greeting, Uptime, Containers) | One editorial moment per page, consistent across the three pages. Everything else stays Inter. |
| `--ink-2` `#a7adb5` | `#b0b6bd` | Secondary text now sits on translucent surfaces over imagery; the extra lightness keeps it above 4.5:1. |

**Kept unchanged:** dark as the identity; Inter Variable plus Source Serif 4; the type scale; tabular
numerals; status colours and the "unhealthy is amber, never red" rule; hairlines; the single accent (sage
by default, the other accents still work on all six backgrounds); tokens in `tokens.css`.

**Typography, kept on purpose.** I looked for something better and did not find it. Inter is already
installed and renders tabular figures well, which matters for the host strip and ribbons; Source Serif 4
supplies the one warm, editorial note that stops a dashboard looking like a dashboard. The only
additions: numerals at weight 300 for big figures (40 to 56 px), and the serif extension in the table.

## 2b. Round 2 changes

- **Greeting name** is the administrator's account name (`admin` by default), not a made-up first name. The mockup takes `?user=` to show others.
- **Account menu** (avatar, top right) holds Appearance (theme, six backgrounds, accent), Settings and Sign out. The floating background dock is gone. There is no separate gear.
- **Host stats expand.** Clicking CPU, Memory, Network, Disk or Temp opens a larger chart under the strip with 1 hour, 24 hours and 7 days, a hover read-out, an average line, the peak marked, and now/average/peak/lowest figures. Esc or the close button collapses it. Needs the single host sampler to keep 7 days (the mockup assumes minute, 15-minute and hourly points).
- **Containers** is the Portainer replacement surface. Every row shows state, image and tag, port, CPU and memory, and one-click Stop/Start, Restart, Logs and Recreate; an accent "Update to x" button appears only when an update exists. Every change opens a confirm dialog that lists, in plain words, what will and will not happen (volumes kept, rollback on failure). The update dialog shows live steps: pull, recreate, wait for healthy. The detail drawer adds the per-container toggles (check for updates, auto-heal) and the Home overrides (name, link, icon, visibility) that moved off Settings.
- **Add compose block:** paste, validate as you type (errors and warnings with line numbers and a fix hint, gutter marks on the bad lines), review what will be created, then confirm. Policy refusals are shown, not hidden: privileged mode, mounting the Docker socket, ports already used. Nothing runs until the last step.
- **Bell** is specified in section 7 and shown in all four states.
- **Settings** has exactly five sections. Docker connection shows the container-listing check (not just "socket found") and how to fix a refusal. Telegram adds a "Send me" choice of event kinds (a small addition to today's policy; flagged below).
- **First run** has three steps, as asked. The Docker step performs the same container-listing check and explains the refusal case with the fix.

## 3. Layout and navigation

- **Top bar**, sticky, 60 px, translucent: wordmark (serif), `Home · Containers · Uptime`, then search
  (`Ctrl K`), bell with a count badge, settings. Active page is a soft pill.
- **Content column** 1280 px max, 24 px gutters (14 px on mobile). Home is a main column plus a 340 px
  rail; under 1100 px the rail drops below, under 600 px tiles go two across.
- **Settings** has five sections (Docker connection, Notifications, Monitoring, Appearance, Account); the
  gear opens it. Appearance holds mode, accent and the background picker.

## 4. Backgrounds

One setting, `appearance.background`, set to one of six fixed ids; anything else falls back to
`graphite`. No uploads, no URLs, no custom CSS.

| id | Name | Recipe | Scrim top / bottom |
|---|---|---|---|
| `graphite` (default) | Graphite | Near-black with soft sage and slate light from the top corners | none |
| `dusk` | Dusk | Violet glow top right, rose glow bottom left | .04 / .14 |
| `forest` | Forest | Green and deep teal glows | .04 / .14 |
| `ember` | Ember | Amber glow top right, brick glow bottom left | .04 / .14 |
| `ridge` | Ridge (photo) | Layered mountain silhouettes under a dusk-to-sunset sky | .12 / .40 |
| `city` | City (photo) | Out-of-focus night lights | .10 / .30 |

- **Build:** a fixed layer behind the page: art, then scrim, then 7% film grain. The art drifts 2 to 3%
  over 120 s (transform only). Gradients cost zero bytes. The two photos are **bundled** WebP files,
  1920 px wide, at most 160 KB each, loaded only when selected. They need a redistributable licence
  (CC0 or your own); the mockups use generated stand-ins.
- **Theme:** backgrounds apply to the dark theme. The light theme keeps its flat paper background (open
  question 4).
- **Legibility is the hard constraint.** Text sits on a tile, or on a soft local plate with a shadow
  (section headings, greeting). The photo backgrounds raise tile opacity to .70. Worst-case contrast of
  `--ink-2` on a tile over the brightest region, computed by hand: Ridge horizon 5.4:1, Ridge glow 6.5:1,
  City bokeh 4.8:1 to 5.2:1; primary text 8.5:1 or better. Implementation must replace this with a script
  that samples the real images and fails the build under 4.5:1.

## 5. Home

Top to bottom (the mockup shows exactly this):

1. **Greeting**: serif, 36 to 56 px, italic accent on the name; below it one line of counts
   (monitors up, need attention, updates). Right: live clock and date.
2. **Host strip**, one line: CPU, Memory, Network, Disk, Temp, Uptime. Each has a value and, for the first
   four, a live sparkline. Wraps to 3 then 2 columns. *Source:* the single host sampler (section 9).
3. **Needs attention**, shown only when something is wrong: one row per container that is unhealthy,
   stopped, or monitored-down, with the reason ("stopped 38 min ago · auto-heal paused after 3 tries") and
   one action. Amber border. Hidden entirely when all is well.
4. **Stacks**: one section per Compose stack, heading plus "3 containers · all running", then tiles.
5. **Rail**: *Updates available* (from, to, Review; footer says when it last checked and that nothing is
   applied automatically), *Uptime* (7-day figure, 3 to 4 mini ribbons for the worst 12 hours), *Bookmarks*
   (flat chips).

### Launch tile

- Minimum 236 × 128 px, radius 18, translucent surface, hairline border.
- Anatomy: 46 px icon (tinted by stack hue, derived from the stack name, muted), health dot top right
  (with the word for non-healthy states), name 15.5 px semibold, port (or URL host) below, an update chip
  (`↑ 10.9.8`) bottom right when an update exists.
- Whole tile is one `<a>`. Hover: lift 3 px, border brightens, a soft spotlight follows the pointer in
  the stack's hue, icon tilts and scales 1.07. Press: settles back. Focus: 2 px accent ring.
- States: **ok** green dot; **unhealthy** amber dot, pulsing, amber border; **down/stopped** red dot, desaturated
  icon, red border. A tile never goes grey-and-dead; you can still open it.
- Not drawn in the mockup: the `⋯` menu (Details, Logs, Restart, Update), shown on hover or focus.

### Empty and error states

Docker not connected: the whole tile area becomes one sentence plus "Configure Docker →", as today. No
containers: the same, with "Add a compose block →". No updates: the widget says "Everything is up to date
· checked 2 h ago". No incidents: the uptime widget shows only the percentage.

## 6. Uptime and the pulse ribbon

Header: serif title, range switch (24 hours / 7 days), **Defaults** (popover), **Add monitor**. Then a
four-figure summary (uptime, up now, incidents, average response) and one ribbon row per service, sorted
down, then slow, then up, then by name.

### The ribbon

One continuous shape per service across the whole range.

| Property | Encodes | Rule |
|---|---|---|
| Colour | State | Green up, amber slow or unhealthy, red down, grey no data. **Hard edges** where state changes. |
| Thickness | Response time | A hairline at the service's healthy baseline, swelling smoothly up to about 5× baseline, where it fills the row. Down is a thin red line (no response, so nothing to measure). |
| Notch | Incident start | A small triangle above the ribbon, amber or red; pulses while ongoing. Focusable, with its own label. |
| Right column | Value under the cursor | Latency and state at the scrubbed time; reverts to "now" when the pointer leaves. |

Thickness is normalised **per service** (against its own baseline), so a fast service and a slow one
read the same way: thick means "slower than usual for this service", not "slower than the others".

**Hover scrub:** a vertical guide crosses all rows at the pointer. A bubble on the time axis names the
exact time, a tooltip names the hovered service, its state and latency, and every row's right column
updates, so you can compare services at one instant. Notches show the incident instead ("Down · 22 min ·
started Sun 10:31"). Touch: drag across a ribbon. Keyboard: focus a ribbon, `←` `→` move one sample,
`Shift` moves twelve, `Home` and `End` jump, `Esc` clears.

**Accessibility:** each ribbon is `role="img"` with a label giving the range and uptime; the scrub is the
keyboard path to every value. Colour is paired with thickness, notches and text, never colour alone.
A "table view" toggle (same data as rows) is part of the implementation scope.

**Data:** 24 h at 5-minute buckets (288 points). 7 d should use the engine's **hourly buckets** (168
points) rather than the mockup's 30-minute ones; to verify against `monitoring/store.js` before building.
Each point is `{ t, state, latencyMs | null }`. The summary figures come from the same points.

### Incidents and defaults

*Incidents* lists the newest first, each with state dot, cause, start time, duration, and "ongoing" or
"resolved". *Defaults* is the compact monitoring panel (decision 8 in the plan): interval, timeout,
failures before down, successes before up, history kept, allow internal targets, auto-create from
discovery, and one "Advanced" disclosure for concurrency, jitter and caps. The same panel is the
Monitoring section of Settings.

## 7. The bell: notifications plus recent activity

This replaces the Activity page. A 400 px popover under the bell, opaque enough to read over any background.

- **Needs you:** notification rows with a severity dot, one-line title, one-sentence detail, age, a small
  paper-plane mark when it also went to Telegram, and one to three actions (Open, Restart, Logs,
  Acknowledge). Acknowledge dims the row and is remembered.
- **Recent activity:** a rule-and-dot timeline of the day: state changes, auto-heal attempts, update
  checks, and your own actions (the audit record). "View all" opens the same list longer, in the same panel.
- Closes on outside click or `Esc`; focus returns to the bell. The badge counts unacknowledged rows.

## 8. Motion

| Name | Where | Spec |
|---|---|---|
| Entrance | Hero, host strip, stack sections, rail widgets | Fade and rise 14 px, 420 ms, `cubic-bezier(.16,1,.3,1)`, 45 ms stagger per block (under 700 ms total) |
| Hover lift | Tiles, chips, attention rows | 220 ms, `cubic-bezier(.22,.61,.36,1)`; spotlight fades in 240 ms |
| Popovers | Bell, defaults | 200 ms scale .97 to 1 plus fade, from the trigger corner |
| Ribbon draw | Uptime, on load and range change | Left-to-right clip reveal, 1000 ms, staggered 55 ms per row |
| Scrub | Guide, bubble, tooltip | 140 ms fade; the guide itself follows the pointer with no easing |
| Sparkline tick | Host strip | Every 1.6 s the path slides one step (linear); data shifts and redraws in the same frame |
| Background drift | Behind everything | 120 s alternate, transform only |
| Attention pulse | Amber dots, ongoing incident notches | 2.2 to 2.4 s ring, opacity and scale only |

All of it uses `transform` and `opacity`. `prefers-reduced-motion` removes every row except hover colour
and popover fades: no entrance, no drift, no ticking sparklines (they render once, statically), no pulse.

## 9. What this means for the code

| Area | Change |
|---|---|
| Shell | `App.tsx` rail replaced by the top bar; the rail CSS goes. The shared SSE connection stays (it keeps the bell live). |
| Home | New `Home` page replaces Hub. Reuse `ServiceLauncher` logic for grouping; drop widget composition (plan commit 12). Stack hue from a hash of the name. |
| Host strip | Uses `/api/system/history`. **Gap:** the sampler (`History` in `providers/system.js`) records CPU, memory, load, network, temperature and processes but not disk. Add one `diskUsedPct` field for the primary mount; no second sampler (plan decision 9). |
| Uptime | New ribbon component from the monitor series; keep the monitoring engine and API as they are. Possible small addition: a series endpoint at the two resolutions if the existing monitor document does not already carry them. |
| Bell | Notification list plus an activity list from `activity.js`; acknowledge writes through the existing alert-ack route. The Activity page is deleted afterwards (plan commits 10 and 11). |
| Backgrounds | A fixed id list in `appearance.background`, a Settings picker, CSS for the four gradients, two bundled WebPs. Old object-shaped values are treated as unset. |
| Settings | Five sections. The compact Monitoring panel replaces the current pane. |
| Performance | Backdrop blur is the one expensive effect. Budget: blur on bars, panels and tiles only, never nested; add `@media (prefers-reduced-transparency)` and a no-`backdrop-filter` fallback that makes surfaces opaque (the mockup already has the latter). Measure Home with 40 tiles before shipping. |
| Tests | DOM tests for the tile states, scrub keyboard path and bell; a contrast script over the six backgrounds. |

## 10. Decisions I need from you

1. **Tile click:** launch the service (proposed), or open the detail page as today?
2. **Top bar instead of the rail:** acceptable? It is the biggest structural change.
3. **The two photos:** which subjects, and from where? They must be redistributable. Ridge and City are placeholders for "landscape" and "night city".
4. **Light theme with backgrounds:** keep the light theme flat (proposed, cheapest), or design light twins of all six?
5. **Glass:** are you comfortable overruling "no glassmorphism" for tiles and bars, under the contrast rules above?
6. **Ribbon resolution for 7 days:** hourly buckets (proposed, no new storage) or 30-minute?
7. **Sparkline window:** the mockup shows about 4 minutes of live data. Is that the right feel, or should it show the last hour?
8. **Alert acknowledge** in the bell: keep (drawn) or drop?

### Decided (round 2 review)

- **Telegram "Send me" toggles:** keep them while there are three or fewer (Downtime, Auto-heal, Updates). If a fourth kind is ever added, replace them with one severity choice. The mockup's "Info" checkbox is dropped.
- **Wizard:** admin, Docker, done. Nothing else.
- **Container action dialogs:** Start and Restart run without a dialog. Stop, Recreate, Update and Remove get a confirm dialog. The mockup's Restart confirm is dropped, and Remove needs adding to the Containers mockup.
- **Host sampler:** gains a disk field (`diskUsedPct`) and coarser retention so the 7-day chart works (for example per-minute points for 1 h, 15-minute for 24 h, hourly for 7 d). It stays the only history sampler.
