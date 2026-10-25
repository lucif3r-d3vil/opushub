# Simplification plan

Read-only audit of `main` (after phases 1 to 4). Goal: a simple website that replaces Portainer,
Homepage, Autoheal, Diun and Uptime Kuma. **Monitoring (the Uptime page and its engine) is kept in
full**; everything else has to justify itself against that goal.

Line counts are measured (`wc -l`); "removed" figures are estimates and include tests. This extends
`docs/PRODUCT.md`; where they differ, this file is newer.

## 1. Settings

Today: 21 tabs in `src/pages/Settings.tsx` (2,251 lines) plus `src/pages/settings/` (Configuration 750,
Operations 251, Monitoring 199, Connections 48). Target: **one small page, five sections**: Docker
connection, Notifications, Monitoring defaults, Appearance basics, Account.

| Tab (file:line) | Settings inside | Verdict | Reason |
|---|---|---|---|
| General (`Settings.tsx:164`) | Name, Greeting name, 24-hour clock, Version, Configured widgets, Where the files live | REMOVE; Version moves to Docker | Greeting and clock belong to Hub widgets; the rest is diagnostics. |
| Appearance (`:481`) | Mode, Accent, Density, Type scale, Translucency | MERGE: keep Mode and Accent | "Appearance basics". Density, type scale and translucency are polish. |
| Background (`:541`) | Style, Blur, Scrim, Position, Fit, Remove | REMOVE | Homepage feature; needs `providers/background.js` (332), `BackgroundImage.tsx`, `/api/backgrounds`. |
| Hub layout (`:668`) | Name and clock, Spacing, Composition, First-run banner | REMOVE | Configures widget composition, which goes. |
| Widgets (`:704`) | Per-widget add/hide/resize/config, reset | REMOVE | Same. |
| Templates (`:935`) | Layout presets | REMOVE | Same (and decided in PRODUCT.md). |
| Services (`:1046`) | Per-container name, icon, group, URL, visibility | MERGE | Presentation overlay is useful, but belongs on the Containers detail page, not Settings. **Uncertain:** see section 4. |
| Groups (`:1379`) | Create, rename, reorder, hide groups | REMOVE | Home groups by Compose stack; a second grouping system is the complexity to avoid. **Uncertain.** |
| Bookmarks (`:1565`) | Flat link groups | REMOVE | Not in the target Home. **Uncertain:** it is a Homepage feature you may use. |
| Integrations (`:1921`) | Weather location, units, placement; news feeds; market symbols | REMOVE | Only configures news, weather and markets, which go. |
| Notifications (`:1667`) | In-app (enabled, min severity); Browser (enabled, min severity, permission); Webhook (enabled, URL, secret, allow internal, allow insecure); Telegram (enabled, bot token, chat ID, min severity) | KEEP in-app and Telegram; REMOVE Webhook (decided) and Browser | The bell plus Telegram is the stated scope. **Uncertain:** browser notifications. |
| Connections (`settings/Connections.tsx`) | Docker status (version, API, container count) | KEEP | Becomes the "Docker connection" section. |
| Environment (`:338`) | Config dir, data dir, runtime, newest release, address, five file inventories, unmatched overlays, inventory | MERGE | Keep host address and the update check inside Docker connection; the rest is diagnostics. Entry-point ports (`infrastructure.entrypointPorts`) stay settable, since URL resolution needs them. |
| Monitoring (`settings/Monitoring.tsx`) | Interval, timeout, failures before down, successes before up, samples kept, hourly buckets, incidents kept, monitor cap, concurrent checks, jitter, allow internal targets, auto-create from discovery, discovery cap | KEEP | Monitoring is kept in full. |
| Operations (`settings/Operations.tsx`) | Read-only list of registered actions, timeouts, permissions | REMOVE | Informational only; nothing to configure. |
| Account & sessions (`:219`) | Username, password hashing, recovery, change password, sessions | KEEP | The Account section. |
| Import & migration (`settings/Configuration.tsx:51`) | Homepage import wizard | REMOVE (last) | See homepageImport in section 4. |
| History (`:407`) | Config versions, restore | REMOVE UI | Atomic writes still keep backups on disk (`configStore`/`configHistory`). **Uncertain.** |
| Export (`:548`) | Export formats, redaction | REMOVE | Decided: back up by copying `config/`. |
| Scope (`:676`) | Read-only description of what config may change | REMOVE | Documentation, not a setting. |
| Advanced (`:2022`) | Log service launches, system refresh, services refresh, custom `theme.css` and `app.js` | REMOVE | Fixed sane intervals; custom CSS/JS is also an attack surface (`server/index.js:112-120`, `/api/custom`). |

