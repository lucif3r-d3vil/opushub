# Phase 10C — Container Recovery & Update Management

> Status: Shipped — Docker Autoheal integration, Diun image update detector adapter, safe authenticated Update Now control plane, UI components, and end-to-end test verification.

---

## 1. Executive Summary & Architecture

Phase 10C adds automated container recovery and controlled image update lifecycle management to OpusGrid while strictly preserving OpusHub's core architectural invariants:

1. **Autoheal is the recovery mechanism**: Docker Autoheal monitors container healthchecks and restarts unhealthy containers. OpusHub does *not* duplicate restart logic; it observes Autoheal status, discovers opted-in containers, normalizes upstream recovery alerts into canonical events, and displays recovery observability.
2. **Diun is the update detector**: Diun polls registries and detects newly available image tags and digest changes. Diun does *not* send independent notifications (no direct Telegram/email/webhook outbound from Diun). Diun posts update payloads exclusively to OpusHub's webhook intake (`/api/container-updates/webhook`).
3. **OpusHub is the control plane & notification center**:
   - Diun update discoveries and Autoheal restarts are normalized into canonical Phase 10B events (`container.update_available`, `container.updated`, `container.update_failed`, `container.autoheal.restarted`, `container.autoheal.failed`).
   - Notifications flow through OpusHub's canonical Event Bus, Notification Center, and Notification Providers (including Telegram).
   - "Update now" is a guarded, multi-step lifecycle operation executed strictly via the Docker Engine HTTP API over unix socket (`docker.sock`). No shell execution, no `docker compose` CLI execution, and no arbitrary commands.

---

## 2. Docker API Write Surface & Allow-List

### Frozen Minimal Allow-List for Container Recreate
Container recreation does NOT expose generic endpoints. It uses a dedicated, module-private client (`server/updates/recreateAdapter.js`) strictly frozen to 8 calls:

1. `POST /v<api>/images/create?fromImage=<imageRef>` (Pull image)
2. `GET  /v<api>/containers/<id>/json` (Inspect container configuration)
3. `POST /v<api>/containers/<id>/stop?t=15` (Graceful stop)
4. `POST /v<api>/containers/<id>/rename?name=<name>` (Rename old container)
5. `POST /v<api>/containers/create?name=<name>` (Create replacement container)
6. `POST /v<api>/networks/<netId>/connect` (Attach auxiliary networks)
7. `POST /v<api>/containers/<newId>/start` (Start replacement container)
8. `DELETE /v<api>/containers/<oldId>?v=0` (Remove old temporary container; `v=0` strictly prevents volume deletion)

No arbitrary commands, no exec, and no arbitrary shell execution exist anywhere in the code.

---

## 3. Configuration Fields Preserved

`server/updates/preserveConfig.js` constructs an allow-listed create payload from `docker inspect`:

| Configuration Domain | Preserved Fields |
| :--- | :--- |
| **Execution** | `Hostname`, `Domainname`, `User`, `WorkingDir`, `Entrypoint`, `Cmd` |
| **Environment** | Complete `Env` array preserved verbatim |
| **Labels** | All Traefik routing rules (`traefik.*`), Autoheal (`autoheal=true`), Diun (`diun.*`), OpusGrid metadata (`opushub.*`) |
| **Storage & Volumes** | All bind mounts (`/mnt/media:/media:ro`), named volumes (`jellyfin-config:/config:rw`), tmpfs mounts, and mount modes (`ro`/`rw`) |
| **Networks** | Primary network mode, IPAM static IPs, network aliases, auxiliary networks attached via `connect` |
| **Lifecycle & Health** | `RestartPolicy` (`unless-stopped`), custom `Healthcheck` parameters, `StopSignal`, `StopTimeout`, `Init` |
| **Security & Resources** | `Privileged`, `SecurityOpt`, `CapAdd`, `CapDrop`, `ReadonlyRootfs`, `Memory`, `NanoCpus`, `CpuShares`, `PidsLimit` |
| **Networking & DNS** | `Dns`, `DnsSearch`, `ExtraHosts`, `LogConfig` |

### Unsupported Fields & Ineligibility
- Host PID (`PidMode=host`) and Host IPC (`IpcMode=host`) namespaces are flagged as ineligible because they compromise isolation and cannot be safely recreated without host root privileges.
- Self-recreation of OpusHub is refused (OpusHub cannot recreate itself without killing its process).
- Recovery infrastructure (`autoheal`) cannot be updated automatically.
- Containers with `opushub.update=false` or `diun.enable=false` are explicitly refused.

