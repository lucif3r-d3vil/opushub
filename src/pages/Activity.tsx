import { useMemo, useState } from 'react';
import { usePolled } from '../lib/api';
import { dayLabel, relTime, timeOfDay } from '../lib/format';
import type { ActivityEvent } from '../lib/types';
import { PageHero, ProviderNote } from '../components/ui';
import { humanEvent } from '../lib/events';

const SOURCES = ['all', 'system', 'config', 'user', 'docker'] as const;
type Source = (typeof SOURCES)[number];

const SOURCE_ICON: Record<string, string> = {
  'app.boot': 'M12 2v4M12 18v4M2 12h4M18 12h4',
  'settings.updated': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'layout.updated': 'M4 5h16M4 12h10M4 19h7',
  'services.updated': 'M4.5 4.5h6v6h-6zM13.5 13.5h6v6h-6z',
  'stacks.updated': 'm12 3 8.5 4.7L12 12.4 3.5 7.7zM3.5 12.5 12 17.2l8.5-4.7',
  'service.launch': 'M7 17 17 7M9 7h8v8',
  'bookmarks.updated': 'M7 4h10v16l-5-4-5 4z',
  'custom.updated': 'M8 6 3 12l5 6M16 6l5 6-5 6',
};

export default function ActivityPage() {
  const [source, setSource] = useState<Source>('all');
  const { data, error } = usePolled<{ items: ActivityEvent[]; total: number }>(`/api/activity?limit=150&source=${source}`, 30_000);
  const items = data?.items ?? [];

  const days = useMemo(() => {
    const out: [string, ActivityEvent[]][] = [];
    for (const e of items) {
      const label = dayLabel(e.t);
      const last = out[out.length - 1];
      if (last && last[0] === label) last[1].push(e);
      else out.push([label, [e]]);
    }
    return out;
  }, [items]);

  return (
    <>
      <PageHero
        title="Activity"
        desc="Everything OpusHub has witnessed: configuration changes, host and engine events, launches. Real events only — when nothing happened, this page is short."
        meta={data ? <span>{data.total} recorded event{data.total === 1 ? '' : 's'}</span> : undefined}
      />
      <div className="tl-filters" role="tablist" aria-label="Filter events" style={{ marginBottom: 'var(--sp-8)' }}>
        {SOURCES.map((s) => (
          <button key={s} role="tab" aria-selected={source === s} className={source === s ? 'chip active' : 'chip'} onClick={() => setSource(s)}>
            {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {error && !data && <ProviderNote status="error" reason={error} />}
      {!items.length && (
        <div className="unavailable" style={{ padding: 'var(--sp-12)' }}>
          <span className="why" style={{ fontSize: 14 }}>
            {source === 'all' ? 'No events yet. The log starts the moment OpusHub boots — try changing a setting or dragging a widget.' : `No ${source} events yet.`}
          </span>
        </div>
      )}

      <div className="activity-wrap">
        <div className="timeline">
          {days.map(([day, evs]) => (
            <div key={day}>
              <div className="tl-day">{day}</div>
              {evs.map((e) => (
                <div className="tl-item" key={e.id}>
                  <span className="tl-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                      <path d={SOURCE_ICON[e.type] || 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'} />
                    </svg>
                  </span>
                  <div className="tl-main">
                    <span className="tl-type">{humanEvent(e)}</span>
                    {e.subject && e.source !== 'user' && <span className="tl-subject">{e.subject}</span>}
                    {e.source !== 'system' && <span className="chip tl-src">{e.source}</span>}
                    <span className="tl-when" title={new Date(e.t).toLocaleString()}>
                      <span>{timeOfDay(e.t)}</span>
                      <span className="rel">{relTime(e.t)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
