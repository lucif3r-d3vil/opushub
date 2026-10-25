# OpusHub: product scope

OpusHub is a simple website that replaces exactly five tools on a homelab: **Portainer, Homepage,
Autoheal, Diun and Uptime Kuma**. It is not a control panel and not a platform. Anything that does
not serve one of those five jobs is out.

Principles that stay: **Docker is the source of truth** (config can decorate, never invent) and
**no fake data** (an unavailable source says so; nothing shows a placeholder or a zero).

## Target

| Surface | What it is | Replaces |
|---|---|---|
| **Home** | Containers grouped by stack, a health dot and an update badge on each, a link to open it, and a one-line host strip (CPU, memory, disk, uptime). | Homepage |
| **Containers** | One list with detail: start, stop, restart, recreate, logs, update. Plus "add a compose block" (paste YAML, review, deploy). Per-container toggles for auto-heal and update checking. | Portainer |
| **Uptime** | Monitors (HTTP, TCP, Docker state) and incidents with real durations. | Uptime Kuma |
| **Bell** | One notification stream: updates available, heal events, downtime and recovery. Delivered in-app and to Telegram. The panel also lists recent activity, including the audit record of operations (there is no Activity page). | Diun alerts, Kuma alerts |
| **Settings** | One small page: Telegram, host address, monitoring defaults, account, theme. | n/a |

**Ctrl+K search** stays (jump to a container, stack, monitor or setting).

Login and first-run setup remain, because there is one local admin account.

**No pages** for Autoheal or Diun. They run in the background and are controlled only by the
per-container opt-in toggles and the bell.

Mutations stay confirmation-gated and audited (the existing pipeline), and the socket's `:ro`
mount stays documented as not being a control (see `SECURITY.md`).

## Current to target

Sizes are approximate lines of code, to show the scale of each removal.

### Pages (`src/pages`)

| Page | Verdict | Reason |
|---|---|---|
| `Hub.tsx` | MERGE | Becomes Home. Keep the stack-grouped launcher; drop the widget composition and drag-and-drop. |
| `Services.tsx`, `ServiceDetail.tsx` | MERGE | Become Containers (list and detail). |
| `Stacks.tsx`, `StackDetail.tsx` | MERGE | Stack is a grouping on Home and a filter on Containers, not its own area. |
| `ManagedStack.tsx` | MERGE | Becomes "add a compose block" inside Containers. |
| `Monitoring.tsx`, `MonitorDetail.tsx` | KEEP | Becomes Uptime (rename, trim). |
| `Activity.tsx` | MERGE | Decided: becomes the bell panel's recent-activity list, including the audit record. No page. |
| `System.tsx`, `Host.tsx` | REMOVE | Replaced by the host strip on Home. |
| `Infrastructure.tsx` | REMOVE | ZFS, OPNsense and topology are not one of the five tools. Decided: remove all, no ZFS line on Home. |
| `Files.tsx` | REMOVE | A file explorer replaces none of the five (~5.0k lines with its server side). |
| `Catalog.tsx`, `CatalogInstall.tsx` | REMOVE | "Add a compose block" covers installing. |
| `Icons.tsx` | REMOVE | A picker page. Icon resolution stays; the page does not. |
| `Settings.tsx`, `settings/*` | KEEP | Shrink to one page. `Configuration.tsx` (750 lines) is the bulk. |
| `Login.tsx`, `Setup.tsx`, `NotFound.tsx` | KEEP | Needed. Trim `Setup.tsx` (600 lines). |

### Server (`server/`)

| Module | Verdict | Reason |
|---|---|---|
| `index.js`, `auth.js`, `env.js`, `errors` helpers, `lib/` | KEEP | Core. `errors.js` is test-only today; fold it into `lib/` or drop it. |
| `discovery.js`, `urlResolver.js`, `providers/docker.js`, `dockerLabels.js` | KEEP | Docker as source of truth. |
| `healthModel.js`, `probe.js` | KEEP | Health dots on Home. |
| `host.js`, `resources.js`, `providers/system.js` | KEEP | The host strip. Merge the first two. |
| `monitoring/` | KEEP | Uptime. Docker, HTTP and TCP checks all stay. |
| `events/`, `notifications/` (Telegram) | KEEP | The bell. |
| `notifications/providers/webhook.js` | REMOVE | Decided: Telegram is the only external channel. |
| `alerts.js` | MERGE | Into the event stream behind the bell. |
| `activity.js` | MERGE | Into the same stream; feeds the bell's recent-activity list and keeps the audit record. |
| `operations/`, `containers/`, `providers/dockerOperations.js`, `updates/recreateAdapter.js` | MERGE | One Docker write path and one confirm/audit pipeline. **High risk.** |
| `stacks/` | KEEP | Backs "add a compose block". |
| `registries/` | KEEP | Registry client for native update checking and private registries. |
| `updates/` (engine, transaction, eligibility, preserveConfig) | KEEP | "Update" with rollback stays. |
| `updates/diun.js`, `updates/webhookAuth.js` (Diun part) | REMOVE | After native checking is verified. |
| `autoheal/`, `autohealApi.js` | REMOVE | Replaced by native auto-heal. |
| `catalog/`, `catalogApi.js` | REMOVE | ~1.3k lines with its pages. |
| `files/`, `filesApi.js` | REMOVE | ~5.0k lines with its page. |
| `infrastructure/`, `infrastructureApi.js`, `providers/{zfs,storage,network,power,opnsense,opnsenseConfig}.js`, `proxy/provider.js` | REMOVE | ~4.3k lines with the page and components. |
| `providers/{news,weather,market,background}.js`, `lib/feed.js` | REMOVE | Homepage widgets, not Homepage's core job. |
| `widgets.js`, `layout.js`, `templates.js` | REMOVE | Widget composition goes. Stack order and group names move to `services.yaml`. |
| `search.js`, `SearchOverlay.tsx` | KEEP | Decided: Ctrl+K stays. Trim its index to containers, stacks, monitors, settings. |
| `providers/icons.js` | KEEP | Service icons on Home. |
| `statsHistory.js` | REMOVE | Decided: container charts go. |
| `homepageImport.js` | KEEP, then REMOVE | A one-time migration; delete once you have moved off Homepage. |
| `configStore.js`, `configSchema.js`, `configHistory.js`, `configScope.js` | MERGE | Into two modules: store and history. |
| `configExport.js`, `configImport.js` | REMOVE | Decided: back up by copying `config/`. |
| `updateCheck.js`, `version.js` | MERGE | Into Settings ("about"). Small. |
| `api.js` (1.9k), `model.js` (1.2k), `*Api.js` | MERGE | Split by domain: containers, uptime, bell, settings, auth. |

