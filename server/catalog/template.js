// Catalog templating — `${var}` substitution over DECLARED variables, and nothing else.
//
// A manifest may write `${PUID}` inside an env value, a port or a volume source; the value comes
// from the operator's install configuration (validated against the manifest's `variables`) or
// from the small fixed set of built-ins (`name`). There are no expressions, no defaults-in-place
// (`${VAR:-x}`), no nesting, no command substitution and no access to OpusHub's own environment.
// An undeclared reference is an error, never an empty string.
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** The variable names a string refers to. */
export function referencesOf(s) {
  const out = new Set();
  if (typeof s !== 'string') return out;
  for (const m of s.matchAll(REF_RE)) out.add(m[1]);
  return out;
}

/** Substitute. Returns `{ ok, value, missing }`. A lone `$` or `${` that is not a reference is kept literally. */
export function render(s, vars) {
  if (typeof s !== 'string') return { ok: true, value: s, missing: [] };
  const missing = [];
  const value = s.replace(REF_RE, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name) || vars[name] === undefined || vars[name] === null) { missing.push(name); return whole; }
    return String(vars[name]);
  });
  return { ok: missing.length === 0, value, missing };
}

/** Walk a plain JSON value (strings, arrays, objects) and render every string in it. */
export function renderDeep(value, vars, path = '') {
  if (typeof value === 'string') { const r = render(value, vars); return { ok: r.ok, value: r.value, missing: r.missing.map((m) => `${path || 'value'}: ${m}`) }; }
  if (Array.isArray(value)) {
    const out = []; const missing = [];
    value.forEach((v, i) => { const r = renderDeep(v, vars, `${path}[${i}]`); out.push(r.value); missing.push(...r.missing); });
    return { ok: missing.length === 0, value: out, missing };
  }
  if (value && typeof value === 'object') {
    const out = {}; const missing = [];
    for (const [k, v] of Object.entries(value)) { const r = renderDeep(v, vars, path ? `${path}.${k}` : k); out[k] = r.value; missing.push(...r.missing); }
    return { ok: missing.length === 0, value: out, missing };
  }
  return { ok: true, value, missing: [] };
}
