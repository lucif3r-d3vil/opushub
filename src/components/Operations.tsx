// The operations UI: one confirmation dialog, one place.
//
// Every surface — Service Detail, the Stack page, a service menu, the command palette — asks for
// an operation the same way: it dispatches `opushub:operation` with an action id and a service
// reference. This component owns what happens next, so there is exactly one confirmation flow in
// OpusHub and no surface can quietly skip it.
//
// The dialog is honest about what it knows:
//   • it shows the server's own dry-run (the checks the execution will repeat), not a summary
//   • it never says "done" until the operation reports a terminal status
//   • a failure shows the reason the server gave, and a timeout says the outcome was not proven
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, invalidateShared } from '../lib/api';
import { relTime } from '../lib/format';
import {
  cancelOperation, dryRun, execute, followOperation, healthWord, isTerminal, stateWord, wordsFor,
  onOperationRequest,
  type ConfirmationDoc, type DryRunResponse, type OperationAction, type OperationDoc,
  type OperationParams, type OperationTargetRef, type PlanDoc,
} from '../lib/operations';
import { Modal } from './ui';

type Phase = 'evaluating' | 'ready' | 'refused' | 'executing' | 'done';

interface Request {
  action: OperationAction;
  target: OperationTargetRef;
  params?: OperationParams;
  /** distinguishes two requests for the same action+target so the dialog resets */
  key: number;
}

/**
 * Mount once, anywhere inside the router. It renders nothing until something asks for an
 * operation.
 */
