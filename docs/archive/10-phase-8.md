# OpusHub — Phase 8: a narrow Operations Engine

Status: implemented on `arena/01a0a529-opushub`. Builds on Phases 1–7 without rewriting
them: the same inventory model, the same design system, the same tests-still-green rule,
and — the one that matters most — **the read-only Docker client stays read-only**.

The one-line summary: OpusHub can now **start, restart and stop a container it already
shows you**, and it can do nothing else. Every operation is a named server-side action,
authorized against the session, resolved from the canonical inventory, confirmed with a
token the server minted, executed through a three-endpoint adapter, verified against the
engine's own answer afterwards, and written to an append-only audit trail.

## Why it is this narrow

Anything OpusHub can do to Docker, an attacker who reaches OpusHub can do to Docker.
The container runtime is the host: a mounted `/var/run/docker.sock` is one network hop
from root. So the question for this phase was never "what would be useful" — it was
"what is the smallest set of capabilities that makes a dashboard feel finished, and how
do we make each one impossible to widen from the browser".

Three actions is the answer to the first part. The second part is the whole rest of this
document, and it reduces to one rule:

> The browser may name an action and reference a target. It may not name an endpoint,
> a method, a command, a container id used as an endpoint, or a promise that it is
> allowed to. Nothing in the server reads any of those, because no field exists for
> them.

That rule is enforced in code and asserted by tests (see **Proofs** below), not promised
in a comment.

## The lifecycle of one operation

```
request → authorization → target resolution → policy → confirmation → execution
        → verification → activity → final result
```

| Stage | Where | What it decides | What it refuses with |
|---|---|---|---|
| request | `operationsApi.js` | the body is a JSON object of at most 8 fields | `bad_request` |
| authorization | `permissions.js` | the session's role carries `operations.container.<verb>` | `not_permitted` (403) |
| target | `targets.js` | the reference resolves to exactly one container OpusHub can see *now* | `unknown_target` (404), `ambiguous_target` (404), `stale_target` (409) |
| policy | `policy.js` | permission + target + engine reachable + no back-off + no lock | `docker_unavailable` (503), `locked`, `rate_limited` (429) |
| confirmation | `confirmation.js` | a single-use token bound to actor, session, action, target, operation id | `confirmation_required`, `confirmation_expired`, `confirmation_mismatch` |
| execution | `engine.js` → `dockerOperations.js` | one of three frozen endpoints, bounded by a timeout | `docker_error`, `timeout` |
| verification | `engine.js` | the container's real state, read back from the engine | `failed` / `timed_out` |
| activity | `activity.js` | one event per completed operation, with the reason when it went wrong | — |
| result | `store.js` / `audit.js` | the record the UI renders, and the trail behind it | — |

The dry-run (`POST /api/v1/operations/dry-run`) walks **the same path** up to and
including confirmation, and then stops. It cannot execute. Anything that would be
refused at execution time is refused at evaluation time, because it is the same code.

## 1. The operation model

One record per requested operation, whatever happens to it. Rejections and successes
have the same shape, so there is no code path where something happens without a record.

```
id           op-20260916-a3fk9zq        display-safe, unguessable, not a container name
action       container.restart          one of three frozen ids
target       { type, id, service, containerName, label, group, stack, state }
actor        the session's username      never the token, never the cookie
sessionId    the session *handle*        enough to correlate, not enough to impersonate
status       pending → awaiting_confirmation → authorized → running
             → succeeded | failed | rejected | cancelled | timed_out
result       { state, health, unchanged }   measured after the call, never assumed
error        { code, reason, detail }       structured, and shown to the operator verbatim
verification { state, health, startedAt, verified, note }
confirmation { required, mode, consumed }
auditId      the id of the first audit record
```

`timed_out` is its own status and the UI says so in words: *"the outcome was not proven"*.
A `204` from Docker means "the request was accepted", not "the container stopped". Phase 8
never reports the first as the second.

## 2. The action registry (server-side, frozen)

`server/operations/registry.js` — three entries, `Object.freeze`d, each carrying its own
permission, risk, confirmation strength, execution timeout, verification window, expected
end state, and the name of the adapter method the engine's static switch may call:

| action | permission | risk | confirmation | timeout | verify | expects |
|---|---|---|---|---|---|---|
| `container.start` | `operations.container.start` | low | normal | 10s | 15s | `running` |
| `container.restart` | `operations.container.restart` | medium | normal | 25s | 20s | `running` |
| `container.stop` | `operations.container.stop` | high | strong | 15s | 15s | `exited` |

