// Runs the DOM interaction checks (test/web/tests.tsx) in a jsdom document.
//
// The components are TSX, so the test module is bundled with vite first, then imported into a
// Node process whose globals are a jsdom window. When jsdom is not installed (a production
// container does not need it) the run is skipped with a message instead of failing.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-web');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('jsdom is not installed — skipping the DOM interaction checks (npm i -D jsdom)');
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom has no layout engine: geometry is stubbed so components that measure do not explode.
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
};
window.Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout */ };
// jsdom has no ResizeObserver. Components that measure their container (the charts) install one,
// so the stub records its callbacks and exposes them for the checks to fire with a chosen width.
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; FakeResizeObserver.instances.push(this); }
  observe(el) { this.el = el; }
  unobserve() {}
  // remove in place: the checks hold a reference to this array, so it must never be replaced
  disconnect() {
    const i = FakeResizeObserver.instances.indexOf(this);
    if (i >= 0) FakeResizeObserver.instances.splice(i, 1);
  }
}
FakeResizeObserver.instances = [];
window.ResizeObserver = FakeResizeObserver;
globalThis.__resizeObservers = FakeResizeObserver.instances;

if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId || 1; }
  };
}
// jsdom has no EventSource — stub it so live-event hooks mount without throwing
class FakeEventSource {
  constructor() { this.readyState = 0; this.withCredentials = false; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2; }
  dispatchEvent() { return true; }
  set onopen(_) {}
  get onopen() { return null; }
  set onmessage(_) {}
  get onmessage() { return null; }
  set onerror(_) {}
  get onerror() { return null; }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;
window.EventSource = FakeEventSource;

const globals = [
  'window', 'document', 'navigator', 'location', 'history', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'ResizeObserver', 'EventSource', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'MessageChannel', 'matchMedia',
  'DocumentFragment', 'CSSStyleDeclaration', 'DOMRect', 'MutationObserver',
];
for (const name of globals) {
  if (window[name] === undefined) continue;
  try {
    globalThis[name] = window[name];
  } catch {
    // Node defines some of these (navigator) as accessor-only — define it over the top.
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React logs every async state update that happens outside act(); with polling components that is
// expected noise, and it drowns the results.
const realError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  realError(...args);
};

let code = 0;
try {
  const build = spawnSync('npx', ['vite', 'build', '--ssr', 'test/web/tests.tsx', '--outDir', 'dist-web', '--emptyOutDir'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    code = build.status ?? 1;
  } else {
    const mod = await import(pathToFileURL(join(OUT, 'tests.js')).href);
    const result = await mod.runWebTests();
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    code = result.failed ? 1 : 0;
  }
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
// the pollers and jsdom timers keep the loop alive; exit deliberately
process.exit(code);
