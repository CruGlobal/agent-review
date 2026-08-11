'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { upgradeConfig } = require('./upgradeConfig.cjs');
const { loadConfig } = require('./loadConfig.cjs');
const { detectSpecial } = require('./detectSpecial.cjs');

test('v1 legacy specials become generalized entries with legacy trigger data', () => {
  const v1 = {
    version: 1,
    risk: { special: [
      { when: 'supabase_migration_change', points: 3 },
      { when: 'next_config_security_change', points: 2 },
    ] },
  };
  const out = upgradeConfig(v1);
  assert.strictEqual(out.version, 2);
  assert.deepStrictEqual(out.risk.special, [
    { when: 'migration_change', points: 3, paths: ['supabase/migrations/**'] },
    { when: 'config_security_change', points: 2, files: ['next.config.{js,ts}'],
      keywords: ['headers', 'content-security', 'csp', 'rewrites', 'images', 'domains'] },
  ]);
  assert.deepStrictEqual(out.risk.manifests, ['package.json']);
  assert.deepStrictEqual(out.risk.lockfiles, ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']);
});

test('v2 config passes through unchanged', () => {
  const v2 = { version: 2, risk: { manifests: ['Cargo.toml'], special: [] } };
  assert.deepStrictEqual(upgradeConfig(v2), v2);
});

test('end-to-end: loadConfig upgrades the v1 wealthtracker fixture and restores special detection', () => {
  const configPath = path.join(__dirname, '../fixtures/wealthtracker/config.yml');
  const schemaPath = path.join(__dirname, '../schema/config.schema.json');
  const cfg = loadConfig({ configPath, schemaPath });

  assert.strictEqual(cfg.version, 2);

  const migrationFound = detectSpecial('', ['supabase/migrations/001.sql'], cfg);
  assert.deepStrictEqual(migrationFound, ['migration_change']);

  const configSecurityFound = detectSpecial(
    '+  headers() {\n',
    ['next.config.ts'],
    cfg,
  );
  assert.deepStrictEqual(configSecurityFound, ['config_security_change']);
});
