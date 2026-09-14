// The Hub page — / and nothing else.
//
// Composition lives in components/hub/HubSurface so the Settings preview renders the identical
// markup; this file only supplies live data, the persisted layout and the effects that follow from
// them (data needs, drag persistence).
import { useCallback, useEffect, useMemo } from 'react';
import { useLayout, useSettings } from '../lib/theme';
import { useHubData } from '../lib/hubData';
import { neededData } from '../lib/hubLayout';
import { HubSurface } from '../components/hub/HubSurface';

export default function Hub() {
  const { layout, setLayout } = useLayout();
  const { settings } = useSettings();

  // Only the providers that a visible widget actually shows are polled.
  const types = useMemo(() => neededData(layout), [layout]);
  const data = useHubData({ types });

  const openSearch = useCallback(() => window.dispatchEvent(new CustomEvent('opushub:open-search')), []);

  // the document title follows the greeting name when one is configured — a personal home
  const name = settings?.hub.greetingName?.trim();
  useEffect(() => {
    document.title = name ? `${name} · OpusHub` : 'OpusHub';
  }, [name]);

  return (
    <HubSurface
      data={data}
      layout={layout}
      interactive
      onLayoutChange={setLayout}
      onSearch={openSearch}
    />
  );
}
