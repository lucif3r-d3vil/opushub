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

## Install

```bash
mkdir -p ~/opushub && cd ~/opushub
# save docker-compose.yml from this repository here, then:
docker compose up -d
```

Open `http://<this-host>:3000`. The first-run wizard takes it from there: create the administrator
account, confirm the Docker endpoint, look over what discovery found, and finish — signed in, on the
Hub. (Set the socket group first if you want Docker visible immediately: `stat -c '%g'
/var/run/docker.sock`, then uncomment `group_add` in the compose file. Without it the wizard honestly
reports Docker as not connected.)

The image is `ghcr.io/lucif3r-d3vil/opushub:latest`, and the compose file mounts exactly what the app
needs: `./config` (your presentation), `./data` (the account and runtime state) and
`/var/run/docker.sock:ro`.

**Keep port 3000 on your LAN.** OpusHub reads host vitals, container logs and your whole inventory;
its login is one local account, not an identity provider. Use a VPN or a reverse proxy with its own
auth if you need it from outside — never publish 3000 to the Internet.

Full detail — tags, persistence, backups, updating, the socket's implications and a troubleshooting
table — is in [`docs/07-distribution.md`](docs/07-distribution.md); the authentication model is in
[`docs/06-auth.md`](docs/06-auth.md).

### Run from source instead

```
npm install
npm run build      # builds the SPA into dist/
npm start          # serves app + /api on :3000 (OPUSHUB_PORT to change)
```

During development: `npm run dev:web` (vite build --watch) in one terminal and `npm run dev`
(node --watch) in another, or just use the built app — the node server serves it.

## What OpusHub is

| Page | What it shows |
| --- | --- |
| **Hub** (`/`) | Greeting (name, date, real time, weather when configured) + global search (`/` or ⌘K), host summary strip, the draggable service launcher built from the live inventory, and rail widgets — clock, weather, news, markets, bookmarks, activity, stacks, attention. Every widget has a zone (main/sidebar), a size (S/M/L), visibility and its own config; drag to reorder, resize or hide, all persisted. Composition presets live in Settings → Templates |
| **Services** (`/services`) | Every discovered container, grouped; applications and infrastructure rails separated by what the engine says about them; click → OpusHub's own service page |
| **Service page** (`/services/:group/:name`) | Identity, runtime stats (real, from Docker), infrastructure (ports/networks/volumes), related activity, Open/Logs actions only where actually implemented |
| **Stacks** (`/stacks`) | Compose projects as Docker reports them (`com.docker.compose.project`), with their member containers, plus standalone containers; aggregate status |
| **Stack page** (`/stacks/:name`) | Member containers with stats, ports, networks, volumes, logs drawer |
| **System** (`/system`) | CPU / memory / storage / network / host — oversized numerals, per-core grid, charts from a real 5s sample history, honest `Unavailable` where the kernel offers nothing |
| **Activity** (`/activity`) | Timeline of real events: config writes, launches, app lifecycle, Docker state changes |
| **Settings** (`/settings/…`) | Appearance (theme, accent, density), Background, Hub layout (composition presets + a live preview of the real Hub), Widgets, Templates, Services (customization overlay + icon picker), Groups, Bookmarks, Integrations, System (paths, discovery) and Advanced (custom CSS/JS, refresh intervals) |
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
config/layout.json      hub composition (v2): widget instances with zone/size/visibility/config,
                        spacing, section order, per-group service order — written by drag & drop
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
  your RSS feeds through the server. Weather uses Open-Meteo, markets use Yahoo Finance's
  public chart endpoint (both keyless).
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
docs/05-service-intelligence.md  Phase 3: read-only depth — stats, logs, history, stack health,
                            provider health — and the read-only boundary that bounds all of it
docs/06-auth.md             the door: account, sessions, cookies, CSRF, throttle, what is public,
                            and the security review table
docs/07-distribution.md     the image and GHCR tags, installing, the socket, volumes, backups,
                            updating, troubleshooting
