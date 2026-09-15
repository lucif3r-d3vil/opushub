// URL resolution — "how do I reach this container from a browser?".
//
// Docker does not know the browser URL, so this is a pipeline with an explicit precedence and an
// explicit *source* on every answer. Nothing is guessed from the application's name, and no
// domain, TLD or port is baked in:
//
//   1. manual         explicit OpusHub override (services.yaml `url`, or an `opushub.url` label)
//   2. traefik        reverse-proxy metadata read off the container's own labels
//   3. published-port a real `0.0.0.0:PORT->…` binding + the host address OpusHub can actually name
//   4. none           no url (null) — never a fabricated endpoint
//
// The host address used by tier 3 is resolved once, from real signals (explicit setting → a
// published bind address → the machine's routable outbound address). If none can be established,
// tier 3 refuses to invent a URL and reports `none` with a note explaining what to set.
//
// Every answer carries a machine-readable `urlReason` next to the human `urlNote`. The note is for
// a person looking at one service; the code is for counting — the first-run wizard says *how many*
// services have no URL and *why*, in categories, without naming a single container before there is
// an account. Codes are stable: `URL_REASONS` below is the whole vocabulary.
import { str } from './providers/dockerLabels.js';

const WEB_PORTS = new Set([80, 443, 3000, 4443, 5000, 5001, 8000, 8080, 8081, 8090, 8443, 9000, 9090, 9443]);
const TLS_PORTS = new Set([443, 4443, 8443, 9443]);
// Ports that are almost never an HTTP UI. Used only to *rank* published-port candidates —
// never to drop a container (a user may well serve something real on 3306).
const NON_WEB_PORTS = new Set([22, 25, 53, 110, 111, 135, 137, 139, 143, 161, 389, 445, 465, 514, 587, 636, 993, 995, 873, 1080, 1433, 1521, 1883, 2049, 3128, 3306, 3389, 5060, 5222, 5432, 5672, 5900, 6379, 8883, 9001, 11211, 25565, 27017]);

/**
 * The complete vocabulary of `urlReason` codes, with the one-line explanation the UI shows.
 *   manual              the operator said so (services.yaml `url:`, or an `opushub.url` label)
 *   traefik             built from the container's own proxy labels
 *   published-port      built from a real published binding + a host address we can name
 *   no-route            nothing routes to it and nothing is published — an honest absence
 *   host-address-unknown  it publishes a port, but the host has no name OpusHub can trust
 *   loopback-only       published, but only on 127.0.0.1 — unreachable from another machine
 *   override-invalid    a manual override exists but is not a usable http(s) URL (so it is refused)
 *   proxy-disabled      `traefik.enable=false` (or an enable=false router) suppresses label URLs
 *   proxy-incomplete    a router exists, but no hostname can be built from it (regexp/SNI-only…)
 */
export const URL_REASONS = {
  manual: 'an explicit override in services.yaml or on the container',
  traefik: 'built from the container’s own Traefik labels',
  'published-port': 'built from a published port and this host’s address',
  'no-route': 'no proxy route and no published port',
  'host-address-unknown': 'a port is published, but OpusHub cannot name this host',
  'loopback-only': 'published only on loopback — unreachable from another machine',
  'override-invalid': 'the configured override is not a usable http(s) URL',
  'proxy-disabled': 'proxy routing is explicitly disabled for this container',
  'proxy-incomplete': 'a proxy router exists, but it names no host to visit',
};

const isLoopback = (ip) => !ip || ip.startsWith('127.') || ip === '::1' || ip.startsWith('fe80:');
const isWildcard = (ip) => !ip || ip === '0.0.0.0' || ip === '::';
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|br[0-9]|cni|flannel|kube|lo$)/i;

// ---------------------------------------------------------------------------
// Traefik tier
// ---------------------------------------------------------------------------

/** Rank this container's HTTP routers and pick the one a human would call "the URL".
 * Deterministic: TLS wins over a plain redirector, a root rule wins over a path-scoped one,
 * a router named after the service wins over an arbitrary one. */