---

## 4. Transaction State Machine & Rollback

`server/updates/transaction.js` maintains persistent transaction records in `data/updates/transactions.json`:

```
pending ──> pulling ──> inspecting ──> stopping ──> renaming ──> creating ──> starting ──> verifying ──> completed
   │           │            │            │            │            │           │            │
   ▼           ▼            ▼            ▼            ▼            ▼           ▼            ▼
 failed      failed       failed       failed     rolled_back  rolled_back  rolled_back  rolled_back
```

### Rollback Guarantees
- **Pull failure**: Old container remains untouched and running.
- **Stop failure**: Old container remains untouched.
- **Rename failure**: Old container restarted.
- **Create failure**: Old container renamed back to original name and restarted.
- **Start failure**: Replacement container deleted (`v=0`), old container renamed back and restarted.
- **Verification failure**: Replacement container stopped and deleted, old container restored.
- **Crash/Daemon restart**: Incomplete transactions are detected on boot and surfaced in UI as `recovery_required`.

---

## 5. Webhook Authentication & Security

Both inbound endpoints (`/api/autoheal/webhook` and `/api/container-updates/webhook`):
- Require `Authorization: Bearer <secret>` matching `OPUSHUB_WEBHOOK_SECRET`.
- Use constant-time comparison (`crypto.timingSafeEqual`).
- Sliding-window rate limit: maximum 30 requests/minute per client IP.
- Bounded payload size: maximum 64 KB.
- Strict payload schema validation.
- No secrets are leaked in logs, events, SSE, Activity, or API responses.

### Webhook Target Validation & Trust
- **Autoheal**: Webhook container names and IDs are resolved against live Docker inventory. Matched containers are marked `verified=true`; unmatched entries are recorded but excluded from confirmed service recoveries.
- **Diun**: Resolves container against live inventory. Proposed image repository MUST match the container's current image repository (`repo_mismatch` rejection). Cannot specify arbitrary images for Update Now.

---

## 6. Real-Host Production Deployment Blueprint

```yaml
version: '3.8'

services:
  opushub:
    image: ghcr.io/lucif3r-d3vil/opushub:latest
    container_name: opushub
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - OPUSHUB_PORT=3000
      - OPUSHUB_HOST=0.0.0.0
      - OPUSHUB_DATA_DIR=/data
      - OPUSHUB_CONFIG_DIR=/config
      - OPUSHUB_DOCKER_SOCKET=/var/run/docker.sock
      - OPUSHUB_WEBHOOK_SECRET=YOUR_SECURE_RANDOM_SECRET_HERE
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - opushub_data:/data
      - opushub_config:/config
    labels:
      - "autoheal=false"
      - "opushub.update=false"
      - "traefik.enable=true"
      - "traefik.http.routers.opushub.rule=Host(`hub.lab.internal`)"
      - "traefik.http.services.opushub.loadbalancer.server.port=3000"
    networks:
      - opusgrid_net

  autoheal:
    image: willfarrell/autoheal:1.2.0
    container_name: autoheal
    restart: unless-stopped
    environment:
      - AUTOHEAL_CONTAINER_LABEL=autoheal
      - AUTOHEAL_INTERVAL=10
      - AUTOHEAL_START_PERIOD=30
      - AUTOHEAL_DEFAULT_STOP_TIMEOUT=15
      - WEBHOOK_URL=http://opushub:3000/api/autoheal/webhook
      - WEBHOOK_HEADER_AUTHORIZATION=Bearer YOUR_SECURE_RANDOM_SECRET_HERE
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    labels:
      - "autoheal=false"
      - "opushub.update=false"
    networks:
      - opusgrid_net

  diun:
    image: crazymax/diun:4.28.0
    container_name: diun
    restart: unless-stopped
    command: serve
    environment:
      - TZ=UTC
      - LOG_LEVEL=info
      - LOG_JSON=true
      - DIUN_WATCH_WORKERS=5
      - DIUN_WATCH_SCHEDULE=0 0 * * *
      - DIUN_WATCH_JITTER=30s
      - DIUN_PROVIDERS_DOCKER=true
      - DIUN_PROVIDERS_DOCKER_WATCHSTOPPED=false
      - DIUN_NOTIF_WEBHOOK_ENDPOINT=http://opushub:3000/api/container-updates/webhook
      - DIUN_NOTIF_WEBHOOK_METHOD=POST
      - DIUN_NOTIF_WEBHOOK_HEADERS=Authorization:Bearer YOUR_SECURE_RANDOM_SECRET_HERE
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - diun_data:/data
    labels:
      - "autoheal=false"
      - "opushub.update=false"
    networks:
      - opusgrid_net

volumes:
  opushub_data:
  opushub_config:
  diun_data:

networks:
  opusgrid_net:
    name: opusgrid_net
    driver: bridge
```