Removal totals roughly 15k lines of source, plus about 4k lines of tests that pin removed
features. The test suite is about 20k lines, so deleting those tests is part of each removal.

## Decisions

Made:

- **Audit trail** goes into the bell panel's recent-activity list. No Activity page.
- **Telegram** is the only external channel. The generic webhook channel is dropped.
- **Ctrl+K search** stays.
- **Config export/import** and **container charts** are dropped.
- **Updates stay manual.** Native checking only detects and badges; "Update" is a button you press.

- **Infrastructure is removed entirely**, ZFS included. No ZFS line on Home. What stays is the host
  vitals read from `/proc` and `/sys` (CPU, memory, storage use, temperature, uptime) for the host
  strip.

## Still unsure: confirm before deleting

1. **`proxy/provider.js`.** A "write side" reverse-proxy abstraction. Nothing I looked at seems to
   use it, but I have not traced it.
2. **Settings keys read by removed modules.** `settings.yaml` and `layout.json` may carry values for
   removed features. The config loader must ignore unknown keys instead of failing.
3. **Coupling between autoheal and updates.** `autoheal/observer.js` calls into
   `updates/transaction.js` (`isContainerUpdating`). Native auto-heal must keep that "don't heal
   during an update" rule.
4. **Routes in links and bookmarks.** `/services`, `/stacks`, `/monitoring`, `/system`: keep
   redirects for one release so saved links survive.
5. **Setup and restore.** Check that first-run setup does not depend on `configImport.js` before
   it is removed.

## Roadmap

Order: **remove, then split, then build.** Phases 1 and 2 (truth pass and dead code) are done; phase 3 (Files) is done on its own branch.

| # | Phase | Risk |
|---|---|---|
| 3 | **Remove Files.** Page, server module, API, tests, compose example, README and env vars. | Low |
| 4 | **Remove Infrastructure** (decided: everything, ZFS included) and its providers, `proxy/provider.js`, tests and settings keys. Config loader tolerates old keys. | Low |
| 5 | **Remove Hub extras:** news, weather, market, background, widget composition, templates, Icons page; container charts (`statsHistory.js`); config export/import; the webhook notification channel. Search stays. Home keeps the stack-grouped launcher. | Low |
| 6 | **Remove Catalog** and its manifests. | Low |
| 7 | **Merge pages:** Home, Containers (with "add compose block"), Uptime. Remove System, Host, Stacks, Activity pages. Redirect old routes. | Low |
| 8 | **Split the monoliths:** `api.js`, `model.js`, `Settings.tsx` by domain. No behavior change. | Low |
| 9 | **One write path.** Merge the Docker write adapters, planners and operations pipeline. The mechanical proof tests must still pass. | **High: Docker socket writes.** Disposable host first. |
| 10 | **The bell.** One stream from events, alerts and the audit record, with a recent-activity list in the panel; Telegram as the only external channel. | Low |
| 11 | **Native update checking, read-only.** Scheduled digest comparison via `registries/client.js`, per-container toggle, badge on Home, bell entry. Applies nothing. Diun webhook stays as a fallback until results match for a few weeks. | Low (outbound registry GETs; mind Docker Hub rate limits) |
| 12 | **Native auto-heal, dry-run.** Per-container toggle. Detects unhealthy containers and writes "would restart" entries to the bell. Restarts nothing. Honors the update-window rule. | Low (read-only) |
| 13 | **Native auto-heal, live.** Restart unhealthy opted-in containers with backoff and a circuit breaker. Enable one container first. | **High: restarts containers.** |
| 14 | **Retire Diun and Autoheal.** Remove `autoheal/`, `updates/diun.js`, webhook secrets and docs. Stop the two external containers. Keep a migration note. | Low |
| 15 | **Docs and packaging.** Rewrite README for the five-tool story. Move the build-only npm packages to `devDependencies`. Update `docker-compose.yml`. | Low |

Out of scope for now: unattended auto-apply of updates (the "Update" button stays manual), multi-host
agents, exec consoles, image/volume/network management, and RBAC beyond the single admin.
