// Unified service health — one verdict per service from every evidence source available.
//
// States (the whole vocabulary):
//   healthy      strong positive evidence: a passing healthcheck, or a serving HTTP endpoint
//   available    the container runs but nothing proves the application itself answers
//                (no healthcheck, no URL/probe) — \"there\", not \"well\"
//   degraded     running, but something is wrong (paused, restarting loop, HTTP errors)
//   unhealthy    explicit negative evidence: a failing healthcheck
//   unreachable  a URL exists but cannot be reached while the container runs
//   stopped      exited / dead / not running
//   starting     created / restarting — transitional, not yet judged
//   unknown      the engine gave no readable state at all
//
// The cardinal rule: a running container is NEVER \"healthy\" on its own. \"Healthy\" requires
// application-level evidence — a passing healthcheck or a successful HTTP probe.
import { probeUrl } from './probe.js';

/** Pure aggregation: evidence in, verdict out. No I/O — the probe result is passed in. */
export function aggregateHealth({
  state = null, // docker container state: running|exited|created|restarting|paused|dead|removing
  healthcheck = null, // docker health: healthy|unhealthy|starting|null (null = no healthcheck)
  url = null,
  urlSource = 'none',
  probe = null, // probeUrl() verdict, or null when nothing was attempted
  stack = null,
  startedAt = null,
} = {}) {
  const evidence = {
    container: state || 'unknown',
    healthcheck: healthcheck || 'none',
    http: probe?.checked
      ? (probe.reachable ? String(probe.statusCode ?? 'reachable') : (probe.errorType || 'unreachable'))
      : (url ? 'not-checked' : 'no-url'),
  };

  // No state at all: nothing to judge.
  if (!state) {
    return { state: 'unknown', evidence, stack, startedAt, url, urlSource, detail: 'No container state was reported.' };
  }
  // Explicit negative evidence outranks everything while running.
  if (state === 'running' && healthcheck === 'unhealthy') {
    return { state: 'unhealthy', evidence, stack, startedAt, url, urlSource, detail: 'The container healthcheck is failing.' };
  }
  // Transitional states: not judged, just named.
  if (state === 'created' || state === 'restarting' || state === 'removing') {
    return { state: 'starting', evidence, stack, startedAt, url, urlSource, detail: `Container is ${state}.` };
  }
  if (state === 'paused') {
    return { state: 'degraded', evidence, stack, startedAt, url, urlSource, detail: 'Container is paused.' };
  }
  if (state !== 'running') {
    return { state: 'stopped', evidence, stack, startedAt, url, urlSource, detail: `Container is ${state}.` };
  }
  // Running from here on.
  if (healthcheck === 'healthy') {
    return { state: 'healthy', evidence, stack, startedAt, url, urlSource, detail: 'Healthcheck passing.' };
  }
  if (healthcheck === 'starting') {
    return { state: 'starting', evidence, stack, startedAt, url, urlSource, detail: 'Healthcheck still starting.' };
  }
  if (probe?.checked) {
    if (!probe.reachable) {
      return { state: 'unreachable', evidence, stack, startedAt, url, urlSource, detail: `HTTP unreachable (${probe.errorType || 'no response'}).` };
    }
    const code = probe.statusCode ?? 0;
    if (code >= 200 && code < 400) {
      return { state: 'healthy', evidence, stack, startedAt, url, urlSource, detail: `HTTP ${code}.` };
    }
    return { state: 'degraded', evidence, stack, startedAt, url, urlSource, detail: `HTTP ${code}.` };
  }
  // Running, no healthcheck, no probe verdict: present, not proven.
  return {
    state: 'available', evidence, stack, startedAt, url, urlSource,
    detail: url ? 'Running. HTTP has not been checked.' : 'Running with no healthcheck and no URL.',
  };
}

/**
 * Full evaluation for one discovered service: aggregates container evidence and, when the
 * service owns a trusted URL, probes it (bounded + cached by probe.js).
 */
export async function evaluateServiceHealth(service, { container = null, probeFn = probeUrl } = {}) {
  const state = container?.state?.status || service?.container?.state || null;
  const healthcheck = container?.state?.health ?? service?.container?.health ?? null;
  const url = service?.url || null;
  const urlSource = service?.urlSource || 'none';
  let probe = null;
  if (url && ['traefik', 'published-port', 'manual'].includes(urlSource)) {
    try { probe = await probeFn(url, { source: urlSource }); }
    catch { probe = { checked: false, code: 'not_checked', reason: 'The probe failed unexpectedly.', source: urlSource }; }
  }
  const verdict = aggregateHealth({
    state, healthcheck, url, urlSource, probe,
    stack: service?.stackDisplayName || service?.stack || null,
    startedAt: container?.state?.status === 'running' ? container?.state?.startedAt || null : null,
  });
  return {
    service: service?.name || null,
    displayName: service?.displayName || null,
    health: verdict,
    probe: probe ? {
      checked: !!probe.checked,
      reachable: probe.reachable ?? null,
      statusCode: probe.statusCode ?? null,
      latencyMs: probe.latencyMs ?? null,
      checkedAt: probe.checkedAt || null,
      source: probe.source || null,
      errorType: probe.errorType || null,
    } : { checked: false, code: 'not_checked', reason: url ? 'This URL source is not probed.' : 'No URL to probe.' },
    evaluatedAt: Date.now(),
  };
}
