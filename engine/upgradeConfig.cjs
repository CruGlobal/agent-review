'use strict';
// Normalizes a v1 config to v2 in memory. v1 stays valid on disk forever;
// `agent-review init --migrate` (skill-level) rewrites the file using this mapping.
const LEGACY = {
  supabase_migration_change: (s) => ({ when: 'migration_change', points: s.points, paths: ['supabase/migrations/**'] }),
  next_config_security_change: (s) => ({
    when: 'config_security_change', points: s.points,
    files: ['next.config.{js,ts}'],
    keywords: ['headers', 'content-security', 'csp', 'rewrites', 'images', 'domains'],
  }),
};

function upgradeConfig(cfg) {
  if (cfg.version !== 1) return cfg;
  const risk = { ...(cfg.risk || {}) };
  risk.manifests = risk.manifests || ['package.json'];
  risk.lockfiles = risk.lockfiles || ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'];
  risk.special = (risk.special || []).map((s) => (LEGACY[s.when] ? LEGACY[s.when](s) : s));
  return { ...cfg, version: 2, risk };
}

module.exports = { upgradeConfig };
