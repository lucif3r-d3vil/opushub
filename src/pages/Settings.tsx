import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, put, usePolled, useSave } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings, type DeepPartial } from '../lib/theme';
import type { HealthDoc, LayoutDoc, ServicesDoc, SettingsDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { IconPickerModal } from '../components/IconPicker';
import { Menu, type MenuItem, Modal, PageHero, Segmented, Switch } from '../components/ui';

const TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'hub', label: 'Hub' },
  { id: 'services', label: 'Services' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'system', label: 'System' },
];

export default function SettingsPage() {
  const { tab = 'appearance' } = useParams();
  const nav = useNavigate();
  return (
    <>
      <PageHero title="Settings" desc="OpusHub reads config/*.yaml — every change here writes the file it belongs in. Comments survive." />
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <Link key={t.id} to={`/settings/${t.id}`} className={t.id === tab ? 'active' : ''}>{t.label}</Link>
          ))}
          <Link to="/icons" style={{ marginTop: 'var(--sp-4)' }}>Icon browser</Link>
        </nav>
        <div className="settings-pane">
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'hub' && <HubTab />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'bookmarks' && <BookmarksTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'system' && <SystemTab />}
          {!TABS.some((t) => t.id === tab) && (
            <p className="stale-note">Unknown section. <button className="section-link" onClick={() => nav('/settings/appearance')}>Go to Appearance →</button></p>
          )}
        </div>
      </div>
    </>
  );
}

/* ============ row primitives ============ */
function Row({ label, desc, children, tight }: { label: string; desc?: string; children: React.ReactNode; tight?: boolean }) {
  return (
    <div className="form-row" style={tight ? { padding: '10px 0' } : undefined}>
      <div>
        <div className="fr-label">{label}</div>
        {desc && <div className="fr-desc">{desc}</div>}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}
function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--section-gap)' }}>
      <div className="section-head" style={{ marginBottom: 2 }}><h2 className="section-title">{title}</h2><span className="section-aside">{aside}</span></div>
      {children}
    </section>
  );
}

/* ============ Appearance ============ */
const ACCENTS = [
  { id: 'sage', name: 'Sage' }, { id: 'slate', name: 'Slate' }, { id: 'teal', name: 'Teal' },
  { id: 'amber', name: 'Amber' }, { id: 'rose', name: 'Rose' }, { id: 'clay', name: 'Clay' }, { id: 'moss', name: 'Moss' },
];

