// Smoke test: server-render every route with providers wired. Catches import/render crashes.
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const routes = [
  '/', '/services', '/services/Media/Stream', '/stacks', '/stacks/Media', '/monitoring', '/system', '/activity',
  // Host and Infrastructure live under System now (legacy /host and /infrastructure redirect and
  // render an empty shell under SSR, so smoke the canonical mounts, not the shims).
  '/system/host', '/system/infrastructure',
  '/settings/appearance', '/settings/background', '/settings/hub', '/settings/widgets', '/settings/templates',
  '/settings/general', '/settings/services', '/settings/groups', '/settings/bookmarks', '/settings/integrations', '/settings/authentication', '/settings/environment',
  '/settings/advanced',
  '/icons', '/nope',
];
let failed = 0;
for (const route of routes) {
  try {
    const html = renderToString(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
    if (!html.includes('root') && html.length < 10) throw new Error('empty render');
    // note: lazy pages resolve during hydration, so this asserts the shell + module graph
    console.log(`✓ ${route} — rendered ${html.length} bytes`);
  } catch (e) {
    failed++;
    console.error(`✗ ${route} — ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
