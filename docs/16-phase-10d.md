# Phase 10D — Docker Control Plane, Stack Management & Service Catalog

> Status: in progress. Part 1 (this section) is the pre-implementation audit. Part 2 (appended
> at the end of the phase) is the final report.

---

## Part 1 — Repository audit (before any code change)

### A. Architecture inventory

| Concern | Where it lives today | Notes |
|---|---|---|
| Operation framework | `server/operations/{registry,engine,policy,targets,confirmation,locks,permissions,model,store,audit}.js` | Frozen registry of 3 actions; one `evaluate()` used by dry-run and execute; static `dispatch()` switch; server-bound single-use confirmation tokens; per-container TTL locks + per-session rate limit + failure back-off; append-only audit trail |
| Operations HTTP surface | `server/operationsApi.js` mounted in `server/api.js` behind session + CSRF | Body is `{action, target, operationId?, confirmationToken?}`; nothing else is read |
| Docker read provider | `server/providers/docker.js` | GET-only by mechanical proof (`phase7-proof`); safe projections (env/entrypoint stripped) |
| Docker lifecycle adapter | `server/providers/dockerOperations.js` | `OP_PATHS = {start, stop, restart}`; single POST method; no query, no body |
| Phase 10C recreate adapter | `server/updates/recreateAdapter.js` | 8 frozen engine calls (pull, inspect, stop?t, rename, create, network connect, start, delete?v=0); module-private transport |
| Phase 10C recreate engine | `server/updates/engine.js` (`executeUpdate`) | Stop→rename→create→connect→start→verify→delete with rollback ladder; persistent `transactions.json`; Autoheal suppression window (`markContainerUpdating`) |
| Config preservation | `server/updates/preserveConfig.js` (`buildReplacementConfig`) | Allow-listed create body from inspect |
| Eligibility | `server/updates/eligibility.js` | Self-container, autoheal, opt-out labels, host PID/IPC refused |
| Stack discovery | `server/discovery.js`, `server/providers/docker.js#groupByProject`, `server/model.js#getStacksDoc/enrichStackMembers` | Docker compose labels are canonical; `stacks.yaml` is a presentation overlay only |
| Persistence | `server/configStore.js` (CONFIG_DIR yaml/json, DATA_DIR), `server/lib/atomicFile.js` (atomic + mode), per-domain stores (`updates/store.js`, `monitoring/store.js`, `notifications/store.js`) | Secrets: Telegram token in DATA_DIR at 0600, masked on read |
| Event bus | `server/events/{bus,model,store,index}.js` — `publishEventSafe()` | `PUBLIC_EVENT_TYPES` allow-list; forbidden payload keys (env, token…) |
| Activity | `server/activity.js#logEvent` | Signature-based dedupe; categories |
| Notifications | `server/notifications/{policy,center,providers/*}` | Subscribes to the bus; one policy for every channel |
| Registry / image code | Only `docker.imageInfo()` (local engine) and `recreateAdapter.pullImage()`; Diun webhook intake (`updates/diun.js`) | **No remote registry client exists** |
| Reverse-proxy | `server/urlResolver.js`, `providers/dockerLabels.js#parseTraefik`, `monitoring/discovery.js` (`source.kind: 'reverse-proxy'`) | Traefik labels are *read*; there is no provider abstraction that *generates* configuration |
| Monitoring | `server/monitoring/*`; `suggestMonitors(inv)` derives suggestions from inventory | Monitors are created via `/api/monitoring/monitors` with a service reference |
| Autoheal | `server/autoheal/observer.js` | Opt-in via `autoheal=true` label; OpusHub observes only |
| Update engine | `server/updates/*` | Diun advisory; Update Now validates independently by pulling |
| Authorization | `server/operations/permissions.js` | Roles → permission strings; role resolved server-side from the session username |
| Address policy / SSRF | `server/lib/ipPolicy.js`, `server/monitoring/net.js` (`resolveHost`, `pinnedLookup`, `validateRedirect`) | Reusable for registry endpoint validation |
| Security proofs | `server/phase8-proof.test.js`, `server/phase9-security.test.js`, `test/phase6-migration.test.js`, `server/phase7-proof.test.js`, `test/source-scan.js` | Enumerate: registry size, adapter endpoint table, no child_process, no dynamic dispatch, socket-opening modules, non-GET routes in api.js, browser bundle contents |
| Mock engine | `test/mock-engine.js` | Serves the endpoints the code uses; anything else 404s — tests count wire calls |
| UI | `src/lib/operations.ts`, `src/components/Operations.tsx` (single confirmation dialog), `ServiceActions.tsx`, `StackDetail.tsx`, `Stacks.tsx`, `settings/Operations.tsx` | One `opushub:operation` event → one dialog |

