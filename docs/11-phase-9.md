# OpusHub — Phase 9: OpusGrid, an infrastructure control plane

Status: implemented on `arena/01a0aaac-opushub`. Builds on Phases 1–8 without rewriting them:
the Docker discovery model is untouched, the Phase 8 operations engine is untouched, the design
system is untouched, and **the set of things a browser can change is exactly what it was at the end
of Phase 8** — nothing more.

The one-line summary: OpusHub can now **see the machine it is standing on, and the shelf of
equipment around it, as infrastructure** — filesystems, ZFS pools and datasets, network interfaces
and routes, an optional upstream OPNsense firewall, declared UPS/PDU devices, an operator-drawn
physical map, and one honest health verdict per domain — and it can still **change nothing**.

> Phase 9 is a read-only expansion of *awareness*. It adds no write operation, no shell, no
> arbitrary filesystem access, no arbitrary HTTP target, and no provider proxy. Every provider is
> optional, every optional provider degrades to a sentence, and every number shown is either
> something the kernel, ZFS or the upstream device said, or the words "Not available".

---

## Why it is this shape

The failure mode for a phase like this is well known: one dashboard that is Portainer + Cockpit +
an OPNsense UI + a ZFS tool, none of them done properly, and a server that will run a command the
browser named. So the question was never "what can we show". It was:

1. **What can OpusHub prove?** Anything it cannot prove is labelled `configured` or `discovered`
   with the source named, or it is not drawn at all.
2. **What is allowed to be absent?** A host with Docker and no ZFS is a complete OpusGrid, not a
   broken one. `not-configured` is a first-class status, never `unhealthy`.
3. **What must never be reachable?** A command, a filesystem path, an HTTP endpoint, a credential.
   Each of those is a *structural* absence in Phase 9, not a runtime check.

The answer to (3) is the part enforced by tests rather than by promises — see **§12 Security
controls**.

---

## STEP 0 — the audit that came first

Nothing was written until the existing surface was inventoried. The full audit was emitted before
implementation; this is its outcome.

### EXISTING (reused, not replaced)

| What | Where | How Phase 9 uses it |
|---|---|---|
| Inventory / discovery model | `server/model.js` | still canonical for every Docker resource |
| Docker read client | `server/providers/docker.js` | unchanged; wrapped by a status adapter only |
| Phase 8 operations | `server/operations/*` | untouched; still exactly three actions |
| Host + system read model | `server/providers/system.js` | extended, not rewritten |
| Storage read model (filesystems) | `server/providers/storage.js` | extended with a real ZFS provider |
| Alerts, activity, search, palette | `server/{alerts,activity,search}.js` | extended with new categories/areas |
| Config architecture (Phase 6) | `server/model.js`, `server/configScope.js` | extended with two non-secret settings |
| Infrastructure/Topology/Settings UI | `src/pages/*` | extended with new tabs and pages |

### EXTEND

`server/providers/storage.js` (ZFS stops being a stub), `server/alerts.js` (new conditions + an
`area` on every alert), `server/activity.js` (four new categories), `server/search.js` (new
destinations and objects), `src/pages/Infrastructure.tsx` (eight tabs, lazy per-tab queries),
`src/pages/Settings.tsx` (a Connections pane), the command palette.

### NEW

| File | Purpose |
|---|---|
| `server/infrastructure/registry.js` | the provider registry: status, TTL cache, single-flight, public status doc |
| `server/infrastructure/providers.js` | the registration table — the one place that names providers |
| `server/infrastructure/model.js` | the vocabulary: domains, layers, node kinds, relationship sources, thresholds |
| `server/infrastructure/health.js` | per-domain and aggregate health |
| `server/infrastructure/state.js` | transition-only activity emitters |
| `server/infrastructure/physical.js` | `config/topology.yaml` reader and validator |
| `server/infrastructure/topology.js` | the expanded topology builder |
| `server/infrastructure/opusgrid.js` | the canonical document assembler |
| `server/infrastructureApi.js` | every `/api/infrastructure/*` route (GET/HEAD only) |
| `server/providers/zfs.js` | the only module in the server that runs a command |
| `server/providers/network.js` | host network reads |
| `server/providers/opnsense.js` + `opnsenseConfig.js` | optional upstream firewall client |
| `server/providers/power.js` | UPS and PDU abstractions |
| `src/pages/Host.tsx` | host detail |
| `src/components/InfraStatusStrip.tsx` | the provider status strip |
| `src/components/OpusGridTopology.tsx` | replaces `src/components/Topology.tsx` |
| `src/components/infrastructure/{Storage,Network,Power}Panel.tsx` | domain panels |
| `src/pages/settings/Connections.tsx` | Connections pane |

