// The widget shell — one frame for every Hub block.
//
// It is deliberately not a card: a title, an optional quiet meta line, and a tools menu that
// appears on hover/focus. Presentation stays inside the widget (a clock is typography, news is a
// list, system is a strip); the frame only holds the name, the drag handle and the controls.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WidgetCatalogueEntry, WidgetInstance, WidgetSize, WidgetZone } from '../../lib/types';
import { SIZE_LABEL, SIZE_ORDER, ZONE_LABEL } from '../../lib/hubLayout';
import { Menu, type MenuItem } from '../ui';

export interface WidgetFrameProps {
  widget: WidgetInstance;
  catalogue: WidgetCatalogueEntry[];
  zone: WidgetZone;
  interactive: boolean;
  handle?: ReactNode;
  right?: ReactNode;
  /** one short line of real state (freshness, counts) — never decoration */
  note?: ReactNode;
  onPatch?: (patch: Partial<WidgetInstance>) => void;
  onMove?: (zone: WidgetZone) => void;
  children: ReactNode;
}

export function WidgetFrame({ widget, catalogue, zone, interactive, handle, right, note, onPatch, onMove, children }: WidgetFrameProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const entry = catalogue.find((c) => c.type === widget.type);
  const title = widget.title || entry?.title || widget.type;
  const sizes = entry?.sizes || SIZE_ORDER;
  const canConfigure = (entry?.config?.length || 0) > 0;

  const items: MenuItem[] = [];
  if (onMove) {
    items.push({ label: `Move to ${ZONE_LABEL[zone === 'main' ? 'rail' : 'main'].toLowerCase()}`, action: () => onMove(zone === 'main' ? 'rail' : 'main') });
  }
  if (onPatch && sizes.length > 1) {
    items.push({ sep: true, label: '' });
    for (const s of sizes) {
      items.push({ label: `Size — ${SIZE_LABEL[s] ?? s}`, active: widget.size === s, action: () => onPatch({ size: s as WidgetSize }) });
    }
  }
  if (canConfigure) items.push({ label: 'Configure this widget…', href: `/settings/widgets#w-${widget.id}` });
  if (onPatch) {
    items.push({ sep: true, label: '' });
    items.push({ label: 'Hide from Hub', action: () => onPatch({ visible: false }) });
  }
  items.push({ label: 'Widget settings…', href: '/settings/widgets' });

  return (
    <section className={`widget widget--${zone}`} aria-label={title} data-widget-id={widget.id}>
      <div className="widget-head">
        <h2 className="widget-title">
          {handle}
          <span>{title}</span>
          {note && <span className="widget-note">{note}</span>}
        </h2>
        <span className="widget-tools">
          {right}
          {interactive && items.length > 0 && (
            <button
              className="icon-btn"
              aria-label={`${title} options`}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: Math.min(r.right - 200, window.innerWidth - 212), y: r.bottom + 6 });
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
          )}
        </span>
      </div>
      <div className="widget-body">{children}</div>
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </section>
  );
}

/** The quiet, per-widget "no data yet" line — the page stays stable while providers answer. */
export function WidgetLoading({ what = 'Reading…' }: { what?: string }) {
  return <div className="widget-quiet" role="status" aria-live="polite">{what}</div>;
}

/** Empty states are sentences, never illustrations. */
export function WidgetEmpty({ children, href, linkLabel }: { children: ReactNode; href?: string; linkLabel?: string }) {
  return (
    <div className="widget-empty">
      <span>{children}</span>
      {href && linkLabel && <Link className="section-link" to={href}>{linkLabel}</Link>}
    </div>
  );
}
