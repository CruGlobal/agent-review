'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  lstatSync,
} = require('node:fs');
const { join, relative } = require('node:path');
const os = require('node:os');
const {
  main,
  ctx,
  changedFiles,
  resolveMinSupport,
  planTmpPath,
  readTranscript,
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
      // Zero-point pattern for the reviewer's own config path: keeps this file
      // out of the unmatched-coverage guarantee's floor (Task 1) so this test
      // isolates only what it's meant to check — content self-match suppression.
      patterns: [{ glob: '.review/**', points: 0, tier: 'low' }],
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

test('plan subcommand rejects an unknown --mode', () => {
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
  const { code, s: text } = run([
    'plan', '--files', f, '--diff', d, '--stat', s,
    '--root', root, '--review-dir', 'rd', '--mode', 'bananas',
  ]);
  assert.strictEqual(code, 1);
  assert.match(text, /unknown mode "bananas"/);
});

test('slice subcommand writes per-agent diff files and prints a JSON manifest', () => {
  const { readFileSync, existsSync } = require('node:fs');
  const root = mkdtempSync(join(os.tmpdir(), 'ar-slice-'));
  const diff = [
    'diff --git a/src/api/users.js b/src/api/users.js',
    'index 1111111..2222222 100644',
    '--- a/src/api/users.js',
    '+++ b/src/api/users.js',
    '@@ -1,2 +1,3 @@',
    ' function getUser() {',
    '+  const k = process.env.SECRET;',
    ' }',
    '',
  ].join('\n');
  const plan = {
    profile: 'standard',
    agents: [
      { id: 'architecture', escalates: true, always: true, triggers: undefined },
      { id: 'security', escalates: false, always: false, triggers: { content: ['process.env.'] } },
      { id: 'financial', escalates: false, always: false, triggers: { paths: ['src/finance/**'] } },
    ],
  };
  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const diffPath = join(root, 'diff.txt');
  writeFileSync(diffPath, diff);
  const outDir = join(root, 'slices');
  const { code, s } = run(['slice', '--plan', planPath, '--diff', diffPath, '--out-dir', outDir]);
  assert.equal(code, 0);
  const manifest = JSON.parse(s);
  assert.deepEqual(manifest, {
    architecture: { mode: 'full', files: 1, hunks: 1 },
    security: { mode: 'sliced', files: 1, hunks: 1 },
    financial: { mode: 'empty', files: 0, hunks: 0 },
  });
  assert.equal(readFileSync(join(outDir, 'architecture.diff'), 'utf8'), diff);
  assert.ok(readFileSync(join(outDir, 'security.diff'), 'utf8').includes('process.env.SECRET'));
  assert.ok(existsSync(join(outDir, 'financial.diff')));
  assert.equal(readFileSync(join(outDir, 'financial.diff'), 'utf8'), '');
  rmSync(root, { recursive: true, force: true });
});

test('slice subcommand requires --plan, --diff, and --out-dir', () => {
  const { code, s } = run(['slice']);
  assert.equal(code, 1);
  assert.match(s, /usage: agent-review slice/);
});

test('slice subcommand refuses an agent id that would escape --out-dir', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-slice-unsafe-'));
  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ agents: [{ id: '../evil', always: true }] }));
  const diffPath = join(root, 'diff.txt');
  writeFileSync(diffPath, '');
  const { code, s } = run(['slice', '--plan', planPath, '--diff', diffPath, '--out-dir', join(root, 'out')]);
  assert.equal(code, 1);
  assert.match(s, /unsafe agent id/);
  rmSync(root, { recursive: true, force: true });
});

