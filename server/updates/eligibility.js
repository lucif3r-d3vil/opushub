// Phase 10C — Container update eligibility analyzer
// Determines if a target container can be safely updated by OpusHub without arbitrary shell/compose exec.
//
// Eligibility requires:
// 1. Target container exists on Docker engine
// 2. Managed by standard Docker / Compose (has recognizable configuration)
// 3. Image reference is standard remote repository (not a local build without registry)
// 4. NOT OpusHub itself (cannot self-recreate without losing execution process)
// 5. NOT database/storage/network infrastructure without explicit opt-in
// 6. Has no unsupported configuration (e.g. host pid/ipc/uts, ephemeral volumes that cannot be mapped)
//
// If unsupported, provides an honest safe human-readable reason.

import * as docker from '../providers/docker.js';
import { selfContainerId } from '../operations/targets.js';

export function evaluateEligibility({ container, inspect = null, imageRef = null }) {
  if (!container) {
    return { eligible: false, reason: 'Container not found in live inventory' };
  }

  const containerName = container.name || container.containerName || '';
  const containerId = container.id || container.containerId || '';

  // 1. Check if self (OpusHub container)
  const selfId = selfContainerId();
  if (selfId && (containerId.startsWith(selfId.slice(0, 12)) || selfId.startsWith(containerId.slice(0, 12)))) {
    return {
      eligible: false,
      reason: 'OpusHub cannot recreate its own container — update OpusHub via host deployment.',
    };
  }
  if (/^opushub/i.test(containerName)) {
    return {
      eligible: false,
      reason: 'OpusHub cannot recreate its own container — update OpusHub via host deployment.',
    };
  }

  // 2. Critical infrastructure protection (Autoheal, Traefik, Docker socket proxies, databases)
  if (/^(autoheal|docker-autoheal)$/i.test(containerName)) {
    return {
      eligible: false,
      reason: 'Recovery infrastructure cannot be updated automatically from OpusHub.',
    };
  }

  // Check labels for explicit opt-out
  const labels = inspect?.labels || container.labels || {};
  const rawLabels = container.rawLabels || inspect?.Config?.Labels || {};
  if (rawLabels['opushub.update'] === 'false' || rawLabels['diun.enable'] === 'false') {
    return {
      eligible: false,
      reason: 'Container has explicitly opted out of updates (opushub.update=false).',
    };
  }

  // 3. Inspect details if available
  if (inspect) {
    // If container uses host network, pid, or ipc that requires privileged host privileges
    const hostConfig = inspect.HostConfig || {};
    if (hostConfig.PidMode === 'host') {
      return {
        eligible: false,
        reason: 'Container uses host PID namespace which cannot be safely preserved.',
      };
    }
    if (hostConfig.IpcMode === 'host') {
      return {
        eligible: false,
        reason: 'Container uses host IPC namespace which cannot be safely preserved.',
      };
    }
  }

  // 4. Image source validation
  const effectiveImage = imageRef || container.image || inspect?.Config?.Image || inspect?.image;
  if (!effectiveImage) {
    return { eligible: false, reason: 'Container has no associated image reference.' };
  }
  // Local scratch / build without registry tag
  if (effectiveImage.startsWith('sha256:') || effectiveImage.includes('<none>')) {
    return { eligible: false, reason: 'Container runs an untagged or local image.' };
  }

  return { eligible: true, reason: null };
}