### B. Reusable primitives (will be reused, not duplicated)

1. `operations/confirmation.js` — token minting/spending. Extended only by binding the **plan hash** into `targetKey`, so what was confirmed is what executes.
2. `operations/locks.js` — `acquire/release/holder` keyed by an arbitrary string. Stack operations lock `stack:<id>` **and** every member container id; container operations check the stack lock of their project. This is how `update + recreate`, `stack deploy + container update`, `autoheal + manual recreate` are excluded.
3. `operations/policy.js#evaluate` — the single evaluation; extended with `targetType` dispatch and a `params` check.
4. `operations/engine.js` — request/execute/settle/verify/activity/event plumbing; extended with params + transactional runners in the same static switch.
5. `operations/targets.js` — container resolution + `revalidateTarget`.
6. `updates/recreateAdapter.js` — the one module already allowed to open a mutating engine client with bodies. Becomes the **control adapter** with a frozen, enumerated endpoint table (kept in the same file so the existing proof exemptions keep naming exactly one such module).
7. `updates/preserveConfig.js` — the allow-listed create-body builder. The container editor's canonical spec ↔ create body mapping builds on the same allow-list.
8. `updates/transaction.js` — persistent transaction store + Autoheal suppression window. Reused by container recreate, stack deploy and catalog install.
9. `updates/eligibility.js` — self/autoheal/opt-out/host-namespace refusals, reused for recreate/remove/edit.
10. `events/index.js#publishEventSafe`, `activity.js#logEvent`, notification policy — untouched; new event types are added to the allow-list only.
11. `lib/ipPolicy.js` + `monitoring/net.js#resolveHost/pinnedLookup` — registry endpoint SSRF protection.
12. `lib/atomicFile.js#writeJsonAtomic(mode 0o600)` — credential file.
13. `urlResolver.js#pickRouter/urlFromRouter` + `dockerLabels.js#parseTraefik` — read side of the proxy provider; the write side is new.
14. `docker.js` read projections + `mock-engine.js` for tests.

### C. New 10D modules required

```
server/operations/params.js            per-action parameter schemas (allow-list) + canonical hash
server/containers/spec.js              canonical editable container spec ⇄ inspect ⇄ create body (allow-list)
server/containers/diff.js              CURRENT / NEW / CHANGES diff
server/containers/recreate.js          generic recreate transaction (extracted from updates/engine.js, reused by it)
server/containers/runners.js           transactional runners: create, recreate, remove, rename, duplicate, edit, network attach/detach, pull
server/containersApi.js                read routes: inspect/config/logs/stats/processes/health/mounts + edit plan
server/stacks/compose.js               YAML → canonical stack model (explicit supported subset)
server/stacks/policy.js                SAFE / WARNING / DANGEROUS / BLOCKED classifier
server/stacks/store.js                 managed stacks + deployment history (DATA_DIR/stacks)
server/stacks/planner.js               current-state discovery → deployment plan + diff
server/stacks/deployer.js              controlled deployment via the control adapter, rollback, verification
server/stacks/targets.js               stack target resolution (managed + discovered)
server/stacksApi.js                    the /api/v1/stacks routes
server/registries/crypto.js            AES-256-GCM at rest, key file 0600 in DATA_DIR (or OPUSHUB_SECRET_KEY)
server/registries/store.js             registry definitions, masked projection
server/registries/client.js            OCI distribution client: ping, token auth, catalog, tags, manifest, digest
server/registries/endpoint.js          endpoint validation + SSRF policy
server/registriesApi.js                /api/v1/registries routes
server/catalog/manifests.json          data-driven service manifests
server/catalog/schema.js               manifest validation (no code, no hooks)
server/catalog/template.js             safe ${var} substitution only
server/catalog/planner.js              manifest + user config → canonical container spec / install plan
server/catalog/installer.js            install transaction with rollback
server/proxy/provider.js               reverse-proxy provider abstraction (+ providers/traefik.js label generator)
server/catalogApi.js                   /api/v1/catalog routes
```