Dockerfile                  multi-stage build; runtime config is a mount, never a COPY
docker-compose.yml          the clean install (image + name + restart + volumes + socket :ro)
.github/workflows/ghcr.yml  publishes the image on main and on v* tags, with GITHUB_TOKEN only
scripts/opusgrid-inspect.sh read-only inspection of the metadata discovery reads, on your host
server/                     HTTP API + discovery + providers + atomic config store
src/                        React app (pages · shell · components · styles)
config/                     YOUR state, committed here in this repo
data/                       runtime log + metric history (gitignored)
```

## The container image

Three stages (deps → build → runtime), production dependencies only, running as the unprivileged
`node` user, `SIGTERM`-aware, with a healthcheck on `/api/health`. The image contains code only:
`.dockerignore` keeps `config/`, `data/`, `.env`, keys and `dist/` out of the build context, so
nothing host-specific is baked into a layer — `test/docker.test.js` asserts that line by line.

Published to GHCR as `ghcr.io/lucif3r-d3vil/opushub` (`:latest`, `:1.4.0`, `:sha-abc1234`), built
for `linux/amd64` first, authenticated with `GITHUB_TOKEN` and verified (`typecheck` + tests + build)
before anything is pushed. The container user gets socket access through `group_add` (the socket's
GID) rather than root, and `OPUSHUB_HOST_ADDRESS` is the only networking hint it can be given — and
it is optional, used solely for containers that publish a port without proxy labels.

Build it yourself with `docker build -t opushub .`; full details in
[`docs/07-distribution.md`](docs/07-distribution.md).

## Status & scope

OpusHub is V1 of the OpusGrid vision: visibility and safe navigation, not orchestration. Kubernetes,
VMs, backups and automation belong to the future control plane — this app is its front door, and
the provider/registry seams are drawn so it can grow into that without a rewrite.

**Phase 3 — read-only service intelligence.** The service page now answers what a container is
doing right now: state and health (a container *without* a healthcheck is never called unhealthy),
uptime, restart count, on-demand resource readings with compact sparklines, read-only logs with
local search/level filtering, published vs exposed ports, mounts and image facts. Stacks get a
documented deterministic status (Operational / Degraded / Attention / Stopped / Unknown) and
rollups; the Activity page is a witnessed timeline with burst grouping and honest *watching since*
markers; Settings → System reports provider health. All of it is strictly observational — no
restart, exec, pull, deploy or write of any kind was added; see
`docs/05-service-intelligence.md` for the boundary and the rules.

**Phase 4 — the door, the details, and distribution.** OpusHub now has one local administrator
account (scrypt, never a plaintext password), server-side sessions in an HttpOnly cookie, CSRF
defence, and a first-run wizard that must be completed before any application API answers. Discovery
got sharper: every compose project becomes a Hub group with a generic display name, service identity
follows a documented precedence (compose service → container name → image → overlay → humanized),
icons resolve through the existing pipeline with a monogram as the honest fallback, and infrastructure
containers are classified and shown on their own rail rather than hidden. The group editor, the
"…" menus and the system charts were rebuilt on real primitives (an anchored portaled menu, an
index-addressed name field, a measured 1:1 chart region). The image is published to GHCR with a
compose file that installs it cleanly. Authentication is a door, not a control plane: nothing about
the read-only boundary changed — no restart, exec, pull or deploy anywhere.

Run it on the LAN or behind a VPN — see `docs/07-distribution.md` for why, and `docs/06-auth.md` for
what the login does and does not protect against.

## Development checks

```
npm run check               # tsc + production build
npm test                    # 240 tests: label grammar, URL precedence, the discovery join, layout v2
                            # normalisation and templates, model integration (with and without
                            # overlays), provider, env, API boundary, the offline contract, the
                            # Phase 3 contract (detail/stats/logs/history/activity/stacks/security),
                            # and Phase 4 (password hashing/sessions/CSRF/throttle, the API door,
                            # generic grouping, labels and packaging) — all against the mock engine
npm run test:web            # 26 DOM interaction checks in jsdom: search hotkeys/arrows/Enter, widget
                            # menus writing the layout, keyboard reordering, preview inertness,
                            # shared-data request counts, the setup/login gate, the group-name
                            # contract (service and bookmark groups), the anchored menu's placement
                            # and the measured chart region (needs the jsdom devDependency)
npm run verify              # the whole API surface against a *scratch* config dir on its own port:
                            # empty config, overlay, hidden/reordered services, templates, search,
                            # detail pages, provider-unavailable paths. Safe on a live host — your
                            # config/ is never touched. OPUSHUB_DOCKER_SOCKET=/var/run/docker.sock
                            # npm run verify points it at the real engine
npm run smoke               # server-render checks: every route renders; the Hub under thirteen data
                            # states (empty, docker off, providers down, unconfigured, hidden,
                            # reordered, unknown widget type, preview, loading, stacks rollup,
                            # attention surfacing incl. provider failures)
npm run smoke:live          # fetches a *running* OpusHub and renders the real Hub from its payloads
                            # (OPUSHUB_URL=http://host:3000 points it at another instance)
npm run mock-engine         # standalone fake Engine API for live validation:
                            # OPUSHUB_DOCKER_SOCKET=/tmp/opushub-mock-docker.sock npm start
                            # (OPUSHUB_MOCK_HIDE=seerr removes a container to test disappearance)
./scripts/opusgrid-inspect.sh   # the same inspection against a real Docker host, read-only
```
