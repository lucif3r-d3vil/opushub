# Phase 11A — File Manager: Read-Only Filesystem Explorer + Controlled Privilege Elevation

> Status: Part 1 is the pre-implementation audit (written before any code changed). Part 2 records
> the implementation, Part 3 the final security review.
>
> Scope: **read-only**. Phase 11B (mutation: delete / rename / move / copy / upload / mkdir /
> chmod / chown) is explicitly *not* part of this phase, and nothing here is shaped to make a
> mutation route easy to add by accident.

---

## Part 1 — Repository audit (before any code change)

### 1. Existing filesystem capabilities

What OpusHub can already see of a filesystem, and — just as important — what it deliberately
cannot:

| Capability | Where | What it actually does |
|---|---|---|
| Mount enumeration | `server/providers/storage.js#LinuxFilesystemProvider` (`id: 'filesystem'`) | Reads `/proc/mounts`, keeps only real filesystem types (`REAL_FS`), drops `/proc /sys /dev /run /etc /snap /usr /nix` and tmpfs (except `/dev/shm`), `statfs` each, drops mounts < 128 MB, returns `{ mount, device, fs, total, used, free, usedPct }` |
| ZFS pools / datasets | `server/providers/zfs.js` behind `storage.js#ZFSProvider` | `zpool list` / `zfs list` through a **frozen command table**; datasets carry `mountpoint`, `used`, `available`, `referenced`, `quota` |
| Storage domain document | `server/infrastructure/opusgrid.js#storageDocument` | Assembles filesystems + ZFS into the Phase 9 storage domain; feeds `/api/storage`, `/api/infrastructure/storage`, alerts, topology |
| Provider registry | `server/infrastructure/registry.js` | TTL cache, single-flight, honest `available`/`unavailable`, public-safe error reasons |
| Docker volumes | `server/providers/docker.js#listVolumes` | Names, driver, scope, refCount, size — **mountpoints are deliberately not projected** ("no arbitrary filesystem locations") |
| Container bind sources | `server/providers/docker.js#inspectContainer` → `mounts[]` | `{ type, source, target, rw }` — the one place a host path legitimately crosses the boundary today |
| Config/data file I/O | `server/configStore.js`, `server/lib/atomicFile.js`, `activity.js`, `events/store.js`, `monitoring/store.js`, `updates/store.js`, `notifications/store.js`, `registries/store.js`, `operations/audit.js` | OpusHub's *own* files, inside `CONFIG_DIR` / `DATA_DIR`, by name from a fixed allow-list |
| Static user assets | `server/index.js#serveFile` + `safeJoin(root, rel)` | `/user/icons/*`, `/user/backgrounds/*`, `dist/*`; session-gated; `safeJoin` is a lexical containment check only (no realpath, no symlink defence) |
| Icon files | `server/providers/icons.js#listLocalFiles` | `CONFIG_DIR/icons` filtered to image extensions |
| Path-ish validation elsewhere | `configSchema.js#safeIcon` (refuses anything but `/user/icons/<file>`, traversal-checked), `monitoring/store.js` (filename allow-list), `infrastructureApi.js#sanitizeName` (bounded, no `..`, no shell metacharacters, re-checked against provider-discovered names), `containers/policy.js` (`BLOCKED_HOST_PATHS`, `SENSITIVE_HOST_PATHS`) |

**Findings that shape the phase:**

1. **There is no directory-listing capability at all.** Nothing in the server enumerates a
   directory the browser names. The closest thing (`safeJoin`) is a lexical prefix check used for
   two fixed static roots; it has no realpath step, so it would not survive being pointed at a
   host tree with symlinks in it. It is not a filesystem provider and must not be stretched into
   one.
2. **The "existing filesystem provider" is a mount/usage provider, not a file provider.** The
   honest reading of "reuse the existing infrastructure/filesystem provider where appropriate" is
   therefore: reuse `LinuxFilesystemProvider` (+ the ZFS provider) as the **source of roots and of
   storage context**, and add the missing *file* operations behind one new canonical contract.
   Building a second, unrelated mount reader would be the duplication; building the file
   operations that do not exist is not.
3. **`containers/policy.js` already owns the "paths that hand over the host" vocabulary**
   (`BLOCKED_HOST_PATHS`: docker/containerd sockets and directories, `/proc`, `/sys/fs/cgroup`,
   `/boot`, `/etc/shadow`, `/etc/sudoers`, `/etc/ssh`, `/root/.ssh`). Phase 11A imports it rather
   than restating it — one deny-list, two consumers.
4. **The command-running boundary is closed by a mechanical proof.** `phase9-security.test.js`
   asserts the set of server modules importing `node:child_process` is exactly
   `{providers/zfs.js, version.js}`, and `phase8-proof.test.js` bans `spawn/exec/execFile/fork`,
   `eval`, `new Function` and even the literal `/exec` in every server module. **A sudo-based or
   shell-based elevation broker is therefore not implementable in this phase without dismantling
   an existing proof** — which the brief forbids. That decides the broker design (§6).
5. **`/api/v1` is an allow-list** (`api.js#V1_ROUTES`): a versioned route exists only if it is
   listed. New file routes must be added there explicitly.
6. **`api.js` has one auth gate in front of everything** (`PUBLIC_ROUTES` + `auth.authenticate` +
   `auth.csrfCheck` for unsafe methods). `phase9-security.test.js` freezes the exact set of
   non-GET routes *in api.js*; sub-handlers (`operationsApi`, `registriesApi`, `stacksApi`, …) own
   their own routes behind that same gate. Phase 11A follows the sub-handler pattern, so the frozen
   api.js list is untouched.

### 2. Reusable primitives (reused, not duplicated)

| Primitive | Use in Phase 11A |
|---|---|
| `server/api.js` session + CSRF gate, `send()`, `V1_ROUTES`, sub-handler delegation | the Files routes sit behind the same door; no new authentication concept |
| `auth.sessionHandle(token)` | binds a download/preview token to a *session*, without ever carrying the token |
| `operations/permissions.js` (`PERMISSIONS`, `ROLES`, `can()`, `resolveRole()`) | `files.read`, `files.download`, `files.search` (+ `files.privilege.request`); role resolved server-side from the session username; fail-closed to `viewer` |
| `operations/confirmation.js` (token minting/spending shape) | the *pattern* for `files/tokens.js`: opaque random token, only its hash stored, bound to session + target + operation, short TTL, swept, capped |
| `operations/audit.js` + `activity.js#logEvent` (signature dedupe) + `events/index.js#publishEventSafe` | the only audit trail. No second audit system; security-relevant file events are activity rows and bus events |
| `events/model.js` (`SEVERITIES`, source allow-list, type grammar, forbidden payload keys) | gains the `files` source; the forbidden-key filter already stops `token`/`secret`/`env`/`socketPath` from reaching a browser |
| `providers/storage.js#LinuxFilesystemProvider`, `providers/zfs.js` | root discovery and read-only storage context (mount / dataset) |
| `providers/docker.js#listContainers/inspectContainer` (read-only, GET-only by proof) | read-only container-bind context for one path, on demand, bounded and cached |
| `containers/policy.js#BLOCKED_HOST_PATHS / SENSITIVE_HOST_PATHS` | the host-path deny/sensitive vocabulary |
| `lib/cache.js#TimedCache`, `lib/atomicFile.js` | TTL caches; any persisted broker state at 0600 |
| `errors.js` shape (`{ status, code, reason }`) and the API's `{ error, code }` convention | every refusal is a stable code the UI switches on |
| UI: `components/ui.tsx` (`PageHero`, `Loading`, `ProviderNote`, `Modal`, `Menu`, `MenuButton`, `Segmented`, `SectionHead`, `Freshness`), `lib/api.ts` (`usePolled`, `api`, `invalidateShared`), `lib/format.ts` (`bytes`, `relTime`), design tokens | the Files page is built from the existing primitives; no new design language |

