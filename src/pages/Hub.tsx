// The Hub page — / and nothing else.
//
// Composition lives in components/hub/HubSurface so the Settings preview renders the identical
// markup; this file only supplies live data, the persisted layout and the effects that follow from
// them (data needs, drag persistence).
import { useCallback, useMemo } from 'react';
import { useLayout } from '../lib/theme';
import { useHubData } from '../lib/hubData';
import { neededData } from '../lib/hubLayout';
import { HubSurface } from '../components/hub/HubSurface';

export default function Hub() {
  const { layout, setLayout } = useLayout();

  // Only the providers that a visible widget actually shows are polled.
  const types = useMemo(() => neededData(layout), [layout]);
  const data = useHubData({ types });

  const openSearch = useCallback(() => window.dispatchEvent(new CustomEvent('opushub:open-search')), []);

  // The document title is owned by the theme applier (app.name from settings.yaml), so it is set
  // once for every page rather than only while the Hub happens to be mounted.

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
