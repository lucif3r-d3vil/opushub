import { useState } from 'react';
import { IconPicker } from '../components/IconPicker';
import { usePolled } from '../lib/api';
import type { ServicesDoc } from '../lib/types';
import { PageHero } from '../components/ui';
import { Icon } from '../components/Icon';

export default function IconsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const used = new Map<string, string[]>();
  for (const g of data?.groups || []) for (const s of g.services) if (s.icon) used.set(s.icon, [...(used.get(s.icon) || []), s.name]);
  return (
    <>
      <PageHero
        title="Icons"
        desc="Bundled first: Lucide, Material Design Icons and Simple Icons ship with OpusHub and resolve offline. Iconify extends it to 200k+ icons when you're online. Drop your own files into config/icons/."
        meta={<span>{used.size} icon{used.size === 1 ? '' : 's'} in use</span>}
      />
      {used.size > 0 && (
        <section className="section">
          <div className="section-head"><h2 className="section-title">In use across your services</h2></div>
          <div className="icon-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
            {[...used.entries()].map(([ref, names]) => (
              <button key={ref} className="icon-cell" title={names.join(', ')}
                onClick={() => { void navigator.clipboard?.writeText(ref).catch(() => undefined); setCopied(ref); setTimeout(() => setCopied(null), 1500); }}>
                <Icon ref={ref} name={names[0]} size={30} />
                <span className="nm">{names[0]}</span>
              </button>
            ))}
          </div>
          {copied && <p className="stale-note" style={{ marginTop: 8 }}>“{copied}” copied — paste it into a service's icon field.</p>}
        </section>
      )}
      <section className="section">
        <div className="section-head"><h2 className="section-title">Search everything</h2><span className="section-aside">pick one, copy its ref, assign it in Settings → Services</span></div>
        <IconPicker initial={null} onDone={(ref) => { if (ref) { void navigator.clipboard?.writeText(ref).catch(() => undefined); setCopied(ref); setTimeout(() => setCopied(null), 1800); } }} />
        {copied && <p className="stale-note" style={{ color: 'var(--accent-ink)' }}>Copied {copied} to your clipboard.</p>}
      </section>
    </>
  );
}
