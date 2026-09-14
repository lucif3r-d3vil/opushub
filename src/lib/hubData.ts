// Everything the Hub renders, fetched once and shared.
//
// The Hub is a composition of widgets, but it must not become a composition of *requests*: this
// hook is the only place that decides what to fetch, and every widget reads from here. Data is
// fetched through the shared cache in lib/api.ts, so the live preview in Settings reuses the very
// same responses instead of polling again.
import { useMemo } from 'react';
import { useSharedQuery, type QueryState } from './api';
import { useSettings } from './theme';
import type {
  ActivityEvent, NewsDoc, ProvidersDoc, ServicesDoc, StacksDoc, SystemSnapshot, WeatherDoc, WidgetDoc, MarketDoc,
} from './types';

export interface BookmarkGroup { name: string; items: { name: string; href: string; description?: string | null }[] }
export interface BookmarkDoc { groups: BookmarkGroup[] }

export interface HubData {
  system: QueryState<SystemSnapshot>;
  services: QueryState<ServicesDoc>;
  stacks: QueryState<StacksDoc>;
  activity: QueryState<{ items: ActivityEvent[] }>;
  bookmarks: QueryState<BookmarkDoc>;
  weather: QueryState<WeatherDoc>;
  news: QueryState<NewsDoc>;
  markets: QueryState<MarketDoc>;
  widgets: QueryState<WidgetDoc>;
  providers: QueryState<ProvidersDoc>;
}

export interface HubNeedOptions {
  /** widget types currently visible — a widget that is hidden costs nothing */
  types: Set<string>;
  /** the activity widget's own limit, so two widgets of the same type never double-fetch */
  activityLimit?: number;
}

export function useHubData({ types, activityLimit = 12 }: HubNeedOptions): HubData {
  const { settings } = useSettings();
  const refresh = settings?.behavior?.refresh;

  const system = useSharedQuery<SystemSnapshot>('/api/system', (refresh?.system ?? 5) * 1000);
  const services = useSharedQuery<ServicesDoc>('/api/services', (refresh?.services ?? 30) * 1000);
  const stacks = useSharedQuery<StacksDoc>('/api/stacks', (refresh?.services ?? 30) * 1000);
  const activity = useSharedQuery<{ items: ActivityEvent[] }>(`/api/activity?limit=${activityLimit}`, 60_000);
  const bookmarks = useSharedQuery<BookmarkDoc>('/api/bookmarks', 0);
  const widgets = useSharedQuery<WidgetDoc>('/api/widgets', 0);

  const wants = useMemo(() => ({
    weather: types.has('weather'),
    news: types.has('news'),
    markets: types.has('markets'),
    // provider health only matters while the attention widget is actually on screen
    providers: types.has('attention'),
  }), [types]);

  // Optional providers are only polled while something on screen actually shows them.
  const weather = useSharedQuery<WeatherDoc>(wants.weather ? '/api/weather' : null, 15 * 60_000);
  const news = useSharedQuery<NewsDoc>(wants.news ? '/api/news' : null, 10 * 60_000);
  const markets = useSharedQuery<MarketDoc>(wants.markets ? '/api/market' : null, 5 * 60_000);
  const providers = useSharedQuery<ProvidersDoc>(wants.providers ? '/api/providers' : null, 60_000);

  return { system, services, stacks, activity, bookmarks, weather, news, markets, widgets, providers };
}

/** Convenience: the catalogue entry for a type, from whichever doc has loaded. */
export function catalogueEntry(doc: WidgetDoc | null, type: string) {
  return doc?.catalogue.find((c) => c.type === type) || null;
}
