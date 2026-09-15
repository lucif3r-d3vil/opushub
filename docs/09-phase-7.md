# OpusHub — Phase 7: production control-plane hardening

Status: implemented (7A–7G) on `arena/01a0a4cb-opushub`. Builds on Phases 1–6 without
rewriting them: same design system, same inventory model, same tests-still-green rule.

The one-line summary: **Docker stays strictly read-only**, and everything new in this
phase is either a read model over data OpusHub already holds, or a bounded, explicit,
user-triggered action that never touches the engine.

## The read-only rule (and its proof)

`server/providers/docker.js` issues requests exclusively through `http.get`. There is
no `http.request`, no method parameter, and no reference — not even as a string — to
`/start`, `/stop`, `/restart`, `/kill`, `/exec`, `/prune`, `/commit`, `/rename`,
`/update`, `/pause`, `/unpause`, `/attach`, `/resize`, `/copy` or `/archive`.

The proof is mechanical, not a comment promise — `server/phase7-proof.test.js`:

1. **Static**: the client's source (comments stripped) contains `http.get` and none of
   the banned call shapes or operation paths.
2. **Socket confinement**: no server module outside the docker provider references the
   socket path or `DOCKER_HOST` (comments stripped).
3. **Dynamic**: a sweep of ~20 API routes against the mock engine records every engine
   call in the wire log, and every line starts with `GET `.

## What was built, by slice

### 7A — Host model, versioning, storage providers, inventory API

- `GET /api/host` (`server/host.js`): the canonical Host document — OS, CPU, memory,
  uptime, Docker engine facts, container counts. One answer to "what machine is this".
- `server/version.js` + `GET /api/version`: name, version, git SHA, build time, image
  tag, installation mode (docker vs source). Unknown renders as "Not available", never
  guessed.
- `server/providers/storage.js` + `GET /api/storage`: the storage provider model —
  filesystem mounts today, ZFS/Btrfs/mergerfs as explicit not-implemented providers
  rather than silent gaps.

### 7B — Infrastructure API, v1 aliases, degraded mode

- `GET /api/networks|/volumes|/images` (`model.getInfra`): one cached document, proven
  joins only (image usage matched container-image → RepoTags; network attachments are
  the daemon's own map; volumes report RefCount because per-container mapping would
  need an inspect per container).
- `/api/v1/*` (`api.js` rewrite): the canonical versioned namespace; unversioned routes
  are permanent aliases. Services, stacks, resources and friends are reachable under
  both.
- Degraded mode: when the engine is unreachable, inventory routes serve last-known
  state with `live: false`, `code: 'docker_unavailable'`, and a timestamp — the UI
  banners it (`LastKnownNote`) instead of pretending.

### 7C — Safe probing, unified health, structured errors

- `server/probe.js`: bounded HTTP checks (5s timeout, 3 redirects max, each hop
  re-validated, http/https only). Only trust-worthy URL sources (Traefik, published
  ports, validated config) are ever probed — user input is refused without a packet.
- `server/healthModel.js` + `GET /api/services/:group/:name/health`: one verdict per
  service (healthy/available/degraded/unhealthy/unreachable/stopped/starting/unknown)
  with the evidence that produced it (container state, healthcheck, HTTP, stack).
- `server/errors.js`: the structured error model (`code` + human `reason`) carried by
  every degraded response.

### 7D — Infrastructure UI, topology, resources, health panel

- `/infrastructure` (`src/pages/Infrastructure.tsx`): engine facts, Networks / Volumes /
  Images tabs, and the read-only topology graph (`Topology.tsx`) drawn purely from the
  daemon's attachment maps — no invented edges.
- `GET /api/resources` (`server/resources.js`): CPU/memory/network/disk series with
  avg/peak math, joined against the topology invariant (every attachment resolves to
  an inventoried container).
- Service detail gained the unified health strip (60s poll, Re-check, evidence rows);
  Services and Stacks gained degraded banners with counts, timestamps and Retry.

### 7E — Activity upgrades, alerts, notifications

- Events carry `severity` (info/notice/warning/critical) and `category`
  (service/stack/docker/system/security/config), derived from the event type — pre-7E
  log lines normalize on read. `GET /api/activity` filters by both.
- `server/alerts.js` + `GET /api/alerts`: a small honest engine over data already held
  — docker-down, unhealthy services, degraded stacks, memory/disk pressure, auth-failure
  bursts. Stable signatures, worst-first cap of 50 (the overflow is disclosed, not
  silent), `alert.fired`/`alert.resolved` transitions logged exactly once, in-memory
  ack via `POST /api/alerts/ack`.
- `server/notify.js`: the delivery registry — webhook, email, Telegram, Slack, all
  `coming-later`, with the fan-out and Settings surface ready so a real channel is one
  `registerChannel()` call.
- Activity page: active-alert strip with evidence links + ack, Area/Severity filters,
  severity dots. Settings → Notifications names the channels and their status.

### 7F — Updates, extended search, performance bounds

- `server/updateCheck.js` + `GET /api/updates` / `POST /api/updates/check`: explicit,
  user-triggered checks against the GitHub releases API only. No timer, no boot ping,
  no page-load call; 10s timeout; 6h cache; every failure is `unknown` with a reason.
  The Environment tab shows the install, the newest release, and the Check button.
- Search (`server/search.js`) indexes active alerts (linking at their evidence) and
  infrastructure names (deep-linked to their Infrastructure tab), plus the
  Notifications settings page. The palette groups them as Alerts / Infrastructure.
- Bounds: needle truncated to 80 chars at the route, 500-bookmark loop cap, 24 results
  max — all asserted in `server/phase7-search-updates.test.js`.

### 7G — Proofs, audits, headers

- `server/phase7-proof.test.js`: the GET-only proofs above, plus a secret-leak sweep
  (the mock engine plants `SECRET_SHOULD_NEVER_LEAVE_SERVER=hunter2` in inspect output;
  no Phase-7 response may contain it, any env value, or any socket/daemon path),
  `/api/health` env-files-by-count assertion, and the `nosniff` header check.
- SSRF posture: `probe.js` re-validates every redirect hop (tested in
  `server/phase7-health.test.js`); the only other outbound fetch is the explicit update
  check. Security headers (CSP, frame denial, referrer policy) live in `server/index.js`
  for the app shell and `send()` for the API.

## API inventory (new in Phase 7)

| Route | Shape |
|---|---|
| `GET /api/host` | Host document |
| `GET /api/networks|/volumes|/images` | Infra document slices (live or stale-labelled) |
| `GET /api/storage` | Storage providers |
| `GET /api/resources` | Series + avg/peak + storage |
| `GET /api/services/:group/:name/health` | Unified verdict + evidence |
| `GET /api/alerts` / `POST /api/alerts/ack` | Active alerts + channels / ack |
| `GET /api/updates` / `POST /api/updates/check` | Cached answer / explicit check |
| `GET /api/version` | Version document |
| `GET /api/v1/*` | Canonical aliases for the above |
| `GET /api/activity?category=&severity=` | New filters |

## Validation

```sh
npm run typecheck
node --test 'server/*.test.js'   # 332 tests
npm run test:web                 # 49 tests
npm run build
```

Design constraints honored throughout: no fake data (every "unknown" says why), no
invented links, hidden services stay hidden from search, Docker GET-only, secrets and
socket paths never cross to the browser.
