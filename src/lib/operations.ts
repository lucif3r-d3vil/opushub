// Operations client — the browser's entire view of the Operations Engine.
//
// What the browser may send: an action id and a reference to a service.
// What it may never send: a Docker endpoint, an HTTP method, a container id used as an endpoint,
// a command, or a promise that it was allowed to. There is no field in these payloads for any of
// those things, and the server reads none of them if they are added.
//
// A dry-run returns the evaluation *and* a confirmation token; executing spends that token. The
// two calls are separate on purpose: the first cannot operate, and the second cannot operate
// without the first.
import { useMemo } from 'react';
import { api, usePolled } from './api';

export type OperationAction =
  | 'container.start' | 'container.restart' | 'container.stop'
  | 'container.pause' | 'container.unpause' | 'container.kill'
  | 'container.rename' | 'container.pull_image' | 'container.network_attach' | 'container.network_detach'
  | 'container.update' | 'container.recreate' | 'container.edit' | 'container.change_image'
  | 'container.duplicate' | 'container.create' | 'container.remove'
  | 'stack.deploy' | 'stack.start' | 'stack.stop' | 'stack.remove'
  | 'image.pull' | 'service.install';

/** The lifecycle actions a service page offers as buttons. */
export const LIFECYCLE_ACTIONS: OperationAction[] = ['container.start', 'container.restart', 'container.stop', 'container.pause', 'container.unpause', 'container.kill'];

export interface OperationTargetRef {
  type: 'service' | 'container' | 'stack' | 'image' | 'new' | 'catalog';
  id?: string;
  group?: string;
  name?: string;
}

/**
 * Operation parameters — an object the server validates against the action's declared schema.
 * The browser never invents fields: what each action accepts is documented next to the action
 * in server/operations/params.js, and anything else is refused (not ignored).
 */
export type OperationParams = Record<string, unknown>;

export interface PlanDiffEntry {
  field: string; label: string; kind: 'added' | 'removed' | 'changed';
  current: string | null; next: string | null; inPlace: boolean;
  keys?: { added: string[]; removed: string[]; changed: string[] };
}
export interface PlanDiff {
  changed: string[]; unchanged: string[]; entries: PlanDiffEntry[]; inPlace: boolean; recreate: boolean; summary: string[];
}
export interface PolicyFinding { level: 'SAFE' | 'WARNING' | 'DANGEROUS' | 'BLOCKED'; code: string; message: string; field?: string | null; preexisting?: boolean; service?: string | null }
export interface PlanDoc {
  kind: string | null;
  summary: string[];
  steps: string[];
  diff: PlanDiff | null;
  current: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
  policy: { level: PolicyFinding['level']; findings: PolicyFinding[] } | null;
  services?: unknown;
  resources?: unknown;
  integrations?: unknown;
  notes: string[];
}

export type OperationStatus =
  | 'pending' | 'awaiting_confirmation' | 'authorized' | 'running'
  | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'timed_out';

export interface OperationError { code: string; reason: string; detail?: string | null }

export interface OperationVerification {
  state?: string | null;
  health?: { state?: string | null; detail?: string | null; measured?: boolean } | null;
  startedAt?: string | null;
  verified?: boolean;
  note?: string | null;
}

export interface OperationDoc {
  id: string;
  action: string;
  target: {
    type: string | null; id: string | null; label: string | null; group: string | null;
    service: string | null; stack: string | null; containerName: string | null; state: string | null;
  } | null;
  actor: string | null;
  status: OperationStatus;
  requestedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  result: ({ state?: string | null; health?: string | null; unchanged?: boolean } & Record<string, unknown>) | null;
  error: OperationError | null;
  verification: OperationVerification | null;
  confirmation: { required: boolean; mode: string; consumed: boolean } | null;
  auditId: string | null;
  dryRun?: boolean;
  plan?: PlanDoc | null;
}

export interface DryRunCheck { key: string; label: string; ok: boolean; detail: string | null }

export interface DryRunDoc {
  ready: boolean;
  action: { id: string; label: string; risk: string; verb: string; timeoutMs: number; targetType?: string; executor?: string } | null;
  target: { type?: string; id?: string | null; label: string; containerName: string | null; state: string | null; health: string | null; group: string | null; stack: string | null; self: boolean } | null;
  permission: boolean;
  risk: string | null;
  docker: boolean;
  engineAction: string | null;
  confirmation: { required: boolean; mode: string };
  checks: DryRunCheck[];
  plan: PlanDoc | null;
  error: OperationError | null;
}

export interface OperationPrompt {
  title: string;
  body: string;
  acknowledge: string | null;
  confirmLabel: string;
  cancelLabel: string;
  risk: string;
  self: boolean;
  selfNote: string | null;
}

export interface ConfirmationDoc {
  required: boolean;
  mode: 'none' | 'normal' | 'strong';
  token: string;
  expiresAt: number;
  ttlMs: number;
  prompt: OperationPrompt;
}

