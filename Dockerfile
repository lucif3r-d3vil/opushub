# OpusHub — container image.
#
# The image contains code and nothing else: no config, no .env, no data, no secrets. Runtime state
# arrives entirely from the bind mounts, and the fleet itself arrives from the Docker socket.
# That is what makes the same image work on any Docker host with no rebuild and no code change.

# ---- 1. dependencies (kept in their own layer so source edits do not re-resolve them) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 2. build the SPA ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- 3. runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# the server reads the bundled icon sets + fonts out of node_modules, so those stay
COPY --from=build /app/dist ./dist
COPY server ./server
# /app/config is a mount point, never build input. It is created here so the app can start
# with an empty overlay directory — Docker decides what exists, so an empty config is a valid
# first run, not a crash.
RUN mkdir -p /app/config /app/data && chown -R node:node /app/config /app/data
ENV OPUSHUB_CONFIG_DIR=/app/config \
    OPUSHUB_DATA_DIR=/app/data \
    OPUSHUB_PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
LABEL org.opencontainers.image.title="OpusHub" \
      org.opencontainers.image.description="Read-only control center for a Docker host: live discovery, stacks, service pages, host vitals." \
      org.opencontainers.image.source="https://github.com/lucif3r-d3vil/opushub"
CMD ["node", "server/index.js"]

# Run it (see docs/04-discovery.md for the full compose snippet):
#
#   docker run -d --name opushub -p 3000:3000 \
#     -v $PWD/config:/app/config \
#     -v $PWD/data:/app/data \
#     -v /var/run/docker.sock:/var/run/docker.sock:ro \
#     -e OPUSHUB_HOST_ADDRESS=192.168.1.20 \
#     --group-add "$(stat -c %g /var/run/docker.sock)" \
#     opushub:latest
#
# The socket mount is read-only and the app only ever issues GETs; exec/restart/create/delete are
# not implemented anywhere. `--group-add` gives the unprivileged container user access to the socket
# group instead of running as root. `OPUSHUB_HOST_ADDRESS` is optional — it is only the fallback
# used for containers that publish a port and have no proxy labels (set it in Settings instead and
# it is written to config/settings.yaml).
