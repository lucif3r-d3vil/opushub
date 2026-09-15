// Icon browser + picker. Searches bundled collections (offline-first), then Iconify for the
// wider world; shows local files from config/icons/; accepts any URL or a short emoji.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { IconSearchDoc } from '../lib/types';
import { Icon } from './Icon';
import { Modal, Segmented } from './ui';

export function useIconSearch(q: string, enabled = true) {
  const [doc, setDoc] = useState<IconSearchDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api<IconSearchDoc>(`/api/icons/search?q=${encodeURIComponent(q)}`);
        if (alive) { setDoc(r); setErr(null); }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
      finally { if (alive) setBusy(false); }
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [q, enabled]);
  return { doc, busy, err };
}

export function IconGrid({ items, selected, onPick, size = 34 }: {
  items: { ref: string; label: string }[]; selected?: string | null; onPick: (ref: string) => void; size?: number;
}) {
  return (
    <div className="icon-grid">
      {items.map((it) => (
        <button key={it.ref} className={`icon-cell ${selected === it.ref ? 'sel' : ''}`} onClick={() => onPick(it.ref)} title={it.ref}>
          <Icon ref={it.ref} name={it.label} size={size} />
          <span className="nm">{it.label}</span>
        </button>
      ))}
      {!items.length && <div className="stale-note" style={{ gridColumn: '1/-1', padding: 'var(--sp-4) 0' }}>No matches — the server falls back to a letter monogram, which is also a valid look.</div>}
    </div>
  );
}

const SETS = [
  { value: 'all', label: 'All sets' },
  { value: 'lucide', label: 'Lucide' },
  { value: 'mdi', label: 'Material' },
  { value: 'si', label: 'Brand' },
  { value: 'local', label: 'Local files' },
] as const;

const RECENT_KEY = 'opushub.recentIcons';
const RECENT_MAX = 12;

/** Picks are remembered per browser, not per install: "recently used" is a convenience for the
 *  person choosing, and it has no business being configuration, a file, or a sync. */
function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

function rememberIcon(ref: string | null) {
  if (!ref) return;
  try {
    const next = [ref, ...readRecent().filter((x) => x !== ref)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode: the picker simply has no history */ }
}

export function IconPicker({ initial, onDone }: { initial: string | null; onDone: (ref: string | null) => void }) {
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const pick = (ref: string | null) => { rememberIcon(ref); setRecent(readRecent()); onDone(ref); };
  const [set, setSet] = useState<(typeof SETS)[number]['value']>('all');
  const { doc, busy, err } = useIconSearch(q || 'star', true);
  const local = usePolledLocal();
  const [custom, setCustom] = useState(initial && !/^[a-z0-9-]+:[a-z0-9+._-]+$/i.test(initial) ? initial : '');
  const results = useMemo<{ ref: string; label: string }[]>(() => {
    if (set === 'local') return local;
    let all: { ref: string; label: string; set: string }[] = (doc?.results || []).map((r) => ({ ref: r.ref, label: r.label, set: r.set }));
    if (set !== 'all') all = all.filter((r) => r.set === set || (set === 'si' && r.set === 'simple-icons'));
    return all;
  }, [doc, set, local]);
  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
        <input autoFocus className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search icons — music, shield, cloud…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search icons" />
        <Segmented value={set} options={SETS.map((s) => ({ value: s.value, label: s.label }))} onChange={setSet} ariaLabel="Icon source" />
      </div>
      {!q && recent.length > 0 && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="stale-note" style={{ marginBottom: 6 }}>Recently used</div>
          <IconGrid items={recent.map((ref) => ({ ref, label: ref.split(':').pop() || ref }))} selected={initial} onPick={pick} />
        </div>
      )}
      {err && <p className="stale-note" style={{ color: 'var(--warn)' }}>search failed: {err}</p>}
      {busy && !results.length && <p className="stale-note">searching…</p>}
      <div style={{ maxHeight: '46dvh', overflow: 'auto', paddingRight: 4 }}>
        <IconGrid
          items={results}
          selected={initial}
          onPick={pick}
        />
      </div>
      <div className="divider" />
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label htmlFor="icon-custom">Custom — an icon URL, a file in config/icons/, or a short emoji</label>
          <input id="icon-custom" className="input mono-meta" placeholder="/user/icons/my-icon.png · https://… · 🎵" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </div>
        <Icon ref={custom || null} name="preview" size={34} />
        <button className="btn" onClick={() => pick(custom.trim() || null)}>Use</button>
        {initial && <button className="btn btn-quiet" onClick={() => pick(null)}>Remove icon</button>}
      </div>
      {doc?.remote?.status === 'unavailable' && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
          Iconify unreachable ({doc.remote.reason?.slice(0, 80)}) — showing bundled sets only; they resolve offline.
        </p>
      )}
    </div>
  );
}

function usePolledLocal() {
  const [items, setItems] = useState<{ ref: string; label: string }[]>([]);
  useEffect(() => {
    api<{ files: { ref: string; name: string }[] }>('/api/icons/local')
      .then((r) => setItems(r.files.map((f) => ({ ref: f.ref, label: f.name }))))
      .catch(() => setItems([]));
  }, []);
  return items;
}

export function IconPickerModal({ initial, onPick, onClose }: { initial: string | null; onPick: (ref: string | null) => void; onClose: () => void }) {
  return (
    <Modal title="Choose an icon" onClose={onClose} wide>
      <IconPicker initial={initial} onDone={(r) => { onPick(r); onClose(); }} />
    </Modal>
  );
}
