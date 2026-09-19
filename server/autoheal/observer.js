// Phase 10C — Autoheal observer & event normalization
// Observes Docker Autoheal as an infrastructure component and normalizes recovery webhooks / events.
//
// Key architectural requirements:
// 1. Webhook authentication via shared secret (OPUSHUB_WEBHOOK_SECRET)
// 2. Verified vs unverified target validation against live Docker inventory
// 3. Autoheal race suppression during active Update Now maintenance windows
// 4. Secret sanitization — never leaks environment, tokens, socket paths

import * as docker from '../providers/docker.js';
import * as model from '../model.js';
import { logEvent } from '../activity.js';
import { publishEvent } from '../events/index.js';
import { isContainerUpdating } from '../updates/transaction.js';

// In-memory ring of recent autoheal recoveries
const recentRecoveries = [];
const MAX_RECOVERIES = 50;

export function recordAutohealRecovery(rec) {
  recentRecoveries.unshift(rec);
  if (recentRecoveries.length > MAX_RECOVERIES) {
    recentRecoveries.pop();
  }
}

export function getAutohealRecoveries() {
  return [...recentRecoveries];
}

/**
 * Discover Autoheal status from live Docker engine:
 * - is Autoheal installed/running
 * - version where available
 * - monitored container count (containers with autoheal=true or healthchecks)
 * - enabled/opted-in containers
 * - unhealthy containers
 * - recent recoveries
 */
export async function getAutohealStatus() {
  let containers = [];
  try {
    containers = await docker.listContainers({ all: true, withLabels: true });
  } catch {
    return {
      available: false,
      running: false,
      version: null,
      monitoredCount: 0,
      optedInCount: 0,
      unhealthyCount: 0,
      monitoredContainers: [],
      unhealthyContainers: [],
      recentRecoveries: getAutohealRecoveries(),
    };
  }

  // Find Autoheal container
  const autohealContainer = containers.find((c) =>
    c.name === 'autoheal' ||
    c.name === '/autoheal' ||
    (c.image && c.image.includes('autoheal'))
  );

  const isRunning = autohealContainer?.state === 'running';

  // Inspect containers to count opted-in containers (autoheal=true)
  const optedIn = [];
  const unhealthy = [];

  for (const c of containers) {
    const labels = c.labels?.raw || c.rawLabels || {};
    const name = (c.name || '').replace(/^\//, '');
    const isOptedIn = labels.autoheal === 'true' || labels['autoheal'] === 'true';
    if (isOptedIn) {
      optedIn.push({ id: c.id, name, state: c.state, health: c.health || null });
    }
    if (c.health === 'unhealthy') {
      unhealthy.push({ id: c.id, name, state: c.state });
    }
  }

  return {
    available: !!autohealContainer,
    running: isRunning,
    containerId: autohealContainer?.id ? String(autohealContainer.id).slice(0, 12) : null,
    version: autohealContainer?.image ? autohealContainer.image.split(':').pop() : null,
    monitoredCount: optedIn.length,
    optedInCount: optedIn.length,
    unhealthyCount: unhealthy.length,
    monitoredContainers: optedIn.slice(0, 20),
    unhealthyContainers: unhealthy,
    recentRecoveries: getAutohealRecoveries(),
    lastRecovery: recentRecoveries[0] || null,
  };
}

/**
 * Normalize incoming Autoheal webhook / alert into canonical OpusHub events.
 *
 * Upstream willfarrell/docker-autoheal webhook text:
 * "Container <name> (<short_id>) found to be unhealthy. Successfully restarted the container!"
 * "Container <name> (<short_id>) found to be unhealthy. Failed to restart the container!"
 */
export async function handleAutohealWebhook(body) {
  const text = typeof body === 'string' ? body : (body?.text || body?.content || body?.message || '');
  if (!text) {
    return { ok: false, code: 'empty_payload', reason: 'No message in payload' };
  }

  // Parse text using regex matching upstream autoheal pattern
  const match = text.match(/Container\s+([^\s(]+)\s*\(([^)]+)\)\s*found to be unhealthy\.\s*(Successfully restarted|Failed to restart)/i);

  const containerName = match ? match[1] : (body.containerName || 'unknown');
  const shortId = match ? match[2] : (body.containerId || 'unknown');
  const succeeded = match ? /successfully/i.test(match[3]) : (body.success !== false);

  // Autoheal race check: if container is currently undergoing an authorized Update Now transaction,
  // SUPPRESS this webhook so it doesn't race or trigger false alarms!
  if (isContainerUpdating(shortId) || isContainerUpdating(containerName)) {
    return {
      ok: true,
      suppressed: true,
      reason: 'Container is in an authorized update maintenance window; Autoheal alert suppressed.',
    };
  }

  // Target validation against live Docker inventory
  const inv = await model.getInventory().catch(() => null);
  const matchedService = inv?.services?.find((s) =>
    s.container?.name === containerName ||
    (s.container?.id && s.container.id.startsWith(shortId))
  );

  const isVerified = !!matchedService;
  const serviceName = matchedService?.name || containerName;
  const serviceLabel = matchedService?.displayName || serviceName;
  const eventType = succeeded ? 'container.autoheal.restarted' : 'container.autoheal.failed';
  const severity = succeeded ? 'notice' : 'critical';

  const recoveryRecord = {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    t: Date.now(),
    containerId: shortId,
    containerName,
    service: serviceName,
    verified: isVerified,
    success: succeeded,
    message: succeeded
      ? `Autoheal successfully restarted ${serviceLabel}`
      : `Autoheal failed to restart ${serviceLabel}`,
  };

  recordAutohealRecovery(recoveryRecord);

  // Publish canonical event ONLY if validated or clearly marked
  try {
    publishEvent({
      type: eventType,
      severity,
      source: 'docker',
      subject: {
        kind: 'service',
        id: shortId,
        label: serviceLabel,
        href: `/services`,
      },
      message: recoveryRecord.message,
      payload: {
        containerId: shortId,
        containerName,
        serviceId: serviceName,
        verified: isVerified,
        result: succeeded ? 'restarted' : 'failed',
      },
      correlation: { service: serviceName, target: shortId },
    });
  } catch {}

  logEvent({
    source: 'docker',
    type: eventType,
    subject: serviceLabel,
    message: recoveryRecord.message,
    meta: {
      containerId: shortId,
      verified: isVerified,
      success: succeeded,
    },
    severity,
    category: 'service',
  });

  return { ok: true, verified: isVerified, recovery: recoveryRecord };
}
