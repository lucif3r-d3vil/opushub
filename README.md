# OpusHub

**The control center of the OpusGrid homelab.** Not a dashboard — a website you visit: a Hub that
greets you with the state of your machines and your morning, a directory of services with real
detail pages, stacks with their containers, host vitals from `/proc` and nothing else, an activity
timeline of things that genuinely happened, and a settings surface where everything you change is
written to real YAML you can read and edit by hand.

```
npm install
npm run build      # builds the SPA into dist/
npm start          # serves app + /api on :3000 (OPUSHUB_PORT to change)
```

Then open the URL — it works on desktop, tablet and phone. During development:
`npm run dev:web` (vite build --watch) in one terminal and `npm run dev` (node --watch) in another,
or just use the built app — the node server serves it.

## What OpusHub is

| Page | What it shows |
| --- | --- |
| **Hub** (`/`) | Greeting + clock, global search (`/` or ⌘K), host overview strip, draggable service launcher, rail widgets: weather, markets, news, bookmarks, recent activity — all reorderable, resizable (S/M/L), hideable, persisted |
| **Services** (`/services`) | The full directory, grouped; live status when Docker is connected; click → OpusHub's own service page |
| **Service page** (`/services/:group/:name`) | Identity, runtime stats (real, from Docker), infrastructure (ports/networks/volumes), related activity, Open/Logs actions only where actually implemented |
| **Stacks** (`/stacks`) | Groups of containers that deploy together, aggregate status |
| **Stack page** (`/stacks/:name`) | Member containers with stats, ports, networks, volumes, logs drawer |
| **System** (`/system`) | CPU / memory / storage / network / host — oversized numerals, per-core grid, charts from a real 5s sample history, honest `Unavailable` where the kernel offers nothing |
| **Activity** (`/activity`) | Timeline of real events: config writes, launches, app lifecycle, Docker state changes |
| **Settings** (`/settings/…`) | Appearance (theme, accent, density, background — live preview, no restart), Hub templates & widget control, services/bookmarks editor with icon picker, integrations, system/env diagnostics |
| **Icons** (`/icons`) | Bundled Lucide + Material Design Icons + Simple Icons (resolve offline), Iconify when online, your own files in `config/icons/`, monogram fallback by design |

## Configuration & `.env` discovery

Everything user-facing lives in `config/`:

```
config/services.yaml    groups → services (name, app, href, icon, container, stack, meta)
config/stacks.yaml      stacks → member services, compose path, notes
config/settings.yaml    appearance, hub behavior, integrations (news feeds, weather, markets)
config/bookmarks.yaml   flat links
config/layout.json      hub layout written by drag & drop
config/theme.css        optional custom CSS (enable in Settings → System)
config/app.js           optional custom JS (enable deliberately)
config/icons/           served at /user/icons/*
config/backgrounds/     served at /user/backgrounds/*
config/.env             secrets — see below
```

`.env` is discovered in an explicit order (first hit wins per key, real environment always beats
files, every attempt is logged on boot and reported — by *name only* — at `GET /api/health`):

1. `$OPUSHUB_ENV_FILE` 2. `config/.env` 3. `./.env` 4. `$HOMEPAGE_DIR/.env` 5. `/app/config/.env`

This exists because a previous build shipped a `.env` that the app simply never looked for. See
`docs/01-audit.md`.

## Data policy

- **No fake data, ever.** System metrics are read from `/proc` and `/sys`. Docker state comes from
  the Engine API over the socket (`OPUSHUB_DOCKER_SOCKET` / `DOCKER_HOST`) — read-only. News fetches
  your RSS feeds through the server. Weather uses Open-Meteo, markets use Stooq (both keyless).
- If a source is missing, disconnected, or unreachable, every affected widget says **Unavailable**
  and shows the real reason ("no Docker socket found…", `SSL_ERROR_SYSCALL`…) with a link to fix it.
- Secrets never cross the API boundary: `.env` values stay in the server, container env vars are
  stripped from Docker projections, `/api/health` exposes key *names* only.
- No shell execution. No container restart/update endpoints in V1 — buttons exist only where the
  action genuinely works.

## Architecture

See `docs/02-architecture.md` (layout, provider contract, API surface) and
`docs/03-design-system.md` (the visual rules this UI is held to). Frontend: React + TypeScript,
no UI framework, hand-drawn SVG charts, in-house drag & drop. Backend: plain Node 22, the `yaml`
package, one process.

```
docs/01-audit.md            what was found in the repo before any change (an empty tree)
docs/02-architecture.md     seams: providers, config store, API
docs/03-design-system.md    type, color, space, motion — the anti-"AI dashboard" rules
server/                     HTTP API + providers + atomic config store
src/                        React app (pages · shell · components · styles)
config/                     YOUR state, committed here in this repo
data/                       runtime log + metric history (gitignored)
```

## Status & scope

OpusHub is V1 of the OpusGrid vision: visibility and safe navigation, not orchestration. Kubernetes,
VMs, backups and automation belong to the future control plane — this app is its front door, and
the provider/registry seams are drawn so it can grow into that without a rewrite.

Run it on the LAN or behind a VPN. It ships with no auth by design (it is your homelab's
entrypoint, not a public service); put a reverse proxy with auth in front if you expose it.

## Development checks

```
npm run check               # tsc + production build
npm test                    # 45 tests: provider, model, env, API boundary (mock engine)
npm run mock-engine         # standalone fake Engine API for live validation:
                            # OPUSHUB_DOCKER_SOCKET=/tmp/opushub-mock-docker.sock npm start
```
