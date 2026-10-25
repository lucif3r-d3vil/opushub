# Phase 10A — OpusHub Monitoring Engine

> **Status:** implementation notes. Phase 10A detects, records and explains. It does not notify
> anyone outside OpusHub, and it does not change anything it observes.

This document is written as the phase is built: §1 is the audit that preceded the first line of
code, and the remaining sections describe what was built, what the limits are, and how the
boundaries are enforced.

---

## 1. Audit (STEP 0)

### Baseline

Recorded on the merge commit of Phase 9 (`main`, working tree clean) before any Phase 10A change:

| Command | Result |
| --- | --- |
| `npm test` | 697 tests, 697 pass, 0 fail (~41 s) |
| `npm run typecheck` | clean |
| `npm run build` | clean (vite 7, ~2 s) |
| `npm run verify` | 62/62 checks passed |
| `npm run smoke` | pass |
| `npm run test:web` | 55 passed, 0 failed |

Node 22, ESM, no new dependencies are required by this phase.

### EXISTING — reused as-is, not rewritten

| Capability | Where | How Phase 10A uses it |
| --- | --- | --- |
| Canonical inventory (containers → services, overlay, URL resolution) | `server/model.js`, `server/discovery.js` | the *only* source of Docker targets and of the service endpoints a monitor can watch |
| URL resolution + provenance | `server/urlResolver.js` (`urlSource` ∈ `manual`/`traefik`/`published-port`) | supplies a monitor's discovered endpoint; `urlSource` is stored as data, never branched on |
| Read-only Docker client | `server/providers/docker.js` | Docker checks read container state; the write client lives in `providers/dockerOperations.js` and is never imported |
| Alert engine | `server/alerts.js` | monitor state becomes an alert *input*; the existing signature/dedupe/ack behaviour is untouched |
| Activity log | `server/activity.js` | state changes and incidents produce events through `logEvent` with the existing dedupe window |
| Search | `server/search.js`, `src/components/SearchOverlay.tsx` | monitors and incidents become search entries of the existing index |
| Safe URL probing | `server/probe.js` | the *pattern* (bounded timeouts, hop revalidation, cached results) is followed; the prober itself is for provider health and is not the monitor path |
| Config store, layout, widgets, templates | `server/configStore.js`, `server/layout.js`, `server/widgets.js` | the Hub widget is a catalogue entry; monitoring state is **not** presentation config (see §4) |
| Auth + CSRF gate | `server/api.js` | `/api/monitoring/*` is mounted behind the same single gate as every other route |

### EXTEND

| Thing | Extension | Why it is safe |
| --- | --- | --- |
| `server/providers/background.js` | IP classification moves to `server/lib/ipPolicy.js`; background now asks the shared classifier with the *remote fetch* policy | verdicts for every address the previous classifier refused are unchanged; one implementation instead of two |
| `server/api.js` | mount `/api/monitoring/*`; add the monitor snapshot to the alert inputs | single auth gate, single CSRF check, no new public route |
| `server/alerts.js` | accept a `monitors` input and raise `monitor.<state>:<id>` conditions | the engine, severity model, dedupe, ack and links are the shipped ones |
| `server/activity.js` | a `monitoring` category (`monitor.*`, `incident.*` types) | category typing is a whitelist; adding one entry is the whole change |
| `server/index.js` | start/stop the monitoring engine with the other background loops | lifecycle stays in one place; the engine starts non-fatally |
| `server/widgets.js` | `monitoring` widget type + default composition | catalogue-validated like every other widget |
| `src/lib/search.ts`, `src/components/SearchOverlay.tsx` | `monitor` / `incident` kinds and "Open Monitoring" / "Open Incidents" actions | destinations only — the palette never operates anything |

### NEW