export interface DryRunResponse {
  operation: OperationDoc;
  dryRun: DryRunDoc;
  confirmation: ConfirmationDoc;
}

export interface ExecuteResponse { operation: OperationDoc; error?: string | null }

export interface OperationsOverview {
  at: number;
  actor: { username: string | null; role: string; roleLabel: string; description: string; permissions: string[] };
  actions: { id: string; label: string; permission: string; risk: string; confirmation: string; summary: string; timeoutMs: number; verifyMs: number; enabled: boolean; permitted: boolean; targetType?: string; params?: string; executor?: string; offerWhen?: string[] }[];
  docker: { read: boolean; operations: boolean; channel: 'shared' | 'dedicated' };
  counts: { running: number; failed: number; recent: number };
  running: OperationDoc[];
  failed: OperationDoc[];
  recent: OperationDoc[];
}

export interface OperationTrailRow {
  id: string; t: number; iso: string; opId: string; phase: string; actor: string | null;
  action: string | null; target: { containerName?: string; label?: string } | null;
  status: string | null; reason: string | null; code: string | null; detail: string | null;
  confirmation: { required: boolean; mode: string; consumed: boolean } | null;
  durationMs: number | null; verification: { state: string | null; health: string | null; verified: boolean } | null;
  note: string | null;
}

export const TERMINAL: OperationStatus[] = ['succeeded', 'failed', 'rejected', 'cancelled', 'timed_out'];
export const isTerminal = (s: OperationStatus | string | null | undefined) => TERMINAL.includes(s as OperationStatus);

/** Ask the server what it would do. Never operates. */
export const dryRun = (action: string, target: OperationTargetRef, params?: OperationParams) =>
  api<DryRunResponse>('/api/v1/operations/dry-run', { method: 'POST', body: JSON.stringify({ action, target, ...(params ? { params } : {}) }) });

/**
 * Spend a confirmation. The server re-checks everything before it touches Docker — and the token
 * is bound to the exact parameters the dry-run evaluated, so the same `params` must be sent.
 */
export const execute = (action: string, target: OperationTargetRef, confirmationToken: string, operationId: string, params?: OperationParams) =>
  api<ExecuteResponse>('/api/v1/operations', { method: 'POST', body: JSON.stringify({ action, target, ...(params ? { params } : {}), confirmationToken, operationId }) });

export const fetchOperation = (id: string) => api<{ operation: OperationDoc }>(`/api/v1/operations/${id}`);

export const cancelOperation = (id: string) => api<{ operation: OperationDoc }>(`/api/v1/operations/${id}/cancel`, { method: 'POST', body: '{}' });

export const fetchOperations = () => api<OperationsOverview>('/api/v1/operations');

export const fetchTrail = (id: string) => api<{ operation: OperationDoc; trail: OperationTrailRow[] }>(`/api/v1/operations/${id}/trail`);

/**
 * Follow an operation until it settles.
 *
 * The server is authoritative throughout — this only reads. `onUpdate` fires with each observed
 * state, so the UI shows what the server reports rather than what it hopes is happening.
 */
