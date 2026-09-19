# OpusHub

**The calm control center for your homelab.**

OpusHub is a website you open in your browser that shows you the real state of your Docker containers, your machines, and your infrastructure — honestly, cleanly, and without the usual dashboard noise.

It discovers whatever is already running on your Docker host, groups it sensibly, and lets you browse services, stacks, host vitals, activity, and monitoring from one place. Configuration is optional YAML you can read and edit by hand. Nothing is hardcoded. Nothing is invented.

---

### Who this is for

- People running a **homelab** (a personal server or collection of servers at home)
- Anyone using **Docker** / Docker Compose who wants a nicer way to see what’s running
- Users who prefer tools that show **real data** instead of pretty placeholders
- People who value **safety** — OpusHub is designed so it cannot accidentally (or maliciously) wreck your containers

You do **not** need to be a developer or know React/Node to use it.

---

## What you actually get

| Area | What it shows you |
|------|-------------------|
| **Hub** | A personalized home page with a greeting, live host summary, draggable service launcher, and useful widgets (clock, weather, news, bookmarks, activity, attention items…) |
| **Services** | Every container Docker knows about, automatically grouped. Click any service for a real detail page with stats, ports, volumes, networks, and logs |
| **Stacks** | Your Compose projects exactly as Docker reports them, with member containers and aggregate health |
| **Monitoring** | OpusHub’s own uptime engine. Create monitors for HTTP, TCP, or Docker state. It records incidents with real durations and never pretends a service is up when it isn’t |
| **System** | Honest host metrics — CPU, memory, storage, network — read directly from the Linux kernel (`/proc` and `/sys`) |
| **Infrastructure** | Filesystems, ZFS pools/datasets (when present), network interfaces, optional OPNsense firewall status, and a physical topology map you can define |
| **Activity** | A clean timeline of things that actually happened: config changes, container state changes, operations, etc. |
| **Settings** | Appearance, Hub layout (drag & drop), widgets, icons, integrations, monitoring defaults, and more — all written to real files on disk |

---

## Why OpusHub feels different

Most “homelab dashboards” either:

- Hardcode a list of services you have to maintain by hand, or
- Show a lot of flashy cards with fake or incomplete data, or
- Give the browser dangerous power over your Docker socket

OpusHub takes a different approach:

- **Docker is the source of truth.** If a container exists, it appears. If you remove it, it disappears from every page. No stale entries.
- **YAML is only presentation.** You can rename services, pick icons, change groups, and set order — but you cannot invent a container that doesn’t exist.
- **No fake data.** If Docker is disconnected or a metric is unavailable, the UI says so clearly instead of showing zeros or placeholders.
- **Safety by design.** The Docker socket is mounted read-only. The limited operations that do exist (start / restart / stop a single container) require explicit confirmation and are fully audited.
- **One local administrator account.** Simple, honest authentication. Designed for LAN / VPN use, not the public internet.

---

## Quick start (2 minutes)

```bash
mkdir -p ~/opushub && cd ~/opushub

# Download the compose file from this repository, then:
docker compose up -d
```

Open **http://\<your-server-ip\>:3000** in a browser.

The first-run wizard will:
1. Let you create the administrator account
2. Confirm the Docker connection
3. Show you what was discovered
4. Drop you on the Hub, signed in

> **Tip:** For Docker to be visible immediately, give the container access to the socket’s group:
> ```bash
> stat -c '%g' /var/run/docker.sock   # note the number (often 999)
> ```
> Then uncomment the `group_add` line in `docker-compose.yml` and set that number.

The official image is:

```
ghcr.io/lucif3r-d3vil/opushub:latest
```

It only needs three mounts:
- `./config` — your presentation settings, icons, layouts (optional)
- `./data` — account, sessions, monitoring history, backups
- `/var/run/docker.sock:ro` — read-only access to Docker

---

## Important security note

**Keep port 3000 on your local network (or behind a VPN / reverse proxy with its own authentication).**

OpusHub can see your entire container inventory, host metrics, and logs. Its login is a single local account — it is not a full identity provider. Do not expose it directly to the public internet.

---

## Optional configuration

Everything lives in the `config/` folder. You can start with an empty folder — pure discovery already gives you a complete, useful interface.

| File | Purpose |
|------|---------|
| `services.yaml` | Optional: rename services, set icons, descriptions, groups, order, or override URLs |
| `stacks.yaml` | Optional: rename or describe Compose projects |
| `settings.yaml` | Appearance, weather location, news feeds, markets, host address, etc. |
| `bookmarks.yaml` | Simple list of links |
| `layout.json` | Hub composition (written automatically when you drag widgets) |
| `icons/` | Your own icon files |
| `backgrounds/` | Custom background images |
| `.env` | Secrets (never sent to the browser) |

You can also edit most of these from the Settings UI. Changes are written as clean, readable YAML.

---

## Philosophy in one sentence

> Show what is actually there, never invent what isn’t, and never give the browser more power than it needs.

This principle guides every feature — from how service URLs are resolved, to how monitoring treats a refused address as “no verdict” instead of an outage, to how the operations engine requires a server-minted confirmation token.

---

## Documentation

Deeper technical docs live in the `docs/` folder:

- [Architecture](docs/02-architecture.md)
- [Design system](docs/03-design-system.md)
- [Discovery contract](docs/04-discovery.md)
- [Authentication model](docs/06-auth.md)
- [Distribution & troubleshooting](docs/07-distribution.md)
- Phase documents (service intelligence, operations engine, infrastructure awareness, monitoring engine…)

---

## Running from source

```bash
npm install
npm run build
npm start          # serves the app + API on port 3000
```

Development mode:

```bash
npm run dev:web   # Vite build --watch
npm run dev       # Node with --watch
```

---

## Status

OpusHub is the front door of the larger **OpusGrid** vision — a calm, honest control plane for a homelab.  
It currently focuses on **visibility**, **safe navigation**, and **bounded operations**.  
Full orchestration, multi-host control planes, and advanced automation are intentional future work.

---

<p align="center">
  <sub>Built to be useful every day, not just impressive on day one.</sub>
</p>
