# 07 — Distribution: the image, GHCR, and installing OpusHub

OpusHub is published as a container image so installing it is `docker compose up -d` and nothing
else. This document is the contract behind that sentence: what the image contains, how it is built
and tagged, what the compose file mounts, and how to update, back up and troubleshoot an install.

## The image

```
ghcr.io/lucif3r-d3vil/opushub:latest
```

The canonical path is `<owner>/<repository>` exactly as Git knows it, lowercased — the publish
workflow reads `github.repository_owner` and `github.repository` rather than anything typed by hand,
so the image path cannot drift from the repository.

### What is inside

- Three stages: `deps` (full install for the build), `build` (vite → `dist/`), `runtime`
  (production dependencies only, `npm ci --omit=dev`). The runtime layer contains the server, the
  built SPA, the bundled icon sets and fonts — and no build tooling.
- **No configuration, no data, no secrets.** `config/`, `data/`, `.env`, `*.pem`, `*.key`, `*.crt`
  and the test suites are excluded by `.dockerignore`, and the `COPY` list is explicit: a wholesale
  context copy would bake one host's state into an image meant for every host.
  `test/docker.test.js` asserts exactly this, line by line.
- Runs as the unprivileged `node` user (the image default), `STOPSIGNAL SIGTERM`, exec-form `CMD`
  (`node server/index.js`) so the server receives the signal directly, `EXPOSE 3000`, and a
  `HEALTHCHECK` against `http://127.0.0.1:3000/api/health`.
- Labelled with `org.opencontainers.image.{source,title,version,revision,licenses}`; the version and
  revision come from build args the workflow fills in, so `dev`/`unknown` is what a local build says.

### Tags

| Tag | Written when | Use it for |
| --- | --- | --- |
| `latest` | Every push to `main` | Normal installs and updates |
| `1.4.0` / `1.4` | A `v1.4.0` release tag | A pinned, reviewable upgrade |
| `sha-abc1234` | Every build | Reproducible deploys — the tag *is* the commit |

Publishing is `docker/build-push-action` with `docker/metadata-action` for tags/labels, authenticated
with the workflow's own `GITHUB_TOKEN` (`packages: write` only). There is no registry password, no
PAT, nothing to rotate.

Platform: **`linux/amd64`** first, because that is what the overwhelming majority of homelab hosts run.
The Dockerfile is architecture-neutral (pure Node, no native build step), so ARM64 is a matrix entry
away in `.github/workflows/ghcr.yml` when it is wanted. `provenance` and `sbom` are enabled, so
`docker buildx imagetools inspect` will show what went into a published image.

CI runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` in a **verify** job that
**publish** depends on: a broken commit never becomes an image.

### Watching it happen

`.github/workflows/ghcr.yml` runs on push to `main`, on `v*` tags, and manually
(`workflow_dispatch`). The job summary lists the tags it pushed.

To build locally instead:

```
docker build -t opushub:local .
```

## Installing

The compose file in this repository is the clean install.

```bash
mkdir -p ~/opushub && cd ~/opushub
# save docker-compose.yml here (from the repo root)
docker compose up -d
```

Then open `http://<this-host>:3000` — the first-run wizard walks through: welcome → the
administrator account → environment (host address, Docker endpoint, Traefik entrypoints) → what
discovery found → finish. No configuration file has to be written by hand, ever.

### The Docker socket

OpusHub knows about containers because it reads the Docker Engine API over the socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

- `:ro` is the read-only mount at the filesystem level, and it is also the truth of this project:
  OpusHub only ever issues `GET`s. There is no start, stop, restart, exec, pull, create or delete
  anywhere in the codebase, and `server/api-boundary.test.js` fails if one appears.
- The socket is usually owned by `root:docker` (GID 999 on Debian/Ubuntu). The image's `node` user is
  not root and not in that group, so give it the group instead of root privileges:

  ```bash
  stat -c '%g' /var/run/docker.sock     # e.g. 999
  # then uncomment in docker-compose.yml:
  # group_add:
  #   - "999"
  ```

  Without it OpusHub still starts — the wizard will show Docker as *Not connected*, and the Hub will
  say why rather than pretending your host has no containers.
- **What the socket means.** Anyone who can read the Engine API can see every container's
  environment (OpusHub strips those before they reach the browser, but the socket itself is
  powerful). Mounting it read-only into a container that already serves a UI has consequences for
  your threat model — see the security note below.

### Volumes and what lives where

