'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main, ctx } = require('./cli.cjs');
const { buildPlan } = require('./plan.cjs');

function run(args) {
  const orig = process.stdout.write.bind(process.stdout);
  let s = '';
  process.stdout.write = (x) => {
    s += x;
    return true;
  };
  let code;
  try {
    code = main(args);
  } finally {
    process.stdout.write = orig;
  }
  return { code, s };
}

test('help returns 0 and prints usage', () => {
  const { code, s } = run(['help']);
  assert.equal(code, 0);
  assert.match(s, /usage: yarn review/);
});

test('no command prints usage', () => {
  const { code, s } = run([]);
  assert.equal(code, 0);
  assert.match(s, /usage: yarn review/);
});

test('unknown command returns 1', () => {
  const { code, s } = run(['definitely-not-a-command']);
  assert.equal(code, 1);
  assert.match(s, /unknown command/);
});

test('ctx() derives reviewDirRel relative to ROOT from --review-dir', () => {
  const C = ctx(['run', '--root', '/tmp/some-repo', '--review-dir', '.review']);
  assert.equal(C.ROOT, '/tmp/some-repo');
  assert.equal(C.reviewDirRel, '.review');
});

test('ctx() defaults reviewDirRel to .claude/review when --review-dir is absent', () => {
  const C = ctx(['run', '--root', '/tmp/some-repo']);
  assert.equal(C.reviewDirRel, '.claude/review');
});

// Regression coverage for the `run` command's wiring: cli.cjs's `run` case passes
// `reviewDirRel: C.reviewDirRel` into buildPlan's input object (see engine/cli.cjs, the `run`
// case). This reproduces that exact call shape — with a custom review dir, the reviewer's own
// config.yml content (trigger vocabulary as data) must NOT falsely self-select agents via a
// content trigger.
test('ctx()-derived reviewDirRel reaches buildPlan and suppresses self-match under a custom review dir', () => {
  const config = {
    profile: 'standard',
    excluded_paths: [],
    risk: {
      patterns: [],
      volume_multiplier: [{ upTo: null, points: 0 }],
      scope_multiplier: { single_feature: 1.0 },
      special: [],
      levels: [{ range: [0, null], level: 'LOW', reviewer: 'entry' }],
    },
    agents: [
      {
        id: 'security',
        triggers: { content: ['process.env.'] },
        rules: [],
      },
    ],
  };
  const diff =
    'diff --git a/.review/config.yml b/.review/config.yml\n' +
    '+triggers: [process.env.]\n';

  const C = ctx(['run', '--root', '/tmp/some-repo', '--review-dir', '.review']);
  const plan = buildPlan(
    {
      files: ['.review/config.yml'],
      diffText: diff,
      linesChanged: 1,
      scope: 'single_feature',
      reviewDirRel: C.reviewDirRel,
    },
    config,
  );
  assert.ok(
    !plan.agents.some((a) => a.id === 'security'),
    'security must not self-select on the reviewer\'s own config content under a custom review dir',
  );
});