There is no way to add a fourth at runtime, and no way to reach a Docker endpoint that
is not one of the three the adapter declares. A request naming anything else is refused
*and audited* — "someone asked for an operation that does not exist" is exactly what an
operations trail should be able to answer.

Timeouts are overridable per install (`OPUSHUB_OP_START_TIMEOUT_MS`,
`OPUSHUB_OP_RESTART_TIMEOUT_MS`, `OPUSHUB_OP_STOP_TIMEOUT_MS`, `OPUSHUB_OP_VERIFY_MS`),
and clamped to sane bounds so a typo cannot make an operation hang forever.

## 3. Targets are resolved, never taken

The client sends a *reference*: `{ type: 'service', id: 'jellyfin', group: 'Media' }`.
The server resolves it against the canonical inventory — the same document the Hub,
Services and Stacks pages render — and re-reads the engine immediately before writing.

- Resolution is by service name, container name, or inventory-known container id.
- A raw container id that is *not* in the inventory is not a target. Docker ids are not
  an addressing scheme in this API; they are data OpusHub happens to hold.
- An ambiguous name is a refusal, not a guess.
- The container is re-looked-up just before the write: if it was replaced in between, the
  operation is refused (`stale_target`) rather than applied to whatever is there now.
- `self` (the OpusHub container) is detected, named in the confirmation, and — for a
  strong confirmation — requires an explicit acknowledgement before the button enables.

## 4. Permissions

`server/operations/permissions.js` — the engine asks `can(actor, permission)` and never
asks "is this the admin?".

| role | operations |
|---|---|
| `administrator` | all three (the only role in use today) |
| `operator` | start + restart — declared and tested, unused until accounts exist |
| `viewer` | none |

An unknown username resolves to `viewer` — fail closed. The role comes from the
authenticated session, server-side; there is no field in any request that can declare one.

Permission is re-checked on **every** request, including the one that spends a
confirmation. Hiding a button in the browser changes nothing about what the server allows.

## 5. Confirmation: a token, not a flag

A `confirmed: true` boolean in the body means literally nothing — it is ignored. What
authorizes an execution is a token the server minted *after* the evaluation passed:

- bound to the actor, the session, the operation id, the action and the resolved target;
- single-use, and remembered until it expires, so a replay answers "already used"
  instead of merely "not valid";
- short-lived (2 minutes), with the expiry shown in the API response;
- retired if the operator walks away — dismissing the dialog cancels the operation.

Spending a token for a different action, a different target, a different session, or
after it expired is refused, and the refusal is audited.

`normal` confirmations ask once. `strong` confirmations (stop) additionally require a
typed acknowledgement in the dialog before the confirm button enables, and the dialog
names what will happen next ("it stays stopped until you start it again").

## 6. Bounded execution, honest failure

- **One operation per container** at a time (`locks.js`): start and stop cannot race.
  Locks carry a TTL (120s), so a crashed process releases them instead of leaving a
  permanent "in progress".
- **Rate limited** per session: 12 operations per 30s window; the refusal is `429` with
  a retry-after, and nothing is executed while throttled.
- **Back-off** after three consecutive failures on one target (30s) — a container that
  keeps failing is not hammered.
- **Verification** re-reads the container and compares against the registry's expected
  state. `unchanged: true` is reported honestly ("it was already in that state").
- **Timeouts** produce `timed_out`, with the state that was actually observed at the
  deadline — never a success.
- **Nothing is queued.** There is no retry-later, no deferred execution, no background
  scheduler. Docker unavailable ⇒ the operation is rejected now (`503`) and the UI says
  so. An operation that was interrupted by a restart is recovered at boot as
  *unknown outcome*, explicitly, rather than left "running" forever.
- **Daemon errors** are reported with their own class (`docker_error`) and the reason.
  Docker's response body never reaches the browser — it can contain paths and
  configuration that are none of its business.

## 7. Audit

`data/operations.jsonl` — one append-only record per phase (`requested`, `authorization`,
`target`, `policy`, `confirmation`, `execution`, `verification`, `completed`, plus
`rejected` / `cancelled` / `interrupted`).

- Built from an **allow-list** of fields, so a new field on the operation object cannot
  start leaking by accident.
- Never contains: passwords or hashes, session tokens, cookies, CSRF or confirmation
  tokens, environment variables, socket paths, request headers or bodies, or Docker
  response bodies. (Asserted by test, not by intention.)
- Bounded: 2,000 records / 2 MB, trimmed to the newest 1,500. Trimming drops the oldest
  lines; it never rewrites them.
- **No delete**, and no API route that would allow one. There is no client-side deletion
  of history and no way to ask for it.

## 8. Activity integration

Every completed operation produces one Activity event:

