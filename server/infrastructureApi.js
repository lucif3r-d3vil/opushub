// /api/infrastructure — the OpusGrid surface.
//
// Every route here is a GET. There is no write, no action, no refresh-triggering endpoint and no
// way for a request to choose what OpusHub asks a provider: the only inputs are a pool/dataset
// `name` (resolved against names the provider itself discovered) and `include` (a fixed list of
// section names). No path, URL, command, endpoint, method or credential field is read anywhere in
// this file, and a test proves that mechanically (server/phase9-security.test.js).
//
// Authentication is not handled here: api.js calls this behind the same session and CSRF gate as
// every other route, so "is the infrastructure surface authenticated?" has the same answer as
// "is OpusHub authenticated?".
import {
  opusGridDocument, storageDocument, poolDocument, datasetDocument,
  networkDocument, powerDocument, externalDocument, topologyDocument,
} from './infrastructure/opusgrid.js';
import { providersDocument, isKnownProvider } from './infrastructure/registry.js';
import { physicalTopology } from './infrastructure/physical.js';

/** The sections `/api/infrastructure?include=` accepts. Anything else is ignored, not accepted. */
const INCLUDES = new Set(['storage', 'network', 'power', 'external']);

function parseInclude(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => INCLUDES.has(s)).slice(0, 4);
}

/** A name is bounded and cannot be a flag: providers still re-check it against their own data. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 256) return null;
  if (s.startsWith('-') || s.includes('..') || /[\s'"$`;&|<>()\\]/.test(s)) return null;
  return s;
}

/**
 * Handle the infrastructure routes.
 *
 * @returns true when the path belonged to this surface (including the 404s inside it), so api.js
 *          does not fall through and report a generic "no route".
 */
export async function handleInfrastructure({ p, method, send, query }) {
  if (!p.startsWith('/api/infrastructure')) return false;
  if (method !== 'GET' && method !== 'HEAD') {
    send(405, { error: 'Infrastructure is read-only.', code: 'method_not_allowed' });
    return true;
  }

  const notFound = (what) => {
    send(404, { error: `No such ${what}.`, code: 'not_found' });
    return true;
  };

  if (p === '/api/infrastructure') {
    const include = parseInclude(query.get('include'));
    send(200, await opusGridDocument({ include }));
    return true;
  }
  if (p === '/api/infrastructure/providers') {
    send(200, await providersDocument());
    return true;
  }
  if (p === '/api/infrastructure/storage') {
    send(200, await storageDocument({ detail: true }));
    return true;
  }
  if (p === '/api/infrastructure/storage/pool') {
    const name = sanitizeName(query.get('name'));
    if (!name) return notFound('pool');
    const doc = await poolDocument(name);
    // Unknown names are refused with nothing looked up — see providers/zfs.js getPoolStatus.
    if (!doc) return notFound('pool');
    send(200, doc);
    return true;
  }
  if (p === '/api/infrastructure/storage/dataset') {
    const name = sanitizeName(query.get('name'));
    if (!name) return notFound('dataset');
    const doc = await datasetDocument(name);
    if (!doc) return notFound('dataset');
    send(200, doc);
    return true;
  }
  if (p === '/api/infrastructure/network') {
    send(200, await networkDocument());
    return true;
  }
  if (p === '/api/infrastructure/power') {
    send(200, await powerDocument());
    return true;
  }
  if (p === '/api/infrastructure/opnsense') {
    send(200, await externalDocument());
    return true;
  }
  if (p === '/api/infrastructure/topology') {
    send(200, await topologyDocument());
    return true;
  }
  if (p === '/api/infrastructure/physical') {
    send(200, physicalTopology());
    return true;
  }
  if (p === '/api/infrastructure/provider') {
    // One provider's status document. The id is validated against the registry — the registry is
    // the allow-list, so an unknown id answers 404 without a check being run.
    const id = query.get('id');
    if (!isKnownProvider(id)) return notFound('provider');
    const doc = await providersDocument();
    const found = doc.providers.find((x) => x.id === id);
    if (!found) return notFound('provider');
    send(200, { at: doc.at, provider: found });
    return true;
  }
  return notFound('infrastructure endpoint');
}