| File | Responsibility |
| --- | --- |
| `server/lib/ipPolicy.js` | the one address classifier; two policies (remote fetch, monitoring) |
| `server/monitoring/model.js` | monitor record, target validation, bounds, defaults, projections |
| `server/monitoring/state.js` | the state machine (thresholds, anti-flap, transitions) |
| `server/monitoring/incidents.js` | incident lifecycle (open → recovering → resolved) |
| `server/monitoring/net.js` | outbound hygiene: URL/TCP target parsing, address validation, pinning, redirect revalidation |
| `server/monitoring/checks/{http,tcp,docker}.js` | the three checks; each records evidence, never bodies |
| `server/monitoring/scheduler.js` | one centralized timer, bounded worker pool, per-monitor arming |
| `server/monitoring/store.js` | bounded, atomic persistence of monitors / history / incidents / engine state |
| `server/monitoring/engine.js` | the service layer: CRUD, tick → check → evaluate → record, incidents, uptime, activity, alert inputs, search entries |
| `server/monitoring/discovery.js` | suggestions from the canonical inventory (nothing is created by looking) |
| `server/monitoringApi.js` | `/api/monitoring/*` |
| `src/pages/Monitoring.tsx`, `src/pages/MonitorDetail.tsx`, `src/pages/settings/Monitoring.tsx`, `src/components/monitoring/*` | the three surfaces and their shared pieces |

### DEFERRED — deliberately not built

Notifications of any kind (Telegram, Discord, Slack, e-mail, webhooks, browser notifications, a
live notification centre, SSE), automatic remediation / Autoheal, AI, ICMP / DNS / filesystem /
storage / reverse-proxy monitor types, monitor importers, per-monitor credentials, multi-user
ownership, and any form of scan or sweep. Phase 10A stops at: monitor → check → evaluate → state →
incident → history, plus the existing alert and activity surfaces, which are fed with data.

### Non-negotiables carried into the implementation

1. Phases 1–9 are preserved; nothing working is rewritten without need.
2. No hardcoded Traefik, no hardcoded Uptime Kuma, no Uptime Kuma dependency of any kind.
3. Monitoring is provider/capability based.
4. No fabricated uptime, health or history — missing data is missing data.
5. Docker "running" is container state, never application availability.
6. No arbitrary URL fetcher, no arbitrary TCP scanner, no arbitrary Docker endpoint.
7. Monitoring never executes Docker operations, shell commands or filesystem access; it never
   restarts containers and never invokes the Phase 8 operations engine.
8. No AI, no fake data, no uncontrolled polling, and the existing authentication and CSRF
   boundaries are untouched.

---

## 2. What was built

### 2.1 The monitor

```
Monitor
├── id            mon-<12 hex>          server-generated, never client-supplied
├── name          ≤ 80 printable chars  a label, not an address
├── type          http | tcp | docker   the whole vocabulary of Phase 10A
├── target        { kind, service, url, host, port, scope, scopeAt }
├── intervalMs    10s – 24h             clamped server-side
├── timeoutMs     0.5s – 30s            and never ≥ its own interval − 1s
├── enabled       bool                  pause/resume
├── expected      { status, min, max }  HTTP only; 100–599
├── provenance    discovered | configured | imported
├── source        { kind, provider, urlSource, note } — descriptive only
├── status        pending | up | degraded | down | recovering | paused | unknown
├── latencyMs     from the last check, or null
├── lastCheck     { at, kind, statusCode, latencyMs, reason, code, errorType, hops, evidence }
├── nextCheck     the scheduler's own answer, recomputed on every check
├── failureCount / successCount / consecutiveFailures / consecutiveSuccesses
├── targetStale   the thing it watches no longer resolves in the inventory
└── createdAt / updatedAt
```

`scope` is the one field that is *evidence* rather than configuration: it is written by the check
that ran, from the addresses that check actually resolved (`scopeOf()` in `net.js`), and it is what
lets the UI say "internal endpoint" as a fact. `null` means "not measured yet" — never "public".

### 2.2 Targets — three shapes, and nothing else

| Type | Target | Validation | What the check does |
| --- | --- | --- | --- |
| `http` | a service reference, and/or an endpoint | `parseHttpEndpoint`: http(s) only, no credentials, ≤ 500 chars, path ≤ 300, port not in the "never an application" list, literal addresses classified; a hostname is validated when it resolves | one `GET` (no body, no cookies, no auth, UA `OpusHub/`), bounded timeout, ≤ 3 redirects each revalidated, response body dropped unread |
| `tcp` | one host + one port | `parseHost` / `parsePort`: single host (no CIDR, list, wildcard or `a-b` range), one port 1–65535 | one `connect()` to the validated address, then close |
| `docker` | a canonical service reference | `normalizeServiceRef`: group + name, no paths, no ids | one `inspect` of the container the *inventory* resolved, and only while it is running |

