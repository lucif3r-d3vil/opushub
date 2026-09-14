# Phase 5 — Operations & Control-Plane Polish: audit + implementation plan

Status: **plan, written before any Phase 5 code.** Baseline is the merge commit of PR #10:
`4dccd791e3c17ac2ab1a3fbe79dd1bee1bcfcc74` (`Merge pull request #10 from
lucif3r-d3vil/arena/01a0a0de-opushub`), which is exactly `origin/main`. Working tree clean, no
untracked files, all six gates green before a line was changed
(`npm test` 277/277 · `typecheck` · `build` · `verify` 62/62 · `smoke` · `test:web` 29/29).

The Yahoo Finance v8 provider introduced in PR #10 is **kept as-is**. It is not researched,
replaced or touched in this phase beyond not regressing it (there is a regression test for the
symbol contract and the `unavailable` wording).

## 1. What already exists (do not rebuild)

Phase 4 (PR #7, plus #8/#9 fixes) landed authentication, the first-run wizard, generic discovery
and GHCR distribution. Phase 3 (PR #6) landed read-only service intelligence. Phase 2 (PR #5)
landed the Hub composition, command overlay, icon browser and templates. The audit below is
against the actual code, not against the phase briefs.

| Phase 5 workstream | Already implemented | Real gap |
| --- | --- | --- |
| 1 · Auth hardening | admin creation, login, logout, server-side sessions, HttpOnly/SameSite/Secure cookies, 30d absolute + 7d idle expiry, 4-layer CSRF, one gate over every non-public route, `publicUser()` (hash never leaves), 401 for unknown API paths, `authenticate()` never throws, throttle | **no password change**, **no session inventory/revocation**, session file re-read synchronously on *every* request |
| 2 · Setup wizard | 5 steps (Welcome/Administrator/Environment/Discovery/Finish), count-only pre-auth discovery summary, entrypoint port mapping, host address | brief asks for **6 steps** incl. a post-creation Finish screen, Docker **API version**, and an explanation of **why** a service has/hasn't a URL (currently a bare count) |
| 3 · Service detail | identity, container name, compose project, image + tag + digest, state, health (with failing streak), uptime, restarts, CPU/memory/net/block-IO, ports (published vs exposed), networks, mounts, URL + source + reasoning, logs drawer, change history + state strip | curated **labels** view, **resource history** beyond a 22px sparkline, some "Not available" cases are blank instead of explicit |
| 4 · Stack detail | container/running/stopped/unhealthy/attention counts, aggregate CPU + memory, per-member health, member networks/ports/volumes, recent activity, links into service detail | **aggregate network I/O**, **stack uptime**, **resource history**; the server does N inspect + N stats calls per load with unbounded concurrency and bypasses the shared stats sampler (**N+1**) |
| 5 · System page | CPU/per-core/load/frequency/temp, memory + swap, disks, network + link rates, uptime, host block, 15m/1h/6h/24h windows, ResizeObserver-measured charts | **Docker/provider health is absent from the System page** (it lives in Settings → Environment), load has no history series |
| 6 · Activity | append-only JSONL, 5 000-line cap, signature dedupe, burst grouping, `grouped=1`, `before=`, `source=` filter, `watchingSince`, container appear/disappear/start/stop/health, stack appear/removed, provider transitions, auth events, config writes | **no service / stack / event-type / time filtering**, and the client only has the source chips |
| 7 · Command palette | ⌘K + `/`, grouped results, arrow/Enter/Esc, direct navigation to Hub/Services/Stacks/System/Activity/Settings, theme toggle, service/stack/bookmark/page/setting/news search | **activity is not searchable**; no command-palette affordance for the new Settings panes |
| 8 · Settings | 11 tabs incl. live preview on 5 of them, groups, service overrides, bookmark groups, widgets, templates, icon browser, background handling, markets, custom CSS/JS | target sections ask for **General** + **Authentication** + a grouped nav; `system` tab is really "Environment" |
| 9 · Homepage compatibility | groups, services, bookmarks, widgets, icons, backgrounds, custom CSS/JS all present; overlay-can't-create rule enforced in `discovery.js` and tested | nothing user-visible says so, no dedicated compatibility summary, thin regression coverage on the "never a phantom" rule for *presentation* files |
| 10 · Visual/UX | design system doc, measured charts (no overlap), keyboard sortable, focus rings, reduced motion, responsive bands at 860/900/980/1080/1180 | a few gaps: nav has no section grouping, some empty/loading states are one-word, activity filters overflow on mobile |

## 2. Architectural constraints (unchanged, restated)

Docker Engine stays the source of truth for *what exists*; the canonical discovered inventory stays
the single service/stack model; `services.yaml` / `stacks.yaml` / `layout.json` / `settings.yaml`
stay a presentation overlay that can never invent an object; automatic Docker, Compose and Traefik
discovery is preserved; URL precedence and URL-source transparency are preserved. OpusHub remains
strictly read-only against Docker — no restart, stop/start, exec, create/delete, no shell, no
socket in the browser, no fake production data, no generic proxy. Security model and visual
language are preserved.

## 3. Plan (workstream → change → test)

1. **Auth** — `POST /api/auth/password` (current password required, new hash, other sessions
   revoked, current session re-minted), `GET /api/auth/sessions` (opaque derived ids, *never* the
   token), `POST /api/auth/sessions/revoke` (`{scope:'others'|'all'}`); move sessions to an
   in-memory store with debounced atomic persistence (one file read per process, not per request);
   Settings → Authentication pane. Tests: password change round-trip, wrong current password,
   session revocation, no token/hash in any response, throttle reset, malformed/expired sessions,
   secret-free activity lines.
2. **Setup wizard** — six steps; Environment step gains Docker API version and a *reason-category*
   breakdown of URL resolution (counts only — no container names pre-auth, which the existing
   contract forbids); Review step recaps; Finish step is a real screen shown after the account is
   created, before entering the app. Tests: fresh-install state machine, count-only payload,
   `409` on second run, no names pre-auth.
3. **Service detail** — curated labels block (allow-list only), bounded session history chart from
   the existing sample buffer, explicit unavailable wording everywhere.
4. **Stack detail** — aggregate network I/O, stack uptime (oldest running member), per-member and
   aggregate history from the *shared* stats sampler, explicit "compose project ≠ presentation
   group" note. Server: bounded-concurrency enrichment (4 at a time), inspect only running
   members, reuse `statsWithHistory` (single-flight + 3 s cache) instead of raw `containerStats`.
5. **System** — provider health band (Docker + the registry) and a load history series.
6. **Activity center** — server-side filters (`service`, `stack`, `type`, `since`), client filter
   row (service/stack/type/time) with removable chips.
7. **Command palette** — activity results (`kind: 'activity'`), the new Settings destinations,
   shortcut hints; still no destructive command.
8. **Settings** — `general` and `authentication` panes; grouped nav (General · Appearance ·
   Services · Groups · Bookmarks · Widgets · Integrations · Authentication · Environment ·
   Advanced); `system` kept as an alias of `environment`. Everything existing is preserved,
   including live preview, groups, overrides, bookmarks, widgets, icons, background, markets and
   custom CSS/JS (markets regression-tested).
9. **Homepage compatibility** — compatibility summary in Settings → Environment and a
   regression suite proving presentation files cannot create infrastructure objects.
10. **Visual/UX** — grouped settings nav, mobile filter row, loading/unavailable wording,
    `focus-visible` audit; no redesign.

Performance and security audits run in the same commits: no new Docker write path, no shell, no
arbitrary proxy, no SSRF, no secret in a response or a log line, bounded retention everywhere.

**Not claimed:** validation against the real OpusGrid host. The Arena environment has no access to
the real Docker engine, so every Docker-shaped assertion runs against `test/mock-engine.js`. The
real installation is not modified, deployed to, or contacted.