Effect: `Settings.tsx` goes from 2,251 lines to roughly 600 (Account about 130, Notifications about 130,
Appearance about 40, Docker connection about 100, shell and primitives); `settings/Configuration.tsx`
(750) and `settings/Operations.tsx` (251) are deleted. Net about 2,500 lines.

## 2. Duplication

| What overlaps | Evidence | Surviving version |
|---|---|---|
| **Pages showing the same data**: Hub, Services, Stacks, StackDetail, ServiceDetail, Host, System, Activity | Hub widgets, `Services.tsx` and `Stacks.tsx` all poll `/api/services` and `/api/stacks`; `Host.tsx` (`/api/host`) and `System.tsx` (`/api/system`) both show host facts; `Activity.tsx`, `ServiceDetail.tsx`, `StackDetail.tsx` and the hub widget all read `/api/activity` | **Home** (stack-grouped launcher plus host strip from `/api/system`), **Containers** (Services, ServiceDetail, Stacks, StackDetail, ManagedStack merged), **Uptime**. Host and System pages go; Activity becomes the bell panel's recent-activity list. |
| **Three Docker HTTP clients** | `providers/docker.js` (reads), `providers/dockerOperations.js` (lifecycle writes), `updates/recreateAdapter.js` (create/recreate), each with its own `http.request` over the socket | One `docker/client.js` plus a frozen write table; keep the read/write split as exported functions, and keep the proof tests (`phase7-proof`, `phase8-proof`, `security-proofs`). |
| **Parallel planner/runner stacks** | `operations/` (about 2.5k), `containers/` (1.5k), `stacks/` (1.1k), `catalog/` (0.9k), `updates/` (1.5k): about 7,830 lines, each with a planner, runners and targets, all feeding one confirm/audit pipeline | One pipeline: `operations/*` stays; `containers/` and `stacks/` become action definitions; `catalog/` is removed; `updates/` is folded in. |
| **Two image-update paths** | `/api/container-updates/dry-run|apply` (`updatesApi.js` to `updates/engine.js`, own `transaction.js` and confirmation) versus the registry actions `container.change_image` / `container.recreate` (`containers/runners.js`). Both already call `containers/recreate.js`. | One operation, `container.update_image`, using `recreate.js` and the rollback in `updates/transaction.js`. Keep `updates/store.js` for the update-available badge. **Also:** `container.update` is actually Docker's in-place resource update (see `containersApi.js:137`), a confusing name; rename it. |
| **Six config modules plus helpers** | `configStore` 149, `configSchema` 378, `configScope` 100, `configHistory` 476, `configExport` 356, `configImport` 347; plus `homepageImport` 1,019, `layout` 112, `templates` 173 | `configStore` (with a trimmed schema) and `configHistory` (backups and restore). Scope logic inlined; export, import and templates removed; `layout.json` shrinks to `services.{groupOrder,order,hiddenGroups}` if Home keeps custom order. |
| **`Settings.tsx` vs `settings/`** | 12 tabs inline in `Settings.tsx`, 5 in `settings/`; primitives already shared (`settings/parts.tsx`) | `Settings.tsx` as a thin shell; one file per section in `settings/` (Docker, Notifications, Monitoring, Appearance, Account). |
| **Two API namespaces** | `V1_ROUTES` alias layer in `server/api.js:1777` and 29 client uses of `/api/v1/...` next to unversioned routes | Unversioned only; delete the alias layer and its test. |
| **Two HTTP probers** | `server/probe.js` (167, service health probing) and `monitoring/checks/http.js` with `monitoring/net.js` | Probably one, in `monitoring/`. **Verify** before merging; health dots could come from monitors. |
| **Host data in four places** | `providers/system.js` (collect), `host.js` (identity), `resources.js` (re-presents the sample), `statsHistory.js` | `system.js` plus one small host-strip endpoint. `resources.js` and `GET /api/resources` have no UI consumer. |
| **Orphan routes after phase 4** | `GET /api/volumes`, `/api/images`, `/api/docker`, `/api/resources` have no `src/` caller; only `/api/networks` is used (`ContainerEditor.tsx`) | Delete them with `listVolumes`, `listImages`, `imagesSummary`, `systemDf` in `providers/docker.js` and their tests (`phase7-infra`, `phase7-host`). |
| **Alerts, events, notifications, activity** | `alerts.js` 308, `events/`, `notifications/`, `activity.js` 259, plus the alert list and ack on the Activity page | Keep: events bus to bell store plus activity log. `alerts.js` stays as the evaluator. Needs an alert list and ack in the bell. |
| **Icons** | `providers/icons.js` 194, `IconPicker.tsx` 143, `pages/Icons.tsx` 164 | Keep the resolver and picker (used by the service editor); drop the page. |
| **`errors.js`** | Imported only by `phase7-health.test.js` | Delete with that test change. |

