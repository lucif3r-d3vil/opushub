// Live homepage preview.
//
// It is the real Hub component (HubSurface) rendered with the layout currently being edited, inside
// a frame. Nothing here re-implements the page: what the preview shows is exactly what `/` will
// render once the change is saved, including theme, accent, density and background.
import { useMemo, useState } from 'react';
import type { LayoutDoc } from '../../lib/types';
import { useHubData } from '../../lib/hubData';
import { neededData } from '../../lib/hubLayout';
import { useSettings } from '../../lib/theme';
import { Modal } from '../ui';
import { HubSurface } from './HubSurface';

function EmbeddedBackground() {
  const { settings } = useSettings();
  const bg = settings?.appearance.background;
  const mode = bg?.mode ?? 'quiet';
  if (mode === 'quiet') return null;
  return (
    <div
      className={`bg-layer bg-embedded bg-${mode}`}
      style={{ ['--bg-blur' as never]: `${bg?.blur ?? 24}`, ['--bg-scrim' as never]: `${bg?.scrim ?? 62}` }}
      aria-hidden="true"
    >
      {mode === 'photo' && bg?.photo && <div className="bg-img" style={{ backgroundImage: `url("${bg.photo}")` }} />}
    </div>
  );
}

export interface HubPreviewProps {
  /** the layout to render; omit to preview the saved one */
  layout: LayoutDoc | null;
  label?: string;
  /** when set, the preview renders this layout but the frame keeps its own scroll position */
  height?: number | string;
}

export function HubPreview({ layout, label, height = 520 }: HubPreviewProps) {
  const types = useMemo(() => neededData(layout), [layout]);
  const data = useHubData({ types });
  const [width, setWidth] = useState<'wide' | 'phone'>('wide');

  return (
    <div className="hub-preview">
      <div className="hub-preview-head">
        <span className="hub-preview-label">
          <span className="hub-preview-dot" aria-hidden="true" />
          Preview
        </span>
        <span className="hub-preview-note">{label || 'updates as you change settings'}</span>
        <span className="hub-preview-sizes">
          <button aria-pressed={width === 'wide'} onClick={() => setWidth('wide')}>Wide</button>
          <button aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}>Phone</button>
        </span>
        <PreviewFullscreen layout={layout} />
      </div>
      <div className={`hub-preview-frame hub-preview-frame--${width}`} style={{ height }} aria-hidden={false}>
        <EmbeddedBackground />
        <div className="hub-preview-surface" inert>
          <div className="hub-preview-scale">
            <HubSurface data={data} layout={layout} interactive={false} preview frozenNow={FROZEN} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A stable clock in the preview keeps the frame from twitching while settings are edited. */
const FROZEN = new Date();

function PreviewFullscreen({ layout }: { layout: LayoutDoc | null }) {
  const [open, setOpen] = useState(false);
  const types = useMemo(() => neededData(layout), [layout]);
  const data = useHubData({ types });
  return (
    <>
      <button className="hub-preview-expand" onClick={() => setOpen(true)} title="Open a large preview">Larger ↗</button>
      {open && (
        <Modal title="Hub preview" onClose={() => setOpen(false)} wide>
          <div className="hub-preview-frame hub-preview-frame--full" style={{ height: '70dvh' }}>
            <EmbeddedBackground />
            <div className="hub-preview-surface" inert>
              <div className="hub-preview-scale">
                <HubSurface data={data} layout={layout} interactive={false} preview frozenNow={FROZEN} />
              </div>
            </div>
          </div>
          <p className="stale-note" style={{ marginTop: 10 }}>
            This is the real Hub component rendering your unsaved-in-this-pane configuration. Nothing here is a mock-up:
            services, widgets and providers all come from the same live data as the page itself.
          </p>
        </Modal>
      )}
    </>
  );
}
