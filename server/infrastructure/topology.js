// OpusGrid topology — a map of relationships, every one of them attributable.
//
// The Phase 7 topology drew Docker network attachments and nothing else, because that is all the
// daemon proves. Phase 9 widens it to the whole infrastructure, and the rule does not change:
//
//     an edge exists only when a provider proved it (source: 'discovered') or the operator
//     asserted it in config/topology.yaml (source: 'configured')
//
// There is no third source. Nothing here infers that OPNsense is the gateway because it is
// "usually" the gateway, or that a switch sits above a node because that is how racks are built.
// A relationship that is merely plausible is not drawn.
//
// Proven edges, and what proves them:
//   host → docker        the engine answers (docker provider)
//   docker → network     the engine lists the network
//   network → service    the engine's own attachment map for that network
//   host → interface     the kernel lists it in /sys/class/net
//   host → filesystem    the kernel lists it in /proc/mounts
//   host → pool          `zpool list` reported it on this host
//   pool → dataset       `zfs list` reported the dataset as a child of that pool
//
// The physical layer (ISP, ONT, switch, NAS, UPS…) comes from configuration only. With no
// topology.yaml the Physical layer is empty, and says so.
import { LAYERS, RELATIONSHIP_SOURCES } from './model.js';
import { physicalTopology, RESERVED_IDS } from './physical.js';

/** Reserved ids are the discovered nodes a configured link may terminate at. */
const RESERVED = new Set(RESERVED_IDS);

const MAX_SERVICES = 120;
const MAX_DATASETS = 80;

function node(id, { label, sub = null, kind, layer, source = 'discovered', state = null, href = null, note = null }) {
  return { id, label, sub, kind, layer, source, state, href, note };
}

function edge(from, to, { source = 'discovered', kind = null, label = null } = {}) {
  return { from, to, source, kind, label };
}

/**
 * Build the graph. Pure: everything it knows arrives in the argument, so tests can prove the
 * "no invented relationship" rule by handing it an empty world.
 */
