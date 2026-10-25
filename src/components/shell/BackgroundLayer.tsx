// The fixed layer behind every page: art, scrim, grain (DESIGN.md §4). Which art is chosen by
// `html[data-bg]`, which the theme applier sets from settings; here only the photo needs a value.
import { useSettings } from '../../lib/theme';

export function BackgroundLayer() {
  const { settings } = useSettings();
  const photo = settings?.appearance?.background === 'photo' && settings.appearance.photoAvailable;
  return (
    <div className="bg-layer" aria-hidden="true" style={photo ? { ['--bg-photo' as never]: 'url(/api/appearance/background)' } : undefined}>
      <div className="art" />
      <div className="scrim" />
      <div className="grain" />
    </div>
  );
}