UI: `src/lib/operations.ts` (params + plan types), `Operations.tsx` (plan/diff rendering), `src/components/ContainerEditor.tsx`, `src/pages/ContainerEdit.tsx`, container action menu extension, `src/pages/StackEditor.tsx` + Stacks/StackDetail additions, `src/pages/settings/Registries.tsx`, `src/pages/Catalog.tsx`, `src/pages/CatalogInstall.tsx`, routes + nav entry.

### D. Security risks and decisions

| # | Risk | Decision |
|---|---|---|
| D1 | **Compose deployment mechanism.** The codebase forbids `child_process` (proof) and the phase forbids compose CLI. | Stacks are deployed **natively through the Engine API** (networks → volumes → containers with `com.docker.compose.*` labels). Only an explicit Compose subset is supported; anything else is `BLOCKED` with the key named. Discovered stacks deployed by external tooling can be started/stopped (member lifecycle) but not deployed/removed by OpusHub unless OpusHub holds their YAML (managed). |
| D2 | A container editor that accepts a free-form create body is a Docker proxy. | The browser submits a **canonical spec** (allow-listed fields). The server builds the create body; unknown keys are rejected, not ignored. Privileged / host namespaces / Docker socket / sensitive host paths / dangerous caps run through the same policy classifier as Compose. |
| D3 | Confirmation token replay with different parameters. | `targetKey` = `<type>:<id>:<sha256(canonical params)>`. The plan the user saw is the plan that runs. |
| D4 | Conflicting transactions. | Locks on container id **and** `stack:<project>`; the update engine, autoheal suppression and recreate share `transaction.js`. |
| D5 | Registry credentials. | Server-side only; AES-256-GCM with a 0600 key file; masked in every GET; never logged or published; `Authorization` never in events (forbidden-key filter already exists). |
| D6 | SSRF through registry endpoints. | HTTPS only (HTTP allowed only for explicitly `insecure: true` **private** RFC1918 endpoints), hostname resolved and every address checked against `ipPolicy` (loopback/link-local/metadata refused), pinned lookup, no redirects off-host, bounded body, fixed path grammar (`/v2/`, `/v2/_catalog`, `/v2/<name>/tags/list`, `/v2/<name>/manifests/<ref>`). No generic proxy route. |
| D7 | Catalog manifests executing code. | JSON data validated by schema; the only templating is `${var}` substitution over declared variables; no hooks, no commands beyond the image's own `command`/`entrypoint` fields (which are data passed to Docker, not executed by OpusHub). |
| D8 | Existing proofs assert "exactly three". | Proofs are **updated to the new frozen sets** — the property (enumerated, frozen, static dispatch, no generic helper, no child_process, no browser-supplied endpoint) is preserved and re-asserted. |
| D9 | Removing OpusHub itself / recovery infra. | `eligibility.js` refusals apply to remove, recreate, edit, kill. |
| D10 | Force remove with volumes. | `v=1` is never sent. Anonymous volumes are preserved; named volume removal is not a 10D operation. |
| D11 | Traefik coupling. | `proxy/provider.js` exposes `activeProvider().labelsFor(spec)`; Traefik is one provider; the canonical spec carries `expose: {domain, https, port}` only. |
| D12 | Event payload leakage (env, binds). | Diffs are returned by the API to the authenticated operator; **events** carry only field *names* that changed, never values. |

