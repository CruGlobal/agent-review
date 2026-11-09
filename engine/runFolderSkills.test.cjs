'use strict';
// The skills keep every review file in the run folder `agent-review run-dir` prints, so reviews
// running at once on one machine never share state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require('node:fs');
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
  'skills/init/SKILL.md',
  'templates/archetype.md',
  'templates/code-review-lane.md',
  'templates/ledger-match.md',
  'templates/report.md',
];
const SYNTAX_CHECKED = [
  'skills/review/SKILL.md',
  'skills/review/code-review-engine.md',
  'skills/yolo-review/SKILL.md',
  'skills/address/SKILL.md',
  'skills/update-files/SKILL.md',
  'skills/init/SKILL.md',
];
// Lines a skill asks the model to fill in before running the block, so they are not shell yet.
const FILL_INS = {
  'skills/address/SKILL.md': ['git add -- <each file you changed or created for these fixes>'],
  'skills/init/SKILL.md': ['gh pr diff <n>                      # only when a lens needs the actual code'],
};
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
  for (const file of ['skills/review/SKILL.md', 'skills/review/code-review-engine.md', 'skills/yolo-review/SKILL.md', 'skills/address/SKILL.md', 'skills/init/SKILL.md']) {
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
    const fillIns = FILL_INS[file] || [];
    const blocks = bashBlocks(read(file));
    for (const line of fillIns) {
      assert.strictEqual(blocks.filter((b) => b.split('\n').includes(line)).length, 1, `${file} still has the fill-in line ${line}`);
    }
    for (const [i, raw] of blocks.entries()) {
      const block = raw
        .split('\n')
        .map((l) => (fillIns.includes(l) ? ': fill-in' : l))
        .join('\n');
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
  assert.ok(first.includes('\necho "run folder: $RUN_DIR"\necho "checkout: $(git rev-parse --show-toplevel)"\n'), 'the model learns the literal paths for prompts and its own writes');
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

test('init takes the checkout first and frees it at the end or on any early stop', () => {
  const skill = read('skills/init/SKILL.md');
  const blocks = bashBlocks(skill);
  assert.ok(blocks[0].startsWith('RUN_DIR=$(agent-review run-dir --lock init) || exit 1; export RUN_DIR\necho "run folder: $RUN_DIR"\n'), 'the first block takes the checkout and prints the literal folder');
  assert.strictEqual(blocks.filter((b) => b.includes('--lock')).length, 1, 'only the first block takes the checkout');
  assert.ok(!skill.includes('agent_review_init'), 'no state file is left at a fixed name');
  for (const name of ['init.sh', 'init_baseline_head.txt', 'init_baseline_status.txt', 'init_now_head.txt', 'init_now_status.txt', 'init_prs.json', 'init_stage.txt', 'init_changed.txt']) {
    assert.ok(skill.includes(`"$RUN_DIR"/${name}`), `init keeps ${name} in the run folder`);
  }
  const guard = blocks.find((b) => b.includes('[ -f "$RUN_DIR"/init_baseline_head.txt ]'));
  assert.ok(guard.startsWith('RUN_DIR=$(agent-review run-dir) || exit 1; export RUN_DIR\n'), 'the baseline block finds the folder first');
  const recheck = blocks.find((b) => b.includes('"$RUN_DIR"/init_now_head.txt'));
  assert.ok(recheck.includes('diff "$RUN_DIR"/init_baseline_head.txt "$RUN_DIR"/init_now_head.txt') && recheck.includes('diff "$RUN_DIR"/init_baseline_status.txt "$RUN_DIR"/init_now_status.txt'), 'the guard still compares baseline to now');
  const report = skill.indexOf('### 3F');
  assert.deepStrictEqual(bashBlocks(skill.slice(skill.indexOf('### Finish the run'))), ['agent-review run-dir --release init'], 'the last block releases the checkout');
  assert.ok(skill.indexOf('### Finish the run') > report, 'the release comes after the report');
  const flat = skill.replace(/\s+/g, ' ');
  const drift = flat.slice(flat.indexOf('Any output → **drift**'), flat.indexOf('**What this check cannot see**'));
  assert.ok(drift.includes('This pause is not a stop of the run: do not run **Finish the run** until the revert below is done'), 'a drift pause keeps the baseline files');
  assert.ok(drift.includes('the baseline SHA (the contents of `"$RUN_DIR"/init_baseline_head.txt`) written out in the message'), 'the human is shown the baseline SHA');
  assert.ok(flat.includes('The one exception is a read-only guard drift, which pauses init until the revert is done'), 'the early-stop rule names the drift exception');
  const prose = skill.replace(/^( *)```[\s\S]*?^\1```$/gm, '');
  assert.deepStrictEqual(prose.match(/(?<!"\$RUN_DIR"\/)\binit(\.sh|_[a-z_]+\.(txt|json))\b/g), null, 'prose names an init state file only behind the run folder');
  for (const needle of [
    'whenever init stops before it finishes, for any reason (a refusal to continue, a `--migrate` run, a "no" at the 3B gate, a failed check), run the **Finish the run** block before you stop',
    'If `agent-review run-dir` fails, stop and show its error: never fall back to `/tmp`.',
    'when another live session already holds this checkout, the block prints who holds it and stops, and you must stop too and show that message',
    "no subagent brief here names a state file. If you add one that does, write the run folder's literal path in it",
  ]) {
    assert.ok(flat.includes(needle), `SKILL.md must say ${JSON.stringify(needle)}`);
  }
});

test('lane prompts carry the run folder and the checkout, and the posted Apply line finds the folder itself', () => {
  for (const name of ['archetype.md', 'code-review-lane.md']) {
    const text = read(`templates/${name}`);
    assert.ok(text.includes('begin every command with `cd "{{REPO_ROOT}}" &&`'), `${name} runs from the checkout, quoted`);
    assert.ok(!/cd \{\{REPO_ROOT\}\}/.test(text), `${name} never leaves the checkout path unquoted`);
    assert.ok(text.includes('{{RUN_DIR}}/'), `${name} names files in the run folder`);
  }
  assert.ok(read('templates/ledger-match.md').includes('`{{RUN_DIR}}/ledger_candidates.json`'));
});

test('the posted report names fix scripts without a local path, and the terminal summary gives their paths', () => {
  const report = read('templates/report.md');
  const apply = report.split('\n').find((l) => l.startsWith('Apply:'));
  assert.strictEqual(
    apply,
    "Apply: `/agent-review:address fix N` applies the fix, then commits and pushes it to the PR branch. Or read and run `fix_N_category.sh` yourself, from the reviewer's terminal summary, which lists each fix script by its full path. Fix scripts stay on the reviewer's machine and change nothing until run.",
  );
  for (const local of ['$(', 'run-dir', '/tmp', '$RUN_DIR/automated', '{{RUN_DIR}}', '/Users/', 'agent-review-']) {
    assert.ok(!apply.includes(local), `the posted Apply line carries no local path or command: ${local}`);
  }
  const skill = read('skills/review/SKILL.md');
  const stage2b = skill.slice(skill.indexOf('## Stage 2B'), skill.indexOf('## Stage 3'));
  assert.ok(
    bashBlocks(stage2b)[0].includes('for fix in "$RUN_DIR"/automated_fixes/fix_*.sh; do\n    [ -f "$fix" ] && printf \'  bash "%s"\\n\' "$fix"\n  done'),
    'Stage 2B prints each fix script by its literal, quoted path',
  );
  const stage8 = skill.slice(skill.indexOf('## Stage 8'), skill.indexOf('### Finish the run'));
  assert.ok(stage8.includes('the `bash "<path>"` line Stage 2B printed, word for word'), 'the summary repeats those lines');

  const dir = mkdtempSync(join(os.tmpdir(), 'ar fix paths '));
  try {
    mkdirSync(join(dir, 'automated_fixes'));
    writeFileSync(join(dir, 'automated_fixes', 'fix_1_style.sh'), '');
    const loop = bashBlocks(stage2b)[0].match(/^ {2}for fix in[\s\S]*?^ {2}done$/m)[0];
    for (const sh of shells()) {
      const printed = execFileSync(sh, ['-c', loop], { encoding: 'utf8', env: { ...process.env, RUN_DIR: dir } });
      assert.strictEqual(printed, `  bash "${dir}/automated_fixes/fix_1_style.sh"\n`, `${sh}: a path with spaces comes out quoted`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('update-files removes its fetched templates on every way it stops, the every-file-current one included', () => {
  const skill = read('skills/update-files/SKILL.md');
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(flat.includes('If every file is current, say so, run the **Clean up** block at the end of this skill, and stop here.'));
  const cleanup = skill.slice(skill.indexOf('## Clean up'));
  assert.ok(cleanup.replace(/\s+/g, ' ').includes('Whenever this skill stops after Stage 1, for any reason'));
  assert.deepStrictEqual(bashBlocks(cleanup), ['UPDATE_DIR=$(agent-review run-dir)/update-files && rm -rf "$UPDATE_DIR"']);
  assert.ok(skill.indexOf('## Clean up') > skill.indexOf('### Diff and PR'), 'the cleanup is the last step');
});

test('Stage 2B counts, lists and applies only fix scripts named fix_<number>_<category>.sh, in bash and zsh', () => {
  const skill = read('skills/review/SKILL.md');
  const block = bashBlocks(skill.slice(skill.indexOf('## Stage 2B'), skill.indexOf('## Stage 3')))[0];
  assert.ok(block.startsWith('RUN_DIR=$(agent-review run-dir) || exit 1; export RUN_DIR\n'));
  const hostile = ['fix_2_a"b.sh', 'fix_3_$(touch pwned).sh', 'fix_4_back`id`tick.sh', 'fix_5_Upper.sh', 'fix_x_style.sh', 'fix_6_ok.sh\nevil.sh', 'fix_7_sp ace.sh'];
  for (const sh of shells()) {
    const dir = mkdtempSync(join(os.tmpdir(), 'ar-fix-names-'));
    try {
      const fixes = join(dir, 'automated_fixes');
      mkdirSync(fixes);
      writeFileSync(join(fixes, 'fix_1_data-integrity.sh'), '#!/bin/bash\n');
      for (const name of hostile) writeFileSync(join(fixes, name), '#!/bin/bash\n');
      writeFileSync(join(dir, 'review_env.sh'), '');
      const script = block.replace(/^RUN_DIR=.*$/m, `RUN_DIR='${dir}'; export RUN_DIR`);
      const out = execFileSync(sh, ['-c', script], { cwd: dir, encoding: 'utf8' });
      assert.deepEqual(readdirSync(fixes).sort(), ['apply_all.sh', 'fix_1_data-integrity.sh'], `${sh}: every other fix_* name is removed`);
      assert.equal(out.split('\n').filter((l) => l.startsWith('⚠️  removed a fix script')).length, hostile.length, `${sh}: each removal is reported`);
      assert.deepEqual(out.split('\n').filter((l) => l.startsWith('  bash ')), [`  bash "${fixes}/fix_1_data-integrity.sh"`], `${sh}: only the safe script is listed`);
      assert.equal(readFileSync(join(dir, 'review_env.sh'), 'utf8'), 'export FIX_COUNT="1"\n', `${sh}: only the safe script is counted`);
      assert.equal(existsSync(join(dir, 'pwned')), false, `${sh}: no name ever ran`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const archetype = read('templates/archetype.md').replace(/\s+/g, ' ');
  assert.ok(archetype.includes('Name the script `fix_<N>_<category>.sh`, with `<N>` a number and `<category>` in lowercase letters, digits, `-`, or `_`; the review removes a fix script with any other name.'));
});

test('the review and address take the PR after the checkout, and free the checkout when another run holds it', () => {
  const review = read('skills/review/SKILL.md');
  const blocks = bashBlocks(review);
  const checkoutAt = blocks.findIndex((b) => b.includes('agent-review run-dir --lock review)'));
  const gatherAt = blocks.findIndex((b) => /^PR_NUMBER=/m.test(b));
  assert.ok(checkoutAt >= 0 && gatherAt > checkoutAt, 'the PR is taken in a later block than the checkout');
  const address = read('skills/address/SKILL.md');
  const local = address.slice(address.indexOf('## Local mode'));
  const stage0 = bashBlocks(local)[0];
  assert.ok(stage0.startsWith('RUN_DIR=$(agent-review run-dir --lock address)'));

  const takes = (block, repoSet, repoVar) => {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('agent-review run-dir --lock-pr'));
    assert.ok(at >= 0, 'the block takes the PR');
    assert.strictEqual(lines.filter((l) => l.includes('--lock-pr')).length, 1);
    assert.match(lines[at], new RegExp(`--lock-pr "\\$${repoVar}#\\$PR_NUMBER" >/dev/null \\|\\| exit 1$`), 'a failed take stops the block');
    assert.ok(lines.findIndex((l) => l.startsWith(repoSet)) < at, 'the repo is known before the PR is taken');
    return lines.slice(0, at + 1);
  };
  const reviewBlock = blocks[gatherAt];
  const reviewLines = takes(reviewBlock, 'PR_NUMBER=', 'PR_REPO');
  assert.ok(reviewBlock.includes('PR_REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"'));
  const guard = reviewLines.findIndex((l) => l.trim() === 'if [ -n "$PR_NUMBER" ]; then');
  assert.ok(guard >= 0 && guard < reviewLines.length - 1 && reviewBlock.split('\n')[reviewLines.length] === 'fi', 'review takes the PR only when PR_NUMBER is set');
  takes(stage0, 'REPO=', 'REPO');

  const flatReview = review.replace(/\s+/g, ' ');
  const flatAddress = local.replace(/\s+/g, ' ');
  assert.ok(flatReview.includes('Show that message, run `agent-review run-dir --release review` to free this checkout, and stop.'));
  assert.ok(flatAddress.includes('Show that message, run `agent-review run-dir --release address` to free this checkout, and stop.'));
  const yolo = read('skills/yolo-review/SKILL.md').replace(/\s+/g, ' ');
  assert.ok(yolo.includes('The hold covers the PR too'));
});