### DEFERRED (with the reason)

| Deferred | Why |
|---|---|
| Every infrastructure **write** — ZFS snapshot/rollback/destroy/scrub, mount/unmount, route, DNS, firewall rule, DHCP lease, UPS shutdown or battery test, PDU outlet switching | explicitly out of scope for Phase 9; each one is a new, individually reviewable capability, and none belongs in the same change that introduces the reader |
| NUT / SNMP / PDU protocol clients | they need real hardware to validate against; the abstraction and the honest "not implemented yet" answer exist now, so a client can be added without touching the UI |
| A physical-topology **editor** | an operator-authored infrastructure claim needs its own review surface, and `config/topology.yaml` is deliberately machine-specific and excluded from export/import/history |
| A filesystem browser | arbitrary path access is exactly what this phase refuses to build |
| A generic provider proxy | a provider is a capability, not a URL; there is no route that takes a target |

---

## 1. The provider model

A **provider** is a named capability with a status. Seven are registered, in display order:

| id | type | domain | optional | capabilities | TTL |
|---|---|---|---|---|---|
| `docker` | compute | compute | no | containers, networks, volumes, images | 30 s |
| `filesystem` | storage | storage | no | filesystems | 30 s |
| `zfs` | storage | storage | **yes** | pools, datasets | 60 s |
| `network` | network | network | no | interfaces, routes, dns | 30 s |
| `opnsense` | firewall | external | **yes** | system, interfaces, gateways, dns | 60 s |
| `ups` | power | power | **yes** | *(none yet)* | 300 s |
| `pdu` | power | power | **yes** | *(none yet)* | 300 s |

Four properties of the registry (`server/infrastructure/registry.js`) make the rest of the phase
safe to build on:

1. **A provider never throws out.** A check that rejects or throws is converted into
   `unavailable` with a public sentence from a fixed `ERROR_CODES` vocabulary. The exception's
   message is logged only behind `OPUSHUB_DEBUG`.
2. **Bounded work.** One in-flight check per provider (single-flight) plus a per-provider TTL, so
   a page with five widgets asking about storage runs `zpool` **once**, not five times.
3. **Status is honest.** `not-configured` exists and is used. `unknown` means "registered but
   never asked" — it is never rendered as healthy.
4. **No secrets cross the boundary.** The public status document carries
   `{ id, name, type, domain, status, statusLabel, capabilities, active, version, error, at }`.
   The provider's `data` payload is **stripped** from that document and is only ever available
   through its own domain route.

Status vocabulary — the complete set, with one label each so nothing improvises a synonym:

```
connected | available | degraded | unavailable | not-configured | unknown
```

Providers are independent by construction: nothing in the UI, the health aggregator, the topology
builder or the alert engine assumes two providers are both present. Docker remains the canonical
source for every Docker resource — Phase 9 places Docker, it does not replace it.

## 2. Storage — filesystems, ZFS pools and datasets as three different things

The storage domain refuses to merge its three subjects. A **filesystem** is a mount with a usage
percentage. A **pool** is a ZFS pool with a health word. A **dataset** is a ZFS dataset with
properties. A filesystem is never reported as a pool, and a pool never borrows a filesystem's
numbers.

`server/providers/zfs.js` is the **only module in the entire server that runs a command**, and it
is built so that this stays true and stays small:

- a frozen `COMMANDS` table of exactly three entries, each a fixed argv array:

  | key | command |
  |---|---|
  | `poolList` | `zpool list -Hp -o name,size,alloc,free,frag,cap,health` |
  | `poolTopology` | `zpool list -Hpv -o name,size,alloc,free,frag,cap,health` (plus one name) |
  | `datasetList` | `zfs list -Hp -t filesystem,volume -o name,used,avail,refer,mountpoint,compression,recordsize,quota` |

  There is no `exec(command)` function. There is no way to name a command.
