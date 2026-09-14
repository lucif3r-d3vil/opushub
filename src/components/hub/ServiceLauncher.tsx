// The service launcher — the primary element of the Hub.
//
// Composition, not a card farm: a group heading (name · description · count), then a hairline list
// of compact entries. Everything here comes from the canonical discovered inventory; nothing is
// hardcoded, and a container that does not exist cannot appear because it was never fetched.
//
//   · single click on an entry  → the service page (OpusHub's own surface)
//   · the launch affordance     → the real URL the resolver found, in a new tab
//   · no URL at all             → no link is invented; the entry says so quietly
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { DeepPartial } from '../../lib/theme';
import type { LayoutDoc, Service, ServicesDoc, WidgetInstance } from '../../lib/types';
import { useSettings } from '../../lib/theme';
import { Icon } from '../Icon';
import { StatusDot, Menu, MenuButton, type MenuItem } from '../ui';
import { Sortable } from '../Sortable';
import { DockerOffNote } from '../../lib/dockerStatus';
import { WidgetEmpty } from './WidgetFrame';

export interface LauncherProps {
  services: ServicesDoc | null;
  error: string | null;
  loading: boolean;
  layout: LayoutDoc | null;
  widget: WidgetInstance;
  interactive: boolean;
  onLayoutChange?: (patch: DeepPartial<LayoutDoc>) => void;
}

/** Order a group's entries: the drag order the user saved wins, then the overlay order, then name. */
function orderedNames(group: { name: string; services: Service[] }, saved: string[] | undefined): string[] {
  const names = group.services.filter((s) => s.showOnHub !== false).map((s) => s.name);
  if (!saved) return names;
  const kept = saved.filter((n) => names.includes(n));
  return [...kept, ...names.filter((n) => !kept.includes(n))];
}

