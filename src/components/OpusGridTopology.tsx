// OpusGrid topology — the whole infrastructure as a layered map, with nothing invented.
//
// Every node came from a provider or from config/topology.yaml, and every edge is labelled with
// where it came from: `discovered` (a provider proved it) or `configured` (you asserted it in the
// topology file). There is no third kind, so there is no line on this map that OpusHub guessed.
//
// Interactions: filter by layer, search by name, click to open the object's own page, drag to pan
// and scroll to zoom, and Reset when you have wandered. Under 720px the graph yields to a
// hierarchy — the same nodes, grouped by layer, honestly re-laid-out instead of shrunk.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TopologyDoc, TopologyEdge, TopologyNode } from '../lib/types';

const LAYERS = ['physical', 'network', 'compute', 'storage', 'services'] as const;
type Layer = typeof LAYERS[number];

const LAYER_WORDS: Record<Layer, string> = {
  physical: 'Physical',
  network: 'Network',
  compute: 'Compute',
  storage: 'Storage',
  services: 'Services',
};

const NW = 186;   // node width
const NH = 38;    // node height
const GAP_Y = 12;
const COLS: Record<Layer, number> = { physical: 16, network: 250, compute: 484, storage: 718, services: 952 };

interface Placed { node: TopologyNode; x: number; y: number }

