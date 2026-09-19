// Phase 10D-D — the service catalog. Browse, search, filter; every card leads to the install
// flow. Nothing here talks to Docker: the list is server data (manifests) plus what the engine
// says is already installed (label io.opushub.catalog).
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { Icon } from '../components/Icon';
import { Loading, PageHero, ProviderNote } from '../components/ui';

export interface CatalogEntry {
  id: string; name: string; summary: string; category: string; tags: string[]; icon: string | null; homepage: string | null;
  image: { repository: string; recommended: string }; proxy: boolean; healthcheck: boolean;
}
export interface CatalogDoc {
  entries: CatalogEntry[]; categories: string[];
  installed: { manifest: string; name: string; state: string; version: string | null }[];
  proxy: { provider: string; label: string; available: boolean; network: string | null };
  permissions: { install: boolean }; invalidManifests: number;
}

export default function CatalogPage() {
  const nav = useNavigate();
  const { data, error } = usePolled<CatalogDoc>('/api/v1/catalog', 60_000);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) => (!category || e.category === category) && (!needle || [e.id, e.name, e.summary, e.category, ...e.tags].some((s) => s.toLowerCase().includes(needle))));
  }, [data, q, category]);
  const installedBy = useMemo(() => {
    const m = new Map<string, CatalogDoc['installed']>();
    for (const i of data?.installed ?? []) m.set(i.manifest, [...(m.get(i.manifest) ?? []), i]);
    return m;
  }, [data]);
  const usedCategories = useMemo(() => (data?.categories ?? []).filter((c) => data?.entries.some((e) => e.category === c)), [data]);

  if (error && !data) return <ProviderNote status="error" reason={String(error)} />;
  if (!data) return <Loading what="catalog" />;

  return (
    <>
      <PageHero
        title="Catalog"
        desc="Services OpusHub knows how to install: a manifest describes the image, the settings it needs and how it plugs into monitoring, updates, Autoheal and the reverse proxy. Installing is a confirmed operation — you see the full plan first."
        meta={
          <>
            <span>{data.entries.length} service{data.entries.length === 1 ? '' : 's'}</span>
            <span className="sep">·</span>
            <span>{data.installed.length} installed from the catalog</span>
            <span className="sep">·</span>
            <span>{data.proxy.available ? `reverse proxy: ${data.proxy.label}` : 'no reverse-proxy provider configured'}</span>
            {!data.permissions.install && <><span className="sep">·</span><span>read-only for your account</span></>}
          </>
        }
      />
      <div className="catalog-filters">
        <input type="search" placeholder="Search services…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the catalog" />
        <div className="catalog-cats" role="tablist" aria-label="Categories">
          <button className={`chip${category === '' ? ' active' : ''}`} onClick={() => setCategory('')}>All</button>
          {usedCategories.map((c) => <button key={c} className={`chip${category === c ? ' active' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      </div>
      {entries.length === 0 ? <p className="op-quiet">Nothing matches.</p> : (
        <div className="catalog-grid">
          {entries.map((e) => {
            const inst = installedBy.get(e.id) ?? [];
            return (
              <article key={e.id} className="catalog-card" onClick={() => nav(`/catalog/${encodeURIComponent(e.id)}`)} tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') nav(`/catalog/${encodeURIComponent(e.id)}`); }}>
                <div className="catalog-card-head">
                  <Icon ref={e.icon} name={e.name} size={36} />
                  <div>
                    <h3>{e.name}</h3>
                    <span className="op-quiet">{e.image.repository}:{e.image.recommended}</span>
                  </div>
                </div>
                <p>{e.summary}</p>
                <div className="catalog-card-foot">
                  <span className="mstack-act" data-act="safe">{e.category}</span>
                  {e.proxy && <span className="mstack-act">web</span>}
                  {e.healthcheck && <span className="mstack-act">healthcheck</span>}
                  {inst.length > 0 && <span className="mstack-act" data-act="running">{inst.length} installed</span>}
                  <span style={{ flex: 1 }} />
                  <Link to={`/catalog/${encodeURIComponent(e.id)}`} className="section-link" onClick={(ev) => ev.stopPropagation()}>{data.permissions.install ? 'Install →' : 'Details →'}</Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
