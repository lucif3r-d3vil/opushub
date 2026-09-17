// Phase 9F — the OpusGrid topology: what gets drawn, and (more importantly) what does not.
//
// The load-bearing assertion in this file is the negative one: with nothing configured and only
// Docker connected, the graph contains exactly the relationships the daemon proved, and not one
// relationship OpusHub might consider "usually true". A router is not drawn above a host because
// routers usually sit above hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9topo-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9topo-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { buildTopology, emptyTopology } = await import('./infrastructure/topology.js');
const { readPhysicalTopology, physicalTopology, RESERVED_IDS } = await import('./infrastructure/physical.js');
const { RELATIONSHIP_SOURCES, LAYERS } = await import('./infrastructure/model.js');

const TOPOLOGY_FILE = path.join(CONFIG_DIR, 'topology.yaml');

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** A world in which Docker is connected and nothing else exists. */
const dockerOnly = () => ({
  hostname: 'opusgrid',
  docker: {
    connected: true,
    networks: [
      { name: 'proxy', driver: 'bridge', containerCount: 2, containers: [{ name: 'wave' }, { name: 'stream' }] },
      { name: 'default', driver: 'bridge', containerCount: 0, containers: [] },
    ],
    services: [
      { name: 'wave', group: 'Music', displayName: 'Wave', state: 'up', container: { state: 'running' } },
      { name: 'stream', group: 'Media', displayName: 'Stream', state: 'up', container: { state: 'running' } },
      { name: 'orphan', group: 'Other', displayName: 'Orphan', state: 'down', container: { state: 'exited' } },
    ],
  },
  storage: { pools: [], datasets: [], filesystems: [] },
  network: { interfaces: [] },
  opnsense: { configured: false, status: 'not-configured' },
  physical: { available: false, configured: false, nodes: [], links: [], reason: 'No physical topology is configured.', error: null },
});

test('an empty world draws a host and nothing else — no decorative topology', () => {
  const g = emptyTopology();
  assert.deepEqual(g.nodes.map((n) => n.id), ['host']);
  assert.deepEqual(g.edges, []);
  assert.equal(g.sources.discovered, 0);
  assert.equal(g.sources.configured, 0);
  for (const l of LAYERS) assert.equal(g.layers[l], l === 'compute' ? 1 : 0);
});

test('docker attachments are drawn because the daemon reported them', () => {
  const g = buildTopology(dockerOnly());
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('host') && ids.includes('docker'));
  assert.ok(ids.includes('net:proxy') && ids.includes('svc:wave'));
  assert.ok(g.edges.some((e) => e.from === 'host' && e.to === 'docker' && e.source === 'discovered'));
  assert.ok(g.edges.some((e) => e.from === 'docker' && e.to === 'net:proxy' && e.source === 'discovered'));
  assert.ok(g.edges.some((e) => e.from === 'net:proxy' && e.to === 'svc:wave' && e.source === 'discovered'));
  // a service the daemon did not attach anywhere is drawn, but unlinked
  assert.ok(ids.includes('svc:orphan'));
  assert.ok(!g.edges.some((e) => e.to === 'svc:orphan'), 'an unattached container gets no invented edge');
});

test('with Docker unreachable there is no engine and no network layer', () => {
  const world = dockerOnly();
  world.docker.connected = false;
  const g = buildTopology(world);
  assert.ok(!g.nodes.some((n) => n.id === 'docker'));
  assert.ok(!g.edges.some((e) => e.from === 'host'));
  assert.equal(g.layers.network, 0);
});

test('storage and network nodes appear only where a provider proved them', () => {
  const world = dockerOnly();
  world.storage = {
    pools: [{ name: 'tank', health: 'ONLINE', capacityPct: 40 }],
    datasets: [{ name: 'tank/media', pool: 'tank', mountpoint: '/tank/media' }, { name: 'rpool/data', pool: 'rpool' }],
    filesystems: [{ mount: '/', fs: 'ext4', usedPct: 40 }],
  };
  world.network = { interfaces: [{ name: 'eth0', state: 'up', kind: 'ethernet', addresses: [{ address: '198.51.100.20', family: 'ipv4', scope: 'global' }] }] };
  const g = buildTopology(world);

  assert.ok(g.nodes.some((n) => n.id === 'pool:tank'));
  assert.ok(g.nodes.some((n) => n.id === 'ds:tank/media'));
  assert.ok(g.nodes.some((n) => n.id === 'iface:eth0'));
  assert.ok(g.nodes.some((n) => n.id === 'fs:/'));
  // ZFS's own hierarchy is what proves this edge
  assert.ok(g.edges.some((e) => e.from === 'pool:tank' && e.to === 'ds:tank/media' && e.source === 'discovered'));
  // a dataset whose pool was not reported is drawn, but not attached to a pool that does not exist
  assert.ok(g.nodes.some((n) => n.id === 'ds:rpool/data'));
  assert.ok(!g.edges.some((e) => e.to === 'ds:rpool/data'), 'no edge to a pool that was never reported');
  // the host edges come from /sys and /proc, not from a guess about what is plugged in
  assert.ok(g.edges.some((e) => e.from === 'host' && e.to === 'iface:eth0'));
  assert.ok(g.edges.some((e) => e.from === 'host' && e.to === 'fs:/'));
});