## 3. Remaining bloat from PRODUCT.md

All safe to remove, with the dependencies that have to be handled in the same commit.

| Item | Size | Depends on it | Safe? |
|---|---|---|---|
| News | `providers/news.js` 61, `lib/feed.js` 59 | `api.js` (`/api/news`), `search.js` news results, `widgets.js` news widget, Integrations tab, `integrations.news` in settings | Yes |
| Markets | `providers/market.js` 165 (+test) | `model.js:17,658-668` (symbol validation in settings), `api.js`, widget, Integrations | Yes; edit `model.js` |
| Weather | `providers/weather.js` 90 | `api.js`, widget, Integrations | Yes |
| Templates and layout presets | `templates.js` 173 | `api.js` (`/api/templates`, `POST /api/layout/template`), `model.js:15,752`, **`Setup.tsx` wizard** (template step, `src/lib/auth.tsx` type), `HubSurface`, `SearchOverlay`, `phase6-setup-audit.test.js`, `test/layout.test.js` | Yes, but the first-run wizard (598 lines) must be reworked first |
| Hub widget composition | `widgets.js` 244, `layout.js` 112 (shrink), `components/hub/` 1,352, three Settings tabs (373) | Home page must exist first; `ServiceLauncher.tsx` (286) is the part to keep | Yes, after Home |
| Icons page | `pages/Icons.tsx` 164 | `App.tsx` route, tests | Yes |
| Catalog | `catalog/` plus `catalogApi.js` plus pages: 1,714 | `operations/engine.js` (imports `catalog/runners`), `operations/policy.js` (imports `catalog/planner`), registry action `service.install`, `phase10d-review.test.js` (uses `catalog/store`), `App.tsx` routes | Yes; strip the operations plumbing. `stacks/` (add compose block) is separate and stays. |
| Activity page | `Activity.tsx` 379 | `App.tsx` and rail, `Notifications.tsx:224` ("View Activity" link), alert list and ack (`/api/alerts`, `/api/alerts/ack`). `/api/activity` itself stays: hub widget, ServiceDetail and StackDetail read it. | **Only after the bell panel has a recent-activity list and alert ack.** |
| Config export and import | `configExport.js` 356, `configImport.js` 347, `Configuration.tsx` 750, tests | `api.js` routes (`/api/config/export`, `/api/config/import/*`), `configScope` and `configSchema` (shared with `configHistory`); `Setup.tsx` does not call them | Yes. `homepageImport.js` (1,019) is separate: keep until you have migrated off Homepage. |
| Container charts | `statsHistory.js` 176, chart code in `ServiceDetail.tsx` and `StackDetail.tsx` (about 250) | `model.js:10,1128` and `api.js:607,645,649` use `statsWithHistory` for **live** stats too; `phase3` and `stack-rollup` tests | Yes, but keep the live stats call and drop only the history sampler. `Charts.tsx` stays: Uptime and the host strip use it. |