A service reference is resolved at **check time**, not frozen at creation: a monitor created from
`Media/jellyfin` follows the endpoint that service has now. That is what keeps monitoring
provider-agnostic — Traefik, a published port or a manual URL can all be the answer today, and the
monitor does not know or care which. The one field that records where a discovered endpoint came
from (`source.urlSource`, `source.provider`) is stored as data and never branched on.

### 2.3 Checks — what they record, and what they refuse to

| Type | ok | degraded | fail | unknown |
| --- | --- | --- | --- | --- |
| HTTP | status matches `expected` | a status outside `expected` (e.g. 500), a redirect loop, a blocked redirect | connection refused / timeout / DNS failure | refused address class, policy refusal |
| TCP | connected | — | connection refused / timeout / DNS failure | refused address class, policy refusal |
| Docker | running + healthcheck healthy, or running with no healthcheck declared (evidence says "unproven") | running with a **failing** healthcheck | stopped / exited / dead | engine offline, transitional state (`restarting`, health `starting`), target no longer in the inventory (stale) |

Two properties are enforced in code and asserted by tests:

* **nothing about the response body is kept** — `res.destroy()` is called as soon as the headers and
  status are known, and there is no code path that reads a body (`phase10a-proof.test.js`);
* **a refused address is never an outage** — it is `unknown`, so it can never cross the failure
  threshold and can never open an incident. A misconfigured monitor must not look like a dead
  service (`phase10a-checks.test.js`).

### 2.4 State machine

```
pending ──first ok──▶ up ──degraded answer──▶ degraded ──threshold failures──▶ down
   │                    ▲                          │                             │
   │                    │                          └────── ok ─────┐             │
   │                 recovering ◀──────── one success while down ───┘             │
   │                    │                                                         │
   └──resume────────────┴──────────── recoveryThreshold successes ────────────────┘
   paused (not a health state)          unknown (no verdict; counters untouched)
```

* **3 consecutive failures** (configurable 1–10) move a monitor to `down`. A single failure moves it
  to no state at all — `phase10a-engine.test.js` and `phase10a-api.test.js` both assert that one bad
  check is not an outage.
* **2 consecutive successes** (configurable 1–10) move it back to `up`; the first success after an
  outage lands in `recovering`, which is what makes anti-flapping visible instead of instant.
* A `degraded` answer is a real negative signal and is immediate (a 500 is not "probably fine"), but
  it does not count toward the failure threshold.
* `unknown` (no verdict) moves no counters in either direction, so an engine that cannot reach the
  inventory cannot slowly turn services "down".
* `paused` is orthogonal: a paused monitor is not down, produces no incidents, and its history is
  marked paused rather than failed.
* Maintenance windows suppress alerts and mark incidents; they do not change the recorded state.

### 2.5 Incidents

Persisted (not memory-only), one open incident per monitor, with `startedAt` (the first failed check
of the streak, so the duration is the outage and not the threshold), `detectedAt` (when it crossed
the threshold), `recoveredAt`, `durationMs`, `status` (`open` → `recovering` → `resolved`), `reason`,
`failureCount`, `maintenance`, `resolvedBy`. Closing reasons are `recovered`, `paused` and `deleted`,
so an incident never disappears without saying why. Open incidents are kept forever; resolved ones
are bounded by `retentionIncidents`.

### 2.6 History, uptime and retention

* **Samples**: one record per check (`t`, `k`, `code`, `ms`) per monitor, newest first, bounded by
  `retentionSamples` (default 360, max 2000).
* **Hourly buckets**: per monitor per hour, bounded by `retentionHours` (default 336, max 2000).
* **Aggregation** happens at read time: 24h / 7d / 30d windows are computed from the samples and
  buckets that exist — never interpolated and never extrapolated.
* **Uptime** is `ok / (ok + degraded + fail)` over the window. `unknown` results are counted and
  excluded from the denominator (they are not evidence in either direction). Missing data is `null`,
  a monitor with no checks reports `noData: true`, and a paused monitor reports `paused` — so 100%
  can only ever mean "every judged check passed".
* Everything is written under `DATA_DIR/monitoring/` (`monitors.json`, `history.json`,
  `incidents.json`, `engine.json`), atomically (temp file + rename), debounced, and loaded at boot —
  a restart resumes rather than forgets (asserted in `phase10a-engine.test.js`, and verified by hand
  against a running server).

