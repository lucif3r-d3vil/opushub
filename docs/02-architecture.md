# OpusHub — Architecture

Status: V1 · Supersedes nothing; this is the founding document. See `01-audit.md` for what existed
before (an empty tree) and why the choices below were made.

OpusHub is the visual control center of the OpusGrid homelab. It is a website — multiple pages,
real navigation, a persisted configuration — not a single dashboard screen. It is deliberately
narrow in scope (read-mostly visibility + safe, implemented actions only) and deliberately clean in
seams, so that the future OpusGrid control plane can attach to the same provider/config layer.

## Shape

```
opushub/
├── config/                  # user-editable YAML state (the product's source of truth)
│   ├── services.yaml          groups → services (name, icon, href, description, stack, meta)
│   ├── stacks.yaml            stacks → member services, notes
│   ├── settings.yaml          appearance, integrations, behavior (theme, accent, feeds, …)
│   ├── bookmarks.yaml         flat link collection
│   ├── layout.json            hub section order / widget visibility / service order (persisted by drag&drop)
│   ├── theme.css              optional custom CSS (Homepage-style)
│   ├── app.js                 optional custom JS (disabled unless explicitly allowed)
│   ├── icons/                 local icon files, served at /user/icons/*
│   ├── backgrounds/           local background images, served at /user/backgrounds/*
│   └── .env                   secrets (git-ignored) — discovered, never sent to the client
├── data/                    # runtime state (git-ignored): activity log, metric history
├── server/                  # Node 22, ESM, zero framework
│   ├── index.js               HTTP app: /api/* + static hosting of the built SPA
│   ├── env.js                 .env discovery + loading (the bug fix)
│   ├── configStore.js         YAML read/atomic write via `yaml` Document (comments preserved)
│   ├── api.js                 routes
│   ├── activity.js            append-only JSONL event log + query
│   ├── metrics.js             ring-buffer history for charts
│   ├── search.js              unified search across config + providers
│   └── providers/
│       ├── system.js          /proc + /sys host metrics (real, always available on Linux)
│       ├── docker.js          Docker Engine via unix socket/DOCKER_HOST, read-only
│       ├── news.js            server-side RSS/Atom fetch + cache (CORS-free)
│       ├── weather.js         Open-Meteo (no key needed), configurable location
│       ├── market.js          Stooq quotes + daily history for sparklines (no key needed)
│       └── icons.js           local @iconify-json collections first, Iconify API proxy fallback
└── src/                     # React 19 + TypeScript (Vite)
    ├── shell/                 navigation rail, page transitions, background layer
    ├── pages/                 Hub, Services, ServiceDetail, Stacks, StackDetail,
    │                          System, Activity, Settings (tabbed)
    ├── components/            Icon, charts (hand-drawn SVG), timeline, search overlay,
    │                          drag/sortable, settings controls, empty/unavailable states
    ├── lib/                   api client + polling hooks, theme applier, formatting, search index
    └── styles/                tokens.css + component css (no utility CSS, no framework)
```

## Configuration discovery (the `.env` fix)

The previous failure mode: a `.env` existed somewhere and the loader looked at exactly one hard-coded
path. The loader now resolves, in order, and **logs every attempt**:

1. `OPUSHUB_ENV_FILE` (explicit file path) — always wins if set and readable.
2. `$OPUSHUB_CONFIG_DIR/.env` (next to the YAML config — the recommended location).
3. `<app-root>/config/.env`.
4. `<app-root>/.env`.
5. `$HOMEPAGE_DIR/.env` (migration path for Homepage installs).
6. `/app/config/.env` (container convention).

The first readable file wins; all found files are parsed, later ones never override earlier ones.
Values already present in `process.env` are never overridden (real environment beats files).
`/api/health` exposes which files were found and which keys are set (**key names only — values
never leave the server**). This makes the whole class of bug observable instead of silent.

Supported syntax: `KEY=value`, quotes, `#` comments, `export` prefix. Secrets referenced by config
(e.g. an icon repo token) are resolved server-side only.

## Provider contract

Every integration is a module with the same shape — the UI renders status, never guesses:

```js
{ provider: "docker", status: "ok" | "unavailable" | "error",
  reason?: "Docker socket not found at /var/run/docker.sock",
  checkedAt, cacheTtlMs, data? }
```

`unavailable` is honest and styled (it is *not* an error dialog); data is only shown when `ok`.
Providers cache on the server; the browser polls on sensible intervals and pauses when the tab is
hidden. Nothing polls Docker or /proc harder than needed: system 5s (cheap /proc reads + in-memory
buffer), services/stacks 30s, news 10min, markets 5min, weather 15min.