---

## 7. Disposable Container Test Procedure

Before running updates on production services, execute this test on a disposable container.

The test explicitly distinguishes between:
1. **Webhook Intake Test** (recording observed update availability)
2. **Genuine Docker Registry/Image Verification** (independent registry manifest resolution)
3. **Update Now Execution** (guarded container recreation)

```bash
# ==============================================================================
# Step 0: Setup Disposable Target
# ==============================================================================
mkdir -p /tmp/opusgrid-test-data
echo "persistence-verified" > /tmp/opusgrid-test-data/index.html

docker run -d \
  --name opusgrid-disposable-test \
  --network opusgrid_net \
  -e TEST_ENV=verified_ok \
  -v /tmp/opusgrid-test-data:/usr/share/nginx/html:ro \
  -l "autoheal=true" \
  -l "traefik.enable=true" \
  -l "traefik.http.routers.test.rule=Host(\`test.lab.internal\`)" \
  --health-cmd "wget -q --spider http://localhost:80/ || exit 1" \
  --health-interval 5s \
  --restart unless-stopped \
  nginx:1.25-alpine

# ==============================================================================
# Step 1: Webhook Intake Test (Observed State Only)
# ==============================================================================
# Post an update notification to OpusHub's authenticated webhook intake.
# This test verifies that the webhook records "update_available" state but DOES NOT
# touch Docker and DOES NOT prove the image actually exists yet.
curl -X POST http://localhost:3000/api/container-updates/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECURE_RANDOM_SECRET_HERE" \
  -d '{
    "status": "update",
    "image": "nginx:1.26-alpine",
    "digest": "sha256:65961074a6142fb2d7ad7a70af3abf402710b8f80ecc10152d7ddfed00c4042c",
    "metadata": { "ctn_names": "opusgrid-disposable-test" }
  }'

# Verify in OpusHub UI or GET /api/container-updates that:
# - Target shows "Update available"
# - Container in Docker remains nginx:1.25-alpine (completely unmodified)

# ==============================================================================
# Step 2: Genuine Docker Registry/Image Verification (Forged Digest Defense)
# ==============================================================================
# If a webhook posts a fake non-existent digest, verify that Update Now independently
# queries the registry and rejects the pull before stopping the container.
curl -X POST http://localhost:3000/api/container-updates/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECURE_RANDOM_SECRET_HERE" \
  -d '{
    "status": "update",
    "image": "nginx:fake-nonexistent-tag-9999",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "metadata": { "ctn_names": "opusgrid-disposable-test" }
  }'

# In UI or API, attempting Update Now will fail with 502 (pull_failed).
# The running container is left running untouched.

# ==============================================================================
# Step 3: Update Now Execution (Genuine Recreate & Preservation)
# ==============================================================================
# Post the genuine update again:
curl -X POST http://localhost:3000/api/container-updates/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECURE_RANDOM_SECRET_HERE" \
  -d '{
    "status": "update",
    "image": "nginx:1.26-alpine",
    "metadata": { "ctn_names": "opusgrid-disposable-test" }
  }'

# In UI:
# - Inspect dry-run preflight modal: verify preserved volumes, environment, and networks.
# - Confirm update.
# - Verify that the container recreates to nginx:1.26-alpine and passes healthchecks.

# ==============================================================================
# Step 4: Post-Update Invariant Verification
# ==============================================================================
# 1. Verify new image is running
docker inspect opusgrid-disposable-test --format '{{.Config.Image}}'
# Expected: nginx:1.26-alpine

# 2. Verify volume persistence and marker file
docker exec opusgrid-disposable-test cat /usr/share/nginx/html/index.html
# Expected: persistence-verified

# 3. Verify environment variable preserved
docker exec opusgrid-disposable-test env | grep TEST_ENV
# Expected: TEST_ENV=verified_ok

# 4. Verify Traefik and Autoheal labels preserved
docker inspect opusgrid-disposable-test --format '{{json .Config.Labels}}' | jq .
# Expected: contains traefik.* and autoheal=true

# 5. Clean up
docker rm -f opusgrid-disposable-test
rm -rf /tmp/opusgrid-test-data
```
