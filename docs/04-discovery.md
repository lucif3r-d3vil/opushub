# Discovery — how OpusHub knows what exists

This document is the contract for everything the Hub, Services, Stacks and search pages show. It
exists because the model before it was wrong in a specific, damaging way: `config/services.yaml` was
the source of truth and Docker was a status decorator. Services that had been uninstalled years
earlier kept rendering, config entries invented URLs (`http://seerr.opusgrid.home.arpa:5055`) that
nothing served, and the same application appeared twice — once as the configured row, once as the
discovered one.

That is inverted now. One rule decides everything:

> **Docker decides what exists. Config decides how it looks. Neither may do the other's job.**

## Flow

```
Engine API ──▶ normalize ──▶ parse labels ──▶ resolve URL ──▶ bind overlays ──▶ classify ──┐
   (read-only)  one record    dockerLabels.js   urlResolver.js  services.yaml /              │
                              per container                  stacks.yaml (optional)          ▼
                                                             one canonical object per container
                                                             ──▶ /api/services · /api/stacks
                                                                  /api/search · /api/discovery
```

Modules: `server/discovery.js` (the inventory), `server/providers/dockerLabels.js` (label grammar),
`server/urlResolver.js` (the precedence list), `server/lib/hostAddress.js` (the host's own address),
`server/model.js` (overlay files + cache + the single join).

## What Docker decides

Every field below comes from the engine and cannot be set from config:

| Field | Source |
| --- | --- |
| `name`, `id` | container name and 12-char id — the key for detail routes |
| `image`, `imageId` | `Image`, `ImageID` |
| `state`, `status`, `health` | `State`, `Status`, `State.Health` (or the `(healthy)` suffix the list API puts in `Status`) |
| `created`, `restartCount` | `Created`, inspect `RestartCount` |
| `composeProject`, `composeService` | `com.docker.compose.project`, `.service` |
| `networks`, `ports` | `NetworkSettings.Networks`, `Ports` |
| `labels` | the curated projection only (below) |
| `url`, `urlSource`, `urlNote` | `urlResolver` — see precedence |

One container is one object. Two overlays cannot make two rows, and no container can be listed
twice — `name` is unique in Docker, so it is the identity, and the id is the tiebreaker.

## What config may decide

`config/services.yaml` and `config/stacks.yaml` are **optional presentation overlays**. Both files
may be empty, absent, or wrong, and the UI stays live and honest. Overlay fields — service:
`displayName`, `app`, `description`, `icon`, `group`, `order`, `hidden`, `showOnHub`, `keywords`,
`meta`, `url` (override). Stack: `displayName`, `description`, `icon`, `notes`.

**Binding.** An entry attaches to a container by `container:` (exact name or id prefix —
authoritative) or by `name:` matching a container name, compose service name, or the base name after
the compose prefix is unwrapped. There is no fuzzy matching: the old `image.includes(name)` join was
what produced phantom and duplicate rows. If nothing matches, the entry is *reported* — as
`unmatched` in the API payload and in **Settings → System → Service discovery** — and rendered
nowhere. Two entries fighting for one container produce one object plus one report naming the winner.

**Enrichment, never creation.** `Docker absent + config present` → nothing displayed.
`Docker present + config present` → one object, config's fields layered on Docker's. Remove the
container and the row disappears — including its display name, group, icon and manual URL. That is
the point of keying everything to the container: a rename in `services.yaml` cannot outlive the thing
it renames.

## Container labels are also an overlay

Metadata on the container itself is honoured with no config file at all, which is often the better
place for it (next to the image tag, in version control, portable with the stack):

```yaml
labels:
  opushub.displayName: Wave
  opushub.group: Music
  opushub.icon: lucide:waves
  opushub.description: Lossless, everywhere
  opushub.meta.Library: 312 GB FLAC
  opushub.url: http://192.168.1.20:4533   # manual override, urlSource "manual"
  opushub.hidden: "true"
  opushub.stack: Media                     # presentation only; membership is still the project
  opushub.kind: infrastructure             # file it with the rails (or "application" to force it into the grid)
```

Precedence for any presentation field: `services.yaml` entry → container label → derived from
Docker metadata. Only the allow-listed `opushub.*`, `com.docker.compose.*` and `traefik.*` keys are
*interpreted*; every other label stays where it belongs and is never serialized to the browser.

## URL precedence

The resolver's whole list — nothing else is consulted, and no domain is ever assumed:

| # | Source (`urlSource`) | From |
| --- | --- | --- |
| 1 | `manual` | `url:` in the overlay, or `opushub.url` on the container |
| 2 | `traefik` | `traefik.http.routers.<r>.rule` → `Host(\`…\`)`, plus `.entrypoints`, `.tls`, `.service.port` |
| 3 | `published-port` | a real `PublicPort` + the host address (`OPUSHUB_HOST_ADDRESS`, Settings → System, or a detected interface address) |
| 4 | `none` | `url: null`. A name, never a link. |

What the Traefik grammar supports, because real compose files do all of this:

- `Host(\`a\`)`, `Host(\`a\`, \`b\`)` (first is canonical, the rest are reported as alternates), `Host(\`a:8443\`)`, `Host(\`a\`) || Host(\`b\`)`, `Host(\`a\`) && PathPrefix(\`/x\`)`
- `HostAndPath(\`a/path\`)`; a `PathPrefix` is appended **unless** a `stripprefix` middleware is attached to that router
- multiple routers per container: the TLS router wins over its `web` redirect twin; routers whose entrypoint is `internal`/`private`/`insecure` lose; a router named after the container or compose service wins ties
- `traefik.enable=false` (or an `enable=false` on the router) suppresses label URLs entirely, even when rules exist
- `HostRegexp(\`{any:[a-z-]+}.example.com\`)`, `Host(\`*.example.com\`)`, `HostSNI(\`*\`)` are **matchers, not addresses** — OpusHub refuses to build a URL out of a pattern, because a link to a hostname nobody owns is worse than no link
- the resolved URL carries no port when the proxy is on the scheme default; if it is not, map the entrypoint in Settings → System (`web=8080`) — that value is yours, never baked in

`urlNote` explains each answer in one line (`Traefik router "seerr" · entrypoint websecure · TLS`,
`published 0.0.0.0:7878 → 7878`), which is what makes a wrong URL debuggable without reading code.

## Applications and rails

Rails (proxies, databases, caches, exporters) are real containers and belong in the inventory, but
not in the launcher. Classification is signal-based, in this order — no blacklist of application
names:

1. an explicit overlay → `application` (you said so, that settles it)
2. it has a proxy route → `application` (somebody deliberately gave it a browser URL)
3. the container says so: `opushub.kind: infrastructure|application`
4. its container/service name or image reads as infrastructure (`db`, `cache`, `proxy`, `worker`, `exporter`, `machine-learning`, `backup`, …) → `infrastructure`
4. it publishes an HTTP port → `application`
5. otherwise → `application` (an app that is merely stopped is still an app)

`kindSource` records which rule fired, and the Services page shows rails in a collapsed section with
that reason. Nothing is filtered out of `/api/services`, `/api/stacks`, the detail pages or the
counters — a rail you care about is one overlay entry away from the grid.

## Icons and groups

Icon resolution: explicit `icon:` → `opushub.icon` label → derived by probing the *bundled* icon
collections with slugs taken from the image reference (`ghcr.io/jellyfin/jellyfin:10.9.7` →
`si:jellyfin`) → monogram. There is no application→icon table, and no network call: the probe reads
`@iconify-json/{lucide,mdi,simple-icons}` locally, so it works on an air-gapped host. `iconSource`
says which tier answered and `iconSuggestion` carries the guess into the Icon Browser. Groups are
presentation only: a group heading exists because containers are in it (from `group:` or
`opushub.group`), never because `services.yaml` declared it.

## Stacks

A stack is a compose project: `com.docker.compose.project` groups members, `.service` gives their
role, `.container-number` distinguishes replicas, and `.project.working_dir`/`.config_files` are read
**server-side only** to guess a project name when the label is missing (a plain `docker run` container
has none → `standalone`). The project name is never assumed to equal a directory name, and
`stacks.yaml` cannot add or remove a member: it renames, describes, icons and annotates a project
that the engine reported. A `stacks.yaml` entry whose containers are gone is reported as an unmatched
stack overlay; a legacy entry that lists `services:` merges into the project those containers actually
live in.

## API

| Route | Payload |
| --- | --- |
| `GET /api/services` | `{groups, services, infrastructure, skipped, unmatched, live, statusSource, statusReason, discoveredAt, stats}` — `groups` holds visible applications; `services` the full flat inventory (what the overlay editor binds against) |
| `GET /api/services/:group/:name` | `{service, stack, container, containerStats, dockerAvailable, url, urlSource, urlNote}` — 404 when no container matches, whatever the config says |
| `GET /api/stacks` | `{stacks, standalone, unmatched, live, statusReason}` |
| `GET /api/discovery` | `{engine, urlDiscovery, overlays, inventory, discoveredAt}` — the §22 diagnostics |
| `POST /api/discovery/refresh` | drops the cache and returns the new diagnostics |

Every page reads these; none of them assembles a service list in the browser, so there is exactly
one answer per container in the whole app.

## When the engine is not reachable

`live: false`, `groups: []`, `stacks: []`, and a public `statusReason` ("no Docker socket found…").
Config entries do not fill the gap — that is the difference between an honest empty state and a
museum of deleted services. Overlays are *not* reported as unmatched while the engine is down,
because nothing was compared; the pages link to Settings → System to fix the connection instead.

## Security

Unchanged from V1 and unchanged by discovery: read-only Engine API over a unix socket or `DOCKER_HOST`
that never reaches the browser. `GET` requests only — no `exec`, `restart`, `update`, `create`,
`delete`, `prune`. `HostConfig.Env`/`Config.Env` are dropped from inspect projections, `Cmd` is
redacted, label sets are reduced to the curated `container.labels` view, compose host paths are never
serialized, and the socket path never appears in a response. The allow-list is the boundary: see
`curatedLabels()` and the API-boundary tests.

## Portable by construction

Nothing in `server/` or `src/` contains a domain, a TLD, a hostname, a `.home.arpa` suffix, or an
application name that decides behaviour (`grep -rn "home\.arpa" server src` is empty). OpusHub will
list, name, and link a stack on another machine — under any domain — with no code change, because it
reads the answers from that machine's containers. To run it as a container:

```yaml
services:
  opushub:
    build: .
    ports: ["3000:3000"]
    volumes:
      - ./config:/app/config           # overlay + settings: mounted, never baked into an image
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      OPUSHUB_HOST_ADDRESS: 192.168.1.20   # optional: only used for published-port URLs
    group_add:
      - "${DOCKER_GID:-999}"               # the unprivileged container user reads the socket via this group
    restart: unless-stopped
```

`.dockerignore` excludes `.git node_modules dist data config .env **/.env`, and the Dockerfile copies
only `server/`, `src/` and `dist/` — runtime config can never be baked into an image, so a rebuilt
container on a new host is a blank slate that discovery immediately fills.

## Verifying against your host

```bash
./scripts/opusgrid-inspect.sh                          # every container, read-only
OPUSHUB_URL=http://127.0.0.1:3000 ./scripts/opusgrid-inspect.sh jellyfin seerr
```

The script prints, per container: state, image, compose project/service, published vs exposed ports,
networks, the routing-relevant labels, and which hostnames Traefik rules spell out — then, if
`OPUSHUB_URL` is set, exactly what OpusHub resolved from the same metadata, with a summary line that
answers the only question that matters for a given host: *is the hostname consistently encoded in
Traefik labels here, or do I need published-port fallbacks (or a `url:` overlay entry)?*

If a URL is wrong, the fix is data, never code: `opushub.url` on the container, `url:` in
`services.yaml`, the host address in Settings → System, or an entrypoint port map. If a service is
missing, it is because the container is missing — check `docker ps -a`, not the config.

## Tests

`server/providers/dockerLabels.test.js` (label grammar), `server/urlResolver.test.js` (every
precedence tier and refusal above), `server/discovery.test.js` (the join: ghost overlays,
enrichment, duplicates collapsing, stopped vs removed, classification, security of the projection),
`server/api-boundary.test.js` + `server/api-offline.test.js` (what the browser may see, and the
no-engine contract), `test/model.test.js` (overlays joined to the mock fleet) and
`test/model-empty.test.js` (§: with both YAML files empty, the whole UI is still a usable live
inventory). Run `npm test`.
