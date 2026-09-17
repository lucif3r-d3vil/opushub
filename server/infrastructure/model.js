// The OpusGrid model — the vocabulary the rest of Phase 9 speaks.
//
// Phases 1–8 gave OpusHub a canonical Docker model. Phase 9 puts that model inside a bigger one
// without touching it:
//
//     OpusGrid
//       └── Host
//             ├── Compute    Docker · containers · services · stacks
//             ├── Storage    filesystems · ZFS pools · datasets
//             ├── Network    interfaces · routes · DNS · Docker networks
//             ├── Power      UPS · PDU
//             └── External   OPNsense
//
// The rule that keeps this honest: a branch is only populated by a provider that answered. There
// is no default value anywhere below, and no branch is filled in from another branch's numbers.
// An unconnected domain is `not-configured`, which is an answer, not a gap.
import { registerInfrastructureProviders } from './providers.js';

/** The five branches. Every provider declares which one it feeds. */
export const DOMAINS = Object.freeze(['compute', 'storage', 'network', 'power', 'external']);

export const DOMAIN_LABELS = Object.freeze({
  compute: 'Compute',
  storage: 'Storage',
  network: 'Network',
  power: 'Power',
  external: 'External',
});

/** Topology layers. A node has exactly one; the UI filters by these. */
export const LAYERS = Object.freeze(['physical', 'network', 'compute', 'storage', 'services']);

export const LAYER_LABELS = Object.freeze({
  physical: 'Physical',
  network: 'Network',
  compute: 'Compute',
  storage: 'Storage',
  services: 'Services',
});

export const NODE_KINDS = Object.freeze([
  'host', 'docker', 'network', 'service', 'interface', 'pool', 'dataset', 'filesystem',
  'opnsense', 'gateway', 'ups', 'pdu',
  // physical-layer devices, only ever present when an operator configured them
  'isp', 'ont', 'router', 'firewall', 'switch', 'patch-panel', 'server', 'nas', 'device',
]);

/**
 * Where a topology relationship came from. There is deliberately no third value: a link is either
 * proven by a provider or asserted by the operator, and "we guessed" is not a source.
 */
export const RELATIONSHIP_SOURCES = Object.freeze(['discovered', 'configured']);

/** Usage thresholds for storage alerts. One place, so the UI and the engine agree. */
export const THRESHOLDS = Object.freeze({ warning: 90, critical: 95 });

/** Importing the model imports the providers: nothing can use the vocabulary without them. */
registerInfrastructureProviders();
