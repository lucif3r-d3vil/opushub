# OpusHub — Service Intelligence (read-only depth)

Status: Phase 3 · extends `02-architecture.md` and `04-discovery.md`; changes neither.

Phase 3 makes OpusHub answer *"what is happening inside my self-hosted environment?"* — runtime
state, resources, logs, change history, stack rollups and provider health — while remaining a
**strictly read-only observer**. The discovery contract from `04-discovery.md` is untouched:
Docker decides what exists, config decides how it is presented, and nothing in this phase gives
OpusHub a way to change either.

## The read-only boundary (enforced, not promised)

Everything below is true by construction, and the test suite asserts it:

- **No mutation routes.** There is no endpoint that restarts, stops, creates, deletes, updates,
  pulls, recreates or redeploys anything. The server's Docker client implements exactly four read
  operations: list, inspect, stats, logs — plus the event stream.
- **No exec, no shell, no stdin.** The log viewer reads the container log Docker already keeps;
  it cannot send a byte to a container. The UI says so on the drawer itself.
- **No secret crossings.** Container `Env` is never part of any projection (the mock engine ships
  a canary value to prove it); `.env` values stay server-side; `/api/health` names keys only;
  image digests/tags are metadata, never configuration.
- **No arbitrary Engine proxying.** Every route is one OpusHub builds itself from a validated
  container reference (a discovered service's name or id — nothing else reaches the socket).
  A request for `/api/docker/containers/anything/../../version` is a 404, not a proxy.
- **No filesystem browsing, no mount contents.** Mounts are presented as the two paths Docker
  reports, read-only. Nothing reads what lives behind them.

## API surface (all generic, all stable IDs)

There are no per-app routes (no `/api/jellyfin`); everything is addressed by the same stable
service keys the rest of the app uses (`:group/:name` for services, `:id` for stacks).

| Route | Answers |
|---|---|
| `GET /api/services/:group/:name` | the canonical service + inspect-level container facts (state, healthcheck, timestamps, restart count, ports vs exposed ports, networks, mounts, image info) + URL and its source |
| `GET …/stats` | one on-demand stats reading (`ok` + metrics, or `unavailable` with the honest reason) |
| `GET …/stats/history?window=ms` | the bounded ring buffer of samples taken *while somebody was looking* |
| `GET …/logs?tail=N&timestamps=1` | recent Docker logs for the container (cap 500 lines) |
| `GET …/history?limit=N` | real events OpusHub witnessed for this container + `watchingSince` |
| `GET /api/stacks/:id` | stack doc with deterministic status and per-member resource summaries |
| `GET /api/providers` | one health doc for Docker / System / News / Weather / Markets |
| `GET /api/activity?grouped=1&limit=N&source=s` | the witnessed event timeline, optionally grouped |

`/api/layout/reset` and overlay writes remain presentation-only; Phase 3 added no new write of any
kind.

## Health semantics

States are reported exactly as Docker reports them — `running`, `exited`, `paused`, `created`,
`restarting` — and health is kept separate from state:

- `healthy` / `unhealthy` come from the container's own healthcheck; an unhealthy verdict on a
  running container shows the failing streak, never just a red dot.
- **A container with no healthcheck is not unhealthy.** It shows *No healthcheck* — an absence,
  not a failure.
- Stopped containers report *Not available* for health and stats rather than zeros-as-data.

### Stack status model (deterministic, documented)

`server/model.js → stackStatus(members, live)` is the single source of truth, in this order:

1. engine unavailable → `unavailable`; the stack binds to no live container → `unlinked`
2. any member's state unknown → `unknown`
3. all running and none unhealthy → `operational`
4. none running and all exited → `stopped`
5. none running but some paused/restarting/created → `attention`
6. anything else (mixed running/stopped/unhealthy) → `degraded`

The Hub's stack widget shows the compact rollup of exactly these counts
(`n containers · n running · n attention`); the stack page shows the same numbers plus CPU/memory.

## Stats: on demand, bounded, honest

- Samples exist **only while somebody is looking**: the service page polls its own
  `/stats/history` every 5 s while mounted and nothing polls it otherwise. There is no global
  per-container loop anywhere.
- Server-side: single-flight dedupe + 3 s cache per container; a ring buffer capped at 360 samples
  (≥2 s apart), keyed by resolved container id.
- Network rx/tx are cumulative counters — the client derives rates from consecutive real samples
  and skips counter resets instead of inventing negatives.
- Unreadable stats (stopped container, engine hiccup) answer `unavailable` with a reason; the UI
  says *The engine has no stats for this container right now* rather than showing 0%.

## Logs: a viewer, not a terminal

- Fetched only when the drawer is open, on manual refresh, or when the tail size changes —
  never streamed.
- Tail is capped (500 lines), timestamps optional; ANSI and control characters are stripped.
- Search, level filtering (errors/warnings) and "clear view" happen **in the browser** — zero
  extra requests. The server test asserts the filtering contract; the DOM test asserts no fetch
  leaves the page while filtering.
- No exec, no attach, no stdin — the route only ever performs a Docker *logs* read.

## Activity: real events, stable IDs, bounded retention

`server/activity.js` keeps an append-only JSONL at `data/activity.jsonl` (5 000 lines cap, trimmed
to 4 000) — no database, no TSDB. Events come from three real sources:

- **watched** — the 30 s Docker state watcher diffs the inventory (appeared/disappeared, state
  changes, restart-loop transitions, health flips);
- **provider transitions** — a provider becoming unavailable/recovered;
- **config writes** — overlay/layout/settings changes the user made.

Every event has a stable id and a *signature*; identical repeats inside the dedupe window fold
into the original event rather than spamming the feed. Bursts of ≥3 same-type Docker events within
120 s fold into one grouped item (`"Stack restarted — 5 containers changed state"`) with the
underlying events still reachable.

**Honesty markers.** `watchingSince` is returned with activity and service history: a page can
distinguish *no data yet* from *nothing happened since OpusHub started watching*, and it says so
in words. Nothing is backfilled.

The service detail page renders the same witnessed events as a compact state strip — every segment
is a real state transition; gaps are drawn as *unknown*, never as uptime.

## Provider health

`GET /api/providers` reports Docker, System, News, Weather and Markets as
`available` / `degraded` / `unavailable` / `idle` with the last successful read and, behind a
disclosure, the reason. The Hub's attention widget surfaces unavailable/degraded providers next to
unhealthy containers; Settings → System shows the same doc as a table. States change only on real
probe transitions (logged to the activity feed), never on a guess.

## What Phase 3 deliberately did not add

restart/stop/start buttons · compose deploy · exec/shell/terminal · image pull/update · secrets or
env-var display · filesystem browsing · arbitrary Engine-API proxying · per-app routes · a
database · global stats/log polling · auth/RBAC. If one of these is wanted, it belongs to the
future control plane, not to this observer.