export function pickRouter(traefik, containerNames = []) {
  if (!traefik || traefik.enabled === false) return null; // `traefik.enable=false` disables everything
  const routers = (traefik?.routers || []).filter((r) => r.protocol === 'http' && (r.hosts || []).length);
  if (!routers.length) return null;
  const names = containerNames.map((n) => String(n).toLowerCase());
  const scored = routers.map((r) => {
    let s = 0;
    if (r.tls) s += 4;
    if ((r.middlewares || []).some((m) => /redirect/i.test(m))) s -= 6;
    if (!r.path || r.path === '/') s += 2;
    if ((r.entrypoints || []).some((e) => /internal|private|insecure/i.test(e))) s -= 4;
    if (names.includes(String(r.name).toLowerCase())) s += 2;
    if ((r.service || '').toLowerCase() && names.includes(String(r.service).toLowerCase())) s += 1;
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s || a.r.rule.length - b.r.rule.length || a.r.name.localeCompare(b.r.name));
  return scored[0].r;
}

/** `Host(`app.example`)` on entrypoint `websecure` → `https://app.example`.
 * `entrypointPorts` (optional, operator-owned) maps an entrypoint name to the port Traefik is
 * actually reachable on — `8443`, or `10.0.0.5:8443` to override the host as well. Without it we
 * emit no port at all, because the label says which *router* answers, not which host port is open. */
export function urlFromRouter(router, { entrypointPorts = null, preferTls = null } = {}) {
  if (!router?.hosts?.length) return null;
  const raw = String(router.hosts[0]).trim().toLowerCase().replace(/\.$/, '');
  if (!raw || /[\s*]/.test(raw)) return null;
  let host = raw;
  let port = null;
  const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (m) { host = m[1]; port = m[2] || null; }
  const tls = preferTls ?? !!router.tls;
  if (!port && entrypointPorts && router.entrypoints?.length) {
    for (const ep of router.entrypoints) {
      const mapped = entrypointPorts[ep];
      if (mapped == null || mapped === '') continue;
      const s = String(mapped).trim();
      if (/^\d{1,5}$/.test(s)) port = s;
      else if (/^[^:/]+:\d{1,5}$/.test(s)) { host = s.split(':')[0]; port = s.split(':')[1]; }
      break;
    }
  }
  const path = router.path && router.path !== '/' ? router.path.replace(/\/+$/, '') : '';
  const hostPort = port && !(port === '80' && !tls) && !(port === '443' && tls) ? `${host}:${port}` : host;
  const authority = hostPort.includes(':') && !hostPort.startsWith('[') ? bracket(hostPort) : hostPort;
  return { url: `${tls ? 'https' : 'http'}://${authority}${path}`, host: authority, scheme: tls ? 'https' : 'http', path: path || null };
}

const bracket = (hostPort) => {
  const [h, p] = hostPort.split(':');
  return h.includes(':') ? `[${h}]${p ? `:${p}` : ''}` : hostPort;
};

// ---------------------------------------------------------------------------
// Published-port tier
// ---------------------------------------------------------------------------

/** Normalize the two port shapes the engine produces into one comparable form.
 *  list:   { ip, private: 8096, public: 8096, type: 'tcp' }
 *  inspect:{ private: '8096/tcp', host: '0.0.0.0', hostPort: '8096' } */
export function normalizePorts(ports) {
  return (ports || []).map((p) => {
    if (p == null) return null;
    if (typeof p.private === 'number' || (typeof p.private === 'string' && /^\d+$/.test(p.private))) {
      const pub = p.public == null || p.public === '' ? null : Number(p.public);
      return { ip: str(p.ip) || '0.0.0.0', private: Number(p.private), public: Number.isFinite(pub) ? pub : null, type: (p.type || 'tcp').toLowerCase() };
    }
    const priv = String(p.private ?? '');
    const privNum = Number(priv.split('/')[0]);
    const pubNum = p.hostPort == null || p.hostPort === '' ? null : Number(p.hostPort);
    if (!Number.isFinite(privNum)) return null;
    return { ip: str(p.host) || '0.0.0.0', private: privNum, public: Number.isFinite(pubNum) ? pubNum : null, type: priv.split('/')[1] || 'tcp' };
  }).filter(Boolean);
}

/** Best published host port for a browser, or null. Loopback-only binds are deliberately not
 * turned into URLs (a browser on another machine cannot reach them) and ranges are skipped. */
export function pickPublishedPort(ports) {
  const usable = normalizePorts(ports).filter((p) => p.public != null && p.type === 'tcp');
  if (!usable.length) return null;
  const web = usable.filter((p) => !isLoopback(p.ip));
  const pool = (web.length ? web : usable).map((p) => ({
    p,
    s: (WEB_PORTS.has(p.public) ? 2 : 0)
      + (p.private === p.public ? 1 : 0)
      - (NON_WEB_PORTS.has(p.public) || NON_WEB_PORTS.has(p.private) ? 3 : 0)
      - (isLoopback(p.ip) ? 4 : 0),
  }));
  pool.sort((a, b) => b.s - a.s || a.p.public - b.p.public);
  const loopbackOnly = !web.length;
  return { ...pool[0].p, loopbackOnly, others: usable.length - 1 };
}

// ---------------------------------------------------------------------------
// Host address (what goes in front of a published port)
// ---------------------------------------------------------------------------

/** Accepts `192.168.1.50`, `home.example`, `http://home.example/`, `[::2]:80`; returns an
 * authority string (host[:port]) or null. No default is supplied — that is the whole point.
 * Anything with a non-http(s) scheme or characters outside the host grammar is refused: manual
 * overrides also arrive from container labels, which never passed through config validation. */
export function normalizeHostAddress(raw) {
  const s = str(raw, 200);
  if (!s) return null;
  let v = s.trim();
  const scheme = v.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  v = v.replace(/[/?#].*$/, '');                   // strip path/query
  if (!v) return null;
  if (!/^(\[[0-9a-f:.]+]|[a-z0-9._-]+)(:\d{1,5})?$/i.test(v)) return null;
  return v.toLowerCase();
}

/** Address families we will happily publish as a clickable host. Anything else (link-local,
 * loopback, an interface that is obviously a bridge) is not an answer, it is a bug waiting. */
export function routableAddress(ip) {
  if (!ip) return false;
  const s = String(ip).trim().toLowerCase();
  if (!s || s === '::1' || s.startsWith('127.') || s.startsWith('169.254.') || s.startsWith('fe80') || s.startsWith('::')) return false;
  return true;
}

/** Most frequently published non-wildcard host IP, if any (e.g. `-p 192.168.1.50:5055:5055`).
 * This is the strongest signal there is: whoever started the container named that address. */
export function addressFromBindings(allPorts) {
  const tally = new Map();
  for (const p of allPorts) {
    if (p.public == null || isLoopback(p.ip) || isWildcard(p.ip)) continue;
    tally.set(p.ip, (tally.get(p.ip) || 0) + 1);
  }
  let best = null;
  for (const [ip, n] of tally) if (!best || n > best.n) best = { ip, n };
  return best?.ip || null;
}

/** Pick the address to put in front of published ports. Pure — inputs come from hostAddress.js. */
export function pickHostAddress({ configured, bindAddress, detected, interfaces = [] } = {}) {
  const explicit = normalizeHostAddress(configured);
  if (explicit) return { address: explicit, source: 'configured' };
  if (bindAddress && routableAddress(bindAddress)) return { address: bindAddress, source: 'published-bind' };
  if (detected && routableAddress(detected)) {
    const iface = Object.entries(interfaces || {}).find(([, addrs]) => (addrs || []).some((a) => a.address === detected))?.[0];
    if (!iface || !VIRTUAL_IFACE.test(iface)) return { address: detected, source: 'outbound-interface' };
  }
  return { address: null, source: 'unavailable' };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Resolve one container's browser URL.
 * @param container { name, ports, traefik, overlayUrl, overlayUrlSource, manualUrl }
 * @param ctx { hostAddress, hostAddressSource, entrypointPorts }
 * @returns {{ url: string|null, urlSource: 'manual'|'traefik'|'published-port'|'none', urlNote: string|null }}
 */
export function resolveUrl(container, ctx = {}) {
  const manual = normalizeHostUrl(container.manualUrl ?? container.overlay?.url ?? null);
  if (manual) return { url: manual, urlSource: 'manual', urlReason: 'manual', urlNote: container.overlay?.url ? `explicit override (${container.overlay.urlSource || 'config'})` : 'explicit override' };
  if (container.manualUrl) {
    // an override that was refused (bad scheme/host) must not silently resolve from something else
    return { url: null, urlSource: 'none', urlReason: 'override-invalid', urlNote: `manual override “${String(container.manualUrl).slice(0, 60)}” is not a usable http(s) URL` };
  }

  const router = pickRouter(container.traefik, [container.name, container.composeService, container.composeProject]);
  if (router) {
    const built = urlFromRouter(router, { entrypointPorts: ctx.entrypointPorts });
    if (built) {
      const hosts = router.hosts || [];
      const via = `Traefik router “${router.name}” · ${router.entrypoints?.length ? `entrypoint ${router.entrypoints.join('/')}` : 'no entrypoint label'} · ${router.tls ? 'TLS' : 'plain'}`;
      return {
        url: built.url, urlSource: 'traefik', urlReason: 'traefik',
        urlNote: hosts.length > 1 ? `${via} · ${hosts.length - 1} alternate host${hosts.length - 1 === 1 ? '' : 's'}` : via,
        urlHosts: hosts.length > 1 ? hosts : undefined,
      };
    }
    // a router was found but produced no address: say which of the two reasons it is
    const disabled = container.traefik?.enabled === false;
    return {
      url: null, urlSource: 'none',
      urlReason: disabled ? 'proxy-disabled' : 'proxy-incomplete',
      urlNote: disabled
        ? 'Traefik routing is disabled for this container (traefik.enable=false)'
        : 'a Traefik router matches this container, but its rule names no hostname to visit',
    };
  }

  const pick = pickPublishedPort(container.ports);
  if (pick?.loopbackOnly) {
    return { url: null, urlSource: 'none', urlReason: 'loopback-only', urlNote: `only ${pick.public} on loopback is published — not reachable from another machine` };
  }
  if (pick && ctx.hostAddress) {
    const scheme = TLS_PORTS.has(pick.public) || TLS_PORTS.has(pick.private) ? 'https' : 'http';
    const host = ctx.hostAddress.includes(':') && !ctx.hostAddress.startsWith('[') ? bracket(ctx.hostAddress) : ctx.hostAddress;
    // 80/443 are the scheme defaults — spelling them out only adds noise to the URL
    const explicit = pick.public === 80 ? scheme !== 'http' : pick.public !== 443;
    const note = `published ${isWildcard(pick.ip) ? 'all interfaces' : pick.ip}:${pick.public} → ${pick.private}${pick.others > 0 ? ` (+${pick.others} more)` : ''}`;
    return { url: `${scheme}://${host}${explicit ? `:${pick.public}` : ''}`, urlSource: 'published-port', urlReason: 'published-port', urlNote: note };
  }
  if (pick && !ctx.hostAddress) {
    return { url: null, urlSource: 'none', urlReason: 'host-address-unknown', urlNote: `published port ${pick.public} found, but OpusHub cannot name this host — set a host address in Settings → Environment (or OPUSHUB_HOST_ADDRESS)` };
  }
  return {
    url: null, urlSource: 'none', urlReason: 'no-route',
    urlNote: container.traefik?.count === 0 && !container.ports?.length ? 'no proxy route, no published port' : null,
  };
}

/** Manual overrides accept a full URL (preferred) or a bare host / host:port. */
export function normalizeHostUrl(raw) {
  const s = str(raw, 500);
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString().replace(/\/$/, '');
    } catch { return null; }
  }
  const host = normalizeHostAddress(s);
  return host ? `http://${host}` : null;
}