- `execFile` with an argv array — never a shell. 4 s timeout, 256 KB output cap.
- The only value appended to a command is a **pool or dataset name that came from our own
  discovery output**, matched against `POOL_NAME` / `DATASET_NAME` before use. A name that does
  not match, or that was never returned by `zpool`/`zfs`, is refused and returns `null`
  **before any process is spawned**.
- No pool name is hardcoded anywhere in the codebase. `tank` appears only in tests and docs.
- The provider reads exactly two environment values: `PATH` (so `execFile` can find the binary)
  and `OPUSHUB_DEBUG`. It never receives `req`, `body` or `query` in any form.
- `zpool` with nothing imported is reported as `available` with `empty: true` — a real state, and
  not the same as `unavailable`.

Output parsing is defensive: `-` and `#` columns become `null` ("Not available"), never `0`.

## 3. Network — what the host will say, from procfs and sysfs

`server/providers/network.js` reads only files the kernel maintains:

| Path | Used for |
|---|---|
| `/sys/class/net/<if>/…` | interfaces, MAC-free identity, operstate, carrier, speed, MTU |
| `/proc/net/dev` | RX/TX byte and packet counters |
| `/proc/net/route`, `/proc/net/ipv6_route` | the default route (v4 and v6) |
| `/etc/resolv.conf` | the configured resolvers |

It deliberately does **not** read ARP/neighbour tables, conntrack, or anything that enumerates
other devices on the network. Every interface carries `scope: 'host' | 'container'` and a
`scopeNote`, because on a containerised install the interfaces OpusHub can see may belong to the
container's network namespace rather than the host's — and saying which is better than guessing.

## 4. OPNsense — optional, four endpoints, credentials that cannot be stored

OPNsense is a device on the network, not a part of OpusHub, so it is the most dangerous thing in
the phase and is built as the narrowest.

- Four frozen endpoints, and no way to request a fifth:

  | key | path |
  |---|---|
  | `system` | `/api/core/system/status` |
  | `interfaces` | `/api/interfaces/overview/interfaces` |
  | `gateways` | `/api/routes/gateway/status` |
  | `dns` | `/api/unbound/settings/get` |

- `dhcp` and `firewall` are declared in `PLANNED` and have **no endpoint** — the UI shows them as
  planned rather than empty.
- Each response goes through a field projector: only known fields survive, so an upstream schema
  change cannot leak an unexpected value into OpusHub.
- `redirect: 'manual'` (no credential-bearing redirect), 5 s timeout, Basic auth built from the
  environment at request time.
- **Credentials come from the environment and nowhere else** — `OPUSHUB_OPNSENSE_KEY` and
  `OPUSHUB_OPNSENSE_SECRET`. The address may be configured (`infrastructure.opnsense.url`, origin
  only, no path/query/fragment/credentials); the key and secret are not fields in the settings
  model, so no code path can write them into YAML, a snapshot, an export, a history version, an
  activity event or a log line.
- Plain HTTP is refused unless `OPUSHUB_OPNSENSE_ALLOW_PLAIN_HTTP` is set explicitly.
- Not configured → `not-configured` ("Not configured"), never an error state.

## 5. Power — UPS and PDU as declared, not invented

`server/providers/power.js` defines the shape (`UPS_FIELDS`, `PDU_FIELDS`) and answers one of two
honest things: `not-configured` when the device is not enabled, and `unavailable` with
"not implemented yet" when it is. No NUT, SNMP or vendor client exists, so **no power number is
ever fabricated**, and no device is ever shown as healthy. Settings hold one boolean per device
(`infrastructure.power.ups.enabled`, `.pdu.enabled`) and nothing else — there is no field for a
host, a community string or a password.

## 6. Physical topology — configured, never discovered, never invented

A homelab's physical layer (ISP → ONT → router → switch → node → NAS → PDU → UPS) cannot be
discovered from inside a container. Inventing it would be fabrication, so it is **configured**:
`config/topology.yaml`, written by hand, read by `server/infrastructure/physical.js`.

