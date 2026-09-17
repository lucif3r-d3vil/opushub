// Configured physical topology — the part of the map only the operator can draw.
//
// A homelab's physical layer (ISP → ONT → router → switch → node → NAS → PDU → UPS) cannot be
// discovered from inside a container, and inventing it would be fabrication. So it is
// *configured*: `config/topology.yaml`, written by hand, read here, and rendered with its
// relationships labelled `configured` so nobody mistakes them for something OpusHub proved.
//
// There is no editor in Phase 9 — no endpoint writes this file. The model, the file format and the
// renderer exist; the UI to draw it belongs to a later phase, along with the review that comes
// with accepting operator-authored infrastructure claims.
//
// Why it is not a presentation config file: it describes a specific room's hardware, so it is
// machine-specific by nature. It is therefore excluded from export/import/history on purpose,
// like the host address and the Traefik entrypoint ports.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CONFIG_DIR } from '../configStore.js';

export const TOPOLOGY_FILE = 'topology.yaml';

/** Discovered node ids a configured link is allowed to point at. */
export const RESERVED_IDS = Object.freeze(['host', 'docker', 'opnsense']);

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NODES = 60;
const MAX_LINKS = 120;
const MAX_FILE_BYTES = 64 * 1024;

const KINDS = new Set(['isp', 'ont', 'router', 'firewall', 'switch', 'patch-panel', 'server', 'nas', 'ups', 'pdu', 'device']);

const EMPTY = Object.freeze({
  available: false,
  configured: false,
  nodes: [],
  links: [],
  reason: 'No physical topology is configured.',
  error: null,
});

function str(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Read and validate the file. Every rejection is a sentence the UI can show, and a rejected file
 * never partially renders: half a map that came from a typo is worse than no map.
 */
export function readPhysicalTopology() {
  const file = path.join(CONFIG_DIR, TOPOLOGY_FILE);
  let text = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ...EMPTY };
    if (stat.size > MAX_FILE_BYTES) {
      return { ...EMPTY, reason: 'The topology file is larger than OpusHub will read (64 KB).', error: 'too_large' };
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...EMPTY }; // no file — the normal case, and not an error
  }
  let parsed = null;
  try {
    parsed = YAML.parse(text);
  } catch {
    return { ...EMPTY, reason: 'The topology file is not valid YAML.', error: 'parse_error' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY, reason: 'The topology file is not a mapping of nodes and links.', error: 'shape' };
  }
  if (parsed.nodes != null && !Array.isArray(parsed.nodes)) {
    return { ...EMPTY, reason: 'The topology file’s “nodes” must be a list of devices.', error: 'shape' };
  }
  if (parsed.links != null && !Array.isArray(parsed.links)) {
    return { ...EMPTY, reason: 'The topology file’s “links” must be a list of connections.', error: 'shape' };
  }
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  if (rawNodes.length > MAX_NODES) {
    return { ...EMPTY, reason: `The topology file declares more than ${MAX_NODES} devices.`, error: 'too_many_nodes' };
  }

  const nodes = [];
  const ids = new Set();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') return { ...EMPTY, reason: 'Every device in the topology file must be a mapping.', error: 'shape' };
    const id = str(raw.id, 64);
    if (!id || !ID.test(id)) return { ...EMPTY, reason: `“${String(raw.id ?? '').slice(0, 40)}” is not a usable device id (letters, digits, - and _).`, error: 'bad_id' };
    if (ids.has(id)) return { ...EMPTY, reason: `The device id “${id}” is used twice.`, error: 'duplicate_id' };
    ids.add(id);
    const kind = str(raw.kind, 40);
    nodes.push({
      id,
      label: str(raw.label, 80) || id,
      kind: kind && KINDS.has(kind) ? kind : 'device',
      note: str(raw.note, 200),
      layer: 'physical',
    });
  }
  if (!nodes.length) return { ...EMPTY };

  const links = [];
  const seen = new Set();
  const push = (from, to, label) => {
    if (!ids.has(from) && !RESERVED_IDS.includes(from)) return `“${from}” is not a declared device`;
    if (!ids.has(to) && !RESERVED_IDS.includes(to)) return `“${to}” is not a declared device`;
    if (from === to) return `a device cannot link to itself (${from})`;
    const key = `${from}>${to}`;
    if (seen.has(key)) return null;
    seen.add(key);
    links.push({ from, to, label, source: 'configured' });
    return null;
  };

  for (const raw of rawNodes) {
    for (const to of Array.isArray(raw.linksTo) ? raw.linksTo : []) {
      const problem = push(raw.id, str(to, 64) || '', null);
      if (problem) return { ...EMPTY, reason: `The topology file links ${problem}.`, error: 'bad_link' };
    }
  }
  const rawLinks = Array.isArray(parsed.links) ? parsed.links : [];
  if (rawLinks.length > MAX_LINKS) return { ...EMPTY, reason: `The topology file declares more than ${MAX_LINKS} links.`, error: 'too_many_links' };
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== 'object') return { ...EMPTY, reason: 'Every link in the topology file must be a mapping.', error: 'shape' };
    const problem = push(str(raw.from, 64) || '', str(raw.to, 64) || '', str(raw.label, 80));
    if (problem) return { ...EMPTY, reason: `The topology file links ${problem}.`, error: 'bad_link' };
  }
  if (links.length > MAX_LINKS) return { ...EMPTY, reason: `The topology file declares more than ${MAX_LINKS} links.`, error: 'too_many_links' };

  return {
    available: true,
    configured: false, // set by the caller: true only when an operator actually saved this file
    nodes,
    links,
    reason: null,
    error: null,
  };
}

export function physicalTopology() {
  const doc = readPhysicalTopology();
  return { ...doc, configured: doc.available, file: TOPOLOGY_FILE, at: Date.now() };
}
