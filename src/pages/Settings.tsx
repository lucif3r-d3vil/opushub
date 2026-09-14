import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidateShared, post, put, usePolled, useSave } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings, type DeepPartial } from '../lib/theme';
import type {
  DiscoveryDoc, HealthDoc, LayoutDoc, ProvidersDoc, Service, ServicesDoc, SettingsDoc, StacksDoc, TemplateEntry,
  TemplatesDoc, WidgetCatalogueEntry, WidgetDoc, WidgetInstance, WidgetZone,
} from '../lib/types';
import { Icon } from '../components/Icon';
import { IconPickerModal } from '../components/IconPicker';
import { Menu, type MenuItem, Modal, PageHero, ProviderNote, Segmented, StatusLine, Switch } from '../components/ui';
import { Sortable } from '../components/Sortable';
import { HubPreview } from '../components/hub/HubPreview';
import {
  addWidget, configSummary, hiddenWidgets, moveWidget, removeWidget, setSpacing, setWidget, visibleInZone,
} from '../lib/hubLayout';
import {
  assignGroup, clearGroup, ensureOverlay, overlayFromInventory, removeEntry, removeGroup, renameGroup,
  saveOverlay, setGroupDescription, setIcon, type DraftGroup, type DraftService,
} from '../lib/overlay';

const TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'background', label: 'Background' },
  { id: 'hub', label: 'Hub layout' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'templates', label: 'Templates' },
  { id: 'services', label: 'Services' },
  { id: 'groups', label: 'Groups' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'system', label: 'System' },
  { id: 'advanced', label: 'Advanced' },
];

/** Tabs where seeing the result is the point. */
const PREVIEW_TABS = new Set(['appearance', 'background', 'hub', 'widgets', 'templates']);

export default function SettingsPage() {
  const { tab = 'appearance' } = useParams();
  const nav = useNavigate();
  const [previewTemplate, setPreviewTemplate] = useState<TemplateEntry | null>(null);
  const { layout } = useLayout();
  const showPreview = PREVIEW_TABS.has(tab);

  return (
    <>
      <PageHero
        title="Settings"
        desc="Everything here is presentation: OpusHub reads your infrastructure and never writes to it. Changes save themselves to config/*.yaml as you make them."
      />
      <div className={`settings-grid${showPreview ? ' settings-grid--preview' : ''}`}>
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <Link key={t.id} to={`/settings/${t.id}`} className={t.id === tab ? 'active' : ''}>{t.label}</Link>
          ))}
          <Link to="/icons" style={{ marginTop: 'var(--sp-4)' }}>Icon browser</Link>
        </nav>
        <div className="settings-pane">
          {showPreview && (
            <div className="settings-preview">
              <HubPreview
                layout={previewTemplate ? previewTemplate.preview : layout}
                label={previewTemplate ? `previewing “${previewTemplate.name}” — not applied yet` : 'updates as you change settings'}
                height={400}
              />
              {previewTemplate && (
                <button className="btn btn-quiet btn-sm settings-preview-clear" onClick={() => setPreviewTemplate(null)}>
                  Stop previewing “{previewTemplate.name}”
                </button>
              )}
            </div>
          )}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'background' && <BackgroundTab />}
          {tab === 'hub' && <HubTab />}
          {tab === 'widgets' && <WidgetsTab />}
          {tab === 'templates' && <TemplatesTab onPreview={setPreviewTemplate} />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'groups' && <GroupsTab />}
          {tab === 'bookmarks' && <BookmarksTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'system' && <SystemTab />}
          {tab === 'advanced' && <AdvancedTab />}
          {!TABS.some((t) => t.id === tab) && (
            <p className="stale-note">Unknown section. <button className="section-link" onClick={() => nav('/settings/appearance')}>Go to Appearance →</button></p>
          )}
        </div>
      </div>
    </>
  );
}

