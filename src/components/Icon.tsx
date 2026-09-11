// The one icon resolution path: url → /user/ local → `set:name` (server-resolved, offline
// collections first) → emoji/text → deterministic letter monogram. Never a broken image.
import { useEffect, useState } from 'react';
import { useSettings } from '../lib/theme';

const svgCache = new Map<string, Promise<string | null>>();

function fetchIconSvg(ref: string): Promise<string | null> {
  if (!svgCache.has(ref)) {
    svgCache.set(ref, (async () => {
      try {
        const res = await fetch(`/api/icon?ref=${encodeURIComponent(ref)}&size=64`);
        if (!res.ok) return null;
        const text = await res.text();
        return text.trim().startsWith('<svg') ? text : null;
      } catch {
        return null;
      }
    })());
  }
  return svgCache.get(ref)!;
}

export const isUrlIcon = (ref: string) => /^https?:\/\//i.test(ref);
export const isLocalIcon = (ref: string) => ref.startsWith('/user/');
export const isRefIcon = (ref: string) => /^[a-z][a-z0-9-]*:[a-z0-9+._-]+$/i.test(ref);
export const isEmojiIcon = (ref: string) => Array.from(ref).length <= 4 && !isRefIcon(ref) && !isUrlIcon(ref) && !isLocalIcon(ref);

function hashHue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

export function Monogram({ name, size = 30, plain = false }: { name: string; size?: number; plain?: boolean }) {
  const { resolvedTheme } = useSettings();
  const hue = hashHue(name || '?');
  const dark = resolvedTheme === 'dark';
  const bg = `hsl(${hue} ${dark ? 22 : 32}% ${dark ? 26 : 91}%)`;
  const fg = `hsl(${hue} ${dark ? 38 : 42}% ${dark ? 74 : 33}%)`;
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  if (plain) return <span style={{ color: fg, fontWeight: 640, fontSize: size * 0.62, letterSpacing: '-0.02em' }}>{letter}</span>;
  return (
    <span className="icon-frame" aria-hidden="true" style={{ ['--icon-size' as never]: `${size}px`, background: bg, color: fg }}>
      <span className="mono" style={{ fontSize: size * 0.46 }}>{letter}</span>
    </span>
  );
}

export function Icon({
  ref: iconRef, name, size = 30, plain = false, className = '',
}: { ref: string | null | undefined; name: string; size?: number; plain?: boolean; className?: string }) {
  const [svg, setSvg] = useState<string | null | undefined>(undefined);
  const isRef = iconRef ? isRefIcon(iconRef) : false;

  useEffect(() => {
    let alive = true;
    if (isRef && iconRef) {
      fetchIconSvg(iconRef).then((s) => { if (alive) setSvg(s); });
    } else {
      setSvg(null);
    }
    return () => { alive = false; };
  }, [iconRef, isRef]);

  if (!iconRef) return <Monogram name={name} size={size} plain={plain} />;
  if (isUrlIcon(iconRef) || isLocalIcon(iconRef)) {
    return (
      <span className={`icon-frame ${plain ? 'plain' : ''} ${className}`} style={{ ['--icon-size' as never]: `${size}px` }}>
        <img src={iconRef} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      </span>
    );
  }
  if (isEmojiIcon(iconRef)) {
    return (
      <span className={`icon-frame ${plain ? 'plain' : ''} ${className}`} aria-hidden="true" style={{ ['--icon-size' as never]: `${size}px`, background: 'transparent', fontSize: size * 0.52 }}>
        {iconRef}
      </span>
    );
  }
  if (isRef) {
    if (svg === undefined) {
      return <span className={`icon-frame ${className}`} aria-hidden="true" style={{ ['--icon-size' as never]: `${size}px`, opacity: 0.45 }} />;
    }
    if (svg === null) return <Monogram name={name} size={size} plain={plain} />;
    return (
      <span
        className={`icon-frame ${plain ? 'plain' : ''} ${className}`}
        aria-hidden="true"
        style={{ ['--icon-size' as never]: `${size}px` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return <Monogram name={iconRef || name} size={size} plain={plain} />;
}
