// Registry endpoints — what OpusHub is willing to talk to, and how it gets there.
//
// A registry is an *origin* (scheme + host + optional port), never a URL with a path. Every
// request the client makes is `<origin>/v2/<fixed grammar>`; the path is composed here from
// validated components, never taken from a caller. Rules:
//
//   · https only. http is allowed only when the entry says `insecure: true` AND every address the
//     host resolves to is private (RFC1918 / CGNAT / ULA) — a LAN registry, not the internet.
//   · the host is resolved by us, every address classified with lib/ipPolicy (loopback,
//     link-local/metadata, multicast, unspecified, documentation are refused outright), and the
//     connection is pinned to the validated address (monitoring/net.js) — no DNS rebinding.
//   · no credentials in the URL, no fragments, no query strings from callers.
//   · well-known aliases: docker.io / index.docker.io → registry-1.docker.io.
import net from 'node:net';
import { resolveHost, scopeOf } from '../monitoring/net.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export const REPOSITORY_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
export const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const KINDS = Object.freeze(['dockerhub', 'ghcr', 'oci', 'custom']);

const ALIASES = Object.freeze({ 'docker.io': 'registry-1.docker.io', 'index.docker.io': 'registry-1.docker.io', 'registry.hub.docker.com': 'registry-1.docker.io' });

/**
 * Parse a user-supplied endpoint string into `{ scheme, host, port, origin }` or a refusal.
 * Accepts `ghcr.io`, `registry.example.com:5000`, `https://registry.example.com`. Refuses paths,
 * query strings, credentials, IP literals of refused classes and anything not http(s).
 */
export function parseEndpoint(raw, { insecure = false } = {}) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return { ok: false, code: 'invalid_endpoint', reason: 'An endpoint is required.' };
  if (s.length > 260) return { ok: false, code: 'invalid_endpoint', reason: 'The endpoint is too long.' };
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return { ok: false, code: 'invalid_endpoint', reason: 'That is not a registry endpoint.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, code: 'scheme', reason: `${u.protocol}// is not a registry scheme.` };
  if (u.username || u.password) return { ok: false, code: 'credentials_in_url', reason: 'Credentials do not belong in the endpoint; use the username and secret fields.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { ok: false, code: 'path', reason: 'A registry endpoint is a host (and port), not a URL path.' };
  const host = ALIASES[u.hostname] || u.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host) && !HOST_RE.test(host)) return { ok: false, code: 'invalid_host', reason: 'The host name is not valid.' };
  if (u.protocol === 'http:' && !insecure) return { ok: false, code: 'insecure', reason: 'http:// registries are refused unless the registry is marked insecure (LAN only).' };
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: 'invalid_port', reason: 'The port is not valid.' };
  const origin = `${u.protocol}//${net.isIPv6(host) ? `[${host}]` : host}${u.port ? `:${u.port}` : ''}`;
  return { ok: true, scheme: u.protocol.replace(':', ''), host, port, origin };
}

/**
 * Resolve and classify the endpoint's host. For http (insecure) endpoints every address must be
 * internal. Returns the pinned address the client must connect to.
 */
export async function validateEndpoint(endpoint, { insecure = false, lookup = undefined } = {}) {
  const parsed = typeof endpoint === 'string' ? parseEndpoint(endpoint, { insecure }) : endpoint;
  if (!parsed.ok) return parsed;
  const resolved = await resolveHost(parsed.host, lookup ? { lookup } : {});
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason };
  const scope = scopeOf(resolved.addresses);
  if (parsed.scheme === 'http' && scope !== 'internal') return { ok: false, code: 'insecure_public', reason: 'An http:// registry is only allowed on the local network; this host resolves to a public address.' };
  return { ok: true, ...parsed, pinned: resolved.pinned, family: resolved.addresses[0].family, scope };
}

/** The registry host an image reference points at (docker.io for bare names). */
export function registryHostOf(imageRef) {
  const ref = String(imageRef || '').trim();
  const first = ref.split('/')[0];
  const hasHost = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return hasHost ? (ALIASES[first.toLowerCase()] || first.toLowerCase()) : 'registry-1.docker.io';
}

/** The repository part of an image reference, normalised the way the registry expects it. */
export function repositoryOf(imageRef) {
  let ref = String(imageRef || '').trim();
  const at = ref.indexOf('@');
  if (at >= 0) ref = ref.slice(0, at);
  const host = registryHostOf(imageRef);
  const first = ref.split('/')[0];
  const hasHost = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  let repo = hasHost ? ref.slice(first.length + 1) : ref;
  const lastSlash = repo.lastIndexOf('/');
  const colon = repo.lastIndexOf(':');
  if (colon > lastSlash) repo = repo.slice(0, colon);
  if (host === 'registry-1.docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  return repo;
}

export const _internals = Object.freeze({ HOST_RE, ALIASES });