function LaunchItem({ svc, groupName, handle, detailed }: { svc: Service; groupName: string; handle?: ReactNode; detailed: boolean }) {
  const { settings } = useSettings();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const detail = `/services/${encodeURIComponent(groupName)}/${encodeURIComponent(svc.name)}`;

  const launch = useCallback(() => {
    if (!svc.url) return;
    if (settings?.behavior?.logLaunches) void api(detail, { method: 'POST' }).catch(() => undefined);
    window.open(svc.url, '_blank', 'noreferrer');
  }, [svc.url, detail, settings?.behavior?.logLaunches]);

  const items: MenuItem[] = [
    ...(svc.url ? [{ label: 'Open in new tab', action: launch } as MenuItem] : []),
    { label: 'Service details', href: detail },
    ...(svc.url ? [{ label: 'Copy URL', action: () => void navigator.clipboard?.writeText(svc.url || '').catch(() => undefined) } as MenuItem] : []),
    { label: 'Customize name, icon, group…', href: `/settings/services?container=${encodeURIComponent(svc.name)}` },
  ];

  const sub = svc.description || svc.app || null;

  return (
    <div
      className="launch-item"
      data-noweb={!svc.url || undefined}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      <Link to={detail} className="li-main" onDoubleClick={launch} title={sub || svc.displayName}>
        <Icon ref={svc.icon} name={svc.displayName} size={detailed ? 28 : 24} />
        <span className="li-text">
          <span className="li-name">{svc.displayName}</span>
          {detailed && (
            <span className="li-sub">
              {sub || (svc.url ? '' : 'No web endpoint detected')}
              {sub && !svc.url && <span className="li-quiet"> · no web endpoint</span>}
            </span>
          )}
        </span>
      </Link>
      <StatusDot state={svc.status || 'unavailable'} title={svc.statusReason || svc.urlNote || undefined} />
      {svc.url ? (
        <button className="li-open" onClick={launch} aria-label={`Open ${svc.displayName}`} title={`Open ${svc.url}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : (
        <span className="li-open li-open--none" aria-hidden="true" />
      )}
      {handle}
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const EyeOffIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" /><path d="m5 19 14-14" strokeLinecap="round" /></svg>;
const GridIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" /></svg>;
const SlidersIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" strokeLinecap="round" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>;

function GroupBlock({ group, saved, handle, detailed, interactive, onReorder, onHide }: {
  group: { name: string; description?: string | null; services: Service[] };
  saved: string[] | undefined;
  handle?: ReactNode;
  detailed: boolean;
  interactive: boolean;
  onReorder: (order: string[]) => void;
  onHide: () => void;
}) {
  const ids = useMemo(() => orderedNames(group, saved), [group, saved]);
  const byName = useMemo(() => new Map(group.services.map((s) => [s.name, s])), [group.services]);
  const visible = group.services.filter((s) => s.showOnHub !== false).length;
  const hiddenCount = group.services.length - visible;
  return (
    <section className="launcher-group" data-group={group.name}>
      <div className="launcher-group-head">
        {handle}
        <h3 className="launcher-group-name">
          {group.name}
          <span className="launcher-group-count">{group.services.length}</span>
        </h3>
        {group.description && <span className="launcher-group-desc">{group.description}</span>}
        {hiddenCount > 0 && <span className="launcher-group-desc">· {hiddenCount} not on the Hub</span>}
        <span className="launcher-group-aside">
          <Link className="section-link" to="/services">Directory →</Link>
          {interactive && (
            // A real menu, placed against this exact button by the shared popover primitive: it
            // opens under the trigger, flips above when the viewport runs out, and stays inside
            // the window — instead of a bare icon that acted immediately with no visible cause.
            <MenuButton
              label={`${group.name} group options`}
              title={`Options for ${group.name}`}
              className="icon-btn li-menu"
              items={[
                { label: 'Hide from Hub', icon: <EyeOffIcon />, action: onHide },
                { label: 'Open in Directory', icon: <GridIcon />, href: '/services' },
                { label: 'Group settings…', icon: <SlidersIcon />, href: '/settings/groups' },
              ]}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </MenuButton>
          )}
        </span>
      </div>
      {ids.length === 0 ? (
        <WidgetEmpty>Every service in this group is hidden. Show them from Settings → Services.</WidgetEmpty>
      ) : interactive ? (
        <Sortable ids={ids} onReorder={onReorder} className="launcher-items" renderItem={(id, ctx) => (
          <LaunchItem svc={byName.get(id)!} groupName={group.name} handle={ctx.handle} detailed={detailed} />
        )} />
      ) : (
        <ul className="launcher-items">
          {ids.map((id) => <li key={id}><LaunchItem svc={byName.get(id)!} groupName={group.name} detailed={detailed} /></li>)}
        </ul>
      )}
    </section>
  );
}

export function ServiceLauncher({ services, error, loading, layout, widget, interactive, onLayoutChange }: LauncherProps) {
  const detailed = widget.size !== 'sm';
  const hiddenGroups = layout?.services?.hiddenGroups || [];
  const only = Array.isArray(widget.config?.groups) ? (widget.config.groups as string[]) : null;
  const includeInfra = widget.config?.infrastructure === true;

  const groups = useMemo(() => {
    const all = services?.groups ?? [];
    const filtered = only?.length ? all.filter((g) => only.includes(g.name)) : all;
    return filtered.filter((g) => !hiddenGroups.includes(g.name));
  }, [services, only, hiddenGroups]);

  const groupIds = useMemo(() => {
    const names = groups.map((g) => g.name);
    const saved = (layout?.services?.groupOrder || []).filter((n) => names.includes(n));
    return [...saved, ...names.filter((n) => !saved.includes(n))];
  }, [groups, layout?.services?.groupOrder]);

  const byName = useMemo(() => new Map(groups.map((g) => [g.name, g])), [groups]);
  const infra = includeInfra ? (services?.infrastructure ?? []).filter((s) => !s.hidden) : [];

  if (loading && !services) {
    return <div className="widget-quiet" role="status">Reading the engine…</div>;
  }
  if (services && !services.live) {
    return <DockerOffNote reason={services.statusReason} />;
  }
  if (error && !services) {
    return <WidgetEmpty>Could not read the service inventory. It will retry on its own.</WidgetEmpty>;
  }
  if (!groups.length && !infra.length) {
    if (only?.length) {
      return <WidgetEmpty href="/settings/widgets" linkLabel="Change this widget's groups →">This widget shows {only.join(', ')}, and nothing is filed there yet.</WidgetEmpty>;
    }
    return (
      <WidgetEmpty href="/settings/system" linkLabel="Discovery status →">
        No containers yet. The launcher fills itself the moment Docker reports one — nothing is configured by hand.
      </WidgetEmpty>
    );
  }

  return (
    <div className={`launcher${detailed ? '' : ' launcher--compact'}`}>
      {interactive && onLayoutChange ? (
        <Sortable
          ids={groupIds}
          className="launcher-groups"
          onReorder={(next) => onLayoutChange({ services: { groupOrder: next } })}
          renderItem={(id, ctx) => (
            <GroupBlock
              group={byName.get(id)!}
              saved={layout?.services?.order?.[id]}
              handle={ctx.handle}
              detailed={detailed}
              interactive={interactive}
              onReorder={(order) => onLayoutChange({ services: { order: { [id]: order } } })}
              onHide={() => onLayoutChange({ services: { hiddenGroups: [...hiddenGroups, id] } })}
            />
          )}
        />
      ) : (
        <div className="launcher-groups">
          {groupIds.map((id) => (
            <GroupBlock
              key={id}
              group={byName.get(id)!}
              saved={layout?.services?.order?.[id]}
              detailed={detailed}
              interactive={false}
              onReorder={() => undefined}
              onHide={() => undefined}
            />
          ))}
        </div>
      )}

      {infra.length > 0 && (
        <section className="launcher-group launcher-group--rails">
          <div className="launcher-group-head">
            <h3 className="launcher-group-name">Rails<span className="launcher-group-count">{infra.length}</span></h3>
            <span className="launcher-group-desc">databases, proxies, caches — shown because you asked this widget to include them</span>
          </div>
          <ul className="launcher-items">
            {infra.map((s) => (
              <li key={s.name}>
                <LaunchItem svc={s} groupName={s.group || 'Other'} detailed={false} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && hiddenGroups.length > 0 && interactive && onLayoutChange && (
        <div className="launcher-restore">
          <span className="stale-note">Hidden groups:</span>
          {hiddenGroups.filter((g) => (services?.groups ?? []).some((x) => x.name === g)).map((g) => (
            <button
              key={g}
              className="chip"
              onClick={() => onLayoutChange({ services: { hiddenGroups: hiddenGroups.filter((x) => x !== g) } })}
            >
              + {g}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