### E. API plan

Mutations — **all** through the existing operations door, `POST /api/v1/operations/dry-run` and `POST /api/v1/operations` with `{action, target, params?}`:

| Action | Target | Params | Executor |
|---|---|---|---|
| `container.start/stop/restart` | container | — | lifecycle (existing) |
| `container.pause/unpause/kill` | container | — | lifecycle |
| `container.rename` | container | `{name}` | control |
| `container.remove` | container | `{force?}` | control |
| `container.pull_image` | container | — | control (pulls the container's own image) |
| `container.network_attach/detach` | container | `{network, aliases?}` | control |
| `container.update` | container | in-place fields (restart policy, resources) | control (`/update`) |
| `container.recreate` | container | — (same config, fresh container) | transaction |
| `container.edit` | container | canonical spec patch | transaction (in-place if possible, else recreate) |
| `container.change_image` | container | `{image}` | transaction |
| `container.duplicate` | container | `{name, overrides?}` | transaction |
| `container.create` | none (`{type:'new'}`) | canonical spec | transaction |
| `stack.create/update` | managed stack | `{compose, env}` | store |
| `stack.deploy/redeploy/start/stop/remove` | stack | — | transaction |
| `image.pull` | image | `{image, registryId?}` | control |
| `service.install` | catalog manifest | install config | transaction |

Reads / plans (GET or plan-only POSTs, no mutation):

```
GET  /api/v1/containers/:id                (inspect, safe projection incl. editable spec)
GET  /api/v1/containers/:id/logs|stats|processes|health|mounts
POST /api/v1/containers/:id/plan           (spec patch → diff, no side effects)
POST /api/v1/stacks           GET /api/v1/stacks           GET /api/v1/stacks/:id
PATCH /api/v1/stacks/:id      POST /api/v1/stacks/:id/validate   POST /api/v1/stacks/:id/plan
POST /api/v1/stacks/:id/deploy|start|stop|remove   → run through the operations engine (dry-run + confirm)
GET  /api/v1/stacks/:id/history
GET/POST /api/v1/registries   GET/PATCH/DELETE /api/v1/registries/:id
POST /api/v1/registries/:id/test   GET /api/v1/registries/:id/repositories?q=
GET  /api/v1/registries/:id/tags?repository=   GET /api/v1/registries/:id/manifest?repository=&reference=
GET  /api/v1/catalog   GET /api/v1/catalog/:id   POST /api/v1/catalog/:id/plan
```

The stack action POSTs are thin: they call the operations engine with `stack.<verb>` and return the same dry-run/confirmation shape, so there is one confirmation flow.

### F. UI plan

- Service detail: action menu gains pause/unpause/kill/rename/recreate/remove/duplicate/pull; "Edit container" opens the editor.
- Container editor (`/services/:group/:name/edit`): allow-listed sections, live diff panel from `/plan`, apply → operations dialog with the diff embedded.
- Operations dialog: renders `plan` (steps, diff, policy findings) when the dry-run returns one; DANGEROUS findings require the strong acknowledgement.
- Stacks: "New stack" → YAML editor with validate/plan/deploy; managed stack detail gets deploy history, config, env, policy findings.
- Settings → Registries: list/add/test/edit/delete; secrets write-only.
- Catalog (`/catalog`): grid from manifests; install wizard (version → storage → network/ports → env → domain/https → restart/health → review) → operations dialog.

### G. Migration / persistence plan

- `DATA_DIR/stacks/stacks.json` (managed stack definitions), `DATA_DIR/stacks/history.json` (deployments), `DATA_DIR/registries/registries.json` (encrypted secrets, 0600), `DATA_DIR/registries/key` (0600), `DATA_DIR/updates/transactions.json` (existing; new `kind` field).
- Nothing new in CONFIG_DIR presentation files; export/import scope unchanged.
- No migration of existing data; all new files are created on first write.

### H. Test plan

New: `server/phase10d-containers.test.js`, `phase10d-stacks.test.js`, `phase10d-registries.test.js`, `phase10d-catalog.test.js`, `phase10d-proof.test.js` (updated frozen sets, no exec, no dynamic dispatch, no generic proxy, browser bundle). Updated: `phase8-proof`, `phase9-security`, `phase6-migration` frozen lists; `mock-engine.js` gains pause/unpause/kill/update/top/networks/volumes/disconnect/images routes (and a registry mock for the client tests). Regression: `npm test`, `npm run test:web`, `npm run verify`, `npm run typecheck`, `npm run build`, `git diff --check`, `node test/source-scan.js`.

**No unresolved architectural question blocks implementation.** D1 (native Engine-API compose subset) is the one consequential design choice; it is the only option consistent with the standing "no shell / no compose CLI" invariant and is recorded as a limitation (Compose features outside the subset are refused explicitly).

## Part 2 — Implementation notes

### 10D-C Registries (implemented)

Modules: `server/registries/{crypto,endpoint,store,client,auth}.js`, `server/registriesApi.js` (mounted in `api.js`, listed in the `/api/v1` route allowlist as `/registries`).

- **Secrets.** AES-256-GCM, key from `OPUSHUB_SECRET_KEY` (hex/base64, ≥32 bytes, hashed) or an auto-generated `DATA_DIR/registries/key` (0600). Ciphertext is bound to the registry id (AAD), so a sealed value cannot be moved between entries. `registries.json` is 0600; the public projection (`store.publicRegistry`) exposes only `hasSecret` and a length hint — no route, event, activity line or operation result can contain the secret. PATCH with `secret` undefined keeps the stored one; `''`/`null` clears it.
- **Endpoints (SSRF).** An endpoint is an *origin* only: `https://host[:port]`; path/query/fragment/credentials refused; `http://` only when the registry is flagged `insecure` **and** every resolved address is in the internal (private) scope; loopback, link-local/metadata, unspecified and multicast are refused for every scheme. Resolution uses the same pinned `monitoring/net.js` resolver as monitoring; the pinned address is what the request is sent to. `dockerhub`/`ghcr` kinds are pinned to their canonical hosts.
- **Client.** GET-only, five fixed request shapes (`/v2/`, `/v2/_catalog`, `/v2/<repo>/tags/list`, `/v2/<repo>/manifests/<ref>` with `HEAD`-free GET, Bearer realm) built from grammar-checked repository/tag/digest strings; response size capped; redirects re-validated and credentials dropped on any origin change; Bearer realm must be `https` and pass the same host policy; catalog refused for Docker Hub and GHCR (no such API). The transport is injectable for tests. There is deliberately **no** pull route here and **no** generic proxy — pulls remain the confirmed `image.pull` / `container.pull_image` operations, which call `registries/auth.js → authHeaderFor(image, registryId?)`; a credential is attached only when the image's registry host matches the stored registry (an explicit `registryId` whose host does not match the image is ignored → anonymous pull).
- **API.** `GET/POST /api/v1/registries`, `GET/PATCH/DELETE /:id`, `POST /:id/test`, `GET /:id/repositories?q=`, `GET /:id/tags?repository=`, `GET /:id/manifest?repository=&reference=`. Writes and `test` need `operations.registry.manage` (administrator); reads are masked for everyone. Creating/updating a registry makes no remote request; only `test`/`repositories`/`tags`/`manifest` do.
- **Tests.** `server/phase10d-registries.test.js` (crypto roundtrip/AAD/tamper/key-file mode; endpoint grammar and address policy; store masking and on-disk encryption; Bearer + Basic flows, https-only realm, no credential forwarding across redirect origins, catalog refusal, grammar refusal before any request; API authz/CRUD/409/400 refusals; source discipline). `phase10d-containers.test.js` adds an `image.pull` integration test proving `x-registry-auth` is sent only for a matching host and never appears in operations, dry-runs or events.
- **Deferred to the 10D-D/UI pass:** the Settings → Registries page (the API is complete; UI is a thin client of it).
