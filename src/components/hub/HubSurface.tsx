// The Hub, as a surface.
//
// This is the *only* implementation of the Hub page: `/` renders it with live data and drag
// enabled, Settings renders the very same component with the layout being edited and interaction
// off. There is no second "preview renderer" that can drift from the real thing.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LayoutDoc, WidgetCatalogueEntry, WidgetInstance, WidgetZone } from '../../lib/types';
import type { DeepPartial } from '../../lib/theme';
import type { HubData } from '../../lib/hubData';
import { reorderZone, visibleInZone, hiddenWidgets, configSummary } from '../../lib/hubLayout';
import { Sortable } from '../Sortable';
import { HubHeader } from './HubHeader';
import { WidgetFrame } from './WidgetFrame';
import { renderWidget } from './widgets';
import SetupBanner from '../SetupBanner';

export interface HubSurfaceProps {
  data: HubData;
  layout: LayoutDoc | null;
  interactive: boolean;
  onLayoutChange?: (patch: DeepPartial<LayoutDoc>) => void;
  onSearch?: () => void;
  /** preview: freeze the clock, and mark the surface as such for assistive tech */
  preview?: boolean;
  frozenNow?: Date;
}

/** One widget: frame + body, with the menu actions wired to layout changes. */
function HubWidget({ widget, zone, data, layout, catalogue, interactive, onLayoutChange, handle }: {
  widget: WidgetInstance;
  zone: WidgetZone;
  data: HubData;
  layout: LayoutDoc | null;
  catalogue: WidgetCatalogueEntry[];
  interactive: boolean;
  onLayoutChange?: (patch: DeepPartial<LayoutDoc>) => void;
  handle?: ReactNode;
}) {
  const entry = catalogue.find((c) => c.type === widget.type);
  const patch = onLayoutChange ? (p: Partial<WidgetInstance>) => onLayoutChange({ hub: { widgets: (layout?.hub.widgets || []).map((w) => (w.id === widget.id ? { ...w, ...p } : w)) } }) : undefined;
  const move = onLayoutChange ? (to: WidgetZone) => {
    const others = (layout?.hub.widgets || []).filter((w) => w.id !== widget.id);
    const lastOfZone = [...others].reverse().find((w) => w.zone === to);
    const at = lastOfZone ? others.indexOf(lastOfZone) + 1 : others.length;
    const widgets = [...others.slice(0, at), { ...widget, zone: to }, ...others.slice(at)];
    onLayoutChange({ hub: { widgets } });
  } : undefined;
  const note = configSummary(widget);

  return (
    <WidgetFrame
      widget={widget}
      catalogue={catalogue}
      zone={zone}
      interactive={interactive}
      handle={handle}
      note={note || null}
      onPatch={patch}
      onMove={move}
    >
      {renderWidget({ widget, data, layout, interactive, onLayoutChange }, catalogue)}
    </WidgetFrame>
  );
}

/** Empty zones offer the next step instead of an apology. */
function ZoneEmpty({ zone }: { zone: WidgetZone }) {
  return (
    <div className="hub-zone-empty">
      <span className="stale-note">
        {zone === 'main' ? 'The main column is empty.' : 'The sidebar is empty.'}
      </span>
      <Link className="section-link" to="/settings/widgets">Add a widget →</Link>
    </div>
  );
}

/** First run with no widgets at all is a welcome, not a wall of placeholders. */
function HubWelcome() {
  return (
    <section className="hub-welcome" aria-label="Your Hub is ready">
      <h2>Your Hub is ready.</h2>
      <p>
        It fills itself from what this machine is actually running — nothing here is configured by hand.
        Choose a composition to start from, or add widgets one at a time.
      </p>
      <div className="hub-welcome-actions">
        <Link className="btn" to="/settings/templates">Choose a template</Link>
        <Link className="btn" to="/settings/widgets">Add widgets</Link>
        <Link className="btn btn-quiet" to="/settings/system">Discovery status</Link>
      </div>
    </section>
  );
}

export function HubSurface({ data, layout, interactive, onLayoutChange, onSearch, preview = false, frozenNow }: HubSurfaceProps) {
  const catalogue = data.widgets.data?.catalogue || [];
  const main = visibleInZone(layout, 'main');
  const rail = visibleInZone(layout, 'rail');
  const hidden = hiddenWidgets(layout);

  const zone = (id: WidgetZone, widgets: WidgetInstance[]) => {
    if (interactive && onLayoutChange) {
      const ids = widgets.map((w) => w.id);
      return (
        <Sortable
          ids={ids}
          className={`hub-zone-stack hub-zone-stack--${id}`}
          onReorder={(next) => onLayoutChange({ hub: { widgets: reorderZone(layout as LayoutDoc, id, next).hub.widgets } })}
          renderItem={(wid, ctx) => {
            const w = widgets.find((x) => x.id === wid);
            if (!w) return null;
            return (
              <HubWidget
                widget={w} zone={id} data={data} layout={layout} catalogue={catalogue}
                interactive onLayoutChange={onLayoutChange} handle={ctx.handle}
              />
            );
          }}
        />
      );
    }
    return (
      <div className={`hub-zone-stack hub-zone-stack--${id}`}>
        {widgets.map((w) => (
          <div key={w.id}>
            <HubWidget widget={w} zone={id} data={data} layout={layout} catalogue={catalogue} interactive={false} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={`hub hub--${layout?.hub?.spacing || 'comfortable'}${preview ? ' hub--preview' : ''}`}>
      <HubHeader
        services={data.services.data}
        weather={data.weather.data}
        showWeather={data.weather.data?.status === 'ok'}
        onSearch={onSearch || (() => undefined)}
        frozenNow={frozenNow}
      />

      {!preview && <SetupBanner sys={data.system.data} services={data.services.data} />}

      {main.length === 0 && rail.length === 0 ? (
        <HubWelcome />
      ) : (
        <div className="hub-zones">
          <div className="hub-zone hub-zone--main">
            {main.length ? zone('main', main) : <ZoneEmpty zone="main" />}
          </div>
          <aside className="hub-zone hub-zone--rail" aria-label="Sidebar">
            {rail.length ? zone('rail', rail) : <ZoneEmpty zone="rail" />}
          </aside>
        </div>
      )}

      {interactive && hidden.length > 0 && (
        <div className="hub-hidden">
          <span className="stale-note">{hidden.length} hidden widget{hidden.length === 1 ? '' : 's'}:</span>
          {hidden.map((w) => (
            <button
              key={w.id}
              className="chip"
              onClick={() => onLayoutChange?.({ hub: { widgets: (layout?.hub.widgets || []).map((x) => (x.id === w.id ? { ...x, visible: true } : x)) } })}
            >
              + {w.title || catalogue.find((c) => c.type === w.type)?.title || w.type}
            </button>
          ))}
          <Link className="section-link" to="/settings/widgets">manage →</Link>
        </div>
      )}
    </div>
  );
}
