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
  assert.match(s, /usage: agent-review/);
});

test('no command prints usage', () => {
  const { code, s } = run([]);
  assert.equal(code, 0);
  assert.match(s, /usage: agent-review/);
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

// Self-contained stdout capture (works regardless of existing helpers in this file).
function captured(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => (chunks.push(String(s)), true);
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('');
}

test('usage names the agent-review binary', () => {
  const out = captured(() => main(['help']));
  assert.ok(out.includes('usage: agent-review <command>'));
  assert.ok(out.includes('plan --files'));
});

test('plan subcommand emits plan JSON', () => {
  const os = require('node:os');
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const root = mkdtempSync(join(os.tmpdir(), 'ar-'));
  mkdirSync(join(root, 'rd'), { recursive: true });
  writeFileSync(join(root, 'rd', 'config.yml'), [
    'version: 2', 'profile: standard',
    'risk:', '  patterns: []',
    '  volume_multiplier: [{ upTo: null, points: 0 }]',
    '  scope_multiplier: { single_feature: 1.0 }',
    '  special: []',
    '  levels: [{ range: [0, null], level: LOW, reviewer: entry }]',
    'agents:', '  - id: standards', '    always: true',
    'excluded_paths: []', '',
  ].join('\n'));
  const f = join(root, 'files.txt'); writeFileSync(f, 'src/a.ts\n');
  const d = join(root, 'diff.txt'); writeFileSync(d, '');
  const s = join(root, 'stat.txt'); writeFileSync(s, ' 1 file changed, 3 insertions(+)\n');
  const out = captured(() =>
    main(['plan', '--files', f, '--diff', d, '--stat', s, '--root', root, '--review-dir', 'rd']),
  );
  const plan = JSON.parse(out);
  assert.strictEqual(plan.profile, 'standard');
  assert.ok(Array.isArray(plan.agents));
  assert.strictEqual(plan.agents[0].id, 'standards');
});
