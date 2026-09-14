// Docker label intelligence — pure, side-effect-free parsing of the metadata that already
// exists on containers. Nothing here knows what applications exist, what domains the grid
// uses, or which ports any particular app listens on: it only reads the labels the engine
// reports and turns them into structured data.
//
// Three label families are understood:
//   com.docker.compose.*   → project / service / config-file identity  (stack discovery)
//   traefik.{http,tcp}.*   → router rules, entrypoints, TLS, backend port  (URL discovery)
//   opushub.* (+ homepage.*) → presentation metadata written next to the container itself
//
// Anything unknown is preserved (for the container detail view) but never interpreted, and
// never handed to the browser verbatim — see `curatedLabels()` for the allow-list that does
// cross the API boundary.

// ---------------------------------------------------------------------------
// Compose identity
// ---------------------------------------------------------------------------

/** Compose metadata as the engine reports it. `configFile`/`workingDir` are host paths: they
// stay server-side (never projected to the browser) but are useful for stack *naming* when a
// project label is missing entirely. */
export function parseCompose(labels) {
  const l = labels || {};
  const prefix = 'com.docker.compose.';
  const has = Object.keys(l).some((k) => k.startsWith(prefix));
  if (!has) return null;
  const project = str(l[`${prefix}project`]);
  const configFile = str(l[`${prefix}project.config_files`] || l[`${prefix}config_files`]);
  const workingDir = str(l[`${prefix}project.working_dir`] || l[`${prefix}working_dir`]);
  return {
    project,
    service: str(l[`${prefix}service`]),
    version: str(l[`${prefix}version`]),
    oneOff: /^(true|1)$/i.test(String(l[`${prefix}oneoff`] ?? l[`${prefix}one_off`] ?? '')),
    configFile,
    workingDir,
    // `myapp-nginx-1` style defaults: only used to *guess* a service name when the
    // project/service labels are absent (plain `docker run`), never to invent a stack.
    containerNumber: str(l[`${prefix}container-number`]),
  };
}

/** A project name from the compose *file path* when the label set is missing (e.g. containers
// started by an older compose v1, or by hand). Directory name, sanitized. Returns null when the
// path carries no signal at all — no project is better than a wrong project. */
export function projectFromPaths(compose) {
  const dir = compose?.workingDir || (compose?.configFile ? parentDir(compose.configFile) : null);
  if (!dir) return null;
  const base = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
  const clean = base.replace(/[^A-Za-z0-9_.-]/g, '').toLowerCase();
  return clean && clean.length > 1 && !/^(stacks|compose|docker|opt|srv|home|root|var|app)$/.test(clean) ? clean : null;
}

const parentDir = (p) => String(p).replace(/[/\\][^/\\]*$/, '');

// ---------------------------------------------------------------------------
// Traefik (v2 + v3 label shapes)
// ---------------------------------------------------------------------------

const TRAEFIK_LABEL = /^traefik\.(http|tcp|udp)\.(routers|services)\.([^.]*)\.(.+)$/;
const RULE_TOKEN = (name) => new RegExp(`${name}\\s*\\(([^)]*)\\)`, 'gi');

