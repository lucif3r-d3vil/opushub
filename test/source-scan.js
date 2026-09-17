// A source scanner for the static security proofs.
//
// These proofs assert things like "no module contains `execSync`". That only makes sense over code,
// not over the prose around it, so comments have to be removed first. The obvious one-liner —
// `src.replace(/\/\*[\s\S]*?\*\//g, '')` — is not safe enough to build a proof on: a `/*` that
// appears inside a line comment or a string (a route glob written as `/api/v1/*` is enough) opens a
// "comment" that runs until the next unrelated `*/`, deleting everything in between. In
// server/api.js that single mistake swallowed 30% of the file, including the very
// `route === 'POST /api/setup'` lines the proof exists to check — it passed while looking at a
// file with the setup, auth, settings and layout routes missing.
//
// So this walks the file once, tracking strings, and only treats `//` or `/*` as a comment when it
// is genuinely in code. Regex literals are left alone: a `/` not followed by `/` or `*` is copied
// verbatim, which is correct for every expression in this codebase.
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null; // the opening quote character while inside a string
  let block = false;
  let line = false;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (line) {
      if (c === '\n') { line = false; out += c; }
      i += 1;
      continue;
    }
    if (block) {
      // replaced with a space, never '': two tokens either side of a comment must not be glued
      if (c === '*' && n === '/') { block = false; i += 2; out += ' '; continue; }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { if (n !== undefined) out += n; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i += 2; continue; }
    if (c === '/' && n === '*') { block = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}
