# OpusHub

**The control center of the OpusGrid homelab.** Not a dashboard — a website you visit: a Hub that
greets you with the state of your machines and your morning, a directory of services with real
detail pages, stacks with their containers, host vitals from `/proc` and nothing else, an activity
timeline of things that genuinely happened, and a settings surface where everything you change is
written to real YAML you can read and edit by hand.

**Your containers are the inventory.** Whatever is on the Docker host shows up, named, grouped and
linked by what its own metadata says — Compose project, Traefik rules, published ports. Uninstall
something and it disappears from every page. Nothing is hardcoded, and no domain is assumed, so the
same image runs on any host with no code change. YAML config is optional *presentation*: it renames,
files, icons and orders what Docker already knows about.

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
| **Services** (`/services`) | Every discovered container, grouped; applications and infrastructure rails separated by what the engine says about them; click → OpusHub's own service page |
| **Service page** (`/services/:group/:name`) | Identity, runtime stats (real, from Docker), infrastructure (ports/networks/volumes), related activity, Open/Logs actions only where actually implemented |
| **Stacks** (`/stacks`) | Compose projects as Docker reports them (`com.docker.compose.project`), with their member containers, plus standalone containers; aggregate status |
| **Stack page** (`/stacks/:name`) | Member containers with stats, ports, networks, volumes, logs drawer |
| **System** (`/system`) | CPU / memory / storage / network / host — oversized numerals, per-core grid, charts from a real 5s sample history, honest `Unavailable` where the kernel offers nothing |
| **Activity** (`/activity`) | Timeline of real events: config writes, launches, app lifecycle, Docker state changes |
| **Settings** (`/settings/…`) | Appearance (theme, accent, density, background — live preview, no restart), Hub templates & widget control, services/bookmarks editor with icon picker, integrations, system/env diagnostics |
| **Icons** (`/icons`) | Bundled Lucide + Material Design Icons + Simple Icons (resolve offline), Iconify when online, your own files in `config/icons/`, monogram fallback by design |

## Configuration & `.env` discovery

Everything user-facing lives in `config/`:

```
config/services.yaml    OPTIONAL presentation overlay — one entry per container: displayName, icon,
                        description, group, order, visibility, manual url override
config/stacks.yaml      OPTIONAL presentation overlay — renames/describes a compose project that exists
config/settings.yaml    appearance, hub behavior, integrations (news feeds, weather, markets),
                        host address + proxy entrypoint ports used by URL discovery
config/bookmarks.yaml   flat links
config/layout.json      hub layout written by drag & drop
config/theme.css        optional custom CSS (enable in Settings → System)
config/app.js           optional custom JS (enable deliberately)
config/icons/           served at /user/icons/*
config/backgrounds/     served at /user/backgrounds/*
config/.env             secrets — see below
```

Both overlay files may be empty or absent — the app then shows pure discovery, which is a complete
and useful UI (`docs/04-discovery.md` is the contract: what Docker decides, what config may decide,
and how a URL is resolved). A config entry whose container is gone is reported in
Settings → System → Service discovery and rendered nowhere.

`.env` is discovered in an explicit order (first hit wins per key, real environment always beats
files, every attempt is logged on boot and reported — by *name only* — at `GET /api/health`):

1. `$OPUSHUB_ENV_FILE` 2. `config/.env` 3. `./.env` 4. `$HOMEPAGE_DIR/.env` 5. `/app/config/.env`

This exists because a previous build shipped a `.env` that the app simply never looked for. See
`docs/01-audit.md`.

## Data policy

- **No fake data, ever.** System metrics are read from `/proc` and `/sys`. The service inventory,
  stack membership, URLs and status all come from the Engine API over the socket
  (`OPUSHUB_DOCKER_SOCKET` / `DOCKER_HOST`) — read-only, GET requests only, never cached to disk. News fetches
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
docs/04-discovery.md        the inventory contract: Docker decides existence, config decides appearance
Dockerfile                  multi-stage build; runtime config is a mount, never a COPY
scripts/opusgrid-inspect.sh read-only inspection of the metadata discovery reads, on your host
server/                     HTTP API + discovery + providers + atomic config store
src/                        React app (pages · shell · components · styles)
config/                     YOUR state, committed here in this repo
data/                       runtime log + metric history (gitignored)
```

## Running it as a container

`docker build -t opushub .` then mount your config, data and the socket read-only — see the compose
snippet in `docs/04-discovery.md`. The image contains code only: `.dockerignore` keeps `config/`,
`data/`, `.env` and `dist/` out of the build context, so nothing host-specific is baked into a layer.
The container user gets socket access through `group_add` (the Docker socket's GID) rather than
running as root, and `OPUSHUB_HOST_ADDRESS` is the only networking hint it can be given — and it is
optional, used solely for containers that publish a port without proxy labels.

## Status & scope

OpusHub is V1 of the OpusGrid vision: visibility and safe navigation, not orchestration. Kubernetes,
VMs, backups and automation belong to the future control plane — this app is its front door, and
the provider/registry seams are drawn so it can grow into that without a rewrite.

Run it on the LAN or behind a VPN. It ships with no auth by design (it is your homelab's
entrypoint, not a public service); put a reverse proxy with auth in front if you expose it.

## Development checks

```
npm run check               # tsc + production build
npm test                    # 130 tests: label grammar, URL precedence, the discovery join, model
                            # integration (with and without overlays), provider, env, API boundary,
                            # and the offline contract — all against the mock engine
npm run mock-engine         # standalone fake Engine API for live validation:
                            # OPUSHUB_DOCKER_SOCKET=/tmp/opushub-mock-docker.sock npm start
                            # (OPUSHUB_MOCK_HIDE=seerr removes a container to test disappearance)
./scripts/opusgrid-inspect.sh   # the same inspection against a real Docker host, read-only
```
