// Network topology — a read-only map drawn ONLY from Docker-proven relationships.
//
// Nodes: the host, Docker networks, and containers. Edges: daemon-reported attachments
// (network → container membership from the Engine's own `Containers` map). Stacks appear as
// labels on container nodes, never as invented links: if Docker cannot prove a relationship,
// it is not drawn.
//
// Interactions: drag to pan, scroll to zoom, click a container to open its service page.
// Under 720px (or with reduced motion forced) the graph yields to a hierarchical list —
// the same data, honestly re-laid-out, not a squeezed miniature.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InfraNetwork, Service } from '../lib/types';

interface Props {
  networks: InfraNetwork[];
  services: Service[];
  hostname: string | null;
}

interface Node { id: string; kind: 'host' | 'network' | 'container'; label: string; sub: string | null; x: number; y: number; stack: string | null; state: string | null; href: string | null }
interface Edge { from: string; to: string }

const NW = 200; // node width
const NH = 36;  // node height
const GAP_Y = 14;
const COL_X = [24, 300, 590]; // host | networks | containers

export function Topology({ networks, services, hostname }: Props) {
  const nav = useNavigate();
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const byName = useMemo(() => {
    const m = new Map<string, Service>();
    for (const s of services) m.set(s.name, s);
    return m;
  }, [services]);

  const { nodes, edges, height } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const nets = [...networks].sort((a, b) => (b.containerCount - a.containerCount) || String(a.name).localeCompare(String(b.name)));
    // Containers: every service whose name the daemon attached to at least one network,
    // plus unattached-but-known services listed under no network (drawn, unlinked).
    const attached = new Set<string>();
    for (const n of nets) for (const c of n.containers) attached.add(c.name);
    const ordered = [...services].sort((a, b) => {
      const sa = a.stackDisplayName || a.container.composeProject || 'zzz';
      const sb = b.stackDisplayName || b.container.composeProject || 'zzz';
      return sa.localeCompare(sb) || a.displayName.localeCompare(b.displayName);
    });
    const shown = ordered.filter((s) => attached.has(s.name));
    const orphans = ordered.filter((s) => !attached.has(s.name)).slice(0, 12);

    const hostY = 24;
    nodes.push({ id: 'host', kind: 'host', label: hostname || 'Docker host', sub: 'host', x: COL_X[0], y: hostY, stack: null, state: null, href: null });

    let y = 24;
    const netY = new Map<string, number>();
    for (const n of nets.slice(0, 24)) {
      const id = `net:${n.name}`;
      netY.set(String(n.name), y);
      nodes.push({
        id, kind: 'network', label: String(n.name), sub: `${n.driver || '?'} · ${n.containerCount} attached`,
        x: COL_X[1], y, stack: null, state: null, href: null,
      });
      edges.push({ from: 'host', to: id });
      y += NH + GAP_Y;
    }

    y = 24;
    const cap = 80;
    for (const s of [...shown.slice(0, cap), ...orphans]) {
      const id = `ctr:${s.name}`;
      nodes.push({
        id, kind: 'container', label: s.displayName, sub: s.stackDisplayName || s.container.composeProject || (attached.has(s.name) ? null : 'no network attachment'),
        x: COL_X[2], y, stack: s.stackDisplayName || s.container.composeProject || null,
        state: s.container.state, href: `/services/${encodeURIComponent(s.group)}/${encodeURIComponent(s.name)}`,
      });
      y += NH + GAP_Y;
    }
    for (const n of nets.slice(0, 24)) {
      for (const c of n.containers) {
        if (nodes.some((x) => x.id === `ctr:${c.name}`)) edges.push({ from: `net:${n.name}`, to: `ctr:${c.name}` });
      }
    }
    const height = Math.max(y, hostY + NH + 24, 200);
    return { nodes, edges, height };
  }, [networks, services, hostname]);

  const pos = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.id, n]));
    return m;
  }, [nodes]);

  // Wheel zoom (non-passive so the page does not scroll under the graph).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setT((prev) => {
        const k = Math.min(2.5, Math.max(0.4, prev.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const s = k / prev.k;
        return { k, x: mx - (mx - prev.x) * s, y: my - (my - prev.y) * s };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    setT((prev) => ({ ...prev, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const onPointerUp = () => { drag.current = null; };

  const sel = selected ? pos.get(selected) : null;
  const selLinks = selected ? edges.filter((e) => e.from === selected || e.to === selected) : [];

  const path = (a: Node, b: Node) => {
    const x1 = a.x + NW; const y1 = a.y + NH / 2;
    const x2 = b.x; const y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };

  return (
    <div className="topo">
      <div className="topo-graph" role="img" aria-label={`Network topology: ${networks.length} networks, ${services.length} containers`}>
        <svg
          ref={svgRef}
          className="topo-svg"
          style={{ height: Math.min(560, Math.max(300, height)) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            {edges.map((e, i) => {
              const a = pos.get(e.from)!;
              const b = pos.get(e.to)!;
              if (!a || !b) return null;
              const hot = selected && (e.from === selected || e.to === selected);
              return <path key={i} d={path(a, b)} className={`topo-edge${hot ? ' hot' : ''}${selected && !hot ? ' dim' : ''}`} />;
            })}
            {nodes.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                className={`topo-node${n.kind === 'container' ? ' clickable' : ''}${selected === n.id ? ' sel' : ''}${selected && n.id !== selected && !selLinks.some((e) => e.from === n.id || e.to === n.id) ? ' dim' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (n.href) nav(n.href);
                  else setSelected((cur) => (cur === n.id ? null : n.id));
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && n.href) nav(n.href); }}
                tabIndex={n.href ? 0 : undefined}
                role={n.href ? 'link' : undefined}
                aria-label={n.href ? `${n.label} — open service` : `${n.kind} ${n.label}`}
              >
                <rect width={NW} height={NH} rx={9} className={`topo-box ${n.kind}${n.state === 'running' ? ' run' : n.state ? ' halt' : ''}`} />
                <circle cx={14} cy={NH / 2} r={3.5} className={`topo-dot ${n.kind}${n.state === 'running' ? ' run' : n.state ? ' halt' : ''}`} />
                <text x={26} y={n.sub ? 16 : 22} className="topo-label">{n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}</text>
                {n.sub && <text x={26} y={29} className="topo-sub">{n.sub.length > 30 ? `${n.sub.slice(0, 29)}…` : n.sub}</text>}
              </g>
            ))}
          </g>
        </svg>
        <div className="topo-tools" role="toolbar" aria-label="Topology view controls">
          <button className="btn btn-sm" onClick={() => setT((p) => ({ ...p, k: Math.min(2.5, p.k * 1.2) }))} aria-label="Zoom in">+</button>
          <button className="btn btn-sm" onClick={() => setT((p) => ({ ...p, k: Math.max(0.4, p.k / 1.2) }))} aria-label="Zoom out">−</button>
          <button className="btn btn-sm" onClick={() => { setT({ x: 0, y: 0, k: 1 }); setSelected(null); }}>Reset</button>
        </div>
        {sel && (
          <div className="topo-sel" role="status">
            <b>{sel.label}</b>
            <span className="stale-note">{sel.kind}{sel.sub ? ` · ${sel.sub}` : ''}</span>
            <button className="btn btn-quiet btn-sm" onClick={() => setSelected(null)}>Clear</button>
          </div>
        )}
      </div>
      {/* Mobile / narrow fallback: the same membership as a hierarchy, not a squeezed graph. */}
      <div className="topo-list">
        {networks.map((n) => (
          <section key={String(n.name)} className="svc-group">
            <div className="svc-group-head">
              <h2 className="svc-group-name">{n.name}</h2>
              <span className="svc-group-desc">{n.driver} · {n.scope}{n.internal ? ' · internal' : ''}</span>
              <span className="svc-group-count">{n.containerCount}</span>
            </div>
            <div className="svc-list">
              {n.containers.map((c) => {
                const s = byName.get(c.name);
                return s ? (
                  <button key={c.name} className="row svc-row" onClick={() => nav(`/services/${encodeURIComponent(s.group)}/${encodeURIComponent(s.name)}`)}>
                    <span className="title">{s.displayName}</span>
                    {s.stackDisplayName && <span className="sub">{s.stackDisplayName}</span>}
                  </button>
                ) : (
                  <div key={c.name} className="row svc-row"><span className="title">{c.name}</span></div>
                );
              })}
              {!n.containers.length && <p className="stale-note">No containers attached.</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