## 4. Removal commits, smallest risk first

| # | Commit | Est. lines removed | Risk |
|---|---|---|---|
| 1 | Settings: Operations tab, Scope tab, Advanced launch-log and refresh rows | 350 | Very low (informational) |
| 2 | Webhook channel and browser notifications (`notifications/providers/webhook.js` 405, UI, tests) | 750 | Low (decided) |
| 3 | Weather, news, markets (server, widgets, Integrations tab, settings keys) | 1,000 | Low; edit `model.js` |
| 4 | Background and custom CSS/JS (`providers/background.js`, `BackgroundImage`, Background tab, `/api/custom`, `/user/*.css|js`) | 800 | Low; reduces attack surface |
| 5 | Icons page | 180 | Very low |
| 6 | Container charts (history sampler only) | 450 | Low; keep live stats |
| 7 | Orphan routes: `/api/volumes`, `/images`, `/docker`, `/resources`, `resources.js`, `errors.js`, v1 alias layer | 450 | Low; confirm no external caller |
| 8 | Config export, import, scope and History UI | 1,900 | Low to medium; keep on-disk backups |
| 9 | Catalog (plus operations plumbing) | 1,800 | Medium (touches `operations/engine.js`, `policy.js`) |
| 10 | Bell panel: add recent-activity list and alert ack (**additive**, builds first) | +150 | Low |
| 11 | Activity page removal | 380 | Low after 10 |
| 12 | Home page (stack grouping, host strip) built; then remove hub composition, templates, widgets, Setup template step | 2,300 net | Medium: touches first-run flow and `layout.json` |
| 13 | Containers page (merge Services, ServiceDetail, Stacks, StackDetail, ManagedStack); remove System and Host pages | 700 net | Medium |
| 14 | Settings reshaped to five sections (Services overlay editor moves to Containers; Groups and Bookmarks removed) | 1,500 net | Medium |
| 15 | One Docker client and one pipeline (merge adapters, planners, the two update paths) | 1,500 net | **High: Docker socket writes.** Disposable host first; keep the proof tests. |
| 16 | `homepageImport.js` and the import wizard, after you have migrated | 1,100 | Low; do last |

Total: roughly **14,000 lines** out of about 60,000.

### Decisions

Made:

1. **Bookmarks stay** as a small flat list on Home. Their Settings editor stays too, until the Settings reshape (commit 14).
2. **Per-service overrides** (name, icon, group, URL, visibility) live on the Containers detail page, not in Settings.
3. **Browser notifications are dropped** (commit 2). In-app and Telegram stay.
4. **Config History restore button is dropped**; backups stay on disk (commit 8).
5. **`probe.js` and `monitoring/checks/http.js` merge only if tests prove identical behavior**, including the private-address checks. Otherwise both stay.

### Still uncertain

1. **Alert ack** (commit 10): today it lives on the Activity page. Does the bell need it?
2. **First-run wizard** (commit 12): it currently offers templates and an import step; its replacement flow needs a decision.
3. **Group order**: groups are Compose stacks, alphabetical, unless you want custom order kept in `layout.json`.
4. **Custom group names and `opushub.*` labels** stay valid (Docker labels are source of truth); only the Settings UI for them goes.
