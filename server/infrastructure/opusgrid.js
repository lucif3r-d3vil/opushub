// The OpusGrid assembler — turns provider answers into the canonical infrastructure document.
//
// Every route in server/infrastructureApi.js reads from here, and nothing anywhere else
// interprets raw provider output. That is what makes the model canonical: there is exactly one
// place where "what does OpusHub know about storage?" is answered.
//
// Cost control (see docs/11-phase-9.md §performance):
//   • provider answers are cached and single-flighted by the registry, so five panels asking for
//     storage at once run `zpool list` once per window
//   • this module never polls; it answers what it is asked, when it is asked
//   • heavy lists are capped, and dataset/pool *detail* is fetched on demand through the
//     provider's own discovery-gated methods, never by re-listing everything
//   • topology and physical-topology documents are built from data already assembled here
import * as model from '../model.js';
import { getActiveAlerts } from '../alerts.js';
import { zfsProvider } from '../providers/zfs.js';
import { checkProvider, cachedData, describeProviders, providerStatusDoc, noteProviderStates } from './registry.js';
import { aggregateHealth } from './health.js';
import { noteInfrastructureState } from './state.js';
import { buildTopology } from './topology.js';
import { physicalTopology } from './physical.js';

/** List caps — a homelab is not a datacentre, and the DOM is not a database. */
const CAPS = Object.freeze({
  mountsSummary: 12, mounts: 32,
  pools: 16,
  datasetsSummary: 8, datasets: 200,
  interfaces: 24, dockerNetworks: 24, services: 120,
});

const byUsed = (a, b) => (Number(b?.used) || 0) - (Number(a?.used) || 0);

/** One provider's status document, or a safe stand-in when it is not registered. */
function statusFor(id) {
  return providerStatusDoc(id) || { id, status: 'unknown', statusLabel: 'Unknown', capabilities: [], active: [], error: null };
}

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

/**
 * The storage domain: filesystems, ZFS pools and datasets as three distinct things.
 *
 * `detail: true` returns the full (capped) lists — the Storage tab asks for it, the summary does
 * not, which is what keeps `/api/infrastructure` cheap enough to poll.
 */
export async function storageDocument({ detail = false } = {}) {
  const [fs, zfs] = await Promise.all([checkProvider('filesystem'), checkProvider('zfs')]);
  const mounts = fs?.data?.mounts || [];
  const pools = zfs?.data?.pools || [];
  const datasets = zfs?.data?.datasets || [];

  // State transitions are observed here because this is where the data is actually refreshed —
  // a poll that did not re-read ZFS cannot honestly claim to have noticed a change.
  noteInfrastructureState({ pools, datasets, mounts });

  const zfsAvailable = zfs?.status === 'available';
  return {
    at: Date.now(),
    providers: ['filesystem', 'zfs'],
    filesystems: {
      status: fs?.status || 'unknown',
      available: fs?.status === 'available',
      reason: fs?.error?.reason || null,
      mounts: mounts.slice(0, detail ? CAPS.mounts : CAPS.mountsSummary),
      mountCount: mounts.length,
      totals: fs?.data?.totals || null,
      truncated: mounts.length > (detail ? CAPS.mounts : CAPS.mountsSummary),
    },
    zfs: {
      status: zfs?.status || 'unknown',
      available: zfsAvailable,
      reason: zfs?.error?.reason || null,
      pools: pools.slice(0, CAPS.pools),
      poolCount: pools.length,
      datasets: detail ? datasets.slice(0, CAPS.datasets) : [...datasets].sort(byUsed).slice(0, CAPS.datasetsSummary),
      datasetCount: datasets.length,
      truncated: detail && datasets.length > CAPS.datasets,
      // ZFS present with nothing imported is a real state, and it is not the same as unavailable
      empty: !!zfs?.data?.empty,
    },
  };
}

/** One pool, with its topology if ZFS will say. null when ZFS never reported that name. */
export async function poolDocument(name) {
  await checkProvider('zfs');
  const zfs = cachedData('zfs');
  const pool = zfs?.pools?.find((p) => p.name === name);
  if (!pool) return null;
  const detail = await zfsProvider.methods.getPoolStatus(name);
  return {
    at: Date.now(),
    ...pool,
    topology: detail?.topology || { available: false, reason: 'ZFS did not report the pool layout.', vdevs: [] },
    datasets: (zfs?.datasets || []).filter((d) => d.pool === name).sort(byUsed),
  };
}

