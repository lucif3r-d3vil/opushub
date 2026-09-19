# Phase 10B — Live Events & Notifications

> Status: implementation plan (pre-code audit)

## 1. Audit — existing modules to reuse

| Capability | Location | Reuse |
| --- | --- | --- |
| Activity log (JSONL, bounded, dedup, severity/category, grouping, filtering) | `server/activity.js` | Keep as historical log; new Event Bus will feed it for meaningful transitions, but Activity remains authoritative for activity UI. Do NOT replace. |
| Alerts engine (pure evaluate, active set, firing/resolved transitions, ack, channels registry) | `server/alerts.js` + `server/notify.js` | Alerts remain authoritative; event bus will publish `alert.created` / `alert.resolved` on transitions. Existing `notify.js` registry will be extended to real provider registry (webhook first). |
| Monitoring engine (CRUD, scheduler, checks, state machine, incidents, history, store) | `server/monitoring/*` + `server/monitoringApi.js` | Monitoring remains sole checker/scheduler/state holder. Phase 10B will add event publishing on meaningful transitions (up→down etc) inside `engine.js` via event bus, without changing check logic. |
| Infrastructure model/providers/registry/health | `server/infrastructure/*` + `server/infrastructureApi.js` | Health changes already produce activity via `state.js` and `registry.js`. Event bus will publish `infrastructure.health_changed` where provider model supports it. No new provider invented. |
| Operations engine (request → confirm → execute → verify → audit) | `server/operations/*` | Operations already log activity. Event bus will publish `operation.completed/failed/etc` on terminal states. No Docker mutation added. |
| Address policy / SSRF boundary | `server/lib/ipPolicy.js` + `server/monitoring/net.js` | Shared classifier with two policies. Webhook destinations must use same policy: reuse `classifyIp`, `BLOCKED_FOR_MONITOR` (or new BLOCKED_FOR_WEBHOOK = same as monitor plus private blocking by default unless explicitly allowed). Implement `allowedForWebhook` using same sets. |
| Auth / session / CSRF | `server/auth.js` + `server/api.js` | SSE endpoint must be authenticated (session cookie) and same-origin checked via existing CSRF logic for safe method? Actually GET is safe, but auth gate ensures session. No new auth. |
| Persistence conventions (atomic write, bounded, corruption-resistant) | `server/configStore.js`, `server/monitoring/store.js`, `server/activity.js` | Event history and notification history will follow same atomic temp+rename, bounded retention, JSONL or JSON docs under `DATA_DIR`. Separate from 7 presentation files (see `configScope.js`). |
| Search | `server/search.js` | Extend with notification/event data, bounded, no secrets. Reuse existing index, don't create second engine. |
| Provider health | `server/providers/health.js` | Webhook provider status (configured/healthy/degraded/unavailable) will report through same provider health doc or new notifications health. |
| UI state/layout | `src/lib/api.ts` (shared query cache), `src/lib/theme.tsx`, `src/components/*` | SSE hook will use `useSharedQuery` invalidation pattern; UI uses existing visual system (chips, cards, PageHero etc). |
| Command palette | `src/components/SearchOverlay.tsx` + `src/lib/search.ts` | Add notification actions (open notifications, mark all read). No arbitrary publish commands. |
| Settings UI | `src/pages/Settings.tsx` + `src/pages/settings/*` | Add Notifications settings pane section for policies and webhook config, secrets masked. |

### What existing must NOT be changed
- Phase 10A monitoring checks, scheduler, state machine, store files, API shape.
- GHCR workflow (`/.github/workflows/ghcr.yml`) — green, leave alone.
- Seven-file presentation boundary (`configScope.js`).
- Docker mutation surface (Phase 8 allow-list only).

## 2. New modules required for Phase 10B

