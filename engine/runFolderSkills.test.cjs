'use strict';
// The skills keep every review file in the run folder `agent-review run-dir` prints, so reviews
// running at once on one machine never share state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const ROOT = join(__dirname, '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// Every skill that runs a review, or works on one's state, plus the prompts and report they fill.
const RUN_FOLDER_FILES = [
  'skills/review/SKILL.md',
  'skills/review/code-review-engine.md',
  'skills/re-review/SKILL.md',
  'skills/yolo-review/SKILL.md',
  'skills/address/SKILL.md',
  'skills/update-files/SKILL.md',
  'templates/archetype.md',
  'templates/code-review-lane.md',
  'templates/ledger-match.md',
  'templates/report.md',
];
const SYNTAX_CHECKED = [
  'skills/review/SKILL.md',
  'skills/review/code-review-engine.md',
  'skills/yolo-review/SKILL.md',
  'skills/update-files/SKILL.md',
];
const RUN_DIR_LINE = /^RUN_DIR=\$\(agent-review run-dir(?: --lock [a-z-]+(?: --outer)?)?\) \|\| exit 1; export RUN_DIR$/;

function bashBlocks(text) {
  return [...text.matchAll(/^( *)```bash\n([\s\S]*?)\n\1```$/gm)].map((m) =>
    m[2]
      .split('\n')
      .map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l))
      .join('\n'),
  );
}

function shells() {
  return ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
}

test('no review skill, lane prompt or report names a fixed /tmp file', () => {
  for (const file of RUN_FOLDER_FILES) {
    const hits = read(file)
      .split('\n')
      .filter((line) => /\/tmp\/(?!agent-review-)[A-Za-z_]/.test(line));
    assert.deepStrictEqual(hits, [], `${file} still names a fixed /tmp file`);
  }
});

test('every block that uses the run folder finds it first, and stops when it cannot', () => {
  for (const file of ['skills/review/SKILL.md', 'skills/review/code-review-engine.md', 'skills/yolo-review/SKILL.md', 'skills/address/SKILL.md']) {
    for (const block of bashBlocks(read(file))) {
      if (!/\$RUN_DIR|process\.env\.RUN_DIR/.test(block)) continue;
      const first = block.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      assert.match(first, RUN_DIR_LINE, `${file}: a block must open with the run-dir line:\n${block.slice(0, 300)}`);
      assert.strictEqual(block.split('\n').filter((l) => /^RUN_DIR=/.test(l)).length, 1, `${file}: one run-dir line per block`);
    }
  }
});

