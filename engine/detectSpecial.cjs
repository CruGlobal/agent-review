'use strict';
const { minimatch } = require('minimatch');
const OPTS = { dot: true };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectSpecial(diffText, changedFiles, config) {
  const found = new Set();
  const risk = (config && config.risk) || {};
  const special = risk.special || [];
  const by = (w) => special.find((s) => s.when === w);

  const manifests = risk.manifests || ['package.json'];
  const lockfiles = risk.lockfiles || ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'];
  const isOneOf = (f, names) => names.some((n) => f === n || f.endsWith('/' + n));
  const manifestChanged = changedFiles.some((f) => isOneOf(f, manifests));
  const lockChanged = changedFiles.some((f) => isOneOf(f, lockfiles));

  if (by('new_dependency') && manifestChanged && /^\+\s*"[^"]+":\s*"[^"]+"/m.test(diffText))
    found.add('new_dependency');

  const pkgEntry = by('critical_pkg_update');
  if (pkgEntry && manifestChanged) {
    for (const p of pkgEntry.packages || []) {
      if (new RegExp(`^\\+\\s*"${escapeRe(p)}":`, 'm').test(diffText)) {
        found.add('critical_pkg_update');
        break;
      }
    }
  }

  if (by('lockfile_only_change') && lockChanged && !manifestChanged)
    found.add('lockfile_only_change');

  const mig = by('migration_change');
  if (mig && changedFiles.some((f) => (mig.paths || []).some((g) => minimatch(f, g, OPTS))))
    found.add('migration_change');

  const sec = by('config_security_change');
  if (
    sec &&
    changedFiles.some((f) => (sec.files || []).some((g) => minimatch(f, g, OPTS))) &&
    (sec.keywords || []).length &&
    new RegExp(`(${(sec.keywords || []).map(escapeRe).join('|')})`, 'i').test(diffText)
  )
    found.add('config_security_change');

  return [...found];
}

module.exports = { detectSpecial };
