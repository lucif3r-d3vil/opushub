// The GHCR workflow's contract, asserted against the file itself.
//
// The workflow is the distribution surface of the project: it decides what "published" means,
// which credential may push, and which platforms and attestations an image carries. All of that
// is configuration, and configuration drifts — a well-meaning edit can drop `needs: verify`,
// widen the token's permissions or quietly disable provenance without any test noticing, because
// none of it is code. This file pins the contract mechanically, the same way the phase proofs
// pin the security boundaries of the server: parse the workflow, assert the invariants, and make
// sure that breaking one of them is a test failure rather than a surprise at release time.
//
// The assertions are deliberately structural (parsed YAML, not grep): prose in the workflow's
// comments can never satisfy them, and a reformat can never break them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ghcr.yml'), 'utf8'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Every string value anywhere in the parsed workflow — the only place a secret reference can hide. */
function collectStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) collectStrings(value, out);
  return out;
}

const verify = WORKFLOW.jobs?.verify;
const publish = WORKFLOW.jobs?.publish;
const runSteps = (job) => (job?.steps || []).map((s) => s.run).filter(Boolean);
const stepByUses = (job, prefix) => (job?.steps || []).find((s) => typeof s.uses === 'string' && s.uses.startsWith(prefix));

test('the workflow is exactly a verify gate and a publish job, and publish waits for verify', () => {
  assert.deepEqual(Object.keys(WORKFLOW.jobs), ['verify', 'publish'], 'a third job would be a new way to reach the registry');
  assert.ok(verify, 'the verify job exists');
  assert.ok(publish, 'the publish job exists');
  assert.equal(publish.needs, 'verify', 'publishing without the gate is not publishing, it is gambling');
});

test('verify runs the full gate, in order: install, typecheck, tests, production build', () => {
  assert.deepEqual(runSteps(verify), ['npm ci', 'npm run typecheck', 'npm test', 'npm run build'],
    'a green publish must mean the whole gate ran — nothing may be skipped or reordered');
});

test('verify installs the Node version the application declares, not a newer one', () => {
  const setup = stepByUses(verify, 'actions/setup-node');
  assert.ok(setup, 'verify uses actions/setup-node');
  // package.json says ">=22": the major the workflow installs must be that major. Bumping the
  // application's Node is a release decision that belongs in package.json, not in the workflow.
  const declared = Number(/(\d+)/.exec(PKG.engines?.node || '')[1]);
  assert.ok(Number.isFinite(declared), 'package.json declares a numeric Node engine');
  assert.equal(Number(setup.with?.['node-version']), declared,
    'the workflow builds with the Node the application targets');
});

test('publish holds the minimum permissions, and verify holds none beyond the default', () => {
  assert.deepEqual(publish.permissions, { contents: 'read', packages: 'write' },
    'the publisher may read the repo and write packages — nothing else is grantable');
  assert.equal(verify.permissions, undefined,
    'the verify job needs no explicit permissions; it must not inherit a write grant');
});

test('the only registry credential in the workflow is its own GITHUB_TOKEN', () => {
  const referenced = collectStrings(WORKFLOW).flatMap((s) => [...s.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[0]));
  assert.ok(referenced.length > 0, 'the workflow must authenticate to push');
  assert.ok(referenced.every((ref) => ref === 'secrets.GITHUB_TOKEN'),
    `no personal token or foreign secret may appear — found: ${referenced.join(', ')}`);
  const login = stepByUses(publish, 'docker/login-action');
  assert.ok(login, 'publish signs in to the registry');
  // the registry is the workflow-level env, so assert what it resolves to, not how it is spelled
  assert.equal(login.with?.registry, '${{ env.REGISTRY }}');
  assert.equal(WORKFLOW.env?.REGISTRY, 'ghcr.io', 'the registry OpusHub publishes to is GHCR');
  assert.equal(login.with?.username, '${{ github.actor }}');
  assert.equal(login.with?.password, '${{ secrets.GITHUB_TOKEN }}');
});

test('the image is linux/amd64 only, pushed with provenance and an SBOM', () => {
  const build = stepByUses(publish, 'docker/build-push-action');
  assert.ok(build, 'publish builds and pushes with docker/build-push-action');
  assert.equal(build.with?.platforms, 'linux/amd64', 'amd64 is the shipped platform; anything else is a deliberate release decision');
  assert.equal(build.with?.push, true, 'the publish job pushes; a build that stays local belongs in verify');
  assert.equal(build.with?.provenance, true, 'provenance stays on: an unsigned provenance is a silent policy change');
  assert.equal(build.with?.sbom, true, 'the SBOM stays on');
});

test('the tag contract: latest follows the default branch, releases get semver, every build gets its sha', () => {
  const meta = stepByUses(publish, 'docker/metadata-action');
  assert.ok(meta, 'publish derives tags with docker/metadata-action');
  const tags = String(meta.with?.tags || '').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(tags.includes('type=raw,value=latest,enable={{is_default_branch}}'),
    ':latest is gated to the default branch — a branch build must never steal it');
  assert.ok(tags.includes('type=semver,pattern={{version}}'), 'a v1.4.0 tag publishes :1.4.0');
  assert.ok(tags.includes('type=semver,pattern={{major}}.{{minor}}'), 'a v1.4.0 tag publishes :1.4');
  assert.ok(tags.includes('type=sha,prefix=sha-'), 'every build publishes a sha- tag for pinning');
});

test('the workflow runs on main pushes, version tags, and manual dispatch — nothing else', () => {
  assert.deepEqual(WORKFLOW.on?.push?.branches, ['main'], 'every merge to main is published');
  assert.deepEqual(WORKFLOW.on?.push?.tags, ['v*'], 'a version tag is a release');
  assert.ok('workflow_dispatch' in (WORKFLOW.on || {}), 'the workflow can be run by hand');
});