/** One dataset. null when ZFS never reported that name — nothing is listed on demand. */
export async function datasetDocument(name) {
  await checkProvider('zfs');
  const dataset = await zfsProvider.methods.getDataset(name);
  if (!dataset) return null;
  return { at: Date.now(), ...dataset };
}

/* ------------------------------------------------------------------ */
/* network                                                             */
/* ------------------------------------------------------------------ */

export async function networkDocument() {
  const [net, infra] = await Promise.all([
    checkProvider('network'),
    model.getInfra().catch(() => null),
  ]);
  const data = net?.data || null;
  const ifaces = data?.interfaces || [];
  noteInfrastructureState({ interfaces: ifaces });
  const dockerNetworks = (infra?.networks || []).slice(0, CAPS.dockerNetworks).map((n) => ({
    name: n.name, driver: n.driver, scope: n.scope, containerCount: n.containerCount,
    internal: !!n.internal, attachable: !!n.attachable,
  }));
  return {
    at: Date.now(),
    providers: ['network', 'docker'],
    status: net?.status || 'unknown',
    reason: net?.error?.reason || null,
    interfaces: ifaces.slice(0, CAPS.interfaces),
    interfaceCount: ifaces.length,
    counts: data?.counts || null,
    routes: data?.routes || null,
    dns: data?.dns || null,
    scope: data?.scope || null,
    scopeNote: data?.scopeNote || null,
    docker: {
      live: infra?.live ?? false,
      networks: dockerNetworks,
      networkCount: infra?.counts?.networks ?? null,
      reason: infra?.live ? null : (infra?.statusReason || 'The engine is not answering.'),
    },
  };
}

/* ------------------------------------------------------------------ */
/* power                                                              */
/* ------------------------------------------------------------------ */

export async function powerDocument() {
  const [ups, pdu] = await Promise.all([checkProvider('ups'), checkProvider('pdu')]);
  return {
    at: Date.now(),
    providers: ['ups', 'pdu'],
    ups: { ...(ups?.data || null), status: ups?.status || 'unknown', reason: ups?.error?.reason || null },
    pdu: { ...(pdu?.data || null), status: pdu?.status || 'unknown', reason: pdu?.error?.reason || null },
    note: 'Power devices are read-only when implemented. Outlet switching and UPS shutdown are not part of OpusHub.',
  };
}

/* ------------------------------------------------------------------ */
/* external (OPNsense)                                                */
/* ------------------------------------------------------------------ */