| Mount | Contents | Back it up? |
| --- | --- | --- |
| `./config` | `services.yaml`, `stacks.yaml`, `settings.yaml`, `bookmarks.yaml`, `layout.json`, `theme.css`, `app.js`, `icons/`, `backgrounds/`, `.env` — your presentation layer | **Yes** — this is the work |
| `./data` | `auth.json` (the account), `sessions.json`, the activity log, metric history, and `config-backups/` | Recommended — `auth.json` is what stands between the Hub and the network |

Both are plain directories on the host: `tar czf opushub-backup.tgz config data` is a complete
backup. OpusHub also keeps its own bounded copy of every file it overwrites in
`data/config-backups/` (20 most recent per file), so a bad edit is recoverable without a backup —
but that is a convenience, not a backup policy.

Deleting the container and running `docker compose up -d` again changes nothing in the app. Deleting
`./data` returns the install to its first-run state (setup runs again).

### Environment variables

All optional, and all documented by their absence:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPUSHUB_PORT` | `3000` | Port inside the container |
| `OPUSHUB_HOST` | `0.0.0.0` | Bind address |
| `OPUSHUB_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker endpoint (or set `DOCKER_HOST`) |
| `OPUSHUB_HOST_ADDRESS` | — | Fallback host/IP for services that publish a port and have no proxy labels; can also be set in the wizard or Settings |
| `OPUSHUB_CONFIG_DIR` / `OPUSHUB_DATA_DIR` | `/app/config` / `/app/data` | Only useful when running outside the image |
| `OPUSHUB_ENV_FILE` | — | First `.env` candidate to read (secrets stay server-side) |

Prefer the wizard or `settings.yaml` over `OPUSHUB_HOST_ADDRESS` unless you are scripting a deploy:
the config file is visible in the app and survives image changes.

## Updating

```bash
docker compose pull && docker compose up -d
```

Data and config are untouched. To pin: replace `:latest` with a version tag (`:1.4.0`) or a commit
(`:sha-abc1234`), then pull that. To go back, change the tag back and `up -d` again — `auth.json` and
your config are not tied to the image.

## Backups

1. `tar czf opushub-$(date +%F).tgz config data` — or snapshot the host directory.
2. Keep it with your other homelab backups.
3. Restoring is unpacking into the same two directories and starting the container.

The account hash lives in `data/auth.json`; sessions in `data/sessions.json`. Restoring `auth.json`
restores the login. Losing it costs one wizard run.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Wizard says *Not connected* for Docker | Container user cannot read the socket | `stat -c '%g' /var/run/docker.sock`, uncomment `group_add` in the compose file, `docker compose up -d` |
| Hub is empty, `docker ps` is not | `OPUSHUB_DOCKER_SOCKET`/`DOCKER_HOST` points elsewhere | Settings → System reports the path the server actually used; fix the env var or the mount |
| A service has no Open button | No Traefik route and no published port — an honest "no browser URL" | Publish a port, add proxy labels, or set the URL on the service page (Settings → Services) |
| Port 3000 answers, but another machine cannot reach it | Host firewall, or `ports` narrowed to `127.0.0.1:3000:3000` | Open 3000 on the LAN, or reach it through your VPN/proxy |
| Container restarts in a loop | Check `docker compose logs opushub`; most often a bad bind path or an unwritable `./data` | `chown` the directories to the container user (`node`, uid 1000) |
| `docker compose config` warns about group ids | The `group_add` value is a string vs number detail | Quotes are fine (`group_add: ["999"]`); the value must be the socket's **GID** |
| Forgot the admin password | There is no reset endpoint, by design | Stop the container, delete `data/auth.json`, start it again — the wizard returns. Sessions live in `data/sessions.json` and are unaffected |
| Icons stay as monograms | Iconify unreachable and no bundled match | Expected: a monogram is the honest fallback. Upload an icon in Settings → Services |

## The security note (read this one)

**Do not publish port 3000 to the Internet.** OpusHub reads host vitals, container logs and the full
inventory of your machine, and its login is a single local account — not an identity provider, not
multi-user, no 2FA, no audit trail beyond your own Activity log.

- Put it on your LAN. If you need it from outside, use a VPN (Tailscale, WireGuard) or a reverse
  proxy with *its own* authentication in front — and prefer HTTPS there so the session cookie gets
  its `Secure` flag automatically (`x-forwarded-proto: https`).
- The container runs unprivileged, with `no-new-privileges: true`, and only ever reads.
- The socket grant is the real privilege in the setup: `group_add` gives the container user access to
  your Docker daemon's API. That is inherent to what OpusHub does; treat a shell in that container as
  equivalent to Docker group membership on the host.

See `docs/06-auth.md` for the authentication model, the CSRF defence, the (documented, expiring)
login throttle and the full security review table.
