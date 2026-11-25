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

// The env fallback is the middle branch of `opts.reviewDir || env || default`. Nothing else covers
// it, so it could be dropped or lose to the default with the rest of the suite still green.
function withReviewDirEnv(value, fn) {
  const original = process.env.AGENT_REVIEW_DIR;
  if (value === undefined) delete process.env.AGENT_REVIEW_DIR;
  else process.env.AGENT_REVIEW_DIR = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.AGENT_REVIEW_DIR;
    else process.env.AGENT_REVIEW_DIR = original;
  }
}

test('reviewDir: AGENT_REVIEW_DIR relocates the review dir when no flag is given', () => {
  withReviewDirEnv('.relocated', () => {
    assert.strictEqual(reviewDir({ root: '/tmp/a' }), join('/tmp/a', '.relocated'));
  });
  withReviewDirEnv('/abs/from-env', () => {
    assert.strictEqual(reviewDir({ root: '/tmp/a' }), '/abs/from-env');
  });
});

test('reviewDir: explicit reviewDir beats AGENT_REVIEW_DIR, which beats the built-in default', () => {
  withReviewDirEnv('.from-env', () => {
    assert.strictEqual(reviewDir({ root: '/tmp/a', reviewDir: '.from-flag' }), join('/tmp/a', '.from-flag'));
    assert.strictEqual(reviewDir({ root: '/tmp/a' }), join('/tmp/a', '.from-env'));
  });
  withReviewDirEnv(undefined, () => {
    assert.strictEqual(reviewDir({ root: '/tmp/a' }), join('/tmp/a', '.claude/review'));
  });
});

test('reviewDir: the env override does not leak out of the test', () => {
  const before = process.env.AGENT_REVIEW_DIR;
  withReviewDirEnv('.temp', () => {});
  assert.strictEqual(process.env.AGENT_REVIEW_DIR, before);
});