```yaml
nodes:
  - id: isp
    kind: isp
    label: ISP
    linksTo: [ont]
  - id: switch-1
    kind: switch
    label: Loft switch
    note: 8-port, unmanaged
links:
  - from: opnsense
    to: switch-1
    label: 2.5 GbE
```

Validation is strict and rejects the **whole file** rather than half-rendering a map that came
from a typo:

- max 60 nodes, max 120 links, max 64 KB;
- ids match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and are unique;
- links must point at a declared node or one of three reserved ids (`host`, `docker`,
  `opnsense`); no self-links;
- `nodes` and `links` must be lists; a mapping or a string is refused with a sentence the UI
  shows;
- every relationship produced is `source: 'configured'`.

The file is machine-specific by nature and is excluded from export, import and history — the same
treatment the host address and Traefik entrypoints already get. **There is no editor**: no
endpoint writes this file in Phase 9.

## 7. The expanded topology — an edge only when something proved it

`server/infrastructure/topology.js` draws five layers (`physical`, `network`, `compute`,
`storage`, `services`) and obeys one rule:

> An edge exists only when a provider proved the relationship, or when the operator configured it.
> A container is attached to a network because the **engine** said so. A service is bound to a port
> because discovery said so. A dataset belongs to a pool because `zfs list` said so. Nothing is
> inferred from a name, a label, a prefix or a coincidence.

Every node and every edge carries `source: 'discovered' | 'configured'` — there is no third value,
because there is no third kind of evidence. Docker networks and services are gated on Docker
actually being connected: when the engine is unreachable the map shows the host, not a stale
invented neighbourhood. The physical layer is rendered only from `config/topology.yaml`.

## 8. Health — one verdict per domain, and an honest aggregate

`server/infrastructure/health.js` turns provider statuses plus active alerts into one document:

| Situation | Domain verdict |
|---|---|
| all providers connected, no alerts | `healthy` |
| optional provider **not configured** | `not-configured` — **excluded from the overall verdict** |
| optional provider unavailable | `degraded` |
| required provider unavailable | `unavailable` |
| a provider that has never been checked | `degraded` — never `healthy` |

Severity ranks `healthy < degraded < unavailable`. The overall verdict is the worst **included**
domain, so an install without OPNsense, ZFS, a UPS and a PDU still reads `healthy`. Unknown is
never optimistic.

## 9. Alerts, activity, search and the palette

- **Alerts** gained `area` (every alert now carries one) and new conditions: pool health
  (`FAULTED`/`UNAVAIL`/`REMOVED`/`OFFLINE`/`SUSPENDED` critical, everything else warning),
  filesystem usage, dataset quota, interface down **with an address configured**, and provider
  unavailable/degraded. Two deliberate non-alerts: an optional provider that was never configured
  is configuration, not failure; and an interface with no carrier and no address is a spare port.
- **Thresholds are one constant** — `THRESHOLDS = { warning: 90, critical: 95 }` in
  `server/infrastructure/model.js` — shared by alerts, the activity emitters and the UI bars.
- **Activity** gained four categories (`storage`, `network`, `power`, `provider`) and emits only
  on **transitions**: a pool changing health, a mount crossing a threshold, a dataset crossing its
  quota, an interface changing state, a provider connecting or disconnecting. A steady state
  produces no event. `not-configured` never produces one.
- **Search** gained pages (Host, Storage, Network, Power, Topology, Connections) and live objects
  (mounts, pools, datasets, interfaces, OPNsense/UPS/PDU with their current status), each optional
  and each wrapped so a provider being absent removes the results rather than the search.
- The **palette** routes to the new pages with the infrastructure nav actions.

## 10. Host detail

`/host` is the machine OpusHub is running on, as one page: identity and kernel, the provider
strip, the health verdict, storage and network summaries, and the physical devices the operator
declared. `/api/host` now also returns `providers` and `health` so the page needs one request.

## 11. The API surface

Every route below is **GET (or HEAD)**. A non-GET request to any of them answers
`405 method_not_allowed` with `Infrastructure is read-only.` The routes are handled before the
setup routes in `api.js`, so an unauthenticated or pre-setup install gets the same answer the rest
of the API gives rather than a generic miss.

