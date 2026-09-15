// OpusGrid host model — ONE canonical representation of the machine OpusHub watches.
//
// Every page that talks about \"the host\" reads this document instead of interpreting raw
// provider output itself. Sources, all read-only:
//
//   system provider   hostname, OS, kernel, arch, CPU model/cores, RAM, uptime, temps
//   docker provider   engine version/API, daemon status, container/image/volume/network counts
//   discovery         configured vs detected host address, Traefik presence + entrypoints
//   version           OpusHub version, git SHA, build time, install mode
//
// Unavailable information is explicit (`null` + `*_source: 'unavailable'`), never invented.
// Nothing here exposes socket paths, environment, credentials, or filesystem locations.
import os from 'node:os';
import * as docker from './providers/docker.js';
import { collect as collectSystem } from './providers/system.js';
import { versionInfo } from './version.js';
import { hostAddress } from './lib/hostAddress.js';
import { getSettings, getInventory } from './model.js';

let cache = { at: 0, value: null };
const CACHE_MS = 15_000;
let inflight = null;

function cpus() {
  try {
    const list = os.cpus() || [];
    return {
      model: list[0]?.model?.trim() || null,
      cores: list.length || null, // logical threads as the kernel reports them
      threads: list.length || null,
    };
  } catch { return { model: null, cores: null, threads: null }; }
}

function memTotal() {
  const total = os.totalmem?.();
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Build the host document. `inventory` may be supplied by callers that already hold it
 * (the API routes do) to avoid a second discovery pass; otherwise it is read here.
 */
export async function hostDocument({ inventory = null } = {}) {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const [system, engine, settings] = await Promise.all([
      collectSystem().catch(() => null),
      docker.engineInfo().catch(() => null),
      Promise.resolve().then(() => { try { return getSettings(); } catch { return null; } }),
    ]);
    let inv = inventory;
    if (!inv) {
      try { inv = await getInventory(); } catch { inv = null; }
    }
    const dockerAvail = docker.availability();
    const infra = settings?.infrastructure || {};
    const host = infra.hostAddress
      ? { address: String(infra.hostAddress), source: 'configured' }
      : await hostAddress().catch(() => ({ address: null, source: 'unavailable' }));

    // Traefik: proven only by containers that carry proxy labels, or a running container
    // whose image/name reads as the Traefik binary. Entrypoints come from router labels.
    const services = inv?.services || [];
    const proxied = services.filter((s) => (s.container?.labels?.proxy || []).length);
    const routers = proxied.flatMap((s) => s.container.labels.proxy);
    const entrypoints = [...new Set(routers.flatMap((r) => r.entrypoints || []))].sort();
    const traefikContainer = services.find((s) => /\/traefik(?::|$)/i.test(s.container?.image || '') || s.container?.name === 'traefik');
    const traefik = {
      detected: proxied.length > 0 || !!traefikContainer,
      source: proxied.length ? 'container-labels' : traefikContainer ? 'container-image' : 'unavailable',
      routedContainers: proxied.length,
      routers: routers.length,
      tlsRouters: routers.filter((r) => r.tls).length,
      entrypoints,
      container: traefikContainer ? { name: traefikContainer.name, state: traefikContainer.container?.state || null } : null,
    };

    const cpu = cpus();
    const value = {
      at: now,
      host: {
        hostname: system?.host?.hostname || os.hostname?.() || null,
        os: system?.host?.os || null,
        kernel: system?.host?.kernel || null,
        arch: system?.host?.arch || null,
        model: system?.host?.model || null,
        uptimeSec: system?.host?.uptimeSec ?? null,
        bootAt: system?.host?.bootAt || null,
      },
      cpu: {
        model: cpu.model || system?.cpu?.model || null,
        cores: system?.cpu?.cores ?? cpu.cores,
        threads: cpu.threads,
        mhz: system?.cpu?.mhz ?? null,
      },
      memory: { total: system?.memory?.total ?? memTotal() },
      docker: {
        status: dockerAvail.ok && engine ? 'connected' : dockerAvail.ok ? 'degraded' : dockerAvail.state,
        available: dockerAvail.ok,
        version: engine?.version || null,
        apiVersion: engine?.apiVersion || null,
        os: engine?.os || null,
        arch: engine?.arch || null,
        driver: engine?.driver || null,
        containers: engine?.containers ?? inv?.stats?.containers ?? null,
        running: engine?.running ?? inv?.stats?.running ?? null,
        stopped: engine?.stopped ?? inv?.stats?.stopped ?? null,
        paused: engine?.paused ?? null,
        images: null, // filled by the infrastructure inventory, not the engine summary
        volumes: null,
        networks: null,
      },
      address: {
        configured: infra.hostAddress || null,
        detected: host.source !== 'configured' ? host.address : null,
        effective: host.address || null,
        source: host.source || 'unavailable',
      },
      traefik,
      opushub: versionInfo(),
      sources: {
        system: system ? 'system-provider' : 'unavailable',
        docker: engine ? 'docker-engine' : dockerAvail.ok ? 'unreachable' : dockerAvail.state,
        inventory: inv ? (inv.live ? 'live-discovery' : 'last-known') : 'unavailable',
      },
    };
    cache = { at: Date.now(), value };
    inflight = null;
    return value;
  })();
  try { return await inflight; } finally { inflight = null; }
}

/** Test helper — the document is cached per process. */
export function _resetHost() { cache = { at: 0, value: null }; inflight = null; }