const splitArgs = (raw) => String(raw || '')
  .split(',')
  .map((a) => a.trim().replace(/^["'`]|["'`]$/g, '').trim())
  .filter(Boolean);

/** Every `Host(...)` / `HostAndPath(...)` argument in a rule, de-duplicated, in order.
 * Supports the shapes Traefik actually emits:
 *   Host(`app.example`)
 *   Host(`a.example`, `b.example`)
 *   Host(`app.example:8443`)
 *   Host(`a.example`) || Host(`b.example`)
 *   Host(`a.example`) && PathPrefix(`/x`)
 *   HostAndPath(`a.example/x`)
 * HostRegexp/HostSNI patterns are reported as patterns, never turned into a URL — inventing a
 * hostname from a regex would be exactly the kind of guess this layer exists to avoid. */
export function ruleHosts(rule) {
  const out = [];
  const patterns = [];
  for (const m of String(rule || '').matchAll(RULE_TOKEN('HostAndPath'))) {
    for (const arg of splitArgs(m[1])) {
      const host = arg.split('/')[0];
      if (host && !/[*?{}\[\]]/.test(host) && !out.includes(host)) out.push(host);
    }
  }
  for (const m of String(rule || '').matchAll(RULE_TOKEN('Host'))) {
    for (const arg of splitArgs(m[1])) {
      // `*`, `*.example.com` and `{any:[a-z]+}.example.com` are matchers, not addresses: using
      // one would put a hostname nobody owns into the UI, which is the failure mode this avoids.
      if (!arg || /[*?{}\[\]]/.test(arg)) { if (arg) patterns.push(arg); continue; }
      if (!/^[a-z0-9._:@\[\]-]+$/i.test(arg)) { patterns.push(arg); continue; }
      if (!out.includes(arg)) out.push(arg);
    }
  }
  for (const m of String(rule || '').matchAll(RULE_TOKEN('HostRegexp'))) {
    for (const arg of splitArgs(m[1])) if (arg) patterns.push(arg);
  }
  return { hosts: out, patterns };
}

/** Path constraints on a rule. Returned only when the rule ANDs them in (`&&`), because
 * `Host(`a`) || (Host(`b`) && Path(`/x`))` does not mean the whole router lives under /x. */
export function rulePath(rule) {
  const src = String(rule || '');
  if (/\|\|/.test(src)) return null; // alternation: no single unambiguous path
  const paths = [];
  for (const m of src.matchAll(RULE_TOKEN('PathPrefix'))) for (const a of splitArgs(m[1])) paths.push(a);
  if (!paths.length) for (const m of src.matchAll(RULE_TOKEN('Path'))) for (const a of splitArgs(m[1])) paths.push(a);
  for (const m of src.matchAll(RULE_TOKEN('HostAndPath'))) {
    for (const a of splitArgs(m[1])) {
      const rest = a.slice(a.indexOf('/') + 1);
      if (rest) paths.push('/' + rest);
    }
  }
  const uniq = [...new Set(paths.filter((p) => p.startsWith('/')))];
  return uniq.length === 1 ? uniq[0] : null;
}

/** True when the router's middlewares strip the prefix it routes on — in that case the browser
 * URL must NOT carry the path, the proxy adds it back. Conservative: only looks for a
 * middleware whose name says strip-prefix / stripprefix. */
function stripsPrefix(labels, router) {
  const mid = String(labels?.[`traefik.http.routers.${router}.middlewares`] || '');
  return /strip[-_]?prefix/i.test(mid);
}

/**
 * All Traefik routing metadata on a container, normalized:
 *   { enabled, network, routers: [{ name, protocol, rule, hosts, hostPatterns, path,
 *     entrypoints, tls, certResolver, service, middlewares, port }], services: [{name, port}] }
 * `enabled` is false unless the container carries at least one router — `traefik.enable=true`
 * alone routes nothing.
 */
export function parseTraefik(labels) {
  const l = labels || {};
  const out = { enabled: null, network: null, routers: [], services: [] };
  const enable = l['traefik.enable'];
  if (enable != null) out.enabled = /^(true|1)$/i.test(String(enable));
  out.network = str(l['traefik.docker.network']);

  const routers = new Map();
  const services = new Map();
  for (const [key, value] of Object.entries(l)) {
    const m = TRAEFIK_LABEL.exec(key);
    if (!m) continue;
    const [, proto, kind, name, prop] = m;
    if (kind === 'routers') {
      if (!routers.has(name)) routers.set(name, {
        name, protocol: proto, rule: '', hosts: [], hostPatterns: [], path: null,
        entrypoints: [], tls: false, certResolver: null, service: null, middlewares: [], port: null,
      });
      const r = routers.get(name);
      if (prop === 'rule') r.rule = String(value || '');
      else if (prop === 'entrypoints') r.entrypoints = String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
      else if (prop === 'service') r.service = str(value);
      else if (prop === 'middlewares') r.middlewares = String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
      else if (prop === 'tls') r.tls = !/^(false|0)$/i.test(String(value ?? '')); // `tls=` (bare) means enabled
      else if (prop === 'tls.certresolver' || prop === 'tls.CertResolver') { r.certResolver = str(value); r.tls = true; }
      else if (prop === 'priority') r.priority = Number(value) || null;
      continue;
    }
    // services
    if (!services.has(name)) services.set(name, { name, protocol: proto, port: null });
    const s = services.get(name);
    if (prop === 'loadbalancer.server.port') s.port = Number(value) || null;
  }
  for (const r of routers.values()) {
    if (r.protocol !== 'http') { // tcp/udp routers carry no browser URL (HostSNI only)
      const { hosts } = ruleHosts(r.rule);
      r.hosts = hosts;
      continue;
    }
    const { hosts, patterns } = ruleHosts(r.rule);
    r.hosts = hosts;
    r.hostPatterns = patterns;
    r.path = stripsPrefix(l, r.name) ? null : rulePath(r.rule);
    const svc = r.service ? services.get(r.service) : null;
    r.servicePort = svc?.port ?? services.get(r.name)?.port ?? null;
  }
  out.services = [...services.values()];
  out.routers = [...routers.values()];
  out.count = out.routers.filter((r) => r.protocol === 'http' && r.hosts.length).length;
  if (out.enabled === false) out.count = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Presentation labels (OpusHub's own, plus a tiny set of dashboard-compatible keys)
// ---------------------------------------------------------------------------

const OVERLAY_MAP = {
  'opushub.displayname': 'displayName',
  'opushub.name': 'displayName',
  'opushub.icon': 'icon',
  'opushub.group': 'group',
  'opushub.description': 'description',
  'opushub.desc': 'description',
  'opushub.url': 'url',
  'opushub.href': 'url',
  'opushub.app': 'app',
  'opushub.order': 'order',
  'opushub.hidden': 'hidden',
  'opushub.stack': 'stack',
  'opushub.kind': 'kind',
  // migration-friendly: Homepage-style labels are presentation metadata too
  'homepage.name': 'displayName',
  'homepage.icon': 'icon',
  'homepage.description': 'description',
  'homepage.href': 'url',
};

/** Presentation metadata written on the container itself. Lower priority than config/services.yaml
 * (OpusHub has the last word on looks), higher than inference. */
export function parseOverlayLabels(labels) {
  const l = labels || {};
  const out = { meta: [], keywords: [], source: null };
  for (const [key, value] of Object.entries(l)) {
    const k = key.toLowerCase();
    const field = OVERLAY_MAP[k];
    if (field) {
      const v = str(value, 300);
      if (!v) continue;
      if (field === 'hidden') out.hidden = /^(true|1|yes)$/i.test(v);
      else if (field === 'order') out.order = Number(v) || null;
      else if (!out[field]) { out[field] = v; out.source = `label:${k}`; }
      continue;
    }
    if (k.startsWith('opushub.meta.')) {
      const label = key.slice('opushub.meta.'.length);
      const v = str(value, 120);
      if (label && v) out.meta.push({ label: humanize(label), value: v });
      continue;
    }
    if (k === 'opushub.keywords') {
      out.keywords = String(value || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 24);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

/** The ONLY label data allowed to cross the API boundary: derived, allow-listed values.
 * Raw labels can hold anything (people do put tokens in labels), so they stay server-side. */
export function curatedLabels({ compose, traefik, overlay }) {
  return {
    compose: compose ? { project: compose.project, service: compose.service, version: compose.version } : null,
    proxy: traefik && traefik.count
      ? traefik.routers
        .filter((r) => r.protocol === 'http' && (r.hosts.length || r.hostPatterns?.length))
        .map((r) => ({
          router: r.name, hosts: r.hosts, entrypoints: r.entrypoints, tls: !!r.tls, path: r.path, service: r.service, servicePort: r.servicePort,
        }))
      : null,
    overlay: overlay && (overlay.displayName || overlay.icon || overlay.group || overlay.url || overlay.description || overlay.kind)
      ? {
        displayName: overlay.displayName || null, icon: overlay.icon || null, group: overlay.group || null,
        url: overlay.url || null, description: overlay.description || null, kind: overlay.kind || null,
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Small shared utilities (used by discovery + naming)
// ---------------------------------------------------------------------------

export function str(v, max = 300) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

const NOISE_WORDS = new Set(['docker', 'container', 'containers', 'app', 'apps', 'service', 'services', 'official', 'alpine', 'slim', 'latest', 'stable', 'edge', 'amd64', 'arm64']);
// Words that are noise in an image reference ("…-app:latest" → drop `app`) but part of the identity
// in a compose service name (`weird-service-name` is not "Weird Name"). The difference matters:
// dropping an identity word can make two different services produce the same display name.
const IDENTITY_WORDS = new Set(['app', 'apps', 'service', 'services']);

/** `jellyfin` → `Jellyfin`, `home-assistant` → `Home Assistant`, `ghcr.io/immich-app/immich-server`
 * → `Immich Server`. Algorithmic: no application-name table anywhere.
 *
 * `keepExtension` exists for *project* names: dropping a trailing dotted segment is right for an
 * image reference (`immich.git`) but wrong for a compose project (`team.api` would collapse to
 * `team`, which could collide with another project). */
export function humanize(raw, { keepExtension = false, keepIdentityWords = false } = {}) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const words = (keepExtension ? s : s.replace(/\.[A-Za-z0-9]{1,5}$/, ''))
    .replace(/[_\-./:]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')        // camelCase → camel Case
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !(NOISE_WORDS.has(w.toLowerCase()) && !(keepIdentityWords && IDENTITY_WORDS.has(w.toLowerCase()))));
  if (!words.length) return s;
  return words
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .slice(0, 80);
}

/** Slug used in URLs and as a canonical key: lowercase, dash-separated, safe. */
export function slugify(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 80) || 'x';
}