function AppearanceTab() {
  const { settings, update, resolvedTheme } = useSettings();
  const { data: bgs } = usePolled<{ files: { name: string; url: string }[] }>('/api/backgrounds', 0);
  const a = settings?.appearance;
  const set = useCallback((patch: DeepPartial<SettingsDoc>) => update(patch), [update]);
  if (!settings || !a) return <p className="stale-note">Loading settings…</p>;
  return (
    <>
      <p className="lede">Changes preview instantly and save themselves to <span className="mono-meta">settings.yaml</span>. No restarts.</p>

      <Block title="Theme">
        <Row label="Mode" desc="Auto follows the OS, with a manual cycle from the rail.">
          <Segmented value={a.theme} onChange={(v) => set({ appearance: { theme: v } })} ariaLabel="Theme mode"
            options={[{ value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row label="Accent" desc="One quiet hue for focus, selection and charts.">
          <div className="swatches">
            {ACCENTS.map((c) => (
              <button
                key={c.id} aria-pressed={a.accent === c.id} title={c.name} className="swatch"
                style={{ background: ACCENT_HEX[c.id] }}
                onClick={() => set({ appearance: { accent: c.id as SettingsDoc['appearance']['accent'] } })}
              >
                <span style={{ display: 'none' }}>{c.name}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Density" desc="Compact tightens rows, paddings and body type.">
          <Segmented value={a.density} onChange={(v) => set({ appearance: { density: v } })} ariaLabel="Density"
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Row>
        <Row label="Type scale">
          <input type="range" min={0.9} max={1.2} step={0.05} value={a.fontScale} aria-label="Type scale"
            onChange={(e) => set({ appearance: { fontScale: Number(e.target.value) } })} />
          <span className="mono-meta" style={{ width: 42 }}>{Math.round(a.fontScale * 100)}%</span>
        </Row>
        <Row label="Translucency" desc="Only the rail and overlays — content stays opaque." tight>
          <Switch checked={a.transparency} onChange={(v) => set({ appearance: { transparency: v } })} label="Translucency" />
        </Row>
      </Block>

      <Block title="Background">
        <Row label="Style">
          <Segmented value={a.background.mode} onChange={(v) => set({ appearance: { background: { mode: v } } })} ariaLabel="Background mode"
            options={[{ value: 'quiet', label: 'Quiet' }, { value: 'horizon', label: 'Horizon' }, { value: 'photo', label: 'Photo' }]} />
        </Row>
        {a.background.mode === 'photo' && (
          <>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <div className="bg-tile-grid">
                <button className={`bg-tile ${!a.background.photo ? 'sel' : ''}`} onClick={() => set({ appearance: { background: { photo: null } } })}>
                  <span className="none">None</span>
                </button>
                {(bgs?.files || []).map((f) => (
                  <button
                    key={f.url} className={`bg-tile ${a.background.photo === f.url ? 'sel' : ''}`}
                    style={{ backgroundImage: `url("${f.url}")` }} title={f.name}
                    onClick={() => set({ appearance: { background: { photo: f.url } } })}
                  />
                ))}
              </div>
              <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
                Drop images into <code className="mono-meta">config/backgrounds/</code>, or paste a URL.
              </p>
              <div className="field" style={{ marginTop: 'var(--sp-4)', maxWidth: 420 }}>
                <label htmlFor="bgurl">Background URL</label>
                <input id="bgurl" className="input mono-meta" placeholder="https://… or /user/backgrounds/photo.jpg"
                  defaultValue={a.background.photo || ''}
                  onKeyDown={(e) => { if (e.key === 'Enter') set({ appearance: { background: { photo: (e.target as HTMLInputElement).value.trim() || null } } }); }}
                  onBlur={(e) => { if (e.target.value.trim() !== (a.background.photo || '')) set({ appearance: { background: { photo: e.target.value.trim() || null } } }); }}
                />
              </div>
            </div>
            <Row label="Blur" desc="Applied to the photo so text keeps contrast.">
              <input type="range" min={0} max={48} value={a.background.blur} onChange={(e) => set({ appearance: { background: { blur: Number(e.target.value) } } })} aria-label="Background blur" />
              <span className="mono-meta" style={{ width: 40 }}>{a.background.blur}px</span>
            </Row>
            <Row label="Scrim" desc="Dark (or light) veil between photo and content.">
              <input type="range" min={0} max={100} value={a.background.scrim} onChange={(e) => set({ appearance: { background: { scrim: Number(e.target.value) } } })} aria-label="Background scrim" />
              <span className="mono-meta" style={{ width: 40 }}>{a.background.scrim}%</span>
            </Row>
          </>
        )}
      </Block>

      <Block title="Clock & greeting">
        <Row label="Greeting name" desc="“Good evening, Nora” — leave empty for no name." tight>
          <input className="input" style={{ maxWidth: 220 }} defaultValue={settings.hub.greetingName || ''}
            placeholder="(none)" aria-label="Greeting name"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => update({ hub: { greetingName: e.target.value.trim() || null } })} />
        </Row>
        <Row label="24-hour clock" tight><Switch checked={settings.hub.clock24h} onChange={(v) => update({ hub: { clock24h: v } })} label="24-hour clock" /></Row>
        <Row label="Seconds" desc="Off by default — the clock shouldn't twitch." tight><Switch checked={settings.hub.showSeconds} onChange={(v) => update({ hub: { showSeconds: v } })} label="Show seconds" /></Row>
      </Block>
      <p className="stale-note">Rendering as <b>{resolvedTheme}</b> right now.</p>
    </>
  );
}

/** swatch colors (static hexes for the picker; the real tokens live on html[data-accent]) */
const ACCENT_HEX: Record<string, string> = {
  sage: '#7ea074', slate: '#68809b', teal: '#4e928d', amber: '#c08f43', rose: '#b76b74', clay: '#a3715a', moss: '#7c8f57',
};

/* ============ Hub ============ */
const TEMPLATES: Record<string, { desc: string; layout: LayoutDoc['hub'] }> = {
  Minimal: { desc: 'Overview + services, nothing else', layout: { main: ['overview', 'services'], rail: [], hidden: ['weather', 'markets', 'news', 'bookmarks', 'activity'], sizes: {} } },
  Classic: { desc: 'Balanced home — the default', layout: { main: ['overview', 'services'], rail: ['weather', 'markets', 'news', 'activity'], hidden: ['bookmarks'], sizes: { overview: 'md', services: 'md', weather: 'md', markets: 'md', news: 'md', activity: 'md', bookmarks: 'md' } } },
  Media: { desc: 'Services first, quieter rail', layout: { main: ['services', 'overview'], rail: ['weather', 'activity'], hidden: ['markets', 'news', 'bookmarks'], sizes: { services: 'lg' } } },
  Monitoring: { desc: 'System lead, live rail', layout: { main: ['overview', 'services'], rail: ['activity', 'markets', 'weather'], hidden: ['news', 'bookmarks'], sizes: { activity: 'lg', overview: 'md' } } },
  Information: { desc: 'News and weather up front', layout: { main: ['services'], rail: ['news', 'weather', 'markets', 'bookmarks', 'activity'], hidden: ['overview'], sizes: { news: 'lg' } } },
  Full: { desc: 'Everything visible', layout: { main: ['overview', 'services'], rail: ['weather', 'markets', 'news', 'bookmarks', 'activity'], hidden: [], sizes: { news: 'lg', activity: 'lg', markets: 'lg', bookmarks: 'md', weather: 'md', overview: 'md', services: 'md' } } },
};

function HubTab() {
  const { layout, setLayout } = useLayout();
  const hidden = layout?.hub?.hidden ?? [];
  const allWidgets = ['weather', 'markets', 'news', 'bookmarks', 'activity'];
  if (!layout) return <p className="stale-note">Loading layout…</p>;
  const toggle = (w: string) => setLayout({ hub: { hidden: hidden.includes(w) ? hidden.filter((h) => h !== w) : [...hidden, w] } });
  return (
    <>
      <p className="lede">The Hub is a real page you arrange. Drag anywhere on the Hub to reorder — these controls are the precise version.</p>
      <Block title="Layout templates" aside={<span className="stale-note">presets, then fine-tune as you like</span>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginTop: 'var(--sp-2)' }}>
          {Object.entries(TEMPLATES).map(([name, t]) => (
            <button key={name} className="svc-tile" style={{ padding: 'var(--sp-4)' }} onClick={() => setLayout({ hub: JSON.parse(JSON.stringify(t.layout)) })}>
              <div className="tile-name">{name}</div>
              <div className="tile-app">{t.desc}</div>
            </button>
          ))}
        </div>
      </Block>
      <Block title="Widgets" aside={<span className="stale-note">visible in the right rail of the Hub</span>}>
        {allWidgets.map((w) => (
          <Row key={w} label={w[0].toUpperCase() + w.slice(1)} desc={`Size: ${layout.hub.sizes?.[w] || 'md'}`} tight>
            <Segmented value={(layout.hub.sizes?.[w] || 'md') as 'sm' | 'md' | 'lg'} onChange={(v) => setLayout({ hub: { sizes: { [w]: v } } })} ariaLabel={`${w} size`}
              options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]} />
            <Switch checked={!hidden.includes(w)} onChange={() => toggle(w)} label={`Show ${w}`} />
          </Row>
        ))}
      </Block>
      <Block title="Data sources">
        <SourceRow label="News" path="/api/news" feeds />
        <SourceRow label="Weather" path="/api/weather" />
        <SourceRow label="Markets" path="/api/market" />
      </Block>
    </>
  );
}

function SourceRow({ label, path, feeds = false }: { label: string; path: string; feeds?: boolean }) {
  const { data } = usePolled<{ status: string; reason?: string; items?: unknown[] }>(path, 60_000);
  const s = data?.status;
  const color = s === 'ok' || s === 'partial' ? 'var(--ok)' : s === 'unconfigured' ? 'var(--ink-3)' : 'var(--warn)';
  return (
    <Row label={label} desc={feeds ? (s === 'unconfigured' ? 'No feeds — add some under Integrations.' : `status: ${s}`) : `status: ${s || '…'}`} tight>
      <span style={{ width: 8, height: 8, borderRadius: 9, background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` }} />
      <span className="mono-meta">{s || '…'}</span>
    </Row>
  );
}

/* ============ Services editor ============ */
interface DraftGroup { name: string; description?: string | null; services: ServicesDoc['groups'][number]['services'] }

function ServicesTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { busy, err, okAt, save } = useSave();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  const [editing, setEditing] = useState<{ gi: number; si: number | null } | null>(null);
  const [iconFor, setIconFor] = useState<{ gi: number; si: number } | null>(null);
  const groups = useMemo(() => {
    if (!data) return null;
    if (!draft) return data.groups.map((g) => ({ name: g.name, description: g.description ?? null, services: g.services.map(({ name, app, description, href, icon, container, stack, keywords, meta }) => ({ name, app, description, href, icon, container, stack, keywords, meta })) }));
    return draft;
  }, [data, draft]);
  if (!groups) return <p className="stale-note">Loading services.yaml…</p>;

  const dirty = !!draft;
  const commit = () => save(async () => {
    await put('/api/services', { groups });
    setDraft(null);
  });
  const patchService = (gi: number, si: number, p: Partial<DraftGroup['services'][number]>) =>
    setDraft((d) => {
      const base = (d ?? groups.map((g) => ({ ...g, services: [...g.services] }))) as DraftGroup[];
      const next = structuredClone(base);
      next[gi].services[si] = { ...next[gi].services[si], ...p };
      return next;
    });

  return (
    <>
      <p className="lede">
        Edits write <span className="mono-meta">config/services.yaml</span> — the single source of truth the whole app reads.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {groups.map((g, gi) => (
        <Block
          key={g.name}
          title={g.name}
          aside={
            <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push({ name: 'New service', app: null, description: null, href: null, icon: null, container: null, stack: null, keywords: [], meta: [] }); return next; })}>+ service</button>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.splice(gi, 1); return next; })}>remove group</button>
            </span>
          }
        >
          <ul style={{ listStyle: 'none' }}>
            {g.services.map((s, si) => (
              <li key={s.name + si} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: '9px 0', borderTop: '1px solid var(--hair)' }}>
                <button className="icon-btn" style={{ width: 34, height: 34 }} title="Choose icon" onClick={() => setIconFor({ gi, si })}>
                  <Icon ref={s.icon} name={s.name} size={24} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 570 }}>{s.name} {s.app && <span className="stale-note">· {s.app}</span>}</div>
                  <div className="stale-note" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.href ? <span className="mono-meta">{s.href}</span> : <i>no URL</i>}
                    {s.container ? <span className="mono-meta"> · container {s.container}</span> : null}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => setEditing({ gi, si })}>Edit</button>
                <button className="btn btn-sm" title={`Remove ${s.name}`} onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.splice(si, 1); return next; })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: 14, height: 14 }}><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </li>
            ))}
            {!g.services.length && <li className="stale-note" style={{ padding: '8px 0' }}>empty group</li>}
          </ul>
        </Block>
      ))}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginTop: 'var(--sp-6)' }}>
        <button className="btn" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.push({ name: 'New group', description: null, services: [] }); return next; })}>+ group</button>
        <button className="btn btn-primary" onClick={commit} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save to services.yaml'}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
        {okAt && !dirty && <span className="stale-note" style={{ color: 'var(--ok)' }}>saved {relTime(okAt)}</span>}
      </div>

      {editing && groups[editing.gi] && (
        <ServiceEditor
          group={groups[editing.gi].name}
          svc={groups[editing.gi].services[editing.si!]}
          isNew={editing.si === null}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            const { gi, si } = editing;
            if (si != null) patchService(gi, si, patch);
            else setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push(patch as DraftGroup['services'][number]); return next; });
            setEditing(null);
          }}
        />
      )}
      {iconFor && (
        <IconPickerModal
          initial={groups[iconFor.gi]?.services[iconFor.si]?.icon ?? null}
          onPick={(ref) => patchService(iconFor.gi, iconFor.si, { icon: ref })}
          onClose={() => setIconFor(null)}
        />
      )}
    </>
  );
}

function ServiceEditor({ group, svc, onSave, onClose }: { group: string; svc: DraftGroup['services'][number]; isNew: boolean; onSave: (p: Partial<DraftGroup['services'][number]>) => void; onClose: () => void }) {
  const [form, setForm] = useState({ ...svc, keywordsText: svc.keywords.join(', '), metaText: svc.meta.map((m) => `${m.label}: ${m.value}`).join('\n') });
  const f = (k: string, v: unknown) => setForm((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={`${svc.name || 'New service'} — ${group}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => {
            onSave({
              name: form.name.trim(), app: form.app?.trim() || null, description: form.description?.trim() || null,
              href: form.href?.trim() || null, icon: form.icon ?? null, container: form.container?.trim() || null, stack: form.stack?.trim() || null,
              keywords: form.keywordsText.split(',').map((x: string) => x.trim()).filter(Boolean),
              meta: form.metaText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [label, ...rest] = l.split(/[:=]\s*/); return { label: label.trim(), value: rest.join(': ').trim() }; }),
            });
          }}>Apply</button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => f('name', e.target.value)} /></div>
        <div className="field"><label>App / software</label><input className="input" value={form.app || ''} onChange={(e) => f('app', e.target.value)} placeholder="Jellyfin" /></div>
      </div>
      <div className="field"><label>Description</label><input className="input" value={form.description || ''} onChange={(e) => f('description', e.target.value)} /></div>
      <div className="field"><label>URL</label><input className="input mono-meta" value={form.href || ''} onChange={(e) => f('href', e.target.value)} placeholder="http://stream.opusgrid.local:8096" /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Docker container <span className="hint">(for live status/stats)</span></label><input className="input mono-meta" value={form.container || ''} onChange={(e) => f('container', e.target.value)} placeholder="jellyfin" /></div>
        <div className="field"><label>Stack</label><input className="input" value={form.stack || ''} onChange={(e) => f('stack', e.target.value)} placeholder="Media" /></div>
      </div>
      <div className="field"><label>Keywords (comma separated)</label><input className="input" value={form.keywordsText} onChange={(e) => f('keywordsText', e.target.value)} /></div>
      <div className="field"><label>Notes / meta — one per line as <span className="mono-meta">Label: value</span></label><textarea className="textarea" rows={3} value={form.metaText} onChange={(e) => f('metaText', e.target.value)} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
        <Icon ref={form.icon} name={form.name || 'svc'} size={40} />
        <span className="stale-note">current icon — change it from the list</span>
      </div>
    </Modal>
  );
}