test('a reachable OPNsense is drawn, and is NOT connected to anything', () => {
  const world = dockerOnly();
  world.opnsense = { configured: true, status: 'connected', statusLabel: 'Connected' };
  const g = buildTopology(world);
  const opn = g.nodes.find((n) => n.id === 'opnsense');
  assert.ok(opn, 'a configured firewall is shown');
  assert.equal(opn.layer, 'network');
  assert.ok(!g.edges.some((e) => e.from === 'opnsense' || e.to === 'opnsense'),
    'OpusHub does not infer that the firewall is the gateway');
});

test('every relationship is attributable: there is no third source', () => {
  const g = buildTopology(dockerOnly());
  for (const e of g.edges) {
    assert.ok(RELATIONSHIP_SOURCES.includes(e.source), `edge ${e.from}→${e.to} has source "${e.source}"`);
  }
  const src = fs.readFileSync(path.join(process.cwd(), 'server/infrastructure/topology.js'), 'utf8');
  assert.ok(!src.includes("'inferred'"), 'the model has no "inferred" relationship source at all');
});

/* ------------------------------------------------------------------ */
/* configured physical topology                                        */
/* ------------------------------------------------------------------ */

test('with no topology file the physical layer is empty, and says why', () => {
  const doc = physicalTopology();
  assert.equal(doc.available, false);
  assert.equal(doc.configured, false);
  assert.match(doc.reason, /No physical topology is configured/);
  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.links, []);
});

test('a configured topology is drawn, and labelled as configured', () => {
  fs.writeFileSync(TOPOLOGY_FILE, YAML.stringify({
    nodes: [
      { id: 'isp', label: 'ISP', kind: 'isp' },
      { id: 'ont', label: 'ONT', kind: 'ont' },
      { id: 'fw', label: 'OPNsense', kind: 'router' },
      { id: 'switch', label: 'Managed switch', kind: 'switch' },
    ],
    links: [
      { from: 'isp', to: 'ont', label: 'fibre' },
      { from: 'ont', to: 'fw' },
      // an operator may assert a link to a discovered object; it stays a configured claim
      { from: 'fw', to: 'host' },
    ],
  }));
  const doc = readPhysicalTopology();
  assert.equal(doc.available, true);
  assert.equal(doc.nodes.length, 4);
  assert.equal(doc.links.length, 3);
  assert.ok(doc.links.every((l) => l.source === 'configured'));

  const world = dockerOnly();
  world.physical = doc;
  const g = buildTopology(world);
  assert.ok(g.nodes.some((n) => n.id === 'phys:isp' && n.layer === 'physical' && n.source === 'configured'));
  assert.ok(g.edges.some((e) => e.from === 'phys:fw' && e.to === 'host' && e.source === 'configured'));
  assert.equal(g.layers.physical, 4);
  assert.equal(g.sources.configured, 3);
  assert.ok(g.edges.some((e) => e.source === 'discovered'), 'discovered edges are not replaced by configured ones');
  fs.rmSync(TOPOLOGY_FILE, { force: true });
});

test('reserved ids are the only discovered objects a configured link may point at', () => {
  assert.deepEqual([...RESERVED_IDS].sort(), ['docker', 'host', 'opnsense']);
  fs.writeFileSync(TOPOLOGY_FILE, YAML.stringify({
    nodes: [{ id: 'isp', kind: 'isp' }],
    links: [{ from: 'isp', to: 'pool:tank' }],
  }));
  const doc = readPhysicalTopology();
  assert.equal(doc.available, false, 'a link to an unknown device invalidates the file rather than half-drawing it');
  assert.match(doc.reason, /not a declared device/);
  fs.rmSync(TOPOLOGY_FILE, { force: true });
});

test('a malformed or hostile topology file is refused with a sentence, not drawn', () => {
  const cases = [
    ['- just\n- a list', /not a mapping/],
    ['nodes: "a string"', /must be a list/],
    ['nodes: []\nlinks: "nope"', /must be a list/],
    ['nodes:\n  - id: "../etc"\n    kind: isp', /not a usable device id/],
    ['nodes:\n  - id: dup\n    kind: isp\n  - id: dup\n    kind: isp', /used twice/],
    ['nodes:\n  - id: a\n    kind: isp\n    linksTo: [ghost]', /not a declared device/],
    ['nodes:\n  - id: a\n    kind: isp\nlinks:\n  - from: a\n    to: a', /cannot link to itself/],
    ['nodes: [{{ bad yaml', /not valid YAML/],
  ];
  for (const [text, reason] of cases) {
    fs.writeFileSync(TOPOLOGY_FILE, text);
    const doc = readPhysicalTopology();
    assert.equal(doc.available, false, `refused: ${text.slice(0, 30)}`);
    assert.match(doc.reason || '', reason);
    assert.deepEqual(doc.nodes, [], 'a rejected file never partially renders');
  }
  fs.rmSync(TOPOLOGY_FILE, { force: true });
});

test('a huge or deeply nested file is bounded', () => {
  const nodes = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, kind: 'device' }));
  fs.writeFileSync(TOPOLOGY_FILE, YAML.stringify({ nodes }));
  assert.match(readPhysicalTopology().reason || '', /more than 60 devices/);
  fs.rmSync(TOPOLOGY_FILE, { force: true });
});
