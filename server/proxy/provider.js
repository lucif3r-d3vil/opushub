// Reverse-proxy provider abstraction — the WRITE side.
//
// The read side already exists: providers/dockerLabels.js#parseTraefik and urlResolver.js turn a
// container's labels into a URL, and monitoring reports `source.kind: 'reverse-proxy'`. This
// module is the inverse: given a canonical *exposure* — `{ domain, port, https, scheme }` — a
// provider produces the labels (and the network to join) that make the running proxy route it.
//
// The canonical service model (containers/spec.js, catalog manifests) never mentions Traefik:
// it carries `expose` and asks `activeProvider()` for labels. Traefik is one provider; a second
// one (Caddy docker-proxy, nginx-proxy) is another entry in PROVIDERS with the same shape.
//
// Provider selection is server-side: OPUSHUB_PROXY_PROVIDER (traefik | none) and
// OPUSHUB_PROXY_NETWORK. When the provider is `none`, `labelsFor()` returns nothing and the
// operator is told the exposure is not applied — never silently dropped.
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const ROUTER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Parse/validate an exposure request. Returns `{ ok, expose, reason }`. */
export function normalizeExpose(raw) {
  if (raw === null || raw === undefined || raw === false) return { ok: true, expose: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'expose must be an object' };
  const extra = Object.keys(raw).filter((k) => !['domain', 'port', 'https', 'scheme', 'entrypoint'].includes(k));
  if (extra.length) return { ok: false, reason: `expose.${extra[0]} is not a field` };
  const domain = String(raw.domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return { ok: false, reason: 'expose.domain must be a DNS host name' };
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'expose.port must be the container port' };
  const scheme = raw.scheme === 'https' ? 'https' : 'http';
  const entrypoint = raw.entrypoint === undefined ? null : String(raw.entrypoint);
  if (entrypoint !== null && !ROUTER_RE.test(entrypoint)) return { ok: false, reason: 'expose.entrypoint is not a valid name' };
  return { ok: true, expose: { domain, port, https: raw.https !== false, scheme, entrypoint } };
}

const traefik = Object.freeze({
  id: 'traefik',
  label: 'Traefik',
  /** Labels that make Traefik (docker provider) route `expose` to this container. */
  labelsFor(expose, { name, network = null } = {}) {
    const router = String(name || 'svc').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'svc';
    const labels = {
      'traefik.enable': 'true',
      [`traefik.http.routers.${router}.rule`]: `Host(\`${expose.domain}\`)`,
      [`traefik.http.routers.${router}.entrypoints`]: expose.entrypoint || (expose.https ? 'websecure' : 'web'),
      [`traefik.http.services.${router}.loadbalancer.server.port`]: String(expose.port),
    };
    if (expose.https) labels[`traefik.http.routers.${router}.tls`] = 'true';
    if (expose.scheme === 'https') labels[`traefik.http.services.${router}.loadbalancer.server.scheme`] = 'https';
    if (network) labels['traefik.docker.network'] = network;
    return labels;
  },
  /** The URL the exposure will answer on — used to seed monitoring and the service link. */
  urlFor(expose) { return `${expose.https ? 'https' : 'http'}://${expose.domain}/`; },
});

const none = Object.freeze({
  id: 'none', label: 'No reverse proxy',
  labelsFor() { return {}; },
  urlFor() { return null; },
});

const PROVIDERS = Object.freeze({ traefik, none });

export function activeProvider(env = process.env) {
  const id = String(env.OPUSHUB_PROXY_PROVIDER || 'traefik').toLowerCase();
  const provider = PROVIDERS[id] || none;
  const network = String(env.OPUSHUB_PROXY_NETWORK || 'proxy').trim();
  return {
    id: provider.id, label: provider.label, available: provider.id !== 'none',
    network: provider.id !== 'none' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network) ? network : null,
    labelsFor: (expose, opts = {}) => provider.labelsFor(expose, { ...opts, network: opts.network === undefined ? (provider.id !== 'none' ? network : null) : opts.network }),
    urlFor: (expose) => provider.urlFor(expose),
  };
}

export const _internals = Object.freeze({ PROVIDERS, DOMAIN_RE });