export function buildTopology({
  hostname = null,
  docker = null,          // { connected, networks: [{name, driver, containers:[{name}]}], services: [{name, group, displayName, state, container:{state}}] }
  storage = null,         // { pools: [], datasets: [], filesystems: [] }
  network = null,         // { interfaces: [] }
  opnsense = null,        // { status, configured, url }
  physical = null,        // physicalTopology() document
} = {}) {
  const nodes = [];
  const edges = [];
  const addNode = (n) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); };

  // ---- compute layer -------------------------------------------------------
  const hostName = hostname || 'OpusGrid host';
  addNode(node('host', { label: hostName, sub: 'host', kind: 'host', layer: 'compute', href: '/host' }));

  const dockerConnected = !!(docker?.connected);
  if (dockerConnected) {
    addNode(node('docker', { label: 'Docker', sub: 'container engine', kind: 'docker', layer: 'compute' }));
    edges.push(edge('host', 'docker', { kind: 'runs' }));
  }

  // ---- network layer -------------------------------------------------------
  // Docker's own resources are drawn only when the engine answered. A last-known inventory is
  // shown on the Services page as stale counts; drawing it here as a live graph would be a claim
  // OpusHub cannot currently prove.
  const nets = dockerConnected && Array.isArray(docker?.networks) ? docker.networks : [];
  for (const n of nets.slice(0, 24)) {
    if (!n?.name) continue;
    addNode(node(`net:${n.name}`, {
      label: String(n.name),
      sub: [n.driver, n.containerCount != null ? `${n.containerCount} attached` : null].filter(Boolean).join(' · ') || null,
      kind: 'network', layer: 'network',
    }));
    if (dockerConnected) edges.push(edge('docker', `net:${n.name}`, { kind: 'provides' }));
  }

  const ifaces = Array.isArray(network?.interfaces) ? network.interfaces : [];
  for (const i of ifaces.slice(0, 24)) {
    if (!i?.name) continue;
    addNode(node(`iface:${i.name}`, {
      label: i.name,
      sub: [i.state, (i.addresses || [])[0]?.address].filter(Boolean).join(' · ') || null,
      kind: 'interface', layer: 'network', state: i.state,
    }));
    // the kernel listing the interface on this host is what proves the edge
    edges.push(edge('host', `iface:${i.name}`, { kind: 'has' }));
  }

  // ---- storage layer -------------------------------------------------------
  const pools = Array.isArray(storage?.pools) ? storage.pools : [];
  const datasets = Array.isArray(storage?.datasets) ? storage.datasets : [];
  const filesystems = Array.isArray(storage?.filesystems) ? storage.filesystems : [];
  for (const p of pools.slice(0, 16)) {
    if (!p?.name) continue;
    addNode(node(`pool:${p.name}`, {
      label: p.name,
      sub: [p.health, p.capacityPct != null ? `${p.capacityPct}% used` : null].filter(Boolean).join(' · ') || null,
      kind: 'pool', layer: 'storage', state: p.health ? String(p.health).toLowerCase() : null,
      href: `/infrastructure?tab=storage&pool=${encodeURIComponent(p.name)}`,
    }));
    edges.push(edge('host', `pool:${p.name}`, { kind: 'has' }));
  }
  for (const d of datasets.slice(0, MAX_DATASETS)) {
    if (!d?.name) continue;
    addNode(node(`ds:${d.name}`, {
      label: d.name,
      sub: d.mountpoint || null,
      kind: 'dataset', layer: 'storage',
      href: `/infrastructure?tab=storage&dataset=${encodeURIComponent(d.name)}`,
    }));
    // ZFS itself reports the hierarchy: a dataset name begins with its pool name.
    if (pools.some((p) => p.name === d.pool)) edges.push(edge(`pool:${d.pool}`, `ds:${d.name}`, { kind: 'contains' }));
  }
  for (const m of filesystems.slice(0, 32)) {
    if (!m?.mount) continue;
    addNode(node(`fs:${m.mount}`, {
      label: m.mount,
      sub: [m.fs, m.usedPct != null ? `${m.usedPct}% used` : null].filter(Boolean).join(' · ') || null,
      kind: 'filesystem', layer: 'storage',
    }));
    edges.push(edge('host', `fs:${m.mount}`, { kind: 'mounts' }));
  }

  // ---- services layer ------------------------------------------------------
  const services = dockerConnected && Array.isArray(docker?.services) ? docker.services : [];
  const attached = new Set();
  for (const n of nets) for (const c of n.containers || []) attached.add(c.name);
  const ordered = [...services].sort((a, b) => String(a.displayName || a.name).localeCompare(String(b.displayName || b.name)));
  for (const s of ordered.slice(0, MAX_SERVICES)) {
    if (!s?.name) continue;
    addNode(node(`svc:${s.name}`, {
      label: s.displayName || s.name,
      sub: s.group || null,
      kind: 'service', layer: 'services', state: s.container?.state || s.state || null,
      href: `/services/${encodeURIComponent(s.group || 'Other')}/${encodeURIComponent(s.name)}`,
    }));
  }
  for (const n of nets.slice(0, 24)) {
    for (const c of n.containers || []) {
      if (!c?.name) continue;
      if (!nodes.some((x) => x.id === `svc:${c.name}`)) continue;
      edges.push(edge(`net:${n.name}`, `svc:${c.name}`, { kind: 'attaches' }));
      attached.add(c.name);
    }
  }

  // ---- external / configured ----------------------------------------------
  if (opnsense?.configured && opnsense?.status && opnsense.status !== 'not-configured') {
    addNode(node('opnsense', {
      label: 'OPNsense',
      sub: opnsense.statusLabel || null,
      kind: 'opnsense', layer: 'network', source: 'discovered',
      note: 'Configured by the operator; OpusHub does not infer what it connects to.',
    }));
    // No edge. Being reachable says nothing about what it is connected to — the operator draws
    // that, in config/topology.yaml, or it stays undrawn.
  }

  const phys = physical || physicalTopology();
  if (phys.available) {
    for (const n of phys.nodes) {
      addNode(node(`phys:${n.id}`, {
        label: n.label, sub: n.kind, kind: n.kind, layer: 'physical', source: 'configured', note: n.note,
      }));
    }
    for (const l of phys.links) {
      const from = RESERVED.has(l.from) ? l.from : `phys:${l.from}`;
      const to = RESERVED.has(l.to) ? l.to : `phys:${l.to}`;
      edges.push(edge(from, to, { source: 'configured', label: l.label }));
    }
  }

  const counts = Object.fromEntries(LAYERS.map((l) => [l, nodes.filter((n) => n.layer === l).length]));
  const bySource = Object.fromEntries(RELATIONSHIP_SOURCES.map((s) => [s, edges.filter((e) => e.source === s).length]));

  return {
    at: Date.now(),
    nodes,
    edges,
    layers: counts,
    sources: bySource,
    physical: { available: phys.available, configured: phys.configured, reason: phys.reason, nodes: phys.nodes.length, links: phys.links.length },
    // stated, so the UI can repeat it instead of implying the graph is complete
    rule: 'Every link is either proven by a provider or configured by you. Nothing is inferred.',
  };
}

/** Convenience for tests and for the route: a graph with nothing in it. */
export function emptyTopology() {
  return buildTopology({});
}