| outcome | type | severity |
|---|---|---|
| succeeded | `operation.succeeded` | notice |
| failed | `operation.failed` | warning |
| timed out | `operation.timeout` | warning |
| refused | `operation.rejected` | warning |
| cancelled | `operation.cancelled` | info |

They read as sentences ("restarted wave", "wave: the container is locked by another
operation") and `Operations` is selectable in the Activity type filter. Alerts still
never trigger operations — see the next section.

## 9. The HTTP surface

Every route below is behind the existing session gate and, for POSTs, the existing CSRF
gate. `server/operationsApi.js` deliberately contains no authentication logic of its own:
there is one door, and it is already guarded.

```
GET    /api/v1/operations                     overview: actor, permitted actions, engine
                                              availability, counts, recent/running/failed
GET    /api/v1/operations?service=<name>      the same, narrowed to one service (server-side)
GET    /api/v1/operations/:id                 one operation (polled while it runs)
GET    /api/v1/operations/:id/trail           the audit trail of one operation
POST   /api/v1/operations/:id/cancel          retire an unspent confirmation
POST   /api/v1/operations/dry-run             evaluate; never execute
POST   /api/v1/operations                     execute with a confirmation token
```

What the client may send, in full:

```json
{ "action": "container.restart", "target": { "type": "service", "id": "jellyfin", "group": "Media" } }
```

and to execute, plus:

```json
{ "confirmationToken": "…", "operationId": "op-20260916-a3fk9zq" }
```

Eight fields maximum; anything extra is ignored rather than interpreted, and never
forwarded.

## 10. The write architecture (why the socket stays `:ro`)

This is the decision the brief asked to be argued rather than assumed.

The starting point: OpusHub mounts `/var/run/docker.sock` — **read-only** — and Phase 7's
client (`server/providers/docker.js`) issues `http.get` exclusively. A `:ro` bind mount of
a unix socket is **not** a write barrier: the read-only bit applies to the file node, not
to the Engine API behind it. A process that can open the socket can `POST /containers/x/stop`
whether the mount says `ro` or `rw`. So the options were about where the *boundary* lives.

### A. Make the socket writable (`:rw`)

Mount `:/var/run/docker.sock:rw` and call the lifecycle endpoints directly.

- *For*: no new moving parts; one client; the smallest diff.
- *Against*: it makes the whole Engine API reachable in principle, so the entire safety
  argument rests on nothing but discipline in one file. It also *looks* like a
  downgrade to anyone auditing the compose file — "the dashboard just asked for write
  access to Docker" is a true sentence about the deployment, whatever the code does.
  Rejected: the boundary would be a convention, not a mechanism.

### B. A dedicated operations sidecar

A second container (a socket proxy) that owns the `rw` socket and exposes only
`POST /containers/{id}/{start,stop,restart}` to OpusHub over an authenticated internal
channel.

- *For*: the boundary is enforced by a separate process with its own attack surface; the
  rule "OpusHub never sees a writable socket" stays literally true; a proxy can log and
  rate-limit independently; it can be swapped for a policy engine (SocketGuard-style
  allow-lists) without touching OpusHub.
- *Against*: a second service is a second thing to secure, update, monitor and trust. It
  needs its own image, its own config, its own failure mode (and its failure mode is
  "every operation fails", which is safe but noisy). It moves the allow-list out of
  version control and into deployment, where it is easier to widen by accident and
  harder to test. And it can be *bypassed by misconfiguration* — one wrong network or
  an unauthenticated listener and the "boundary" is decorative.

### C. A separate constrained write channel inside OpusHub

Keep the compose mount at `:ro`. Add a second provider
(`server/providers/dockerOperations.js`) whose only reachable endpoints are the three
frozen ones, selected by a **static switch** keyed on the registry's `adapter` field.
The adapter exposes no generic request helper at all — a caller cannot supply a path, a
method, a query string or a body. Container ids are validated as 12/64 hex before they
are interpolated, and error bodies are logged server-side and never returned.

- *For*: the allow-list lives in code, is frozen, version-controlled and covered by the
  same test suite as everything else. There is no second process to secure or update.
  Failure mode is local and legible. It composes **with** B: an operator who wants the
  separation enforced outside OpusHub can point this channel at a different socket.

### Decision: **C**, with B available as an operator's choice

The compose mount stays `:ro`. The write channel defaults to the same endpoint discovery
already uses, and honours an optional `OPUSHUB_OPERATIONS_SOCKET` for operators who want
a dedicated socket — including one fronted by their own filtering proxy. That way the
strongest option (B) is a deployment decision an operator can make, not an architecture
every install is forced to carry, and the code-level allow-list (C) is in force either
way. A test asserts that the adapter reaches exactly three endpoints and exposes no
generic request helper, so if anyone adds a fourth, the suite fails.

## 11. What Phase 8 deliberately does not do

Stated here so it does not get "fixed" later by someone who did not read this far:

- **No shell or command execution.** There is no code path that runs a command you
  supply, and the audit's static proof refuses to compile if one appears.
- **No `docker exec`,** no file read or write, no Compose execution, no image pull, no
  volume, network or log management, no container creation or removal.
- **No Docker API passthrough.** The client names an action. It cannot name an endpoint,
  an HTTP method, a query string or a body — those are not fields in the request.
- **No browser access to the socket,** directly or by proxy. Every operation is an
  authenticated, audited API call.
- **No generic container ids as targets.** Ids are accepted only when the canonical
  inventory already holds them.
- **No automatic remediation.** Alerts never trigger operations; nothing restarts on a
  schedule; there is no "if unhealthy then restart" anywhere in the codebase.
- **No bulk operations.** No restart-stack, no restart-all, no group action. One
  container at a time, and the UI says so.
- **No queued or deferred execution.** An operation runs now or is refused now.
- **No agent or AI access.** No OpenRouter, no OpenHands, no MCP, no API key of its own.
  The engine's only caller is an authenticated browser session.
- **No weaker authentication.** Phase 6's session, CSRF and first-run wizard are
  untouched; the operations routes simply sit behind them.

## 12. The UI

Quiet on purpose. An operation changes the state of something real, so the interface
around it is text, state and one emphasised confirm — never a wall of buttons, and no
giant red button.

| Surface | What it offers |
|---|---|
| **Service Detail** | an Operations section: three controls (Start / Restart / Stop), a sentence about what pressing one does, and this service's own recent operations, filtered server-side |
| **Services list** | operations behind a per-row menu, after Open and Details |
| **Stack Detail** | per-container menus, labelled "one at a time, never in bulk" |
| **Hub** | operations in the launcher menu, after navigation, filtered by the container's observed state |
| **Command palette** | operations as *destinations* — selecting one opens the confirmation, it never runs anything. Offered only for containers whose state permits the action, and only to an account that may run it |
| **Settings → Operations** | informational: engine status, this account's permissions, the three registered actions with their risk and timeouts, recent operations, the guarantees, and the list of what it will not do. No toggles — none of this is configurable from a browser |
| **Activity** | every operation, as a sentence, filterable by type |

Controls are disabled with a reason in the tooltip and hidden entirely when the session
holds no operation permissions. A viewer's Service Detail says the account is not allowed
rather than showing dead buttons.

The confirmation dialog shows the server's own dry-run — the same checks execution will
repeat — before it offers to run anything. Reduced motion turns off the only animation in
it (the spinner); nothing about the state is carried by movement.

## 13. Proofs and tests

`server/phase8-proof.test.js` — 20 static security proofs. The load-bearing ones:

- the registry is exactly three actions, and **no other server file declares an
  operation action** (event names like `container.started` are not capabilities);
- the operations adapter reaches exactly three endpoints and **exposes no generic
  request helper**;
- the read-only Docker client still issues no writes;
- no module outside the providers references the socket path or `DOCKER_HOST`;
- there is no shell/exec surface, no `confirmed` fast-path, no endpoint built from client
  input, and no automation hook that triggers an operation from an alert or a timer.

`server/phase8-operations.test.js` — 47 behavioural tests against the mock engine, whose
wire log is asserted so "nothing else was asked of Docker" is a fact rather than a hope:
unknown actions, unknown/ambiguous/stale targets, unauthenticated and cross-site
requests, a viewer's refusal, dry-run harmlessness, `confirmed: true` meaning nothing,
token replay / cross-action / cross-target / cross-session / expiry, cancel, the three
happy paths proven by `inspect`, lock expiry, back-off, honest unchanged states, verified
timeouts, Docker unavailable (rejected, not queued), daemon errors without their payload,
rate limiting, the trail, activity events, and post-operation inventory refresh.

`test/web/tests.tsx` — 6 new DOM checks (49 → 55): pressing a control produces a dry-run
and nothing else; cancelling and refusing both leave the engine alone; execution spends
the token the server issued and sends no `confirmed` flag; a viewer is offered no controls
and is told why; a timeout reads as unproven; the palette opens a confirmation instead of
executing; Settings → Operations reports the engine with no toggle in it.

Suite: `npm test` → **593 passing**. `npm run typecheck`, `npm run build`,
`npm run verify` (62/62) and `npm run test:web` (55/55) are all green.

## 14. Real-host validation — not performed

Everything above was exercised against the mock engine and jsdom. **No real Docker host
was touched as part of this work**, so the following is the checklist to run on one. Do it
on a low-risk container first — a stopped spare, not the database.

```bash
# 0. before anything: the compose mount must still be read-only
grep -n "docker.sock" docker-compose.yml          # expect :ro

# 1. start from a clean checkout of this branch
git fetch origin arena/01a0a529-opushub
git checkout arena/01a0a529-opushub
npm install
npm test && npm run typecheck && npm run build && npm run verify && npm run test:web

# 2. run against the real daemon (the socket stays :ro — see §10)
docker compose up -d --build
docker compose logs -f opushub

# 3. in the browser: sign in, then check the engine is reachable
curl -s -b cookies.txt http://localhost:3000/api/v1/operations | jq '.docker, .actor'
#   expect  docker.operations: true   and   actor.role: "administrator"

# 4. the dry-run must not touch the container — pick something disposable
CID=<a low-risk running container>
curl -s -b cookies.txt -H 'content-type: application/json' \
     -X POST http://localhost:3000/api/v1/operations/dry-run \
     -d '{"action":"container.stop","target":{"type":"service","id":"'"$CID"'"}}' | jq
docker inspect -f '{{.State.Status}}' "$CID"       # unchanged — still running

# 5. spend the token it returned (jq it out of the response above)
TOKEN=<confirmation.token>   OPID=<operation.id>
curl -s -b cookies.txt -H 'content-type: application/json' \
     -X POST http://localhost:3000/api/v1/operations \
     -d '{"action":"container.stop","target":{"type":"service","id":"'"$CID"'"},"confirmationToken":"'"$TOKEN"'","operationId":"'"$OPID"'"}' | jq
docker inspect -f '{{.State.Status}}' "$CID"       # expect: exited

# 6. the same token must not work twice
curl -s -b cookies.txt -H 'content-type: application/json' \
     -X POST http://localhost:3000/api/v1/operations \
     -d '{"action":"container.stop","target":{"type":"service","id":"'"$CID"'"},"confirmationToken":"'"$TOKEN"'","operationId":"'"$OPID"'"}' | jq
#   expect the token to be refused as already used

# 7. the record, the trail, and the activity event
curl -s -b cookies.txt "http://localhost:3000/api/v1/operations/$OPID" | jq
curl -s -b cookies.txt "http://localhost:3000/api/v1/operations/$OPID/trail" | jq
docker compose exec opushub sh -c 'tail -20 /app/data/operations.jsonl'

# 8. the wire, from the daemon's side: nothing but the three endpoints
#    (re-run 4–5 and watch) —
sudo socat -t100 -v UNIX-LISTEN:/tmp/probe.sock,mode=660,reuseaddr,fork \
     UNIX-CONNECT:/var/run/docker.sock 2>&1 | grep -i '^> POST'

# 9. start it again, and confirm the UI followed the real state
#    (Service Detail should read Running without a reload)
```

Optional, for operators who want the write channel separated outside OpusHub (§10,
option B): point `OPUSHUB_OPERATIONS_SOCKET` at a filtering socket proxy that exposes only
lifecycle endpoints, and repeat 3–8 — the overview should report
`docker.channel: "dedicated"`.

## 15. Files

| File | Role |
|---|---|
| `server/operations/registry.js` | the three actions, frozen |
| `server/operations/permissions.js` | roles → `operations.container.*` |
| `server/operations/model.js` | the canonical operation record |
| `server/operations/targets.js` | inventory-based target resolution and revalidation |
| `server/operations/policy.js` | the single evaluation, shared by dry-run and execute |
| `server/operations/confirmation.js` | server-bound, single-use tokens |
| `server/operations/locks.js` | per-container locks, rate limiting, back-off |
| `server/operations/store.js` / `audit.js` | bounded store and append-only trail |
| `server/operations/engine.js` | the lifecycle, end to end |
| `server/operationsApi.js` | the HTTP surface (no auth logic of its own) |
| `server/providers/dockerOperations.js` | the three-endpoint write adapter |
| `src/lib/operations.ts` | the client contract and the capability hook |
| `src/components/Operations.tsx` | the one confirmation flow |
| `src/components/ServiceActions.tsx` | controls, menus, recent operations |
| `src/pages/settings/Operations.tsx` | the informational Settings pane |
| `docs/10-phase-8.md` | this document |

Untouched on purpose: `server/providers/docker.js` (still GET-only), `server/alerts.js`
(still no remediation), `docker-compose.yml` (still `:ro`), and every Phase 1–7 test.
