// DOM harness for the interaction checks (test/web/tests.tsx).
//
// jsdom gives the components a real document, a real event system and a real focus model, which is
// exactly what the keyboard, menu and search flows need. It gives no layout (getBoundingClientRect
// returns zeros), so pointer dragging is out of scope here — the keyboard reorder path, which is
// the accessible one and the one that commits through the same code, is what gets exercised.
//
// fetch is stubbed at the network boundary: every request is recorded, and responses come from the
// fixture table. Nothing in the app is mocked — the components, contexts, router and drag logic all
// run for real.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { resetSharedCache } from '../../src/lib/api';

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

type Responder = (body: unknown, path: string) => unknown;

export interface Harness {
  container: HTMLElement;
  root: Root;
  calls: Recorded[];
  /** mount a tree; returns after the first paint and data flush */
  mount: (node: ReactNode) => Promise<void>;
  /** let pending promises, effects and microtasks settle */
  flush: (ms?: number) => Promise<void>;
  /** flush repeatedly until the predicate holds (or give up) */
  waitFor: (predicate: () => boolean, label?: string) => Promise<void>;
  /** replace the route table (used by checks that must mount before the fixture is known) */
  setRoutes: (next: Record<string, unknown | Responder>) => void;
  /** the last write to a path, e.g. `lastCall('PUT', '/api/layout')` */
  lastCall: (method: string, path: string) => Recorded | undefined;
  writes: (method: string, path: string) => Recorded[];
  unmount: () => Promise<void>;
}

export interface HarnessOptions {
  /** a route value, a responder, or `{ $status, body }` for a non-200 answer */
  routes?: Record<string, unknown | Responder>;
  /** called for unknown paths — the default answers 404 so a missing stub is visible */
  fallback?: (path: string) => unknown;
}

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

/**
 * A responder may return a plain body (200) or `{ $status, body }` to answer with a status —
 * that is how the harness tests what the app does with a 401 from a real server.
 */
const answer = (value: unknown) => {
  if (value && typeof value === 'object' && '$status' in (value as Record<string, unknown>)) {
    const { $status, body } = value as { $status: number; body: unknown };
    return json(body, $status);
  }
  return json(value);
};

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // every check starts from an empty cache, so "how many requests were made" means what it says
  resetSharedCache();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Recorded[] = [];
  const routes: Record<string, unknown | Responder> = { ...(options.routes || {}) };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = path.split('?')[0];
    const hit = Object.keys(routes)
      .filter((r) => key === r || path === r)
      .sort((a, b) => b.length - a.length)[0];
    if (hit == null) return json(options.fallback ? options.fallback(path) : { error: `no stub for ${path}` }, 404);
    const value = routes[hit];
    return answer(typeof value === 'function' ? (value as Responder)(body, path) : value);
  }) as typeof fetch;

  const root = createRoot(container);
  const flush = async (ms = 0) => {
    await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  };
  const mount = async (node: ReactNode) => {
    await act(async () => { root.render(node); });
    await flush(5);
  };
  const waitFor = async (predicate: () => boolean, label = 'condition') => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await flush(10);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const lastCall = (method: string, path: string) =>
    [...calls].reverse().find((c) => c.method === method && c.path === path);
  const writes = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
  };

  const setRoutes = (next: Record<string, unknown | Responder>) => {
    for (const key of Object.keys(routes)) delete routes[key];
    Object.assign(routes, next);
  };

  return { container, root, calls, mount, flush, waitFor, lastCall, writes, setRoutes, unmount };
}

/* ---------------- event helpers ---------------- */

/** Dispatch inside act() so React applies the update before the next assertion. */
function dispatch(target: EventTarget, ev: Event) {
  act(() => { target.dispatchEvent(ev); });
}

export function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  dispatch(target, ev);
  return ev;
}

/** React tracks its own value on inputs — go through the native setter, then fire `input`. */
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

export function click(el: Element) {
  dispatch(el, new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

/** Visible text of a node (Document.textContent is null per spec — read the body instead). */
export const text = (root: ParentNode = document.body) => (root.textContent || '').replace(/\s+/g, ' ');
export const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
