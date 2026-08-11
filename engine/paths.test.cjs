'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { repoRoot, reviewDir } = require('./paths.cjs');

test('repoRoot: flag > env > cwd', () => {
  assert.strictEqual(repoRoot({ root: '/tmp/a' }), '/tmp/a');
  process.env.AGENT_REVIEW_ROOT = '/tmp/b';
  assert.strictEqual(repoRoot({}), '/tmp/b');
  delete process.env.AGENT_REVIEW_ROOT;
  assert.strictEqual(repoRoot({}), process.cwd());
});

test('reviewDir: relative resolves under root; absolute wins; default .claude/review', () => {
  assert.strictEqual(reviewDir({ root: '/tmp/a', reviewDir: '.review' }), join('/tmp/a', '.review'));
  assert.strictEqual(reviewDir({ root: '/tmp/a', reviewDir: '/abs/dir' }), '/abs/dir');
  assert.strictEqual(reviewDir({ root: '/tmp/a' }), join('/tmp/a', '.claude/review'));
});