| Route | Returns |
|---|---|
| `/api/infrastructure` | the headline document; `?include=` accepts `storage,network,power,external` |
| `/api/infrastructure/providers` | every provider's status document |
| `/api/infrastructure/provider?id=` | one provider (validated against the registry — an unknown id 404s without a check running) |
| `/api/infrastructure/storage` | filesystems, pools, datasets (detail) |
| `/api/infrastructure/storage/pool?name=` | one pool, resolved from discovery output |
| `/api/infrastructure/storage/dataset?name=` | one dataset, resolved from discovery output |
| `/api/infrastructure/network` | interfaces, routes, resolvers |
| `/api/infrastructure/power` | UPS and PDU |
| `/api/infrastructure/opnsense` | the optional upstream device |
| `/api/infrastructure/topology` | the expanded topology |
| `/api/infrastructure/physical` | the configured physical map |

`include` is an **allow-list**, not a passthrough: unrecognised sections are ignored, and a value
like `../../etc/passwd` or `<script>` is dropped and never echoed back. The only three query
parameters the whole surface reads are `include`, `name` and `id`.

**Performance.** `/api/infrastructure` stays cheap enough to poll: it returns headline counts and
summaries, and each tab fetches its own detail on demand (`storage` returns 12 mounts and 8
datasets by summary, 32 and 200 with `detail: true`). Capped lists report `truncated: true` and
the true `count`, so a cap is never presented as the whole picture.

## 12. Security controls and how each is proven

| Control | How it is enforced | Proven by |
|---|---|---|
| **No new write operation** | the non-GET route list in `server/api.js` is byte-compared against the Phase 8 list (21 routes) | `phase9-security.test.js` |
| **Exactly one module runs a command** | a scan of every non-test file under `server/` asserts that only `server/providers/zfs.js` and `server/version.js` import `child_process` | `phase9-security.test.js` |
| **That module runs only its frozen table** | no `shell:`, `execSync`, `spawnSync`, `spawn(`, `fork(`, `/exec`, `new Function`, `eval(`; `execFile(` with argv required; every call site names a table key as a literal | `phase9-security.test.js`, `phase8-proof.test.js` |
| **zfs.js knows nothing about requests** | no `req.`, `body.`, `query.`, `searchParams`; its only environment reads are `PATH` and `OPUSHUB_DEBUG`, and it never hands over the whole environment | `phase9-security.test.js` |
| **No arbitrary filesystem path** | the infrastructure API reads `include`, `name`, `id` and nothing else; a static assertion refuses `path`, `file`, `url`, `endpoint`, `command` | `phase9-security.test.js` |
| **No arbitrary upstream endpoint** | `ENDPOINTS` is frozen, is the only source of paths, and the URL is built as `new URL(spec.path, baseUrl)`; no generic transport is exported | `phase9-security.test.js` |
| **No credential leak** | a secret planted in the environment is asserted absent from every response body, every header, every activity event and every log line | `phase9-security.test.js` |
| **No provider proxy** | the only route that accepts a provider id validates it with `isKnownProvider()`; the API never calls a provider check directly | `phase9-security.test.js` |
| **No Docker socket or operation from infrastructure code** | every infrastructure module is scanned for socket paths, `dockerOperations` and container endpoints | `phase9-security.test.js` |
| **No filesystem write from infrastructure code** | every `server/infrastructure/*` module is scanned for `writeFileSync`, `appendFileSync`, `rmSync`, `unlinkSync`, `mkdirSync`, `renameSync` | `phase9-security.test.js` |
| **The sweep is read-only on the wire** | with the registry cache cleared, every call the sweep makes to the mock engine is asserted to start with `GET ` | `phase9-security.test.js` |
| **Phase 8 is intact** | the operations allow-list is still three actions; the Docker read client is still GET-only | `phase9-security.test.js`, `phase8-proof.test.js` |

### The proof that had to be fixed first

