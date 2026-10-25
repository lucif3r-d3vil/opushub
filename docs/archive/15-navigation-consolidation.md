# Navigation Consolidation + Deduplication Audit

Continuation of the completed Phase 10C state. This is a refactor and UX-consolidation pass —
not a feature phase. Phase 11 has not started.

This document records the audit **before** the change: what the navigation was, every duplicate
found, what was consolidated, what was deliberately left alone, and why.

---

## A. Navigation inventory

### A.1 Sidebar (rail) before

Desktop rail is an always-compact icon rail (tooltips on hover), replaced below 860 px by a
bottom mobile bar carrying the same items.

Primary entries (7):

| # | Label | Target | Notes |
|---|-------|--------|-------|
| 1 | Hub | `/` | |
| 2 | Services | `/services` | |
| 3 | Monitoring | `/monitoring` | **identical icon to Activity** (heartbeat path) |
| 4 | Stacks | `/stacks` | |
| 5 | System | `/system` | |
| 6 | Activity | `/activity` | identical icon to Monitoring |
| 7 | Settings | `/settings/appearance` | deep link past the default tab |

Rail foot / global actions (in order): **Search** (button opening the command overlay),
**Notifications** (bell + portalled panel), **Theme toggle** (system → dark → light cycle),
**Sign out**. On mobile the bottom bar shows the 7 primary items + search + bell.

### A.2 Routes before

| Route | Page | In nav? |
|---|---|---|
| `/` | Hub | yes |
| `/services`, `/services/:group/:name` | Services, ServiceDetail | yes |
| `/monitoring`, `/monitoring/incidents`, `/monitoring/:id` | Monitoring (two views), MonitorDetail | yes |
| `/stacks`, `/stacks/:name` | Stacks, StackDetail | yes |
| `/system` | System (host vitals, Autoheal) | yes |
| `/infrastructure` (+ `?tab=docker|storage|network|power|networks|volumes|images|topology`) | Infrastructure | **orphan** — only reachable from itself, `/host`, and search |
| `/host` | Host (machine identity) | **orphan** — only reachable from `/infrastructure` and search |
| `/activity` | Activity (events, alerts) | yes |
| `/settings`, `/settings/:tab`, `/settings/:tab/:item` | Settings (21 tabs) | yes |
| `/icons` | Icon browser | utility page linked from Settings + search |
| `*` | NotFound | — |

### A.3 Duplicate / fragmented navigation concepts found

1. **Monitoring and Activity shared one icon** — the exact same SVG path. Two different pages,
   one glyph: that is the "visually misleading icon" failure mode.
2. **The "machine" story was fragmented across three pages**: `/system` (live vitals), `/host`
   (identity + provider picture), `/infrastructure` (Docker engine, storage/ZFS, network,
   power, topology). None of the latter two appeared in the primary navigation, so the only
   way to reach Docker engine/storage/networking/UPnS detail was a search or a lucky link.
3. **Settings linked into the middle of itself** (`/settings/appearance`), skipping the tab a
   first-time visitor should see (General).

### A.4 Mapping to the consolidated navigation

New primary navigation (7 + 4 global — no additions, order per the consolidation brief):

```
Hub · Services / Containers · Stacks · Monitoring · System · Activity · Settings
                    ⋮  (flexible spacer)
        Search · Notifications · Dark/Light · Logout
```

Route mapping — old routes keep working through client redirects:

| Old route/feature | New parent | New location | Deep links |
|---|---|---|---|
| `/system` (vitals, Autoheal status) | System | `/system` ("Vitals" view) | unchanged |
| `/host` | System | `/system/host` | `/host` **redirects**, query/hash preserved |
| `/infrastructure?tab=…` (Docker, storage/ZFS, network, power, volumes, images, topology) | System | `/system/infrastructure?tab=…` | `/infrastructure?tab=…` **redirects**, query/hash preserved |
| `/icons` | Settings (utility) | `/icons` unchanged | unchanged |
| `/settings/appearance` (nav target) | Settings | nav now targets `/settings` (General is the default tab) | all `/settings/:tab` links unchanged |

