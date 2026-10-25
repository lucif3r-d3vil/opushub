// A launch tile: one click opens the service. Details are one step away, behind the ⋯ menu.
// The whole tile is a single link; the menu button sits beside it, never inside it.
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { Tile as TileModel } from '../../lib/homeModel';
import { allowedActions, requestOperation, wordsFor, type OperationAction } from '../../lib/operations';
import { useSettings } from '../../lib/theme';
import { Icon } from '../Icon';
import { Menu, type MenuItem } from '../ui';

export interface OpsCaps { available: boolean; can: (action: string) => boolean }

export function Tile({ tile, ops }: { tile: TileModel; ops: OpsCaps }) {
  const { svc, view, update, hue } = tile;
  const { settings } = useSettings();
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const detail = `/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}`;

  const logLaunch = useCallback(() => {
    if (settings?.behavior?.logLaunches) void api(`/api${detail}`, { method: 'POST' }).catch(() => undefined);
  }, [detail, settings?.behavior?.logLaunches]);

  const spot = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const sub = svc.url ? (svc.container.ports.find((p) => p.public)?.public ? `:${svc.container.ports.find((p) => p.public)!.public}` : new URL(svc.url).host) : 'No web address';
  const word = view.word ? `, ${view.word.toLowerCase()}` : '';
  const label = svc.url ? `Open ${svc.displayName}${word}` : `${svc.displayName}${word}, no web address — open details`;

  const target = { type: 'service' as const, id: svc.name, group: svc.group };
  const offered = allowedActions(svc.container?.state);
  const restart: OperationAction = 'container.restart';
  const items: MenuItem[] = [
    { label: 'Details', href: detail },
    ...(svc.url ? [{ label: 'Open in new tab', action: () => { logLaunch(); window.open(svc.url!, '_blank', 'noopener,noreferrer'); } }] : []),
    ...(update ? [{ label: 'Review update', href: detail }] : []),
    ...(ops.available && ops.can(restart) && offered[restart] ? [{ label: `${wordsFor(restart).imperative} ${svc.displayName}`, action: () => requestOperation(restart, target) }] : []),
    ...(svc.url ? [{ label: 'Copy address', action: () => void navigator.clipboard?.writeText(svc.url!).catch(() => undefined) }] : []),
  ];

  const body = (
    <>
      <div className="hm-top">
        <span className="hm-ico"><Icon ref={svc.icon} name={svc.displayName} size={26} plain /></span>
        <span className={`hm-st ${view.state}`}><i className={`hdot ${view.state}`} />{view.word}</span>
      </div>
      <div>
        <div className="hm-tname">{svc.displayName}</div>
        <div className="hm-tsub">
          <span className={svc.url ? undefined : 'hm-quiet'}>{sub}</span>
          {update && (
            <span className="hm-upd" title={update.to ? `Update available: ${update.from} → ${update.to}` : 'A newer image is available'}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>{update.to ?? 'update'}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="hm-tilew" style={{ ['--h' as never]: hue }}>
      {svc.url ? (
        <a className="hm-tile" href={svc.url} target="_blank" rel="noopener noreferrer" data-s={view.state} aria-label={label} onClick={logLaunch} onPointerMove={spot}>{body}</a>
      ) : (
        <Link className="hm-tile" to={detail} data-s={view.state} aria-label={label} onPointerMove={spot}>{body}</Link>
      )}
      <button ref={more} type="button" className="hm-more" aria-label={`More for ${svc.displayName}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      {menu && <Menu items={items} anchor={more.current} onClose={() => setMenu(false)} label={`${svc.displayName} actions`} />}
    </div>
  );
}
