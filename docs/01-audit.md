# OpusHub — Phase 1 Audit (what actually exists)

Audited on 2026-09-11 against branch `main` @ `ba8ef48`.

## Method

Everything below was verified with `git ls-tree`, `git log --all`, `git status --porcelain --ignored`,
`find` across `/`, `/home`, `/opt`, `/srv`, and `docker`/`node` capability probes. No conclusions are
assumed from the project name or from the task brief.

## Findings

### 1. The repository is empty

```
$ git log --all --oneline
ba8ef48 Initial commit

$ git ls-tree -r --name-only HEAD
README.md
```

`README.md` contains one line: `# opushub`. There is no other tracked file, no branch with code,
no stash, and no untracked or ignored files in the working tree.

**There is no existing OpusGrid or Homepage source in this checkout.** The task describes OpusHub
as a transformation of an existing dashboard; that dashboard is not present in this repository.

### 2. No environment or configuration files exist anywhere on the machine

```
$ find / -maxdepth 6 -name ".env*"                          # → nothing
$ find / -maxdepth 6 -iname "services.yaml"                 # → nothing
$ find / -maxdepth 3 -iname "*homepage*" -o -iname "*opus*" # → only this repo
$ ls /opt /srv                                               # → /opt/yarn-v1.22.22, /srv empty
```

The previously reported bug ("`.env` existed in the provided path but was not discovered")
**cannot be reproduced here, because no `.env` file exists on this filesystem.** Nothing was lost by
this audit; there was nothing to find.

Consequence for the build: `.env` discovery must be written as a real, documented resolution
order with observable diagnostics, rather than patched on top of a loader that assumed a root path.
See `docs/02-architecture.md` § "Configuration discovery".

### 3. No existing Homepage functionality to reuse

Because no config or code exists, there is nothing to preserve. The useful *concepts* from Homepage
that this build adopts deliberately (reimplemented, not copied):

| Homepage concept | OpusHub V1 treatment |
| --- | --- |
| `services.yaml` groups | `config/services.yaml` — groups → items, edited by the Services settings page |
| `widgets.yaml` | `config/settings.yaml` → `integrations` (news/weather/markets/etc.) |
| `kubernetes.yaml` / Docker info | `config/stacks.yaml` + a live Docker provider behind the API |
| `search` providers | Hub command search, `/api/search` providers registry |
| Icon refs (`lucide:*`, `shields:*`, URLs) | `IconRef` union: local dir, URL, `lucide:*`, `mdi:*`, `si:*` |
| `custom.css` / `custom.js` | `config/theme.css`, `config/app.js`, both opt-in and validated |
| `settings.yaml` (theme, layout) | `config/settings.yaml` with live preview via `/api/settings` |

### 4. Runtime capabilities of this environment

| Capability | Status | Effect on the build |
| --- | --- | --- |
| Node v22.22.3 | available | Run the server directly; `node:sqlite` is available (built-in, no native dep) |
| npm registry | reachable (200) | Dependencies install normally |
| General internet (open-meteo.com, stooq.com, iconify.design, hnrss.org) | **blocked** — `SSL_ERROR_SYSCALL` on connect | Weather, market and news providers will report `unavailable` with a real reason. They must NOT fabricate values |
| Docker CLI / `/var/run/docker.sock` | absent | Docker provider reports `unavailable`; container stats stay `Unavailable` |
| `/proc`, `/sys/class/thermal`, `os.networkInterfaces()` | present | System page runs on **real** data here (load, meminfo, netdev, disks, uptime) |
| 2 cores, 3.9 GB RAM, Debian 12 bookworm, x86_64 | — | No `sensors`, no `nvidia-smi`, no GPU devices |

The last two rows matter: the task forbids fake data. That is satisfiable here because host metrics
have a real source (`/proc`), while services with no reachable source (weather, markets, news,
Docker) degrade to an explicit `unavailable` state carrying the actual error. No placeholder
numbers are introduced anywhere in production code.

## Decisions taken from this audit

1. Build OpusHub in this repository, on top of the empty tree, as a Vite + React front end and a
   Node HTTP API layer that owns all infrastructure access.
2. Implement configuration discovery as an ordered, logged search that works for the common install
   shapes (repo root, `config/`, `/app/config`, `HOMEPAGE_DIR`, and an explicit `OPUSHUB_CONFIG_DIR`
   override) and reports exactly which paths were tried. That is the durable fix for the `.env` bug.
3. Keep every integration behind a provider module with a uniform `{ status, data, reason }` shape,
   so `unavailable` is a first-class state the UI renders honestly.
4. Do not add an auth layer, shell execution, or Docker write actions in V1. Infrastructure access
   is read-only and server-side.

---

# Phase 2 — real-environment audit (2026-09-12)

Audited against branch `arena/01a094af-opushub` on the machine available to this session. The
Phase 2 brief asks OpusHub to run "against the actual OpusGrid environment" — this section records
what that environment actually is, because several Phase 2 assumptions do not hold here.

## Method

`cat /etc/os-release`, `uname`, `which docker`, socket probes at `/var/run/docker.sock` and
`/run/docker.sock`, `env`, filesystem sweeps (`find / -maxdepth 6` for compose files, `.env*`,
`*homepage*`, `*opus*`), `free`/`df`/`ip addr`, `sudo` + `apt-get update` + egress probes
(`registry.npmjs.org`, `deb.debian.org`, `download.docker.com`, `open-meteo.com`, `stooq.com`).

## Findings