The three System pages carry the same sub-navigation ("Vitals · Host · Infrastructure") the way
the Monitoring page already switches Monitors/Incidents — one pattern, reused.

**Server-side hrefs are intentionally unchanged.** Alerts, topology nodes, event subjects and
stored notifications carry paths like `/infrastructure?tab=storage`. They are data (some of it
persisted in `data/*.jsonl`), and the redirect makes old paths resolve forever. Rewriting them
would churn APIs and stored records for zero user-visible gain.

### A.5 What each parent now contains

- **Hub** — overview, health attention strip, update summary chip, alerts attention widget,
  system/service summaries, recent activity, launch/actions (unchanged content).
- **Services / Containers** — directory, per-service detail (health, updates/Update Now,
  Autoheal badges where already present, lifecycle actions, resources, logs).
- **Stacks** — compose projects, members, status, standalone containers.
- **Monitoring** — Monitors / Incidents views, engine line, defaults & bounds shortcut
  (unchanged).
- **System** — Vitals (CPU/mem/disk/network charts, Autoheal area), Host, Infrastructure tabs
  (Docker engine, storage/filesystems/ZFS, networking, power/UPS/PDU/OPNsense when configured,
  topology, resources).
- **Activity** — event history with filters, live events, alerts.
- **Settings** — everything configurable: general, appearance, background, hub, widgets,
  templates, services/groups/bookmarks presentation, integrations, notifications, connections,
  authentication, environment, monitoring, operations, advanced (custom CSS/JS), import,
  history, export, configuration.

Global actions remain global and singular: Search = one command overlay, Notifications = the
Phase 10B bell/panel + server center, Dark/Light = the one settings-backed theme toggle,
Logout = the one session logout.

---

## B. Code duplication inventory

Classification legend: **SAFE_TO_CONSOLIDATE** · **KEEP_SEPARATE** · **DEAD_CODE** ·
**NEEDS_FURTHER_REVIEW**.

### B.1 Consolidated in this pass