### 3. New modules required

```
server/files/limits.js      frozen bounds: entries, preview bytes, search scope/depth, timeouts, path shape
server/files/roots.js       the filesystem-root policy: which roots exist, their ids, their sensitivity
server/files/policy.js      THE canonical path policy: protected/sensitive classification + resolution
                            (traversal, encoding, null bytes, separators, realpath containment, symlink
                            and bind/mount escape). One implementation, used by every file route,
                            by the provider and by the broker.
server/files/provider.js    the FilesystemProvider contract + LocalFilesystemProvider
                            (list / stat / read / download / search / resolve), read-only
server/files/preview.js     server-side content detection (magic bytes first, extension second) and
                            the bounded preview projection
server/files/tokens.js      server-minted file references (session-bound, path-bound, operation-bound,
                            expiring) for downloads and inline previews
server/files/context.js     read-only storage awareness for one path: mount · ZFS dataset · container bind
server/files/broker.js      the privileged filesystem broker: fixed operation vocabulary, request →
                            authorization → path policy → operation-specific approval → grant with
                            expiry → audit. No provider is configured by default, so it refuses
                            honestly instead of faking elevation.
server/filesApi.js          the /api/v1/files/* routes (mounted in api.js behind the existing gate)
server/phase11a-files.test.js   the phase test suite
src/pages/Files.tsx         the File Manager page (explorer, tree, breadcrumbs, listing, preview, properties)
src/lib/files.ts            the client-side document types + small helpers (path/breadcrumb/sort logic)
src/styles/pages.css        a `.fm-*` section (the existing token/variable system, no new design language)
```

Touched, not replaced: `server/api.js` (delegation + `V1_ROUTES`), `server/operations/permissions.js`
(new permission strings), `server/activity.js` (a `files` category), `server/events/model.js` (a
`files` source), `server/search.js` (Files as a destination), `src/App.tsx` (nav item + route),
`src/lib/types.ts` (types + `EventCategory`), `src/pages/Activity.tsx` (the new area filter),
`test/web/tests.tsx` (nav contract 7 → 8 items + Files checks), `src/ssr-smoke.tsx` (route),
`server/phase7-proof.test.js` (one documented deny-list exemption, see §4), `.env.example`,
`docs/`, `README.md`.

### 4. Security boundaries

The boundary Phase 11A has to hold, stated as invariants (each one becomes a test):

1. **No host path is ever accepted from the browser.** A request names `root=<rootId>` (an id from
   the server's own root table) and `path=<relative>` (a root-relative path). Absolute paths,
   drive-like prefixes and unknown root ids are refusals, not inputs.
2. **One canonical path policy.** Every read — list, stat, preview, download, search, context,
   permission-status, broker — resolves through `files/policy.js#resolve()`. Nothing else in the
   server computes a filesystem path from request data. The broker revalidates independently:
   a grant is not a path bypass.
3. **Resolution is server-side and realpath-based.** Lexical containment is only the first check;
   the resolved target's `realpath` must still be inside the root's `realpath`. `/tank/media/link →
   /etc` makes `/tank/media/link/passwd` resolve to `/etc/passwd`, which is outside the root →
   `symlink_escape` (403). A symlink *inside* the root that stays inside the root is fine and is
   reported as a symlink with its target.
4. **Bind/mount escapes are refused too**, and realpath cannot see them: `/proc/self/mountinfo` is
   read once (cached) to find mount points inside exposed roots; a mount whose filesystem type is a
   kernel/pseudo type, or whose mount *source root* is under a denied prefix (the classic
   `bind /etc → /tank/etc`), extends the deny-list. The mount table is used for policy only; it is
   never served to the browser.
5. **Roots are a policy decision, never `/`.** Roots come from explicit configuration
   (`OPUSHUB_FILES_ROOTS`) or, when unset, from the *existing* filesystem provider's real mounts —
   minus `/`, minus denied system prefixes, minus OpusHub's own `CONFIG_DIR`/`DATA_DIR`, minus
   anything that resolves into a protected path, minus duplicates by realpath. A root must be a
   real directory that is not a symlink. The UI shows only what the policy exposes.
6. **Protected content is refused by the server, not hidden by the UI.** Protected entries are
   omitted from listings (with an honest `hidden` count) and refused for stat/preview/download with
   `protected_path`. Classes: kernel pseudo-filesystems (`/proc /sys /dev /run`), Docker/containerd
   sockets and state, OpusHub's own config and data directories (account, sessions, registry key,
   Telegram token, activity/event stores), environment files, SSH/GPG/cloud/registry credential
   stores, password and sudoers databases, private keys and keytabs, session/token files.
7. **Sensitive content is allowed but audited.** Database dumps, backups, certificates/keys that are
   the operator's own, `secrets.*`, `password*`, `*.ovpn`: readable, and a download or preview
   writes one deduplicated security activity row.
8. **Reads are bounded.** Entry caps, preview byte caps, search node/depth/match caps, deadlines and
   request-driven cancellation. Downloads stream; nothing multi-gigabyte is ever buffered.
9. **No execution, no rendering of active content.** Previews are text (React-escaped), images or a
   PDF opened by the browser in its own viewer. HTML/SVG are shown as *text*, never rendered; the
   raw-byte route sets `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`,
   `Cache-Control: no-store` and a `Content-Disposition` the server chose.
10. **No shell, no sudo, no child_process, no Docker socket access** — enforced by the existing
    mechanical proofs, which this phase extends rather than relaxes (§6).
11. **Downloads are tokenised.** `GET /api/v1/files/download?root=&path=` mints a token and
    redirects; the bytes only ever flow from `?token=`, which is bound to the session handle, the
    canonical path, the root, the operation and an expiry. A preview token cannot download and a
    download token cannot preview.
12. **Browsing is quiet.** Directory listings, stats and ordinary previews write no activity rows.

**One existing proof needs a documented amendment.** `phase7-proof.test.js` fails any server module
that *names* a socket path, with one exemption: `containers/policy.js`, which names it in order to
refuse it, and is asserted to contain no transport. `files/policy.js` is in exactly that position —
it imports `BLOCKED_HOST_PATHS` and adds a small number of its own protected literals. The
exemption set gains `server/files/policy.js` with the *same* assertion (no `node:net`, no
`node:http`, no `socketPath`, no `request(`, no `fetch(`), so the proof still means what it says:
naming a path to refuse it is allowed, opening one is not.

### 5. Root policy design

```
Root {
  id            'tank', 'opt-stacks'          stable slug of the path; URL-safe; validated on input
  label         '/tank'                       what the UI shows (the operator's own mount point)
  path          realpath of the mount         resolved once, at policy build; never a symlink
  source        'configured' | 'discovered'   which half of the policy produced it
  fs, device, total, used, free, usedPct      from the existing filesystem provider, when it has them
  dataset       { pool, name } | null         ZFS dataset mounted here, when there is one
  sensitive     bool                          a root that needs the stronger read permission
  readable      bool                          can OpusHub's own process list it right now
  reason        string | null                 honest sentence when it cannot
}
```

Sources, in precedence order:

1. **Explicit configuration** — `OPUSHUB_FILES_ROOTS=/tank:/opt/stacks` (documented in
   `.env.example`; env is the existing place host-access configuration lives, and unlike
   `settings.yaml` it cannot be edited from the browser, which is the right property for a
   filesystem root). Each entry is validated by the same policy that validates a discovered root;
   an invalid entry is dropped with a reason, never half-honoured.
2. **Discovery from the existing provider** — when nothing is configured, the real mounts
   `LinuxFilesystemProvider` reports become candidate roots. This is what makes a bare-metal
   install useful with no configuration and what keeps `/tank` and `/opt/stacks` (the operator's
   real mounts) available without hardcoding them.