export function OpusGridTopology({ doc }: { doc: TopologyDoc | null }) {
  const nav = useNavigate();
  const [layers, setLayers] = useState<Layer[]>([...LAYERS]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const nodes = doc?.nodes || [];
  const edges = doc?.edges || [];

  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () => new Set(needle
      ? nodes.filter((n) => `${n.label} ${n.sub || ''} ${n.kind}`.toLowerCase().includes(needle)).map((n) => n.id)
      : nodes.map((n) => n.id)),
    [nodes, needle],
  );

  const { placed, links, height } = useMemo(() => {
    const visible = nodes.filter((n) => layers.includes(n.layer as Layer));
    const byLayer = new Map<Layer, TopologyNode[]>();
    for (const l of LAYERS) byLayer.set(l, []);
    for (const n of visible) byLayer.get(n.layer as Layer)?.push(n);
    const placed: Placed[] = [];
    const pos = new Map<string, Placed>();
    let maxY = 0;
    for (const l of LAYERS) {
      let y = 20;
      for (const n of byLayer.get(l) || []) {
        const p = { node: n, x: COLS[l], y };
        placed.push(p);
        pos.set(n.id, p);
        y += NH + GAP_Y;
      }
      maxY = Math.max(maxY, y);
    }
    const links: { edge: TopologyEdge; a: Placed; b: Placed }[] = [];
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a && b) links.push({ edge: e, a, b });
    }
    return { placed, links, height: Math.max(maxY + 20, 200) };
  }, [nodes, edges, layers]);

  const posById = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);

  // Wheel zoom, non-passive so the page does not scroll under the graph.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setT((prev) => {
        const k = Math.min(2.4, Math.max(0.35, prev.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
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

  const toggle = (l: Layer) => setLayers((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  const neighbours = useMemo(() => {
    if (!selected) return new Set<string>();
    const set = new Set<string>([selected]);
    for (const l of links) {
      if (l.edge.from === selected) set.add(l.edge.to);
      if (l.edge.to === selected) set.add(l.edge.from);
    }
    return set;
  }, [selected, links]);

  const dim = (id: string) => {
    if (needle && !matches.has(id)) return true;
    if (selected && !neighbours.has(id)) return true;
    return false;
  };

  const path = (a: Placed, b: Placed) => {
    const right = b.x >= a.x;
    const x1 = right ? a.x + NW : a.x;
    const x2 = right ? b.x : b.x + NW;
    const y1 = a.y + NH / 2;
    const y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };

  if (!doc) return <p className="stale-note" role="status">Reading the OpusGrid topology…</p>;

  const sel = selected ? posById.get(selected)?.node || null : null;
  const configured = doc.sources?.configured || 0;

  return (
    <div className="topo">
      <div className="topo-bar">
        <div className="seg" role="group" aria-label="Filter by layer">
          {LAYERS.map((l) => (
            <button key={l} type="button" aria-pressed={layers.includes(l)} onClick={() => toggle(l)}>
              {LAYER_WORDS[l]} <span className="stale-note">{doc.layers?.[l] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          className="input topo-search"
          type="search"
          value={q}
          placeholder="Find an object…"
          aria-label="Find an object in the topology"
          onChange={(e) => setQ(e.target.value)}
        />
        {configured > 0 && (
          <span className="chip" title="Configured relationships come from config/topology.yaml">
            {configured} configured
          </span>
        )}
      </div>

      <div className="topo-graph" role="img" aria-label={`OpusGrid topology: ${nodes.length} objects, ${edges.length} relationships`}>
        <svg
          ref={svgRef}
          className="topo-svg"
          style={{ height: Math.min(600, Math.max(320, height)) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            {links.map((l, i) => {
              const hot = selected && (l.edge.from === selected || l.edge.to === selected);
              const faded = dim(l.edge.from) || dim(l.edge.to);
              return (
                <path
                  key={i}
                  d={path(l.a, l.b)}
                  className={`topo-line ${l.edge.source}${hot ? ' hot' : ''}${faded ? ' dim' : ''}`}
                />
              );
            })}
            {placed.map(({ node, x, y }) => (
              <g
                key={node.id}
                transform={`translate(${x} ${y})`}
                className={`topo-node${node.href || !node.href ? ' clickable' : ''}${selected === node.id ? ' sel' : ''}${dim(node.id) ? ' dim' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected((cur) => (cur === node.id ? null : node.id));
                  if (node.href) nav(node.href);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && node.href) nav(node.href); }}
                tabIndex={0}
                role="link"
                aria-label={`${LAYER_WORDS[node.layer as Layer] || node.layer}: ${node.label}${node.href ? ' — open' : ''}`}
              >
                <rect width={NW} height={NH} rx={9} className={`topo-box ${node.kind}${node.state === 'running' || node.state === 'up' || node.state === 'online' ? ' run' : node.state && node.state !== 'up' ? ' halt' : ''}${node.layer === 'physical' ? ' physical' : ''}`} />
                <circle cx={13} cy={NH / 2} r={3.5} className={`topo-dot ${node.kind}${node.state === 'running' || node.state === 'up' || node.state === 'online' ? ' run' : node.state ? ' halt' : ''}`} />
                <text x={24} y={node.sub ? 16 : 23} className="topo-label">{node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}</text>
                {node.sub && <text x={24} y={29} className="topo-sub">{node.sub.length > 28 ? `${node.sub.slice(0, 27)}…` : node.sub}</text>}
              </g>
            ))}
          </g>
        </svg>
        <div className="topo-tools" role="toolbar" aria-label="Topology view controls">
          <button className="btn btn-sm" onClick={() => setT((p) => ({ ...p, k: Math.min(2.4, p.k * 1.2) }))} aria-label="Zoom in">+</button>
          <button className="btn btn-sm" onClick={() => setT((p) => ({ ...p, k: Math.max(0.35, p.k / 1.2) }))} aria-label="Zoom out">−</button>
          <button className="btn btn-sm" onClick={() => { setT({ x: 0, y: 0, k: 1 }); setSelected(null); setQ(''); }}>Reset</button>
        </div>
        {sel && (
          <div className="topo-sel" role="status">
            <b>{sel.label}</b>
            <span className="stale-note">{LAYER_WORDS[sel.layer as Layer] || sel.layer} · {sel.source}{sel.note ? ` · ${sel.note}` : ''}</span>
            <button className="btn btn-quiet btn-sm" onClick={() => setSelected(null)}>Clear</button>
          </div>
        )}
      </div>

      <div className="topo-legend">
        <span><i className="topo-legend-line discovered" aria-hidden="true" /> solid — discovered by a provider</span>
        <span><i className="topo-legend-line configured" aria-hidden="true" /> dashed — configured by you</span>
        <span className="stale-note">{doc.rule}</span>
      </div>

      {/* Mobile / narrow: the same objects, as a hierarchy grouped by layer — not a squeezed graph. */}
      <div className="topo-list">
        {LAYERS.filter((l) => layers.includes(l)).map((l) => {
          const group = nodes.filter((n) => n.layer === l);
          if (!group.length) return null;
          return (
            <section key={l} className="svc-group">
              <h2 className="topo-list-layer">{LAYER_WORDS[l]}</h2>
              <div className="svc-list">
                {group.map((n) => (
                  <button
                    key={n.id}
                    className="row svc-row"
                    onClick={() => (n.href ? nav(n.href) : setSelected(n.id))}
                  >
                    <span className="title">{n.label}</span>
                    {n.sub && <span className="sub">{n.sub}</span>}
                    <span className="stale-note" style={{ marginLeft: 'auto' }}>{n.source}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!nodes.length && <p className="stale-note">Nothing to draw yet — no provider has reported anything.</p>}
      </div>
    </div>
  );
}