export function OperationsHost() {
  const [req, setReq] = useState<Request | null>(null);
  useEffect(() => onOperationRequest((d) => setReq({ ...d, key: Date.now() })), []);
  if (!req) return null;
  return (
    <OperationDialog
      key={req.key}
      action={req.action}
      target={req.target}
      params={req.params}
      onClose={() => setReq(null)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* the dialog                                                          */
/* ------------------------------------------------------------------ */

export function OperationDialog({
  action, target, params, onClose, inline = false,
}: {
  action: OperationAction;
  target: OperationTargetRef;
  /** the action's parameters — evaluated by the dry-run and bound into the confirmation token */
  params?: OperationParams;
  onClose: () => void;
  /** rendered inside a page (hides the backdrop) — same flow, same server checks */
  inline?: boolean;
}) {
  const words = wordsFor(action);
  const paramsKey = useMemo(() => JSON.stringify(params ?? null), [params]);
  const [phase, setPhase] = useState<Phase>('evaluating');
  const [dry, setDry] = useState<DryRunResponse | null>(null);
  const [op, setOp] = useState<OperationDoc | null>(null);
  const [error, setError] = useState<{ reason: string; code: string | null; detail?: string | null } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  // 1 — the server evaluates. Nothing has happened to the container and nothing can yet.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await dryRun(action, target, params);
        if (!alive) return;
        setDry(r);
        setPhase('ready');
      } catch (err) {
        if (!alive) return;
        const body = err instanceof ApiError ? (err.body as { operation?: OperationDoc; error?: string; code?: string } | null) : null;
        setError({
          reason: body?.operation?.error?.reason || body?.error || (err instanceof Error ? err.message : 'The operation was refused.'),
          code: body?.operation?.error?.code || body?.code || null,
          detail: body?.operation?.error?.detail || null,
        });
        setOp(body?.operation || null);
        setPhase('refused');
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, target.id, target.group, target.name, target.type, paramsKey]);

  const dismiss = useCallback(() => {
    // leaving a confirmation on the table retires it, so an abandoned dialog cannot be spent later
    if (phase === 'ready' && dry?.operation?.id) void cancelOperation(dry.operation.id).catch(() => undefined);
    onClose();
  }, [phase, dry, onClose]);

  const confirm = useCallback(async () => {
    if (!dry?.confirmation) return;
    setBusy(true);
    cancelled.current = false;
    setPhase('executing');
    try {
      const r = await execute(action, target, dry.confirmation.token, dry.operation.id, params);
      setOp(r.operation);
      const final = await followOperation(r.operation.id, setOp);
      setOp(final);
      setPhase('done');
      // the inventory just changed; every open page should see it without waiting for a poll
      invalidateShared('/api/services');
      invalidateShared('/api/stacks');
      invalidateShared('/api/activity');
      invalidateShared('/api/v1/operations');
      invalidateShared('/api/v1/stacks');
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { operation?: OperationDoc; error?: string; code?: string } | null) : null;
      setError({
        reason: body?.operation?.error?.reason || body?.error || (err instanceof Error ? err.message : 'The operation could not be started.'),
        code: body?.operation?.error?.code || body?.code || null,
        detail: body?.operation?.error?.detail || null,
      });
      if (body?.operation) setOp(body.operation);
      setPhase('done');
    } finally {
      setBusy(false);
    }
  }, [action, target, dry, params]);

  const prompt = dry?.confirmation?.prompt;
  const strong = dry?.confirmation?.mode === 'strong';
  const title = useMemo(() => {
    if (phase === 'evaluating') return 'Checking…';
    if (phase === 'refused') return 'Operation refused';
    if (phase === 'executing') return `${words.progressive} ${dry?.dryRun.target?.label || 'service'}…`;
    if (phase === 'done' && op) {
      if (op.status === 'succeeded') return `${dry?.dryRun.target?.label || 'Service'} ${words.past}`;
      if (op.status === 'timed_out') return `${words.progressive} timed out`;
      if (op.status === 'rejected') return 'Operation rejected';
      if (op.status === 'cancelled') return 'Operation cancelled';
      return `${words.progressive} failed`;
    }
    return prompt?.title || words.imperative;
  }, [phase, op, words, dry, prompt]);

  const body = (
    <>
      {phase === 'evaluating' && (
        <p className="op-note" role="status">
          <span className="op-spinner" aria-hidden="true" />
          Checking permission, target and Docker before asking you to confirm.
        </p>
      )}

      {phase === 'refused' && (
        <RefusedPanel
          dry={dry}
          error={error}
          operation={op}
          onOpen={() => undefined}
        />
      )}

      {phase === 'ready' && dry && (
        <>
          <p className="op-prompt">{prompt?.body}</p>
          {prompt?.selfNote && (
            <p className="op-warn" role="alert">{prompt.selfNote}</p>
          )}
          <DryRunPanel doc={dry.dryRun} />
          {dry.dryRun.plan && <PlanPanel plan={dry.dryRun.plan} />}
          {strong && prompt?.acknowledge && (
            <label className="op-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>{prompt.acknowledge}</span>
            </label>
          )}
        </>
      )}

      {phase === 'executing' && (
        <ProgressPanel operation={op} words={words} label={dry?.dryRun.target?.label || null} />
      )}

      {phase === 'done' && op && (
        <ResultPanel operation={op} words={words} error={error} label={dry?.dryRun.target?.label || op.target?.label || null} />
      )}
    </>
  );

  const footer = (
    <>
      {phase === 'refused' && <button className="btn" onClick={onClose}>Close</button>}
      {phase === 'ready' && (
        <>
          <button className="btn btn-quiet" onClick={dismiss}>{prompt?.cancelLabel || 'Cancel'}</button>
          <button
            className={strong ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={strong && !acknowledged}
            onClick={() => void confirm()}
          >
            {prompt?.confirmLabel || words.imperative}
          </button>
        </>
      )}
      {phase === 'executing' && <span className="op-note">This finishes on its own — you can leave this open.</span>}
      {phase === 'done' && (
        <>
          <Link className="btn btn-quiet" to="/activity">View Activity</Link>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="op-inline" role="group" aria-label={title}>
        <div className="op-inline-head"><h3>{title}</h3></div>
        <div className="op-inline-body">{body}</div>
        <div className="op-inline-foot">{footer}</div>
      </div>
    );
  }
  const wide = !!dry?.dryRun?.plan?.diff?.entries?.length;
  return <Modal title={title} onClose={phase === 'executing' ? () => undefined : dismiss} footer={footer} wide={wide}>{body}</Modal>;
}

/* ------------------------------------------------------------------ */
/* panels                                                              */
/* ------------------------------------------------------------------ */

/** The dry-run report: the checks the server ran, and the ones it will run again. */
function DryRunPanel({ doc }: { doc: DryRunResponse['dryRun'] }) {
  return (
    <>
      {doc.target && (
        <div className="op-target">
          <div>
            <span className="micro-label">Target</span>
            <div className="op-target-name">{doc.target.label}</div>
            <div className="op-quiet">{doc.target.containerName} · {stateWord(doc.target.state)}{doc.target.stack ? ` · ${doc.target.stack}` : ''}</div>
          </div>
          <span className={`op-risk op-risk--${doc.risk || 'low'}`}>{riskWord(doc.risk)} risk</span>
        </div>
      )}
      <ul className="op-checks">
        {doc.checks.map((c) => (
          <li key={c.key} data-ok={c.ok || undefined}>
            <span className="op-check-mark" aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
            <span className="op-check-label">{c.label}</span>
            <span className="op-check-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
      {doc.ready
        ? <p className="op-note op-note--ok">Ready to execute — {doc.engineAction}, then OpusHub checks the {doc.target?.type === 'stack' ? 'stack' : 'container'} again.</p>
        : <p className="op-note op-note--bad">Not ready: {doc.error?.reason}</p>}
    </>
  );
}

/**
 * The plan: what will change (CURRENT → NEW, field by field), what the configuration policy
 * found, and the steps the transaction will take. Rendered from the server's own plan — the
 * same object the confirmation token is bound to — never from anything the page computed.
 */
export function PlanPanel({ plan, compact = false }: { plan: PlanDoc; compact?: boolean }) {
  const diff = plan.diff;
  const findings = plan.policy?.findings || [];
  const level = plan.policy?.level || 'SAFE';
  return (
    <div className="op-plan">
      {diff && diff.entries.length > 0 && (
        <>
          <div className="op-plan-head">
            <span className="micro-label">Changes</span>
            <span className={`op-plan-mode ${diff.recreate ? 'op-plan-mode--recreate' : ''}`}>
              {diff.recreate ? 'requires recreate' : diff.inPlace ? 'applied in place' : 'no change'}
            </span>
          </div>
          <table className="op-diff">
            <thead><tr><th>Field</th><th>Current</th><th>New</th></tr></thead>
            <tbody>
              {diff.entries.map((e) => (
                <tr key={e.field} data-kind={e.kind}>
                  <td className="op-diff-field">{e.label}{e.inPlace ? '' : <span className="op-quiet" title="changing this recreates the container"> ↻</span>}</td>
                  <td className="op-diff-val"><pre>{e.current ?? '—'}</pre></td>
                  <td className="op-diff-val"><pre>{e.next ?? '—'}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!compact && diff.unchanged.length > 0 && (
            <p className="op-quiet">Unchanged: {diff.unchanged.length} field{diff.unchanged.length === 1 ? '' : 's'}.</p>
          )}
        </>
      )}
      {findings.length > 0 && (
        <ul className={`op-findings op-findings--${level.toLowerCase()}`} aria-label="Configuration policy">
          {findings.map((f, i) => (
            <li key={`${f.code}-${i}`} data-level={f.level}>
              <span className="op-finding-level">{f.level}</span>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!compact && plan.steps?.length > 0 && (
        <details className="op-steps">
          <summary>{plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}</summary>
          <ol>{plan.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
        </details>
      )}
      {plan.notes?.length > 0 && plan.notes.map((n, i) => <p key={i} className="op-note">{n}</p>)}
    </div>
  );
}

function RefusedPanel({
  error, operation,
}: {
  dry: DryRunResponse | null;
  error: { reason: string; code: string | null; detail?: string | null } | null;
  operation: OperationDoc | null;
  onOpen: () => void;
}) {
  return (
    <div className="op-refused">
      <p className="op-reason">{error?.reason || 'The operation was refused.'}</p>
      {error?.detail && <p className="op-quiet">{error.detail}</p>}
      {operation?.id && (
        <p className="op-quiet">
          Nothing was changed. Operation <code>{operation.id}</code> was recorded as rejected.
        </p>
      )}
    </div>
  );
}

function ProgressPanel({ operation, words, label }: { operation: OperationDoc | null; words: ReturnType<typeof wordsFor>; label: string | null }) {
  const started = operation?.startedAt || Date.now();
  return (
    <div className="op-progress" role="status" aria-live="polite">
      <span className="op-spinner" aria-hidden="true" />
      <div>
        <div className="op-progress-line">{words.progressive} {label || 'service'}</div>
        <div className="op-quiet">
          {operation?.id ? `Operation ${operation.id}` : 'Starting'}
          {operation?.status === 'running' ? ' · the container is checked again once this finishes' : ''}
        </div>
        <Elapsed since={started} />
      </div>
    </div>
  );
}

function ResultPanel({
  operation, words, error, label,
}: {
  operation: OperationDoc;
  words: ReturnType<typeof wordsFor>;
  error: { reason: string; code: string | null; detail?: string | null } | null;
  label: string | null;
}) {
  const v = operation.verification;
  if (operation.status === 'succeeded') {
    return (
      <div className="op-result op-result--ok">
        <p className="op-reason">{label || 'Service'} {words.past}{operation.result?.unchanged ? ' (it was already in that state)' : ''}.</p>
        <div className="op-chips">
          <span className="op-chip">Container: {stateWord(v?.state)}</span>
          {v?.health?.state && <span className="op-chip">Health: {healthWord(v.health.state) || v.health.state}{v.health.measured === false ? ' (still checking)' : ''}</span>}
          {operation.durationMs != null && <span className="op-chip">{Math.max(0, Math.round(operation.durationMs / 100) / 10)}s</span>}
        </div>
        {v?.health?.state === 'starting' && <p className="op-quiet">The container is up; its healthcheck has not finished yet.</p>}
      </div>
    );
  }
  if (operation.status === 'timed_out') {
    return (
      <div className="op-result op-result--warn">
        <p className="op-reason">{words.progressive} took longer than expected.</p>
        <p className="op-quiet">
          OpusHub stopped waiting and checked the container: it is {stateWord(v?.state).toLowerCase()}.
          The Docker call may still have completed — check the service before repeating this.
        </p>
      </div>
    );
  }
  return (
    <div className="op-result op-result--bad">
      <p className="op-reason">{error?.reason || operation.error?.reason || `${words.progressive} failed.`}</p>
      {(error?.detail || operation.error?.detail) && <p className="op-quiet">{error?.detail || operation.error?.detail}</p>}
      {v?.state && <p className="op-quiet">The container is {stateWord(v.state).toLowerCase()}.</p>}
    </div>
  );
}

/** A live elapsed counter — bounded, and it stops the moment the operation settles. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  return <div className="op-quiet">{secs}s</div>;
}

const riskWord = (risk: string | null) =>
  risk === 'high' ? 'Higher' : risk === 'medium' ? 'Medium' : risk === 'low' ? 'Low' : 'Unknown';

/* ------------------------------------------------------------------ */
/* a running operation, in whatever row it belongs to                  */
/* ------------------------------------------------------------------ */

/** One line about an operation, for the Activity page and the Operations panel. */
export function OperationRow({ operation, onOpen }: { operation: OperationDoc; onOpen?: (o: OperationDoc) => void }) {
  const words = wordsFor(operation.action);
  const target = operation.target?.label || operation.target?.containerName || 'service';
  const status = operation.status;
  return (
    <button
      className={`op-row op-row--${status}`}
      onClick={() => onOpen?.(operation)}
      title={operation.error?.reason || `${words.progressive} ${target}`}
    >
      <span className={`op-mark op-mark--${status}`} aria-hidden="true">
        {status === 'running' || status === 'authorized' ? '●' : status === 'succeeded' ? '✓' : status === 'timed_out' ? '◔' : '✕'}
      </span>
      <span className="op-row-text">
        <span className="op-row-title">{words.imperative} {target}</span>
        <span className="op-row-sub">
          {statusWord(status)}
          {operation.completedAt ? ` · ${relTime(operation.completedAt)}` : operation.startedAt ? ` · started ${relTime(operation.startedAt)}` : ''}
          {operation.actor ? ` · ${operation.actor}` : ''}
        </span>
      </span>
      {operation.durationMs != null && <span className="op-row-dur">{Math.max(0, Math.round(operation.durationMs / 100) / 10)}s</span>}
    </button>
  );
}

const statusWord = (s: string) =>
  s === 'running' || s === 'authorized' ? 'Running'
    : s === 'awaiting_confirmation' ? 'Awaiting confirmation'
      : s === 'succeeded' ? 'Completed'
        : s === 'failed' ? 'Failed'
          : s === 'timed_out' ? 'Timed out'
            : s === 'rejected' ? 'Rejected'
              : s === 'cancelled' ? 'Cancelled' : s;

export { isTerminal };