export async function followOperation(
  id: string,
  onUpdate: (op: OperationDoc) => void,
  { intervalMs = 600, timeoutMs = 120_000 } = {},
): Promise<OperationDoc | null> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationDoc | null = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetchOperation(id);
      if (r?.operation) {
        last = r.operation;
        onUpdate(r.operation);
        if (isTerminal(r.operation.status)) return r.operation;
      }
    } catch {
      // a failed poll is not a failed operation — keep following until the deadline
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* words                                                               */
/* ------------------------------------------------------------------ */

export const ACTION_WORDS: Record<string, { verb: string; progressive: string; past: string; imperative: string }> = {
  'container.start': { verb: 'start', progressive: 'Starting', past: 'started', imperative: 'Start' },
  'container.restart': { verb: 'restart', progressive: 'Restarting', past: 'restarted', imperative: 'Restart' },
  'container.stop': { verb: 'stop', progressive: 'Stopping', past: 'stopped', imperative: 'Stop' },
  'container.pause': { verb: 'pause', progressive: 'Pausing', past: 'paused', imperative: 'Pause' },
  'container.unpause': { verb: 'unpause', progressive: 'Unpausing', past: 'unpaused', imperative: 'Unpause' },
  'container.kill': { verb: 'kill', progressive: 'Killing', past: 'killed', imperative: 'Kill' },
  'container.rename': { verb: 'rename', progressive: 'Renaming', past: 'renamed', imperative: 'Rename' },
  'container.remove': { verb: 'remove', progressive: 'Removing', past: 'removed', imperative: 'Remove' },
  'container.pull_image': { verb: 'pull', progressive: 'Pulling image for', past: 'image pulled', imperative: 'Pull image' },
  'container.network_attach': { verb: 'attach', progressive: 'Attaching network to', past: 'network attached', imperative: 'Attach network' },
  'container.network_detach': { verb: 'detach', progressive: 'Detaching network from', past: 'network detached', imperative: 'Detach network' },
  'container.update': { verb: 'update', progressive: 'Updating', past: 'updated', imperative: 'Update' },
  'container.recreate': { verb: 'recreate', progressive: 'Recreating', past: 'recreated', imperative: 'Recreate' },
  'container.edit': { verb: 'edit', progressive: 'Applying changes to', past: 'reconfigured', imperative: 'Apply changes' },
  'container.change_image': { verb: 'change image of', progressive: 'Changing image of', past: 'moved to a new image', imperative: 'Change image' },
  'container.duplicate': { verb: 'duplicate', progressive: 'Duplicating', past: 'duplicated', imperative: 'Duplicate' },
  'container.create': { verb: 'create', progressive: 'Creating', past: 'created', imperative: 'Create' },
  'stack.deploy': { verb: 'deploy', progressive: 'Deploying', past: 'deployed', imperative: 'Deploy' },
  'stack.start': { verb: 'start', progressive: 'Starting', past: 'started', imperative: 'Start' },
  'stack.stop': { verb: 'stop', progressive: 'Stopping', past: 'stopped', imperative: 'Stop' },
  'stack.remove': { verb: 'remove', progressive: 'Removing', past: 'removed', imperative: 'Remove' },
  'image.pull': { verb: 'pull', progressive: 'Pulling', past: 'pulled', imperative: 'Pull' },
  'service.install': { verb: 'install', progressive: 'Installing', past: 'installed', imperative: 'Install' },
};

export const wordsFor = (action: string) =>
  ACTION_WORDS[action] || { verb: action, progressive: 'Running', past: 'completed', imperative: 'Run' };

/** A state the engine reported, said plainly. Never "healthy" unless it was measured. */
export function stateWord(state: string | null | undefined): string {
  switch (state) {
    case 'running': return 'Running';
    case 'exited': return 'Stopped';
    case 'created': return 'Created';
    case 'paused': return 'Paused';
    case 'restarting': return 'Restarting';
    case 'dead': return 'Stopped';
    default: return state ? String(state) : 'Unknown';
  }
}

export function healthWord(health: string | null | undefined): string | null {
  switch (health) {
    case 'healthy': return 'Healthy';
    case 'unhealthy': return 'Unhealthy';
    case 'starting': return 'Still starting';
    default: return null;
  }
}

/**
 * Which lifecycle actions make sense for a container in this state.
 *
 * The UI's opinion only: the server re-checks everything and stays authoritative. These rules
 * exist so a button that cannot work is not offered, not to enforce anything.
 */
export function allowedActions(state: string | null | undefined): Record<string, boolean> {
  const s = String(state || '');
  const exists = s !== '';
  const stopped = s === 'exited' || s === 'created' || s === 'dead';
  const running = s === 'running';
  const paused = s === 'paused';
  return {
    'container.start': stopped,
    'container.restart': running,
    'container.stop': running,
    'container.pause': running,
    'container.unpause': paused,
    'container.kill': running || paused || s === 'restarting',
    'container.rename': exists,
    'container.remove': exists,
    'container.pull_image': exists,
    'container.network_attach': running || stopped || paused,
    'container.network_detach': running || stopped || paused,
    'container.update': running || stopped || paused,
    'container.recreate': exists,
    'container.edit': exists,
    'container.change_image': exists,
    'container.duplicate': exists,
  };
}

/** Ask for an operation from anywhere: the palette, a menu, a service page. */
export function requestOperation(action: OperationAction, target: OperationTargetRef, params?: OperationParams) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('opushub:operation', { detail: { action, target, params } }));
}

export const onOperationRequest = (fn: (detail: { action: OperationAction; target: OperationTargetRef; params?: OperationParams }) => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => fn((e as CustomEvent).detail);
  window.addEventListener('opushub:operation', handler);
  return () => window.removeEventListener('opushub:operation', handler);
};

/* ------------------------------------------------------------------ */
/* capability hook                                                     */
/* ------------------------------------------------------------------ */

/**
 * What this session is allowed to do, as the server described it.
 *
 * The UI uses it to decide what to *offer*; the server decides what is *allowed*. A button that
 * is hidden here proves nothing about authorization — it only avoids offering something that
 * would be refused.
 */
export function useOperationsCapabilities() {
  const { data, error } = usePolled<OperationsOverview>('/api/v1/operations', 60_000);
  const permitted = useMemo(
    () => new Set((data?.actions || []).filter((a) => a.permitted).map((a) => a.id)),
    [data],
  );
  return {
    loading: !data && !error,
    available: !!data?.docker?.operations,
    permitted,
    overview: data,
    can: (action: string) => permitted.has(action),
  };
}