These proofs read source with comments stripped. The obvious one-liner —
`src.replace(/\/\*[\s\S]*?\*\//g, '')` — is not safe enough to build a proof on: `server/api.js`
documents its versioned namespace with a line comment containing `/api/v1/*`, and that `/*` opens
a "comment" which runs to the next unrelated `*/`, **deleting 30 % of the file** — including the
very `route === 'POST /api/setup'` lines the assertion exists to check. The test passed while
looking at a file with the setup, auth, settings and layout routes missing, which is worse than
having no test at all.

Both proof files now use `test/source-scan.js`, a single-pass scanner that tracks strings and only
treats `//` and `/*` as comments when they are genuinely in code, and `phase9-security.test.js`
carries a meta-test asserting that stripping comments from `api.js` preserves every route and
removes a plausible amount of text. If the scanner ever regresses again, the meta-test fails
loudly instead of the route assertion passing quietly.

## 13. UI

- **Infrastructure** — eight tabs (`docker`, `storage`, `network`, `power`, `networks`, `volumes`,
  `images`, `topology`). Each tab fetches lazily: a hidden tab costs nothing. `?pool=` and
  `?dataset=` deep-link from an alert to the thing it is about.
- **Host** — `/host`, the machine itself.
- **InfraStatusStrip** — one row per provider with status, capability chips and the reason when
  there is one. "Not configured" is styled as a choice, not as a failure.
- **OpusGridTopology** — replaces the old `Topology.tsx`; five layers, a legend, `discovered` and
  `configured` edges labelled distinctly, and an empty state that explains what is missing rather
  than drawing a guess.
- **Connections** (Settings) — every provider, its state, and what configuring it would involve,
  including which environment variable holds a credential (named, never printed).
- Every panel shows "Not available" where a value could not be determined, and never `0`.

## 14. Tests

`npm test` → **697 passed, 0 failed** (593 before Phase 9; **104 added**).

| File | Cases | What it proves |
|---|---|---|
| `server/phase9-providers.test.js` | 10 | registry status vocabulary, TTL + single-flight, throw → `unavailable`, `data` stripped, independent providers |
| `server/phase9-storage.test.js` | 16 | three-command table, argv only, refused names never spawn, `-`/`#` → `null`, no borrowed numbers, empty vs unavailable |
| `server/phase9-network.test.js` | 12 | procfs/sysfs parsing, default route (v4/v6), resolvers, `host`/`container` scope |
| `server/phase9-opnsense.test.js` | 14 | frozen endpoints, field projection, plain-HTTP refusal, no credential in any output |
| `server/phase9-power.test.js` | 5 | `not-configured` vs `unavailable`, no fabricated hardware |
| `server/phase9-topology.test.js` | 11 | edges only from proof, gating on Docker, malformed topology files rejected wholesale |
| `server/phase9-health.test.js` | 15 | per-domain verdicts, `not-configured` excluded, never optimistic, alert areas |
| `server/phase9-security.test.js` | 21 | the whole table in §12, plus the scanner meta-test |
| `test/web/tests.tsx` | — | new fixtures and routes for the Infrastructure, Host and Connections surfaces |

Also updated: `server/phase8-proof.test.js` (a `zfs.js` branch on the `child_process` gate that is
**stricter** than the existing `version.js` one, and the safe scanner) and
`server/phase7-host.test.js` (the ZFS assertion was rewritten for a provider that actually
answers: it must either report ZFS facts or say it could not, and must never borrow filesystem
numbers).

`npm run typecheck` clean · `npm run verify` 62/62 · `npm run test:web` 55/55 · `npm run build` OK.

## 15. Known limitations

1. **ZFS inside a container is usually unavailable.** `zpool`/`zfs` are user-space binaries that
   are typically not present in the image. That is reported as `command_missing`, not as a fault
   and not as an empty pool list.
2. **The network provider sees the network namespace it runs in.** `/proc/net/route` and
   `/sys/class/net` inside a container describe the container unless it runs with host networking;
   every interface therefore carries `scope` and a note. Interpreting host interfaces from a
   bridged container is a deployment question, not a code one.
3. **UPS and PDU answer "not implemented yet".** The abstraction, the settings and the UI row
   exist; no protocol client does. Nothing is claimed about hardware that was never asked.
4. **OPNsense credentials cannot be configured through the UI** — by design. They are environment
   variables, so a restart with the environment missing means `not-configured`.