| Fact | Value |
| --- | --- |
| OS / arch | Debian 12 (bookworm), x86_64, kernel 6.1.158+ |
| CPU / RAM | 2 vCPU (Xeon @ 2.60 GHz), 3.9 GB RAM, **no swap** |
| Disk | 21 GB ext4 root, ~4% used |
| Network | `lo` + `eth0` (169.254.0.21/30); no Docker bridges, no extra NICs |
| Docker CLI | **absent** (`docker: command not found`) |
| Docker socket | **absent** (`/var/run/docker.sock` and `/run/docker.sock` do not exist) |
| Containers / networks / volumes / stacks | **none exist** — no Engine, nothing to list |
| Compose files | **none anywhere** on the filesystem |
| OpusGrid homelab / Homepage install | **not present** — no directories, no configs, no reverse proxy |
| `.env` files | **none** (verified again; Phase 1 finding still holds) |
| `sudo` | passwordless root available |
| `apt` | unusable — `deb.debian.org` unreachable, so `docker.io` cannot be installed |
| Egress | npm registry reachable; Docker downloads, Open-Meteo, Stooq, Iconify **blocked** |
| `/proc`, `/sys`, `os.networkInterfaces()` | present — host metrics are real |
| Thermal sensors / GPU | **absent** (`/sys/class/thermal` empty, no DRM cards, no NVIDIA driver) |

## Consequences for Phase 2

1. **There is no OpusGrid host to run against.** No container was stopped, restarted, modified or
   created at any point — there is no production infrastructure in this sandbox to disturb (§2
   holds trivially).
2. **Docker could not be installed.** With `apt` broken and `download.docker.com` blocked, no
   Engine binary is obtainable. Phase 2's live-Docker validation therefore runs the **real
   provider code** (socket → Engine HTTP API → projection → API → UI) against
   `test/mock-engine.js`, a mock Engine speaking the genuine Docker HTTP-over-unix-socket
   protocol with fixtures for every state the UI must handle (running, stopped, healthy,
   unhealthy, paused, created, standalone, long names, many/no ports, multi-network). Fixtures
   are clearly marked `MOCK DATA` / `MOCK-FIXTURE-*` and are test-only — no fabricated value
   exists in any production path.
3. **Real host metrics are genuinely live** (`/proc`, `/sys`): CPU + per-core, load, memory,
   ext4 `/`, `eth0` throughput, uptime, process count. Temperature, frequency beyond
   `/proc/cpuinfo`, swap and GPU correctly report unavailable — nothing is invented.
4. **Weather, markets, news and remote icons remain unreachable** (egress blocked), so those
   providers were validated in their `unconfigured`/`unavailable` states only — which is
   exactly what §§17–18 needed: the first-run banner and the quiet optional states.
5. **`.env` discovery was validated for real** by placing and then removing a `config/.env`:
   `GET /api/health` reported FOUND with the file path and key *names*; a full-response scan of
   every endpoint confirmed no secret *value* leaks.

# Phase 3 — discovery audit (2026-09-12)

Re-audited the *model* rather than the machine, because the machine is unchanged: still no Docker
CLI, no socket, no Engine (`apt` and `download.docker.com` blocked — see Phase 2). Concretely
re-checked: `ls /var/run/docker.sock /run/docker.sock`, `which docker`, `ip addr` (only `lo` +
`eth0` at `169.254.0.21/30`), `find / -name 'docker-compose*.y*ml'`. Nothing to inspect.

## What the shipped config actually claimed

`config/services.yaml` and `config/stacks.yaml` in this checkout described nine services
(Stream, Requests, Wave, Photos, Drive, Vault, Metrics, Nest, Docs, Lens) and four stacks. Of
those, zero exist on this host — and the app rendered all of them anyway, with `href` values
pointed at `*.opusgrid.home.arpa` and `:5055`-style ports that nothing listens on. That is the
failure this phase removes: **a config file was allowed to assert existence.**

The second symptom was the duplicate row: a configured `Media/Seerr` and a discovered
`opustream/seerr` are the same container presented as two entries, because the merge joined on
`image.includes(name)`. Both defects are structural, not cosmetic, so the fix is the data model:
Docker decides existence, and config only decorates.

## How the replacement was validated without an Engine

- `test/mock-engine.js` speaks the real HTTP-over-unix-socket protocol (24 fixtures: proxied
  HTTP/HTTPS, a redirect router losing to its TLS twin, multi-host rules, `PathPrefix` with and
  without `stripprefix`, `HostRegexp`, `traefik.enable=false`, `expose` without `published`,
  loopback-only publishes, `created`/`paused`/`exited` states, rails, a container whose name is a
  lie, and a long name that used to wrap badly). `OPUSHUB_MOCK_HIDE=name` deletes a container so
  "it disappeared from the UI" is testable end-to-end rather than asserted in prose.
- `scripts/opusgrid-inspect.sh` is the read-only tool that performs the inspection this sandbox
  cannot: per container it prints state, image, compose labels, published vs exposed ports,
  networks, the routing-relevant label set, which hostnames Traefik rules actually spell out — and
  what OpusHub resolved from the same data. Run it on the real host before trusting any assumption
  about how that installation is wired; if a machine encodes its hostnames somewhere else, that
  script shows it in one screen, and the fix is a `url:` overlay entry, not a code change.
- 130 tests (`npm test`) cover label grammar, every URL tier and refusal, the overlay join,
  classification, the projection's security boundary, and the offline contract.