export async function externalDocument() {
  const opnsense = await checkProvider('opnsense');
  const data = opnsense?.data || null;
  return {
    at: Date.now(),
    providers: ['opnsense'],
    opnsense: {
      status: opnsense?.status || 'unknown',
      configured: !!data?.configured,
      url: data?.url || null,                       // origin only — no path, no credentials
      credentialSource: data?.credentialSource || 'environment',
      credentialPresent: !!data?.credentialPresent,
      version: opnsense?.version || null,
      reason: opnsense?.error?.reason || null,
      capabilities: data?.capabilityList || [],
      planned: data?.planned || [],
      system: data?.system || null,
      interfaces: data?.interfaces || null,
      gateways: data?.gateways || null,
      dns: data?.dns || null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* compute                                                            */
/* ------------------------------------------------------------------ */

export async function computeDocument() {
  const [dockerProvider, inventory] = await Promise.all([
    checkProvider('docker'),
    model.getInventory().catch(() => null),
  ]);
  return {
    at: Date.now(),
    providers: ['docker'],
    docker: {
      status: dockerProvider?.status || 'unknown',
      version: dockerProvider?.data?.version || dockerProvider?.version || null,
      reason: dockerProvider?.error?.reason || null,
      live: inventory?.live ?? false,
      counts: inventory ? {
        containers: inventory.stats?.containers ?? null,
        running: inventory.stats?.running ?? null,
        stopped: inventory.stats?.stopped ?? null,
        stacks: inventory.stats?.stacks ?? null,
      } : null,
      lastKnown: inventory?.live ? null : (inventory?.lastKnown || null),
    },
  };
}

/* ------------------------------------------------------------------ */
/* the whole picture                                                  */
/* ------------------------------------------------------------------ */

/**
 * The canonical OpusGrid document.
 *
 * `include` chooses how much detail the caller wants: the summary (default) carries counts and
 * the storage/network headlines; `storage`, `network`, `power` and `external` add their full
 * lists. Cheap by default is what keeps the status strip affordable on every page load.
 */
export async function opusGridDocument({ include = [] } = {}) {
  const want = new Set(Array.isArray(include) ? include : []);
  const providers = await describeProviders();
  noteProviderStates(providers);
  const health = aggregateHealth({ providers, alerts: getActiveAlerts() });

  const [storage, network, power, external, compute] = await Promise.all([
    storageDocument({ detail: want.has('storage') }),
    want.has('network') ? networkDocument() : networkHeadline(),
    want.has('power') ? powerDocument() : powerHeadline(),
    want.has('external') ? externalDocument() : externalHeadline(),
    computeDocument(),
  ]);

  return {
    at: Date.now(),
    health,
    providers,
    domains: {
      compute,
      storage,
      network,
      power,
      external,
    },
  };
}

/** The cheap forms: enough for the strip and the summary, no full lists. */
async function networkHeadline() {
  const net = await checkProvider('network');
  const data = net?.data || null;
  return {
    at: Date.now(),
    providers: ['network', 'docker'],
    status: net?.status || 'unknown',
    reason: net?.error?.reason || null,
    interfaces: [],
    interfaceCount: data?.counts?.interfaces ?? null,
    counts: data?.counts || null,
    routes: data?.routes || null,
    dns: data?.dns || null,
    scope: data?.scope || null,
    scopeNote: data?.scopeNote || null,
    docker: { live: false, networks: [], networkCount: null, reason: null },
    summaryOnly: true,
  };
}

async function powerHeadline() {
  const [ups, pdu] = await Promise.all([checkProvider('ups'), checkProvider('pdu')]);
  return {
    at: Date.now(),
    providers: ['ups', 'pdu'],
    ups: { status: ups?.status || 'unknown', reason: ups?.error?.reason || null, planned: ups?.data?.planned || [] },
    pdu: { status: pdu?.status || 'unknown', reason: pdu?.error?.reason || null, planned: pdu?.data?.planned || [] },
    summaryOnly: true,
  };
}

async function externalHeadline() {
  const opn = await checkProvider('opnsense');
  return {
    at: Date.now(),
    providers: ['opnsense'],
    opnsense: {
      status: opn?.status || 'unknown',
      configured: !!opn?.data?.configured,
      url: opn?.data?.url || null,
      credentialSource: opn?.data?.credentialSource || 'environment',
      credentialPresent: !!opn?.data?.credentialPresent,
      version: opn?.version || null,
      reason: opn?.error?.reason || null,
    },
    summaryOnly: true,
  };
}

/* ------------------------------------------------------------------ */
/* topology                                                           */
/* ------------------------------------------------------------------ */

export async function topologyDocument() {
  const [storage, network, dockerProvider] = await Promise.all([
    storageDocument({ detail: true }),
    networkDocument(),
    checkProvider('docker'),
  ]);
  let docker = { connected: false, networks: [], services: [] };
  if (dockerProvider?.status === 'connected') {
    const [infra, inv] = await Promise.all([
      model.getInfra().catch(() => null),
      model.getInventory().catch(() => null),
    ]);
    docker = {
      connected: true,
      networks: (infra?.networks || []).slice(0, CAPS.dockerNetworks).map((n) => ({
        name: n.name, driver: n.driver, containerCount: n.containerCount, containers: n.containers || [],
      })),
      services: (inv?.services || []).slice(0, CAPS.services).map((s) => ({
        name: s.name, group: s.group, displayName: s.displayName, state: s.status, container: { state: s.container?.state || null },
      })),
    };
  }
  const opn = await checkProvider('opnsense');
  const physical = physicalTopology();
  let hostname = null;
  try { hostname = (await model.getInventory().catch(() => null))?.engine?.name || null; } catch { /* optional */ }
  const graph = buildTopology({
    hostname,
    docker,
    storage: { pools: storage.zfs.pools, datasets: storage.zfs.datasets, filesystems: storage.filesystems.mounts },
    network: { interfaces: network.interfaces },
    opnsense: { configured: !!opn?.data?.configured, status: opn?.status, statusLabel: opn?.status },
    physical,
  });
  return graph;
}

export { statusFor };
