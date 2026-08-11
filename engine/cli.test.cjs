'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const {
  main,
  ctx,
  changedFiles,
  resolveMinSupport,
  planTmpPath,
} = require('./cli.cjs');
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

// --- Regression coverage for the audit fixes (base_branch, min_support, tmp-file collision) ---

// main <- release <- feature, one file added per branch, HEAD parked on `feature`.
function tmpGitRepo() {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-git-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), 'init\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', '-M', 'main');
  git('checkout', '-q', '-b', 'release');
  writeFileSync(join(root, 'release.txt'), 'r\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'release commit');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'feature.txt'), 'f\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature commit');
  return root;
}

test('changedFiles defaults to cfg.base_branch, or "main" when absent', () => {
  const root = tmpGitRepo();
  try {
    const C = ctx(['x', '--root', root]);
    const noCfg = changedFiles(undefined, C, {});
    assert.equal(noCfg.base, 'main');
    assert.deepEqual(noCfg.files.sort(), ['feature.txt', 'release.txt']);

    const withCfg = changedFiles(undefined, C, { base_branch: 'release' });
    assert.equal(withCfg.base, 'release');
    assert.deepEqual(withCfg.files, ['feature.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changedFiles falls back to HEAD~1 when the default base branch does not resolve', () => {
  const root = tmpGitRepo();
  try {
    const C = ctx(['x', '--root', root]);
    const r = changedFiles(undefined, C, { base_branch: 'does-not-exist' });
    assert.equal(r.base, 'HEAD~1');
    assert.deepEqual(r.files, ['feature.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changedFiles throws (no silent fallback) when an explicit --base fails to resolve', () => {
  const root = tmpGitRepo();
  try {
    const C = ctx(['x', '--root', root]);
    assert.throws(
      () => changedFiles('does-not-exist', C, {}),
      /could not determine a diff base/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMinSupport defaults from cfg.learning.min_support, else 3; explicit flag wins', () => {
  assert.deepEqual(resolveMinSupport({}, undefined), { minSupport: 3 });
  assert.deepEqual(
    resolveMinSupport({ learning: { min_support: 7 } }, undefined),
    { minSupport: 7 },
  );
  assert.deepEqual(
    resolveMinSupport({ learning: { min_support: 7 } }, '2'),
    { minSupport: 2 },
  );
});

test('resolveMinSupport rejects a non-positive-integer explicit value', () => {
  const r = resolveMinSupport({}, 'abc');
  assert.ok(r.error);
  assert.equal(r.minSupport, undefined);
});

test('planTmpPath is stable per ROOT, distinct across ROOTs, and namespaced', () => {
  const a1 = planTmpPath('/tmp/repo-a');
  const a2 = planTmpPath('/tmp/repo-a');
  const b = planTmpPath('/tmp/repo-b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /agent-review-plan-[0-9a-f]{12}\.json$/);
});
