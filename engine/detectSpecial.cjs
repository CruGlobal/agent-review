'use strict';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectSpecial(diffText, changedFiles, config) {
  const found = new Set();
  const special = (config.risk && config.risk.special) || [];
  const pkgEntry = special.find((s) => s.when === 'critical_pkg_update');
  const pkgs = (pkgEntry && pkgEntry.packages) || [];

  const pkgChanged = changedFiles.includes('package.json');
  const lockChanged = changedFiles.some((f) => f.endsWith('yarn.lock'));

  if (pkgChanged && /^\+\s*"[^"]+":\s*"[^"]+"/m.test(diffText))
    found.add('new_dependency');

  if (pkgChanged) {
    for (const p of pkgs) {
      if (new RegExp(`^\\+\\s*"${escapeRe(p)}":`, 'm').test(diffText)) {
        found.add('critical_pkg_update');
        break;
      }
    }
  }

  if (lockChanged && !pkgChanged) found.add('lockfile_only_change');

  if (changedFiles.some((f) => /supabase\/migrations\//.test(f)))
    found.add('supabase_migration_change');

  if (
    changedFiles.some((f) => /next\.config\.(js|ts)$/.test(f)) &&
    /(headers|content-security|csp|rewrites|images|domains)/i.test(diffText)
  ) {
    found.add('next_config_security_change');
  }

  return [...found];
}

module.exports = { detectSpecial };
