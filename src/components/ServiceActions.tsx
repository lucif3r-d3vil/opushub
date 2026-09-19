// Service lifecycle actions — the same operation flow everywhere.
//
// These controls do not perform operations. They ask for one: `requestOperation()` opens the
// normal confirmation dialog, and the server decides whether it may happen. Nothing here can
// skip a check, and a disabled button is a courtesy rather than a control — the server is
// authoritative and re-checks every time.
//
// Button state follows the container's observed state (you cannot stop what is not running), and
// every control disappears when this session holds no operation permissions at all.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  allowedActions, requestOperation, useOperationsCapabilities, wordsFor,
  type OperationAction, type OperationTargetRef,
} from '../lib/operations';
import { MenuButton, type MenuItem } from './ui';

/** The three buttons every service shows. Pause/unpause/kill and the rest live in the menu. */
const ORDER: OperationAction[] = ['container.start', 'container.restart', 'container.stop'];

/** The menu: every container action the server registers, in the order it makes sense to read. */
const MENU_ORDER: OperationAction[] = [
  'container.start', 'container.restart', 'container.stop', 'container.pause', 'container.unpause', 'container.kill',
  'container.pull_image', 'container.recreate', 'container.rename', 'container.duplicate', 'container.remove',
];
/** Actions that need parameters the menu cannot supply — they open the editor instead. */
const NEEDS_INPUT = new Set<OperationAction>(['container.rename', 'container.duplicate', 'container.remove', 'container.edit', 'container.change_image', 'container.network_attach', 'container.network_detach', 'container.update', 'container.create']);
const DANGER = new Set<OperationAction>(['container.stop', 'container.kill', 'container.remove', 'container.recreate']);

const ICONS: Partial<Record<OperationAction, string>> = {
  'container.start': 'M6 4.5 19 12 6 19.5z',
  'container.restart': 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  'container.stop': 'M6.5 6.5h11v11h-11z',
};

/** Ask the page to open the Edit Container UI for one of the parameterised actions. */
export function requestEditor(name: string, group: string | null | undefined, mode: 'edit' | 'rename' | 'duplicate' | 'remove' | 'change_image' | 'networks' | 'resources') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('opushub:container-editor', { detail: { name, group: group || null, mode } }));
}

export interface ServiceActionsProps {
  /** the container name — the canonical service key */
  name: string;
  group?: string | null;
  /** observed docker state: running | exited | paused | restarting | created … */
  state?: string | null;
  /** hide everything when the engine is not reachable */
  dockerAvailable?: boolean;
}

/**
 * Three restrained buttons. `Start` when stopped, `Restart`/`Stop` when running — the inert one
 * is disabled rather than hidden, so the set of things OpusHub can do stays visible.
 */
