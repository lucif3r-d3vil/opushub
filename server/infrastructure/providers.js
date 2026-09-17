// Provider registration — the one place that decides which providers OpusGrid has.
//
// Registering a provider is what makes it exist everywhere: the status strip, the Connections
// pane, the health aggregator, the topology builder and the search index all read the registry.
// Nothing else in the codebase may name a provider directly.
//
// Registration order matters only for display: the UI shows them in the order below.
//
// Providers are independent by construction — see registry.js. A host with Docker and no ZFS,
// no OPNsense and no UPS is a complete OpusGrid; it is not an unhealthy one.
import * as docker from '../providers/docker.js';
import { filesystemCheck, zfsCheck } from '../providers/storage.js';
import { networkProvider } from '../providers/network.js';
import { createOpnsenseProvider } from '../providers/opnsense.js';
import { opnsenseConfig, opnsenseCredentials } from '../providers/opnsenseConfig.js';
import { upsProvider, pduProvider } from '../providers/power.js';
import { registerProvider, isKnownProvider } from './registry.js';

/**
 * Docker — the canonical compute provider. This is a thin status adapter: container discovery,
 * stacks, networks, volumes and images stay exactly where Phases 1–8 put them (server/model.js
 * and server/providers/docker.js). Phase 9 does not replace the Docker model; it places it.
 */
async function dockerCheck() {
  const availability = docker.availability();
  if (!availability.ok) {
    return {
      status: 'unavailable',
      capabilities: [],
      version: null,
      error: { code: 'not_configured', reason: availability.reason || 'No Docker endpoint is configured.' },
      data: null,
    };
  }
  const probed = await docker.probe().catch(() => false);
  if (!probed) {
    return {
      status: 'unavailable',
      capabilities: [],
      version: null,
      error: { code: 'unreachable', reason: 'The Docker engine is not responding.' },
      data: null,
    };
  }
  const engine = await docker.engineInfo().catch(() => null);
  return {
    status: 'connected',
    capabilities: ['containers', 'networks', 'volumes', 'images'],
    version: engine?.version || null,
    error: null,
    data: { version: engine?.version || null, apiVersion: engine?.apiVersion || null, at: Date.now() },
  };
}

const opnsense = createOpnsenseProvider({
  config: opnsenseConfig,
  credentials: opnsenseCredentials,
});

/**
 * Provider table. `optional: true` means "an install without this is normal" — see health.js for
 * why that distinction is the whole point of the aggregator.
 */
const PROVIDERS = [
  {
    id: 'docker', type: 'compute', name: 'Docker', domain: 'compute', optional: false,
    capabilities: ['containers', 'networks', 'volumes', 'images'], ttlMs: 30_000,
    description: 'Containers, stacks, networks, volumes and images, read from the engine.',
    check: dockerCheck,
  },
  {
    id: 'filesystem', type: 'storage', name: 'Filesystems', domain: 'storage', optional: false,
    capabilities: ['filesystems'], ttlMs: 30_000,
    description: 'Mounted filesystems and their usage, from the kernel’s own mount table.',
    check: filesystemCheck,
  },
  {
    id: 'zfs', type: 'storage', name: 'ZFS', domain: 'storage', optional: true,
    capabilities: ['pools', 'datasets'], ttlMs: 60_000,
    description: 'ZFS pools and datasets, read-only, through a fixed command table.',
    check: zfsCheck,
  },
  {
    id: 'network', type: 'network', name: 'Host network', domain: 'network', optional: false,
    capabilities: ['interfaces', 'routes', 'dns'], ttlMs: 30_000,
    description: 'Interfaces, addresses, traffic counters, the default route and the resolver.',
    check: () => networkProvider.check(),
  },
  {
    id: 'opnsense', type: 'firewall', name: 'OPNsense', domain: 'external', optional: true,
    capabilities: ['system', 'interfaces', 'gateways', 'dns'],
    planned: ['dhcp', 'firewall'],
    ttlMs: 60_000,
    description: 'Optional read-only view of the upstream firewall/router. Not required.',
    check: () => opnsense.check(),
  },
  {
    id: 'ups', type: 'power', name: 'UPS', domain: 'power', optional: true,
    capabilities: [], ttlMs: 300_000,
    description: 'Uninterruptible power supply status. No client is connected yet.',
    check: () => upsProvider.check(),
  },
  {
    id: 'pdu', type: 'power', name: 'PDU', domain: 'power', optional: true,
    capabilities: [], ttlMs: 300_000,
    description: 'Power distribution unit status. No client is connected yet.',
    check: () => pduProvider.check(),
  },
];

let registered = false;

/** Idempotent: importing this module is what registers the providers. */
export function registerInfrastructureProviders() {
  if (registered) return;
  for (const def of PROVIDERS) {
    if (isKnownProvider(def.id)) continue;
    registerProvider(def);
  }
  registered = true;
}

registerInfrastructureProviders();

export { opnsense };
