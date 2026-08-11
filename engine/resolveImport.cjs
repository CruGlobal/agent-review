'use strict';
const path = require('node:path');

// Defaults match a typical TS/Next repo; override per-repo via config `index.aliases`/`index.extensions`.
const DEFAULT_ALIASES = ['src/', 'pages/', '__tests__/'];
const DEFAULT_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.json'];

function candidates(base, exts = DEFAULT_EXTS) {
  const out = [base];
  for (const e of exts) out.push(base + e);
  for (const e of exts) out.push(base + '/index' + e);
  return out;
}

function resolveImport(fromFile, spec, fileSet, opts = {}) {
  const aliases =
    opts.aliases && opts.aliases.length ? opts.aliases : DEFAULT_ALIASES;
  const exts = opts.exts && opts.exts.length ? opts.exts : DEFAULT_EXTS;

  // Normalize aliases: convert strings to {prefix, target} objects
  const norm = aliases.map((a) =>
    typeof a === 'string' ? { prefix: a, target: a } : a,
  );

  let base;
  const hit = norm.find(
    (a) => spec === a.prefix.replace(/\/$/, '') || spec.startsWith(a.prefix),
  );

  if (hit) {
    base = hit.target + spec.slice(hit.prefix.length);
  } else if (spec.startsWith('.')) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), spec),
    );
  } else {
    return null; // bare / external
  }
  for (const c of candidates(base, exts)) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

module.exports = {
  resolveImport,
  candidates,
  DEFAULT_ALIASES,
  DEFAULT_EXTS,
  EXTS: DEFAULT_EXTS,
};