### 2.7 Scheduler

One `createScheduler()` per process (`server/monitoring/scheduler.js`), owned by the engine:

* **one timer**, not one per monitor: a single tick computes the monitors that are due and hands
  them to a bounded pool;
* **bounded concurrency** (`maxConcurrent`, default 3, max 8) — a due monitor that cannot start
  waits for the pool rather than piling up;
* **exactly one in-flight check per monitor** (a due monitor that is already running is skipped, and
  `nextDueAt()` is computed from completion so an overrun cannot create a backlog);
* **optional jitter** (`jitterMs`, default 5s) spreads monitors that share an interval — the
  thundering-herd guard;
* **server-side interval floor** of 10s and a manual-check rate limit of one per monitor per 5s;
* **no browser polling of targets**: the UI polls the monitoring API at 15–30s and nothing else;
* **graceful shutdown**: `stop()` stops arming work, waits for the checks already in flight up to a
  bounded grace, and `index.js` stops the engine before the Docker loops;
* **bounded pool accounting**: `checksRunning`, `maxChecksRunning`, `ticks` and `lastTickAt` are
  reported by `engineHealth()`, which marks everything stale when the engine is stopped or has not
  ticked for two minutes.

### 2.8 API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/monitoring` | overview: engine health, counts, monitors (optionally `?include=uptime`, `?service=group/name`) |
| GET | `/api/monitoring/monitors/:id` | detail: monitor, uptime windows, series, buckets, incidents, engine |
| GET | `/api/monitoring/incidents` | incidents, `?open=1`, `?monitorId=` |
| GET | `/api/monitoring/engine` | engine health alone |
| GET | `/api/monitoring/settings` | effective defaults + bounds |
| GET | `/api/monitoring/suggestions` | what the inventory offers (creates nothing) |
| GET | `/api/monitoring/search` | the search entries the global index consumes |
| POST | `/api/monitoring/monitors` | create |
| PUT | `/api/monitoring/monitors/:id` | edit a definition |
| POST | `/api/monitoring/monitors/:id/{pause,resume,check}` | pause / resume / re-run the stored target |
| POST · DELETE | `/api/monitoring/monitors/:id/maintenance[/clear]` | open / end a window |
| DELETE | `/api/monitoring/monitors/:id` | delete |
| POST | `/api/monitoring/suggestions/apply` | create the chosen suggestions |
| PUT | `/api/monitoring/settings` | update defaults (clamped server-side) |

**There is no route that accepts a URL, host, port or container id to check.** The one manual
trigger names a stored monitor and re-runs its stored, validated target. Every response is the
`publicMonitor` projection — the engine's internals (`streakStartedAt`, `lastManualCheckAt`) never
leave the process.

### 2.9 Discovery and suggestions

`suggestMonitors()` reads the canonical inventory and offers at most one HTTP suggestion per service
that has a URL *and* a trusted URL source (`manual`, `traefik`, `published-port`), plus one Docker
suggestion for that same service. Services without a usable endpoint are never suggested. Reading
the list creates nothing. Creating from it requires an explicit `POST …/suggestions/apply`, is
bounded by `maxMonitors`, and every monitor it makes carries `provenance: 'discovered'`. The
opt-in `autoCreate.enabled` (off by default, capped by `autoCreate.max`) does the same at boot and
nothing else — there is no path by which discovery silently turns the host into a monitor.

### 2.10 UI

* **`/monitoring`** — engine line, counts strip (Total / Up / Degraded / Down / Paused, each a
  filter), the suggestions panel, and the monitors as rows grouped by their service's group. A
  monitor row carries its type, its target, today's uptime, latency, last check and its state word.
* **`/monitoring/incidents`** — every recorded incident, with its real duration and its reason.
* **`/monitoring/:id`** — state, scope, target, uptime (24h/7d/30d), latency (avg/min/max), the
  recorded series as a sparkline and a list, the incident history, the definition (with an inline
  edit for name/interval/timeout/note), maintenance controls, pause/resume/check-now/delete.
* **Settings → Monitoring** — the defaults and the retention/load values with their server-side
  bounds printed next to every field, the internal-target switch, the discovery opt-in, the monitor
  list, and the boundaries in plain words.
