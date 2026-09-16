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

export type OperationAction = 'container.start' | 'container.restart' | 'container.stop';

export interface OperationTargetRef {
  type: 'service' | 'container';
  id: string;
  group?: string;
  name?: string;
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
  result: { state?: string | null; health?: string | null; unchanged?: boolean } | null;
  error: OperationError | null;
  verification: OperationVerification | null;
  confirmation: { required: boolean; mode: string; consumed: boolean } | null;
  auditId: string | null;
  dryRun?: boolean;
}

export interface DryRunCheck { key: string; label: string; ok: boolean; detail: string | null }

export interface DryRunDoc {
  ready: boolean;
  action: { id: string; label: string; risk: string; verb: string; timeoutMs: number } | null;
  target: { label: string; containerName: string; state: string | null; health: string | null; group: string | null; stack: string | null; self: boolean } | null;
  permission: boolean;
  risk: string | null;
  docker: boolean;
  engineAction: string | null;
  confirmation: { required: boolean; mode: string };
  checks: DryRunCheck[];
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
  actions: { id: string; label: string; permission: string; risk: string; confirmation: string; summary: string; timeoutMs: number; verifyMs: number; enabled: boolean; permitted: boolean }[];
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
export const dryRun = (action: string, target: OperationTargetRef) =>
  api<DryRunResponse>('/api/v1/operations/dry-run', { method: 'POST', body: JSON.stringify({ action, target }) });

/** Spend a confirmation. The server re-checks everything before it touches Docker. */
export const execute = (action: string, target: OperationTargetRef, confirmationToken: string, operationId: string) =>
  api<ExecuteResponse>('/api/v1/operations', { method: 'POST', body: JSON.stringify({ action, target, confirmationToken, operationId }) });

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
export function allowedActions(state: string | null | undefined): Record<OperationAction, boolean> {
  const s = String(state || '');
  return {
    'container.start': s === 'exited' || s === 'created' || s === 'dead',
    'container.restart': s === 'running',
    'container.stop': s === 'running',
  };
}

/** Ask for an operation from anywhere: the palette, a menu, a service page. */
export function requestOperation(action: OperationAction, target: OperationTargetRef) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('opushub:operation', { detail: { action, target } }));
}

export const onOperationRequest = (fn: (detail: { action: OperationAction; target: OperationTargetRef }) => void) => {
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