| # | Files / symbols | What overlapped | Canonical | Classification | Risk |
|---|---|---|---|---|---|
| 1 | `tmp-write + rename` atomic write in `activity.js`, `auth.js`, `configStore.js`, `events/store.js` ×2, `monitoring/store.js`, `notifications/policy.js`, `notifications/store.js`, `notifications/providers/telegram.js`, `notifications/providers/webhook.js`, `operations/audit.js` ×2, `providers/system.js`, `updates/store.js`, `lib/cache.js` (`persistSnapshot`) | 15 copies of the same three lines (write temp, optional 0o600, rename) | new `server/lib/atomicFile.js` (`writeFileAtomic`, `writeJsonAtomic`) | SAFE_TO_CONSOLIDATE | low — byte-identical contents, per-file mode preserved; covered by every store's tests |
| 2 | `getPublish()` + `publishEventSafe()` lazy wrapper in `alerts.js`, `infrastructure/registry.js`, `infrastructure/state.js`, `monitoring/engine.js`, `operations/engine.js`, `updates/engine.js` | 6 copies of the same best-effort event publish | `publishEventSafe` exported from `server/events/index.js` (the bus already exposes itself statically to `autoheal/observer.js` and `updates/diun.js`) | SAFE_TO_CONSOLIDATE | low — no import cycle (events/index → activity → configStore, none import back); event publication asserted by phase 7/8/9/10 tests |
| 3 | severity rank `{ info: 0, notice: 1, warning: 2, critical: 3 }` inline in `alerts.js`, `events/bus.js` ×2, `events/sse.js` ×2, `events/store.js`, `notifications/policy.js`, `notifications/store.js`; severity list duplicated in `activity.js` | 10 re-implementations of the canonical order | `SEVERITY_ORDER` / `SEVERITIES` already exported from `server/events/model.js` | SAFE_TO_CONSOLIDATE | low — identical constants, no cycle (model imports only `node:crypto`) |
| 4 | `src/pages/Settings.tsx#NotificationsTab` hand-rolled `api()`/`put()`/`post()` calls + local fetch-once state for policy / webhook / telegram | a second notification-settings client beside the canonical hooks | `useNotificationPolicy` / `useWebhookConfig` / `useTelegramConfig` / `requestBrowserPermission` in `src/lib/notifications.ts` | SAFE_TO_CONSOLIDATE | medium-low — form-sync semantics preserved (first load only); covered by the web settings tests |
| 5 | `GlobalUpdateIndicator` in `src/components/Updates.tsx` hand-rolled `.modal-backdrop`/`.modal` markup | modal scaffolding duplicated (no Escape key, no focus handling, no scroll lock) | shared `Modal` from `src/components/ui.tsx` | SAFE_TO_CONSOLIDATE | low — same CSS classes, better a11y |
| 6 | `NOTIFIABLE_TYPES` in `src/lib/notifications.ts` | stale mirror of `server/notifications/init.js` (15 vs 20 types — missing the Phase 10C `container.update*`/`autoheal` types, so live updates/autoheal events did not refresh the panel silently) | synced to the server list (by design a mirror — client cannot import server code) | SAFE_TO_CONSOLIDATE (bug fix) | low |
| 7 | `/host` + `/infrastructure` mounts in `src/App.tsx` | second mount points for pages that belong to System | canonical mounts at `/system/host` and `/system/infrastructure` + `<Navigate>` redirects | SAFE_TO_CONSOLIDATE | low — pages untouched, query strings preserved |
| 8 | `NotificationCenterPage` in `src/components/Notifications.tsx` | exported, never imported anywhere — a second notification UI left over from an earlier iteration | removed; the bell/panel is the one notification UI | DEAD_CODE | none |
| 9 | `.rail-dot` / `.rail-dot.off` in `src/styles/base.css`, `requestBrowserPermission`'s unused duplicate inline in Settings | unused CSS; inline re-implementation | removed / routed through the lib helper | DEAD_CODE | none |
| 10 | publish-to-activity bridge in `server/events/index.js#publishEvent` (mapped ~17 canonical event types to activity rows *in addition to* the producers' own direct activity writes) | the same transition was written to the activity log twice — once by the producer with rich context and dedupe signatures, once by the bridge as a bare re-format | producers write activity directly (they own the transition and context); `events/index.js` now only drives bus + store + SSE + notifications | SAFE_TO_CONSOLIDATE (duplicate-write) | low-medium — found by `phase7-alerts.test.js` asserting one row per transition (bridge made resolve land twice); activity UI reads activity, which is unchanged |

### B.2 Audited and deliberately kept separate

| Files / symbols | Why they stay separate |
|---|---|
| `providers/docker.js` (read-only) vs `providers/dockerOperations.js` (3-op write adapter) vs `updates/recreateAdapter.js` (update transaction pipeline) | Mechanical proofs depend on the read provider containing **no** write path (`phase7-proof`, `phase10a-proof`). Three security postures, three modules — by design. |
| `monitoring/net.js` `resolveHost`/`addressRefusal` vs `notifications/providers/webhook.js` `resolveWebhookHost` | Same DNS-pinning *shape*, deliberately different **policy**: monitors allow RFC1918 targets by default (that is what a homelab is), webhook endpoints block internal classes unless an operator opts in, with different redirect budgets and error vocabulary asserted by security tests. Merging the policy knobs into one resolver would blur the boundary the modules exist to keep obvious. Cross-reference comments updated. |
| `auth.js` login throttle (exponential failure delay) vs `updates/webhookAuth.js` IP sliding window vs webhook provider per-URL minute bucket | Three different threat models (credential brute force, inbound webhook abuse, outbound delivery storms). No shared state is correct here. |
| `activity.js` (user timeline JSONL) vs `events/store.js` (canonical event history) vs `operations/audit.js` (operation audit trail) | Different retention, consumers and trust levels; producers write each from the transition they own (the leaky double-write bridge that mapped canonical events into activity was removed — see B.1 #10). Merging stores would be a rewrite, not a dedup. |
| `providers/health.js` (provider registry) vs `infrastructure/health.js` (domain aggregation) vs `healthModel.js` (per-service verdict) | Three different health vocabularies answering three different questions. |
| `updateCheck.js` (OpusHub's own releases) vs `updates/*` (container updates via Diun) | Homonyms, not duplicates. |
| `model.js#safeIcon` vs `configSchema.js#safeIcon` | The import pipeline is deliberately **stricter** (refuses anything except `/user/icons/<file>` with traversal checks); the presentation overlay reader accepts existing `/user/*` refs. Tightening the overlay reader would reject previously valid configs — a behavior change, not a dedup. Annotated in code. |
| `ui.Modal` vs `SearchOverlay` vs `NotificationPanel` vs `LogsDrawer` | A command palette, an anchored popover and a pinned log drawer are not modals; each is used consistently for its one job. |
| `probe.js` (one-shot service URL probe feeding healthModel) vs `monitoring/checks/*` (scheduled, pin-validated monitor checks) | Different lifecycles and policy (probe follows the configured service URL; monitors validate targets). |
| `sse.ts#LiveEvent`, `notifications.ts#Notification` frontend types | Each defined exactly once, in the client lib for its API. `src/lib/types.ts` holds the shared document types; no competing definitions found. |
| `lib/api.ts#useSharedQuery` + `usePolled` alias | One implementation; the alias exists so pages keep their import shape. |
| Theme (`lib/theme.tsx` + `index.html` bootstrap) / Search (`SearchOverlay` + `server/search.js`) / Icons (`Icon.tsx` → `/api/icon` → `providers/icons.js`) | Verified single canonical implementation each — no duplicates found. |

### B.3 Needs further review (reported, not touched)

1. **Homepage-import helpers** (`homepageImport.js`, ~1000 lines) contain internal helpers that
   echo config-schema ideas (icon/name sanitation). It is a one-shot migration pipeline with
   its own test suite; partially overlapping but not identical semantics. Left alone — the
   migration path is already legacy-shaped and any change there deserves its own pass.
2. **Settings.tsx size (2.2k lines)** — the settings tabs now import shared primitives well;
   splitting the file is cosmetic and churny, noted as debt rather than done here.

---

## C. Risk assessment

| Area | Exposure | Verdict |
|---|---|---|
| Authentication / sessions | untouched — one auth module, one gate in `api.js`; no change | safe |
| Authorization / CSRF | untouched — the session+CSRF gate still wraps every mutating route | safe |
| Docker operations | no change to `dockerOperations.js`, `recreateAdapter.js`, targets, locks, or confirmation | safe |
| Notifications | canonical system reused; the Settings tab moves onto the canonical client hooks; dead duplicate page removed; client notifiable-type mirror synced (a correctness fix) | safe, behavior improves |
| Monitoring | untouched engine/scheduler/stores; only the shared `atomicFile` helper is swapped under `monitoring/store.js` with identical bytes | safe |
| Updates (Phase 10C) | no pipeline change; `updates/store.js` swaps to the shared atomic write (identical bytes) | safe |
| Autoheal / Diun | untouched | safe |
| Persistence / migrations | `writeFileAtomic` preserves tmp-name shape, 0o600 modes and content bytes; `configStore` keeps its backup hook wrapping the helper | safe — covered by store/migration tests |
| API compatibility | no endpoint added/removed; no payload shape changed; old client routes redirect | safe |
| Event bus | `publishEventSafe` is the same best-effort publish, now called synchronously from the same call sites (previously via a cached microtask hop) — order within each module preserved | safe — asserted by phase suites |

Security invariants confirmed untouched: no generic Docker proxying, no arbitrary endpoints,
no new shell/filesystem access, webhook auth + rate limits unchanged, SSRF policy unchanged,
Update Now still resolves and validates the target server-side, Diun remains advisory-only.