/* ============ row primitives ============ */
function Row({ label, desc, children, tight }: { label: string; desc?: string; children: ReactNode; tight?: boolean }) {
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
function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
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
const ACCENT_HEX: Record<string, string> = {
  sage: '#7ea074', slate: '#68809b', teal: '#4e928d', amber: '#c08f43', rose: '#b76b74', clay: '#a3715a', moss: '#7c8f57',
};

function AppearanceTab() {
  const { settings, update, resolvedTheme } = useSettings();
  const a = settings?.appearance;
  const set = useCallback((patch: DeepPartial<SettingsDoc>) => update(patch), [update]);
  if (!settings || !a) return <p className="stale-note">Loading settings…</p>;
  return (
    <>
      <Block title="Theme">
        <Row label="Mode" desc="Auto follows the OS; the rail button cycles it too.">
          <Segmented value={a.theme} onChange={(v) => set({ appearance: { theme: v } })} ariaLabel="Theme mode"
            options={[{ value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row label="Accent" desc="One quiet hue: focus, selection, charts.">
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
      <p className="stale-note">Rendering as <b>{resolvedTheme}</b> right now.</p>
    </>
  );
}

/* ============ Background ============ */
function BackgroundTab() {
  const { settings, update } = useSettings();
  const { data: bgs } = usePolled<{ files: { name: string; url: string }[] }>('/api/backgrounds', 0);
  const a = settings?.appearance;
  const set = (patch: DeepPartial<SettingsDoc>) => update(patch);
  if (!settings || !a) return <p className="stale-note">Loading settings…</p>;
  return (
    <>
      <Block title="Background">
        <Row label="Style" desc="Quiet is flat. Horizon is one muted ramp. Photo uses your own image behind an automatic scrim.">
          <Segmented value={a.background.mode} onChange={(v) => set({ appearance: { background: { mode: v } } })} ariaLabel="Background mode"
            options={[{ value: 'quiet', label: 'Quiet' }, { value: 'horizon', label: 'Horizon' }, { value: 'photo', label: 'Photo' }]} />
        </Row>
      </Block>
      {a.background.mode === 'photo' && (
        <Block title="Image">
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
          <Row label="Blur" desc="Applied to the photo so text keeps its contrast.">
            <input type="range" min={0} max={48} value={a.background.blur} onChange={(e) => set({ appearance: { background: { blur: Number(e.target.value) } } })} aria-label="Background blur" />
            <span className="mono-meta" style={{ width: 40 }}>{a.background.blur}px</span>
          </Row>
          <Row label="Scrim" desc="Veil between photo and content. Below 45% the preview will tell you what it costs.">
            <input type="range" min={0} max={100} value={a.background.scrim} onChange={(e) => set({ appearance: { background: { scrim: Number(e.target.value) } } })} aria-label="Background scrim" />
            <span className="mono-meta" style={{ width: 40 }}>{a.background.scrim}%</span>
          </Row>
        </Block>
      )}
      <p className="stale-note">The preview above uses the same background layer as the Hub — what you see is what `/` renders.</p>
    </>
  );
}

/* ============ Hub layout ============ */
function HubTab() {
  const { settings, update } = useSettings();
  const { layout, setLayout, resetLayout } = useLayout();
  if (!settings || !layout) return <p className="stale-note">Loading…</p>;
  return (
    <>
      <Block title="Greeting">
        <Row label="Name" desc="“Good evening, Nora.” Leave it empty for a greeting with no name — nothing is assumed about you.">
          <input className="input" style={{ maxWidth: 220 }} defaultValue={settings.hub.greetingName || ''}
            placeholder="(none)" aria-label="Greeting name"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => update({ hub: { greetingName: e.target.value.trim() || null } })} />
        </Row>
        <Row label="24-hour clock" tight><Switch checked={settings.hub.clock24h} onChange={(v) => update({ hub: { clock24h: v } })} label="24-hour clock" /></Row>
        <Row label="Seconds" desc="Off by default — the clock shouldn’t twitch." tight>
          <Switch checked={settings.hub.showSeconds} onChange={(v) => update({ hub: { showSeconds: v } })} label="Show seconds" />
        </Row>
      </Block>

      <Block title="Rhythm" aside={<span className="stale-note">the air between sections</span>}>
        <Row label="Spacing" desc="Templates set this too; change it here to fine-tune.">
          <Segmented value={layout.hub.spacing} onChange={(v) => setLayout({ hub: { spacing: v } })} ariaLabel="Hub spacing"
            options={[{ value: 'cozy', label: 'Cozy' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'airy', label: 'Airy' }]} />
        </Row>
        <Row label="Composition" desc={`${visibleInZone(layout, 'main').length} widget(s) in the main column · ${visibleInZone(layout, 'rail').length} in the sidebar · ${hiddenWidgets(layout).length} hidden`}>
          <Link className="btn btn-sm" to="/settings/widgets">Arrange widgets</Link>
          <Link className="btn btn-sm" to="/settings/templates">Templates</Link>
        </Row>
        <Row label="First-run banner" desc="Shown until Docker answers or you dismiss it." tight>
          <Switch checked={!layout.hub.setupDismissed} onChange={(v) => setLayout({ hub: { setupDismissed: !v } })} label="Show first-run banner" />
        </Row>
      </Block>

      <Block title="Reset">
        <Row label="Hub composition" desc="Back to the default arrangement. Services, overlays and settings are untouched." tight>
          <button className="btn btn-sm" onClick={() => void resetLayout()}>Reset layout</button>
        </Row>
      </Block>
    </>
  );
}

/* ============ Widgets ============ */
function WidgetsTab() {
  const { layout, setLayout, resetLayout } = useLayout();
  const { data } = usePolled<WidgetDoc>('/api/widgets', 0);
  const [configFor, setConfigFor] = useState<WidgetInstance | null>(null);
  const catalogue = data?.catalogue ?? [];
  const widgets = layout?.hub.widgets ?? [];
  const missing = catalogue.filter((c) => !widgets.some((w) => w.type === c.type));
  // the catalogue's own organisation; a client newer than the server still renders ungrouped
  const categories = data?.categories ?? [{ id: 'grid', label: 'Widgets', description: '' }];
  const categoryLabel = (id: string) => categories.find((c) => c.id === id)?.label || id;

  const entries = useMemo(() => new Map(catalogue.map((c) => [c.type, c])), [catalogue]);
  if (!layout) return <p className="stale-note">Loading layout…</p>;

  const zoneBlock = (zone: WidgetZone) => {
    const list = widgets.filter((w) => w.zone === zone);
    const ids = list.map((w) => w.id);
    const render = (id: string, handle?: ReactNode) => {
      const w = widgets.find((x) => x.id === id);
      if (!w) return null;
      const entry = entries.get(w.type);
      return (
        <div className="widget-row" id={`w-${w.id}`} key={w.id}>
          {handle}
          <span className="widget-row-main">
            <span className="widget-row-title">{w.title || entry?.title || w.type}</span>
            <span className="widget-row-sub">
              {entry?.description || w.type}
              {entry?.category && <span className="mono-meta"> · {categoryLabel(entry.category)}</span>}
              {configSummary(w) && <span className="mono-meta"> · {configSummary(w)}</span>}
            </span>
          </span>
          {w.visible === false && <span className="chip">hidden</span>}
          <span className="widget-row-actions">
            {entry && entry.sizes.length > 1 && (
              <Segmented value={w.size} onChange={(v) => setLayout({ hub: { widgets: setWidget(layout, w.id, { size: v }).hub.widgets } })} ariaLabel={`${w.title || entry.title} size`}
                options={entry.sizes.map((s) => ({ value: s, label: s.toUpperCase() }))} />
            )}
            <Segmented value={w.zone} onChange={(v) => setLayout({ hub: { widgets: moveWidget(layout, w.id, v).hub.widgets } })} ariaLabel={`${w.title || entry?.title} column`}
              options={[{ value: 'main' as const, label: 'Main' }, { value: 'rail' as const, label: 'Sidebar' }]} />
            <Switch checked={w.visible !== false} onChange={(v) => setLayout({ hub: { widgets: setWidget(layout, w.id, { visible: v }).hub.widgets } })} label={`Show ${w.title || w.type}`} />
            {entry?.config.length ? (
              <button className="btn btn-sm" onClick={() => setConfigFor(w)}>Configure</button>
            ) : null}
            <button className="icon-btn" aria-label={`Remove ${w.title || w.type}`} title="Remove from the Hub"
              onClick={() => setLayout({ hub: { widgets: removeWidget(layout, w.id).hub.widgets } })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
            </button>
          </span>
        </div>
      );
    };
    return (
      <Block key={zone} title={zone === 'main' ? 'Main column' : 'Sidebar'}
        aside={<span className="stale-note">{list.filter((w) => w.visible !== false).length} visible</span>}>
        {ids.length === 0 ? (
          <p className="stale-note" style={{ padding: '10px 0' }}>Nothing here yet.</p>
        ) : (
          <Sortable
            ids={ids}
            className="widget-rows"
            onReorder={(next) => setLayout({ hub: { widgets: reorderWidgets(layout, zone, next) } })}
            renderItem={(id, ctx) => render(id, ctx.handle)}
          />
        )}
      </Block>
    );
  };

  return (
    <>
      <p className="lede">
        Widgets are the Hub’s blocks. Reorder them by dragging, move them between columns, resize where a
        smaller or larger form makes sense — everything here is layout, never infrastructure.
      </p>
      {zoneBlock('main')}
      {zoneBlock('rail')}

      <Block title="Add a widget" aside={<span className="stale-note">{missing.length} type{missing.length === 1 ? '' : 's'} not on the Hub</span>}>
        {categories.map((cat) => {
          const inCat = missing.filter((c) => (c.category || 'grid') === cat.id);
          if (!inCat.length) return null;
          return (
            <div className="widget-cat" key={cat.id}>
              <div className="widget-cat-head">
                <span className="micro-label">{cat.label}</span>
                <span className="stale-note">{cat.description}</span>
              </div>
              <div className="widget-add">
                {inCat.map((c) => (
                  <button key={c.type} className="widget-add-item" onClick={() => setLayout({ hub: { widgets: addWidget(layout, c).hub.widgets } })}>
                    <span className="wa-title">+ {c.title}</span>
                    <span className="wa-desc">{c.description}</span>
                    <span className="wa-zone">default: {c.zone === 'main' ? 'main column' : 'sidebar'}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!missing.length && <p className="stale-note">Every widget type this build has is already on the Hub. You can add duplicates of a type — say, two clocks for two timezones — from the menu below.</p>}
        <details className="tech" style={{ marginTop: 'var(--sp-3)' }}>
          <summary className="stale-note">Add a duplicate of a type already in use</summary>
          <div className="widget-add" style={{ marginTop: 10 }}>
            {catalogue.map((c) => (
              <button key={c.type} className="widget-add-item" onClick={() => setLayout({ hub: { widgets: addWidget(layout, c).hub.widgets } })}>
                <span className="wa-title">+ {c.title}</span>
                <span className="wa-desc">{c.description}</span>
              </button>
            ))}
          </div>
        </details>
      </Block>

      <Block title="Defaults">
        <Row label="Reset the composition" desc="Back to the balanced default arrangement. Services and settings are untouched." tight>
          <button className="btn btn-sm" onClick={() => void resetLayout()}>Reset layout</button>
        </Row>
      </Block>

      {configFor && (
        <WidgetConfigModal
          widget={configFor}
          entry={entries.get(configFor.type) || null}
          onClose={() => setConfigFor(null)}
          onSave={(config) => {
            setLayout({ hub: { widgets: setWidget(layout, configFor.id, { config }).hub.widgets } });
            setConfigFor(null);
          }}
        />
      )}
    </>
  );
}

/** Reorder visible widgets of one zone; hidden ones keep their slots (same rule as the Hub). */
function reorderWidgets(layout: LayoutDoc, zone: WidgetZone, orderedVisibleIds: string[]): WidgetInstance[] {
  const queue = [...orderedVisibleIds];
  const out: WidgetInstance[] = [];
  for (const w of layout.hub.widgets) {
    if (w.zone !== zone || w.visible === false) { out.push(w); continue; }
    const next = queue.shift();
    out.push(next ? layout.hub.widgets.find((x) => x.id === next) || w : w);
  }
  for (const id of queue) {
    const w = layout.hub.widgets.find((x) => x.id === id);
    if (w) out.push(w);
  }
  return out;
}

function WidgetConfigModal({ widget, entry, onSave, onClose }: {
  widget: WidgetInstance;
  entry: WidgetCatalogueEntry | null;
  onSave: (config: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>({ ...widget.config });
  const { data: services } = usePolled<ServicesDoc>('/api/services', 0);
  const groupNames = (services?.groups || []).map((g) => g.name);
  const fields = entry?.config || [];
  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  return (
    <Modal
      title={`${widget.title || entry?.title || widget.type} — configuration`}
      onClose={onClose}
      footer={<>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onSave(config)}>Save widget</button>
      </>}
    >
      {!fields.length && <p className="stale-note">This widget has no configuration — its content follows the engine.</p>}
      {fields.map((f) => {
        const value = config[f.key];
        if (f.type === 'group-list') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          if (!groupNames.length) return <p className="stale-note" key={f.key}>No groups discovered on this engine yet.</p>;
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {groupNames.map((g) => (
                  <button key={g} className="chip" aria-pressed={chosen.includes(g)}
                    style={chosen.includes(g) ? { borderColor: 'var(--accent)', color: 'var(--ink)' } : undefined}
                    onClick={() => set(f.key, chosen.includes(g) ? chosen.filter((x) => x !== g) : [...chosen, g])}>
                    {g}
                  </button>
                ))}
              </div>
              <span className="hint">{f.hint || 'Leave empty for every group.'}</span>
            </div>
          );
        }
        if (f.type === 'list') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(f.options || []).map((o) => (
                  <button key={o} className="chip" aria-pressed={chosen.includes(o)}
                    style={chosen.includes(o) ? { borderColor: 'var(--accent)', color: 'var(--ink)' } : undefined}
                    onClick={() => set(f.key, chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])}>
                    {o}
                  </button>
                ))}
              </div>
              <span className="hint">{f.hint || 'Leave empty for all sources.'}</span>
            </div>
          );
        }
        if (f.type === 'boolean') {
          return (
            <Row key={f.key} label={f.label} desc={f.hint} tight>
              <Switch checked={value === true} onChange={(v) => set(f.key, v)} label={f.label} />
            </Row>
          );
        }
        return (
          <div className="field" key={f.key}>
            <label>{f.label}</label>
            <input className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => set(f.key, e.target.value)} />
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        );
      })}
    </Modal>
  );
}

/* ============ Templates ============ */
function TemplatesTab({ onPreview }: { onPreview: (t: TemplateEntry | null) => void }) {
  const { layout, reload } = useLayout();
  const { data, loading } = usePolled<TemplatesDoc>('/api/templates', 0);
  const { busy, err, save } = useSave();
  const [applied, setApplied] = useState<string | null>(null);
  const templates = data?.templates || [];
  const currentSpacing = layout?.hub.spacing;

  return (
    <>
      <p className="lede">
        Templates are <b>arrangements</b>. They decide which widgets show, where they sit and how much air the page
        gets. They never install, create or rename anything — applying one to a system with no media containers
        simply leaves that ordering unused.
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {loading && !templates.length && <p className="stale-note">Reading templates…</p>}
      <div className="tpl-grid">
        {templates.map((t) => {
          const matches = t.spacing === currentSpacing;
          return (
            <article className="tpl" key={t.id}>
              <header>
                <h3>{t.name}</h3>
                <p className="tpl-tagline">{t.tagline}</p>
              </header>
              <p className="tpl-desc">{t.description}</p>
              <div className="tpl-widgets">
                {t.widgets.map((w) => (
                  <span className="tpl-widget" key={w.id}>
                    <span className="tpl-widget-zone">{w.zone === 'main' ? '▤' : '▎'}</span>
                    {w.title}
                  </span>
                ))}
              </div>
              {(t.groupPriority?.length ?? 0) > 0 && (
                <p className="stale-note">
                  Prefers {t.groupPriority.join(' › ')}
                  {(t.unmatchedGroups?.length ?? 0) > 0 && <> · not on this system: {t.unmatchedGroups.join(', ')} (ignored)</>}
                </p>
              )}
              <footer>
                <button className="btn btn-sm" onMouseEnter={() => onPreview(t)} onFocus={() => onPreview(t)} onMouseLeave={() => onPreview(null)} onClick={() => onPreview(t)}>
                  Preview
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => save(async () => {
                    await post('/api/layout/template', { id: t.id });
                    invalidateShared('/api/layout');
                    await reload();
                    onPreview(null);
                    setApplied(t.id);
                  })}
                >
                  {applied === t.id ? 'Applied' : 'Apply'}
                </button>
                {matches && <span className="stale-note">matches your spacing</span>}
              </footer>
            </article>
          );
        })}
      </div>
      <p className="stale-note" style={{ marginTop: 'var(--sp-5)' }}>
        Applying keeps your service ordering, hidden groups and first-run dismissal — a template only rearranges the page.
      </p>
    </>
  );
}

/* ============ Services overlay editor ============ */
/**
 * What this editor edits is *presentation*, not infrastructure: an entry here can rename, file,
 * icon, order, hide, or re-URL a container that Docker actually reports. It cannot create one —
 * entries that match no container are listed under "unmatched" so they are fixable, not silent.
 */
function ServicesTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { busy, err, okAt, save } = useSave();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  const [editing, setEditing] = useState<{ gi: number; si: number | null } | null>(null);
  const [iconFor, setIconFor] = useState<{ gi: number; si: number } | null>(null);
  const inventory = useMemo(() => data?.services ?? [], [data]);
  const bound = useMemo(() => new Set(inventory.filter((s) => s.configured).map((s) => s.name)), [inventory]);
  const groups = useMemo<DraftGroup[] | null>(() => draft ?? (data ? overlayFromInventory(data) : null), [draft, data]);

  // ?container=<name> — "Customize" from the Hub lands straight in the editor for that service
  const focus = params.get('container');
  useEffect(() => {
    if (!focus || !data || draft) return;
    const svc = inventory.find((s) => s.name === focus);
    if (!svc) return;
    const base = overlayFromInventory(data);
    const has = base.some((g) => g.services.some((s) => s.container === svc.name));
    const withEntry = has ? base : ensureOverlay(base, svc);
    setDraft(withEntry);
    const gi = withEntry.findIndex((g) => g.services.some((s) => s.container === svc.name));
    const si = withEntry[gi]?.services.findIndex((s) => s.container === svc.name) ?? -1;
    if (gi >= 0 && si >= 0) setEditing({ gi, si });
    params.delete('container');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, data]);

  if (!groups) return <p className="stale-note">Loading services.yaml…</p>;

  const dirty = !!draft;
  const commit = () => save(async () => { await saveOverlay(groups); setDraft(null); });
  const patchService = (gi: number, si: number, p: Partial<DraftService>) =>
    setDraft((d) => {
      const next = structuredClone((d ?? groups) as DraftGroup[]);
      next[gi].services[si] = { ...next[gi].services[si], ...p };
      return next;
    });
  const unbound = inventory.filter((s) => !bound.has(s.name) && !s.hidden);
  const unmatched = (data?.unmatched ?? []).filter((u) => u.kind === 'service');

  return (
    <>
      <p className="lede">
        Docker decides what exists; <span className="mono-meta">config/services.yaml</span> only decides how a container is
        named, filed, iconed and ordered.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}

      {!data?.live && (
        <ProviderNote
          status="unavailable"
          reason={data?.statusReason || 'Docker is not connected, so there is nothing to overlay. Connect the engine and every container appears here automatically.'}
          fixHref="/settings/system"
          fixLabel="Discovery status →"
        />
      )}

      {groups.map((g, gi) => (
        <Block
          key={g.name}
          title={g.name}
          aside={
            <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push({ name: 'new', container: null, displayName: null, app: null, description: null, url: null, icon: null, group: g.name, order: null, hidden: false, showOnHub: true, keywords: [], meta: [] }); return next; })}>+ entry</button>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft(removeGroup(groups, g.name))}>remove group</button>
            </span>
          }
        >
          <ul style={{ listStyle: 'none' }}>
            {g.services.map((s, si) => {
              const live = inventory.find((x) => x.name === s.container);
              const label = live ? (live.container.composeService || live.name) : s.container;
              const customized = !!(s.displayName || s.icon || s.description || s.url || s.hidden || s.showOnHub === false || (s.group && s.group !== g.name));
              return (
                <li key={`${s.container || s.name}-${si}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: '9px 0', borderTop: '1px solid var(--hair)' }}>
                  <button className="icon-btn" style={{ width: 34, height: 34 }} title="Choose icon" onClick={() => setIconFor({ gi, si })}>
                    <Icon ref={s.icon || live?.icon} name={s.displayName || s.name} size={24} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 570 }}>
                      {s.displayName || live?.displayName || s.name}
                      {live && (s.displayName || live.displayName) !== label && <span className="stale-note"> · {label}</span>}
                    </div>
                    <div className="stale-note" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.container
                        ? <span className="mono-meta">container {s.container}</span>
                        : <i>not bound to a container — it will not be listed</i>}
                      {live?.url && <span className="mono-meta"> · {live.url.replace(/^https?:\/\//, '')} ({live.urlSource})</span>}
                      {!live?.url && s.url && <span className="mono-meta"> · {s.url.replace(/^https?:\/\//, '')} (manual)</span>}
                      {s.hidden ? <span> · hidden</span> : null}
                      {!s.showOnHub ? <span> · not on Hub</span> : null}
                    </div>
                  </div>
                  {/* discovered vs customized is a word, not a badge */}
                  <span className="stale-note">{customized ? 'customized' : live ? 'discovered' : ''}</span>
                  {!live && s.container && <span className="chip" title={unmatched.find((u) => u.name === s.name)?.reason || 'no such container on this engine'}>not installed</span>}
                  <button className="btn btn-sm" onClick={() => setEditing({ gi, si })}>Edit</button>
                  <button className="btn btn-sm" title={`Remove ${s.name}`} onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.splice(si, 1); return next; })}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: 14, height: 14 }}><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                  </button>
                </li>
              );
            })}
            {!g.services.length && <li className="stale-note" style={{ padding: '8px 0' }}>no overlays in this group yet — it only renders if a container matches</li>}
          </ul>
        </Block>
      ))}

      {unbound.length > 0 && (
        <Block title="Discovered, no overlay" aside={<span className="stale-note">{unbound.length} container{unbound.length === 1 ? '' : 's'} rendering with derived names and icons — fine to leave alone</span>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {unbound.map((s) => (
              <button key={s.id} className="chip" title={`${s.container.image || ''} · ${s.url || s.urlNote || 'no url'}`} onClick={() => setDraft(ensureOverlay(groups, s))}>
                <Icon ref={s.icon} name={s.displayName} size={14} plain /> {s.displayName} · customize
              </button>
            ))}
          </div>
        </Block>
      )}

      {unmatched.length > 0 && (
        <Block title="Unmatched overlays" aside={<span className="stale-note">in services.yaml, but no container on this engine</span>}>
          <ul style={{ listStyle: 'none' }}>
            {unmatched.map((u, i) => (
              <li key={`${u.name}-${i}`} className="form-row" style={{ padding: '9px 0' }}>
                <div>
                  <div className="fr-label">{u.name}</div>
                  <div className="fr-desc">{u.reason}{u.container ? <span className="mono-meta"> · looked for container {u.container}</span> : null}</div>
                </div>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {inventory.length > 0 && (
                    <select
                      className="input"
                      style={{ width: 210 }}
                      value=""
                      aria-label={`Rebind ${u.name} to a container`}
                      onChange={(e) => {
                        const v = e.target.value;
                        const svc = inventory.find((x) => x.name === v);
                        if (svc) setDraft(ensureOverlay(groups, svc));
                      }}
                    >
                      <option value="">bind to a live container…</option>
                      {inventory.map((s) => <option key={s.id} value={s.name}>{s.displayName} ({s.name})</option>)}
                    </select>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginTop: 'var(--sp-6)' }}>
        <button className="btn" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.push({ name: `Group ${next.length + 1}`, description: null, services: [] }); return next; })}>+ group</button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={commit}>{busy ? 'Saving…' : 'Save to services.yaml'}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
        {okAt && !dirty && <span className="stale-note" style={{ color: 'var(--ok)' }}>saved {relTime(okAt)}</span>}
      </div>

      {editing && groups[editing.gi] && (
        <ServiceEditor
          group={groups[editing.gi].name}
          inventory={inventory}
          svc={groups[editing.gi].services[editing.si!]}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            const { gi, si } = editing;
            if (si != null) patchService(gi, si, patch);
            else setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push(patch as DraftService); setEditing(null); return next; });
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

function ServiceEditor({ group, svc, inventory, onSave, onClose }: { group: string; svc: DraftService; inventory: Service[]; onSave: (p: Partial<DraftService>) => void; onClose: () => void }) {
  const [form, setForm] = useState({ ...svc, keywordsText: (svc.keywords || []).join(', '), metaText: (svc.meta || []).map((m) => `${m.label}: ${m.value}`).join('\n') });
  const f = (k: string, v: unknown) => setForm((x) => ({ ...x, [k]: v }));
  const live = inventory.find((x) => x.name === form.container);
  return (
    <Modal title={`${svc.displayName || svc.name || 'New overlay'} — ${group}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => {
            onSave({
              name: (form.container || form.name || '').trim(),
              container: form.container?.trim() || null,
              displayName: form.displayName?.trim() || null, app: form.app?.trim() || null, description: form.description?.trim() || null,
              url: form.url?.trim() || null, icon: form.icon ?? null, group: form.group?.trim() || null,
              order: form.order, hidden: form.hidden, showOnHub: form.showOnHub,
              keywords: form.keywordsText.split(',').map((x: string) => x.trim()).filter(Boolean),
              meta: form.metaText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [label, ...rest] = l.split(/[:=]\s*/); return { label: label.trim(), value: rest.join(': ').trim() }; }),
            });
          }}>Apply</button>
        </>
      }
    >
      <div className="field">
        <label>Container <span className="hint">(what this overlay is about — required for it to show anywhere)</span></label>
        <input className="input mono-meta" list="opus-live-containers" value={form.container || ''} onChange={(e) => f('container', e.target.value)} placeholder={live ? live.name : 'start typing a running container'} />
        <datalist id="opus-live-containers">
          {inventory.map((s) => <option key={s.id} value={s.name}>{`${s.displayName} · ${s.container.state}`}</option>)}
        </datalist>
        {form.container && !live && <p className="stale-note" style={{ color: 'var(--warn)' }}>no container named “{form.container}” on this engine — this entry will be reported as unmatched, and no service will appear.</p>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Display name</label><input className="input" value={form.displayName || ''} onChange={(e) => f('displayName', e.target.value)} placeholder={live ? live.displayName : 'derived from the container'} /></div>
        <div className="field"><label>Group</label><input className="input" value={form.group || ''} onChange={(e) => f('group', e.target.value)} placeholder={live?.group || 'Other'} /></div>
      </div>
      <div className="field"><label>App / software <span className="hint">(shown as identity; the image is the default)</span></label><input className="input" value={form.app || ''} onChange={(e) => f('app', e.target.value)} /></div>
      <div className="field"><label>Description</label><input className="input" value={form.description || ''} onChange={(e) => f('description', e.target.value)} /></div>
      <div className="field">
        <label>URL override <span className="hint">(optional — wins over Traefik and published ports)</span></label>
        <input className="input mono-meta" value={form.url || ''} onChange={(e) => f('url', e.target.value)} placeholder={live && live.url ? `discovered: ${live.url}` : 'leave empty to use what the engine says'} />
        {live?.url && !form.url && (
          <p className="stale-note">discovered from {live.urlSource === 'traefik' ? 'Traefik metadata' : live.urlSource === 'published-port' ? 'a published port' : 'config'} · <span className="mono-meta">{live.url}</span></p>
        )}
        {!live?.url && !form.url && <p className="stale-note">{live?.urlNote || 'this container has no web endpoint — it will read “No web endpoint detected”, which is honest, not broken'}</p>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Order in group</label><input type="number" className="input" value={form.order ?? ''} onChange={(e) => f('order', e.target.value === '' ? null : Number(e.target.value))} /></div>
        <div className="field"><label>Visibility</label>
          <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'center', paddingTop: 6 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={form.hidden} onChange={(e) => f('hidden', e.target.checked)} /> hide everywhere</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={form.showOnHub} onChange={(e) => f('showOnHub', e.target.checked)} /> show on Hub</label>
          </div>
        </div>
      </div>
      <div className="field"><label>Keywords (comma separated)</label><input className="input" value={form.keywordsText} onChange={(e) => f('keywordsText', e.target.value)} /></div>
      <div className="field"><label>Notes / meta — one per line as <span className="mono-meta">Label: value</span></label><textarea className="textarea" rows={3} value={form.metaText} onChange={(e) => f('metaText', e.target.value)} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
        <Icon ref={form.icon || live?.icon} name={form.displayName || form.name || 'svc'} size={40} />
        <span className="stale-note">current icon — set it from the list so it overrides the derived one</span>
      </div>
    </Modal>
  );
}

/* ============ Groups ============ */
function GroupsTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { layout, setLayout } = useLayout();
  const { busy, err, save } = useSave();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const inventory = useMemo(() => data?.services ?? [], [data]);
  const hiddenGroups = layout?.services?.hiddenGroups || [];

  const groups = useMemo<DraftGroup[] | null>(() => {
    if (draft) return draft;
    if (!data) return null;
    const base = overlayFromInventory(data);
    for (const g of data.groups) if (!base.some((x) => x.name === g.name)) base.push({ name: g.name, description: g.description ?? null, services: [] });
    return base;
  }, [draft, data]);

  const discoveredGroups = useMemo(() => {
    const seen = new Map<string, Service[]>();
    for (const s of inventory) {
      if (!s.group || s.hidden) continue;
      seen.set(s.group, [...(seen.get(s.group) || []), s]);
    }
    return seen;
  }, [inventory]);

  if (!groups) return <p className="stale-note">Loading groups…</p>;
  const dirty = !!draft;

  const moveService = (container: string, to: string | null) => {
    const svc = inventory.find((s) => s.name === container);
    if (!svc) return;
    setDraft(to === null ? clearGroup(groups, container) : assignGroup(groups, svc, to));
  };

  return (
    <>
      <p className="lede">
        Groups are presentation. A group heading exists because containers are filed under it — either by
        discovery (their compose project) or by an overlay you write here. Nothing in this pane can create a service.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}

      <Sortable
        ids={groups.map((g) => g.name)}
        className="group-rows"
        onReorder={(next) => {
          const reordered = [...next].map((n) => groups.find((g) => g.name === n)!).filter(Boolean);
          setDraft(reordered);
          setLayout({ services: { groupOrder: next } });
        }}
        renderItem={(name, ctx) => {
          const g = groups.find((x) => x.name === name);
          if (!g) return null;
          const discovered = discoveredGroups.get(name) || [];
          const isHidden = hiddenGroups.includes(name);
          return (
            <div className="group-row" key={name}>
              <div className="group-row-head">
                {ctx.handle}
                <input
                  className="input group-name"
                  value={g.name}
                  aria-label={`Group name for ${name}`}
                  onChange={(e) => setDraft(renameGroup(groups, name, e.target.value))}
                />
                <input
                  className="input group-desc"
                  value={g.description || ''}
                  placeholder="one line about this group (optional)"
                  aria-label={`Description for ${name}`}
                  onChange={(e) => setDraft(setGroupDescription(groups, name, e.target.value))}
                />
                <span className="stale-note">{g.services.length} overlay · {discovered.length} discovered</span>
                <Switch checked={!isHidden} onChange={() => setLayout({ services: { hiddenGroups: isHidden ? hiddenGroups.filter((x) => x !== name) : [...hiddenGroups, name] } })} label={`Show ${name} on the Hub`} />
                <button className="btn btn-sm" onClick={() => setEditing(editing === name ? null : name)}>{editing === name ? 'Done' : 'Services'}</button>
                <button
                  className="icon-btn"
                  aria-label={`Delete group ${name}`}
                  title="Delete this group — its services fall back to discovery"
                  onClick={() => { setDraft(removeGroup(groups, name)); setLayout({ services: { hiddenGroups: hiddenGroups.filter((x) => x !== name) } }); }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </div>

              {editing === name && (
                <div className="group-row-body">
                  {g.services.length === 0 && discovered.length === 0 && <p className="stale-note">Nothing is filed here yet. Assign a discovered service below, or leave the group empty — it renders nothing until a container matches.</p>}
                  {g.services.map((s) => (
                    <div className="group-svc" key={s.container || s.name}>
                      <Icon ref={s.icon} name={s.displayName || s.name} size={20} plain />
                      <span className="grow">{s.displayName || inventory.find((x) => x.name === s.container)?.displayName || s.container || s.name}</span>
                      <span className="stale-note">overlay</span>
                      <button className="btn btn-quiet btn-sm" onClick={() => setDraft(removeEntry(groups, s.container || ''))}>Remove overlay</button>
                    </div>
                  ))}
                  {discovered.filter((d) => !g.services.some((s) => s.container === d.name)).map((d) => (
                    <div className="group-svc" key={d.name}>
                      <Icon ref={d.icon} name={d.displayName} size={20} plain />
                      <span className="grow">{d.displayName}</span>
                      <span className="stale-note">discovered · {d.container.composeProject || 'standalone'}</span>
                      <button className="btn btn-quiet btn-sm" onClick={() => setDraft(assignGroup(groups, d, name))}>File here</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      />

      <Block title="Unfiled" aside={<span className="stale-note">containers with a derived group — moving one writes an overlay</span>}>
        <div className="group-rows">
          {inventory.filter((s) => !s.hidden && !groups.some((g) => g.services.some((x) => x.container === s.name))).slice(0, 40).map((s) => (
            <div className="group-svc" key={s.name}>
              <Icon ref={s.icon} name={s.displayName} size={20} plain />
              <span className="grow">{s.displayName}<span className="stale-note"> · currently “{s.group}” ({s.groupSource || 'derived'})</span></span>
              <select className="input" style={{ width: 190 }} value="" aria-label={`File ${s.displayName} under a group`}
                onChange={(e) => { if (e.target.value) moveService(s.name, e.target.value); }}>
                <option value="">file under…</option>
                {groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
              </select>
            </div>
          ))}
          {!inventory.length && <p className="stale-note">No containers discovered — nothing to file.</p>}
        </div>
      </Block>

      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
        <button className="btn" onClick={() => { const name = `Group ${groups.length + 1}`; setDraft([...groups, { name, description: null, services: [] }]); setEditing(name); }}>+ New group</button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => save(async () => { await saveOverlay(groups); setDraft(null); })}>{busy ? 'Saving…' : 'Save groups'}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
      </div>
    </>
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
      <p className="lede">Flat links, no status, no icon machinery. They appear in search and can be shown in the Hub sidebar.</p>
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
      </div>
    </>
  );
}
function cloneAt(groups: BmGroup[], fn: (d: BmGroup[]) => void): BmGroup[] {
  const next = structuredClone(groups);
  fn(next);
  return next;
}

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
  const [feedUrl, setFeedUrl] = useState('');
  const [sym, setSym] = useState('');
  if (!settings || !intg) return <p className="stale-note">Loading…</p>;
  const feeds = intg.news.feeds || [];
  const symbols = intg.markets.symbols || [];
  const touch = () => { invalidateShared('/api/news'); invalidateShared('/api/weather'); invalidateShared('/api/market'); };
  return (
    <>
      <p className="lede">Every value here is yours. OpusHub ships no defaults and never invents a reading — each widget shows its real provider state, and nothing is displayed that could not be fetched.</p>

      <Block title="News" aside={<Link className="section-link" to="/">see it on the Hub →</Link>}>
        <div className="editor-list">
          {feeds.map((f, i) => (
            <div className="editor-item" key={i}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontWeight: 560 }}>{f.name || URLSafe(f.url)}</b>
                <div className="stale-note mono-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.url}</div>
              </span>
              <button className="icon-btn" aria-label="Remove feed" onClick={() => { update({ integrations: { news: { feeds: feeds.filter((_, j) => j !== i) } } }, true); touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
          {!feeds.length && <div className="editor-item stale-note">No feeds yet — the News widget will say so rather than show an empty box.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <input className="input" style={{ flex: 1 }} placeholder="https://example.com/feed.xml" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} aria-label="Feed URL" />
          <button className="btn" disabled={!feedUrl.trim()} onClick={() => { update({ integrations: { news: { feeds: [...feeds, { url: feedUrl.trim(), name: null }] } } }, true); touch(); setFeedUrl(''); }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {FEED_SUGGESTIONS.filter((s) => !feeds.some((f) => f.url === s.url)).map((s) => (
            <button key={s.url} className="chip" onClick={() => { update({ integrations: { news: { feeds: [...feeds, s] } } }, true); touch(); }}>+ {s.name}</button>
          ))}
        </div>
      </Block>

      <Block title="Weather">
        <Row label="Location" desc="City name or explicit coordinates — used with Open-Meteo (keyless)." tight>
          <input className="input" style={{ width: 240 }} defaultValue={intg.weather.location || ''} placeholder="Amsterdam" aria-label="Weather location"
            onBlur={(e) => { update({ integrations: { weather: { location: e.target.value.trim() || null } } }, true); touch(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </Row>
        <Row label="Units" tight>
          <Segmented value={intg.weather.units} onChange={(v) => { update({ integrations: { weather: { units: v } } }, true); touch(); }} ariaLabel="Units"
            options={[{ value: 'c', label: '°C' }, { value: 'f', label: '°F' }]} />
        </Row>
        <Row label="Where it appears" desc="The Hub header shows the current temperature when weather is available; the sidebar widget shows the full reading." tight>
          <Link className="btn btn-sm" to="/settings/widgets">Widget settings</Link>
        </Row>
      </Block>

      <Block title="Markets" aside={<span className="stale-note">Stooq symbol syntax — bare tickers assume US, use <code>.NS</code> for NSE</span>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
          {symbols.map((s, i) => (
            <span className="chip" key={s}>
              {s}
              <button className="x" aria-label={`Remove ${s}`} onClick={() => { update({ integrations: { markets: { symbols: symbols.filter((_, j) => j !== i) } } }, true); touch(); }}>
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
            if (add.length) { update({ integrations: { markets: { symbols: [...symbols, ...add] } } }, true); touch(); }
            setSym('');
          }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {SYMBOL_SUGGESTIONS.filter((s) => !symbols.includes(s)).map((s) => (
            <button key={s} className="chip" onClick={() => { update({ integrations: { markets: { symbols: [...symbols, s] } } }, true); touch(); }}>+ {s}</button>
          ))}
        </div>
      </Block>
    </>
  );
}
function URLSafe(u: string) { try { return new URL(u).host; } catch { return u.slice(0, 30); } }

/* ============ Advanced ============ */
function AdvancedTab() {
  const { settings, update } = useSettings();
  const { data: custom } = usePolled<{ cssEnabled: boolean; jsEnabled: boolean; css: string | null; jsPresent: boolean }>('/api/custom', 0);
  const { save, busy, err } = useSave();
  const [cssText, setCssText] = useState<string | null>(null);
  return (
    <>
      <p className="lede">
        Custom assets and polling. Everything here is opt-in and stays on the frontend: a stylesheet can add to
        OpusHub's rendering, a script runs in the page only (never on the server), and the refresh values decide how
        often each provider is asked — lower is not better.
      </p>

      <Block title="Hub behaviour">
        <Row label="Log service launches" desc="Adds an Activity event when you open a service from OpusHub." tight>
          <Switch checked={settings?.behavior.logLaunches ?? true} onChange={(v) => update({ behavior: { logLaunches: v } }, true)} label="Log launches" />
        </Row>
        <Row label="System refresh" desc="Seconds between host metric polls." tight>
          <input type="number" min={2} max={300} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.system}
            onBlur={(e) => update({ behavior: { refresh: { system: Math.max(2, Number(e.target.value) || 5) } } }, true)} aria-label="System refresh seconds" />
        </Row>
        <Row label="Services refresh" desc="Containers are polled gently — the engine's API is not free." tight>
          <input type="number" min={5} max={600} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.services}
            onBlur={(e) => update({ behavior: { refresh: { services: Math.max(5, Number(e.target.value) || 30) } } }, true)} aria-label="Services refresh seconds" />
        </Row>
      </Block>

      <Block title="Custom CSS & JS" aside={<span className="stale-note">files live next to services.yaml</span>}>
        <Row label="theme.css" desc="Custom CSS, linked into every page when enabled. A stylesheet cannot break OpusHub's own rendering — it only adds." tight>
          <Switch checked={custom?.cssEnabled ?? false} onChange={(v) => update({ advanced: { customCss: v } }, true)} label="Enable custom CSS" />
        </Row>
        <Row label="app.js" desc="Custom JS, same-origin, opt-in. A thrown error is contained to that script; it never runs server-side." tight>
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

/* ============ System ============ */
function SystemTab() {
  const { data: health } = usePolled<HealthDoc>('/api/health', 0);
  return (
    <>
      <p className="lede">Where OpusHub is plugged in. Paths are resolved at startup and logged on the server; infrastructure access stays read-only.</p>
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
        <Row label="Runtime" tight><span className="mono-meta">OpusHub {health?.version || '0.1'} · node {health?.node || '…'} · {health?.platform || ''}</span></Row>
      </Block>

      <ProvidersBlock />
      <DiscoveryBlock health={health} />
    </>
  );
}

/** Provider health — one quiet table, technical detail behind disclosure. The Hub itself is
 *  never dominated by this; it lives here for the moment something stops answering. */
function ProvidersBlock() {
  const { data } = usePolled<ProvidersDoc>('/api/providers', 30_000);
  if (!data) return <Block title="Providers"><p className="stale-note">Checking providers…</p></Block>;
  const word = (s: string) => s === 'available' ? 'Available' : s === 'degraded' ? 'Degraded' : s === 'idle' ? 'Idle' : 'Unavailable';
  return (
    <Block title="Providers" aside={<span className="stale-note">checked {relTime(data.at)}</span>}>
      <div className="prov-table" role="table" aria-label="Provider health">
        {data.providers.map((p) => (
          <div className="prov-row" role="row" key={p.name}>
            <span role="cell" className="prov-name">{p.name[0].toUpperCase() + p.name.slice(1)}</span>
            <span role="cell"><StatusLine state={p.state} note={word(p.state)} /></span>
            <span role="cell" className="stale-note">
              {p.lastOk ? `last success ${relTime(p.lastOk)}` : 'never succeeded'}
            </span>
            {p.reason && (
              <details className="tech" role="cell"><summary>Why</summary><code>{p.reason}</code></details>
            )}
          </div>
        ))}
      </div>
    </Block>
  );
}

/** Discovery status — the honest answer to “why is nothing showing up?”. */
function DiscoveryBlock(_props: { health: HealthDoc | null }) {
  const { data, refresh } = usePolled<DiscoveryDoc>('/api/discovery', 30_000);
  const { busy, save } = useSave();
  if (!data) return <Block title="Service discovery"><p className="stale-note">Reading engine status…</p></Block>;
  const e = data.engine;
  return (
    <Block
      title="Service discovery"
      aside={
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => save(async () => { await post('/api/discovery/refresh'); invalidateShared('/api/services'); invalidateShared('/api/discovery'); refresh(); })}>
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
      }
    >
      <p className="lede" style={{ marginBottom: 'var(--sp-4)' }}>
        Docker decides what exists; URLs come from Traefik labels, published ports or your own override. Nothing is
        assumed about domains or ports, and no socket path ever reaches this page.
      </p>
      <div className="sys-kv" style={{ marginTop: 0 }}>
        <dt>Engine</dt><dd>{e.ok ? `connected${e.version ? ` · v${e.version}` : ''}${e.api ? ` · API ${e.api}` : ''}` : e.state}</dd>
        <dt>Containers</dt><dd>{e.containers} · {e.running} running · {e.stopped} stopped</dd>
        <dt>Inventory</dt><dd>{data.inventory.applications} applications · {data.inventory.infrastructure} infrastructure · {data.inventory.stacks} stacks · {data.inventory.standalone} standalone</dd>
        <dt>URLs</dt><dd>{data.urlDiscovery.withUrl} with a URL · {data.urlDiscovery.withoutUrl} without {data.urlDiscovery.hostAddress ? <span className="mono-meta"> · host {data.urlDiscovery.hostAddress} ({data.urlDiscovery.hostAddressSource})</span> : null}</dd>
        <dt>Overlays</dt><dd>{data.overlays.serviceOverlays} of {data.overlays.serviceEntries ?? data.overlays.serviceOverlays} service entries bind · {data.overlays.stackOverlays} of {data.overlays.stackEntries ?? data.overlays.stackOverlays} stack entries bind</dd>
      </div>
      {data.overlays.unmatched > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="micro-label">Unmatched overlays</div>
          <ul style={{ display: 'grid', gap: 4, marginTop: 6 }}>
            {(data.overlays.unmatchedList || []).slice(0, 12).map((u, i) => (
              <li key={i} className="stale-note">{u.kind === 'stack' ? 'stack' : 'service'} <b>{u.name}</b> — {u.reason}</li>
            ))}
          </ul>
          <Link className="section-link" to="/settings/services">Fix the overlays →</Link>
        </div>
      )}
      {!e.ok && (
        <ProviderNote
          status="unavailable"
          reason="OpusHub cannot see containers right now, so live status, stats and logs stay off. Set OPUSHUB_DOCKER_SOCKET (or DOCKER_HOST) and restart."
          fixHref="/settings/system"
          fixLabel="How discovery resolves →"
        />
      )}
    </Block>
  );
}
