// The Home sections other than the host strip and the tiles: the greeting, the "needs attention"
// band, and the right rail (updates, uptime, bookmarks). Each hides itself when it has nothing real
// to say.
import { Link } from 'react-router-dom';
import type { BookmarkGroup } from '../../lib/hubData';
import { relTime } from '../../lib/format';
import type { AttentionItem, UpdateRow, UptimeSummary } from '../../lib/homeModel';
import { requestOperation } from '../../lib/operations';
import { Icon } from '../Icon';
import type { OpsCaps } from './Tile';

export function Attention({ items, healOn, ops }: { items: AttentionItem[]; healOn: number | null; ops: OpsCaps }) {
  if (!items.length) return null;
  return (
    <section className="hm-attn glass rise" style={{ ['--i' as never]: 2 }} aria-labelledby="hm-attn-h">
      <header>
        <i className="hdot warn" />
        <h2 id="hm-attn-h">Needs attention · {items.length}</h2>
        {healOn != null && healOn > 0 && <span className="hm-meta">auto-heal is on for {healOn} container{healOn === 1 ? '' : 's'}</span>}
      </header>
      <div className="hm-items">
        {items.map((it) => {
          const svc = it.svc;
          const detail = svc ? `/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}` : `/monitoring/${it.monitorId}`;
          // a stopped container is started, a running one that is struggling is restarted; either only when this session may
          const act: 'container.start' | 'container.restart' | null = !svc || !ops.available ? null
            : svc.container?.state === 'running' ? 'container.restart'
              : svc.container?.state === 'exited' || svc.container?.state === 'created' ? 'container.start' : null;
          const canAct = !!act && ops.can(act);
          return (
            <div key={it.key} className="hm-ai">
              <i className={`hdot ${it.state}`} />
              <Link to={detail} className="hm-ai-main"><b>{it.name}</b><small>{it.reason}</small></Link>
              {canAct
                ? <button type="button" className="hm-go" onClick={() => requestOperation(act!, { type: 'service', id: svc!.name, group: svc!.group })}>{act === 'container.start' ? 'Start' : 'Restart'} →</button>
                : <Link to={detail} className="hm-go">Details →</Link>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function UpdatesCard({ rows, checkedAt, index }: { rows: UpdateRow[]; checkedAt: number | null; index: number }) {
  if (!rows.length) return null;
  return (
    <section className="hm-w glass rise" style={{ ['--i' as never]: index }}>
      <header><h2>Updates available</h2><span className="hm-meta">{rows.length}</span></header>
      {rows.map((r) => (
        <div key={r.key} className="hm-u" style={{ ['--h' as never]: r.hue }}>
          <span className="hm-mini"><Icon ref={r.svc?.icon} name={r.name} size={18} plain /></span>
          <div><b>{r.name}</b><small>{r.from && r.to ? `${r.from} → ${r.to}` : `${r.image} · newer image`}</small></div>
          <Link to={r.svc ? `/services/${encodeURIComponent(r.svc.group)}/${encodeURIComponent(r.svc.name)}` : '/services'}>Review</Link>
        </div>
      ))}
      <div className="hm-foot">{checkedAt ? `Last notice ${relTime(checkedAt)}` : 'No check time recorded'} · nothing is applied automatically</div>
    </section>
  );
}

export function UptimeCard({ summary, index }: { summary: UptimeSummary | null; index: number }) {
  if (!summary) return null;
  return (
    <section className="hm-w glass rise" style={{ ['--i' as never]: index }}>
      <header><h2>Uptime</h2><Link className="hm-more-link" to="/monitoring">Open →</Link></header>
      <div className="hm-bignum">
        {summary.pct != null ? <b>{summary.pct.toFixed(summary.pct >= 99.995 ? 0 : 2)}<span className="hm-pct">%</span></b> : <b>—</b>}
        <span>today<br />{summary.up} of {summary.total} up now</span>
      </div>
      {summary.down.slice(0, 4).map((m) => (
        <Link key={m.id} to={`/monitoring/${m.id}`} className="hm-mrow"><i className={`hdot ${m.status === 'down' ? 'fail' : 'warn'}`} /><span>{m.name}</span><small>{m.status}</small></Link>
      ))}
    </section>
  );
}

export function BookmarksCard({ groups, index }: { groups: BookmarkGroup[]; index: number }) {
  const items = groups.flatMap((g) => g.items);
  if (!items.length) return null;
  return (
    <section className="hm-w glass rise" style={{ ['--i' as never]: index }}>
      <header><h2>Bookmarks</h2></header>
      <div className="hm-chips">
        {items.slice(0, 24).map((b) => (
          <a key={`${b.name}${b.href}`} className="hm-chip" href={b.href} target="_blank" rel="noopener noreferrer" title={b.description || undefined}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>{b.name}
          </a>
        ))}
      </div>
    </section>
  );
}
