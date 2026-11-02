'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { CATEGORIES, CLEANUP_CATEGORIES } = require('./vocabulary.cjs');

test('cleanup categories are a subset of the nine categories', () => {
  assert.equal(CATEGORIES.length, 9);
  for (const c of CLEANUP_CATEGORIES) assert.ok(CATEGORIES.includes(c), c);
});

test('engine modules spell the engine name only in vocabulary.cjs', () => {
  const files = readdirSync(__dirname).filter(
    (f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs') && f !== 'vocabulary.cjs',
  );
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /['"]code-review['"]/, `${f} spells code-review`);
    assert.doesNotMatch(src, /['"]agent-review['"]/, `${f} spells agent-review`);
  }
});
