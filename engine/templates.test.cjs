'use strict';
// Contract tests between the shipped templates/skills and the CLI surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = join(__dirname, '..');
const ARCHETYPE = join(ROOT, 'templates/archetype.md');
const REVIEW_WORKFLOW = join(ROOT, '.github/workflows/review.yml');
const INTERACT_WORKFLOW = join(ROOT, '.github/workflows/interact.yml');
const INTERACT_TEMPLATE = join(ROOT, 'templates/workflows/agent-review-interact.yml');
const ADDRESS_SKILL = join(ROOT, 'skills/address/SKILL.md');
// Skills whose bash blocks invoke the agent-review CLI. update-files calls no
// engine subcommands, so it is held only to the legacy-path contract below.
const SKILLS = ['review', 'init', 'learn', 'address'].map((name) => ({
  name,
  path: join(ROOT, `skills/${name}/SKILL.md`),
}));
const ALL_SKILLS = [...SKILLS, { name: 'update-files', path: join(ROOT, 'skills/update-files/SKILL.md') }];

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
  for (const { name, path } of ALL_SKILLS) {
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

test('model steps can write the /tmp handoff despite forced sandbox isolation', () => {
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB forces bubblewrap filesystem isolation on,
  // which only allows writes to the working directory and session temp dir. The
  // skill contract and the handoff files live in /tmp, so each model step must
  // grant it back via sandbox settings — without it Claude silently produces no
  // report (mpdx_api PR 3548).
  const review = readFileSync(REVIEW_WORKFLOW, 'utf8');
  const interact = readFileSync(INTERACT_WORKFLOW, 'utf8');
  for (const [name, body] of [['review.yml', review], ['interact.yml', interact]]) {
    assert.ok(
      body.includes('"allowWrite": ["/tmp"]'),
      `${name} model step must grant sandbox write access to /tmp`,
    );
    assert.ok(
      !body.includes('allowWrite: ["/tmp", '),
      `${name} must not widen sandbox writes beyond /tmp`,
    );
  }
  // The model transcript must be preserved for failed runs — this failure was
  // undiagnosable without it.
  assert.ok(review.includes('claude-execution-output.json'), 'review.yml must preserve the model transcript');
  assert.ok(interact.includes('claude-execution-output.json'), 'interact.yml must preserve the model transcript');
  // The address result handoff must be written where the sandbox permits (/tmp),
  // never under runner.temp, which stays write-protected for the trusted runtime.
  assert.ok(interact.includes('ADDRESS_RESULT_OUT: /tmp/address-result.json'), 'address result must be staged in /tmp');
  assert.ok(!interact.includes('ADDRESS_RESULT_OUT: ${{ runner.temp }}'), 'address result must not point at runner.temp');
  // apt-get update downloads the full package index set (minutes on a slow
  // mirror) and runs on every review; install from the image's baked-in lists
  // first and refresh only when that misses.
  for (const [name, body] of [['review.yml', review], ['interact.yml', interact]]) {
    assert.ok(
      /install -y --no-install-recommends bubblewrap socat \\\n\s*\|\| \{ sudo apt-get \$APT_OPTS update -qq; sudo apt-get \$APT_OPTS install -y --no-install-recommends bubblewrap socat; \}/.test(body),
      // The Linux sandbox needs BOTH: bwrap for isolation and socat for its
      // network proxy. Without socat every Bash call fails with "Sandbox is
      // required but failed to initialize" and the model can run nothing
      // (mpdx_api runs 32265870681 and 32276309565).
      `${name} must install socat alongside bubblewrap — the sandbox cannot initialize without it`,
    );
    assert.ok(
      body.includes("Acquire::Retries=3 -o Acquire::http::Timeout=15"),
      `${name} apt calls must time out and retry instead of hanging on a wedged mirror`,
    );
  }
  // Subagents inherit the allowlist and need Read/Glob/Grep for rule docs and
  // diffs (29 denials on mpdx run 32280550011), and the main thread needs
  // TaskOutput to wait for background agents — without it the model ends its
  // turn while agents run, which in non-interactive SDK mode kills the session.
  assert.ok(
    review.includes('--allowedTools "Bash,Task,TaskOutput,Read,Glob,Grep,Write"'),
    'review.yml must allow the read tools and TaskOutput alongside Bash/Task',
  );
  assert.ok(
    interact.includes('--allowedTools "Read,Edit,Write,Bash,Task,TaskOutput,Glob,Grep"'),
    'interact.yml must allow the read tools and TaskOutput alongside its edit set',
  );
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

test('every fail-closed interact exit is reported back to the maintainer', () => {
  const workflow = readFileSync(INTERACT_WORKFLOW, 'utf8');
  const failure = workflow.slice(workflow.indexOf('  report-failure:'));
  assert.ok(failure, 'interact workflow must define a report-failure job');
  assert.match(failure, /needs: \[model, publish\]\n    if: failure\(\)/);
  assert.match(failure, /permissions:\n      pull-requests: write/);
  assert.ok(failure.includes('gh pr comment'));
  // The parse error is the one failure a maintainer can act on, so it is carried
  // out of the read-only model job rather than left in the run log.
  assert.ok(failure.includes('needs.model.outputs.failure_reason'));
  assert.ok(workflow.includes('failure_reason: ${{ steps.prepare.outputs.failure_reason }}'));
  assert.ok(workflow.includes('echo "failure_reason='));
  // A whitespace nit must not discard an already-validated patch.
  assert.ok(!/git diff --cached --check\n/.test(workflow));
});

test('the review skill forbids ending the turn while agents are still running', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('never end your turn while launched agents are still running'));
  assert.ok(skill.includes('TaskOutput'));
  // Observed in run 32280550011: transient bwrap bind races and no final
  // verification that the comment handoff actually exists.
  assert.ok(skill.includes('sandbox bind race'), 'skill must teach the bwrap retry');
  assert.ok(skill.includes('succeeded ONLY when `$AGENT_REVIEW_COMMENT_OUT` exists'), 'skill must require the final handoff self-check');
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

test('the plugin version is the single source of truth and every surface agrees', () => {
  const pluginVersion = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
  assert.match(pluginVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    pluginVersion,
    'package.json version must match .claude-plugin/plugin.json',
  );
  // Every copied workflow template carries a version marker equal to the plugin
  // version. This deliberately forces a version bump whenever a template
  // changes — the marker is what lets a review flag stale consumer copies.
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml']) {
    const body = readFileSync(join(ROOT, 'templates/workflows', name), 'utf8');
    const marker = body.match(/^# agent-review-template-version: (\d+\.\d+\.\d+)$/m);
    assert.ok(marker, `${name} must carry an agent-review-template-version marker`);
    assert.equal(marker[1], pluginVersion, `${name} marker must equal the plugin version`);
  }
  // The manifest pins each template's exact contents to the plugin version, so a
  // template edit fails here until the version is bumped and the manifest
  // restamped (npm run stamp-templates). Editing a released entry in place would
  // evade this, but that act is loud in code review — unlike forgetting a bump.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'templates/workflows/template-manifest.json'), 'utf8'));
  const entry = manifest[pluginVersion];
  assert.ok(entry, `template-manifest.json has no entry for v${pluginVersion} — bump the version, then npm run stamp-templates`);
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml']) {
    const hash = createHash('sha256').update(readFileSync(join(ROOT, 'templates/workflows', name))).digest('hex');
    assert.equal(
      entry[name],
      hash,
      `${name} changed without a version bump — bump plugin.json/package.json/template markers, then npm run stamp-templates`,
    );
  }
});

test('the review skill checks for stale consumer workflows and stale local plugins', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review-template-version'), 'review skill must read the template marker');
  assert.ok(skill.includes('/agent-review:update-files'), 'stale workflow note must point at update-files');
  assert.ok(skill.includes('plugin marketplace update cruglobal'), 'stale plugin note must point at the marketplace update');
  assert.ok(skill.includes('is older than'), 'staleness must compare older-than, never mere difference — a dev branch ahead of main is not stale');
  assert.ok(!skill.includes('differs from `PLUGIN_VERSION`'), 'the differs-from predicate misfires when local is ahead of main');
  assert.ok(skill.includes('[IF the installed plugin is older'), 'the summary must gate the plugin line and the workflow-file line independently');
});

test('the update-files skill preserves consumer knobs and stamps the new marker', () => {
  const skill = readFileSync(join(ROOT, 'skills/update-files/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review-template-version'));
  assert.ok(skill.includes('auto_approve'), 'must carry over the consumer auto_approve choice');
  assert.ok(skill.includes('anthropic_api_key'), 'must carry over the consumer secret mapping');
  assert.ok(skill.includes('gh api "repos/CruGlobal/agent-review/contents'), 'must fetch templates from the source repo on GitHub');
  assert.ok(!skill.includes('plugins/cache'), 'must fetch templates from GitHub, not the local plugin cache');
  assert.ok(skill.includes('git diff'), 'must show the consumer the diff before anything is committed');
});
