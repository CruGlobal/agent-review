'use strict';
// Contract tests between the shipped templates/skills and the CLI surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const ARCHETYPE = join(ROOT, 'templates/archetype.md');
const REVIEW_WORKFLOW = join(ROOT, '.github/workflows/review.yml');
const INTERACT_WORKFLOW = join(ROOT, '.github/workflows/interact.yml');
const INTERACT_TEMPLATE = join(ROOT, 'templates/workflows/agent-review-interact.yml');
const ADDRESS_SKILL = join(ROOT, 'skills/address/SKILL.md');
// Every shipped skill is held to the same CLI/legacy-path contract.
const SKILLS = ['review', 'init', 'learn', 'address'].map((name) => ({
  name,
  path: join(ROOT, `skills/${name}/SKILL.md`),
}));

const PLACEHOLDERS = [
  'TITLE',
  'EXPERTISE',
  'RISK_CONTEXT',
  'PROFILE_INSTRUCTION',
  'RULES',
  'LEARNINGS',
  'IMPACT',
  'EVIDENCE',
  'CONTEXT',
];

test('archetype.md uses exactly the documented placeholders', () => {
  const text = readFileSync(ARCHETYPE, 'utf8');
  const found = new Set(
    [...text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]),
  );
  assert.deepStrictEqual(
    [...found].sort(),
    [...PLACEHOLDERS].sort(),
    'archetype placeholder vocabulary drifted from the documented set',
  );
});

test('skills reference the CLI, never legacy engine paths', () => {
  for (const { name, path } of SKILLS) {
    const text = readFileSync(path, 'utf8');
    for (const legacy of ['.claude/review/engine', 'cli.cjs']) {
      assert.ok(
        !text.includes(legacy),
        `skills/${name}/SKILL.md must not reference "${legacy}" — call the agent-review binary instead`,
      );
    }
  }
});

// Lines of every ```bash fenced block in the skill.
function bashBlocks(text) {
  const out = [];
  let inBash = false;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (inFence) {
        inFence = false;
        inBash = false;
      } else {
        inFence = true;
        inBash = line.slice(3).trim().toLowerCase() === 'bash';
      }
      continue;
    }
    if (inFence && inBash) out.push(line);
  }
  return out.join('\n');
}

test('every agent-review subcommand used in skill bash blocks exists in the CLI', () => {
  const usage = execFileSync(
    process.execPath,
    [join(ROOT, 'bin/agent-review'), 'help'],
    { encoding: 'utf8' },
  );
  // Each usage line is "<command column>  <description>". Within the command column the first
  // word is a subcommand, as is any word after a spaced ` | ` alternation ("approve <id> | reject
  // <id>"). Unspaced pipes ("show|validate|get") separate a subcommand's own arguments, not
  // subcommands, so they are deliberately not collected.
  const known = new Set();
  for (const line of usage.split('\n').slice(1)) {
    // drop the "usage:" line
    const head = line.trim().split(/\s{2,}/)[0];
    for (const m of head.matchAll(/(?:^|\s\|\s)([a-z][a-z-]*)/g)) known.add(m[1]);
  }
  assert.ok(known.size > 5, 'could not parse subcommands out of the CLI usage text');
  // "show" only ever appears as an argument alternation ("show|validate|get"). If it leaks into
  // the known set the unspaced-pipe convention has broken and this test stops catching typos.
  assert.ok(
    !known.has('show'),
    'usage-line parse picked up an argument alternation as a subcommand — keep argument alternations unspaced ("show|validate|get")',
  );

  for (const { name, path } of SKILLS) {
    const used = new Set(
      [...bashBlocks(readFileSync(path, 'utf8')).matchAll(
        /(?:^\s*|\$\(|(?:^|[;&|])\s*|\b(?:if|then|do)\s+)agent-review\s+([a-z][a-z-]*)/gm,
      )].map((m) => m[1]),
    );
    assert.ok(
      used.size > 0,
      `no agent-review invocations found in skills/${name}/SKILL.md bash blocks`,
    );
    for (const sub of used) {
      assert.ok(
        known.has(sub),
        `skills/${name}/SKILL.md calls "agent-review ${sub}" but the CLI has no such command`,
      );
    }
  }
});

test('CI workflows fail closed on missing/stale reports and use portable pagination', () => {
  const review = readFileSync(REVIEW_WORKFLOW, 'utf8');
  const interact = readFileSync(INTERACT_WORKFLOW, 'utf8');
  assert.ok(review.includes('Claude exited without producing an agent-review report'));
  assert.ok(review.includes('EXPECTED_HEAD'));
  assert.ok(review.includes("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'"));
  assert.ok(interact.includes('waiting for incremental re-review'));
  assert.ok(!review.includes('--paginate --slurp'));
  assert.ok(!interact.includes('--paginate --slurp'));
});

test('interact workflow separates the untrusted model from the write-capable publisher', () => {
  const workflow = readFileSync(INTERACT_WORKFLOW, 'utf8');
  const model = workflow.slice(workflow.indexOf('  model:'), workflow.indexOf('  publish:'));
  const publish = workflow.slice(workflow.indexOf('  publish:'));

  assert.match(model, /permissions:\n      contents: read\n      pull-requests: read/);
  assert.ok(!model.includes('contents: write'));
  assert.ok(!model.includes('pull-requests: write'));
  assert.match(publish, /permissions:\n      actions: write\n      contents: write\n      pull-requests: write/);
  assert.ok(model.includes("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'"));
  assert.ok(model.includes('persist-credentials: false'));
  assert.ok(model.includes('retention-days: 1'));
  assert.ok(model.includes('address validate'));
  assert.ok(publish.includes('address prepare'));
  assert.ok(publish.includes('address validate'));
  assert.ok(publish.includes('cmp -s'));
  assert.ok(publish.includes('address-changed-files-current.json'));
  assert.ok(publish.includes('git apply --check "$HANDOFF_DIR/address.patch"'));
  assert.ok(publish.includes('artifact-ids:'));
  assert.ok(publish.includes('actions/artifacts/$ARTIFACT_ID'));
  assert.ok(model.includes('collaborators/$ACTOR/permission'));
  assert.ok(publish.includes('collaborators/$CURRENT_ACTOR/permission'));
  assert.ok(!model.includes('inputs.command }}'));
  assert.ok(!model.includes('inputs.actor }}'));
});

test('address CI skill is a structured patch-only contract', () => {
  const skill = readFileSync(ADDRESS_SKILL, 'utf8');
  const ci = skill.slice(skill.indexOf('## CI mode'), skill.indexOf('## Local mode'));
  assert.ok(ci.includes('$ADDRESS_REQUEST_FILE'));
  assert.ok(ci.includes('$ADDRESS_RESULT_OUT'));
  assert.ok(ci.includes('"status": "not-applied"'));
  assert.ok(ci.includes('Never use `gh`'));
  assert.ok(ci.includes('Never stage, commit, push'));
  assert.ok(ci.includes('The trusted post-job owns'));
});

test('interact caller passes comment identity and grants only required publish permissions', () => {
  const template = readFileSync(INTERACT_TEMPLATE, 'utf8');
  assert.ok(template.includes('comment_id: ${{ github.event.comment.id }}'));
  assert.ok(!template.includes('command: ${{ github.event.comment.body }}'));
  assert.ok(!template.includes('actor: ${{ github.event.comment.user.login }}'));
  assert.match(template, /permissions:\n      actions: write\n      contents: write\n      pull-requests: write/);
});
