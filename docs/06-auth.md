# 06 — The door: authentication and the security model

OpusHub reads a Docker host — inventory, logs, host vitals — and writes its own presentation config.
Until Phase 4 it shipped without a door, which was only defensible on a network nobody else could
reach. Phase 4 adds one administrator account and a session cookie, in the smallest shape that is
still honest about what it protects.

## What exists

| Piece | Where |
| --- | --- |
| The account (scrypt hash + salt) and the setup state | `data/auth.json` |
| Live sessions | `data/sessions.json` |
| The gate in front of every API route | `server/api.js` (`PUBLIC_ROUTES`, one `auth.authenticate()` per request) |
| Hashing, sessions, cookies, CSRF metadata, throttle | `server/auth.js` |
| The wizard and the login screen | `src/pages/Setup.tsx`, `src/pages/Login.tsx`, gated by `src/App.tsx` |

`data/` is *runtime state*, not configuration: it is never written to `services.yaml` or
`settings.yaml`, never baked into an image, and it survives container recreation because it is a
volume. Deleting `data/` returns OpusHub to a fresh install and the wizard will run again.

## Passwords

- **scrypt** (`N=2^15, r=8, p=1`, 64-byte key, 16-byte random salt) — in Node's standard library, so
  there is no native build step and nothing to compile on any architecture.
- Stored self-describing: `scrypt$N$r$p$salt$hash`. Raising the cost later is a one-line change that
  keeps existing accounts valid.
- Verification is `crypto.timingSafeEqual`, and an unknown username is verified against a dummy hash
  of the same cost, so a wrong username and a wrong password take the same time and return the same
  sentence: *Incorrect username or password.* Nothing enumerates accounts.
- The hash never leaves the server. `publicUser()` is the only shape any endpoint can return, and
  `npm run verify` asserts that no response body contains `scrypt$` or `passwordHash`.

## Sessions

- 32 bytes from `crypto.randomBytes` (256 bits, base64url), stored server-side with `createdAt`,
  `lastSeenAt`, `expiresAt` and the client address.
- Cookie `opushub_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` **only** when the request
  arrived over TLS (`x-forwarded-proto` or a TLS socket). A plain-HTTP LAN install must keep working
  — a `Secure` cookie there would be silently dropped and look like a broken login.
- 30-day absolute expiry, 7-day idle expiry, and a cap of 50 sessions. Signing out — or a revoked
  session — kills it *server-side*; the cookie is not the authority.
- **Sign-in always mints a new id** and retires the id the request presented (when there was one), so
  a token captured before sign-in cannot be replayed after it. Signing in on a second device does not
  sign the first one out.
- Nothing is stored in `localStorage`/`sessionStorage`, and no token is put anywhere JavaScript can
  read it.

## CSRF

Four layers, all cheap, and they compose — no single one is load-bearing:

1. `SameSite=Lax` on the session cookie.
2. `Sec-Fetch-Site` must not be `cross-site` (sent by every current browser).
3. `Origin` — or `Referer` as fallback — must match the request's `Host`.
4. Bodies must be `application/json` (or empty). A cross-site `<form>` cannot send that content type,
   and a `text/plain` payload is refused with `415` instead of being parsed.

Requests with none of those headers (curl, a script, the test suite) are allowed: they carry no
cookie an attacker could abuse, and the cookie is the thing CSRF steals. `server/api.js` applies the
check to every non-GET route in one place, and cross-origin writes are logged as
`auth.csrf_blocked`.

## The login throttle (documented, deliberately not a lockout)

Failed logins get progressively slower, keyed by client address **and** username
(`server/auth.js`: `FREE_ATTEMPTS = 4`, `MAX_DELAY_MS = 30s`, `FAIL_WINDOW_MS = 15min`):

- The first four failures are answered immediately.
- After that the wait doubles (1s, 2s, 4s, 8s, 16s, 30s…) up to a **30-second ceiling**.
- A pending wait longer than a second is reported as `429` with a `retry-after` header instead of
  being silently slept through; shorter ones are simply delayed.
- It is a **delay**, never a refusal: the correct password still works, and the window expires
  **15 minutes** after the last failure. Nothing is stored on disk, so a restart clears it too.
- It never covers the whole install: a different address is unaffected, so a homelab admin cannot be
  locked out of their own Hub by an attacker (or by their own typo) permanently.
- A successful sign-in clears the counter for that client + username.

There is intentionally no account lockout, no captcha, no e-mail reset. Recovery from a forgotten
password is a host-level action (see below), which is exactly the trust level of somebody with the
data volume in front of them.

## Setup lifecycle

