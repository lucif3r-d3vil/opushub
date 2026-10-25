// The top of the Hub: words, time, search. One display moment per page, and it belongs here.
import { useEffect, useState } from 'react';
import type { ServicesDoc } from '../../lib/types';
import { useSettings } from '../../lib/theme';
import { StatusDot } from '../ui';
import { Icon } from '../Icon';
import { plural } from '../../lib/format';
import { searchShortcutLabel } from '../SearchOverlay';
import { GlobalUpdateIndicator } from '../Updates';

/**
 * The greeting's whole vocabulary, in one place.
 *
 * Exported so it can be pinned by a test: the rendered greeting depends on the *hour the process
 * happens to be running at*, which made any assertion on the Hub's headline a coin flip at 4am.
 * The four windows below are the contract; the smoke check accepts any of them.
 */
export const GREETINGS = ['Still up', 'Good morning', 'Good afternoon', 'Good evening'] as const;

export function greetingFor(name: string | null, hour: number): { lead: string; name: string | null } {
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const clean = name?.trim();
  return { lead: part, name: clean ? clean.slice(0, 40) : null };
}

export interface HubHeaderProps {
  services: ServicesDoc | null;
  onSearch: () => void;
  /** preview surfaces freeze the clock so the frame stays stable */
  frozenNow?: Date;
}

export function HubHeader({ services, onSearch, frozenNow }: HubHeaderProps) {
  const { settings } = useSettings();
  const [now, setNow] = useState(() => frozenNow || new Date());
  useEffect(() => {
    if (frozenNow) { setNow(frozenNow); return; }
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, [frozenNow]);

  const { lead, name } = greetingFor(settings?.hub?.greetingName ?? null, now.getHours());
  const stats = services?.stats;
  const live = !!services?.live;

  return (
    <header className="hub-head">
      <div className="hub-head-main">
        <h1 className="greeting">
          {lead}
          {name && <em>, {name}</em>}
        </h1>
        <div className="hub-head-meta">
          <StatusDot state={live ? 'up' : services ? 'unavailable' : 'unmanaged'} title={services?.statusReason || (live ? 'Docker connected' : 'Docker not connected')} />
          <span>
            {services == null
              ? 'Reading this machine…'
              : live
                ? `${plural(stats?.applications ?? 0, 'service')}${stats ? ` · ${stats.running} running` : ''}${stats ? ` · ${plural(stats.stacks, 'stack')}` : ''}`
                : 'Docker isn’t connected — nothing can be discovered right now'}
          </span>
          <span className="dot-sep">·</span>
          <span>week {isoWeek(now)}</span>
          <GlobalUpdateIndicator />
        </div>
        <button className="hub-search" onClick={onSearch} aria-label="Search OpusHub">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" /></svg>
          <span className="hub-search-text">Search services, stacks, settings…</span>
          <kbd className="kbd">{searchShortcutLabel()}</kbd>
        </button>
      </div>
      <div className="hub-head-side">
        <div className="hub-clock">
          <div className="hub-clock-time">
            {now.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: !(settings?.hub.clock24h ?? false) })}
          </div>
          <div className="hub-clock-date">{now.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
      </div>
    </header>
  );
}

function isoWeek(d: Date): number {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
