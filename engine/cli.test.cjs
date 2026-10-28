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
  realpathSync,
} = require('node:fs');
const { join, relative, dirname } = require('node:path');
const os = require('node:os');
const {
  main,
  ctx,
  changedFiles,
  resolveMinSupport,
  planTmpPath,
  readTranscript,
  captureWaitTimeout,
} = require('./cli.cjs');
const { buildPlan } = require('./plan.cjs');
const { looksFinished } = require('./codeReviewProof.cjs');
const { EFFORTS } = require('./vocabulary.cjs');

// The CLI writes stdout synchronously through fs.writeSync(1, ...), so in-process captures
// stub that for fd 1 as well as process.stdout.write.
function captureStdout(fn) {
  const fs = require('node:fs');
  const origWrite = process.stdout.write;
  const origWriteSync = fs.writeSync;
  let s = '';
  process.stdout.write = (x) => {
    s += x;
    return true;
  };
  fs.writeSync = (fd, buf, offset, ...rest) => {
    if (fd !== 1) return origWriteSync.call(fs, fd, buf, offset, ...rest);
    const chunk = typeof buf === 'string' ? Buffer.from(buf) : Buffer.from(buf).subarray(offset || 0);
    s += chunk.toString('utf8');
    return chunk.length;
  };
  let result;
  try {
    result = fn();
  } finally {
    process.stdout.write = origWrite;
    fs.writeSync = origWriteSync;
  }
  return { result, s };
}

