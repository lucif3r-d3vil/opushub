// The command/search overlay. `/` or ⌘K opens it anywhere; results group like a real command
// interface, keyboard-native, and everything comes from already-configured OpusHub data.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, invalidateShared, post } from '../lib/api';
import { groupBy, type SearchEntry } from '../lib/search';
import { useSettings } from '../lib/theme';
import { Icon } from './Icon';
import { STATUS_WORDS, StatusDot } from './ui';

interface ServerResult extends SearchEntry { group?: string; status?: string }

const KIND_LABEL: Record<string, string> = {
  action: 'Actions', page: 'Pages', service: 'Services', stack: 'Stacks', setting: 'Settings',
  bookmark: 'Bookmarks', news: 'News',
};
const ORDER = ['Actions', 'Services', 'Stacks', 'Pages', 'Settings', 'Bookmarks', 'News'];

const KIND_ICON: Record<string, string> = {
  page: 'lucide:house', stack: 'lucide:layers', bookmark: 'lucide:bookmark', news: 'lucide:newspaper',
  action: 'lucide:command', setting: 'lucide:sliders-horizontal',
};

/** ⌘K on a Mac, Ctrl K everywhere else — the overlay should not teach the wrong muscle memory. */
export function searchShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

export function useGlobalSearchHotkey(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpen();
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { settings, update } = useSettings();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ServerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useMemo<ServerResult[]>(() => [
    // navigation — every page is one keystroke away
    { title: 'Go Home', subtitle: 'The Hub', kind: 'action', href: '/', keywords: ['hub', 'home', 'start'] },
    { title: 'Go Services', subtitle: 'Everything you run', kind: 'action', href: '/services', keywords: ['apps', 'containers'] },
    { title: 'Go Stacks', subtitle: 'Compose projects', kind: 'action', href: '/stacks', keywords: ['projects'] },
    { title: 'Go System', subtitle: 'Host vitals', kind: 'action', href: '/system', keywords: ['cpu', 'memory', 'host'] },
    { title: 'Go Activity', subtitle: 'What happened, when', kind: 'action', href: '/activity', keywords: ['events', 'timeline'] },
    { title: 'Go Settings', subtitle: 'Everything you can change', kind: 'action', href: '/settings/appearance', keywords: ['preferences', 'config'] },
    { title: 'Go Icons', subtitle: 'Icon browser', kind: 'action', href: '/icons', keywords: ['glyphs', 'logos'] },
    // presentation — no infrastructure mutation, ever
    {
      title: settings?.appearance.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
      subtitle: 'Appearance', kind: 'action', keywords: ['theme'],
      action: () => update({ appearance: { theme: settings?.appearance.theme === 'light' ? 'dark' : 'light' } }),
    },
    {
      title: 'Reset Hub layout', subtitle: 'Back to the default composition', kind: 'action', keywords: ['layout', 'default', 'factory'],
      action: () => { void post('/api/layout/reset').then(() => invalidateShared('/api/layout')); },
    },
    { title: 'Open templates', subtitle: 'Hub composition presets', kind: 'action', href: '/settings/templates', keywords: ['preset', 'composition'] },
    { title: 'Arrange Hub widgets', subtitle: 'Add, hide, resize, reorder', kind: 'action', href: '/settings/widgets' },
    { title: 'Customize a service', subtitle: 'Name, icon, group, URL', kind: 'action', href: '/settings/services' },
    { title: 'Browse icons', subtitle: 'Find one and apply it to a service', kind: 'action', href: '/icons' },
    { title: 'Integrations', subtitle: 'News, weather, markets', kind: 'action', href: '/settings/integrations' },
  ], [settings, update]);

  useEffect(() => {
    if (!open) { setQ(''); setResults([]); setActive(0); return; }
    setTimeout(() => inputRef.current?.focus(), 10);
    // empty query: show curated start surface (actions + a sample of services/stacks)
    if (!q.trim()) {
      api<{ results: ServerResult[] }>('/api/search?q=').then((r) => setResults(r.results.slice(0, 8))).catch(() => setResults([]));
      return;
    }
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<{ results: ServerResult[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        setResults(r.results);
      } catch { setResults([]); }
      setLoading(false);
      setActive(0);
    }, 180);
    return () => window.clearTimeout(t);
  }, [q, open]);

  const entries = useMemo<ServerResult[]>(() => {
    const acts = q.trim()
      ? actions
      : actions.slice(0, 6);
    const needle = q.toLowerCase();
    const localHits = acts.filter((a) => !needle
      || a.title.toLowerCase().includes(needle)
      || a.subtitle?.toLowerCase().includes(needle)
      || (a.keywords || []).some((k) => k.includes(needle)));
    return [...localHits, ...results];
  }, [q, actions, results]);

  const groups = useMemo(() => {
    const g = groupBy(entries, (e) => KIND_LABEL[e.kind] || e.kind);
    g.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    return g;
  }, [entries]);

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const it = flat[active];
        if (it) {
          if (it.action) it.action();
          else if (it.href) {
            if (it.external || /^https?:\/\//i.test(it.href || '')) window.open(it.href, '_blank', 'noreferrer');
            else nav(it.href!);
          }
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, active, onClose, nav]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let idx = -1;
  return (
    <div className="cmdk" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Search OpusHub">
      <div className="cmdk-panel">
        <div className="cmdk-input-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search services, stacks, pages, news…"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ color: 'var(--ink-3)' }}><path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" /></svg>}
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {!flat.length && (
            <div className="cmdk-empty">
              {q ? (
                <>
                  Nothing matches “{q}”.
                  <div className="stale-note" style={{ marginTop: 6 }}>Try a container name, a group, or a setting like “widgets”.</div>
                </>
              ) : (
                'Search services, stacks, pages and settings — everything comes from the same discovered inventory the pages use.'
              )}
            </div>
          )}
          {groups.map(([label, items]) => (
            <div key={label}>
              <div className="cmdk-group">{label}</div>
              {items.map((it) => {
                idx++;
                const mine = idx;
                return (
                  <button
                    key={`${label}-${it.title}-${mine}`}
                    className="cmdk-item"
                    data-idx={mine}
                    data-active={mine === active || undefined}
                    onMouseEnter={() => setActive(mine)}
                    onClick={() => {
                      if (it.action) it.action();
                      else if (it.href) {
                        if (it.external || /^https?:\/\//i.test(it.href || '')) window.open(it.href!, '_blank', 'noreferrer');
                        else nav(it.href!);
                      }
                      onClose();
                    }}
                  >
                    {it.kind === 'service' || it.kind === 'stack'
                      ? <Icon ref={it.icon} name={it.title} size={22} />
                      : <span className="icon-frame plain" style={{ ['--icon-size' as never]: '22px' }}><Icon ref={KIND_ICON[it.kind]} name={it.title} size={17} plain /></span>}
                    <span className="t">{it.title}</span>
                    <span className="s">
                      {it.status && <StatusDot state={it.status} title={STATUS_WORDS[it.status] || it.status} />}
                      {it.subtitle}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate</span>
          <span><kbd className="kbd">↵</kbd> open</span>
          <span style={{ marginLeft: 'auto' }}>{searchShortcutLabel()} anywhere · / everywhere</span>
        </div>
      </div>
    </div>
  );
}