export function ServiceActions({ name, group, state, dockerAvailable = true, size = 'sm' }: ServiceActionsProps & { size?: 'sm' | 'md' }) {
  const { can, available } = useOperationsCapabilities();
  const allowed = allowedActions(state);
  const target: OperationTargetRef = { type: 'service', id: name, ...(group ? { group } : {}) };
  const enabled = dockerAvailable && available;

  if (!ORDER.some((a) => can(a))) return null; // a viewer sees no operations at all

  return (
    <div className="svc-actions" role="group" aria-label={`Operations for ${name}`}>
      {ORDER.map((action) => {
        const w = wordsFor(action);
        const ok = enabled && allowed[action];
        return (
          <button
            key={action}
            className={action === 'container.stop' ? 'btn btn-sm btn-quiet stop' : `btn btn-${size === 'md' ? 'sm' : 'sm'}`}
            disabled={!ok}
            title={ok ? `${w.imperative} ${name}` : reason(action, state, enabled)}
            onClick={() => requestOperation(action, target)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={ICONS[action] || ''} />
            </svg>
            {w.imperative}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The menu form — for the Hub and the Services list, where navigation is the point and an
 * operation is a secondary affordance. "Open" and "Details" stay first.
 */
export function ServiceActionMenu({
  name, group, state, url, detailHref, className = 'icon-btn', label,
}: ServiceActionsProps & { url?: string | null; detailHref?: string; className?: string; label?: string }) {
  const { can, available } = useOperationsCapabilities();
  const allowed = allowedActions(state);
  const target: OperationTargetRef = { type: 'service', id: name, ...(group ? { group } : {}) };
  const detail = detailHref || `/services/${encodeURIComponent(group || 'Other')}/${encodeURIComponent(name)}`;

  const items: MenuItem[] = [];
  if (url) items.push({ label: 'Open in new tab', action: () => window.open(url, '_blank', 'noreferrer') });
  items.push({ label: 'Service details', href: detail });
  const operations = MENU_ORDER.filter((a) => can(a) && allowed[a]);
  if (operations.length && available) {
    items.push({ sep: true } as unknown as MenuItem);
    for (const action of operations) {
      const w = wordsFor(action);
      items.push({
        label: `${w.imperative} ${name}`,
        action: () => (NEEDS_INPUT.has(action) ? requestEditor(name, group, editorMode(action)) : requestOperation(action, target)),
        ...(DANGER.has(action) ? { danger: true } : {}),
      });
    }
    if (can('container.edit')) {
      items.push({ sep: true } as unknown as MenuItem);
      items.push({ label: `Edit ${name}…`, action: () => requestEditor(name, group, 'edit') });
      items.push({ label: `Change image…`, action: () => requestEditor(name, group, 'change_image') });
      items.push({ label: `Networks…`, action: () => requestEditor(name, group, 'networks') });
    }
  }
  return (
    <MenuButton items={items} label={label || `Actions for ${name}`} className={className} align="end">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" />
      </svg>
    </MenuButton>
  );
}

function editorMode(action: OperationAction): 'edit' | 'rename' | 'duplicate' | 'remove' | 'change_image' | 'networks' | 'resources' {
  switch (action) {
    case 'container.rename': return 'rename';
    case 'container.duplicate': return 'duplicate';
    case 'container.remove': return 'remove';
    case 'container.change_image': return 'change_image';
    case 'container.network_attach':
    case 'container.network_detach': return 'networks';
    case 'container.update': return 'resources';
    default: return 'edit';
  }
}

/** Why a control is not available — said once, in the tooltip, not in a wall of warnings. */
function reason(action: OperationAction, state: string | null | undefined, enabled: boolean): string {
  if (!enabled) return 'Docker is not connected, so no operation can run';
  const s = String(state || 'unknown');
  if (action === 'container.start') return `Only a stopped container can be started (this one is ${s})`;
  if (action === 'container.restart') return `Only a running container can be restarted (this one is ${s})`;
  return `Only a running container can be stopped (this one is ${s})`;
}

/** A compact "recent operations" list for a service page. */
export function RecentOperations({ rows, onOpen }: { rows: { id: string; action: string; status: string; at: number; actor: string | null }[]; onOpen?: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <p className="stale-note">No operations have been run on this service yet.</p>;
  return (
    <ul className="op-recent">
      {rows.slice(0, 5).map((r) => {
        const w = wordsFor(r.action);
        return (
          <li key={r.id}>
            <button className="op-recent-row" onClick={() => { setOpen(r.id); onOpen?.(r.id); }} aria-expanded={open === r.id}>
              <span className={`op-mark op-mark--${r.status}`} aria-hidden="true">
                {r.status === 'succeeded' ? '✓' : r.status === 'failed' || r.status === 'rejected' ? '✕' : '◔'}
              </span>
              <span className="op-recent-text">
                <span>{w.past[0].toUpperCase() + w.past.slice(1)}</span>
                <span className="op-quiet">{new Date(r.at).toLocaleString()}{r.actor ? ` · ${r.actor}` : ''}</span>
              </span>
            </button>
          </li>
        );
      })}
      <li><Link className="section-link" to="/activity">All operations →</Link></li>
    </ul>
  );
}
