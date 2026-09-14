// Icon browser — first-class customization tool, not a copy-the-ref utility.
//
// Pick an icon, then apply it to a container or a stack. Applying writes an *overlay*: an icon is
// presentation metadata, never infrastructure. Resolution itself is untouched (see
// source: providers/icons.js — bundled collections first, Iconify when reachable, monogram last).
import { useMemo, useState } from 'react';
import { usePolled } from '../lib/api';
import type { ServicesDoc, StacksDoc } from '../lib/types';
import { PageHero, ProviderNote, StatusDot } from '../components/ui';
import { Icon } from '../components/Icon';
import { useIconSearch, IconGrid } from '../components/IconPicker';
import { applyServiceIcon, saveStackIcon } from '../lib/overlay';

type Target = { kind: 'service'; container: string; label: string } | { kind: 'stack'; id: string; label: string };

export default function IconsPage() {
  const services = usePolled<ServicesDoc>('/api/services', 0);
  const stacks = usePolled<StacksDoc>('/api/stacks', 0);
  const [q, setQ] = useState('');
  const { doc, busy } = useIconSearch(q || 'star', true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [applying, setApplying] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const inventory = services.data?.services ?? [];
  const targets = useMemo(
    () => inventory.filter((s) => !s.hidden).map((s) => ({ kind: 'service' as const, container: s.name, label: s.displayName, icon: s.icon, group: s.group })),
    [inventory],
  );
  const stackTargets = useMemo(
    () => (stacks.data?.stacks ?? []).map((s) => ({ kind: 'stack' as const, id: s.id, label: s.displayName || s.name, icon: s.icon, group: s.project || '' })),
    [stacks.data],
  );
  const all = [...targets, ...stackTargets];
  const f = filter.trim().toLowerCase();
  const shown = f ? all.filter((t) => `${t.label} ${t.group || ''}`.toLowerCase().includes(f)) : all;
  const used = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of all) if (t.icon) map.set(t.icon, [...(map.get(t.icon) || []), t.label]);
    return map;
  }, [all]);

  const apply = async (t: Target) => {
    if (!chosen) return;
    setErr(null);
    setApplying(`${t.kind}:${t.label}`);
    try {
      if (t.kind === 'service') {
        if (!services.data) throw new Error('the service inventory is not loaded yet');
        await applyServiceIcon(services.data, t.container, chosen);
      } else {
        if (!stacks.data) throw new Error('the stack list is not loaded yet');
        await saveStackIcon(stacks.data, t.id, chosen);
      }
      services.refresh(); stacks.refresh();
      setDone(`${t.label} → ${chosen}`);
      window.setTimeout(() => setDone(null), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(null);
    }
  };

  return (
    <>
      <PageHero
        title="Icons"
        desc="Bundled first: Lucide, Material Design Icons and Simple Icons ship with OpusHub and resolve offline. Iconify extends that when you are online, and a monogram is always the honest fallback. Pick one here and apply it directly to a discovered service or stack — it is written as an overlay, never to Docker."
        meta={<span>{used.size} icon{used.size === 1 ? '' : 's'} in use · {all.length} thing{all.length === 1 ? '' : 's'} you can dress</span>}
      />

      {used.size > 0 && (
        <section className="section">
          <div className="section-head"><h2 className="section-title">In use</h2><span className="section-aside">click to reuse</span></div>
          <div className="icon-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
            {[...used.entries()].map(([ref, names]) => (
              <button key={ref} className={`icon-cell${chosen === ref ? ' sel' : ''}`} title={names.join(', ')} onClick={() => setChosen(ref)}>
                <Icon ref={ref} name={names[0]} size={30} />
                <span className="nm">{names[0]}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Find an icon</h2>
          <span className="section-aside">{chosen ? <>selected <b className="mono-meta">{chosen}</b></> : 'pick one to apply it'}</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginBottom: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 220 }} autoFocus placeholder="Search icons — music, shield, cloud…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search icons" />
          {chosen && <button className="btn btn-quiet" onClick={() => setChosen(null)}>Clear selection</button>}
        </div>
        {busy && !doc && <p className="stale-note">Searching…</p>}
        <div style={{ maxHeight: '44dvh', overflow: 'auto', paddingRight: 4 }}>
          <IconGrid items={(doc?.results || []).map((r) => ({ ref: r.ref, label: r.label }))} selected={chosen} onPick={setChosen} />
        </div>
        {doc?.remote?.status === 'unavailable' && (
          <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
            Iconify unreachable ({doc.remote.reason?.slice(0, 80)}) — bundled sets are shown and resolve offline.
          </p>
        )}
        <div className="divider" />
        <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 240, marginBottom: 0 }}>
            <label htmlFor="icon-custom">Or use a URL, a file in config/icons/, or a short emoji</label>
            <input id="icon-custom" className="input mono-meta" placeholder="/user/icons/my-icon.png · https://… · 🎵"
              value={chosen && !/^[a-z0-9-]+:[a-z0-9+._-]+$/i.test(chosen) ? chosen : ''}
              onChange={(e) => setChosen(e.target.value.trim() || null)} />
          </div>
          <Icon ref={chosen} name="preview" size={34} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Apply to</h2>
          <span className="section-aside">services and stacks discovered on this engine</span>
        </div>
        {!chosen && <p className="stale-note">Choose an icon above; the list then applies it in one click.</p>}
        {services.data && !services.data.live && (
          <ProviderNote status="unavailable" reason="Docker isn't connected, so there is nothing to apply an icon to right now." fixHref="/settings/environment" fixLabel="Discovery status →" />
        )}
        {err && <p className="stale-note" style={{ color: 'var(--fail)', marginBottom: 8 }}>{err}</p>}
        {done && <p className="stale-note" style={{ color: 'var(--ok)', marginBottom: 8 }}>Applied {done}</p>}
        {all.length > 0 && (
          <>
            <input className="input" style={{ maxWidth: 320, marginBottom: 'var(--sp-3)' }} placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter targets" />
            <ul className="icon-apply-list">
              {shown.map((t) => {
                const key = t.kind === 'service' ? `service:${t.container}` : `stack:${t.id}`;
                return (
                  <li key={key}>
                    <Icon ref={t.icon} name={t.label} size={26} />
                    <span className="grow">
                      <span className="title">{t.label}</span>
                      <span className="sub">
                        {t.kind === 'service' ? `service · ${t.group || 'Other'}` : `stack · ${t.group || 'compose project'}`}
                        {t.icon ? <span className="mono-meta"> · icon {t.icon}</span> : <span className="stale-note"> · derived icon</span>}
                      </span>
                    </span>
                    <StatusDot state={t.kind === 'service' ? 'up' : 'operational'} title={t.kind} />
                    <button className="btn btn-sm" disabled={!chosen || applying === `${t.kind}:${t.label}`} onClick={() => void apply(t)}>
                      {applying === `${t.kind}:${t.label}` ? 'Applying…' : 'Apply'}
                    </button>
                  </li>
                );
              })}
              {!shown.length && <li className="stale-note" style={{ padding: '10px 0' }}>Nothing matches “{filter}”.</li>}
            </ul>
          </>
        )}
        <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
          Widgets do not carry icons in this version — they are typographic by design. Icons applied here appear on the
          Hub launcher, the service page, the stacks list and in search.
        </p>
      </section>
    </>
  );
}
