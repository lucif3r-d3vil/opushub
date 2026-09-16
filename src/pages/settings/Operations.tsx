// Phase 8 — the Operations pane in Settings.
//
// This is the one place the whole engine is described to a person, and it is deliberately
// *informational*: there is no switch here that turns confirmation off, no "allow more actions",
// no way to widen the allow-list from the browser. The registry lives on the server, and this
// pane reports it.
//
// Three questions it answers, in order:
//   1. Can operations run at all right now?       (engine reachable, and over which channel)
//   2. What may this account do?                  (role → permissions → each action permitted?)
//   3. What actually happened?                    (the recent trail, read-only)
//
// Nothing here executes anything either. Running an operation is done from a service's own page,
// the Hub menu, or the command palette — and all three of those open a confirmation first.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolled } from '../../lib/api';
import { relTime } from '../../lib/format';
import type { OperationsOverview, OperationDoc } from '../../lib/operations';
import { wordsFor } from '../../lib/operations';
import { Loading } from '../../components/ui';
import { Block, Row } from './parts';

/**
 * The guarantees, stated in the UI rather than only in a doc.
 *
 * Each line is a property of the engine that a test also asserts (see server/phase8-proof.test.js
 * and server/phase8-operations.test.js) — the point of listing them here is that an operator can
 * see what the boundary is without reading the source.
 */
const GUARANTEES: { title: string; body: string }[] = [
  {
    title: 'Three actions, fixed on the server',
    body: 'Start, restart and stop. That list is compiled into the server, not sent by the browser, so a request naming anything else is refused and recorded.',
  },
  {
    title: 'Targets are resolved from the inventory',
    body: 'You name a service; the server resolves it to a container it can see right now. A raw container id is not accepted as a target.',
  },
  {
    title: 'Permission is checked again, server-side',
    body: 'Every request is authorized against the account’s role at the moment it is made. Hiding a button in the browser changes nothing about what the server will allow.',
  },
  {
    title: 'Confirmation is a token, not a flag',
    body: 'The browser cannot say "confirmed". It can only return a single-use token the server issued for that exact operation, actor and session, and it expires.',
  },
  {
    title: 'A dry-run takes the same path',
    body: 'Evaluating an operation runs the same authorization, target resolution and policy checks as running it, and executes nothing.',
  },
  {
    title: 'One operation per container',
    body: 'A container is locked while an operation is in flight, requests are rate limited, and a repeated-failure target is backed off before it accepts another.',
  },
  {
    title: 'Outcomes are verified, not assumed',
    body: 'After the call returns, the container’s real state is read back. If that cannot be proven in time, the operation is reported as unproven — never as a success.',
  },
  {
    title: 'Every attempt is audited',
    body: 'Requests, refusals, executions, timeouts and failures are written to an append-only trail that keeps its most recent 2,000 records. Nothing in it can be deleted from the browser, and it never contains credentials, tokens or environment values.',
  },
];

/** What Phase 8 deliberately does not do. Saying so prevents it being "fixed" later by accident. */
const OUT_OF_SCOPE = [
  'no shell or command execution — there is no code path that runs a command you supply',
  'no `docker exec`, no file access, no Compose execution, no image or volume management',
  'no Docker API passthrough: the client names an action, never an endpoint or a method',
  'no automatic remediation — an alert never triggers an operation, and nothing restarts on a schedule',
  'no bulk actions — operations act on one container at a time; there is no "restart stack"',
  'no queued or deferred execution — an operation either runs now and is verified, or it does not run',
  'no access for AI agents or external tools — the engine has no MCP, no agent surface, no API key of its own',
];