| File | Responsibility | Bounds |
| --- | --- | --- |
| `server/events/model.js` | Canonical Event: id (evt-uuid), timestamp, type (allow-list), severity (info/notice/warning/critical), source (monitor/alert/service/infrastructure/operation/system/auth), subject, payload (sanitized public), correlation (monitorId, incidentId, service ref, etc), metadata (safe). Validation + sanitization boundary. | Max payload size, explicit allow-list for SSE exposure. |
| `server/events/bus.js` | Internal EventBus: publish (sync, assigns id/ts), subscribe(filter?, handler), unsubscribe, bounded subscribers (max 100), bounded in-memory ring (200), failure isolation (try/catch per subscriber), loop protection (max depth 10), deterministic ordering. | No unbounded growth, no recursive amplification. |
| `server/events/store.js` | Persistent event history: atomic JSONL under `DATA_DIR/events/events.jsonl`, bounded retention (max 5000 lines, keep 4000), corruption-resistant (skip torn lines), retention by count + age (7 days). | Bounded storage, restart-safe. |
| `server/events/index.js` | Singleton wiring: loads store, creates bus, exposes `publishEvent`, `subscribeEvents`, `getRecentEvents`, `getEventById`. Bridge to activity log for meaningful types. | One instance. |
| `server/events/sse.js` | SSE transport: authenticated connections (session), explicit allow-list of event types, correct content-type, heartbeat (15s), Last-Event-ID support, bounded connections (global max 50, per-user max 10), bounded per-client queue (max 100), cleanup on disconnect, backpressure (drop oldest), graceful shutdown, secret sanitization. | No sensitive leakage. |
| `server/eventsApi.js` | `/api/events` routes: GET history (bounded, filtered), SSE endpoint `/api/events/stream`. Auth gated. | Same gate as monitoring. |
| `server/notifications/model.js` | Notification: id, eventId, timestamp, severity, source, title, message, href, read, readAt, delivery status. |
| `server/notifications/store.js` | Persistence: `DATA_DIR/notifications/notifications.json` (JSON doc, atomic), bounded (max 1000, keep 800), corruption handling, retention. |
| `server/notifications/policy.js` | Policy layer: Event → Notification filtering. Simple explicit rules: enabled, minSeverity, allowedTypes, allowedSources, browserEnabled, webhookEnabled. No rule language, no JS eval. Stored in `DATA_DIR/notifications/policy.json` or `config/settings.yaml`? Decision: store in `DATA_DIR/notifications/policy.json` to keep operational data separate, but expose via settings API. |
| `server/notifications/center.js` | Notification Center logic: create from event (idempotent by eventId), unread count, mark read, mark all read, list with filters, retention. |
| `server/notifications/providers/registry.js` | Generic provider registry: `NotificationProvider` base, `registerProvider`, `listProviders`, `getProviderStatus`. Extends existing `notify.js` concept but new generic interface. |
| `server/notifications/providers/webhook.js` | WebhookProvider: config (url, secret, enabled), validation (HTTPS by default, allow http for explicitly configured internal? Use shared ipPolicy), SSRF protection (reuse `ipPolicy`), redirect validation, timeout (5s), bounded payload (64KB), bounded response (16KB), bounded retries (max 2, exponential), no arbitrary headers, secret redaction, delivery results recorded. | Safe target validation, same security boundary as monitoring. |
| `server/notificationsApi.js` | `/api/notifications/*` routes: list, unread count, mark read, mark all read, policy get/put, webhook config get/put/test, providers status. Auth gated, CSRF for writes, secrets masked. |
| `src/lib/sse.ts` | Frontend SSE hook: authenticated EventSource with reconnection, Last-Event-ID handling, connection state, duplicate prevention via event id, fallback to polling. |
| `src/lib/notifications.ts` | Frontend notification client: unread count, list, mark read, browser notification permission handling, policy UI. |
| `src/components/Notifications.tsx` | Notification Center UI: bell indicator, list, read/unread, severity, navigation. |
| `src/pages/settings/Notifications.tsx` (extend) | Settings pane: notification center enabled, browser notifications (permission request only on user action), min severity, categories, webhook config/status, secret masked. |
| `src/pages/Activity.tsx` | Upgrade to live updates via SSE: insert new events naturally, avoid duplicates after reconnect, maintain ordering, show connection state, graceful fallback. |

## 3. Event flow

```
REAL SYSTEM EVENT (monitor state change, incident, alert, operation, infra health, etc)
        ↓
    EVENT BUS (canonical, internal, trusted producers only)
        ↓
   ┌────┴────┐
   ↓         ↓
ACTIVITY   POLICY (simple allow-list, severity filter)
   ↓         ↓
  SSE    NOTIFICATION (persistent, unread/read, bounded)
             ↓
     ┌───────┴────────┐
     ↓                ↓
  BROWSER           WEBHOOK
NOTIFICATION       PROVIDER (generic, SSRF-safe, HTTPS default, bounded)
```

Future providers (Email, Telegram, Discord, Slack) can be added as new `NotificationProvider` implementations without changing bus/policy/center.

## 4. Security boundaries

- Browser cannot publish arbitrary events: only server-side `publishEvent` (trusted) may emit.
- SSE payloads pass through explicit sanitization: strip process.env, Docker socket, tokens, passwords, cookies, session secrets, filesystem credentials, raw auth internals, provider secrets.
- Public event model exposed to browser is safe projection: id, timestamp, type, severity, source, subject, safe payload (no secrets), correlation (ids only), href.
- Webhook SSRF: reuse `lib/ipPolicy.js` — reject loopback, link-local, multicast, unspecified, reserved, documentation, benchmark, invalid. DNS resolution and redirects validated. Internal/private only if explicitly configured via settings (reuse existing mechanism for hostAddress? Or explicit allowInternal flag in webhook config, default false). HTTPS by default, http only if allowInternal true and target is internal.
- No arbitrary proxy: webhook POST only to validated URL, fixed headers, bounded sizes, timeout.
- Secrets masked in UI, never returned after save.