test('the run folder is never expanded inside single quotes or a quoted heredoc', () => {
  for (const file of RUN_FOLDER_FILES.filter((f) => f.startsWith('skills/'))) {
    for (const block of bashBlocks(read(file))) {
      for (const [, script] of block.matchAll(/node -e '([^']*)'/g)) {
        assert.ok(!script.includes('$RUN_DIR'), `${file}: a node -e script must read process.env.RUN_DIR:\n${script.slice(0, 200)}`);
      }
      for (const [, body] of block.matchAll(/node - <<'([A-Z]+)'\n([\s\S]*?)\n\1/g)) {
        assert.ok(!body.includes('$RUN_DIR'), `${file}: a node heredoc must read process.env.RUN_DIR`);
      }
      for (const line of block.split('\n')) {
        assert.ok(!/(^|[^"])\$RUN_DIR"\//.test(line) && !line.includes('""$RUN_DIR'), `${file}: a run path is quoted whole or as "$RUN_DIR"/...: ${line}`);
      }
    }
  }
});

test('the run-folder skill blocks parse under bash and zsh', () => {
  for (const file of SYNTAX_CHECKED) {
    for (const [i, block] of bashBlocks(read(file)).entries()) {
      for (const sh of shells()) {
        const r = spawnSync(sh, ['-n', '-c', block], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `${file} block ${i + 1} does not parse in ${sh}: ${r.stderr}`);
      }
    }
  }
});

test('the review takes the checkout first and frees it at the end or on any early stop', () => {
  const skill = read('skills/review/SKILL.md');
  const init = skill.slice(skill.indexOf('### Initialize'), skill.indexOf('### Gather PR Context & Diff Manifest'));
  const first = bashBlocks(init)[0];
  assert.ok(first.startsWith('RUN_DIR=$(agent-review run-dir --lock review) || exit 1; export RUN_DIR\n'));
  assert.ok(first.includes('\necho "run folder: $RUN_DIR"\n'), 'the model learns the literal path for prompts and its own writes');
  for (const f of ['agent_review_report.md', 'agent_review_ledger.json', 'agent_review_status.json', 'agent_review_inline.json', 'agent_review_safety.json', 'agent_review_comment.md']) {
    assert.match(first, new RegExp(`^rm -f [^\\n]*"\\$RUN_DIR"/${f.replace('.', '\\.')}`, 'm'), `Initialize clears an earlier ${f}`);
  }
  const stage8 = skill.slice(skill.indexOf('## Stage 8'), skill.indexOf('## Notes'));
  assert.deepStrictEqual(bashBlocks(stage8), ['agent-review run-dir --release review'], 'Stage 8 ends by releasing the checkout');
  const flat = skill.replace(/\s+/g, ' ');
  for (const needle of [
    'whenever the run stops before Stage 8, for any reason (a ❌ line, a skip, a head already reviewed, a lane that failed twice), run Stage 8\'s **Finish the run** block before you stop',
    'If `agent-review run-dir` fails, stop and show its error: never fall back to `/tmp`.',
    "So in every prompt you hand a subagent, every file you write yourself, and every path you show the user, write the run folder's literal path where this skill says `$RUN_DIR`: the path Stage 0A's first block prints as `run folder: <path>`",
  ]) {
    assert.ok(flat.includes(needle), `SKILL.md must say ${JSON.stringify(needle)}`);
  }
  const yolo = read('skills/yolo-review/SKILL.md');
  assert.ok(bashBlocks(yolo)[0].startsWith('RUN_DIR=$(agent-review run-dir --lock yolo-review --outer) || exit 1; export RUN_DIR\necho "run folder: $RUN_DIR"\n'));
  assert.ok(yolo.includes('first run `agent-review run-dir --release yolo-review`'));
  const address = read('skills/address/SKILL.md');
  const local = address.slice(address.indexOf('## Local mode'));
  assert.ok(bashBlocks(local)[0].startsWith('RUN_DIR=$(agent-review run-dir --lock address) || exit 1; export RUN_DIR\necho "run folder: $RUN_DIR"\n'));
  for (const text of [skill, local]) {
    assert.ok(text.replace(/\s+/g, ' ').includes('If it prints `kept` and no yolo-review started this'), 'a stray kept says how to free the checkout');
  }
  assert.ok(local.includes('Run `agent-review run-dir --release address`, then summarize'));
  const ci = address.slice(address.indexOf('## CI mode'), address.indexOf('## Local mode'));
  assert.ok(!ci.includes('run-dir'), 'CI address keeps its workflow-given files');
});

test('lane prompts carry the run folder and the checkout, and the posted Apply line finds the folder itself', () => {
  for (const name of ['archetype.md', 'code-review-lane.md']) {
    const text = read(`templates/${name}`);
    assert.ok(text.includes('begin every command with `cd {{REPO_ROOT}} &&`'), `${name} runs from the checkout`);
    assert.ok(text.includes('{{RUN_DIR}}/'), `${name} names files in the run folder`);
  }
  assert.ok(read('templates/ledger-match.md').includes('`{{RUN_DIR}}/ledger_candidates.json`'));
  const report = read('templates/report.md');
  assert.ok(report.includes('Apply, from the PR\'s checkout: `bash "$(agent-review run-dir)/automated_fixes/fix_N_category.sh"`'));
});

test('CI keeps its run folder at /tmp: the model steps set AGENT_REVIEW_CI', () => {
  const review = read('.github/workflows/review.yml');
  assert.ok(review.includes("AGENT_REVIEW_CI: '1'"), 'the CI review model step sets AGENT_REVIEW_CI');
  assert.ok(review.includes('AGENT_REVIEW_COMMENT_OUT: /tmp/agent_review_comment.md'), 'the publish step still reads /tmp');
  assert.ok(read('test/e2e-review.sh').includes('AGENT_REVIEW_CI=1'), 'the local copy of CI runs in CI mode too');
  const interact = read('.github/workflows/interact.yml');
  assert.ok(interact.includes('ADDRESS_RESULT_OUT: /tmp/address-result.json'), 'CI address writes where the workflow says');
});

test('apply_all.sh finds the fix scripts beside itself, from any folder', (t) => {
  const skill = read('skills/review/SKILL.md');
  const script = skill.match(/apply_all\.sh << 'EOF'\n([\s\S]*?)\nEOF\n/)[1];
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-apply-all-'));
  try {
    const fixes = join(dir, 'run', 'automated_fixes');
    mkdirSync(fixes, { recursive: true });
    writeFileSync(join(fixes, 'apply_all.sh'), `${script}\n`, { mode: 0o755 });
    writeFileSync(join(fixes, 'fix_1_style.sh'), `#!/bin/bash\ntouch "${join(dir, 'applied')}"\n`, { mode: 0o755 });
    const dry = execFileSync('bash', [join(fixes, 'apply_all.sh')], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.ok(dry.includes('===== fix_1_style.sh ====='), dry);
    assert.ok(dry.includes(`bash ${fixes}/apply_all.sh --yes`), dry);
    assert.equal(existsSync(join(dir, 'applied')), false, 'a dry run applies nothing');
    execFileSync('bash', [join(fixes, 'apply_all.sh'), '--yes'], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(existsSync(join(dir, 'applied')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(skill.includes('rm -rf "$RUN_DIR"/automated_fixes\nmkdir -p "$RUN_DIR"/automated_fixes'), 'each run starts with no earlier fix scripts');
});