Never a root: `/` (or anything whose realpath is `/`), a denied system prefix, a symlink, a
non-directory, a path inside another exposed root (deduplicated by realpath, deepest wins for
nesting), OpusHub's `CONFIG_DIR` / `DATA_DIR`, and anything unreadable *as a root* (a mount that
exists but cannot be listed is still shown, with `readable: false` and a reason, so the UI can say
"Permission required" instead of pretending the mount is not there).

`sensitive` roots — a root whose realpath is under a `SENSITIVE_HOST_PATHS` entry (`/etc`, `/root`,
`/home`, `/var`, …) — require `files.read_sensitive` in addition to `files.read`. Only the
administrator role carries it today; the reserved `operator` and `viewer` roles carry no files
permission at all, so filesystem access is not handed to every authenticated role by construction.

Root isolation: a path is always resolved against **one** root's realpath, and the containment
check is against that same realpath. There is no route that takes two roots, no "mount this root
under that root", and no way to name a root by path — so cross-root access is not expressible.

### 6. Privilege broker design

The brief's chain, and where each link lives:

```
Browser
  ↓  POST /api/v1/files/privilege/request { root, path, operation }   ← authenticated session (api.js gate)
filesystem authorization   files/permissions: can(actor, FILES_PRIVILEGE_REQUEST) + root sensitivity
  ↓
path policy                files/policy.js#resolve() — revalidated here, independently of the read that failed
  ↓
privileged broker          files/broker.js — fixed operation vocabulary, grant store, expiry, audit
  ↓
fixed read operation       the provider's list/stat/read for that one path, under an active grant
  ↓
host filesystem
```

* **Fixed operation vocabulary.** `OPERATIONS = Object.freeze(['list', 'stat', 'read'])` — the three
  read operations Phase 11A has. There is no `exec`, no `shell`, no `sudo`, no `write`, no
  free-form operation string: an unknown operation is a 400 before anything else happens. The
  browser may select only `{ root, path, operation }` and (for `read`) an approved byte range
  inside the preview cap. It may never select an executable, arguments, a shell, an environment or
  a filesystem root.
* **A provider slot, not a shell.** The broker executes an approved request through a *registered
  privileged provider* — an object implementing the same read contract at higher privilege.
  `registerPrivilegedProvider()` is server-side only (no route reaches it) and, in this phase,
  **nothing registers one**: there is no safe host-side broker that can be built without either
  `child_process`/sudo (banned by the standing proofs and by this brief) or a setuid companion that
  does not exist in this repository. So the default answer to a request is
  `{ status: 'unavailable', code: 'no_privileged_provider', reason: '…' }`: the request is
  authorized, path-validated, **recorded and audited**, and then honestly refused. Nothing is
  granted, and no read is retried at higher privilege.
* **No faked elevation.** A grant exists only if a registered provider confirmed it
  (`provider.grant()` → `{ grantId, expiresAt }`); `permission-status` reports
  `provider: null, grants: 0, state: 'permission_required'` otherwise, and the UI says
  "OpusHub cannot elevate on this host" rather than implying access was obtained. The phase test
  injects a *test-double* provider to prove the machinery (independent path revalidation, grant
  expiry, session binding, denial, audit) and asserts that with no provider registered nothing is
  granted and no read succeeds.
* **Approval is operation-specific and expiring.** A grant is `{ rootId, canonicalPath, operation,
  sessionHandle, actor, issuedAt, expiresAt }`, single operation, single path (never a subtree
  wider than the requested path), TTL-bounded, swept, capped in size, and retired on logout of the
  session that holds it. Grants live in memory (like confirmations): a restart invalidates them.
* **Audit.** `files.privilege.requested` / `.granted` / `.denied` / `.unavailable`,
  `files.protected_path` (an attempt at a protected path) and `files.download.sensitive` are
  activity rows (deduplicated by signature) and bus events with source `files`. Ordinary browsing
  writes nothing.
* **EACCES handling on the normal path.** A read that fails with `EACCES`/`EPERM` returns the
  structured refusal `{ code: 'permission_required', root, path, operation }` (HTTP 403). It never
  shells out, never elevates the OpusHub process, never re-mounts anything, and never falls back to
  a wider root.

### 7. API design

All routes: authenticated session (the api.js gate), GET-only except the one privilege request,
listed in `V1_ROUTES`, handled by `server/filesApi.js`.

```
GET  /api/v1/files                             the surface: roots, limits, permissions, broker state
GET  /api/v1/files/roots                       the exposed roots only (ids, labels, readability)
GET  /api/v1/files/list?root=&path=            directory listing: entries (root-relative), counts,
                                               hidden count, truncation, sort/limit applied server-side
GET  /api/v1/files/tree?root=&path=            one level of the sidebar tree (bounded, lazy)
GET  /api/v1/files/stat?root=&path=            file properties (+ storage context)
GET  /api/v1/files/context?root=&path=         read-only storage awareness: mount · dataset · container bind
GET  /api/v1/files/preview?root=&path=         bounded preview document (server-detected kind)
GET  /api/v1/files/search?root=&path=&q=       bounded filename/metadata search
GET  /api/v1/files/permission-status?root=&path=   readable | permission_required | protected | …
GET  /api/v1/files/download-token?root=&path=  mint a download reference (JSON, for the UI)
GET  /api/v1/files/download?root=&path=        mint + 302 to the token form (browser-friendly)
GET  /api/v1/files/download?token=             the bytes, streamed
GET  /api/v1/files/raw?token=                  inline bytes for an image/PDF preview (sandboxed headers)
POST /api/v1/files/privilege/request           { root, path, operation } → broker answer (audited)
```

There is deliberately **no** `POST /api/files { operation, path }`: the operation is chosen by the
route, and the only POST in the namespace takes an operation from a frozen three-word vocabulary
that the broker revalidates against the path policy.

Error vocabulary (stable codes the UI switches on): `auth_required` 401 · `not_permitted` 403 ·
`bad_request` 400 · `unknown_root` 404 · `bad_path` 400 (traversal, encoding, null byte, separator,
depth, length) · `protected_path` 403 · `symlink_escape` 403 · `mount_escape` 403 ·
`root_isolation` 403 · `not_found` 404 · `not_a_directory` 400 · `permission_required` 403 ·
`too_large` 413 · `unsupported_preview` 415 · `token_expired` / `token_invalid` / `token_session` /
`token_mismatch` 403 · `no_privileged_provider` 501 · `method_not_allowed` 405.

### 8. UI design

`/files` → **File Manager**, added to the primary navigation between System and Activity:

```
Hub · Services / Containers · Stacks · Monitoring · System · Files · Activity · Settings
```

Global actions unchanged (Search · Notifications · Dark/Light · Logout).

Layout — an explorer, built from the existing primitives and tokens:

```
PageHero "File Manager"      roots exposed · read-only · updated …        [Refresh]
├ toolbar   [←] [→] [↑] [⟳]  breadcrumb: tank ▸ media ▸ photos   location bar [Go]   [search]
├ body      ┌ sidebar tree ─┐ ┌ listing ─────────────────────────────────────────────┐
│           │ ▸ /tank       │ │ Name        Size   Type    Modified   Permissions  Owner │
│           │   ▾ media     │ │ ▸ photos     —     Folder  2 h ago    drwxr-xr-x   nora  │
│           │     photos    │ │   IMG_01.jpg 4 MB  JPEG    yesterday  -rw-r--r--   nora  │
│           │ ▸ /opt/stacks │ └──────────────────────────────────────────────────────┘
│           └───────────────┘  selection → properties panel / preview / download
```

