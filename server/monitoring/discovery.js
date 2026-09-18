// Monitor discovery — suggestions, never surprises.
//
// OpusHub already knows which of the operator's services have a real, resolvable endpoint: the
// canonical inventory carries that answer, with its *source* (`manual`, `traefik`,
// `published-port`) and its reasons (`urlReason`). That is the only input this module reads.
//
// What it produces is a list of *suggestions* — "Jellyfin has a discovered endpoint
// https://stream.example.com; an HTTP monitor would watch it". A suggestion is inert: nothing is
// created until a person accepts it, unless auto-create is switched on in Settings → Monitoring, in
// which case at most `autoCreate.max` suggestions are created and every monitor records
// `provenance: 'discovered'` so it is obvious later where it came from.
//
// What it deliberately does NOT do:
//   · it never invents an endpoint — a service with `url: null` (no route, loopback-only, unknown
//     host address) produces no HTTP suggestion, and the reason is carried through for the UI;
//   · it never reads a proxy's labels itself: `urlSource: 'traefik'` is reported as *the source of
//     the endpoint*, and the suggestion is identical in shape for any other reverse proxy;
//   · it never creates a Docker monitor for every container in sight. A Docker suggestion exists
//     only for services that already have an HTTP suggestion — i.e. for services the operator has
//     chosen to expose — so enabling auto-create cannot turn 200 containers into 200 monitors.
import { MONITOR_TYPES } from './model.js';

/** Where an endpoint came from, in words a person reads. Never used to branch on a vendor. */
const SOURCE_LABEL = {
  manual: 'an override you configured',
  traefik: 'the container’s own proxy labels',
  'published-port': 'a published port on this host',
};

/** Endpoint sources a monitor may watch. `none` is an absence, not a source. */
export const TRUSTED_URL_SOURCES = Object.freeze(['manual', 'traefik', 'published-port']);

/** Does a monitor already watch this exact target? Compares structurally, never by string prefix. */
function alreadyMonitored(monitors, type, ref, url) {
  return monitors.some((m) => {
    if (m.type !== type) return false;
    if (type === 'http') {
      const sameService = m.target?.service && ref
        && m.target.service.name.toLowerCase() === ref.name.toLowerCase()
        && (m.target.service.group || '').toLowerCase() === (ref.group || '').toLowerCase();
      if (sameService) return true;
      return !!url && m.target?.url === url;
    }
    if (type === 'docker') {
      return m.target?.service?.name?.toLowerCase() === ref.name.toLowerCase()
        && (m.target?.service?.group || '').toLowerCase() === (ref.group || '').toLowerCase();
    }
    return false;
  });
}

/**
 * Build suggestions from the canonical inventory.
 *
 * @param {object} inv       the inventory (`getInventory()`), or null when the engine is unreachable
 * @param {object} monitors  the monitors that already exist
 * @param {object} opts      `{ limit }`
 */
export function suggestMonitors(inv, monitors = [], { limit = 40 } = {}) {
  const out = [];
  if (!inv || inv.live === false) return { suggestions: out, reason: inv?.statusReason || 'The Docker engine is not reachable, so there is nothing to discover yet.' };

  // The inventory exposes services both grouped and flat; the same container must not be suggested
  // twice, so identity is `group/name` and the first sighting wins.
  const all = [...(inv.groups || []).flatMap((g) => g.services || []), ...(inv.services || [])];
  const seen = new Set();
  for (const s of all) {
    if (!s || s.hidden) continue;
    const key = `${String(s.group || 'Ungrouped').toLowerCase()}/${String(s.name).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = s.group || 'Ungrouped';
    const ref = { group, name: s.name };
    const url = s.url || null;
    const source = TRUSTED_URL_SOURCES.includes(s.urlSource) ? s.urlSource : null;

    if (!url || !source) continue; // no usable endpoint ⇒ no suggestion at all (with a reason on the service itself)

    if (!alreadyMonitored(monitors, 'http', ref, url)) {
      out.push({
        id: `http:${group}/${s.name}`,
        type: 'http',
        name: s.displayName || s.name,
        title: `${s.displayName || s.name}`,
        reason: `Endpoint discovered from ${SOURCE_LABEL[source] || source}.`,
        target: { kind: 'http', service: ref, url },
        source: { kind: 'reverse-proxy', provider: s.urlSource === 'traefik' ? 'Traefik' : null, urlSource: s.urlSource, note: s.urlNote || null },
        provenance: 'discovered',
      });
    }
    // The container-state suggestion is offered *only* for services that expose an endpoint, which
    // is what keeps "enabled auto-create" from turning every container on the host into a monitor.
    if (!alreadyMonitored(monitors, 'docker', ref, null)) {
      out.push({
        id: `docker:${group}/${s.name}`,
        type: 'docker',
        name: `${s.displayName || s.name} container`,
        title: `${s.displayName || s.name} container`,
        reason: `Watching the container state of ${s.displayName || s.name}.`,
        target: { kind: 'docker', service: ref },
        source: null,
        provenance: 'discovered',
      });
    }
    if (out.length >= limit) break;
  }
  // one suggestion per id, whatever the inventory did
  const byId = new Map();
  for (const s of out) if (!byId.has(s.id)) byId.set(s.id, s);
  return { suggestions: [...byId.values()].slice(0, limit), reason: null, types: MONITOR_TYPES };
}