/* ============ Bookmarks ============ */
interface BmGroup { name: string; items: { name: string; href: string; description?: string | null }[] }
function BookmarksTab() {
  const { data } = usePolled<{ groups: BmGroup[] }>('/api/bookmarks', 0);
  const { busy, err, save } = useSave();
  const [draft, setDraft] = useState<BmGroup[] | null>(null);
  const groups = draft ?? data?.groups ?? [];
  if (!data && !draft) return <p className="stale-note">Loading bookmarks…</p>;
  return (
    <>
      <p className="lede">Flat links, no icons machinery, no status. They appear in search and can be shown on the Hub later.</p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {groups.map((g, gi) => (
        <Block key={g.name + gi} title={g.name} aside={
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-quiet btn-sm" onClick={() => setDraft(cloneAt(groups, (d) => d[gi].items.push({ name: 'New', href: 'https://' })))}>+ link</button>
            <button className="btn btn-quiet btn-sm" onClick={() => setDraft(cloneAt(groups, (d) => d.splice(gi, 1)))}>remove</button>
          </span>
        }>
          <ul style={{ listStyle: 'none' }}>
            {g.items.map((b, bi) => (
              <li key={bi} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto auto', gap: 'var(--sp-3)', alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--hair)' }}>
                <input className="input" value={b.name} onChange={(e) => setDraft(cloneAt(groups, (d) => { d[gi].items[bi].name = e.target.value; }))} aria-label="Bookmark name" />
                <input className="input mono-meta" value={b.href} onChange={(e) => setDraft(cloneAt(groups, (d) => { d[gi].items[bi].href = e.target.value; }))} aria-label="Bookmark URL" />
                <button className="btn btn-quiet btn-sm" onClick={() => { window.open(b.href, '_blank', 'noreferrer'); }}>Open</button>
                <button className="icon-btn" aria-label="Remove" onClick={() => setDraft(cloneAt(groups, (d) => d[gi].items.splice(bi, 1)))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </li>
            ))}
            {!g.items.length && <li className="stale-note" style={{ padding: 8 }}>no links here yet</li>}
          </ul>
        </Block>
      ))}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-6)' }}>
        <button className="btn" onClick={() => setDraft(cloneAt(groups, (d) => d.push({ name: 'New group', items: [] })))}>+ group</button>
        <button className="btn btn-primary" disabled={!draft || busy} onClick={async () => { await save(async () => { await put('/api/bookmarks', { groups }); setDraft(null); }); }}>Save bookmarks.yaml</button>
        {draft && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
      </div>
    </>
  );
}
function cloneAt<T>(arr: T[], mutate: (copy: T[]) => void): T[] { const c = structuredClone(arr); mutate(c); return c; }

