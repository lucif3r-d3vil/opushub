// Smoke test: server-render every route with providers wired. Catches import/render crashes.
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const routes = ['/', '/services', '/services/Media/Stream', '/stacks', '/stacks/Media', '/system', '/activity', '/settings/appearance', '/settings/services', '/settings/integrations', '/settings/system', '/icons', '/nope'];
let failed = 0;
for (const route of routes) {
  try {
    const html = renderToString(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
    if (!html.includes('root') && html.length < 10) throw new Error('empty render');
    console.log(`✓ ${route} — rendered ${html.length} bytes`);
  } catch (e) {
    failed++;
    console.error(`✗ ${route} — ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
