// Runs one of the server-render checks: real components, fixture data, assertions on the markup.
//
// There is no browser in this environment, so this is how the client surfaces get verified before
// deployment. The bundle goes to dist-ssr/ (gitignored) and is removed when the run finishes.
//
//   node test/ssr-smoke.mjs routes   every route renders without throwing
//   node test/ssr-smoke.mjs hub      the Hub surface under nine data states
//   node test/ssr-smoke.mjs live     the real API of a running OpusHub through the real Hub
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entries = { routes: 'src/ssr-smoke.tsx', hub: 'src/ssr-hub.tsx', live: 'src/ssr-live.tsx' };
const which = process.argv[2];
if (!Object.hasOwn(entries, which || '')) {
  console.error(`usage: node test/ssr-smoke.mjs <${Object.keys(entries).join('|')}>`);
  process.exit(2);
}
const entry = entries[which];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-ssr');
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

let code = 0;
try {
  const build = run('npx', ['vite', 'build', '--ssr', entry, '--outDir', 'dist-ssr', '--emptyOutDir']);
  if (build.status !== 0) {
    code = build.status ?? 1;
  } else {
    const bundle = join(outDir, entry.split('/').pop().replace(/\.tsx$/, '.js'));
    code = run(process.execPath, [bundle]).status ?? 1;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exitCode = code;