/* ============ Integrations ============ */
const FEED_SUGGESTIONS = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/selfhosted', url: 'https://www.reddit.com/r/selfhosted.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];
const SYMBOL_SUGGESTIONS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'RELIANCE.NS', 'TCS.NS', '^NSEI', '^NIFTYSMLCAP'];

function IntegrationsTab() {
  const { settings, update } = useSettings();
  const intg = settings?.integrations;
  if (!settings || !intg) return <p className="stale-note">Loading…</p>;
  const [feedUrl, setFeedUrl] = useState('');
  const [sym, setSym] = useState('');
  const feeds = intg.news.feeds || [];
  const symbols = intg.markets.symbols || [];
  return (
    <>
      <p className="lede">Everything here is user configuration — OpusHub ships no defaults and never invents values. Each widget shows its real provider state.</p>

      <Block title="News" aside={<Link className="section-link" to="/">test it on the Hub →</Link>}>
        <div className="editor-list">
          {feeds.map((f, i) => (
            <div className="editor-item" key={i}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontWeight: 560 }}>{f.name || URLSafe(f.url)}</b>
                <div className="stale-note mono-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.url}</div>
              </span>
              <button className="icon-btn" aria-label="Remove feed" onClick={() => update({ integrations: { news: { feeds: feeds.filter((_, j) => j !== i) } } })}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
          {!feeds.length && <div className="editor-item stale-note">No feeds yet.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <input className="input" style={{ flex: 1 }} placeholder="https://example.com/feed.xml" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} aria-label="Feed URL" />
          <button className="btn" disabled={!feedUrl.trim()} onClick={() => { update({ integrations: { news: { feeds: [...feeds, { url: feedUrl.trim(), name: null }] } } }, true); setFeedUrl(''); }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {FEED_SUGGESTIONS.filter((s) => !feeds.some((f) => f.url === s.url)).map((s) => (
            <button key={s.url} className="chip" onClick={() => update({ integrations: { news: { feeds: [...feeds, s] } } }, true)}>+ {s.name}</button>
          ))}
        </div>
      </Block>

      <Block title="Weather">
        <Row label="Location" desc="City name or explicit coordinates — used with Open-Meteo (keyless)." tight>
          <input className="input" style={{ width: 240 }} defaultValue={intg.weather.location || ''} placeholder="Amsterdam" aria-label="Weather location"
            onBlur={(e) => update({ integrations: { weather: { location: e.target.value.trim() || null } } }, true)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </Row>
        <Row label="Units" tight>
          <Segmented value={intg.weather.units} onChange={(v) => update({ integrations: { weather: { units: v } } }, true)} ariaLabel="Units"
            options={[{ value: 'c', label: '°C' }, { value: 'f', label: '°F' }]} />
        </Row>
      </Block>

      <Block title="Markets" aside={<span className="stale-note">Stooq symbol syntax — bare tickers assume US, use <code>.NS</code> for NSE</span>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
          {symbols.map((s, i) => (
            <span className="chip" key={s}>
              {s}
              <button className="x" aria-label={`Remove ${s}`} onClick={() => update({ integrations: { markets: { symbols: symbols.filter((_, j) => j !== i) } } }, true)}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </span>
          ))}
          {!symbols.length && <span className="stale-note">No symbols configured.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ width: 200 }} placeholder="AAPL, RELIANCE.NS…" value={sym} onChange={(e) => setSym(e.target.value)} aria-label="Add symbol" />
          <button className="btn" disabled={!sym.trim()} onClick={() => {
            const add = sym.toUpperCase().split(/[,\s]+/).filter(Boolean).filter((x) => !symbols.includes(x));
            if (add.length) update({ integrations: { markets: { symbols: [...symbols, ...add] } } }, true);
            setSym('');
          }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {SYMBOL_SUGGESTIONS.filter((s) => !symbols.includes(s)).map((s) => (
            <button key={s} className="chip" onClick={() => update({ integrations: { markets: { symbols: [...symbols, s] } } }, true)}>+ {s}</button>
          ))}
        </div>
      </Block>
    </>
  );
}
function URLSafe(u: string) { try { return new URL(u).host; } catch { return u.slice(0, 30); } }

/* ============ System ============ */
function SystemTab() {
  const { settings, update } = useSettings();
  const { data: health } = usePolled<HealthDoc>('/api/health', 0);
  const { data: custom } = usePolled<{ cssEnabled: boolean; jsEnabled: boolean; css: string | null; jsPresent: boolean }>('/api/custom', 0);
  const { save, busy, err } = useSave();
  const [cssText, setCssText] = useState<string | null>(null);
  return (
    <>
      <p className="lede">Where OpusHub is plugged in. All paths are resolved at startup and logged on the server.</p>
      <Block title="Configuration">
        <Row label="Config directory" tight><span className="mono-meta">{health?.configDir || '…'}</span></Row>
        <Row label="Data directory" tight><span className="mono-meta">{health?.dataDir || '…'}</span></Row>
        <Row
          label=".env discovery"
          desc="Order: $OPUSHUB_ENV_FILE → config/.env → ./.env → $HOMEPAGE_DIR/.env → /app/config/.env. First hit wins; real env vars always beat files. Values never reach the browser."
        >
          <span className="mono-meta">
            {health?.env.files.length
              ? health.env.files.map((f) => `${f.file.split('/').slice(-2).join('/')} (${f.keys.length} key${f.keys.length === 1 ? '' : 's'}${f.error ? ' — ' + f.error : ''})`).join(' · ')
              : 'none found — keys fall through to process.env only'}
          </span>
        </Row>
        <Row label="Docker engine" tight>
          <span className="mono-meta" style={{ color: health?.providers.docker.ok ? 'var(--ok)' : 'var(--ink-3)' }}>
            {health?.providers.docker.ok ? `connected · engine ${health.providers.docker.version}` : health?.providers.docker.reason || '…'}
          </span>
        </Row>
        <Row label="Runtime" tight><span className="mono-meta">OpusHub {health?.version || '0.1'} · node {health?.node || '…'} · {health?.platform || ''}</span></Row>
      </Block>

      <Block title="Behavior">
        <Row label="Log service launches" desc="Adds an Activity event when you open a service from OpusHub." tight>
          <Switch checked={settings?.behavior.logLaunches ?? true} onChange={(v) => update({ behavior: { logLaunches: v } }, true)} label="Log launches" />
        </Row>
        <Row label="System refresh" desc="Seconds between host metric polls." tight>
          <input type="number" min={2} max={300} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.system}
            onBlur={(e) => update({ behavior: { refresh: { system: Math.max(2, Number(e.target.value) || 5) } } }, true)} aria-label="System refresh seconds" />
        </Row>
        <Row label="Services refresh" desc="Containers are polled gently — Docker API calls are not free." tight>
          <input type="number" min={5} max={600} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.services}
            onBlur={(e) => update({ behavior: { refresh: { services: Math.max(5, Number(e.target.value) || 30) } } }, true)} aria-label="Services refresh seconds" />
        </Row>
      </Block>

      <Block title="Custom CSS & JS" aside={<span className="stale-note">files live next to services.yaml</span>}>
        <Row label="theme.css" desc="Homepage-style custom CSS. Linked into every page when enabled." tight>
          <Switch checked={custom?.cssEnabled ?? false} onChange={(v) => update({ advanced: { customCss: v } }, true)} label="Enable custom CSS" />
        </Row>
        <Row label="app.js" desc="Custom JS, same-origin. Enable deliberately — it runs on every page." tight>
          <Switch checked={custom?.jsEnabled ?? false} onChange={(v) => update({ advanced: { customJs: v } }, true)} label="Enable custom JS" />
        </Row>
        {(custom?.cssEnabled) && (
          <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
            <label>config/theme.css</label>
            <textarea className="textarea" rows={8} value={cssText ?? custom?.css ?? ''} onChange={(e) => setCssText(e.target.value)} />
            <span>
              <button className="btn btn-sm" disabled={busy} onClick={() => save(async () => { await put('/api/custom', { css: cssText ?? '' }); setCssText(null); })}>{busy ? 'Saving…' : 'Save theme.css'}</button>
              {err && <span className="stale-note" style={{ color: 'var(--fail)', marginLeft: 10 }}>{err}</span>}
            </span>
          </div>
        )}
      </Block>
    </>
  );
}