5. **The physical topology has no editor.** `config/topology.yaml` is written by hand and
   validated; a rejected file renders nothing.
6. **No infrastructure write exists anywhere.** Snapshots, scrubs, mounts, routes, firewall rules,
   DHCP, UPS shutdown and PDU switching are all absent — deliberately, and all at once, so that
   "OpusHub changed my storage" is not a sentence anyone can say after this phase.
7. **Topology is a summary, not a wire map.** It shows relationships a provider proved; it does not
   model bandwidth, VLAN membership or cabling.
8. **Nothing here has been validated against the real OpusGrid host.** Every behaviour above is
   proven against fixtures, a mock Docker engine, a fake command runner and a fake filesystem.
   The commands in §16 are what the operator should run; no claim of real-host validation is made.

## 16. Real-host validation (for the operator to run)

Not performed as part of this change. These are the commands that exercise each provider against
the real host:

```bash
# 1. the provider strip — what OpusHub thinks it can see, and why
curl -s http://<host>:<port>/api/infrastructure/providers | jq '.providers[] | {id, status, error}'

# 2. the headline document, and the health verdict
curl -s http://<host>:<port>/api/infrastructure | jq '{health, domains}'

# 3. storage — compare against the host's own answer
zpool list -Hp -o name,size,alloc,free,frag,cap,health
zfs list -Hp -t filesystem,volume -o name,used,avail,refer,mountpoint,compression,recordsize,quota
curl -s http://<host>:<port>/api/infrastructure/storage | jq '.zfs.pools[], .filesystems.mounts[]'
curl -s "http://<host>:<port>/api/infrastructure/storage/pool?name=$(zpool list -Ho name | head -1)" | jq

# 4. ZFS from inside the container will usually report command_missing — check that first
docker exec <container> sh -c 'command -v zpool zfs || echo "not in the image"'

# 5. network — the provider reads these four; the container's namespace is what it gets
cat /proc/net/dev; cat /proc/net/route; cat /proc/net/ipv6_route 2>/dev/null; cat /etc/resolv.conf
curl -s http://<host>:<port>/api/infrastructure/network | jq '.interfaces[] | {name, state, scope, addresses}'

# 6. OPNsense — with the credentials in the container's environment only
docker exec <container> env | grep -c OPUSHUB_OPNSENSE_    # expect 2 (key + secret), 0 printed values
curl -s http://<host>:<port>/api/infrastructure/opnsense | jq

# 7. the configured physical map
docker exec <container> sh -c 'cat "$OPUSHUB_CONFIG_DIR/topology.yaml"'
curl -s http://<host>:<port>/api/infrastructure/physical | jq '{available, nodes: (.nodes|length), links: (.links|length), reason}'

# 8. the topology — every edge should name the thing that proved it
curl -s http://<host>:<port>/api/infrastructure/topology | jq '.edges[] | {from, to, source}'

# 9. nothing in the surface is writable
for m in POST PUT PATCH DELETE; do
  curl -s -o /dev/null -w "$m /api/infrastructure -> %{http_code}\n" -X $m http://<host>:<port>/api/infrastructure
done   # expect 405 four times
```

## 17. Status at a glance

| Capability | Status |
|---|---|
| Provider registry, status vocabulary, TTL + single-flight | **implemented** |
| Filesystems, ZFS pools and datasets (read-only) | **implemented** |
| Host network (interfaces, routes, resolvers) | **implemented** |
| Host detail page, health aggregation, alerts/activity/search/palette | **implemented** |
| Configured physical topology (`config/topology.yaml`) | **implemented** (file, no editor) |
| OPNsense — system, interfaces, gateways, DNS | **optional** (needs URL + env credentials) |
| OPNsense — DHCP, firewall | **planned** (declared, no endpoint) |
| UPS | **unavailable** (abstraction only — "not implemented yet") |
| PDU | **unavailable** (abstraction only — "not implemented yet") |
| Any infrastructure write operation | **future / deferred** |
| NUT / SNMP / PDU protocol clients | **future** |
| Physical-topology editor | **future** |
| Filesystem browser, generic provider proxy | **not planned** |