* **Hub widget** — a compact summary (totals, then only the monitors that are not well, with how
  long and why) that links to Monitoring, and that renders its own honest state when monitoring is
  unavailable without disturbing the rest of the Hub.
* **Service detail** — a Monitoring block listing the monitors that watch *that* service, or a
  "Configure a monitor" link that opens the Add dialog with the service (and its discovered
  endpoint) already chosen.
* **Search and palette** — monitors and incidents are indexed by the server (kinds `monitor` and
  `incident`) and open their page; "Open Monitoring", "Open Incidents" and "Configure monitoring
  defaults" are plain navigation. Nothing in the palette operates anything.

### 2.11 Activity and alerts — integration is data, not control

* Activity gets a `monitoring` category and exactly the events that mean something:
  `monitor.created/updated/deleted/paused/resumed/maintenance_started/maintenance_ended/settings_updated`,
  and — from the state machine only — `monitor.down/degraded/degraded_cleared/recovering/recovered/unknown`
  and `incident.opened/incident.resolved`. Successful checks are never events, and the existing
  dedupe window applies unchanged.
* The alert engine consumes `alertInputs()`: one condition per monitor that is `down` (critical) or
  `degraded` (warning), signature `monitor.<status>:<id>`, area `monitoring`, linking to the monitor.
  Paused monitors and monitors inside a maintenance window are not offered at all, which is the
  entire mechanism behind "maintenance is quiet". A monitor that is not well is never the same thing
  as an incident record — the alert says "this is true now", the incident says "this happened".

---

## 3. Security

### 3.1 One classifier, two policies

`server/lib/ipPolicy.js` is the only place an address is classified. It exposes one classifier
(`classifyIp`) and two frozen verdict sets:

| class | remote fetch (background images) | monitoring |
| --- | --- | --- |
| loopback, unspecified, multicast, reserved, discard, documentation, benchmark, invalid | **blocked** | **blocked** |
| link-local (169.254.0.0/16, fe80::/10 — includes 169.254.169.254) | **blocked** | **blocked** |
| private (RFC1918), shared (100.64/10), unique-local (fc00::/7) | **blocked** | **allowed by default**, recorded as `internal`, switchable off |
| public | allowed | allowed |

The background fetcher's shipped verdicts were preserved exactly (including the coarser
`169/8` and `100::/8` refusals) when the classifier moved; `phase8`/provider tests and the Phase 10A
proof both assert that. Nothing else in the server defines an address range: `hostAddress.js` and
`urlResolver.js` contain display-tier heuristics that only ever *exclude* a host from a link, and the
proof test asserts they are on no connection path and make no policy decision.

### 3.2 Internal targets: allowed because it is a homelab, bounded because it is a capability

The three cases the brief asks to distinguish are distinguished in the data, not in prose:

| case | how it is expressed | what bounds it |
| --- | --- | --- |
| public endpoint | `target.scope = 'public'` (measured) | nothing special |
| explicitly configured internal endpoint | `provenance: 'configured'` + `target.scope = 'internal'` | authenticated + CSRF-gated write; `parseHttpEndpoint`/`parseHost` validate the literal; the resolver validates every address on every check; `allowInternal: false` refuses the whole class with `internal_blocked`; the monitor shows "internal" in the UI |
| discovered service endpoint | `provenance: 'discovered'` + `source.urlSource` | only services the inventory already sees; only when a trusted URL source exists; suggestions create nothing by themselves; the same policy applies at check time |

The always-blocked classes cannot be re-enabled by any setting, any monitor or any suggestion — the
proof test asserts their refusal both with `allowInternal: true` and with `false`. A policy refusal
is `unknown`, so no setting and no attacker-influenced DNS answer can turn a blocked target into an
outage, an incident or an alert.

### 3.3 SSRF, rebinding and redirects

* The name is resolved by us, **every** address it returns is classified, and **one** bad answer
  refuses the whole name (DNS rebinding against a multi-answer host);
* the check connects to the address that was validated (`lookup` is overridden with the pinned
  address for HTTP; TCP connects to the address, not the name) — a second DNS answer during the
  connection cannot move the destination;
* each redirect hop is re-parsed and revalidated: http(s) only, no credentials, no https→http
  downgrade, hop budget of 3, and the new host resolves through the same policy;