export function OperationsSettingsTab() {
  const { data, error, loading } = usePolled<OperationsOverview>('/api/v1/operations', 15_000);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <p className="stale-note">Operations status is unavailable right now.</p>;
  if (!data) return null;

  const { actor, actions, docker, counts, recent, running, failed } = data;
  const permitted = actions.filter((a) => a.permitted);

  return (
    <>
      <Block
        title="Operations"
        aside={docker.operations ? <span className="op-chip op-chip--ok">engine reachable</span> : <span className="op-chip op-chip--warn">engine unreachable</span>}
      >
        <p className="stale-note" style={{ marginTop: 0 }}>
          OpusHub can start, restart and stop the containers it already shows you — and nothing else.
          Every operation is named on the server, authorized there, confirmed with a single-use token,
          verified against the real container state afterwards, and written to an audit trail.
          This pane reports the engine; it does not configure it.
        </p>

        <div className="form-list">
          <Row
            label="Engine"
            desc={docker.operations
              ? `Reachable over the ${docker.channel === 'dedicated' ? 'dedicated operations socket' : 'engine endpoint discovery already uses'}.`
              : 'Unreachable, so no operation can run. Pages stay read-only and nothing fails silently.'}
          >
            <span className="op-chip">{docker.channel === 'dedicated' ? 'dedicated socket' : 'shared endpoint'}</span>
          </Row>
          <Row
            label="This account"
            desc={actor.description}
          >
            <span className="op-chip">{actor.roleLabel}</span>
          </Row>
          <Row
            label="What this account may run"
            desc={permitted.length
              ? permitted.map((a) => wordsFor(a.id as never)?.imperative ?? a.label).join(', ')
              : 'Nothing. Operations are not offered to this role, and requesting one anyway is refused and recorded.'}
          >
            <span className="op-chip">{permitted.length} of {actions.length}</span>
          </Row>
          <Row
            label="Right now"
            desc="Operations currently in flight, and recent failures."
          >
            <span className="op-chip">{counts.running} running</span>
            <span className={`op-chip${counts.failed ? ' op-chip--warn' : ''}`}>{counts.failed} failed</span>
          </Row>
        </div>
      </Block>

      <Block title="The three actions" aside="fixed at build time, not configurable from the browser">
        <div className="form-list">
          {actions.map((a) => {
            const w = wordsFor(a.id as never);
            const open = expanded === a.id;
            return (
              <div key={a.id} className="op-settings-row">
                <button
                  className="op-settings-summary"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : a.id)}
                >
                  <span className="op-settings-title">
                    {w?.imperative ?? a.label}
                    <code className="mono">{a.id}</code>
                  </span>
                  <span className="op-chips">
                    <span className={`op-chip op-chip--${a.risk === 'high' ? 'warn' : a.risk === 'medium' ? 'mid' : 'ok'}`}>{a.risk} risk</span>
                    <span className="op-chip">{a.confirmation} confirmation</span>
                    <span className={`op-chip${a.permitted ? ' op-chip--ok' : ''}`}>{a.permitted ? 'permitted' : 'not permitted'}</span>
                    <span className="op-chip op-chip--quiet">{open ? '−' : '+'}</span>
                  </span>
                </button>
                {open && (
                  <div className="op-settings-detail">
                    <p style={{ margin: '0 0 8px' }}>{a.summary}</p>
                    <dl className="op-facts">
                      <div><dt>Permission</dt><dd><code className="mono">{a.permission}</code></dd></div>
                      <div><dt>Execution timeout</dt><dd>{Math.round(a.timeoutMs / 1000)}s</dd></div>
                      <div><dt>Verification window</dt><dd>{Math.round(a.verifyMs / 1000)}s</dd></div>
                      <div><dt>Enabled</dt><dd>{a.enabled ? 'yes' : 'no'}</dd></div>
                    </dl>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Block>

      <Block title="Recent operations" aside={<Link className="section-link" to="/activity">Open Activity →</Link>}>
        {!recent.length && !running.length && !failed.length && (
          <p className="stale-note" style={{ marginTop: 0 }}>
            No operations have run yet. When one does, it appears here and in Activity with who asked,
            what was asked, and what the engine found afterwards.
          </p>
        )}
        {!!running.length && (
          <div className="form-list">
            <div className="fr-label" style={{ paddingTop: 4 }}>In flight</div>
            {running.map((op) => <OperationLine key={op.id} op={op} />)}
          </div>
        )}
        {!!recent.length && (
          <div className="form-list">
            <div className="fr-label" style={{ paddingTop: 4 }}>Most recent</div>
            {recent.slice(0, 10).map((op) => <OperationLine key={op.id} op={op} />)}
          </div>
        )}
        {!!failed.length && (
          <div className="form-list">
            <div className="fr-label" style={{ paddingTop: 4 }}>Failed or timed out</div>
            {failed.map((op) => <OperationLine key={op.id} op={op} />)}
          </div>
        )}
      </Block>

      <Block title="What every operation is guaranteed">
        <div className="op-list">
          {GUARANTEES.map((g) => (
            <div key={g.title} className="op-list-item">
              <div className="op-list-title">{g.title}</div>
              <div className="op-list-body">{g.body}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block title="What it will not do" aside="deliberate, not pending">
        <ul className="op-list op-list--bullets">
          {OUT_OF_SCOPE.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="stale-note">
          The audit trail is on the server at <code className="mono">data/operations.jsonl</code> — append-only in
          normal operation, trimmed to its most recent records, and never writable from the browser.
        </p>
      </Block>
    </>
  );
}

/** One line of history: who asked for what, and what the engine concluded. */
function OperationLine({ op }: { op: OperationDoc }) {
  const w = wordsFor(op.action as never);
  const verb = w?.past ?? op.action;
  const state = op.result?.state || op.verification?.state || null;
  return (
    <div className="op-line">
      <span className={`op-dot op-dot--${op.status}`} aria-hidden="true" />
      <span className="op-line-main">
        <strong>{verb}</strong> {op.target?.label || op.target?.containerName || 'unknown target'}
      </span>
      <span className="op-line-meta">
        {op.actor ? `by ${op.actor}` : 'unknown actor'} · {relTime(op.requestedAt)}
        {op.durationMs != null && ` · ${(op.durationMs / 1000).toFixed(1)}s`}
      </span>
      <span className="op-line-state">
        {op.status === 'succeeded' && state ? `verified ${state}` : null}
        {op.status === 'timed_out' ? 'outcome unproven — timed out' : null}
        {op.status === 'failed' ? (op.error?.reason || 'failed') : null}
        {op.status === 'rejected' ? (op.error?.reason || 'refused') : null}
        {op.status === 'cancelled' ? 'cancelled before it ran' : null}
        {(op.status === 'running' || op.status === 'authorized' || op.status === 'awaiting_confirmation' || op.status === 'pending') ? 'in progress' : null}
      </span>
    </div>
  );
}
