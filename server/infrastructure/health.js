// Infrastructure health aggregation — one verdict per domain, and one for OpusGrid.
//
// The rule this file exists to enforce:
//
//     An optional provider that is not configured must never make OpusGrid unhealthy.
//
// "OPNsense: Not configured" is a fact about an install, not a problem with it. So the aggregator
// treats `not-configured` as *out of scope* rather than as a bad state, and only domains that are
// actually in play contribute to the overall verdict.
//
// Vocabulary (the whole set — nothing improvises a synonym):
//
//     healthy          everything in play is working, and nothing is alerting
//     degraded         something in play is partly working, or an alert is open
//     unavailable      something required is unreachable
//     not-configured   the domain has no provider that was ever set up (never unhealthy)
//     unknown          the domain has not been checked yet
//
// Severity order for "worst wins": healthy < degraded < unavailable; not-configured and unknown
// are excluded from the overall computation rather than ranked inside it.
import { DOMAINS, DOMAIN_LABELS } from './model.js';

export const DOMAIN_STATUS = Object.freeze(['healthy', 'degraded', 'unavailable', 'not-configured', 'unknown']);

const RANK = Object.freeze({ healthy: 0, degraded: 1, unavailable: 2 });

/** Which domain an alert belongs to, by the area the alert engine stamps on it. */
const ALERT_AREA_TO_DOMAIN = Object.freeze({
  storage: 'storage',
  network: 'network',
  power: 'power',
  provider: null,      // provider alerts are already carried by provider status
  compute: 'compute',
  docker: 'compute',
  system: null,
});

const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);

/**
 * One domain's verdict from its providers' status documents.
 *
 * @param providers  status documents (see registry.providerStatusDoc) belonging to this domain
 * @param alerts     active alerts whose area maps to this domain
 */
export function domainHealth(providers = [], alerts = []) {
  if (!providers.length) return { status: 'unknown', reasons: [] };
  const inPlay = providers.filter((p) => p.status !== 'not-configured');
  if (!inPlay.length) {
    return {
      status: 'not-configured',
      reasons: providers.map((p) => `${p.name}: ${p.error?.reason || 'not configured'}`).slice(0, 3),
    };
  }
  let status = 'healthy';
  const reasons = [];
  for (const p of inPlay) {
    if (p.status === 'unavailable') {
      status = worse(status, p.optional ? 'degraded' : 'unavailable');
      reasons.push(`${p.name}: ${p.error?.reason || 'unavailable'}`);
    } else if (p.status === 'degraded') {
      status = worse(status, 'degraded');
      reasons.push(`${p.name}: ${p.error?.reason || 'degraded'}`);
    } else if (p.status === 'unknown') {
      // never checked: not a fault, but not something to call healthy either
      status = worse(status, 'degraded');
      reasons.push(`${p.name} has not been checked yet`);
    }
  }
  for (const a of alerts) {
    if (status === 'unavailable') break;
    status = worse(status, 'degraded');
    reasons.push(a.title);
  }
  return { status, reasons: reasons.slice(0, 4) };
}

/**
 * The whole picture.
 *
 * @param providers  every provider status document
 * @param alerts     active alerts (they carry an `area`)
 */
export function aggregateHealth({ providers = [], alerts = [] } = {}) {
  const domains = {};
  const contributions = [];
  for (const d of DOMAINS) {
    const mine = providers.filter((p) => p.domain === d);
    const domainAlerts = alerts.filter((a) => ALERT_AREA_TO_DOMAIN[a.area] === d);
    const health = domainHealth(mine, domainAlerts);
    domains[d] = {
      domain: d,
      label: DOMAIN_LABELS[d],
      status: health.status,
      reasons: health.reasons,
      providers: mine.map((p) => p.id),
      alerts: domainAlerts.length,
    };
    if (health.status === 'healthy' || health.status === 'degraded' || health.status === 'unavailable') {
      contributions.push(health.status);
    }
  }
  // Only domains that are actually in play decide the overall verdict. An install with Docker and
  // nothing else is healthy; an install where Docker is unreachable is not.
  const overall = contributions.length
    ? contributions.reduce((acc, s) => worse(acc, s), 'healthy')
    : 'unknown';
  return {
    status: overall,
    domains,
    counts: {
      healthy: Object.values(domains).filter((d) => d.status === 'healthy').length,
      degraded: Object.values(domains).filter((d) => d.status === 'degraded').length,
      unavailable: Object.values(domains).filter((d) => d.status === 'unavailable').length,
      notConfigured: Object.values(domains).filter((d) => d.status === 'not-configured').length,
      unknown: Object.values(domains).filter((d) => d.status === 'unknown').length,
    },
    // Stated once, here, so every surface says the same thing about absence.
    note: 'Optional providers that are not configured are excluded from the overall verdict.',
  };
}

/** The compact strip: one line per domain the UI shows, never more. */
export function healthStrip(health) {
  return DOMAINS.map((d) => ({
    domain: d,
    label: DOMAIN_LABELS[d],
    status: health.domains[d]?.status || 'unknown',
    providers: health.domains[d]?.providers || [],
  }));
}