test('address subcommands prepare, validate, emit feedback, and finalize through the CLI', () => {
  const { mkdirSync, readFileSync } = require('node:fs');
  const root = mkdtempSync(join(os.tmpdir(), 'ar-address-'));
  try {
    const files = Object.fromEntries(
      ['command.txt', 'report.md', 'request.json', 'result.json', 'changed.json', 'address.patch']
        .map((name) => [name, join(root, name)]),
    );
    const finding = {
      n: 1, id: 'f1', signature: 'sig-1', agent: 'security', category: 'auth',
      severity: 9, file: 'src/auth.js', line: 4, message: 'missing authorization', status: 'open',
    };
    const status = { v: 1, head: 'a'.repeat(40), risk: 'HIGH', openBlockers: 1, pass: false, irreversible: false, irreversibleReasons: [] };
    const report = [
      '<!-- agent-review -->',
      `<!-- agent-review-ledger: ${JSON.stringify([finding])} -->`,
      `<!-- agent-review-status: ${JSON.stringify(status)} -->`,
      '- [ ] **#1** · 9/10 · `src/auth.js:4` — missing authorization _(security)_',
      '',
    ].join('\n');
    writeFileSync(files['command.txt'], '@claude fix 1\n');
    writeFileSync(files['report.md'], report);

    const prepared = run([
      'address', 'prepare', '--command', files['command.txt'], '--report', files['report.md'],
      '--actor', 'maintainer', '--pr', '7', '--comment-id', '8', '--report-comment-id', '9',
      '--head', 'a'.repeat(40), '--root', root,
    ]);
    assert.equal(prepared.code, 0);
    writeFileSync(files['request.json'], prepared.s);
    writeFileSync(files['result.json'], JSON.stringify({
      version: 1,
      expectedHead: 'a'.repeat(40),
      fixes: [{ n: 1, status: 'applied', files: ['src/auth.js'], summary: 'added the guard' }],
      tests: [{ command: 'npm test', status: 'passed' }],
    }));
    writeFileSync(files['changed.json'], JSON.stringify(['src/auth.js']));
    writeFileSync(files['address.patch'], 'diff --git a/src/auth.js b/src/auth.js\n');

    const validated = run([
      'address', 'validate', '--request', files['request.json'], '--result', files['result.json'],
      '--changed-files', files['changed.json'], '--patch', files['address.patch'], '--root', root,
    ]);
    assert.equal(JSON.parse(validated.s).fixes[0].status, 'applied');
    const feedback = run([
      'address', 'feedback', '--request', files['request.json'], '--result', files['result.json'],
      '--root', root,
    ]);
    assert.equal(JSON.parse(feedback.s).outcome, 'accepted');

    const output = join(root, 'final');
    mkdirSync(output);
    const finalized = run([
      'address', 'finalize', '--request', files['request.json'], '--result', files['result.json'],
      '--report', files['report.md'], '--out-dir', output, '--fix-sha', 'b'.repeat(40), '--root', root,
    ]);
    assert.equal(JSON.parse(finalized.s).pass, true);
    assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /fixed in bbbbbbb/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

function writeMinimalConfig(root) {
  const dir = join(root, '.claude', 'review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), [
    'version: 2', 'profile: standard',
    'risk:', '  patterns: []',
    '  volume_multiplier: [{ upTo: null, points: 0 }]',
    '  scope_multiplier: { single_feature: 1.0 }',
    '  special: []',
    '  levels: [{ range: [0, null], level: LOW, reviewer: entry }]',
    'agents:', '  - id: standards', '    always: true',
    'excluded_paths: []', '',
  ].join('\n'));
}

// Regression coverage: `run`'s positional mode arg used to be validated against MODES
// but never actually passed into buildPlan's input object, so plan.mode was always the
// buildPlan default ('standard') regardless of what was requested on the command line.
test('run <mode> passes the requested mode through to buildPlan, visible in both the preflight output and the tmp plan file', () => {
  const root = tmpGitRepo();
  try {
    writeMinimalConfig(root);
    const { code, s } = run(['run', '--root', root, '--no-launch', 'quick']);
    assert.equal(code, 0);
    assert.match(s, /mode: quick/);
    const plan = JSON.parse(readFileSync(planTmpPath(root), 'utf8'));
    assert.equal(plan.mode.requested, 'quick');
    assert.equal(plan.mode.resolved, 'quick');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run auto is accepted (MODES gains auto) and the requested mode reaches buildPlan', () => {
  const root = tmpGitRepo();
  try {
    writeMinimalConfig(root);
    const { code, s } = run(['run', '--root', root, '--no-launch', 'auto']);
    assert.equal(code, 0);
    assert.ok(!/unknown mode/.test(s));
    const plan = JSON.parse(readFileSync(planTmpPath(root), 'utf8'));
    assert.equal(plan.mode.requested, 'auto');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run still rejects an unrecognized mode', () => {
  const root = tmpGitRepo();
  try {
    writeMinimalConfig(root);
    const { code, s } = run(['run', '--root', root, '--no-launch', 'bananas']);
    assert.equal(code, 1);
    assert.match(s, /unknown mode "bananas"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeEngineConfig(root, engineName) {
  const dir = join(root, '.claude', 'review');
  mkdirSync(dir, { recursive: true });
  const lanes = ['security', 'testing', 'standards', 'architecture', 'simplification'];
  writeFileSync(join(dir, 'config.yml'), [
    'version: 2', 'profile: standard',
    'risk:', '  patterns: []',
    '  volume_multiplier: [{ upTo: null, points: 0 }]',
    '  scope_multiplier: { single_feature: 1.0 }',
    '  special: []',
    '  levels: [{ range: [0, null], level: LOW, reviewer: entry }]',
    'agents:', ...lanes.flatMap((id) => [`  - id: ${id}`, '    always: true']),
    `engine: { name: ${engineName} }`,
    'excluded_paths: []', '',
  ].join('\n'));
}

test('run plans with the review options, so a code-review repo previews and saves its own lanes', () => {
  const root = tmpGitRepo();
  try {
    writeEngineConfig(root, 'code-review');
    const { code, s } = run(['run', '--root', root, '--no-launch', 'quick']);
    assert.equal(code, 0, s);
    const plan = JSON.parse(readFileSync(planTmpPath(root), 'utf8'));
    assert.equal(plan.engine.name, 'code-review');
    assert.deepEqual(plan.agents.map((a) => a.id), ['code-review', 'security', 'testing', 'standards']);
    assert.equal(plan.mode.requested, 'quick');
    assert.match(s, /^ {2}- code-review \[engine\]$/m);
    assert.doesNotMatch(s, /- architecture \[/);

    writeEngineConfig(root, 'agent-review');
    const plain = run(['run', '--root', root, '--no-launch']);
    assert.equal(plain.code, 0, plain.s);
    const defaultPlan = JSON.parse(readFileSync(planTmpPath(root), 'utf8'));
    assert.equal('engine' in defaultPlan, false, 'the agent-review engine plan has no engine block');
    assert.ok(defaultPlan.agents.some((a) => a.id === 'architecture'));
    assert.equal(defaultPlan.agents.some((a) => a.id === 'code-review'), false);
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

test('approval subcommand judges a report file against a head SHA', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-approval-'));
  const head = 'abc123def4567890abc123def4567890abc12345';
  const file = join(dir, 'report.md');
  writeFileSync(file, [
    '<!-- agent-review -->',
    '<!-- agent-review-rollout: advisory -->',
    `<!-- agent-review-head: ${head} -->`,
    `<!-- agent-review-status: ${JSON.stringify({ v: 1, head, pass: true, irreversible: false })} -->`,
    '',
    'report',
  ].join('\n'));
  const ok = run(['approval', '--report', file, '--head', head]);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.s), {
    approve: true,
    reason: `report for ${head} passes with no open blockers and the change is reversible`,
  });
  const stale = run(['approval', '--report', file, '--head', '0000000000000000000000000000000000000000']);
  assert.equal(stale.code, 0);
  assert.equal(JSON.parse(stale.s).approve, false);
  const usage = run(['approval', '--report', file]);
  assert.equal(usage.code, 1);
  assert.match(usage.s, /usage: agent-review approval/);
  rmSync(dir, { recursive: true, force: true });
});

test('address parse prints lenient operations and rejects bare dismissals in strict mode', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-parse-'));
  const cmd = join(dir, 'cmd.txt');
  writeFileSync(cmd, 'fix: 1,2 dimiss 3');
  const ledger = join(dir, 'ledger.json');
  writeFileSync(ledger, JSON.stringify([{ n: 1, severity: 8, status: 'open' }, { n: 2, severity: 3, status: 'open' }, { n: 3, severity: 7, status: 'open' }]));
  const ok = run(['address', 'parse', '--command', cmd, '--lenient']);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.s).map((o) => [o.n, o.action, o.reasonCode]), [[1, 'fix', undefined], [2, 'fix', undefined], [3, 'dismiss', null]]);
  writeFileSync(cmd, 'fix blockers');
  const blockers = run(['address', 'parse', '--command', cmd, '--lenient', '--ledger', ledger]);
  assert.deepEqual(JSON.parse(blockers.s).map((o) => o.n), [1, 3]);
  writeFileSync(cmd, 'dismiss 3');
  const strict = run(['address', 'parse', '--command', cmd]);
  assert.equal(strict.code, 1);
  assert.match(strict.s, /invalid address syntax/);
  rmSync(dir, { recursive: true, force: true });
});

function optionsRoot() {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-opt-'));
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
  return root;
}

test('options prints resolved JSON', () => {
  const root = optionsRoot();
  const { code, s } = run(['options', '--args', 'deep engine=agent-review', '--root', root, '--review-dir', 'rd']);
  rmSync(root, { recursive: true, force: true });
  assert.equal(code, 0);
  const r = JSON.parse(s);
  assert.equal(r.engine.value, 'agent-review');
  assert.equal(r.mode.value, 'deep');
});

test('options reports errors', () => {
  const root = optionsRoot();
  const { code, s } = run(['options', '--args', 'effort=extreme', '--root', root, '--review-dir', 'rd']);
  rmSync(root, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(s, /^error: /);
});

test('a code-review config with a disabled default lane fails only config validate and the code-review engine', () => {
  const root = optionsRoot();
  const configPath = join(root, 'rd', 'config.yml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8')
      .replace('agents:\n  - id: standards\n    always: true\n', 'agents:\n  - id: standards\n    always: true\n  - id: security\n    enabled: false\n')
      .concat('rollout:\n  mode: advisory\nengine:\n  name: code-review\n'),
  );
  const at = ['--root', root, '--review-dir', 'rd'];
  try {
    const mode = run(['config', 'get', 'rollout.mode', ...at]);
    assert.equal(mode.code, 0, mode.s);
    assert.equal(mode.s, 'advisory\n');

    const fallback = run(['options', '--args', 'engine=agent-review', ...at]);
    assert.equal(fallback.code, 0, fallback.s);
    assert.equal(JSON.parse(fallback.s).engine.value, 'agent-review');

    const ci = run(['options', '--args', '', '--ci', ...at]);
    assert.equal(ci.code, 0, ci.s);

    const validate = run(['config', 'validate', ...at]);
    assert.equal(validate.code, 1);
    assert.equal(
      validate.s,
      `Invalid review config (${configPath}):\n` +
        '- engine.code_review.always references disabled agent: security\n' +
        '- engine.code_review.always references unknown agent: testing\n',
    );

    const engine = run(['options', '--args', '', ...at]);
    assert.equal(engine.code, 1);
    assert.match(engine.s, /^error: engine\.code_review\.always lists "security"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the reserved code-review id fails config validate only under the code-review engine', () => {
  const root = optionsRoot();
  const configPath = join(root, 'rd', 'config.yml');
  const base = readFileSync(configPath, 'utf8').replace(
    'agents:\n  - id: standards\n    always: true\n',
    'agents:\n  - id: standards\n    always: true\n  - id: security\n  - id: testing\n  - id: code-review\n',
  );
  const at = ['--root', root, '--review-dir', 'rd'];
  try {
    writeFileSync(configPath, base);
    const plain = run(['config', 'validate', ...at]);
    assert.equal(plain.code, 0, plain.s);
    assert.equal(plain.s, 'config OK\n');
    assert.equal(run(['options', '--args', '', ...at]).code, 0, 'the default engine runs the lane as before');

    writeFileSync(configPath, `${base}engine:\n  name: code-review\n`);
    const validate = run(['config', 'validate', ...at]);
    assert.equal(validate.code, 1);
    assert.equal(validate.s, `Invalid review config (${configPath}):\n- agent id "code-review" is reserved for the code-review engine\n`);
    assert.equal(run(['config', 'get', 'profile', ...at]).code, 0, 'other commands still load it');
    const engine = run(['options', '--args', '', ...at]);
    assert.equal(engine.code, 1);
    assert.equal(engine.s, 'error: agent id "code-review" is reserved for the code-review engine\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function startupRoot({ reviewsRun, workflows = [] } = {}) {
  const root = optionsRoot();
  if (reviewsRun) {
    const configPath = join(root, 'rd', 'config.yml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}reviews_run: ${reviewsRun}\n`);
  }
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const name of workflows) writeFileSync(join(root, '.github/workflows', name), 'name: x\n');
  const options = run(['options', '--args', 'auto', '--root', root, '--review-dir', 'rd']);
  writeFileSync(join(root, 'options.json'), options.s);
  writeFileSync(join(root, 'plan.json'), JSON.stringify({
    mode: { requested: 'auto', resolved: 'skip' },
    agents: [{ id: 'standards', matchedBy: 'always' }],
  }));
  return root;
}

const startupArgs = (root, ...extra) => [
  'startup', '--options', join(root, 'options.json'), '--plan', join(root, 'plan.json'),
  '--root', root, '--review-dir', 'rd', ...extra,
];

test('startup --mode shows the final mode, and a real skip lists no reviewers', () => {
  const root = startupRoot();
  try {
    const skip = run(startupArgs(root, '--mode', 'skip'));
    assert.equal(skip.code, 0, skip.s);
    const [l1, l2] = skip.s.split('\n');
    assert.match(l1, / · mode: auto → skip · /);
    assert.equal(l2, 'reviewers: none (no-risk diff skipped)');

    const standard = run(startupArgs(root, '--mode', 'standard'));
    assert.equal(standard.code, 0, standard.s);
    assert.match(standard.s, / · mode: auto → standard · /);
    assert.match(standard.s.split('\n')[1], /^reviewers: standards \[always\]/);

    const bad = run(startupArgs(root, '--mode', 'auto'));
    assert.equal(bad.code, 1);
    assert.equal(bad.s, 'error: unknown final mode "auto" (use skip/quick/standard/deep)\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup notes leftover CI files when any of the three CI workflows remains', () => {
  const NOTE = 'note: this repo is local-only but still has CI review workflows';
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml']) {
    const root = startupRoot({ reviewsRun: 'local', workflows: [name, 'agent-review-approve.yml'] });
    try {
      const r = run(startupArgs(root, '--mode', 'standard'));
      assert.equal(r.code, 0, r.s);
      assert.ok(r.s.includes(NOTE), name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const approveOnly = startupRoot({ reviewsRun: 'local', workflows: ['agent-review-approve.yml'] });
  try {
    assert.ok(!run(startupArgs(approveOnly, '--mode', 'standard')).s.includes(NOTE), 'the approve workflow is not a CI review');
  } finally {
    rmSync(approveOnly, { recursive: true, force: true });
  }
});

test('code-review-proof reads a bare finding on an existing extensionless file under --root', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-crproof-root-'));
  try {
    const raw = join(root, 'raw.txt');
    writeFileSync(raw, 'Skill "code-review" completed (forked execution).\n\nResult:\nMakefile:12 - the test target skips lint\nsrc/a.js:4 - a real one\n');
    const missing = run(['code-review-proof', '--raw', raw, '--root', root]);
    assert.deepEqual(JSON.parse(missing.s), { ok: true, reason: 'ok', count: 1 }, 'no Makefile, so only the path-like line counts');
    writeFileSync(join(root, 'Makefile'), 'all:\n');
    const present = run(['code-review-proof', '--raw', raw, '--root', root]);
    assert.deepEqual(JSON.parse(present.s), { ok: true, reason: 'ok', count: 2 });
    mkdirSync(join(root, 'Dir'));
    writeFileSync(raw, 'Skill "code-review" completed (forked execution).\n\nResult:\nDir:3 - a directory\n');
    assert.equal(run(['code-review-proof', '--raw', raw, '--root', root]).code, 1, 'a directory is not a file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('code-review-proof exit codes', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-'));
  try {
    const findings = [
      { file: 'a.js', line: 1, summary: 's', failure_scenario: 'f' },
      { file: 'b.js', line: 2, summary: 's', failure_scenario: 'f' },
    ];
    const file = join(dir, 'raw.txt');
    writeFileSync(
      file,
      `Skill "code-review" completed (forked execution).\n\nResult:\nProse.\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n`,
    );
    const ok = run(['code-review-proof', '--raw', file]);
    assert.equal(ok.code, 0);
    const parsed = JSON.parse(ok.s);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.count, 2);

    const missing = run(['code-review-proof', '--raw', join(dir, 'nope.txt')]);
    assert.equal(missing.code, 1);
    const bad = JSON.parse(missing.s);
    assert.equal(bad.ok, false);
    assert.equal(bad.count, 0);
    assert.match(bad.reason, /did not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof checks found = scored + dropped when given both files', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-'));
  try {
    const raw = join(dir, 'raw.txt');
    const lane = join(dir, 'code-review.json');
    const dropped = join(dir, 'dropped.json');
    const findings = [{ file: 'a.js', line: 1 }, { file: 'b.js', line: 2 }];
    writeFileSync(raw, `Skill "code-review" completed (forked execution).\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n`);
    writeFileSync(lane, JSON.stringify({ findings: [{ agent: 'code-review', category: 'correctness', severity: 8, file: 'a.js', line: 1 }] }));
    writeFileSync(dropped, JSON.stringify([{ file: 'b.js', line: 2, summary: 's', proof: 'p' }]));

    const ok = run(['code-review-proof', '--raw', raw, '--findings', lane, '--dropped', dropped]);
    assert.equal(ok.code, 0, ok.s);
    assert.deepEqual(JSON.parse(ok.s), { ok: true, reason: 'ok', count: 2 });

    const omitted = run(['code-review-proof', '--raw', raw, '--findings', lane, '--dropped', join(dir, 'none.json')]);
    assert.equal(omitted.code, 1);
    const bad = JSON.parse(omitted.s);
    assert.equal(bad.ok, false);
    assert.equal(bad.count, 2);
    assert.match(bad.reason, /found 2, but the lane scored 1 and dropped 0/);

    const emptyDrop = join(dir, 'empty-drop.json');
    writeFileSync(emptyDrop, JSON.stringify([{}]));
    const unproven = run(['code-review-proof', '--raw', raw, '--findings', lane, '--dropped', emptyDrop]);
    assert.equal(unproven.code, 1, 'a drop with no file, line, summary, or proof fails even when the counts add up');
    assert.match(JSON.parse(unproven.s).reason, /dropped entry 1 needs a non-empty string file/);

    const lone = run(['code-review-proof', '--raw', raw, '--findings', lane]);
    assert.equal(lone.code, 1);
    assert.match(lone.s, /^usage: agent-review code-review-proof --raw <f> \[--findings <f> --dropped <f>\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof reads excluded_paths from the repo config', () => {
  const root = optionsRoot();
  const configPath = join(root, 'rd', 'config.yml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('excluded_paths: []', 'excluded_paths: ["dist/**"]'));
  try {
    const raw = join(root, 'raw.txt');
    const lane = join(root, 'code-review.json');
    const dropped = join(root, 'dropped.json');
    const findings = [{ file: 'dist/app.js', line: 4 }, { file: 'src/a.js', line: 2 }];
    writeFileSync(raw, `Skill "code-review" completed (forked execution).\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n`);
    writeFileSync(lane, JSON.stringify({ findings: [{ agent: 'code-review', category: 'correctness', severity: 5, file: 'src/a.js', line: 2 }] }));
    writeFileSync(dropped, JSON.stringify([{ file: 'dist/app.js', line: 4, summary: 's', proof: 'excluded path: dist/**' }]));
    const args = ['code-review-proof', '--raw', raw, '--findings', lane, '--dropped', dropped];

    const ok = run([...args, '--root', root, '--review-dir', 'rd']);
    assert.equal(ok.code, 0, ok.s);
    assert.deepEqual(JSON.parse(ok.s), { ok: true, reason: 'ok', count: 2 });

    const otherDir = run([...args, '--root', root, '--review-dir', 'nowhere']);
    assert.equal(otherDir.code, 1, 'with no config there are no excluded paths');
    assert.match(JSON.parse(otherDir.s).reason, /cites excluded path "dist\/\*\*", which is not in the config's excluded_paths/);

    writeFileSync(configPath, 'version: [');
    const broken = run([...args, '--root', root, '--review-dir', 'rd']);
    assert.equal(broken.code, 1);
    const reason = JSON.parse(broken.s).reason;
    assert.match(reason, /^could not read excluded_paths from the review config: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger --match-suggestions-by-location skips reworded suggestions; without it the merge is unchanged', () => {
  const { mergeLedger } = require('./reportState.cjs');
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-ledger-'));
  try {
    const previous = [{
      n: 1, signature: 'old-sig', agent: 'code-review', category: 'correctness',
      severity: 5, file: 'a.rb', line: 10, message: 'old words here', status: 'open',
    }];
    const findings = { kept: [{
      signature: 'new-sig', agent: 'code-review', category: 'correctness',
      severity: 4, file: 'a.rb', line: 12, message: 'new words here',
    }] };
    const prevPath = join(dir, 'previous.json');
    const findingsPath = join(dir, 'findings.json');
    writeFileSync(prevPath, JSON.stringify(previous));
    writeFileSync(findingsPath, JSON.stringify(findings));

    const plain = run(['ledger', '--findings', findingsPath, '--previous', prevPath]);
    assert.equal(plain.code, 0);
    assert.equal(plain.s, JSON.stringify(mergeLedger(previous, findings), null, 2) + '\n');
    assert.deepEqual(JSON.parse(plain.s).map((entry) => entry.n), [1, 2]);

    const byLocation = run(['ledger', '--findings', findingsPath, '--previous', prevPath, '--match-suggestions-by-location']);
    assert.equal(byLocation.code, 0);
    assert.deepEqual(JSON.parse(byLocation.s).map((entry) => entry.n), [1]);

    const help = run(['help']);
    assert.match(help.s, /^ {2}ledger --findings <f> \[--previous <f>\] \[--match-suggestions-by-location\] {3}/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CLI = join(__dirname, 'cli.cjs');

function spawnCli(args, { dir, input = '' }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readCaptureJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

function armCapture(dir, args = 'xhigh 12') {
  writeFileSync(
    join(dir, 'agent_review_capture.json'),
    JSON.stringify({ armed: true, run_id: 'r1', args, created: Math.floor(Date.now() / 1000) }),
  );
}

test('hook exits 0 and prints nothing on malformed stdin', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    for (const name of ['post-skill', 'subagent-stop', 'no-such-hook']) {
      const unarmed = spawnCli(['hook', name], { dir, input: 'not json {' });
      assert.deepEqual(unarmed, { code: 0, stdout: '', stderr: '' }, `${name} while not armed`);
    }
    assert.deepEqual(readdirSync(dir), [], 'nothing is written while not armed');

    armCapture(dir);
    for (const name of ['post-skill', 'subagent-stop', 'no-such-hook']) {
      for (const input of ['not json {', '', 'null', '[]', '"text"']) {
        const r = spawnCli(['hook', name], { dir, input });
        assert.deepEqual(r, { code: 0, stdout: '', stderr: '' }, `${name} with ${JSON.stringify(input)}`);
      }
    }
    assert.deepEqual(spawnCli(['hook'], { dir, input: '{}' }), { code: 0, stdout: '', stderr: '' }, 'no hook name');
    assert.deepEqual(readdirSync(dir), ['agent_review_capture.json'], 'malformed payloads write nothing');

    writeFileSync(join(dir, 'agent_review_capture.json'), 'not json {');
    const brokenArm = spawnCli(['hook', 'subagent-stop'], {
      dir,
      input: JSON.stringify({ agent_id: 'f1', last_assistant_message: 'x' }),
    });
    assert.deepEqual(brokenArm, { code: 0, stdout: '', stderr: '' }, 'a malformed arm file');
    assert.deepEqual(readdirSync(dir), ['agent_review_capture.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture arm clears old capture files and writes the arm file', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    for (const name of [
      'code_review_capture.json',
      'code_review_capture.pending.json',
      'code_review_capture.stops.jsonl',
      'code_review_capture.mismatch.json',
    ]) {
      writeFileSync(join(dir, name), '{}');
    }
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const before = Math.floor(Date.now() / 1000);
    const armed = spawnCli(['capture', 'arm', '--run', 'r1', '--args', 'xhigh  12 --max-findings all'], { dir });
    assert.equal(armed.code, 0, armed.stderr);
    assert.equal(armed.stdout, 'armed r1: xhigh  12 --max-findings all\n');
    assert.deepEqual(readdirSync(dir).sort(), ['agent_review_capture.json', 'unrelated.json']);
    const arm = readCaptureJson(dir, 'agent_review_capture.json');
    assert.deepEqual(Object.keys(arm), ['armed', 'run_id', 'args', 'created']);
    assert.equal(arm.armed, true);
    assert.equal(arm.run_id, 'r1');
    assert.equal(arm.args, 'xhigh  12 --max-findings all', 'args are stored exactly');
    assert.ok(arm.created >= before && arm.created <= Math.floor(Date.now() / 1000), `created ${arm.created}`);

    for (const bad of [
      ['capture', 'arm', '--args', 'xhigh 12'],
      ['capture', 'arm', '--run', 'r1'],
      ['capture', 'arm', '--run', 'r1', '--args', ''],
      ['capture'],
    ]) {
      const r = spawnCli(bad, { dir });
      assert.equal(r.code, 1, bad.join(' '));
      assert.match(r.stdout, /usage: agent-review capture/);
    }

    const disarmed = spawnCli(['capture', 'disarm'], { dir });
    assert.equal(disarmed.code, 0);
    assert.equal(disarmed.stdout, 'disarmed\n');
    assert.deepEqual(readdirSync(dir), ['unrelated.json']);
    assert.equal(spawnCli(['capture', 'disarm'], { dir }).code, 0, 'disarm with no arm file');

    const help = run(['help']);
    assert.match(help.s, /^ {2}hook post-skill\|subagent-stop {2,}/m);
    assert.match(help.s, /^ {2}capture arm --run <id> --args "<args>" {2,}/m);
    assert.match(help.s, /^ {2}capture disarm {2,}/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post-skill then subagent-stop write a capture end to end', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armCapture(dir);
    const quiet = { code: 0, stdout: '', stderr: '' };
    const skill = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      session_id: 's1',
      tool_use_id: 'tu1',
      agent_id: 'lane1',
      tool_input: { skill: 'code-review', args: 'xhigh 12' },
      tool_response: { success: true, commandName: 'code-review', status: 'forked', background: true, agentId: 'f1', result: 'Running in the background as @code-review' },
    };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(skill) }), quiet);
    assert.equal(readCaptureJson(dir, 'code_review_capture.pending.json').fork_id, 'f1');
    assert.equal(existsSync(join(dir, 'code_review_capture.json')), false);

    const helper = { hook_event_name: 'SubagentStop', agent_id: 'helper9', agent_type: '', last_assistant_message: 'helper', agent_transcript_path: '/t/h.jsonl' };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(helper) }), quiet);
    assert.equal(existsSync(join(dir, 'code_review_capture.json')), false, 'a non-matching stop only buffers');

    const transcript = join(dir, 'fork.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '- lib/cart.rb:50: wrong discount' }] } }),
      JSON.stringify({ type: 'attachment' }),
    ].join('\n') + '\n');
    const forkStop = { hook_event_name: 'SubagentStop', agent_id: 'f1', agent_type: 'general-purpose', last_assistant_message: '', agent_transcript_path: transcript };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(forkStop) }), quiet);
    const capture = readCaptureJson(dir, 'code_review_capture.json');
    assert.deepEqual(
      { ...capture, ts: 0 },
      {
        source: 'agent-review-capture-hook',
        mode: 'forked',
        run_id: 'r1',
        args: 'xhigh 12',
        fork_id: 'f1',
        result: '- lib/cart.rb:50: wrong discount',
        transcript,
        stop_count: 1,
        ts: 0,
      },
    );
    assert.equal(typeof capture.ts, 'number');

    const again = { ...forkStop, last_assistant_message: '- lib/cart.rb:51: second stop' };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(again) }), quiet);
    const second = readCaptureJson(dir, 'code_review_capture.json');
    assert.equal(second.stop_count, 2);
    assert.equal(second.result, '- lib/cart.rb:51: second stop');

    const stops = readFileSync(join(dir, 'code_review_capture.stops.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(stops.map((s) => s.agent_id), ['helper9', 'f1', 'f1']);
    assert.deepEqual(Object.keys(stops[0]), ['agent_id', 'last_assistant_message', 'agent_transcript_path', 'ts']);

    const mismatch = { ...skill, tool_input: { skill: 'code-review', args: 'xhigh  12' } };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(mismatch) }), quiet);
    assert.deepEqual(
      { ...readCaptureJson(dir, 'code_review_capture.mismatch.json'), ts: 0 },
      { run_id: 'r1', expected: 'xhigh 12', got: 'xhigh  12', ts: 0 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a headless post-skill after the fork stop writes the foreground capture', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armCapture(dir, 'low HEAD~1..HEAD');
    const quiet = { code: 0, stdout: '', stderr: '' };
    const text = '- lib/cart.rb:50: wrong discount';
    const forkStop = { hook_event_name: 'SubagentStop', agent_id: 'f1', agent_type: 'general-purpose', last_assistant_message: text, agent_transcript_path: '/t/f1.jsonl' };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(forkStop) }), quiet);
    assert.equal(existsSync(join(dir, 'code_review_capture.json')), false);
    const skill = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      agent_id: 'lane1',
      tool_input: { skill: 'code-review', args: 'low HEAD~1..HEAD' },
      tool_response: { success: true, commandName: 'code-review', status: 'forked', agentId: 'f1', result: text },
    };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(skill) }), quiet);
    const capture = readCaptureJson(dir, 'code_review_capture.json');
    assert.equal(capture.mode, 'foreground');
    assert.equal(capture.result, text);
    assert.equal(capture.stop_count, 1);
    assert.equal(existsSync(join(dir, 'code_review_capture.pending.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent-stop keeps the last 50 stop lines', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armCapture(dir);
    const old = Array.from({ length: 55 }, (_, i) => JSON.stringify({ agent_id: `old${i}`, last_assistant_message: null, agent_transcript_path: null, ts: 1 }));
    writeFileSync(join(dir, 'code_review_capture.stops.jsonl'), old.join('\n') + '\n');
    const stop = { hook_event_name: 'SubagentStop', agent_id: 'newest', last_assistant_message: 'x', agent_transcript_path: '/t/n.jsonl' };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(stop) }), { code: 0, stdout: '', stderr: '' });
    const lines = readFileSync(join(dir, 'code_review_capture.stops.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 50);
    assert.equal(JSON.parse(lines[0]).agent_id, 'old6');
    assert.equal(JSON.parse(lines[49]).agent_id, 'newest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const QUIET = { code: 0, stdout: '', stderr: '' };
const FORK_STOP = { hook_event_name: 'SubagentStop', agent_id: 'f1', agent_type: 'general-purpose', last_assistant_message: '- a.rb:1: bug', agent_transcript_path: '/t/f1.jsonl' };
const HEADLESS_SKILL = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Skill',
  agent_id: 'lane1',
  tool_input: { skill: 'code-review', args: 'xhigh 12' },
  tool_response: { success: true, commandName: 'code-review', status: 'forked', agentId: 'f1', result: '- a.rb:1: bug' },
};

// Every reader and writer must refuse `dir`: the hooks silently, the commands with exit 1 and a reason.
function assertCaptureDirRefused(dir, reason) {
  const before = readdirSync(dir).sort();
  assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(FORK_STOP) }), QUIET);
  assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(HEADLESS_SKILL) }), QUIET);
  assert.deepEqual(readdirSync(dir).sort(), before, 'the hooks wrote nothing');
  for (const args of [
    ['capture', 'arm', '--run', 'r1', '--args', 'xhigh 12'],
    ['capture', 'disarm'],
    ['capture', 'show', '--run', 'r1'],
  ]) {
    const r = spawnCli(args, { dir });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, reason, args.join(' '));
  }
  assert.deepEqual(readdirSync(dir).sort(), before, 'the commands changed nothing');
}

test('capture dir that is group- or world-writable is refused', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armCapture(dir);
    for (const mode of [0o770, 0o702, 0o750, 0o701]) {
      chmodSync(dir, mode);
      assertCaptureDirRefused(dir, /group or other permission bits/);
    }
    chmodSync(dir, 0o700);
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(FORK_STOP) }), QUIET);
    assert.ok(existsSync(join(dir, 'code_review_capture.stops.jsonl')), 'the same dir at 0700 is used');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture dir that is a symlink is refused', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const real = join(parent, 'real');
    mkdirSync(real, { mode: 0o700 });
    armCapture(real);
    const link = join(parent, 'link');
    symlinkSync(real, link);
    assertCaptureDirRefused(link, /symlink/);
    assert.deepEqual(readdirSync(real), ['agent_review_capture.json'], 'nothing reached the real dir');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('hooks do nothing when the capture dir is missing', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const dir = join(parent, 'missing');
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(FORK_STOP) }), QUIET);
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(HEADLESS_SKILL) }), QUIET);
    assert.equal(existsSync(dir), false, 'the hooks never create the dir');
    for (const args of [['capture', 'disarm'], ['capture', 'show', '--run', 'r1']]) {
      const r = spawnCli(args, { dir });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, /does not exist/, args.join(' '));
    }
    assert.equal(existsSync(dir), false, 'only capture arm creates the dir');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('capture arm creates the dir with mode 0700', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const dir = join(parent, 'capture');
    const r = spawnCli(['capture', 'arm', '--run', 'r1', '--args', 'xhigh 12'], { dir });
    assert.equal(r.code, 0, r.stderr);
    const stat = lstatSync(dir);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, process.getuid());
    assert.equal(readCaptureJson(dir, 'agent_review_capture.json').run_id, 'r1');
    assert.equal(spawnCli(['capture', 'arm', '--run', 'r2', '--args', 'xhigh 12'], { dir }).code, 0, 'arming again reuses the dir');
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);

    const fileInTheWay = join(parent, 'file');
    writeFileSync(fileInTheWay, '');
    const blocked = spawnCli(['capture', 'arm', '--run', 'r1', '--args', 'xhigh 12'], { dir: fileInTheWay });
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /not a directory/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('readTranscript ignores a non-jsonl path', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const body = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'from the transcript' }] } }) + '\n';
    for (const name of ['t.jsonl', 't.txt', 't.jsonl.bak', 't.json']) writeFileSync(join(dir, name), body);
    assert.equal(readTranscript(join(dir, 't.jsonl')), 'from the transcript');
    assert.equal(readTranscript(join(dir, 't.txt')), null);
    assert.equal(readTranscript(join(dir, 't.jsonl.bak')), null);
    assert.equal(readTranscript(join(dir, 't.json')), null);
    assert.equal(readTranscript(relative(process.cwd(), join(dir, 't.jsonl'))), null, 'a relative path is ignored');
    assert.equal(readTranscript(join(dir, 'missing.jsonl')), null);
    assert.equal(readTranscript(undefined), null);

    armCapture(dir);
    const skill = { ...HEADLESS_SKILL, tool_response: { ...HEADLESS_SKILL.tool_response, background: true, result: 'launched' } };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(skill) }), QUIET);
    const stop = { ...FORK_STOP, last_assistant_message: '', agent_transcript_path: join(dir, 't.txt') };
    assert.deepEqual(spawnCli(['hook', 'subagent-stop'], { dir, input: JSON.stringify(stop) }), QUIET);
    assert.equal(readCaptureJson(dir, 'code_review_capture.json').result, '', 'the hook does not read a non-jsonl transcript');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture show prints the result for the matching run and fails for another run', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    assert.equal(spawnCli(['capture', 'arm', '--run', 'r1', '--args', 'xhigh 12'], { dir }).code, 0);
    const none = spawnCli(['capture', 'show', '--run', 'r1'], { dir });
    assert.equal(none.code, 1);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /no capture/);

    const result = 'I reviewed it.\n\n```json\n[{"file": "café.rb", "line": 3}]\n```\n\n';
    const capture = { source: 'agent-review-capture-hook', mode: 'forked', run_id: 'r1', args: 'xhigh 12', fork_id: 'f1', result, transcript: null, stop_count: 1, ts: 1 };
    writeFileSync(join(dir, 'code_review_capture.json'), JSON.stringify(capture));
    assert.deepEqual(spawnCli(['capture', 'show', '--run', 'r1'], { dir }), { code: 0, stdout: result, stderr: '' });

    const other = spawnCli(['capture', 'show', '--run', 'r2'], { dir });
    assert.equal(other.code, 1);
    assert.equal(other.stdout, '');
    assert.match(other.stderr, /r1/);
    assert.match(other.stderr, /r2/);

    const big = 'x'.repeat(300 * 1024) + '\nend';
    writeFileSync(join(dir, 'code_review_capture.json'), JSON.stringify({ ...capture, result: big }));
    const shown = spawnCli(['capture', 'show', '--run', 'r1'], { dir });
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout.length, big.length, 'a large result is not cut short through a pipe');
    assert.equal(shown.stdout, big);

    writeFileSync(join(dir, 'code_review_capture.json'), JSON.stringify({ ...capture, source: 'something-else' }));
    assert.equal(spawnCli(['capture', 'show', '--run', 'r1'], { dir }).code, 1, 'a file the hook did not write is not a capture');

    const usage = spawnCli(['capture', 'show'], { dir });
    assert.equal(usage.code, 1);
    assert.match(usage.stdout, /usage: agent-review capture/);
    assert.match(run(['help']).s, /^ {2}capture show --run <id> {2,}/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
