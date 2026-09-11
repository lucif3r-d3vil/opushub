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