Caching is an in-memory `TimedCache` per provider with bounded size and per-source TTLs; failure
results are cached briefly (60s) so an unreachable source is retried gently rather than hammered.

## API surface (all under /api, same-origin only)

| Route | Notes |
| --- | --- |
| `GET /api/health` | version, paths, env-file names, provider availability summary |
| `GET/PUT /api/settings` | appearance/integrations/behavior; PUT = partial deep-merge, atomic YAML write, logged to Activity |
| `GET/PUT /api/layout` | hub section order, widget visibility/size, service order overrides |
| `GET /api/services` | config + live status merged per service when Docker is available |
| `GET /api/services/:group/:name` | detail incl. container/stack join |
| `GET/PUT /api/services` | full YAML document (safe subset), write preserves comments |
| `GET/PUT /api/stacks`, `GET /api/stacks/:id` | stacks + joined member status |
| `GET/PUT /api/bookmarks` | |
| `GET /api/system` · `GET /api/system/history?window=` | real host metrics + chart history |
| `GET /api/docker/containers` · `GET /api/docker/containers/:id/logs?tail=` | read-only; `unavailable` without socket |
| `GET /api/news` · `/api/weather` · `/api/market` | provider passthrough with cache |
| `GET /api/activity?limit&source` | timeline events (config writes, app lifecycle, docker events, provider state changes — all real) |
| `GET /api/search?q=` | pages · services · stacks · bookmarks · settings keys · news (debounced by client) |
| `GET /api/icons/search?q=` | local collections, then Iconify; `GET /api/icon?ref=` returns SVG |
| `GET /user/icons/*`, `/user/backgrounds/*` | static, path-traversal guarded |

Mutations are limited to *configuration* (yaml/json writes, atomically via temp+rename, each
preceded by a copy of the previous contents in `data/config-backups/`, 20 per file). There is
no endpoint that executes commands, restarts containers, or touches the socket for writes. Action
buttons for restart/update are rendered **only** when the backing capability reports `ok` (V1 ships
none — everything is Open/Details/Logs where real).

## Frontend architecture

- **Routing**: React Router with pages per §6 of the brief; hub is `/`, not a dashboard island.
  Pages: `/`, `/services`, `/services/:group/:name`, `/stacks`, `/stacks/:id`, `/system`,
  `/activity`, `/settings/:tab`, `/icons`.
- **Data**: tiny typed fetch client + `usePolledQuery(path, ttl)` (stale-while-revalidate,
  visibility-paused). No global store — provider data is local to what asks for it; theme/layout
  live in two contexts. This keeps re-renders scoped and avoids a state library.
- **Theme**: CSS custom properties in `tokens.css` ([data-theme] + [data-density] + `--accent`);
  a JS applier reads settings, applies instantly (live preview) and persists on debounce. Fonts:
  Inter Variable (UI) + a serif display face used *only* for the greeting and stack/service heroes.
- **Charts**: hand-rolled SVG (sparkline, area with gradient-to-baseline, meter bars). No chart lib.
- **Drag & drop**: pointer-events sortable built in-house (`SortableList`): grab handle appears on
  hover, 2px drop indicator, FLIP animation on settle, keyboard movable (space to pick, arrows to
  move), writes order to `/api/layout`. Reordering hub sections, widgets and services — one
  mechanism.
- **Search**: `/` or ⌘K opens the command overlay. Index built client-side from data already on
  the page + `/api/search` for anything remote (news). Fuzzy subsequence scoring, grouped results,
  arrows/Enter navigation; actions ("Toggle theme", "Edit services.yaml") appear as results.
- **Icons**: `IconRef` resolution order: absolute URL → `/user/icons/` path → `set:name` (local
  collections via `/api/icon`) → letter monogram fallback (deterministic muted hue). Never a broken
  image; monograms are part of the design system, not an accident.

## Performance & resilience

Server: single process, no deps beyond `yaml`. ETag/`Cache-Control` on API json; gzip skipped (LAN).
Client: route-level `React.lazy`, fonts self-hosted via @fontsource (no external fetch), icon SVGs
cached by browser, provider responses cached server-side, `IntersectionObserver` defers hub widgets.

## Security posture

Read-mostly by construction; no shell, no docker writes, no arbitrary file access (allow-listed
config filenames only), `.env` values never serialized to any response, SPA served same-origin with
CSP (self assets + user-configured inline custom css/js opt-in). Intended for LAN/VPN; a warning is
shown if bound beyond localhost? — V1 documents this in README.

## What V1 explicitly is not

Kubernetes, VMs, orchestration, IAM, automation, Unraid/Portainer replacement. Activity events,
metrics and statuses all describe what genuinely happened on the host the server runs on. The design
system (§ `03-design-system.md`) governs every surface so it reads as one place, not a card farm.
