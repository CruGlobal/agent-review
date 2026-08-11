'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectSpecial } = require('./detectSpecial.cjs');

const config = {
  risk: {
    special: [
      {
        when: 'critical_pkg_update',
        points: 3,
        packages: ['next', '@supabase/supabase-js'],
      },
    ],
  },
};

test('detects new dependency added to package.json', () => {
  assert.deepEqual(
    detectSpecial('+    "lodash": "^4.17.21",', ['package.json'], config),
    ['new_dependency'],
  );
});

test('detects critical package update', () => {
  const found = detectSpecial(
    '+    "@supabase/supabase-js": "^2.0.0",',
    ['package.json'],
    config,
  );
  assert.ok(found.includes('critical_pkg_update'));
});

test('detects lockfile-only change', () => {
  assert.deepEqual(detectSpecial('+ some lock line', ['yarn.lock'], config), [
    'lockfile_only_change',
  ]);
});

test('detects supabase migration change and next.config security change', () => {
  const found = detectSpecial(
    '+ headers: [...]',
    ['next.config.ts', 'supabase/migrations/20260101_x.sql'],
    config,
  );
  assert.ok(found.includes('supabase_migration_change'));
  assert.ok(found.includes('next_config_security_change'));
});

test('detects supabase migration change', () => {
  const found = detectSpecial(
    '+ create table accounts ();',
    ['supabase/migrations/20260101_x.sql'],
    config,
  );
  assert.ok(found.includes('supabase_migration_change'));
});
