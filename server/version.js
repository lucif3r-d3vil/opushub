// OpusHub version — one honest answer to \"what build is this?\".
//
// Values come from (in order): build-time env (baked into the Docker image), package.json,
// git at runtime (dev checkouts only), or null when genuinely unknown. Nothing is fabricated:
// a missing SHA renders as \"Not available\", never as a guess.
//
// Build args (see Dockerfile):
//   OPUSHUB_VERSION        e.g. \"0.2.0\" (defaults to package.json version)
//   OPUSHUB_GIT_SHA        full or short commit hash
//   OPUSHUB_BUILD_TIME     ISO-8601 build timestamp
//   OPUSHUB_IMAGE_TAG      e.g. \"ghcr.io/lucif3r-d3vil/opushub:latest\"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from './env.js';

let pkgVersion = '0.1.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  if (pkg?.version) pkgVersion = String(pkg.version);
} catch { /* keep the fallback */ }

function gitSha() {
  const env = (process.env.OPUSHUB_GIT_SHA || '').trim();
  if (env) return env.slice(0, 40);
  // Dev checkouts only: never in production code paths that could block a request.
  // This runs once per process (cached below), with a hard timeout, and failures are silent.
  try {
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: APP_ROOT, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
  } catch { return null; }
}

let cached = null;

/**
 * The version document. Stable per process; cheap to call from any route.
 * `installationMode` is derived, not stored: a container marker + image tag means
 * \"docker image\", otherwise \"source checkout\".
 */
export function versionInfo() {
  if (cached) return cached;
  const version = (process.env.OPUSHUB_VERSION || '').trim() || pkgVersion;
  const sha = gitSha();
  const buildTime = (process.env.OPUSHUB_BUILD_TIME || '').trim() || null;
  const imageTag = (process.env.OPUSHUB_IMAGE_TAG || '').trim() || null;
  let inContainer = false;
  try {
    inContainer = fs.existsSync('/.dockerenv')
      || /docker|kubepods/i.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch { /* not a container, or unreadable cgroup — either way, not proven */ }
  cached = {
    name: 'OpusHub',
    version,
    gitSha: sha,
    buildTime,
    imageTag,
    installationMode: inContainer ? 'docker' : 'source',
  };
  return cached;
}

/** Test helper — the document is process-global state. */
export function _resetVersion() { cached = null; }