## 5. Retention & bounds (explicit)

| Resource | Limit | Reason |
| --- | --- | --- |
| SSE connections global | 50 | Prevent FD exhaustion |
| SSE connections per session/user | 10 | One browser tab = 1, but allow multiple tabs |
| Per-client SSE queue | 100 events | Backpressure, drop oldest |
| Event history (persistent) | 5000 lines, keep 4000 on trim, 7 days max age | Bounded storage |
| Event bus in-memory ring | 200 events | Quick replay for Last-Event-ID |
| Notification history | 1000, keep 800 | Bounded, unread preserved? Actually trim oldest regardless, but open incidents preserved in monitoring, not here. |
| Webhook payload | 64KB max | Bounded |
| Webhook response | 16KB max | Bounded |
| Webhook timeout | 5s | Fail fast |
| Webhook retries | max 2, exponential 1s,2s | Bounded, no storm |
| Webhook delivery rate | 10 per minute per webhook? Or global 30/min | Prevent spam |
| Event fan-out | synchronous, bounded subscribers 100 | No uncontrolled fan-out |
| Reconnect | exponential backoff 1s→30s, jitter | No tight loop |

## 6. Integration points

- Monitoring: in `engine.js` `record()` and `logTransitions()` publish events: `monitor.state_changed` (up→down etc), `monitor.incident.opened/recovered`, `monitor.maintenance.started/ended`. No event for every successful poll — only meaningful transitions.
- Alerts: in `alerts.js` `refreshAlerts()` publish `alert.created` / `alert.resolved` on diff (already logs to activity). Ensure idempotent.
- Operations: in `operations/engine.js` `settle()` publish `operation.completed/failed/etc` with safe projection.
- Infrastructure: in `infrastructure/state.js` and `registry.js` `noteProviderStates` publish `infrastructure.health_changed` and existing `zfs.pool.health` etc? Actually those already log to activity; we will publish canonical events for those transitions.

## 7. What is deferred (explicit)

- Email, Telegram, Discord, Slack providers (registry placeholder only)
- Autoheal/remediation (no restart, no repair)
- OpusAI (no LLM)
- File management, app deployment, reverse-proxy implementation
- WebSockets (SSE sufficient)

## 8. Testing strategy (matches task §23-24)

- Event bus: publish, subscribe, unsubscribe, ordering, subscriber failure isolation, bounded behavior, loop protection.
- Event persistence: write, reload, corruption handling, retention, restart.
- SSE: authentication, connection, event delivery, heartbeat, disconnect, reconnect, Last-Event-ID, duplicate prevention, connection limits, secret sanitization.
- Monitoring integration: UP→DOWN, DOWN→UP, incident opened/recovered, no spam for repeated UP.
- Notifications: policy filtering, unread/read, mark read, mark all read, retention, idempotency.
- Browser notifications: permission behavior, disabled state, fallback.
- Webhooks: valid public, rejected unsafe, internal/private policy, DNS validation, redirect validation, timeout, oversized response, delivery failure, secret redaction, rate limiting.
- Security: no passwords, tokens, cookies, session IDs, env vars, Docker socket paths, filesystem credentials, provider secrets in any SSE/event/notification payload.

All failure modes from §24 tested: disconnect halfway, many events quickly, subscriber throws, provider offline, webhook timeout, malformed response, DNS forbidden, redirect forbidden, duplicate event, restart, corrupted storage, denied permission, reconnect, monitoring continues while webhook failing.

## 9. Files changed (anticipated)

- New: `server/events/*` (4 files), `server/notifications/*` (5+ files), `server/eventsApi.js`, `server/notificationsApi.js`, `src/lib/sse.ts`, `src/lib/notifications.ts`, `src/components/Notifications.tsx`, `src/pages/settings/Notifications.tsx` extension, tests.
- Modified: `server/api.js` (mount new handlers), `server/index.js` (start event system, graceful shutdown), `server/monitoring/engine.js` (publish), `server/alerts.js` (publish), `server/operations/engine.js` (publish), `server/infrastructure/state.js` + `registry.js` (publish), `server/search.js` (include notifications), `src/pages/Activity.tsx` (live), `src/App.tsx` (bell indicator, SSE provider), `src/pages/Settings.tsx` (notifications tab wiring).