* the checked URL is never taken from a request — it is read from the stored monitor, and the
  browser has no endpoint that accepts one;
* HTTP checks use `GET`, send no body, no cookies, no credentials; the response body is never read
  and the socket is destroyed after the headers;
* port discipline: an HTTP endpoint may not point at SSH/RDP/SMB/LDAP/database/daemon ports
  (22, 23, 25, 110, 111, 135, 137–139, 143, 389, 445, 465, 514, 587, 636, 993, 995, 1080, 1433,
  1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 6379, 11211, 27017) — no HTTP monitor may be used
  to probe a service that does not speak HTTP. TCP monitors are explicit single endpoints by
  construction and carry no such list.

### 3.4 TCP is one endpoint, never a scanner

`parseTcpEndpoint` and the model both refuse a CIDR block, a comma list, whitespace-separated hosts,
a wildcard, a `10.0.0.1-10.0.0.50` range and a port range or list. The check module contains exactly
one `net.connect()` call and no loop of any kind over targets — asserted mechanically. There is no
subnet, sweep, host-discovery or port-scanning code path in the engine.

### 3.5 Docker is read-only

The Docker check imports `providers/docker.js` (the read client), names exactly one container
through the canonical inventory, and calls `inspect` at most once and only for a running container.
It never touches `providers/dockerOperations.js`, `operations/` or `operationsApi.js` — the static
proof asserts the absence of those imports and of every write verb in the whole monitoring tree. The
Docker check also never chooses a socket: it goes through the provider client the rest of OpusHub
uses.

### 3.6 No shell, no filesystem, no AI, no notifications

* no `child_process`, no `exec`, no `spawn`, no shell of any kind anywhere in monitoring;
* the only filesystem access is `server/monitoring/store.js`, whose complete vocabulary is four file
  names, gated by `storePath()`; the proof test feeds it traversals and asserts they are refused;
* no notification channel exists: no Telegram/Discord/Slack/webhook/e-mail/SMTP/SSE/EventSource/
  browser-notification code in any monitoring file (asserted by pattern);
* no AI surface of any kind, and no MCP/agent endpoint;
* the monitoring `PUT /api/monitoring/settings` can make the engine *stricter*; nothing in the API
  can widen the block lists, raise a bound above the compiled maximum, turn a check into an action,
  or let the browser name a target to check.

### 3.7 Authentication and CSRF are untouched

`/api/monitoring/*` is dispatched from inside the same gate as every other route (`server/api.js`),
so: session required (401), CSRF non-GET (403 without a matching Origin), method dispatch, and the
`/api/v1/*` rewrite. The API test asserts the 401 for all 13 routes and the 403 with no write
applied.

---

## 4. What reuse looks like (Phase 7 / Phase 9 already had this)

| Already existed (Phase 7/9) | How Phase 10A uses it |
| --- | --- |
| `providers/docker.js` availability + `inspect` | the Docker check: read-only, canonical, one call |
| `model.getInventory()` / `getServicesView()` | the only inventory: enables/disables Docker monitoring, resolves container state, supplies service URLs, feeds discovery |
| `urlResolver.js` + `urlSource` provenance | the endpoint a discovered monitor watches, and the record of where it came from |
| `providers` registry + `describeProviders()` | provider health remains the provider registry's answer; monitoring does not become a second health source |
| `alerts.js` (conditions, severity, dedupe, ack, links) | monitor state is an *input*; nothing about the alert engine changed |
| `activity.js` (JSONL, severities, dedupe, categories) | a `monitoring` category and the transition events |
| `search.js` + `SearchOverlay` | monitors and incidents as indexed destinations |
| `statsHistory.js` / service detail | untouched: service health stays service health, and the monitoring block only *links* to monitors |
| `configStore.js` boundary (7 presentation files) | monitoring state deliberately lives under `DATA_DIR`, outside the exportable configuration |
| `api.js` gate, `widgets.js` catalogue, `layout.js` | one mount point, one catalogue entry, one default composition |

---

## 5. Numbers, as built