function run(args) {
  const { result: code, s } = captureStdout(() => main(args));
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
      // out of the unmatched-coverage guarantee's floor so this test
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

function captured(fn) {
  return captureStdout(fn).s;
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

function diffBlock(path, added, oldPath = path) {
  return [
    `diff --git a/${oldPath} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${oldPath}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' keep',
    `+${added}`,
    '',
  ].join('\n');
}

function rawEntry(n, file) {
  return { n, file, line: 2, summary: 'a finding' };
}

test("diff-for prints the raw files' blocks in diff order, and nothing for []", () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-diff-for-'));
  const a = diffBlock('lib/a.rb', 'a = 1');
  const docs = diffBlock('docs/b.md', 'b');
  const renamed = diffBlock('lib/c.rb', 'c = 3', 'lib/old_c.rb');
  const d = diffBlock('app/d.js', 'd');
  const diffPath = join(root, 'diff.txt');
  writeFileSync(diffPath, `preamble line\n${a}${docs}${renamed}${d}`);
  const rawPath = join(root, 'raw.json');
  const diffFor = (raw) => {
    writeFileSync(rawPath, JSON.stringify(raw));
    return run(['diff-for', '--diff', diffPath, '--raw', rawPath, '--root', root]);
  };

  const picked = diffFor([
    rawEntry(1, 'app/d.js'),
    rawEntry(2, `${root}/lib/a.rb`),
    rawEntry(3, './lib/old_c.rb'),
    rawEntry(4, 'lib/a.rb'),
    rawEntry(5, 'lib/not_in_diff.rb'),
  ]);
  assert.equal(picked.code, 0);
  assert.equal(
    picked.s,
    `${a}${renamed}${d}no diff block for lib/not_in_diff.rb\n`,
    'blocks come in diff order, once each, matched repo-relative by new or old path',
  );

  const empty = diffFor([]);
  assert.equal(empty.code, 0);
  assert.equal(empty.s, '');
  rmSync(root, { recursive: true, force: true });
});

test('diff-for skips excluded paths and names every other raw file it has no block for', () => {
  const root = optionsRoot();
  try {
    const configPath = join(root, 'rd', 'config.yml');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('excluded_paths: []', 'excluded_paths: ["dist/**"]'));
    const a = diffBlock('lib/a.rb', 'a = 1');
    const bundle = diffBlock('dist/app.js', 'bundle');
    const diffPath = join(root, 'diff.txt');
    writeFileSync(diffPath, a + bundle);
    const rawPath = join(root, 'raw.json');
    writeFileSync(
      rawPath,
      JSON.stringify([
        rawEntry(1, 'dist/app.js'),
        rawEntry(2, 'lib/gone.rb'),
        rawEntry(3, 'lib/a.rb'),
        rawEntry(4, 'dist/other.js'),
        rawEntry(5, `${root}/lib/gone.rb`),
        rawEntry(6, 'my file.rb'),
      ]),
    );
    const at = ['--diff', diffPath, '--raw', rawPath, '--root', root];
    const filtered = run(['diff-for', ...at, '--review-dir', 'rd']);
    assert.equal(filtered.code, 0, filtered.s);
    assert.equal(
      filtered.s,
      `${a}no diff block for lib/gone.rb\nno diff block for my file.rb\n`,
      'an excluded file gets neither a block nor a line, and each unmatched file is named once, repo-relative',
    );

    const noConfig = run(['diff-for', ...at, '--review-dir', 'nowhere']);
    assert.equal(noConfig.code, 0, noConfig.s);
    assert.equal(
      noConfig.s,
      `${a}${bundle}no diff block for lib/gone.rb\nno diff block for dist/other.js\nno diff block for my file.rb\n`,
      'with no config, nothing is excluded',
    );

    writeFileSync(configPath, 'version: [');
    const broken = run(['diff-for', ...at, '--review-dir', 'rd']);
    assert.equal(broken.code, 0, broken.s);
    assert.equal(broken.s, noConfig.s, 'a config that cannot be read filters nothing');

    writeFileSync(diffPath, a.replace(/\n$/, ''));
    writeFileSync(rawPath, JSON.stringify([rawEntry(1, 'lib/a.rb'), rawEntry(2, 'lib/gone.rb')]));
    assert.equal(
      run(['diff-for', ...at, '--review-dir', 'nowhere']).s,
      `${a.replace(/\n$/, '')}\nno diff block for lib/gone.rb\n`,
      'the first line starts on its own line',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff-for keeps a block whose paths it cannot read whenever the raw list names a file', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-diff-for-quoted-'));
  const a = diffBlock('lib/a.rb', 'a = 1');
  const quoted = 'diff --git "a/my file.rb" "b/my file.rb"\n--- "a/my file.rb"\n+++ "b/my file.rb"\n@@ -1 +1 @@\n-x\n+y\n';
  const other = diffBlock('lib/other.rb', 'o');
  const diffPath = join(root, 'diff.txt');
  writeFileSync(diffPath, a + quoted + other);
  const rawPath = join(root, 'raw.json');
  writeFileSync(rawPath, JSON.stringify([rawEntry(1, 'lib/a.rb')]));
  const { code, s } = run(['diff-for', '--diff', diffPath, '--raw', rawPath, '--root', root]);
  assert.equal(code, 0);
  assert.equal(s, a + quoted);
  writeFileSync(rawPath, '[]');
  assert.equal(run(['diff-for', '--diff', diffPath, '--raw', rawPath, '--root', root]).s, '');
  rmSync(root, { recursive: true, force: true });
});

test('diff-for checks its arguments and its raw list', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-diff-for-args-'));
  const diffPath = join(root, 'diff.txt');
  writeFileSync(diffPath, diffBlock('lib/a.rb', 'a = 1'));
  const rawPath = join(root, 'raw.json');

  for (const args of [['diff-for'], ['diff-for', '--diff', diffPath], ['diff-for', '--raw', rawPath]]) {
    const r = run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.s, /usage: agent-review diff-for --diff <f> --raw <f>/);
  }

  const failsWith = (rawText, pattern, diff = diffPath) => {
    writeFileSync(rawPath, rawText);
    const r = run(['diff-for', '--diff', diff, '--raw', rawPath, '--root', root]);
    assert.equal(r.code, 1, rawText);
    assert.match(r.s, pattern);
  };
  failsWith('{"findings": []}', /is not a JSON array/);
  failsWith('[{"n": 1, "line": 3}]', /raw entry 1 needs a non-empty string file/);
  failsWith('not json', /could not read the raw findings list/);
  failsWith('[]', /could not read the diff/, join(root, 'missing.txt'));
  rmSync(root, { recursive: true, force: true });
});

test('usage lists diff-for', () => {
  const { s } = run(['help']);
  assert.ok(s.includes('  diff-for --diff <f> --raw <f>   '), s);
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

// `run`'s positional mode arg must reach buildPlan's input, so plan.mode matches the request
// instead of defaulting to 'standard'.
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
    reason: `report for ${head} passes with no open blockers`,
    irreversible: false,
    irreversibleReasons: [],
    humanRequired: false,
    humanReasons: [],
  });
  const stale = run(['approval', '--report', file, '--head', '0000000000000000000000000000000000000000']);
  assert.equal(stale.code, 0);
  assert.equal(JSON.parse(stale.s).approve, false);
  const usage = run(['approval', '--report', file]);
  assert.equal(usage.code, 1);
  assert.match(usage.s, /usage: agent-review approval/);

  const rules = join(dir, 'rules.json');
  writeFileSync(rules, JSON.stringify({ required: false, reasons: [] }));
  const labels = join(dir, 'labels.json');
  writeFileSync(labels, JSON.stringify(['needs-human-approval']));
  const decided = run(['approval', '--report', file, '--head', head, '--rules', rules]);
  assert.equal(decided.code, 0);
  assert.deepEqual(JSON.parse(decided.s), {
    approve: true,
    reason: `report for ${head} passes with no open blockers`,
    label: 'keep',
    dismissBotApprovals: 'none',
    caution: null,
  });
  const errorRules = join(dir, 'error-rules.json');
  writeFileSync(errorRules, JSON.stringify({ error: "human-check: the PR's file list is incomplete" }));
  const unreadable = JSON.parse(run(['approval', '--report', file, '--head', head, '--rules', errorRules, '--labels', labels, '--label-owner', 'bot']).s);
  assert.deepEqual([unreadable.approve, unreadable.label, unreadable.dismissBotApprovals], [false, 'keep', 'stale']);
  writeFileSync(errorRules, JSON.stringify({ required: true, reasons: ['PCI path: app/pay.rb'] }));
  const needed = JSON.parse(run(['approval', '--report', file, '--head', head, '--rules', errorRules]).s);
  assert.deepEqual([needed.approve, needed.label, needed.dismissBotApprovals], [false, 'add', 'all']);
  const owned = JSON.parse(
    run(['approval', '--report', file, '--head', head, '--rules', rules, '--labels', labels, '--label-owner', 'bot']).s,
  );
  assert.equal(owned.label, 'remove');
  const personOwned = JSON.parse(
    run(['approval', '--report', file, '--head', head, '--rules', rules, '--labels', labels, '--label-owner', 'person']).s,
  );
  assert.equal(personOwned.approve, false);
  const badOwner = run(['approval', '--report', file, '--head', head, '--rules', rules, '--label-owner', 'robot']);
  assert.equal(badOwner.code, 1);
  assert.match(badOwner.s, /usage: agent-review approval/);
  rmSync(dir, { recursive: true, force: true });
});

test('status carries the human fields and requires both new inputs', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-status-'));
  const f = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const base = [
    'status',
    '--ledger', f('ledger.json', []),
    '--plan', f('plan.json', { risk: { level: 'LOW' } }),
    '--safety', f('safety.json', { irreversible: false, reasons: [] }),
  ];
  const human = f('human.json', { required: true, reasons: ['PCI path: app/payments/a.rb'] });
  const card = f('card.json', { cardData: true, reasons: ['stores PAN', 'PCI path: app/payments/a.rb'] });
  const r = run([...base, '--human', human, '--card-scan', card]);
  assert.equal(r.code, 0);
  const json = JSON.parse(r.s);
  assert.equal(json.humanRequired, true);
  assert.deepEqual(json.humanReasons, ['PCI path: app/payments/a.rb', 'stores PAN']);
  for (const extra of [[], ['--human', human], ['--card-scan', card]]) {
    const usage = run([...base, ...extra]);
    assert.equal(usage.code, 1);
    assert.match(usage.s, /usage: agent-review status/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('help lists the required status inputs', () => {
  const { s } = run(['help']);
  assert.match(s, /status --ledger <f> --plan <f> --safety <f> --human <f> --card-scan <f>/);
});

test('human-check prints the rules for a config file and a file list', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-human-'));
  const cfg = join(dir, 'config.yml');
  const files = join(dir, 'files.txt');
  writeFileSync(cfg, 'human_approval:\n  paths: ["app/payments/**"]\n');
  writeFileSync(files, 'app/payments/a.rb\nlib/x.rb\n');
  const r = run(['human-check', '--config', cfg, '--files', files]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.s), { required: true, reasons: ['PCI path: app/payments/a.rb'] });

  writeFileSync(cfg, '');
  const none = run(['human-check', '--config', cfg, '--files', files]);
  assert.equal(none.code, 0);
  assert.deepEqual(JSON.parse(none.s), { required: false, reasons: [] });

  for (const args of [['--files', files], ['--config', cfg]]) {
    const usage = run(['human-check', ...args]);
    assert.equal(usage.code, 1);
    assert.match(usage.s, /usage: agent-review human-check/);
  }

  writeFileSync(cfg, 'a: [unclosed\n');
  const bad = run(['human-check', '--config', cfg, '--files', files]);
  assert.equal(bad.code, 1);
  assert.match(bad.s, /^human-check: /);
  rmSync(dir, { recursive: true, force: true });
});

test('human-check --incomplete refuses a partial file list only when the base config sets rules', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-human-'));
  const cfg = join(dir, 'config.yml');
  const files = join(dir, 'files.txt');
  writeFileSync(files, 'lib/x.rb\n');
  const check = (config) => {
    writeFileSync(cfg, config);
    return run(['human-check', '--config', cfg, '--files', files, '--incomplete']);
  };

  const paths = check('human_approval:\n  paths: ["app/payments/**"]\n');
  assert.equal(paths.code, 1);
  assert.equal(paths.s.trim(), "human-check: the PR's file list is incomplete");

  const always = check('human_approval:\n  always: true\n');
  assert.equal(always.code, 1);
  assert.equal(always.s.trim(), "human-check: the PR's file list is incomplete");

  for (const none of ['', 'engine:\n  name: agent-review\n', 'human_approval:\n  always: false\n  paths: []\n']) {
    const r = check(none);
    assert.equal(r.code, 0, `no rules in ${JSON.stringify(none)}`);
    assert.deepEqual(JSON.parse(r.s), { required: false, reasons: [] });
  }

  writeFileSync(cfg, 'human_approval:\n  paths: ["app/payments/**"]\n');
  const complete = run(['human-check', '--config', cfg, '--files', files]);
  assert.equal(complete.code, 0, 'without the flag nothing changes');
  assert.deepEqual(JSON.parse(complete.s), { required: false, reasons: [] });
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

test('options --args-file keeps a leading --flag token', () => {
  const root = optionsRoot();
  try {
    const file = join(root, 'args.txt');
    writeFileSync(file, '--foo engine=agent-review deep\n');
    const { code, s } = run(['options', '--args-file', file, '--root', root, '--review-dir', 'rd']);
    assert.equal(code, 0, s);
    const r = JSON.parse(s);
    assert.equal(r.mode.value, 'deep');
    assert.equal(r.engine.source, 'argument');
    assert.deepEqual(r.notes, ['ignored unknown argument(s): --foo']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('options --args=<value> keeps a leading --flag token', () => {
  const root = optionsRoot();
  try {
    const { code, s } = run(['options', '--args=--comment deep', '--root', root, '--review-dir', 'rd']);
    assert.equal(code, 0, s);
    assert.equal(JSON.parse(s).mode.value, 'deep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a --ci token inside the args file does not set ci', () => {
  const root = optionsRoot();
  try {
    const file = join(root, 'args.txt');
    writeFileSync(file, '--ci');
    const at = ['--root', root, '--review-dir', 'rd'];
    assert.equal(JSON.parse(run(['options', '--args-file', file, ...at]).s).ci, false);
    assert.equal(JSON.parse(run(['options', '--args', '--ci', ...at]).s).ci, false);
    assert.equal(JSON.parse(run(['options', '--args', '', '--ci', ...at]).s).ci, true);
    assert.equal(JSON.parse(run(['options', '--args-file', file, '--ci', ...at]).s).ci, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.equal(
      engine.s,
      'error: engine.code_review.always references disabled agent: security; engine.code_review.always references unknown agent: testing\n',
    );
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

const PROOF_USAGE = /^usage: agent-review code-review-proof --raw <f> --findings <f> --dropped <f> --run <id> \[--head <sha>\] \[--base <sha>\] \[--promote <f>\]\n$/;

// Writes the lane files into dir and the capture into a private dir under it, which the
// command reads through AGENT_REVIEW_CAPTURE_DIR.
function proofFiles(dir, { raw, scored, dropped, result }) {
  const capDir = join(dir, 'cap');
  mkdirSync(capDir, { mode: 0o700 });
  chmodSync(capDir, 0o700);
  const files = {
    capDir,
    capture: join(capDir, 'code_review_capture.json'),
    raw: join(dir, 'raw.json'),
    findings: join(dir, 'findings.json'),
    dropped: join(dir, 'dropped.json'),
  };
  writeFileSync(files.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'r1', result }));
  writeFileSync(files.raw, JSON.stringify(raw));
  writeFileSync(files.findings, JSON.stringify(scored));
  writeFileSync(files.dropped, JSON.stringify(dropped));
  return files;
}

function withCaptureDir(capDir, fn) {
  const saved = process.env.AGENT_REVIEW_CAPTURE_DIR;
  process.env.AGENT_REVIEW_CAPTURE_DIR = capDir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AGENT_REVIEW_CAPTURE_DIR;
    else process.env.AGENT_REVIEW_CAPTURE_DIR = saved;
  }
}

const proofArgs = (f, extra = []) => ['code-review-proof', '--raw', f.raw, '--findings', f.findings, '--dropped', f.dropped, '--run', 'r1', ...extra];
const PROOF_RESULT = 'Result:\n```json\n[{"file":"dist/app.js","line":4,"summary":"s"},{"file":"src/a.js","line":2,"summary":"s"}]\n```\n';
const PROOF_RAW = [
  { n: 1, file: 'dist/app.js', line: 4, summary: 's' },
  { n: 2, file: 'src/a.js', line: 2, summary: 's' },
];
const PROOF_SCORED = [
  { raw: 2, file: 'src/a.js', line: 2, message: 'm', severity: 5, category: 'correctness', confidence: 'High', evidence: '', outside_range: false, doubted: false, recategorized_from: null },
];

test('code-review-proof exits 1 with a usage line when a flag is missing, and rejects --capture', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-'));
  try {
    const f = proofFiles(dir, { raw: PROOF_RAW, scored: PROOF_SCORED, dropped: [], result: PROOF_RESULT });
    withCaptureDir(f.capDir, () => {
      const full = proofArgs(f);
      for (const name of ['--raw', '--findings', '--dropped', '--run']) {
        const at = full.indexOf(name);
        const r = run([...full.slice(0, at), ...full.slice(at + 2)]);
        assert.equal(r.code, 1, name);
        assert.match(r.s, PROOF_USAGE, name);
      }
      const other = join(dir, 'other-capture.json');
      writeFileSync(other, readFileSync(f.capture));
      const withFlag = run(proofArgs(f, ['--capture', other]));
      assert.equal(withFlag.code, 1);
      assert.match(withFlag.s, PROOF_USAGE, 'the capture path is never accepted from the command line');
    });
    assert.match(run(['help']).s, /^ {2}code-review-proof --raw <f> --findings <f> --dropped <f> --run <id> \[--head <sha>\] \[--base <sha>\] \[--promote <f>\] {3}/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof checks the whole run and reads excluded_paths from the repo config', () => {
  const root = optionsRoot();
  const configPath = join(root, 'rd', 'config.yml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('excluded_paths: []', 'excluded_paths: ["dist/**"]'));
  try {
    const dropped = [{ raw: 1, reason: 'excluded', glob: 'dist/**' }];
    const f = proofFiles(root, { raw: PROOF_RAW, scored: PROOF_SCORED, dropped, result: PROOF_RESULT });
    withCaptureDir(f.capDir, () => {
      const args = proofArgs(f, ['--root', root, '--review-dir', 'rd']);

      const ok = run(args);
      assert.equal(ok.code, 0, ok.s);
      assert.deepEqual(JSON.parse(ok.s), {
        ok: true,
        stage: null,
        reason: 'ok',
        count: 2,
        mode: 'json',
        dropped: [{ file: 'dist/app.js', line: 4, summary: 's', why: 'excluded path: dist/**' }],
      });

      const otherDir = run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere']));
      assert.equal(otherDir.code, 1, 'with no config there are no excluded paths');
      const refused = JSON.parse(otherDir.s);
      assert.equal(refused.stage, 'lane');
      assert.match(refused.reason, /not in the config's excluded_paths/);

      writeFileSync(f.dropped, '[]');
      const lost = run(args);
      assert.equal(lost.code, 1);
      assert.match(JSON.parse(lost.s).reason, /raw entry 1 \(dist\/app\.js:4\) is neither scored nor dropped/);

      writeFileSync(f.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'other', result: PROOF_RESULT }));
      assert.equal(JSON.parse(run(args).s).stage, 'capture');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('code-review-proof prints JSON for an unreadable lane file, treating it as missing', () => {
  const root = optionsRoot();
  try {
    const f = proofFiles(root, { raw: PROOF_RAW, scored: PROOF_SCORED, dropped: [], result: PROOF_RESULT });
    withCaptureDir(f.capDir, () => {
      const asDir = join(root, 'a-directory');
      mkdirSync(asDir);
      const r = run(['code-review-proof', '--raw', f.raw, '--findings', asDir, '--dropped', f.dropped, '--run', 'r1', '--root', root, '--review-dir', 'rd']);
      assert.equal(r.code, 1);
      const parsed = JSON.parse(r.s);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.stage, 'lane');
      assert.match(parsed.reason, /scored findings file/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('code-review-proof prints stage config when the config cannot be read', () => {
  const root = optionsRoot();
  try {
    const f = proofFiles(root, { raw: PROOF_RAW, scored: PROOF_SCORED, dropped: [], result: PROOF_RESULT });
    writeFileSync(join(root, 'rd', 'config.yml'), 'version: [');
    withCaptureDir(f.capDir, () => {
      const r = run(proofArgs(f, ['--root', root, '--review-dir', 'rd']));
      assert.equal(r.code, 1);
      const parsed = JSON.parse(r.s);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.stage, 'config');
      assert.match(parsed.reason, /^could not read excluded_paths from the review config: /);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('code-review-proof checks the capture dir before reading the capture', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-'));
  try {
    const f = proofFiles(dir, { raw: PROOF_RAW, scored: PROOF_SCORED, dropped: [{ raw: 1, reason: 'excluded', glob: 'dist/**' }], result: PROOF_RESULT });
    const at = ['--root', dir, '--review-dir', 'nowhere'];
    const missing = withCaptureDir(join(dir, 'absent'), () => JSON.parse(run(proofArgs(f, at)).s));
    assert.equal(missing.stage, 'capture');
    assert.match(missing.reason, /does not exist/);

    rmSync(f.capture);
    const noFile = withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, at)).s));
    assert.equal(noFile.stage, 'capture');
    assert.match(noFile.reason, /no \/code-review capture was found/);

    writeFileSync(f.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'r1', result: PROOF_RESULT }));
    const found = withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, at)).s));
    assert.equal(found.stage, 'lane', 'the capture is read; the drop glob is not configured here');

    chmodSync(f.capDir, 0o755);
    const open = withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, at)).s));
    assert.equal(open.stage, 'capture');
    assert.match(open.reason, /permission bits/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ONE_RESULT = 'Result:\n```json\n[{"file":"src/a.js","line":2,"summary":"s"}]\n```\n';
const ONE_RAW = [{ n: 1, file: 'src/a.js', line: 2, summary: 's' }];
// Odd spacing, a non-ASCII character, and trailing blank lines show the copy is byte for byte.
const ONE_SCORED_TEXT = `{ "findings": [ ${JSON.stringify({ ...PROOF_SCORED[0], raw: 1, message: 'café m' })} ] }\n\n`;

test('code-review-proof --promote copies the exact checked findings bytes when ok', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-promote-'));
  try {
    const f = proofFiles(dir, { raw: ONE_RAW, scored: [], dropped: [], result: ONE_RESULT });
    writeFileSync(f.findings, ONE_SCORED_TEXT);
    const target = join(dir, 'agent_findings', 'code-review.json');
    mkdirSync(join(dir, 'agent_findings'));
    writeFileSync(target, 'stale');
    withCaptureDir(f.capDir, () => {
      const r = run(proofArgs(f, ['--root', dir, '--review-dir', 'nowhere', '--promote', target]));
      assert.equal(r.code, 0, r.s);
      assert.equal(JSON.parse(r.s).ok, true);
      assert.deepEqual(readFileSync(target), Buffer.from(ONE_SCORED_TEXT, 'utf8'), 'the promoted file is the checked bytes');
      assert.deepEqual(readdirSync(join(dir, 'agent_findings')), ['code-review.json'], 'no temp file is left behind');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof --promote writes nothing and removes a stale target when not ok', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-promote-'));
  try {
    const f = proofFiles(dir, { raw: ONE_RAW, scored: [], dropped: [], result: ONE_RESULT });
    const target = join(dir, 'code-review.json');
    const at = ['--root', dir, '--review-dir', 'nowhere', '--promote', target];
    withCaptureDir(f.capDir, () => {
      writeFileSync(target, 'stale');
      const lane = run(proofArgs(f, at));
      assert.equal(lane.code, 1);
      assert.equal(JSON.parse(lane.s).stage, 'lane', 'raw entry 1 is neither scored nor dropped');
      assert.equal(existsSync(target), false, 'a failed lane check removes the stale target');

      writeFileSync(f.findings, ONE_SCORED_TEXT);
      writeFileSync(f.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'other', result: ONE_RESULT }));
      writeFileSync(target, 'stale');
      const capture = run(proofArgs(f, at));
      assert.equal(JSON.parse(capture.s).stage, 'capture');
      assert.equal(existsSync(target), false, 'a failed capture check removes the stale target');
    });

    writeFileSync(target, 'stale');
    const refused = withCaptureDir(join(dir, 'absent'), () => run(proofArgs(f, at)));
    assert.equal(JSON.parse(refused.s).stage, 'capture');
    assert.equal(existsSync(target), false, 'a refused capture dir removes the stale target');

    writeFileSync(f.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'r1', result: ONE_RESULT }));
    const unwritable = join(dir, 'missing-dir', 'code-review.json');
    const failedWrite = withCaptureDir(f.capDir, () =>
      run(proofArgs(f, ['--root', dir, '--review-dir', 'nowhere', '--promote', unwritable])),
    );
    assert.equal(failedWrite.code, 1);
    const parsed = JSON.parse(failedWrite.s);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, 'config');
    assert.match(parsed.reason, /could not save the proved findings/);
    assert.equal(existsSync(unwritable), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof lists --promote in its usage and needs a value for it', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-promote-'));
  try {
    const f = proofFiles(dir, { raw: ONE_RAW, scored: [], dropped: [], result: ONE_RESULT });
    const r = withCaptureDir(f.capDir, () => run([...proofArgs(f), '--promote']));
    assert.equal(r.code, 1);
    assert.match(r.s, PROOF_USAGE);
    assert.match(
      run(['help']).s,
      /^ {2}code-review-proof --raw <f> --findings <f> --dropped <f> --run <id> \[--head <sha>\] \[--base <sha>\] \[--promote <f>\] {3}.*--promote/m,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A git repository at <parent>/repo with `files` committed; lane files and the capture go in parent.
function proofRepo(files) {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-crproof-git-'));
  const root = join(parent, 'repo');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { parent, root, git };
}

test('code-review-proof reads root-level file names from the committed tree under --root', () => {
  const { parent, root } = proofRepo({ Gemfile: 'gem "rack"\n', 'lib/cart.rb': 'x = 1\n' });
  try {
    writeFileSync(join(root, 'untracked.rb'), 'y = 2\n');
    const result = [
      '- Gemfile:12 pins an old rack',
      '- cart.rb:3 skips the guard',
      'Calls to api.stripe.com:443 time out, the base image ruby:3.3 is old, and untracked.rb:1 is new.',
    ].join('\n');
    const raw = [
      { n: 1, file: 'Gemfile', line: 12, summary: 's' },
      { n: 2, file: 'cart.rb', line: 3, summary: 's' },
    ];
    const scored = raw.map((entry) => ({ ...PROOF_SCORED[0], raw: entry.n, file: entry.file, line: entry.line }));
    const f = proofFiles(parent, { raw, scored, dropped: [], result });
    const proof = () => withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere'])).s));
    const ok = proof();
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.mode, 'text');

    writeFileSync(f.raw, JSON.stringify([raw[1]].map((entry) => ({ ...entry, n: 1 }))));
    writeFileSync(f.findings, JSON.stringify([{ ...scored[1], raw: 1 }]));
    const lost = proof();
    assert.equal(lost.ok, false);
    assert.equal(lost.stage, 'lane');
    assert.match(lost.reason, /\(Gemfile:12\) is a finding line that no raw entry claims/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('code-review-proof reads root-level file names at --head, not from the local index', () => {
  const { parent, root, git } = proofRepo({ 'lib/cart.rb': 'x = 1\n' });
  try {
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'setup.py'), 'setup()\n');
    git('add', 'setup.py');
    git('commit', '-q', '-m', 'add setup.py');
    const reviewed = git('rev-parse', 'HEAD');
    const result = '- lib/cart.rb:1 skips the guard\n- setup.py:12 pins an old version\n';
    const cart = { n: 1, file: 'lib/cart.rb', line: 1, summary: 's' };
    const setup = { n: 2, file: 'setup.py', line: 12, summary: 's' };
    const scoredFor = (raw) => raw.map((entry) => ({ ...PROOF_SCORED[0], raw: entry.n, file: entry.file, line: entry.line }));
    const f = proofFiles(parent, { raw: [cart], scored: scoredFor([cart]), dropped: [], result });
    const proofWith = (raw, extra) => {
      writeFileSync(f.raw, JSON.stringify(raw));
      writeFileSync(f.findings, JSON.stringify(scoredFor(raw)));
      return withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere', ...extra])).s));
    };
    const assertNeedsClaim = (extra, label) => {
      const lost = proofWith([cart], extra);
      assert.equal(lost.ok, false, label);
      assert.equal(lost.stage, 'lane', label);
      assert.match(lost.reason, /\(setup\.py:12\) is a finding line that no raw entry claims/, label);
      const listed = proofWith([cart, setup], extra);
      assert.equal(listed.ok, true, `${label}: ${listed.reason}`);
    };

    git('checkout', '-q', before);
    assertNeedsClaim(['--head', reviewed], 'a checkout behind the reviewed head');
    assert.equal(proofWith([cart], []).ok, true, 'with no --head the names come from HEAD, which has no setup.py');

    git('checkout', '-q', reviewed);
    git('rm', '-q', 'setup.py');
    assertNeedsClaim([], 'setup.py deleted from the index but present at HEAD');
    assertNeedsClaim(['--head', reviewed], 'the same, with --head');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('code-review-proof reads no-slash names at --base too, so a finding on a root file the PR deleted must be claimed', () => {
  const { parent, root, git } = proofRepo({ 'legacy_helper.rb': 'def format_money; end\n', 'lib/a.rb': 'x = 1\n' });
  try {
    const base = git('rev-parse', 'HEAD');
    git('rm', '-q', 'legacy_helper.rb');
    git('commit', '-q', '-m', 'drop the helper');
    const head = git('rev-parse', 'HEAD');
    const result = '- legacy_helper.rb:40: format_money removed but still called\n';
    const legacy = { n: 1, file: 'legacy_helper.rb', line: 40, summary: 's' };
    const f = proofFiles(parent, { raw: [], scored: [], dropped: [], result });
    const proofWith = (raw, extra) => {
      writeFileSync(f.raw, JSON.stringify(raw));
      writeFileSync(f.findings, JSON.stringify(raw.map((entry) => ({ ...PROOF_SCORED[0], raw: entry.n, file: entry.file, line: entry.line }))));
      return withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere', ...extra])).s));
    };
    const unclaimed = proofWith([], ['--head', head, '--base', base]);
    assert.equal(unclaimed.ok, false);
    assert.equal(unclaimed.stage, 'lane', unclaimed.reason);
    assert.match(unclaimed.reason, /\(legacy_helper\.rb:40\) is a finding line that no raw entry claims/);
    const claimed = proofWith([legacy], ['--head', head, '--base', base]);
    assert.equal(claimed.ok, true, claimed.reason);
    assert.equal(claimed.mode, 'text');
    assert.equal(proofWith([], ['--head', head]).stage, 'capture', 'with no --base, the file is not in the head commit');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('code-review-proof refuses at stage config when --base is not a commit or its files cannot be listed', () => {
  const { parent, root, git } = proofRepo({ 'old.rb': 'x = 1\n' });
  try {
    const base = git('rev-parse', 'HEAD');
    const baseTree = git('rev-parse', 'HEAD^{tree}');
    writeFileSync(join(root, 'new.rb'), 'y = 2\n');
    git('add', 'new.rb');
    git('commit', '-q', '-m', 'add new.rb');
    const head = git('rev-parse', 'HEAD');
    const raw = [{ n: 1, file: 'new.rb', line: 1, summary: 's' }];
    const f = proofFiles(parent, { raw, scored: [{ ...PROOF_SCORED[0], raw: 1, file: 'new.rb', line: 1 }], dropped: [], result: '- new.rb:1 is wrong\n' });
    const proofAt = (extra) => withCaptureDir(f.capDir, () => run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere', '--head', head, ...extra])));
    const ok = JSON.parse(proofAt(['--base', base]).s);
    assert.equal(ok.ok, true, ok.reason);
    for (const bad of ['not-a-commit', '-x', '', `${base}^{tree}`]) {
      const r = proofAt(['--base', bad]);
      assert.equal(r.code, 1, bad);
      const parsed = JSON.parse(r.s);
      assert.equal(parsed.stage, 'config', bad);
      assert.match(parsed.reason, /--base .* is not a commit in /, bad);
    }
    const missing = proofAt(['--base']);
    assert.equal(missing.code, 1);
    assert.match(missing.s, PROOF_USAGE);

    rmSync(join(root, '.git', 'objects', baseTree.slice(0, 2), baseTree.slice(2)));
    const unlisted = proofAt(['--base', base]);
    assert.equal(unlisted.code, 1);
    const parsed = JSON.parse(unlisted.s);
    assert.equal(parsed.stage, 'config');
    assert.match(parsed.reason, /could not list the files of base commit /);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('code-review-proof reads each disproof file with one git cat-file blob call', () => {
  const cart = Array.from({ length: 20 }, (_, i) => (i === 17 ? '  if (!items) return [];' : `# line ${i + 1}`));
  const { parent, root, git } = proofRepo({ 'lib/cart.rb': cart.join('\n') + '\n', 'lib/dir/a.rb': 'x = 1\n' });
  try {
    const head = git('rev-parse', 'HEAD');
    const bin = join(parent, 'bin');
    const log = join(parent, 'git.log');
    mkdirSync(bin);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const result = 'Result:\n```json\n[{"file":"lib/cart.rb","line":18,"summary":"s"}]\n```\n';
    const f = proofFiles(parent, { raw: [{ n: 1, file: 'lib/cart.rb', line: 18, summary: 's' }], scored: [], dropped: [], result });
    const proofWith = (proof) => {
      writeFileSync(f.dropped, JSON.stringify([{ raw: 1, reason: 'disproved', proof }]));
      rmSync(log, { force: true });
      const r = withEnv({ PATH: `${bin}:${process.env.PATH}` }, () =>
        withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere', '--head', head])).s)),
      );
      return { r, calls: readFileSync(log, 'utf8').trim().split('\n') };
    };
    const passed = proofWith('already handled: lib/cart.rb:18 if (!items) return [];');
    assert.equal(passed.r.ok, true, passed.r.reason);
    assert.deepEqual(passed.calls.filter((c) => c.includes('lib/cart.rb')), [`cat-file blob ${head}:./lib/cart.rb`]);
    const tree = proofWith('lib/dir:1 a.rb a.rb');
    assert.equal(tree.r.ok, false);
    assert.match(tree.r.reason, /no file lib\/dir exists/, 'a directory is not a blob');
    assert.deepEqual(tree.calls.filter((c) => c.includes('lib/dir')), [`cat-file blob ${head}:./lib/dir`]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('code-review-proof refuses at stage config when it cannot list the reviewed commit\'s files', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-crproof-nogit-'));
  try {
    const raw = [{ n: 1, file: 'lib/cart.rb', line: 1, summary: 's' }];
    const f = proofFiles(dir, {
      raw,
      scored: [{ ...PROOF_SCORED[0], raw: 1, file: 'lib/cart.rb', line: 1 }],
      dropped: [],
      result: '- lib/cart.rb:1 skips the guard, and setup.py:12 pins an old version\n',
    });
    // The temp dir may sit inside a git work tree; the ceiling keeps git from finding that repo.
    const r = withEnv({ GIT_CEILING_DIRECTORIES: realpathSync(dirname(dir)) }, () =>
      withCaptureDir(f.capDir, () => run(proofArgs(f, ['--root', dir, '--review-dir', 'nowhere']))),
    );
    assert.equal(r.code, 1);
    const parsed = JSON.parse(r.s);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, 'config');
    assert.match(parsed.reason, /could not list the files of commit HEAD in /);
    writeFileSync(f.capture, JSON.stringify({ source: 'agent-review-capture-hook', run_id: 'r1', result: '- lib/cart.rb:1 skips the guard\n' }));
    const slashOnly = withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', dir, '--review-dir', 'nowhere'])).s));
    assert.equal(slashOnly.ok, true, `a result with no path lacking a / needs no file list: ${slashOnly.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-review-proof checks a disproof against the files committed under --root', () => {
  const cart = Array.from({ length: 20 }, (_, i) => (i === 17 ? '  if (!items) return [];' : `# line ${i + 1}`));
  const { parent, root } = proofRepo({
    'lib/cart.rb': cart.join('\n') + '\n',
    'lib/dir/a.rb': 'x = 1\n',
    Makefile: Array.from({ length: 14 }, (_, i) => (i === 11 ? 'test: build lint' : `# ${i + 1}`)).join('\n'),
  });
  try {
    writeFileSync(join(parent, 'outside.rb'), 'secret = 1\n');
    const result = 'Result:\n```json\n[{"file":"lib/cart.rb","line":18,"summary":"s"}]\n```\n';
    const f = proofFiles(parent, { raw: [{ n: 1, file: 'lib/cart.rb', line: 18, summary: 's' }], scored: [], dropped: [], result });
    const proofWith = (proof) => {
      writeFileSync(f.dropped, JSON.stringify([{ raw: 1, reason: 'disproved', proof }]));
      return withCaptureDir(f.capDir, () => JSON.parse(run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere'])).s));
    };
    const passed = proofWith('already handled: lib/cart.rb:18 if (!items) return [];');
    assert.equal(passed.ok, true, passed.reason);
    assert.equal(proofWith('Makefile:12 test: build lint').ok, true, 'a bare file name counts when the file exists');
    for (const [proof, pattern] of [
      ['x.y:1 nah', /no file x\.y exists in the repository/],
      ['lib/cart.rb:99 if (!items) return [];', /lib\/cart\.rb has 20 lines/],
      ['lib/cart.rb:5 if (!items) return [];', /quote after lib\/cart\.rb:5 does not hold that whole line of lib\/cart\.rb/],
      ['../outside.rb:1 secret = 1', /no file \.\.\/outside\.rb exists/],
      [`${parent}/outside.rb:1 secret = 1`, /no file .*outside\.rb exists/],
      ['lib/dir:1 a.rb a.rb', /no file lib\/dir exists/],
    ]) {
      const r = proofWith(proof);
      assert.equal(r.ok, false, proof);
      assert.equal(r.stage, 'lane', proof);
      assert.match(r.reason, pattern, proof);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('code-review-proof reads a disproof at --head, or else at HEAD, never from the working tree', () => {
  const lines = (third) => ['def pay(amount)', '  log(amount)', third, '  charge(amount)', 'end'].join('\n') + '\n';
  const { parent, root, git } = proofRepo({ 'lib/pay.rb': lines('  audit(amount)') });
  try {
    const first = git('rev-parse', 'HEAD');
    const result = 'Result:\n```json\n[{"file":"lib/pay.rb","line":3,"summary":"charges a nil amount"}]\n```\n';
    const proof = 'already handled: lib/pay.rb:3 return if amount.nil?';
    const f = proofFiles(parent, {
      raw: [{ n: 1, file: 'lib/pay.rb', line: 3, summary: 'charges a nil amount' }],
      scored: [],
      dropped: [{ raw: 1, reason: 'disproved', proof }],
      result,
    });
    const proofAt = (extra) => withCaptureDir(f.capDir, () => run(proofArgs(f, ['--root', root, '--review-dir', 'nowhere', ...extra])));
    const judged = (extra) => JSON.parse(proofAt(extra).s);

    writeFileSync(join(root, 'lib', 'pay.rb'), lines('  return if amount.nil?'));
    for (const extra of [[], ['--head', first]]) {
      const r = judged(extra);
      assert.equal(r.ok, false, `an uncommitted guard proves nothing (${extra.join(' ') || 'no --head'})`);
      assert.equal(r.stage, 'lane');
      assert.match(r.reason, /quote after lib\/pay\.rb:3 does not hold that whole line of lib\/pay\.rb/);
    }

    git('commit', '-q', '-am', 'guard');
    const second = git('rev-parse', 'HEAD');
    assert.equal(judged(['--head', second]).ok, true, 'the committed guard, at that commit, disproves the finding');
    assert.equal(judged([]).ok, true, 'with no --head the proof reads HEAD');
    assert.equal(judged(['--head', first]).ok, false, 'an older --head still lacks the guard');
    assert.equal(judged(['--head', second.slice(0, 12)]).ok, true, 'a short sha names the same commit');

    writeFileSync(join(root, 'lib', 'new.rb'), 'return if amount.nil?\n');
    writeFileSync(f.dropped, JSON.stringify([{ raw: 1, reason: 'disproved', proof: 'lib/new.rb:1 return if amount.nil?' }]));
    const untracked = judged(['--head', second]);
    assert.equal(untracked.ok, false);
    assert.match(untracked.reason, /no file lib\/new\.rb exists in the repository/, 'a working-tree-only file does not exist at the commit');
    writeFileSync(f.dropped, JSON.stringify([{ raw: 1, reason: 'disproved', proof }]));

    for (const bad of ['not-a-commit', '-x', '', 'HEAD:lib/pay.rb', `${second}^{tree}`]) {
      const r = proofAt(['--head', bad]);
      assert.equal(r.code, 1, bad);
      const parsed = JSON.parse(r.s);
      assert.equal(parsed.ok, false, bad);
      assert.equal(parsed.stage, 'config', bad);
      assert.match(parsed.reason, /--head .* is not a commit in /, bad);
    }
    const missing = proofAt(['--head']);
    assert.equal(missing.code, 1);
    assert.match(missing.s, PROOF_USAGE);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a default-engine repo's other commands are unaffected", () => {
  const root = optionsRoot();
  try {
    const at = ['--root', root, '--review-dir', 'rd'];
    assert.doesNotMatch(readFileSync(join(root, 'rd', 'config.yml'), 'utf8'), /^engine:/m);
    const get = run(['config', 'get', 'profile', ...at]);
    assert.equal(get.code, 0, get.s);
    assert.equal(get.s, 'standard\n');
    const options = run(['options', '--args', '', ...at]);
    assert.equal(options.code, 0, options.s);
    assert.equal(JSON.parse(options.s).engine.value, 'agent-review');
    assert.equal(run(['config', 'validate', ...at]).code, 0);
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

function spawnCli(args, { dir, input = '', env = {} }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: dir, ...env },
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

const PLUGIN_ROOT = join(__dirname, '..');
const HOOK_ENTRY = join(PLUGIN_ROOT, 'bin', 'agent-review-hook');
const BUNDLE = join(PLUGIN_ROOT, 'dist', 'agent-review.cjs');

test('the light hook entry and captureDir agree on the capture dir, the arm file, and the arm age limit', () => {
  const { captureDir, CAPTURE_FILES, ARM_MAX_AGE_SECONDS } = require('./captureHook.cjs');
  const hookEntry = require(HOOK_ENTRY);
  const { hookCaptureDir, ARM_FILE } = hookEntry;
  assert.equal(hookCaptureDir({}), captureDir({}));
  assert.equal(hookCaptureDir({ AGENT_REVIEW_CAPTURE_DIR: '/x/y' }), captureDir({ AGENT_REVIEW_CAPTURE_DIR: '/x/y' }));
  assert.equal(hookCaptureDir({ AGENT_REVIEW_CAPTURE_DIR: '' }), captureDir({ AGENT_REVIEW_CAPTURE_DIR: '' }));
  assert.equal(ARM_FILE, CAPTURE_FILES.arm);
  assert.equal(hookEntry.ARM_MAX_AGE_SECONDS, ARM_MAX_AGE_SECONDS, 'the light entry keeps its own copy of the arm age limit');
});

// Runs the light entry with a preload that records every module loaded, to see whether the bundle was.
function spawnHookEntry(name, { dir, input }) {
  const probe = mkdtempSync(join(os.tmpdir(), 'ar-hook-probe-'));
  try {
    const preload = join(probe, 'record.cjs');
    const loaded = join(probe, 'loaded.json');
    writeFileSync(preload, `process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(Object.keys(require.cache))));\n`);
    const r = spawnSync(process.execPath, ['--require', preload, HOOK_ENTRY, name], {
      input,
      encoding: 'utf8',
      env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: dir },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, bundleLoaded: JSON.parse(readFileSync(loaded, 'utf8')).includes(BUNDLE) };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test('the light hook entry exits 0 silently without loading the bundle when nothing is armed', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const dir = join(parent, 'cap');
    mkdirSync(dir, { mode: 0o700 });
    for (const [name, payload] of [['post-skill', HEADLESS_SKILL], ['subagent-stop', FORK_STOP]]) {
      for (const at of [dir, join(parent, 'missing')]) {
        const r = spawnHookEntry(name, { dir: at, input: JSON.stringify(payload) });
        assert.deepEqual(r, { ...QUIET, bundleLoaded: false }, `${name} in ${at}`);
      }
    }
    assert.deepEqual(readdirSync(dir), [], 'nothing is written while not armed');

    const { ARM_MAX_AGE_SECONDS } = require('./captureHook.cjs');
    const now = Math.floor(Date.now() / 1000);
    const arm = join(dir, 'agent_review_capture.json');
    for (const [label, text] of [
      ['a stale arm', JSON.stringify({ armed: true, run_id: 'r1', args: 'xhigh 12', created: now - ARM_MAX_AGE_SECONDS - 60 })],
      ['armed: false', JSON.stringify({ armed: false, run_id: 'r1', args: 'xhigh 12', created: now })],
      ['armed: "true"', JSON.stringify({ armed: 'true', run_id: 'r1', args: 'xhigh 12', created: now })],
      ['no created time', JSON.stringify({ armed: true, run_id: 'r1', args: 'xhigh 12' })],
      ['a string created time', JSON.stringify({ armed: true, run_id: 'r1', args: 'xhigh 12', created: String(now) })],
      ['malformed JSON', '{"armed": true,'],
      ['JSON null', 'null'],
      ['an empty file', ''],
    ]) {
      writeFileSync(arm, text);
      for (const [name, payload] of [['post-skill', HEADLESS_SKILL], ['subagent-stop', FORK_STOP]]) {
        const r = spawnHookEntry(name, { dir, input: JSON.stringify(payload) });
        assert.deepEqual(r, { ...QUIET, bundleLoaded: false }, `${label}: ${name}`);
      }
    }
    rmSync(arm);
    mkdirSync(arm);
    assert.deepEqual(spawnHookEntry('post-skill', { dir, input: JSON.stringify(HEADLESS_SKILL) }), { ...QUIET, bundleLoaded: false }, 'an unreadable arm file');
    rmSync(arm, { recursive: true });
    assert.deepEqual(readdirSync(dir), [], 'nothing is written for a stale or disarmed arm');

    writeFileSync(arm, JSON.stringify({ armed: true, run_id: 'r1', args: 'xhigh 12', created: now - ARM_MAX_AGE_SECONDS + 60 }));
    assert.deepEqual(spawnHookEntry('subagent-stop', { dir, input: JSON.stringify(FORK_STOP) }), { ...QUIET, bundleLoaded: true }, 'an arm inside the age limit hands off');

    armCapture(dir);
    const armed = spawnHookEntry('subagent-stop', { dir, input: JSON.stringify(FORK_STOP) });
    assert.deepEqual(armed, { ...QUIET, bundleLoaded: true }, 'an arm file hands off to the bundle');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the hooks.json commands write a capture end to end through the light entry', () => {
  const config = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const [postSkill] = config.hooks.PostToolUse[0].hooks;
  const [subagentStop] = config.hooks.SubagentStop[0].hooks;
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  const hook = (command, payload) => {
    const r = spawnSync('/bin/sh', ['-c', command.command], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, AGENT_REVIEW_CAPTURE_DIR: dir },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    armCapture(dir);
    const background = { ...HEADLESS_SKILL, tool_response: { ...HEADLESS_SKILL.tool_response, background: true, result: 'launched' } };
    assert.deepEqual(hook(postSkill, background), QUIET);
    assert.equal(readCaptureJson(dir, 'code_review_capture.pending.json').fork_id, 'f1');
    assert.equal(existsSync(join(dir, 'code_review_capture.json')), false);
    assert.deepEqual(hook(subagentStop, FORK_STOP), QUIET);
    const capture = readCaptureJson(dir, 'code_review_capture.json');
    assert.equal(capture.mode, 'forked');
    assert.equal(capture.result, '- a.rb:1: bug');
    assert.equal(capture.stop_count, 1);
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

test('hooks exit 0 silently when the session cwd was removed', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const gone = join(parent, 'gone');
    const dir = join(parent, 'capture');
    mkdirSync(dir, { mode: 0o700 });
    armCapture(dir);
    const inRemovedCwd = (args, captureDirPath, input = '') => {
      const r = spawnSync(
        'sh',
        ['-c', 'mkdir "$1" && cd "$1" && rmdir "$1" && shift && exec "$@"', 'sh', gone, process.execPath, CLI, ...args],
        { input, encoding: 'utf8', env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: captureDirPath } },
      );
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };

    const control = inRemovedCwd(['help'], dir);
    assert.equal(control.code, 1, 'a command that needs the cwd fails there, so the cwd really is gone');
    assert.match(control.stderr, /uv_cwd|ENOENT/);

    const missing = join(parent, 'missing');
    assert.deepEqual(inRemovedCwd(['hook', 'post-skill'], missing, JSON.stringify(HEADLESS_SKILL)), QUIET);
    assert.deepEqual(inRemovedCwd(['hook', 'subagent-stop'], missing, JSON.stringify(FORK_STOP)), QUIET);

    assert.deepEqual(inRemovedCwd(['hook', 'subagent-stop'], dir, JSON.stringify(FORK_STOP)), QUIET);
    assert.deepEqual(inRemovedCwd(['hook', 'post-skill'], dir, JSON.stringify(HEADLESS_SKILL)), QUIET);
    const capture = readCaptureJson(dir, 'code_review_capture.json');
    assert.equal(capture.result, '- a.rb:1: bug', 'an armed hook still captures from a removed cwd');
    assert.equal(capture.stop_count, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a command printing through out() delivers more than 64 KiB through a pipe intact', () => {
  const { mergeLedger } = require('./reportState.cjs');
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-out-'));
  try {
    const findings = { kept: Array.from({ length: 1500 }, (_, i) => ({
      signature: `sig-${i}`, agent: 'correctness', category: 'correctness',
      severity: 5, file: `lib/file_${i}.rb`, line: i + 1, message: `café finding ${i} `.padEnd(120, 'x'),
    })) };
    const findingsPath = join(dir, 'findings.json');
    writeFileSync(findingsPath, JSON.stringify(findings));
    const expected = JSON.stringify(mergeLedger([], findings), null, 2) + '\n';
    assert.ok(Buffer.byteLength(expected) > 3 * 65536, `fixture is ${Buffer.byteLength(expected)} bytes`);

    const r = spawnSync(process.execPath, [CLI, 'ledger', '--findings', findingsPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(Buffer.byteLength(r.stdout), Buffer.byteLength(expected));
    assert.equal(r.stdout, expected);
    assert.equal(run(['ledger', '--findings', findingsPath]).s, expected, 'in-process output is the same bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FAST_POLL = { AGENT_REVIEW_CAPTURE_POLL_MS: '10' };

function captureWait(dir, args, env = {}) {
  const started = Date.now();
  const r = spawnCli(['capture-wait', ...args], { dir, env: { ...FAST_POLL, ...env } });
  assert.equal(r.stderr, '', 'capture-wait reports through its JSON line');
  assert.match(r.stdout, /^[^\n]+\n$/, `one JSON line: ${JSON.stringify(r.stdout)}`);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(json), ['status', 'reason', 'stop_count', 'mode']);
  assert.equal(typeof json.reason, 'string');
  return { code: r.code, json, ms: Date.now() - started };
}

function armRun(dir, { run = 'r1', args = 'xhigh 12', created = Math.floor(Date.now() / 1000) } = {}) {
  writeFileSync(join(dir, 'agent_review_capture.json'), JSON.stringify({ armed: true, run_id: run, args, created }));
}

function writeCapture(dir, over = {}) {
  writeFileSync(
    join(dir, 'code_review_capture.json'),
    JSON.stringify({
      source: 'agent-review-capture-hook',
      mode: 'forked',
      run_id: 'r1',
      args: 'xhigh 12',
      fork_id: 'f1',
      result: '(none)',
      transcript: null,
      stop_count: 1,
      ts: 1,
      ...over,
    }),
  );
}

const JSON_LIST_RESULT = 'Summary.\n\n```json\n[{"file": "a.rb", "line": 3, "summary": "s"}]\n```\n';

test('capture-wait finishes on a matching capture', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir);
    writeCapture(dir, { result: JSON_LIST_RESULT });
    const done = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(done.code, 0);
    assert.equal(done.json.status, 'finished');
    assert.equal(done.json.stop_count, 1);
    assert.equal(done.json.mode, 'forked');
    assert.ok(done.ms < 5000, `took ${done.ms} ms`);

    armRun(dir, { args: 'low 12' });
    writeCapture(dir, { mode: 'foreground', stop_count: 0, result: '- a.rb:1: bug' });
    const foreground = captureWait(dir, ['--run', 'r1', '--effort', 'low', '--timeout', '30']);
    assert.equal(foreground.code, 0, 'a foreground capture with no stops counts');
    assert.deepEqual([foreground.json.stop_count, foreground.json.mode], [0, 'foreground']);

    armRun(dir, { args: 'high 12' });
    writeCapture(dir, { result: '' });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'high', '--timeout', '30']).code, 0, 'an empty result fails in the proof, not by waiting');

    armRun(dir, { args: 'max 12 --max-findings all' });
    writeCapture(dir, { result: 'I launched three helpers and will merge their findings.', stop_count: 2 });
    const prose = captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '0.05']);
    assert.equal(prose.code, 3, 'prose at max keeps waiting');
    assert.deepEqual([prose.json.status, prose.json.stop_count, prose.json.mode], ['waiting', 2, 'forked']);
    armRun(dir, { args: 'xhigh 12' });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0.05']).code, 0, 'prose below max is finished');

    armRun(dir, { args: 'max 12 --max-findings all' });
    writeCapture(dir, { result: JSON_LIST_RESULT, stop_count: 3 });
    const max = captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '0.05']);
    assert.equal(max.code, 0, 'a findings list at max is finished');
    assert.equal(max.json.stop_count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture-wait keeps waiting on another run's capture and exits 3", () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir);
    const none = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0']);
    assert.equal(none.code, 3, 'no capture yet');
    assert.deepEqual(none.json, { status: 'waiting', reason: none.json.reason, stop_count: null, mode: null });

    writeCapture(dir, { run_id: 'r2', result: JSON_LIST_RESULT });
    const other = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0.2']);
    assert.equal(other.code, 3);
    assert.deepEqual([other.json.status, other.json.stop_count, other.json.mode], ['waiting', null, null]);
    assert.ok(other.ms >= 200, `waited the timeout out (${other.ms} ms)`);
    assert.match(other.json.reason, /capture-wait/, 'the reason says to run it again');

    writeCapture(dir, { source: 'something-else', result: JSON_LIST_RESULT });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0']).code, 3, 'a file the hook did not write is not a capture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait fails at once on a mismatch record and prints both args', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir, { args: 'xhigh 12' });
    const got = 'xhigh  12 --max-findings all';
    writeFileSync(join(dir, 'code_review_capture.mismatch.json'), JSON.stringify({ run_id: 'r1', expected: 'xhigh 12', got, ts: 1 }));
    const r = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(r.code, 1);
    assert.equal(r.json.status, 'failed');
    assert.ok(r.ms < 5000, `failed within one poll (${r.ms} ms)`);
    assert.ok(r.json.reason.includes(JSON.stringify('xhigh 12')), r.json.reason);
    assert.ok(r.json.reason.includes(JSON.stringify(got)), r.json.reason);
    assert.match(r.json.reason, /re-armed/, 'a mismatch stays until the run is armed again');
    assert.doesNotMatch(r.json.reason, /call the Skill tool with exactly the armed args/);

    writeCapture(dir, { result: 'Still reviewing.', stop_count: 1 });
    armRun(dir, { args: 'max 12' });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '30']).code, 1, 'an unfinished capture does not cover a mismatch');
    armRun(dir, { args: 'xhigh 12' });
    rmSync(join(dir, 'code_review_capture.json'));

    writeFileSync(join(dir, 'code_review_capture.mismatch.json'), JSON.stringify({ run_id: 'r0', expected: 'xhigh 12', got, ts: 1 }));
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0']).code, 3, "another run's mismatch is ignored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait: a finished matching capture wins over a mismatch record', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir, { args: 'xhigh 12' });
    writeFileSync(join(dir, 'code_review_capture.mismatch.json'), JSON.stringify({ run_id: 'r1', expected: 'xhigh 12', got: 'xhigh  12', ts: 1 }));
    writeFileSync(
      join(dir, 'code_review_capture.json'),
      JSON.stringify({ source: 'agent-review-capture-hook', mode: 'forked', run_id: 'r1', args: 'xhigh 12', result: '(none)', stop_count: 1 }),
    );
    const r = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(r.code, 0, r.json.reason);
    assert.deepEqual([r.json.status, r.json.stop_count, r.json.mode], ['finished', 1, 'forked']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait fails when --effort is not the armed effort', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir, { args: 'xhigh 12 --max-findings all' });
    writeCapture(dir, { result: 'I launched three helpers.' });
    for (const effort of ['max', 'high', 'low']) {
      const r = captureWait(dir, ['--run', 'r1', '--effort', effort, '--timeout', '30']);
      assert.equal(r.code, 1, effort);
      assert.equal(r.json.status, 'failed', effort);
      assert.ok(r.json.reason.includes(effort), r.json.reason);
      assert.ok(r.json.reason.includes(JSON.stringify('xhigh 12 --max-findings all')), r.json.reason);
      assert.ok(r.ms < 5000, `${effort}: failed at once (${r.ms} ms)`);
    }
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']).code, 0, 'the armed effort finishes');
    armRun(dir, { args: '  max 12' });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '0']).code, 3, 'leading spaces do not hide the effort');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait --timeout defaults to 540 and clamps to 590 seconds', () => {
  assert.equal(captureWaitTimeout(undefined), 540);
  assert.equal(captureWaitTimeout('0'), 0);
  assert.equal(captureWaitTimeout('0.05'), 0.05);
  assert.equal(captureWaitTimeout('30'), 30);
  assert.equal(captureWaitTimeout('590'), 590);
  assert.equal(captureWaitTimeout('591'), 590);
  assert.equal(captureWaitTimeout('100000'), 590);
  for (const bad of ['soon', '-1', '', ' 5', '5s', '1e3']) assert.equal(captureWaitTimeout(bad), null, JSON.stringify(bad));
});

test('capture-wait fails after the overall limit', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    const created = Math.floor(Date.now() / 1000) - 41 * 60;
    armRun(dir, { created });
    const late = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(late.code, 1);
    assert.equal(late.json.status, 'failed');
    assert.match(late.json.reason, /40-minute/);
    assert.ok(late.ms < 5000, `failed at once (${late.ms} ms)`);

    armRun(dir, { args: 'max 12', created });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '0']).code, 3, 'the max limit is 120 minutes');

    armRun(dir, { created });
    writeCapture(dir, { result: JSON_LIST_RESULT });
    assert.equal(captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']).code, 0, 'a finished capture still counts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait fails with no arm for the run or a refused dir, and checks its arguments', () => {
  const parent = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  const dir = join(parent, 'capture');
  try {
    const missing = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(missing.code, 1);
    assert.match(missing.json.reason, /does not exist/);

    mkdirSync(dir, { mode: 0o700 });
    writeCapture(dir, { result: JSON_LIST_RESULT });
    const unarmed = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(unarmed.code, 1);
    assert.equal(unarmed.json.status, 'failed');
    assert.match(unarmed.json.reason, /not armed/);

    armRun(dir, { run: 'r2' });
    const otherRun = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(otherRun.code, 1);
    assert.match(otherRun.json.reason, /r2/);
    assert.match(otherRun.json.reason, /r1/);

    armRun(dir);
    chmodSync(dir, 0o770);
    const open = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(open.code, 1);
    assert.match(open.json.reason, /group or other permission bits/);
    chmodSync(dir, 0o700);

    for (const args of [
      ['--effort', 'xhigh'],
      ['--run', 'r1'],
      ['--run', 'r1', '--effort', 'huge'],
      ['--run', 'r1', '--effort', 'xhigh', '--timeout', 'soon'],
      ['--run', 'r1', '--effort', 'xhigh', '--timeout', '-1'],
    ]) {
      const r = spawnCli(['capture-wait', ...args], { dir, env: FAST_POLL });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stdout, /^usage: agent-review capture-wait/, args.join(' '));
    }
    assert.match(run(['help']).s, /^ {2}capture-wait --run <id> --effort <low\|medium\|high\|xhigh\|max> \[--timeout <seconds>\] {2,}/m);
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});

const HOOKS_DID_NOT_RUN =
  'the capture hooks did not run: restart Claude Code after installing or updating the plugin, and check that plugin hooks are allowed';
const SHORT_HOOK_GRACE = { AGENT_REVIEW_CAPTURE_HOOK_GRACE_MS: '150' };

test('capture-wait fails fast when no hook wrote anything for the run', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armRun(dir);
    const silent = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30'], SHORT_HOOK_GRACE);
    assert.equal(silent.code, 1);
    assert.deepEqual(silent.json, { status: 'failed', reason: HOOKS_DID_NOT_RUN, stop_count: null, mode: null });
    assert.ok(silent.ms >= 150 && silent.ms < 5000, `failed soon after the grace period (${silent.ms} ms)`);

    writeFileSync(join(dir, 'code_review_capture.pending.json'), JSON.stringify({ run_id: 'r0', fork_id: 'f1' }));
    assert.equal(
      captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30'], SHORT_HOOK_GRACE).json.reason,
      HOOKS_DID_NOT_RUN,
      "another run's pending file is not this run's",
    );

    writeFileSync(join(dir, 'code_review_capture.pending.json'), JSON.stringify({ run_id: 'r1', fork_id: 'f1' }));
    const pending = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0.4'], SHORT_HOOK_GRACE);
    assert.equal(pending.code, 3, 'a pending file shows the hooks ran, so the wait goes on');
    rmSync(join(dir, 'code_review_capture.pending.json'));

    armRun(dir, { args: 'max 12' });
    writeCapture(dir, { result: 'I launched helpers.' });
    assert.equal(
      captureWait(dir, ['--run', 'r1', '--effort', 'max', '--timeout', '0.4'], SHORT_HOOK_GRACE).code,
      3,
      'an unfinished capture shows the hooks ran',
    );
    rmSync(join(dir, 'code_review_capture.json'));

    armRun(dir);
    const quick = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '0.2']);
    assert.equal(quick.code, 3, 'the default grace is far longer than this call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-wait names a wrong skill or a missing fork id from the hook', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    armCapture(dir);
    const wrongSkill = { ...HEADLESS_SKILL, tool_input: { skill: 'code-review:code-review', args: 'xhigh 12' } };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(wrongSkill) }), QUIET);
    const wrong = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(wrong.code, 1);
    assert.ok(wrong.ms < 5000, `failed at once (${wrong.ms} ms)`);
    assert.ok(wrong.json.reason.includes('skill "code-review:code-review" with args "xhigh 12"'), wrong.json.reason);
    assert.match(wrong.json.reason, /built-in "code-review" skill/);
    assert.match(wrong.json.reason, /re-armed/);

    armCapture(dir);
    rmSync(join(dir, 'code_review_capture.mismatch.json'));
    const noFork = { ...HEADLESS_SKILL, tool_response: { success: true, status: 'forked', background: true, result: 'Running' } };
    assert.deepEqual(spawnCli(['hook', 'post-skill'], { dir, input: JSON.stringify(noFork) }), QUIET);
    assert.equal(existsSync(join(dir, 'code_review_capture.pending.json')), false, 'no pending file without a fork id');
    const lost = captureWait(dir, ['--run', 'r1', '--effort', 'xhigh', '--timeout', '30']);
    assert.equal(lost.code, 1);
    assert.match(lost.json.reason, /no fork id/);
    assert.match(lost.json.reason, /re-armed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a foreground capture counts as finished at every effort, max included', () => {
  assert.equal(looksFinished('I launched helpers and will merge their findings.', 'max', 'foreground'), true);
  assert.equal(looksFinished('I launched helpers and will merge their findings.', 'max', 'forked'), false);
  assert.equal(looksFinished(undefined, 'max', 'foreground'), false, 'a capture with no text is never finished');
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    for (const effort of EFFORTS) {
      armRun(dir, { args: `${effort} 12` });
      writeCapture(dir, { mode: 'foreground', stop_count: 0, result: 'Reviewed. Nothing stood out beyond style.' });
      const r = captureWait(dir, ['--run', 'r1', '--effort', effort, '--timeout', '0.05']);
      assert.equal(r.code, 0, effort);
      assert.deepEqual([r.json.status, r.json.mode], ['finished', 'foreground'], effort);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture disarm removes the arm and every capture file, and nothing else', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-capture-'));
  try {
    assert.equal(spawnCli(['capture', 'arm', '--run', 'r1', '--args', 'xhigh 12'], { dir }).code, 0);
    for (const name of [
      'code_review_capture.json',
      'code_review_capture.pending.json',
      'code_review_capture.stops.jsonl',
      'code_review_capture.mismatch.json',
    ]) {
      writeFileSync(join(dir, name), '{}');
    }
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const r = spawnCli(['capture', 'disarm'], { dir });
    assert.deepEqual(r, { code: 0, stdout: 'disarmed\n', stderr: '' });
    assert.deepEqual(readdirSync(dir), ['unrelated.json']);
    assert.equal(spawnCli(['capture', 'show', '--run', 'r1'], { dir }).code, 1, 'nothing can read the capture after disarm');
    assert.match(run(['help']).s, /^ {2}capture disarm {2,}.*every capture file/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
