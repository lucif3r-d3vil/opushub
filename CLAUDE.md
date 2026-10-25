# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpusHub is a homelab control center: a Node 22 (ESM, no web framework, only `yaml` as a server dependency) HTTP server in `server/` that serves `/api/*` plus the built React 19 + TypeScript SPA from `src/` (Vite). See `README.md` for the product pitch and `docs/` (`docs/README.md` indexes the current docs; per-phase records are in `docs/archive/`) for design rationale.

## Commands

```bash
npm install
npm run build        # vite build -> SPA served by the server
npm start            # node server/index.js (port 3000, OPUSHUB_PORT)
npm run dev          # node --watch server/index.js
npm run dev:web      # vite build --watch (run alongside `dev`)
npm run typecheck    # tsc --noEmit
npm run check        # typecheck + build
npm test             # node --test server/*.test.js server/providers/*.test.js test/*.test.js
npm run test:web     # jsdom DOM-interaction tests (test/web/tests.tsx, bundled with vite first)
npm run smoke        # SSR smoke tests of routes + hub (smoke:live for live fixtures)
npm run verify       # end-to-end against a scratch config dir/port (mock engine or real socket)
npm run mock-engine  # fake Docker engine on /tmp/opushub-mock-docker.sock
```

Run a single test file: `node --test server/phase11a-files.test.js`; a single case: add `--test-name-pattern="<name>"`.

## Architecture

**Docker is the source of truth; YAML is presentation only.** `server/discovery.js` builds the canonical inventory (normalize containers → resolve URL → join `config/services.yaml` overlay → classify). Config can rename/group/order but can never invent a service. Search, stacks, and widgets reuse this same inventory rather than reimplementing it.

**Provider contract** (`server/providers/*`): every integration returns `{provider, status: "ok"|"unavailable"|"error", reason?, checkedAt, cacheTtlMs, data?}`. The UI shows honest "unavailable" states, never fake/zero data. Public reasons must never contain socket paths, host paths, or secrets — Docker provider keeps a detailed `reason` (logs only) and a generic `public` one; only `publicStatus()` may cross `/api`.

**Read-mostly by design.** The Docker socket is mounted read-only. Mutations are (a) atomic config writes (temp+rename, previous copy kept in `data/config-backups/`) and (b) a small set of audited, confirmation-gated operations built in `server/operations/` (registry, policy, permissions, confirmation, audit, locks) and the planner/runner modules under `server/containers/`, `server/stacks/`, `server/catalog/`, `server/updates/`. Follow that pipeline (plan → confirm → run → audit) rather than adding ad-hoc write endpoints.

**Files explorer** (`server/files/`, `server/filesApi.js`) is intentionally read-only with no write endpoint. Requests name a configured root plus a relative path; resolution/containment is server-side, and `policy.js` refuses credentials/keys/session material/docker socket wherever they live. Preserve this property (see `docs/archive/17-phase-11a.md`).

**Server layout**: `server/index.js` boots the app; `server/api.js` and the `*Api.js` files hold routes per domain (monitoring, events/SSE, notifications, infrastructure, catalog, registries, etc.); domain logic lives in same-named directories. Config is handled by `configStore.js` (comment-preserving YAML), `configSchema.js`, `configScope.js`, `configHistory.js`, `configExport/Import.js`. `.env` is discovered from a documented ordered list of locations (`server/env.js`, `.env.example`); real env vars win, and `/api/health` exposes key names only, never values.

**Frontend** (`src/`): React Router pages in `src/pages`, data via a shared-poller hook (`useSharedQuery` in `src/lib/api.ts`: one poll per path, visibility-paused). The Hub is rendered by a single `HubSurface` used both live and as the Settings preview; widgets are instances resolved via a renderer registry. Charts and drag-and-drop are hand-rolled (no chart/DnD libs); styling is CSS custom properties in `src/styles/tokens.css`, no utility CSS framework.

**Tests**: colocated `server/*.test.js` named by phase (`phase10a-*`, `phase11a-files`, …) using `node:test`, plus `test/*.test.js` and fixtures. Phase tests often include "proof"/boundary tests that assert security invariants (e.g. `api-boundary.test.js`, `test/source-scan.js`); keep them passing when touching auth, operations, or files code.

Config lives in `config/` (YAML/JSON, user-editable); runtime state in `data/` (git-ignored). Docker image/compose in `Dockerfile` and `docker-compose.yml`; CI in `.github/workflows/ghcr.yml`.