| Thing | Bound |
| --- | --- |
| interval | 10s – 24h (default 60s) |
| timeout | 0.5s – 30s (default 5s), always < interval − 1s |
| failures before `down` / successes before `up` | 1–10 / 1–10 (defaults 3 / 2) |
| concurrent checks | 1–8 (default 3) |
| scheduler jitter | 0 – 60s (default 5s) |
| monitor cap | 1 – 500 (default 200) |
| discovery auto-create | off; 0 – 100 (default max 10) |
| manual check rate limit | one per monitor per 5s |
| recent samples / hourly buckets / resolved incidents | 30–2000 / 24–2000 h / 20–2000 |
| maintenance window | ≤ 30 days (default cap 1 day) |
| redirects per HTTP check | 3, each revalidated |
| addresses considered per name | 8 |
| engine staleness | no tick for 120s (or any non-running state) ⇒ stale |

---

## 6. Tests

| File | What it holds |
| --- | --- |
| `server/phase10a-model.test.js` (17) | the type vocabulary, every bound, target validation (HTTP/TCP/Docker), provenance, maintenance, the public projection, the address policy and its two verdicts, internal targets |
| `server/phase10a-state.test.js` (16) | thresholds, anti-flap, `unknown` never moving counters, paused semantics, transition names |
| `server/phase10a-checks.test.js` (11) | the three checks against real sockets: status/latency/timestamp, body never read, redirect revalidation, TCP single endpoint, Docker read-only with exactly one inspect, scope recording, `allowInternal` |
| `server/phase10a-scheduler.test.js` (10) | one timer, bounded pool, no duplicate in-flight check, jitter, graceful stop |
| `server/phase10a-engine.test.js` (18) | CRUD + history + uptime, the outage → incident → recovery cycle, restart persistence, pause, maintenance, activity, staleness, alert inputs, search, deletion, cap, settings clamping, manual check rate limit, concurrency, the scheduler actually checking, scope recording |
| `server/phase10a-api.test.js` (12) | the whole `/api/monitoring` surface through the real gates: 401s, CSRF, lifecycle, refusals, Docker-read-only assertion, 404/405, suggestions, alerts, activity, search, no URL-taking route |
| `server/phase10a-proof.test.js` (16) | the static security proofs (below) |
| `test/web/tests.tsx` (+12) | the pages: counts and list, stale engine, add-monitor payload, refusals in place, filtering, incidents, detail history, maintenance choices, settings bounds, service block, search destinations, Hub widget with and without monitoring |
| `test/verify.mjs` (+18 when Docker is live) | the same properties against a **running** server: engine state, monitor creation, manual check, history, pause, refusals, settings clamping, search, activity, deletion, 401 |

### The static proofs (`server/phase10a-proof.test.js`)

1. the monitoring file set is fixed — a new file must be reviewed here before it ships;
2. no `fetch()`, no second HTTP client, no write verb, no body read, no download plumbing in the
   monitoring tree; the only outbound HTTP is the check's own `GET`;
3. redirects are revalidated, bounded, and refuse scheme changes, credentials and downgrades;
4. loopback/link-local/metadata/multicast/unspecified/reserved/documentation/benchmark/discard are
   blocked for monitoring, private/CGNAT/ULA are allowed *and* recorded, and the classifier is the
   shared one (no range literals anywhere else on a connection path);
5. a name is only reached when every answer is allowed, and the validated address is the one pinned;
6. TCP cannot express a range, a list or a sweep, and the module has exactly one `connect()`;
7. Docker monitoring cannot write: no operations import, no lifecycle call, no socket, no id target;
8. no Phase 8 import, no shell, no direct filesystem read, and the store's file vocabulary is
   exactly four names with traversal refused;
9. no notification channel, no SSE, no browser notification, no AI surface;
10. the monitoring API writes monitor definitions only, sits behind the identity gate, and no request
    starts or stops the engine; exactly one module creates a scheduler and no other module arms a
    timer for monitoring.

---

## 7. Deferred to Phase 10B (and beyond) — deliberately not built

* **Notifications** of every kind: Telegram, Discord, Slack, e-mail, webhooks, browser
  notifications, a live notification centre, SSE/streaming updates. The engine emits activity events
  and alert inputs and is clean to subscribe to; it has no delivery mechanism of its own.
* **Automatic remediation / Autoheal**: nothing in Phase 10A can start, stop or restart anything,
  and the Phase 8 operations engine is never invoked (Monitor → Incident → Automation Policy → Ops
  Engine is a later phase, and must be an explicit, confirmed, permissioned chain).