- `/api/setup/status` is public and answers `required`/`complete`/`hasAccount`. **Before** an account
  exists it also includes a *count-only* discovery summary (Docker state, counts, URL verdicts) so
  the wizard can show what the engine sees; container names, images and URLs never leave the server
  pre-auth. **After** setup that summary is not returned at all.
- `POST /api/setup` creates the account and signs it in. It refuses to run twice (`409`) — the wizard
  disappears behind the gate and cannot be reached again.
- It is a bootstrap endpoint, not a maintenance one: there is no user creation, no password change
  and no public re-init API. A future "reconfigure" affordance is expected to be a host-level action
  (or an authenticated route added deliberately), never a public endpoint.
- **Forgotten password recovery:** stop the container, remove `data/auth.json` (keep the rest of
  `data/` if you like — sessions live in a different file), start it again and open the wizard. This
  is a deliberate root-equivalent operation on the host; nothing else can reset the account.

## What is public, and what is not

Public: `GET /api/health` (liveness only — no paths, no provider internals, no env values),
`GET /api/setup/status`, `POST /api/setup`, `GET /api/auth/me`, `POST /api/auth/login`,
`POST /api/auth/logout`. The SPA shell itself is public, because it contains no data: it renders the
wizard, the login screen, or the app depending on what the API says.

Everything else — services, stacks, system, activity, Docker status, logs, settings, layout,
bookmarks, custom assets, icons, discovery, providers — requires a session, unknown `/api/*` paths
included (a 401, not a 404, so routes cannot be enumerated anonymously).

Custom assets (`/user/theme.css`, `/user/app.js`, `/user/icons/*`, `/user/backgrounds/*`) are gated
too: they are user content served from the config volume, and a background or a stylesheet is as much
"the state of this host" as the service list. A signed-out browser cannot fetch them.

## Review notes (Phase 4)

Checked, with the tests that pin each one:

| Area | Result |
| --- | --- |
| Session fixation | New id per sign-in; the presented id is destroyed (`server/api-auth.test.js`) |
| Session entropy | 32 random bytes; ids are never derived from user input |
| Cookie flags | HttpOnly + SameSite=Lax + Path=/, `Secure` over TLS, `Max-Age=0` on logout |
| Hashing | scrypt with per-account salt; self-describing parameters; `verify` fails closed on garbage |
| Timing-safe verification | `crypto.timingSafeEqual` + dummy hash for unknown users |
| Brute force | Delay-only exponential throttle, expires, per client+username, never a permanent lockout |
| Login error leakage | One sentence for both failure modes; identical status and body |
| Setup endpoint abuse | Cannot run twice; count-only summary pre-auth; no names pre-auth |
| CSRF / Origin | Four layers (see above); cross-origin writes refused and logged |
| API auth | One gate, complete route list, 401 for unknown API paths |
| Static user assets | Session-gated (`/user/*`), including theme/app.js/icons/backgrounds |
| Custom JS | Opt-in only (`advanced.customJs`); served same-origin from the config volume — as privileged as the app itself, by design |
| Log access | Session-gated; log lines are rendered as text by React, never as markup |
| Docker socket | Mounted `:ro`, used read-only, no exec/restart/create/delete anywhere (pinned by `server/api-boundary.test.js`) |
| Path traversal | `/user/*` goes through `safeJoin`; config file names are an allowlist |
| SSRF | The server fetches a fixed set of hosts: Open-Meteo, Stooq and `api.iconify.design`. The one exception is the **admin-configured** RSS feed list in `settings.yaml` — those URLs are fetched as given (following redirects, 9s timeout). Anyone who can write your config can already reach your network, but that is the boundary to know about |
| XSS / CSP | React escaping throughout, and the only `dangerouslySetInnerHTML` in the app is the icon SVG, which is `sanitizeSvg`-filtered server-side (script/foreignObject/`on*`/`javascript:` stripped) for bundled, remote and user files alike. CSP in `server/index.js`: `default-src 'self'`, `script-src 'self' 'sha256-…'` (the one pre-hydration theme script), `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `connect-src 'self'`, plus `x-frame-options: DENY` |
| Uploaded/user assets | `config/icons/*` and `config/backgrounds/*` are served from the config volume behind a session, through `safeJoin` (no `..` traversal, no path outside the two directories), with `x-content-type-options: nosniff` |
| Secret leakage | `.env` values stay server-side; container env is stripped; `/api/health` reports key names only |

**Non-goals.** OpusHub is not an identity provider: one account, no roles, no OAuth, no audit trail
beyond the Activity log. It is meant for a LAN or a VPN — see `docs/07-distribution.md` for why port
3000 should never be published to the Internet.
