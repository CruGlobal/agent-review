'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectSpecial } = require('./detectSpecial.cjs');

const CFG = {
  risk: {
    manifests: ['package.json'],
    lockfiles: ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'],
    special: [
      { when: 'new_dependency', points: 2 },
      { when: 'critical_pkg_update', points: 3, packages: ['next'] },
      { when: 'lockfile_only_change', points: 1 },
      { when: 'migration_change', points: 3, paths: ['db/migrations/**'] },
      { when: 'config_security_change', points: 2, files: ['app.config.{js,ts}'], keywords: ['csp', 'headers'] },
    ],
  },
};

test('detects new dependency added to package.json', () => {
  assert.deepEqual(
    detectSpecial('+    "lodash": "^4.17.21",', ['package.json'], CFG),
    ['new_dependency'],
  );
});

test('detects critical package update', () => {
  const found = detectSpecial(
    '+    "next": "^14.0.0",',
    ['package.json'],
    CFG,
  );
  assert.ok(found.includes('critical_pkg_update'));
});

test('detects lockfile-only change', () => {
  assert.deepEqual(detectSpecial('+ some lock line', ['yarn.lock'], CFG), [
    'lockfile_only_change',
  ]);
});

test('migration_change fires from configured paths only', () => {
  assert.deepStrictEqual(detectSpecial('', ['db/migrations/001.sql'], CFG), ['migration_change']);
  assert.deepStrictEqual(detectSpecial('', ['supabase/migrations/001.sql'], CFG), []);
});

test('config_security_change needs configured file AND keyword', () => {
  assert.deepStrictEqual(detectSpecial('+ csp stuff', ['app.config.ts'], CFG), ['config_security_change']);
  assert.deepStrictEqual(detectSpecial('+ unrelated', ['app.config.ts'], CFG), []);
});

test('pnpm lockfile-only change fires', () => {
  assert.deepStrictEqual(detectSpecial('', ['pnpm-lock.yaml'], CFG), ['lockfile_only_change']);
});