* **AI-assisted anything**: no model, no agent surface, no MCP, no summarisation.
* **More monitor types**: ICMP, DNS, filesystem, storage, reverse-proxy-specific and user-supplied
  check scripts. The `type` field is a closed set (`http|tcp|docker`) with a test asserting the
  refusal of everything else.
* **Monitor importers** (including any Uptime Kuma import) — `provenance: 'imported'` exists in the
  vocabulary, but nothing imports.
* Per-monitor credentials, custom headers, request bodies, TLS pinning, certificate inspection and
  authenticated checks: an HTTP monitor is an unauthenticated `GET` and nothing more.
* Grouping/labelling beyond the service's own group, monitor ownership per user, quiet hours and
  recurring maintenance calendars (a window is a single bounded window).

---

## 8. Manual validation on the real host

I have no access to the OpusGrid host, so nothing in this document claims a real-host run. The
commands and steps below are the ones to run there; everything they exercise is covered by the
automated suites above, and the parts that cannot be covered in a sandbox (a real listener going
down and coming back) are exactly what the steps are for.

```bash
cd /opt/stacks/opushub
docker compose pull
docker compose up -d
docker compose ps
docker logs --tail 100 opushub
```

1. Open **Monitoring** in the nav (between Services and Stacks). The engine line should read
   *Monitoring is running*; with no monitors it reads *running, with no enabled monitors*.
2. **Add monitor** → pick `HTTP`, choose a discovered service from the pulldown (e.g. Jellyfin) —
   the endpoint is prefilled from what OpusHub already resolved — set *Check every* 30s, save. The
   monitor appears in its service's group with state **Not checked yet**.
3. Wait one interval: the state becomes **Up** with a latency and a "checked …" time, and the detail
   page shows a recorded check, a latency figure and an uptime percentage computed from that check.
4. **Add monitor** → `Docker`, choose a service, save. The Docker monitor reports container state
   with evidence (`proven by healthcheck` / `unproven — no healthcheck` / `healthcheck failing`).
5. **Add monitor** → `TCP`, host `10.0.0.9` (or any LAN address), port `8096`, save. Confirm the row
   shows the **internal** marker and the detail page says *internal endpoint* — that is the recorded
   scope, not a guess.
6. Stop a disposable service on the host (`docker compose -f /opt/stacks/… stop <service>`, chosen
   by you) so the HTTP/TCP monitor fails. After the third consecutive failure the monitor turns
   **Down**, an **Incident** appears with a live duration, and an alert condition `monitor.down` is
   visible in Activity's alert strip.
7. Restart that service. The monitor shows **Recovering** on the first success, then **Up** after
   the second; the incident becomes *recovered* with a real duration (start = first failed check,
   end = recovery), and `incident.resolved` appears in Activity.
8. On the monitor's detail page, check uptime and latency for the 24h window, and the recorded check
   list — every number traces to a check the engine ran.
9. **Pause** the monitor: it shows *Paused*, counts under Paused, raises no alert, and its history
   stays visible. **Resume**: it shows *No verdict* until the next check, then a real state.
10. Open **Settings → Monitoring**: change the default interval to 30s and save; confirm the field
    reports the clamped value and its bound. Turn *internal targets* off and confirm the next check of
    the TCP monitor above reports **No verdict** with the reason *on the local network … public
    endpoints only*, without going down. Turn it back on.
11. Start a maintenance window from the monitor's page for 15 minutes: the monitor is not alerted
    while it fails, the incident is marked *maintenance*, and the window ends by itself.
12. Confirm **Service detail → Monitoring** lists the monitors for that service, and that
    `Search` (⌘K / `/`) finds monitors and incidents and opens them.
13. **Restart OpusHub** (`docker compose restart opushub`) and confirm the monitors, their history,
    their incidents and their states come back, and that the engine resumes checking. Confirm in
    `docker logs opushub` that OpusHub restarted **no** container of yours: the log line is
    `monitoring : running — N active, M concurrent checks`, and the only containers that change state
    are the ones you changed by hand.

## 9. What Phase 10A does, in one sentence

OpusHub Monitoring **detects and records**: it observes configured targets on a bounded schedule,
keeps an honest state machine, opens and closes incidents with real durations, keeps bounded history
and uptime, feeds the existing alert and activity surfaces, and stops there — **no external
notification, no container restart, no Docker operation, no shell command, no AI**.