* **Navigation:** breadcrumbs (each crumb a link), back/forward (an in-page stack reconciled with
  the router history, so the browser's own back/forward also works), up, refresh, and an editable
  location bar that accepts a root-relative path and refuses anything else the same way the server
  does (with the server's sentence). The URL (`/files?root=&path=`) is the state, so a folder is
  linkable and reloadable.
* **Listing:** sortable columns (name · size · type · modified · permissions · owner), folders
  first, keyboard navigable, single/multi/range selection, double-click or Enter to open.
* **States:** loading (`Loading`), empty folder, no roots exposed (what to configure, honestly),
  permission-required (the panel below), protected path, error (`ProviderNote status="error"`),
  truncated listing ("showing the first N of more").
* **Permission required:**
  > **Permission Required** — OpusHub does not currently have permission to read this location.
  > `[ Request Access ]`
  and, because this phase does not fake elevation, the honest outcome of that request:
  "Request recorded. This host has no privileged broker provider, so OpusHub cannot elevate —
  nothing was granted."
* **Preview:** a `Modal` — text/JSON/YAML/Markdown/log in a mono box (truncated, with the byte
  count and a "download the whole file" action), images inline from the token'd raw route, PDFs as
  "open in a new tab" (never embedded in the OpusHub origin), HTML/SVG as escaped text with a note
  that it is not rendered.
* **Properties:** name, canonical path, type, size, modified, permissions (symbolic + octal),
  owner/group (names where the host resolves them, ids always), directory/file/symlink, symlink
  target *only when it stays inside the root*, and read-only storage context (mount, ZFS dataset,
  container bind).
* **Responsive:** ≥1100 px sidebar + full table; tablet collapses the owner/permissions columns;
  ≤860 px the sidebar becomes a drawer and rows stack (name + size/modified), the mobile bottom bar
  gains the Files item (the bar already contracts evenly, and its CSS comment is updated from
  "seven destinations" to eight).
* **Search:** in-page, scoped to the current root and folder, with the server's bounds and
  truncation reported; never a whole-host crawl.

### 9. Test plan

`server/phase11a-files.test.js` — a fixture tree in a temp dir, exposed through
`OPUSHUB_FILES_ROOTS` (plus a second root, to prove isolation), containing: nested dirs, a text
file, a large file (> preview cap), a JSON/YAML/Markdown file, an image, a PDF, an HTML file, an
empty dir, a symlink inside the root, a symlink to `/etc`, a symlink to a sibling root, a file with
a `..`-looking name, a protected file (`.env`, `id_rsa`), and a directory with more entries than the
cap.

| Area | Checks |
|---|---|
| Roots | root listing shows only exposed roots; `/` is never a root; configured roots are validated; a symlinked/denied/inner root is dropped with a reason; unknown root id → 404 |
| Listing | entries carry name/kind/size/mtime/mode/owner; sorted; entry cap honoured with `truncated`; empty dir; `not_a_directory`; hidden count for protected entries |
| Stat / properties | all fields present; symlink reports `symlink` + in-root target; out-of-root target is `null` + flagged; octal + symbolic mode agree |
| Preview | bounded (never more than the cap, `truncated: true`); kind detected from bytes, not the extension (a `.txt` holding a PNG is an image; a `.png` holding text is text); oversized → `too_large`; binary → `unsupported_preview`; HTML is text, never rendered |
| Path security | `../`, `..%2f`, `%2e%2e%2f`, double-encoded, null byte, `\` separators, absolute path, `//`, trailing `/..`, over-long, over-deep, a name that *contains* `..` (legal) vs a `..` segment (refused) |
| Symlink / mount escape | `/tank/media/link/passwd` (link → `/etc`) refused; a link to another root refused; a link inside the root allowed; a bind-mount-style escape refused by the mountinfo rule |
| Protected paths | docker socket path, `/proc`, `/sys`, `/dev`, `/run`, OpusHub `CONFIG_DIR`/`DATA_DIR`, `.env`, private key, `shadow`, `sudoers`, `.ssh/*`, `.git/config` → `protected_path`, and absent from listings |
| Permissions | 401 unauthenticated (through `handleApi`); 403 for a `viewer` actor; `files.read` / `files.download` / `files.search` each gate their own route; a sensitive root needs the stronger permission |
| permission_required | an unreadable file/dir (chmod 000 as a non-root user) → the structured `{ code, path, operation }`, never a raw errno, never a fallback |
| Tokens | expiry; session binding; path binding; operation binding (preview token ≠ download token); single canonical path; no host path in the token; unknown/tampered token refused |
| Downloads | streamed (no full buffering); `Content-Disposition` from the server; sensitive download writes one activity row; protected download refused |
| Search | match cap, node cap, depth cap, deadline; refuses to cross the root; skips protected; empty query refused; reports truncation |
| Broker | operation vocabulary frozen; unknown operation refused; a request is authorized + path-revalidated + audited; with no provider → `no_privileged_provider` and **no grant**; with an injected test-double provider → grant expires, is session-bound, is operation-specific, and re-denies a protected path; the browser can never name a provider, a command or a root path |
| Activity volume | N listings + stats + previews of ordinary files write **zero** activity rows; the security events above write exactly one each (deduplicated) |
| Mechanical proofs | no `child_process`/`spawn`/`exec`/`sudo`/`shell` anywhere in `server/files/*` or `filesApi.js`; no write/unlink/mkdir/chmod/chown call; no Docker socket reference or transport in `files/policy.js`; no generic `{operation, path}` route; the api.js non-GET route list is unchanged; the browser bundle contains no host path or `process.env` read |

Web (`test/web/tests.tsx`): the nav contract becomes **eight** primary items with Files between
System and Activity (and the mobile bar mirrors it); Files rail item active on `/files`; the
explorer renders roots, breadcrumbs and a listing; clicking a folder navigates and updates the
breadcrumb + URL; back/up work; the permission-required panel renders with Request Access and shows
the honest "no privileged broker on this host" outcome; a text preview renders escaped (an HTML file
shows its source, not a rendered node); the download action requests a token and points the anchor at
the token href (never at a raw host path); the mobile layout renders the drawer toggle and stacked
rows.

Regression: `npm test`, `npm run test:web`, `npm run verify`, `npm run typecheck`, `npm run build`,
`git diff --check`, `node test/source-scan.js`, `npm run smoke:routes`.

---

## Part 2 — Implementation notes

Everything below describes code that exists in this branch. Where the implementation differs from
the Part 1 plan, §2.14 says so and why.

### 2.1 Module map

| File | Lines | Responsibility |
|---|---|---|
| `server/files/limits.js` | 102 | Every bound, frozen, in one place. Nothing here is configurable from a request; `publicLimits()` is the subset the UI may know. |
| `server/files/policy.js` | 557 | The canonical path policy: shape rules, `realpath` containment, mount-escape detection (`/proc/self/mountinfo`), classification (`allowed · sensitive · protected`), and `STATUS_BY_CODE` — the one table that turns a refusal code into an HTTP status. |
| `server/files/roots.js` | 309 | Which directories are exposed. `OPUSHUB_FILES_ROOTS` first, storage-provider discovery as a fallback, `OPUSHUB_FILES_DISABLED` as a kill switch. Every candidate is validated (absolute, exists, directory, readable, not `/`, not protected, not a duplicate after `realpath`), refused candidates are *published* with a reason, and the table is TTL-cached. |
| `server/files/identity.js` | 85 | `uid/gid → owner/group` names with a bounded cache; falls back to numbers rather than guessing. |
| `server/files/preview.js` | 273 | Type detection: magic bytes first, extension second, `content` wins over `name`. Decides `inline: text | image | pdf`, marks active content (HTML/SVG/XML), and refuses oversize/undisplayable files with a code. |
| `server/files/tokens.js` | 123 | Short-lived references: `sha256(token)` is the stored key (the raw token is never persisted), bound to `{sessionId, rootId, path, operation}`, TTL 120 s (download) / 300 s (preview), swept on use, retired per session and wholesale. |
| `server/files/provider.js` | 699 | The `FilesystemProvider`: `roots · list · tree · stat · read · preview · download · resolveRef · search · permissionStatus`. **No mutation method exists.** Every operation resolves through the policy first, runs inside `bounded()` (deadline + `AbortSignal`), and returns `{ok:false, code, reason, status}` rather than throwing errnos. |
| `server/files/context.js` | 203 | Storage context for the Properties panel: which mount, which ZFS dataset, which containers bind or serve the path, which volume. Reuses the Phase 9 storage providers and the Docker provider's `inspectContainer` mounts — bounded to 32 inspects per request. |
| `server/files/broker.js` | 430 | The privilege broker: a frozen operation vocabulary (`list · stat · read`), a registration guard that refuses a provider spec containing execution words, independent path re-validation, session-bound grants with a hard TTL cap, and the five honest states. **No provider is registered in 11A**, so the answer is `unavailable` (501) — never a fake elevation. |
| `server/filesApi.js` | 630 | The HTTP layer: session + CSRF gate, permission gates, sensitive-root gate, the 12 GET routes and the 1 POST, refusal shaping, event logging, token minting, the 302 download redirect and the streamed byte routes (with CSP for inline content). |
| `server/phase11a-files.test.js` | 1292 | 38 tests over a real fixture tree in a temp dir, driven through `handleApi` (no server process, no mocks of the filesystem). |
| `src/lib/files.ts` | 298 | The browser's data layer: URL builders (`root` + relative `path` only), one hook per read with polling **off**, the refusal helper, the one POST, and presentation helpers. |
| `src/pages/Files.tsx` | 1174 | The explorer: roots sidebar, folder tree, breadcrumbs, sortable listing, search, Properties, Preview, the permission panel. |
| `src/lib/types.ts` | +~330 | The documents, typed. There is no mutation type to write. |
| `src/styles/pages.css` | +208 | `.fm-*`, built from existing tokens; three columns → two → one. |

Touched, not rewritten: `server/api.js` (delegation + `/api/v1/files/*` rewrite + reference
retirement on logout/session revoke), `server/operations/permissions.js` (four `files.*`
permissions), `server/activity.js` (`files` category), `server/search.js` (Files is a destination),
`src/App.tsx` (the eighth rail item + route), `src/pages/Activity.tsx` (the Files filter),
`src/lib/api.ts` (`errorCode` + `errorBody` on `QueryState`), `.env.example`, `docker-compose.yml`,
`test/verify.mjs`, `test/web/tests.tsx`, `src/ssr-smoke.tsx`.

### 2.2 The provider contract

One abstraction, and it is the only thing between a request and the host:

```
roots()            which directories are exposed, and which candidates were refused
list()             one directory, enriched, sorted, capped
tree()             folders only, depth-capped, per-level capped
stat()             one location, with mode/owner/timestamps and readability
read()             bounded bytes (never a whole file)
preview()          read() + detection + an inline mode or a coded refusal
download()         a *stream factory*, not a buffer — the API decides when to open it
resolveRef()       resolution facts about a path (used by /context)
search()           a bounded name walk that never follows directory symlinks
permissionStatus() "can OpusHub read this, and would asking help?"
```

Three properties matter more than the list:

* **Policy before I/O.** Every operation calls `locate()` → `policy.resolve()` before a single
  `readdir`. There is no code path that touches the host first and checks afterwards.
* **Bounded and cancellable.** `bounded(fn, {ms, signal})` races a deadline, and
  `filesApi.js` aborts when the request closes — a browser that navigates away mid-listing stops
  the host working.
* **Structured refusals.** `{ok:false, code, reason, status, rule?, class?, operation}`. Errnos are
  translated (`EACCES` → `permission_required`), never forwarded, and never turned into a stack
  trace the browser can read.

### 2.3 Roots as built

```
OPUSHUB_FILES_ROOTS=/tank/media,/opt/stacks     → configured roots (validated, in order)
(nothing set)                                   → discovery: eligible mounts from the storage provider
OPUSHUB_FILES_DISABLED=1                        → no roots, and every /api/files route answers 404
```

A candidate is refused (and the refusal is published to the UI with its reason) when it is empty,
relative, `/`, contains a null byte, protected by classification, under a protected prefix, missing,
not a directory, unreadable, a duplicate of another root after `realpath`, or beyond the cap of 24.
A root that is itself a symlink is resolved and recorded (`viaSymlink: true`); a root nested under
another exposed root is marked `nestedUnder` rather than silently dropped. Roots under a sensitive
prefix (a log directory) are `sensitive: true` and need `files.read_sensitive`.

Root addressing is by **id (a slug of the resolved path)**, never by the path itself: an unknown id
is `404 unknown_root`, and root isolation is structural — a path from root A can never be resolved
against root B, because resolution starts from A's real path and must stay inside it.

### 2.4 Path policy as built

Shape is checked before anything is stat'd, and the *rule* that caught it is reported:

| Rule | Refuses |
|---|---|
| `not_a_string`, `too_long` | a non-string, or more than 4096 characters |
| `null_byte`, `control_character` | `\0` anywhere; any C0/DEL character |
| `encoded` | any percent escape at all (`%2e`, `%2f`, double-encoded) — the API receives already-decoded query values, so a literal `%` means someone is trying twice |
| `separator` | backslashes (an alternate separator is a traversal attempt, not a filename) |
| `absolute`, `home` | a leading `/`, a drive letter, a leading `~` |
| `empty_segment`, `dot_segment`, `traversal` | `//`, `.`, `..` — a *name* that contains `..` (e.g. `my..file`) is legal and passes |
| `name_too_long`, `too_deep` | a 256-byte name; more than 64 levels |

Then resolution: `realpath` of the joined path, containment inside the root's real path
(`root_isolation` if not), a mount-escape check against `/proc/self/mountinfo` (`mount_escape` when
the location sits on a different device/bind than the root and would open a protected tree), a
symlink check (`symlink_escape` when a link's real target leaves the root), and classification of
**every prefix** of the resolved path plus its basename (`protected_path`). Classification runs
twice — before and after resolution — because a link inside an allowed root can point at `.env`.

Protected classes: `root_filesystem · kernel_interface · system_directory · container_runtime ·
opushub_secrets · environment_file · credential_store · ssh_material · private_key ·
password_database · session_material · protected_mount`. The blocklist is imported from
`server/containers/policy.js` (`BLOCKED_HOST_PATHS`, `SENSITIVE_HOST_PATHS`) rather than restated,
so the container-spec classifier and the file classifier cannot drift apart. Sockets are refused by
name pattern (`*.sock`, `*.socket`), which is why a root may *contain* the directory a socket lives
in while the socket file itself is never listed or read.

Protected entries are **omitted from listings** (counted as `hidden`) rather than shown as locked
rows, and an explicit request for one is refused *and* recorded.

### 2.5 Authorization as built

Four permissions, mapped from the existing role model:

| Permission | Gates | administrator | operator | viewer |
|---|---|---|---|---|
| `files.read` | `/api/files`, `roots`, `list`, `tree`, `stat`, `context`, `preview`, `permission-status`, `raw`, and the privilege POST | ✓ | ✓ | ✗ |
| `files.search` | `search` | ✓ | ✓ | ✗ |
| `files.download` | `download-token`, `download` | ✓ | ✗ | ✗ |
| `files.read_sensitive` | any sensitive root, and any file classified sensitive (preview/download of those write an activity row) | ✓ | ✗ | ✗ |

The viewer column is empty because `phase8-operations.test.js` freezes `ROLES.viewer = []`; giving a
viewer `files.read` would have meant editing a frozen security proof, so a viewer gets a 403 with a
sentence that explains the difference between a role permission and a file permission. Every route
answer carries `permissions` — the caller's own role map — so the UI never guesses what to show.
A file's mode is `modeText` (`-rw-r--r--`) and `octal` (`0644`); the name `permissions` is reserved
for the role map, everywhere, with no exceptions.

### 2.6 The privilege broker as built

* Vocabulary: `list · stat · read`. Anything else is `bad_operation` (400).
* A request body may carry `root`, `path`, `operation`, `reason` (≤ 240 chars). **Unknown fields are
  dropped, never echoed** — a `command`, `args`, `shell`, `user` or `sudo` key in the body is
  discarded and does not appear in the response or in the event log.
* `registerPrivilegedProvider(spec)` refuses a spec whose id, label or description contains any
  forbidden whole word (`exec`, `spawn`, `shell`, `sudo`, `command`, `script`, `terminal`, `pty`,
  `eval`, `root`, …) matched as a camelCase token, not a substring. This is the guard that stops a
  future module from registering "run a command as root" as a file provider.
* The broker re-resolves and re-classifies the path itself: a grant can never be obtained for a
  protected location, and a provider that claims otherwise is not consulted.
* States: `granted` (a session-bound grant for `{rootId, path, operation}`, TTL ≤ 15 min),
  `not_needed` (OpusHub can already read it), `denied` (policy refuses), `unavailable` (501 — no
  provider registered), `invalid` (the request itself was malformed).
* **11A registers nothing.** So every request answers `unavailable`, and the UI says: *"OpusHub will
  not run sudo, a shell or any other command to read a file, so this location stays unreadable until
  an operator registers a privileged provider on the host."* That is the honest state; the interface
  is complete, the elevation is not faked.

### 2.7 References, downloads and inline bytes

```
GET /api/files/download?root=<id>&path=<rel>   → 302 Location: /api/files/download?token=<t>
GET /api/files/download?token=<t>              → re-resolves the path, streams it, Content-Disposition: attachment
GET /api/files/raw?token=<t>                   → sniffs, then serves image/* or application/pdf inline with a CSP
```

The token is a capability, not an address: it names `{sessionId, rootId, path, operation}`, expires
in 120 s (download) or 300 s (preview), is stored only as `base64url(sha256(token))`, and is
re-validated **and the path re-resolved** on use — a token cannot be edited into another file,
because the browser never holds a path form of the route. A preview token spent on the download
route is `403 token_mismatch`; another session's token is `403 token_session`; an expired one is
`403 token_expired` with `retry: "request a fresh link"`. Signing out, revoking a session or
revoking all sessions retires every reference that session held
(`retireFilesSession` / `retireAllFilesSessions`, wired in `api.js`).

Downloads are streamed (`fs.createReadStream` piped to the response, `maxDownloadBytes: null`): a
byte cap that buffered first would be worse than no cap. The filename in
`Content-Disposition` is RFC 5987-encoded, so a name with spaces or non-ASCII survives.

### 2.8 Preview

Detection is server-side and content-first: the first 8 KB are sniffed, and `detectedBy` reports
`content` or `name`. A `.txt` holding a PNG is an image; a `.png` holding text is text. Inline modes
are `text` (escaped into JSON, rendered by React as text — never `dangerouslySetInnerHTML`),
`image` and `pdf` (both served from `/raw` by token). Active content — HTML, SVG, XML — is previewed
as *source*, flagged `activeContent: true`, and the UI states that nothing in a preview can run a
script in this origin. A PDF is opened in a new tab by the browser's own viewer rather than
embedded. Files above 32 MB, or of a kind that cannot be displayed, are refused with `too_large` /
`unsupported_preview` **carrying the detection result**, so the panel can say "900 MB video —
download it" instead of "error".

### 2.9 Bounds and cancellation

| Bound | Value | Where enforced |
|---|---|---|
| Entries per listing | 2 000 (`truncated: true`, `total` still honest) | `provider.list` |
| Entries scanned per listing | 20 000 | `provider.list` |
| Concurrent `lstat` while enriching | 16 | `provider.list` |
| Tree depth / entries per level | 3 / 200 | `provider.tree` |
| Preview bytes / file size / inline image | 256 KB / 32 MB / 8 MB | `provider.read`, `preview.js` |
| Search matches / nodes / depth / query length | 500 / 20 000 / 8 / 128 chars | `provider.search` |
| Path length / depth / name length | 4096 / 64 / 255 | `policy.js` |
| Roots exposed | 24 | `roots.js` |
| Deadlines | list 8 s · stat 3 s · preview 8 s · search 8 s · context 8 s | `bounded()` |
| Live references | 400 (oldest swept) | `tokens.js` |
| Container inspects per Properties request | 32 | `context.js` |

Every bound is reported to the UI in the response (`limits`, `truncated`, `stopped`, `hidden`,
`sortScope`) so the page explains a short answer instead of looking broken. `sortScope: 'page'` is
the honest flag for a directory too large to sort globally: the page is sorted, and the UI says so.

### 2.10 Activity events

Ordinary browsing writes **nothing** — no event per listing, stat, preview or download of an
ordinary file. Exactly eight security-relevant events exist, all through the existing
`logEvent()` (category `files`), all deduplicated:

| Type | Severity | When |
|---|---|---|
| `files.protected_path` | warning | an explicit request for a protected location |
| `files.preview.sensitive` | notice | a sensitive file was previewed |
| `files.download.sensitive` | notice | a sensitive file was downloaded |
| `files.download.failed` | warning | a download reference failed (expired, wrong session, wrong operation) |
| `files.privilege.requested` | notice | somebody asked the broker |
| `files.privilege.granted` | notice | a provider granted it |
| `files.privilege.unavailable` | notice | no provider exists to grant it |
| `files.privilege.denied` | warning | policy refused the request |

No new audit system, no new store, no new event bus topic (see §2.14).

### 2.11 HTTP surface

Twelve GET routes and one POST — the complete vocabulary:

```
GET  /api/files                     surface: roots, permissions, provider state, bounds, notSupported
GET  /api/files/roots               the root table (+ refused candidates, ?refresh=1 re-reads the host)
GET  /api/files/list                one directory       ?root=&path=&sort=&dir=&limit=&offset=
GET  /api/files/tree                folders only        ?root=&path=&depth=
GET  /api/files/stat                one location        ?root=&path=&context=1
GET  /api/files/context             storage context     ?root=&path=
GET  /api/files/preview             bounded preview     ?root=&path=&tail=1
GET  /api/files/search              bounded name walk   ?root=&path=&q=&limit=&depth=&nodes=
GET  /api/files/permission-status   readability + grants ?root=&path=
GET  /api/files/download-token      mint a reference    ?root=&path=
GET  /api/files/download            mint + 302, or stream with ?token=
GET  /api/files/raw                 inline bytes        ?token=
POST /api/files/privilege/request   the only write verb: { root, path, operation, reason }
```

`/api/v1/files/*` is rewritten to the same table (`rewriteV1` in `api.js`), and an *unlisted*
`/api/v1/files/...` still lands here rather than falling through to a generic 404. Route membership
is checked before method: an unknown path under a wrong verb is `404 not_found`, a known path under
a wrong verb is `405 method_not_allowed` with the allowed verbs listed. Token-addressed routes are
matched before root/path validation, because a reference is already an authorized address.

Refusal codes and their statuses live in one frozen table (`policy.js#STATUS_BY_CODE`), reproduced
here in full because the UI switches on it:

| Status | Codes |
|---|---|
| 400 | `bad_path` · `bad_query` · `bad_operation` · `not_a_directory` · `is_a_directory` · `cancelled` · `bad_provider` |
| 401 | `auth_required` |
| 403 | `protected_path` · `symlink_escape` · `mount_escape` · `root_isolation` · `permission_required` · `not_permitted` · `grant_required` · `token_invalid` · `token_expired` · `token_session` · `token_mismatch` |
| 404 | `unknown_root` · `not_found` · `no_roots` |
| 405 | `method_not_allowed` |
| 413 | `too_large` · `entry_limit` |
| 415 | `unsupported_preview` |
| 500 | `provider_error` |
| 501 | `no_privileged_provider` |
| 504 | `timeout` |

Two statuses are sent directly rather than through the table, and both are rare: `400 bad_request`
when a POST body cannot be read, and `503` when a reference cannot be issued (carrying the issuer's
own code). The UI switches on `code` and prints `error` — never the other way round.

### 2.12 The page

* **Rail:** eight destinations — Hub · Services/Containers · Stacks · Monitoring · System · **Files** ·
  Activity · Settings — with a unique folder-and-pages glyph. Global actions unchanged.
* **Address:** `/files?root=<id>&path=<relative>&sel=<relative>&q=<query>&sort=&dir=&offset=`.
  Shareable, back/forward works, a reload lands where you were. No host path is ever in the URL, and
  a path the browser should not send (absolute, traversal, stray separator, null) is rewritten
  client-side *and* refused server-side; the page says it rewrote the address.
* **Layout:** roots + folder tree | listing | details (three columns → two at 1180 px → one at
  860 px, listing first). Built from existing primitives (`.btn`, `.chip`, `.kv`, `.input`,
  `.select`, `.icon-btn`, `PageHero`, `Freshness`, `Loading`, `.stale-note`, `.mono-meta`).
* **Root naming:** the server's label for a root is the path the operator configured, which is the
  honest identifier but too long for a trail — so the page shows its last segment as the name and
  the full path underneath it (and as a tooltip). A label that is not a path is shown as given.
* **Listing:** name (folder → open, file → select), size, type, modified, symbolic mode, owner/group,
  plus marks for `link`, `sensitive` and `unreadable`. Sortable on all six keys the API accepts;
  a re-sort keeps the table on screen instead of flashing a loader; paging appears only when a
  directory is larger than one listing.
* **Details:** Properties (kind, size, four timestamps, `modeText` + octal, owner/group with numeric
  fallback, link count, an in-root symlink target, "OpusHub can read", classification, mount,
  dataset, volume, which containers use it) and Preview. It always says *Read-only: OpusHub cannot
  change this file.*
* **Download:** a plain `<a href="/api/files/download?root=…&path=…" download>`. No token in page
  state, no fetch, no host path — the server mints and redirects.
* **Permission required:** the panel names the location, the single operation being asked for, and
  whether a privileged provider exists; `Request Access` POSTs `{root, path, operation, reason}` and
  renders `granted · not_needed · denied · unavailable · invalid`. A granted/not-needed answer
  re-reads the folder.
* **Polling is off** (`intervalMs = 0`): a file manager that re-read the host every few seconds would
  be a load generator. Refresh is a button.
* **Search:** submit-driven (not per keystroke), names only, and the note always says how much was
  walked and that folder symlinks are never followed and protected locations never matched.

### 2.13 Verification

| Command | Result |
|---|---|
| `npm test` | **960/960 pass** (922 baseline + 38 new in `server/phase11a-files.test.js`), ~131 s |
| `npm run test:web` | **95/95 pass** (82 baseline + 13 new Files checks) |
| `npm run verify` | **97/97 checks pass** (68 baseline + 29 new end-to-end files checks against a real spawned server and a real fixture directory) |
| `npm run typecheck` | clean |
| `npm run build` | ✓ — `dist/assets/Files-*.js` 37.2 kB (gzip 11.2 kB), lazy-loaded |
| `npm run smoke:routes` | ✓ including `/files` and `/files?root=nope&path=a/b` |
| `node test/source-scan.js` | exit 0 (it is the comment-stripping library the proof tests import; it has no main) |
| `git diff --check` | clean |

The frozen security proofs still pass unchanged: `phase7-proof` (no docker-socket literal outside its
allow-list, no spawn/exec in `server/*.js`), `phase8-proof` (no `docker.sock`, `DOCKER_HOST`,
`exec(`, `spawn(` or `process.env` in the browser bundle), `phase9-security` (the exact set of
`child_process` importers, and `api.js`'s non-GET route list — the files POST lives in `filesApi.js`,
so the frozen list did not need to move). 48/48 across those three files with **no new exemption**.

### 2.14 Deviations from the Part 1 plan

1. **No event-bus publication for file security events.** Part 1 left it open. `events/model.js`
   freezes `ALLOWED_SOURCES` and `INTERNAL_TYPE_RE`, and `FORBIDDEN_PAYLOAD_KEYS` bans `sessionId`
   and `token` from a payload — a files security event wants exactly those subjects. Rather than
   widen a frozen model, the events go to the existing activity log only, which is where the UI
   already reads them. Revisit if a live "protected path attempted" notification is ever wanted.
2. **`permissions` means the role map, always.** Part 1 sketched a per-entry `permissions` field for
   the mode; the collision was resolved in favour of the role map (which the UI needs on every
   response) and the mode became `modeText` + `octal`.
3. **Downloads are an anchor + 302, not a JS token fetch.** Part 1 described "the download action
   requests a token and points the anchor at it". Doing that in the browser would put a capability in
   page state and in history for no benefit: `GET /api/files/download?root=&path=` mints and
   redirects, so the anchor a person can copy carries no token and no host path. `download-token`
   still exists for a client that wants the reference explicitly.
4. **References are TTL-bound, not single-use.** Part 1's test plan mentioned single-use. A download
   that a browser retries (or a proxy that pre-fetches) would break, and the security value is
   already carried by the session + path + operation binding and the 120 s TTL. `uses` is counted, so
   a future cap is a one-line change; the tests assert binding and expiry, not single-use.
5. **`src/lib/api.ts` gained `errorCode` and `errorBody` on `QueryState`.** The shared poller only
   kept a message string, and a files refusal is structured: `too_large` arrives with the size and
   the detected type, `permission_required` with the operation and whether access may be requested.
   Both fields are optional and additive — no existing page reads them.
6. **The viewer role stays empty.** Part 1 assumed a viewer might get `files.read`; the Phase 8 proof
   freezes `ROLES.viewer = []`, so a viewer is refused at the door with an explanation instead.
7. **Tree depth requested is 2 (server cap 3).** A deeper sidebar costs more than it shows at the
   widths this page runs at.

---

## Part 3 — Final 11A review (security + architecture)

### 3.1 What the phase is

A read-only file manager for explicitly configured filesystem roots, with a canonical path policy, a
role-based read permission model, bounded reads, token-referenced downloads, content-detected
previews, bounded name search, storage context, and a privilege broker that is complete as an
interface and honestly empty as an implementation.

Navigation is now eight destinations; global actions are unchanged; the page reuses existing design
primitives and adds no new store, no new audit system and no new abstraction where one existed.

### 3.2 Security findings

Each line is a property that a test asserts, not an intention.

1. **No mutation exists.** `POST /api/files/{delete,rename,move,copy,upload,mkdir,chmod,chown,write,
   exec,shell}` → 404; `DELETE|PUT|PATCH` on a read route → 405/404; the provider has no such method;
   `NOT_SUPPORTED` is published in the surface document and rendered in the sidebar. Verified by
   `phase11a-files.test.js`, by 14 calls in `verify.mjs` against a real server, and by a filesystem
   check that the fixture tree survived every request.
2. **No execution primitive, and no write syscall.** A comment-stripping source scan over every file
   in the feature (`server/files/*.js`, `server/filesApi.js`) asserts the absence of:
   `child_process`, `spawn(`, `exec(`/`execFile(`/`execSync(`, `fork(`, `eval(`, `new Function(`,
   `process.binding`, `vm.runIn`, `node-pty`, `sudo` (outside the broker's own deny-list literal),
   `/bin/sh|bash|dash|zsh`, a quoted shell name (`'sh'`, `'bash'`, `'powershell'`, …), ` -c `,
   `require(` — and of every mutation call: `writeFile`, `appendFile`, `createWriteStream`, `unlink`,
   `rm`, `rmdir`, `mkdir`, `rename`, `copyFile`, `chmod`, `chown`, `lchown`, `utimes`, `truncate`,
   `ftruncate`, `symlink`, `link`, `mkdtemp`, any `O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND` flag,
   and any `.open()` whose flag is not `'r'`. The scan is call-shaped rather than word-shaped because
   the words legitimately appear in deny-lists and file-type labels, and it asserts the stripper left
   real code to look at. The frozen `phase7/8/9` proofs pass unchanged, with no new exemption.
3. **Traversal is refused in every shape tested:** plain `..`, `./`, encoded `%2e%2e%2f`,
   double-encoded, null byte, backslash separator, absolute path, `~`, `//`, trailing `/..`,
   over-long, over-deep — each with the rule that caught it. A filename that merely *contains* `..`
   is legal and still works.
4. **Symlinks and mounts cannot escape.** A link to `/etc` is `403 symlink_escape`; a link into a
   sibling root is `403 root_isolation`; a bind/pseudo mount that would open a protected tree is
   `403 mount_escape`; a link *inside* the root is followed and its target is named only when it
   stays inside. Resolution is `realpath`, every time, on the server — never a browser-supplied
   canonical path.
5. **Protected paths are classified server-side, not hidden client-side.** Credentials, private keys,
   `.env`, session material, `shadow`/`sudoers`, `.ssh`/`.gnupg`/cloud credential homes, OpusHub's
   own `CONFIG_DIR`/`DATA_DIR`, kernel interfaces (`/proc /sys /dev /run`), system directories and
   any `*.sock` are refused by policy and omitted from listings; an explicit attempt is recorded as
   `files.protected_path`. `docker.sock` never appears in the browser bundle (frozen proof).
6. **Root isolation is structural.** Unknown root → `404 unknown_root`; `/` is refused as a root;
   roots come from the environment or from discovered mounts, never from a request; a path is always
   resolved inside the named root's real path. Cross-root reads are impossible without a root id that
   the host already exposed.
7. **Authorization is per route and per sensitivity.** `files.read` / `files.search` /
   `files.download` / `files.read_sensitive` each gate their own routes; unauthenticated → 401 (and
   every reference that session held is retired on logout/revoke); a viewer → 403 with a sentence
   that distinguishes a role permission from a filesystem permission.
8. **`permission_required` is structured, and elevation is never faked.** An `EACCES` becomes
   `{code:'permission_required', operation, root, path, requestAccess:true, privileged:{…}}`. The
   broker's vocabulary is `list · stat · read`; a smuggled `command`/`shell`/`user` key is dropped and
   never echoed; with no provider registered the answer is `501 unavailable` and the UI says OpusHub
   will not run sudo or a shell. A protected path is never grantable, and the broker re-validates the
   path independently of the API layer.
9. **References are capabilities.** Session-bound, root/path/operation-bound, 120 s/300 s TTL, stored
   only as a sha256 hash, re-resolved on use, refused across sessions (`token_session`), across
   operations (`token_mismatch`) and after expiry (`token_expired`), retired wholesale on sign-out
   everywhere. There is no `?path=` form of a byte route.
10. **Reads are bounded and cancellable** (§2.9): a 400 GB file cannot be previewed, a huge directory
    cannot be listed whole, a search cannot walk forever, and a client that disconnects aborts the
    work. Downloads stream.
11. **Previews cannot execute.** Detection is content-first; text is delivered escaped in JSON and
    rendered by React as text; active content is flagged and shown as source; images/PDFs come from a
    token route with a CSP; there is no `dangerouslySetInnerHTML` in the page and no iframe in this
    origin.
12. **No secrets leave the server.** The UI never receives a raw token to keep, never renders a
    `canonical` host path for a browsed location, and the only host paths it shows are the roots the
    operator configured and the mount point/dataset the storage providers already publish elsewhere
    in the app. Response bodies carry no `CONFIG_DIR`/`DATA_DIR` value, no environment, no credential.
13. **Activity volume is deliberate.** Browsing, previewing and downloading ordinary files write zero
    rows (asserted end-to-end in `verify.mjs`); only the eight security events write anything, and
    they deduplicate.

### 3.3 Limitations (honest list)

1. **No privileged provider ships in 11A.** "Request Access" is a complete, tested interface whose
   answer on a default host is `unavailable`. An operator who wants a real elevation path must
   register a provider out-of-band; until then unreadable locations stay unreadable, and the UI says
   so rather than offering a workaround.
2. **Container installs see nothing until you mount it.** The published compose file mounts only
   `./config`, `./data` and the Docker socket, so `OPUSHUB_FILES_ROOTS` alone is not enough in a
   container — `docker-compose.yml` now carries a commented example (mount `:ro`, then name the root).
3. **A viewer cannot use the page at all** (frozen role), and the rail item is still visible to them:
   the destination explains the refusal instead of pretending not to exist. Hiding it by role would
   make the permission model invisible and would fork the navigation contract.
4. **Listings are not live.** No polling, no filesystem watch: a folder changes when you refresh it.
   That is a deliberate trade against load, and the page shows when it last read.
5. **`sortScope: 'page'`** — a directory larger than 2 000 entries is paged in name order and sorted
   within the page. Global sorting of a huge directory would mean reading all of it.
6. **Search is by name only**, bounded, and never follows directory symlinks — so a name behind a
   folder link or inside a protected location will not be found. Contents are never read to search.
7. **Previews are capped** (256 KB of text; nothing above 32 MB; images above 8 MB not inlined), and
   PDFs open in a new tab rather than embedding. Media, archives and binaries are described, not
   shown.
8. **Storage context is best-effort.** Mounts come from `/proc/self/mountinfo` (Linux), datasets from
   the ZFS provider, containers from bounded inspects (32). Where a source is unavailable the panel
   says which and why, rather than showing an empty row.
9. **Ownership names are a cache, not a directory service.** `uid → name` uses the host's passwd/group
   with a 60 s TTL and falls back to numbers.
10. **Windows/macOS hosts are not the target.** The mount-escape rule, `mode`/`owner` reporting and
    socket classification assume a POSIX host; the shape rules (backslash, drive letter) are refused
    rather than interpreted.

### 3.4 The 11B boundary

Nothing in this phase is shaped to make mutation easy to add by accident:

* the provider has no write method, and `NOT_SUPPORTED` is published and rendered;
* the route table is frozen in `filesApi.js` and asserted by tests, so a new verb is a visible change;
* `api.js`'s frozen non-GET route list did not move — the single POST lives in the files handler;
* the broker's registration guard refuses a provider spec that smells of execution, so 11B cannot
  arrive as "a privileged provider that runs commands";
* references are operation-bound, so a download reference cannot be reused for anything else.

If 11B is ever commissioned, the work is a new permission (`files.write`), a new provider method per
operation, an audit event per mutation, and a confirmation flow through the existing
`OperationsHost` — not a change to the path policy, which is already written for the harder case.

### 3.5 Reviewing this branch

```
docs/17-phase-11a.md            this document (audit → implementation → review)
server/files/policy.js          the path policy and the classification vocabulary   ← read first
server/files/provider.js        the only code that touches the host filesystem
server/files/broker.js          the privilege broker and its registration guard
server/filesApi.js              routes, gates, refusals, tokens, streaming
server/phase11a-files.test.js   38 tests over a real fixture tree
src/pages/Files.tsx             the explorer
src/lib/files.ts                the browser's data layer (no mutation function exists)
test/verify.mjs §11             29 end-to-end checks against a real spawned server
test/web/tests.tsx              the nav contract (eight items) + 12 Files checks
```

Not merged: this branch is `arena/01a0ba9f-opushub`, and it stays there until it is reviewed.
