'use strict';
// Contract tests between the shipped templates/skills and the CLI surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
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
  'AGENT_ID',
  'DIFF_PATH',
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

  const engineDocFile = { path: join(ROOT, 'skills/review/code-review-engine.md') };
  for (const { path } of [...SKILLS, engineDocFile]) {
    const shown = path.slice(ROOT.length + 1);
    const used = new Set(
      [...bashBlocks(readFileSync(path, 'utf8')).matchAll(
        /(?:^\s*|\$\(|(?:^|[;&|])\s*|\b(?:if|then|do)\s+)agent-review\s+([a-z][a-z-]*)/gm,
      )].map((m) => m[1]),
    );
    assert.ok(
      used.size > 0,
      `no agent-review invocations found in ${shown} bash blocks`,
    );
    for (const sub of used) {
      assert.ok(
        known.has(sub),
        `${shown} calls "agent-review ${sub}" but the CLI has no such command`,
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
    review.includes('--allowedTools "Bash,Task,TaskOutput,Read,Glob,Grep,Write,Edit"'),
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
  // The stale-report check moved into the shared approve action: it reads the
  // PR's current head and the engine rule (approval.test.cjs) rejects a report
  // for any other head.
  const approveAction = readFileSync(join(ROOT, '.github/actions/approve/action.yml'), 'utf8');
  assert.ok(approveAction.includes('HEAD_SHA=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)'));
  assert.ok(approveAction.includes('--head "$HEAD_SHA"'));
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

test('review workflow reports back to the PR when the review job fails', () => {
  const workflow = readFileSync(REVIEW_WORKFLOW, 'utf8');
  const failure = workflow.slice(workflow.indexOf('  report-failure:'));
  assert.ok(failure, 'review workflow must define a report-failure job');
  assert.match(failure, /needs: review\n    if: failure\(\)/);
  assert.match(failure, /permissions:\n      pull-requests: write/);
  assert.ok(failure.includes('gh pr comment'));
  // Simple static message — no failure_reason plumbing like interact.yml's job.
  // The publish step posts/patches its comment BEFORE its postcondition check, so a
  // failure there can still leave a report on the PR — the message must stay truthful
  // on that path too, not claim "no report was posted" unconditionally.
  assert.ok(failure.includes('did not complete'));
  assert.ok(failure.includes('may be missing or partially posted'));
  assert.ok(failure.includes('check for an agent-review comment'));
  assert.ok(failure.includes('made no code changes'));
  assert.ok(failure.includes('agent-review'), 'must tell the maintainer which label to cycle');
  assert.ok(failure.includes('github.event.pull_request.number'));
  assert.ok(failure.includes('github.run_id'), 'must link to the run log');
  // The review job itself must not gain new permissions to support this.
  const review = workflow.slice(0, workflow.indexOf('  report-failure:'));
  assert.match(review, /permissions:\n      contents: read\n      checks: read\n      pull-requests: write/);
});

test('review.yml stays YAML-parseable', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(REVIEW_WORKFLOW, 'utf8'));
  assert.ok(doc.jobs['report-failure'], 'report-failure job must parse as a real job');
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
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml', 'agent-review-approve.yml']) {
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
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml', 'agent-review-approve.yml']) {
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

test('the local e2e harness exists and derives its contract from the CI workflow', () => {
  const script = readFileSync(join(ROOT, 'test/e2e-review.sh'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:e2e'], 'bash test/e2e-review.sh');
  // The harness must read allowedTools and sandbox settings out of review.yml —
  // hardcoding them here would let the local test and real CI drift apart.
  assert.ok(script.includes('--allowedTools'), 'harness must pass an allowlist');
  assert.ok(script.includes('.github/workflows/review.yml'), 'harness must parse the CI workflow, not hardcode its contract');
  assert.ok(script.includes('AGENT_REVIEW_COMMENT_OUT'), 'harness must stage the comment to a file, never post to GitHub');
  assert.ok(script.includes('agent-review-ledger'), 'harness must apply the publish-step validation');
});

test('the report skeleton surfaces needsHumanReview and defines the agent-summary severity bands', () => {
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  assert.ok(
    report.includes('_([agent])_[ · 🤔 needs-human-review]'),
    'BLOCKERS/OTHER FINDINGS lines must carry the optional needs-human-review suffix',
  );
  assert.ok(
    report.includes('Critical 9-10 · High 7-8 · Important 5-6 · Suggestions 3-4'),
    'Agent summary must define its severity bands to match the SEVERITY ANCHORS',
  );
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(
    /agents.*field.*fallback.*agent|falling back to `agent`/.test(skill),
    'the fill rules must tell the model to source the display agent list from `agents`, falling back to `agent`',
  );
});

test('the report skeleton and commit message never emit bare #N', () => {
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  assert.ok(!report.includes('**#[N]**'), 'ledger skeleton lines must use the code-span form **`#[N]`**');
  assert.ok(report.includes('**`#[N]`**'));
  const interact = readFileSync(INTERACT_WORKFLOW, 'utf8');
  // A commit message containing #N creates cross-reference notifications on
  // those unrelated PRs every time a fix is pushed.
  assert.ok(!interact.includes('"#\\(.n)"'), 'commit-message numbers must be plain, never #N');
  assert.ok(interact.includes('"\\(.n)"'));
});

test('the report skeleton is the approved verdict+blockers caveman layout', () => {
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  // One verdict line up top, right after the hidden markers.
  assert.ok(report.includes('🤖 agent-review · [❌ [N] blockers open | ✅ no blockers] · risk [LEVEL]'));
  // Visible blocks: blockers with evidence + fix sub-lines, then one-liner findings.
  assert.ok(report.includes('## BLOCKERS — fix or dismiss to pass'));
  assert.ok(report.includes('↳ evidence:'));
  assert.ok(report.includes('↳ fix:'));
  assert.ok(report.includes('## OTHER FINDINGS'));
  // Everything else collapses, in the brief's order.
  const sections = ['Fix suggestions', 'Dependency impact', 'Review detail & stats', 'How to act on this review'];
  const sectionIndexes = sections.map((section) => {
    const match = new RegExp(`<details>\\s*<summary>[^<]*${section}`).exec(report);
    assert.ok(match, `${section} must be a <details> section`);
    return match.index;
  });
  for (let i = 1; i < sectionIndexes.length; i += 1) {
    assert.ok(sectionIndexes[i] > sectionIndexes[i - 1], `${sections[i]} must come after ${sections[i - 1]}`);
  }
  // The duplication is gone: no severity-section restatement, no raw-agent appendix.
  assert.ok(!report.includes('Full Agent Reports'), 'raw-agent appendix must be removed');
  for (const heading of [
    '## 🚫 Critical',
    '## 🔴 HIGH PRIORITY BLOCKERS',
    '## ⚠️ IMPORTANT ISSUES',
    '## 💡 MEDIUM PRIORITY',
    '## 💭 SUGGESTIONS',
    '## 🤔 UNRESOLVED DEBATES',
  ]) {
    assert.ok(!report.includes(heading), `legacy severity/debate section "${heading}" must not restate ledger findings`);
  }
  // Machine contracts survive byte-identical.
  assert.ok(report.includes('- [ ] **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_'));
  // The skeleton may document the hidden markers in prose, but must never itself contain a
  // marker-shaped line — the CI posting step prepends the one real copy of each, and a
  // duplicate breaks addressState's "exactly one ledger/status marker" parsing.
  assert.ok(report.includes('agent-review-ledger'), 'the skeleton should document the ledger marker by name');
  assert.ok(report.includes('agent-review-status'), 'the skeleton should document the status marker by name');
  for (const name of ['agent-review-head', 'agent-review-rollout', 'agent-review-ledger', 'agent-review-status']) {
    assert.ok(
      !new RegExp(`^<!-- ${name}: .* -->$`, 'm').test(report),
      `the skeleton must not itself contain a live "${name}" marker line`,
    );
  }
  assert.ok(!/^<!-- agent-review -->$/m.test(report), 'the skeleton must not itself contain the live bare review marker line');
});

test('the ledger-line rewrite regex only ever matches report.md\'s own ledger-format definition lines', () => {
  // finalizeAddress rewrites ANY line matching this regex to the current ledger state for its
  // `#N` — a stray match (e.g. a bolded `#N` reference in prose) gets silently clobbered into a
  // bogus ledger line. Prove report.md carries the regex's intended matches only.
  const { LEDGER_LINE_REGEX } = require('./addressState.cjs');
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  // Only "#[N]" (the ledger reference placeholder) needs a real digit to be regex-eligible —
  // every other bracketed placeholder is irrelevant to this regex.
  const realized = report.replace(/#\[N\]/g, '#7');
  const regex = new RegExp(LEDGER_LINE_REGEX.source, LEDGER_LINE_REGEX.flags);
  const matchedLines = [...realized.matchAll(regex)].map((match) => match[0].split('\n')[0]);
  assert.deepEqual(matchedLines, [
    '- [ ] **`#7`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_[ · 🤔 needs-human-review]',
    '- [x] **`#7`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — ✅ fixed in [short sha]',
    '- [x] **`#7`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — 🚫 dismissed by @[user] [[reason code]]: [reason]',
    '- **`#7`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_[ · 🤔 needs-human-review]',
    '- **`#7`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — ✅ fixed in [short sha]',
    '- **`#7`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — 🚫 dismissed by @[user] [[reason code]]: [reason]',
  ], 'only the six open/fixed/dismissed ledger-format definition lines (BLOCKERS + OTHER FINDINGS) may match — any other match is a rewriter hazard');
});

test('the review skill fills the caveman report and enforces the soft byte target', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('soft target 25,000 bytes'), 'Stage 6 must state the new soft size target');
  assert.ok(skill.includes('state each finding exactly once'), 'fill rules must forbid restating findings across sections');
  assert.ok(skill.includes('BLOCKERS — fix or dismiss to pass'), 'fill rules must reference the skeleton sections by name');
  // Stale instructions from the pre-caveman layout must not survive: they contradict the
  // verdict+blockers skeleton and would mislead the model filling it.
  assert.ok(!skill.includes('AUTOMATED FIXES AVAILABLE'), 'the old AUTOMATED FIXES AVAILABLE section name must not survive');
  assert.ok(!/debate transcript/.test(skill), 'there is no separate debate transcript section — only the Debate summary block');
  assert.ok(!/raw-agent-report appendix/.test(skill), 'the caveman layout has no raw-agent-report appendix to trim');
});

test('the archetype caps agent verbosity two-tier and drops CI fix scripts', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(archetype.includes('severity ≥ 7: evidence ≤ 8 lines (600 chars max'), 'blocker evidence tier missing');
  assert.ok(archetype.includes('severity < 7: evidence ≤ 2 lines'), 'minor evidence tier missing');
  assert.ok(archetype.includes('report only the checklist items that FAIL'), 'checklists must be violations-only');
  assert.ok(archetype.includes('In CI mode do NOT write fix scripts'), 'CI fix-script ban missing');
});

test('the archetype severity guidance never contradicts the pinned SEVERITY ANCHORS', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  // The old band sentence claimed Critical/BLOCKING is 10/10 and Concerns are 6-9/10 — directly
  // contradicting the SEVERITY ANCHORS (9-10 critical, 7-8 correctness) below it, which is what
  // caused a 7/10 finding to be rated as merely a "Concern" instead of a blocker.
  assert.ok(
    !archetype.includes('Critical/BLOCKING is 10/10'),
    'the contradictory old severity-band sentence must not survive',
  );
  assert.ok(
    archetype.includes('Severity ≥ 7 is a BLOCKER'),
    'the ≥7-is-a-blocker line must replace the old band sentence',
  );
});

test('the archetype makes exploitable security/data-loss/corruption defects every lane\'s duty, not just the owning specialist\'s', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(
    archetype.includes('CROSS-CUTTING DUTY:'),
    'a CROSS-CUTTING DUTY paragraph must exist near the severity anchors',
  );
  assert.ok(
    /must never go unreported because it ["'“]?belongs["'”]? to a lane/.test(archetype),
    'the duty must say a >=7 defect must never go unreported for belonging to a lane that may not be running',
  );
});

test('the archetype hands off findings as a JSON file with a one-line return', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(archetype.includes('/tmp/agent_findings/'), 'findings-file path missing');
  assert.ok(archetype.includes('{{AGENT_ID}}'), 'AGENT_ID placeholder missing');
  assert.ok(
    archetype.includes('done — <N> findings, max severity <X>'),
    'one-line Task return contract missing',
  );
  assert.ok(
    !archetype.includes('## {{TITLE}} — Findings'),
    'the old markdown findings report heading must not survive',
  );
});

test('the plugin ships one thin reviewer agent per model tier', () => {
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    const body = readFileSync(join(ROOT, `agents/reviewer-${tier}.md`), 'utf8');
    assert.match(body, new RegExp(`^model: ${tier}$`, 'm'), `reviewer-${tier} must pin model: ${tier}`);
    assert.ok(/^name: reviewer-/m.test(body));
    assert.ok(body.length < 2000, 'tier agents are thin shells — the real prompt arrives via Task');
  }
});

const CODE_REVIEW_AGENT = join(ROOT, 'agents/reviewer-code-review.md');
const CODE_REVIEW_LANE = join(ROOT, 'templates/code-review-lane.md');
const CODE_REVIEW_LANE_PLACEHOLDERS = [
  'RUN_ID',
  'ATTEMPT',
  'EFFORT',
  'SKILL_ARGS',
  'RETRY_NOTE',
  'PROFILE_INSTRUCTION',
  'RISK_CONTEXT',
  'DIFF_PATH',
  'SCORING_RULES',
  'LEARNINGS',
  'IMPACT',
  'EXCLUDED_PATHS',
];
const FINAL_LINE_CONTRACT = 'done — <N> findings, max severity <X>';
const LANE_FILES = ['raw', 'findings', 'dropped'].map((kind) => `/tmp/code_review_${kind}.{{ATTEMPT}}.json`);
const LANE_PROOF_COMMAND =
  'agent-review code-review-proof --raw /tmp/code_review_raw.{{ATTEMPT}}.json --findings /tmp/code_review_findings.{{ATTEMPT}}.json --dropped /tmp/code_review_dropped.{{ATTEMPT}}.json --run {{RUN_ID}}';
const PROMOTED_FINDINGS = '/tmp/agent_findings/code-review.json';
const STAGE2_PROOF_COMMAND =
  `agent-review code-review-proof --raw "/tmp/code_review_raw.$ATTEMPT.json" --findings "/tmp/code_review_findings.$ATTEMPT.json" --dropped "/tmp/code_review_dropped.$ATTEMPT.json" --run "$REVIEW_ID" --promote ${PROMOTED_FINDINGS} > /tmp/code_review_proof.json`;
const QUIET_DISARM = 'agent-review capture disarm >/dev/null 2>&1 || true';

function laneText() {
  return readFileSync(CODE_REVIEW_LANE, 'utf8');
}

function flatText(text) {
  return text.replace(/\s+/g, ' ');
}

// Sections start at a heading on its own line; prose such as "Go to STEP 2." never ends one.
function laneStep(text, from, to) {
  const start = text.indexOf(`\n${from}`);
  const end = to ? text.indexOf(`\n${to}`, start + 1) : text.length;
  assert.ok(start >= 0 && end > start, `the lane template has a section from ${from} to ${to}`);
  return text.slice(start + 1, end);
}

function laneHeredocs(text) {
  return [...text.matchAll(/^node - <<'EOF'\n([\s\S]*?)\nEOF$/gm)].map((m) => m[1]);
}

// The code-review engine text the review skill points at, and one of its `## ` sections by name.
const ENGINE_DOC = join(ROOT, 'skills/review/code-review-engine.md');
function engineDoc() {
  return readFileSync(ENGINE_DOC, 'utf8');
}
function engineSection(name) {
  const doc = engineDoc();
  const start = doc.indexOf(`\n## ${name}\n`);
  assert.ok(start !== -1, `code-review-engine.md has no section "${name}"`);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start + 1, next === -1 ? doc.length : next);
}

// The rows of the review skill's code-review lane table, keyed by placeholder name. The archetype
// table above it fills placeholders of the same names, so rows are read only from this section.
function lanePlaceholderRows() {
  const doc = engineDoc();
  const start = doc.indexOf('## Stage 1: the code-review lane');
  const end = doc.indexOf('Launch the lane with the Task tool', start);
  assert.ok(start >= 0 && end > start, 'code-review-engine.md has the code-review lane placeholder table');
  const section = doc.slice(start, end);
  const rows = new Map();
  for (const line of section.split('\n')) {
    const m = /^\| `\{\{([A-Z_]+)\}\}`\s*\|(.*)\|\s*$/.exec(line);
    if (m) rows.set(m[1], m[2].trim());
  }
  return { section, rows };
}

test('reviewer-code-review pins opus and no effort', () => {
  const body = readFileSync(CODE_REVIEW_AGENT, 'utf8');
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'reviewer-code-review must open with YAML frontmatter');
  assert.match(frontmatter[1], /^name: reviewer-code-review$/m);
  assert.match(frontmatter[1], /^model: opus$/m);
  assert.doesNotMatch(frontmatter[1], /^effort:/m, 'an effort cap would weaken the /code-review recipe');
  assert.ok(!body.includes('Keep reasoning brief'), 'the brevity nudge would weaken the scoring');
  assert.ok(!body.includes('—'), 'new prose uses no em dashes');
});

test('lane template placeholders are exactly the twelve listed', () => {
  const found = new Set([...laneText().matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]));
  assert.deepStrictEqual(
    [...found].sort(),
    [...CODE_REVIEW_LANE_PLACEHOLDERS].sort(),
    'code-review lane placeholder vocabulary drifted from the documented set',
  );
  const { section, rows } = lanePlaceholderRows();
  assert.ok(section.includes('fill its twelve placeholders:'), 'the engine doc counts the twelve placeholders');
  assert.deepStrictEqual(
    [...rows.keys()].sort(),
    [...CODE_REVIEW_LANE_PLACEHOLDERS].sort(),
    "the skill's table documents exactly the template's placeholders",
  );
});

test('the skill says how to fill the capture, attempt, retry, diff, and profile placeholders', () => {
  const { rows } = lanePlaceholderRows();
  assert.strictEqual(rows.get('RUN_ID'), '`$REVIEW_ID`, the `<id>` in the `armed <id>: <args>` line');
  assert.strictEqual(
    rows.get('ATTEMPT'),
    "`$CODE_REVIEW_ATTEMPT`, the value the block above prints as `code-review attempt:` (`$REVIEW_ID-1`); on a relaunch, the value Stage 2's relaunch block prints (`$REVIEW_ID-2`)",
  );
  assert.strictEqual(
    rows.get('RETRY_NOTE'),
    'Empty on the first launch and on a relaunch with a new capture; the note from Stage 2 on a relaunch with the same capture',
  );
  assert.strictEqual(
    rows.get('DIFF_PATH'),
    'The path the block above prints as `code-review diff:`. That is `/tmp/code_review_diff.txt` (`git diff "$BASE_REF...$HEAD_REF"`, the merge base) for a full PR review, and `/tmp/pr_diff.txt` for incremental and range reviews',
  );
  const profile = rows.get('PROFILE_INSTRUCTION');
  assert.ok(
    profile.includes(
      'For `chill`: "This repository uses the chill profile, so the report hides findings below 4 that no other lane backs up. Score every finding honestly anyway; never drop or lower one for the profile."',
    ),
    profile,
  );
  assert.ok(!profile.includes('below 7'), 'chill hides only findings below 4, so "below 7" would tell the scorer the wrong cutoff');
  assert.ok(profile.includes('For `standard` and `assertive`: "Score every finding honestly."'), profile);
  assert.ok(!/Report only high-confidence/.test(profile), 'the lane never gets the suppress-nits instruction');
});

test('the chill profile instruction states the cutoff consensus applies', () => {
  const { consensusFrom } = require('./consensus.cjs');
  const lone = (severity, file) => ({
    agent: 'testing', category: 'testing', severity, file, line: 1, message: `a severity ${severity} finding`,
    confidence: 'High', evidence: 'e', recommendation: 'r',
  });
  const findingsByAgent = { testing: { findings: [lone(3, 'a.js'), lone(4, 'b.js')] } };
  const kept = consensusFrom({ findingsByAgent, profile: 'chill' }).findings.map((f) => f.severity);
  assert.deepStrictEqual(kept, [4], 'chill hides a lone finding below 4 and keeps one at 4');
  assert.ok(lanePlaceholderRows().rows.get('PROFILE_INSTRUCTION').includes('hides findings below 4 that no other lane backs up'));
});

test('with no PR, /code-review gets the same range the lanes review', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const bash = bashBlocks(skill);
  assert.ok(
    bash.includes('  elif [ -n "$PR_NUMBER" ]; then\n    CODE_REVIEW_TARGET="$PR_NUMBER"\n  else\n    CODE_REVIEW_TARGET="$RANGE"\n  fi'),
    'the no-PR target is $RANGE',
  );
  assert.ok(!bash.includes('git branch --show-current'), 'a branch name lets /code-review pick its own base');
  const row = lanePlaceholderRows().rows.get('SKILL_ARGS');
  assert.ok(row, 'the skill documents {{SKILL_ARGS}}');
  assert.ok(row.includes('`"$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"`'), row);
  assert.ok(!row.includes('branch name'), row);
});

test('the lane always passes --max-findings, so a remembered /code-review limit never caps it', () => {
  const row = lanePlaceholderRows().rows.get('SKILL_ARGS');
  assert.ok(row, 'the skill documents {{SKILL_ARGS}}');
  assert.ok(row.startsWith('The args printed by `agent-review capture arm`, composed as '), row);
  assert.ok(
    row.includes('`MAX_FINDINGS_FLAG` is ` --max-findings <n>` when `plan.engine.maxFindings` is set, else ` --max-findings default`.'),
    row,
  );
  assert.ok(!/Empty string/i.test(row), 'the flag is never left out');
});

test('code-review-lane.md carries the contracts', () => {
  const text = laneText();
  for (const needle of [
    'skill: "code-review"',
    'args: "{{SKILL_ARGS}}"',
    ...LANE_FILES,
    FINAL_LINE_CONTRACT,
    '`/code-review did not finish`',
    '`/code-review returned no usable result`',
    "If the Bash tool cuts a command's output short",
  ]) {
    assert.ok(text.includes(needle), `code-review lane must contain ${JSON.stringify(needle)}`);
  }
  assert.ok(!text.includes('/code-review did not run'), 'the lane waits for the capture, so "did not run" is gone');
  const headings = ['BEFORE YOU START:', 'STEP 1.', 'STEP 2.', 'STEP 3.', 'STEP 4.', 'STEP 5.'].map((h) => text.indexOf(h));
  assert.ok(headings.every((at, i) => at >= 0 && (i === 0 || at > headings[i - 1])), 'the steps appear once, in order');
  for (const category of ['simplification', 'efficiency', 'reuse', 'altitude', 'conventions']) {
    assert.ok(text.includes(`\`${category}\``), `cleanup category ${category} missing`);
  }
  const anchors = readFileSync(ARCHETYPE, 'utf8')
    .split('\n')
    .filter((line) => /^\s*- (9-10|7-8|5-6|3-4): /.test(line))
    .map((line) => line.trim());
  assert.strictEqual(anchors.length, 4, 'archetype must still carry four severity anchor lines');
  for (const anchor of anchors) {
    assert.ok(text.includes(anchor), `severity anchor not copied verbatim: ${anchor}`);
  }
  assert.ok(
    !text.split(FINAL_LINE_CONTRACT).join('').includes('—'),
    'the final-line contract is the only em dash allowed in the lane prompt',
  );
});

test('lane template never writes the capture file or /tmp/agent_findings/code-review.json', () => {
  const text = laneText();
  assert.ok(!text.includes('code_review_capture'), 'the template never names a capture file');
  assert.ok(!text.includes('/tmp/agent-review'), 'the template never names the private capture dir');
  assert.ok(!text.includes('/tmp/agent_findings'), 'the skill copies the checked findings for consensus, not the lane');
  assert.ok(!/agent-review capture (?:arm|disarm)/.test(text), 'only the review skill arms and disarms capture');
  assert.ok(
    text.includes('```bash\nagent-review capture show --run {{RUN_ID}}\n```'),
    'the lane reads the result through the CLI',
  );
  const removals = text.split('\n').filter((line) => /^\s*rm\b/.test(line));
  assert.deepStrictEqual(removals, [`rm -f ${LANE_FILES.join(' ')}`], "the lane removes only this attempt's three files");
  const writes = [...text.matchAll(/writeFileSync\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(writes.sort(), [...LANE_FILES].sort(), "the lane writes only this attempt's three files");
  assert.ok(!/>\s*\/tmp\//.test(text), 'no shell redirect writes another /tmp file');
});

test('lane template has no node -e write recipe and uses a quoted node heredoc', () => {
  const text = laneText();
  assert.ok(!text.includes('node -e'), 'a single-quoted node -e script breaks on quoted code');
  const scripts = laneHeredocs(text);
  assert.strictEqual(scripts.length, 2, 'one heredoc writes the raw list, one the scored and dropped lists');
  for (const script of scripts) assert.ok(script.includes('JSON.stringify'), script);
  assert.strictEqual(text.split('node - <<').length - 1, 2, "every node heredoc is the quoted 'EOF' form");
  assert.ok(
    flatText(text).includes(
      'inside a JS string, write a backslash as `\\\\` and a double quote as `\\"`, and a line break as `\\n`.',
    ),
    'the lane is told how to escape quoted code inside a JS string',
  );
  assert.ok(
    flatText(text).includes('Use double quotes for every JS string, never backticks: a backtick string runs any `${...}` in the code you quote.'),
    'a template-literal string would run quoted code',
  );
  for (const script of scripts) assert.ok(!script.includes('`'), 'the heredoc examples use no backtick strings');
});

test('lane template pages long output by bytes through a pipe, never through a file', () => {
  const long = flatText(laneStep(laneText(), 'LONG OUTPUT:', 'STEP 1.'));
  for (const needle of [
    "If the Bash tool cuts a command's output short, run the command again piped through `head -c 20000` to read the first part,",
    'then through `tail -c +20001 | head -c 20000` for the second, `tail -c +40001 | head -c 20000` for the third, and so on, until a part prints nothing.',
    'If a part still comes back cut short, halve the page size and read that part again in two halves.',
    'This applies to `agent-review capture show` and `agent-review diff-for` output alike.',
    'Never save the output to a file to page through it.',
  ]) {
    assert.ok(long.includes(needle), `LONG OUTPUT must say ${JSON.stringify(needle)}`);
  }
  assert.ok(!long.includes('sed -n'), 'a page of 300 lines can still pass the Bash cap');
});

test('the lane heredoc examples run, and their files pass the lane check', () => {
  const { checkLaneOutput } = require('./codeReviewProof.cjs');
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-lane-'));
  try {
    for (const script of laneHeredocs(laneText())) {
      execFileSync(process.execPath, ['-'], {
        input: script.replaceAll('/tmp/', `${dir}/`).replaceAll('{{ATTEMPT}}', 'r-1'),
      });
    }
    const read = (kind) => readFileSync(join(dir, `code_review_${kind}.r-1.json`), 'utf8');
    const numJs = ['function parseCount(s) {', '  // digits only', '', '', '', '', '  if (!/^\\d+$/.test(s)) return null;', '  return Number(s);', '}'];
    const repo = {
      fileExists: (path) => path === 'lib/num.js',
      readLines: (path) => (path === 'lib/num.js' ? numJs : null),
    };
    const check = (over = {}) =>
      checkLaneOutput({
        rawEntries: JSON.parse(read('raw')),
        scoredText: read('findings'),
        droppedText: read('dropped'),
        excludedPaths: ['dist/**'],
        root: dir,
        ...repo,
        ...over,
      });
    const result = check();
    assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: true, reason: 'ok' });
    const moved = check({ readLines: (path) => (path === 'lib/num.js' ? ['', '', '', '', '', '', '', '', '', '', '', ...numJs] : null) });
    assert.strictEqual(moved.ok, false, "the example proof's quote must sit near the line it cites");
    const proofs = JSON.parse(read('dropped')).map((entry) => entry.proof).filter(Boolean);
    assert.ok(proofs.some((p) => p.includes('if (!/^\\d+$/.test(s))')), 'a doubled backslash reaches the file as one');
    const evidence = JSON.parse(read('findings')).findings.map((f) => f.evidence);
    assert.ok(evidence.some((e) => e.includes('{ name: "Ann" }')), 'an escaped double quote reaches the file as one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lane template calls capture-wait with --run {{RUN_ID}} --effort {{EFFORT}} and loops on exit 3', () => {
  const text = laneText();
  const step1 = laneStep(text, 'STEP 1.', 'STEP 2.');
  assert.ok(
    step1.includes('```bash\nagent-review capture-wait --run {{RUN_ID}} --effort {{EFFORT}}\n```'),
    step1,
  );
  const flat = flatText(step1);
  for (const needle of [
    'Call the Skill tool once, with exactly these inputs: - skill: "code-review" - args: "{{SKILL_ARGS}}"',
    "Ignore the Skill tool's reply.",
    'either way, never read findings from it.',
    'give that Bash call a timeout of 600000',
    '- 0: /code-review finished. Go to STEP 2.',
    '- 3: /code-review is still running. Run the same command again, with the same timeout.',
    '- 1: /code-review did not finish, or its result cannot be waited for. Stop here and write no files. Reply with the one line `/code-review did not finish` and nothing else.',
  ]) {
    assert.ok(flat.includes(needle), `STEP 1 must say ${JSON.stringify(needle)}`);
  }
  assert.ok(flat.indexOf('Call the Skill tool once') < flat.indexOf('agent-review capture-wait'), 'the wait follows the Skill call');
  const retry = flatText(laneStep(text, 'RETRY NOTE', 'STEP 1.'));
  assert.ok(retry.includes('{{RETRY_NOTE}}'), retry);
  assert.ok(
    retry.includes('If it says to skip the Skill call, skip only that call: still run `capture-wait` in STEP 1, and do every later step.'),
    retry,
  );
});

test('lane template lists raw findings the way the check grounds them', () => {
  const step2 = flatText(laneStep(laneText(), 'STEP 2.', 'STEP 3.'));
  for (const needle of [
    'It prints the saved result exactly, and that text is the only source of raw findings.',
    '`n` counts 1, 2, 3, ... in list order;',
    '`file` is the path the result gives, made repo-relative: drop any leading path to the repository root and any leading `./`;',
    'that list is the only source: copy it one to one, in the same order, with the same `file` and the same `line`, and ignore every other line of the result.',
    'When it has two such lists that differ, the result cannot be used.',
    'A `line` written as a string uses the number it starts with (`"42-45"` gives 42).',
    'Otherwise, every line of the result that cites a location is one raw finding.',
    'For `path:start-end`, the raw `line` is `start`: `src/a.js:49-59` gives 49.',
    'When none of these fits, or the result cannot be used, write `[]` as the raw list anyway,',
    'A web address such as `https://example.com:443` is not a location.',
    'but not lines inside a code block labeled with a language, such as `js` or `ruby`.',
    'List each such line once, using the first location on it, even when two lines cite the same location and even when a line seems to give only context.',
    'A list that is `[]` never cancels a finding line.',
    'The raw list is `[]` when no line cites a location and the result either has findings lists that are all `[]` or has a line that reads exactly `(none)` or `No findings.`.',
  ]) {
    assert.ok(step2.includes(needle), `STEP 2 must say ${JSON.stringify(needle)}`);
  }
  for (const label of ['text', 'txt', 'md', 'markdown', 'plain']) {
    assert.ok(step2.includes(`\`${label}\``), `a fence labeled ${label} holds prose the check reads`);
  }
  assert.ok(!step2.includes('the last such list'), 'two different lists fail the check, so the last one never wins');
  const json = step2.indexOf('1. JSON list.');
  const lines = step2.indexOf('2. Finding lines.');
  const none = step2.indexOf('3. Nothing.');
  assert.ok(json >= 0 && json < lines && lines < none, 'JSON list first, then finding lines, then nothing');
  assert.ok(!step2.includes('Result:'), 'the captured text has no Result: header to look for');
  assert.ok(!/\b[Ss]teps? [1-5]\b/.test(step2), 'list items never read as "step N" beside the STEP headings');
});

test('lane template scores from the diff-for blocks, not the whole diff', () => {
  const step3 = laneStep(laneText(), 'STEP 3.', 'SCORING CONTEXT:');
  assert.ok(
    step3.includes('```bash\nagent-review diff-for --diff {{DIFF_PATH}} --raw /tmp/code_review_raw.{{ATTEMPT}}.json\n```'),
    step3,
  );
  const flat = flatText(step3);
  assert.ok(flat.includes('When the raw list is empty, skip to STEP 4.'), flat);
  assert.ok(flat.includes('Read that output, not the whole diff.'), flat);
  assert.ok(flat.indexOf('skip to STEP 4') < flat.indexOf('agent-review diff-for'), 'an empty raw list never reads the diff');
  assert.ok(flat.includes("either way its entry's `raw` is the raw finding's `n`."), flat);
  for (const needle of [
    'It skips files on an excluded path, and for any other file it has no block for, it prints a line `no diff block for <file>`.',
    'A missing block never proves that a file is unchanged: the diff can spell a path another way, such as a quoted name or a rename.',
    'Before you set `outside_range` to `true` for a finding on such a file, run `grep -n "^diff --git" {{DIFF_PATH}}`, look for the file under any spelling, and read its block if it is there.',
  ]) {
    assert.ok(flat.includes(needle), `STEP 3 must say ${JSON.stringify(needle)}`);
  }
  assert.ok(!flat.includes('has no change in this pass'), 'a missing block is not proof of no change');
});

test('lane template anchors a no-line finding to the changed line, and consensus caps a null line at 6', () => {
  const flat = flatText(laneText());
  for (const needle of [
    "- `line`: its raw entry's `line`. When that is `null`, use the line in {{DIFF_PATH}} that this change adds or changes and that the failure runs through. Leave it `null` only when no such line applies. A finding with a `null` line never scores above 6.",
    '- every finding with a `null` `line` scores 6 or less;',
  ]) {
    assert.ok(flat.includes(needle), `the lane must say ${JSON.stringify(needle)}`);
  }
  const { consensusFrom } = require('./consensus.cjs');
  const blocker = {
    raw: 1, agent: 'code-review', category: 'correctness', severity: 8, file: 'app/user.js', line: null,
    message: 'displayName throws for a user with no profile', confidence: 'High',
    evidence: 'displayName({}) reaches the nickname read with no profile and throws.',
    outside_range: false, doubted: false, recategorized_from: null,
  };
  const run = (finding) =>
    consensusFrom({
      plan: { engine: { name: 'code-review' }, agents: [{ id: 'code-review' }] },
      findingsByAgent: { 'code-review': { findings: [finding] } },
      profile: 'standard',
    }).findings.map((f) => f.severity);
  assert.deepStrictEqual(run(blocker), [6], 'a High-confidence 8 with no line comes out as 6');
  assert.deepStrictEqual(run({ ...blocker, line: 13 }), [8], 'anchored to a line, the same finding keeps its 8');
});

test('lane template sets the structured fields instead of evidence prefixes', () => {
  const text = laneText();
  for (const prefix of ['Outside the reviewed range: ', 'Doubted: ', 'Recategorized from ']) {
    assert.ok(!text.includes(prefix), `the lane no longer writes the ${JSON.stringify(prefix)} evidence prefix`);
  }
  const flat = flatText(text);
  for (const needle of [
    'A finding that is truly outside the reviewed range scores 6 at most, keeps its original category, and has `outside_range` set to `true`. Every other finding has `outside_range` set to `false`.',
    'set `confidence` to `Low` and `doubted` to `true`, score it 4 at most (even where the 7+ bar would allow 6), and say why in `evidence`. Every other finding has `doubted` set to `false`.',
    'set `recategorized_from` to the cleanup name you moved it out of',
    '- `raw`: the `n` of its raw entry',
    '- `outside_range`: `true` or `false`, from SEVERITY',
    '- `doubted`: `true` or `false`, from DROPPING A FINDING',
    '- `recategorized_from`: a cleanup name or `null`, from CATEGORY',
  ]) {
    assert.ok(flat.includes(needle), `the lane must say ${JSON.stringify(needle)}`);
  }
  const scored = laneHeredocs(text)[1];
  for (const field of ['raw: 1,', 'outside_range: false', 'doubted: false', 'recategorized_from: null']) {
    assert.ok(scored.includes(field), `the scored example carries ${field}`);
  }
});

test('code-review-lane.md limits category to the names the engine knows', () => {
  const flat = flatText(laneText());
  const categories = flat.slice(flat.indexOf('CATEGORY:'), flat.indexOf('CONFIDENCE:'));
  assert.ok(
    categories.includes(
      '`category` must be exactly one of these nine names: `correctness`, `security`, `data-integrity`, `testing`, `simplification`, `efficiency`, `reuse`, `altitude`, or `conventions`.',
    ),
    'the scorer may not invent a category name',
  );
  assert.ok(
    categories.includes('a cleanup finding must use one of these five names'),
    'an invented cleanup name would dodge the engine cap',
  );
  assert.ok(flat.includes('every `category` is one of the nine names'), 'the self-check repeats the rule');
  assert.ok(
    categories.includes('When that category is not one of the nine names, map it to the closest one. This mapping is normal scoring and leaves `recategorized_from` set to `null`.'),
    'mapping a raw category is ordinary scoring',
  );
  assert.ok(
    categories.includes('Set `recategorized_from` only for that move, never for mapping a raw category to one of the nine names.'),
    'the field is not for mapping',
  );
});

test('lane template shows the profile and never lets it drop or lower a finding', () => {
  const profile = flatText(laneStep(laneText(), 'PROFILE:', 'DROPPING A FINDING:'));
  assert.ok(profile.includes('{{PROFILE_INSTRUCTION}}'), profile);
  assert.ok(profile.includes('The profile never justifies dropping a finding or lowering its score.'), profile);
});

test('lane template has no REFUTED drop and names both drop reasons', () => {
  const text = laneText();
  assert.ok(!text.includes('REFUTED'), '/code-review already leaves refuted findings out of its result');
  const dropping = flatText(laneStep(text, 'DROPPING A FINDING:', 'STEP 4.'));
  for (const needle of [
    'Drop a raw finding in only two cases:',
    '1. Excluded path. Its `file` matches one of the excluded paths below. Drop it with `reason: "excluded"` and `glob` set to that glob, copied exactly as listed, for example `dist/**`.',
    '2. Disproved.',
    'Drop it with `reason: "disproved"` and a `proof` that names which of those it is and quotes the exact line or lines that show it, with `path:line`',
    'EXCLUDED PATHS (one glob per line, or `none`): {{EXCLUDED_PATHS}}',
    "When the finding's line in /code-review's result also cites a location that no excluded glob matches, the finding is not only on an excluded path: score it instead.",
    'The review checks the proof three ways:',
    '- the path names a file that exists in the repository, such as `lib/cart.rb` or `Makefile`;',
    '- the line is a line of that file, from 1 to its last line;',
    '- the text right after `path:line` is the quoted code: at least 3 characters besides spaces, found in that file within 2 lines of that line. Spaces, line breaks, backticks, and `*` do not count when comparing.',
    'So write the quoted code right after `path:line`, and nothing after it.',
  ]) {
    assert.ok(dropping.includes(needle), `DROPPING A FINDING must say ${JSON.stringify(needle)}`);
  }
  assert.ok(!dropping.includes('The review checks that the proof cites a `path:line`.'), 'the old, looser rule is gone');
  const flat = flatText(text);
  for (const needle of [
    'Each dropped finding becomes one entry: `{ raw, reason: "excluded", glob }` or `{ raw, reason: "disproved", proof }`.',
    'every raw finding whose `file` matches an excluded path is dropped with `reason: "excluded"`;',
    'every `severity` is a whole number from 1 to 10;',
  ]) {
    assert.ok(flat.includes(needle), `the lane must say ${JSON.stringify(needle)}`);
  }
  const scored = laneHeredocs(text)[1];
  assert.ok(scored.includes('{ raw: 2, reason: "excluded", glob: "dist/**" }'), scored);
  assert.ok(scored.includes('{ raw: 3, reason: "disproved", proof: '), scored);

  const row = lanePlaceholderRows().rows.get('EXCLUDED_PATHS');
  assert.ok(row, 'the skill documents {{EXCLUDED_PATHS}}');
  assert.ok(
    row.includes('The globs `agent-review config get excluded_paths` prints (a JSON array), one per line. `none` when the list is empty.'),
    row,
  );
});

test('lane template runs code-review-proof before its final line', () => {
  const text = laneText();
  assert.ok(text.includes('```bash\n' + LANE_PROOF_COMMAND + '\n```'), 'STEP 5 runs the proof on this attempt\'s files');
  assert.ok(!text.includes('--capture'), 'the proof always reads the hook capture itself');
  const step5 = flatText(laneStep(text, 'STEP 5.'));
  assert.ok(
    step5.indexOf('agent-review code-review-proof') < step5.indexOf('your final message must be exactly one line'),
    'the check runs before the final line',
  );
  for (const needle of [
    '- `ok` is `true`: give the final line below.',
    '- `stage` is `"lane"`: your files have the problem that `reason` names',
    'Never call the Skill tool again. Fix at most twice; if the check still fails, give the final line anyway.',
    "- `stage` is `\"capture\"`: /code-review's result cannot be used. Reply with the one line `/code-review returned no usable result` and nothing else.",
    '- `stage` is `"config"`: the review\'s config could not be read, and you cannot fix that. Give the final line below.',
    'where `<N>` is `findings.length` in `/tmp/code_review_findings.{{ATTEMPT}}.json`',
  ]) {
    assert.ok(step5.includes(needle), `STEP 5 must say ${JSON.stringify(needle)}`);
  }
});

test('the review skill routes agents by plan tier and degrades safely', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review:reviewer-'), 'launch table must select tier subagent types');
  assert.ok(!skill.includes('or `opus` when `risk.level`'), 'the blanket smart→opus escalation must be gone');
  assert.ok(!skill.includes('MODEL_OVERRIDE'), 'mode overrides are engine-resolved now — no model prose logic');
  assert.ok(skill.includes('routing degraded'), 'unknown subagent type must fall back with a report note');
  assert.ok(skill.includes('plan.mode.resolved') || skill.includes('mode.resolved'), 'auto resolution comes from the plan');
});

// Extracts the first ```bash fence in `section` and returns its first non-comment,
// non-blank line — used to pin that every consolidated block sources review_env.sh first.
function firstNonCommentLineOfFirstBashFence(section, label) {
  const fenceStart = section.indexOf('```bash');
  assert.ok(fenceStart !== -1, `no \`\`\`bash fence found in the ${label} section`);
  const fenceEnd = section.indexOf('```', fenceStart + '```bash'.length);
  assert.ok(fenceEnd !== -1, `unterminated \`\`\`bash fence in the ${label} section`);
  const block = section.slice(fenceStart + '```bash'.length, fenceEnd);
  return block
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
}

test('the Build the Review Plan & Load Evidence block sources review_env.sh before using $MODE/$RANGE/$FULL_RANGE', () => {
  // Every bash block in this skill is a fresh shell (see the "Cross-stage state" note). Sourcing
  // review_env.sh as the first statement is defensive idempotency for mid-run bwrap bind-race
  // reruns and for picking up cross-block state exported by earlier blocks — here $MODE (from
  // the Initialize block) and $RANGE/$FULL_RANGE (from Gather PR Context & Diff Manifest), used
  // for --mode and the gate-plan aliasing check respectively. Skipping the source line silently
  // sends `--mode ''` (auto mode never resolves) and aliases an empty $FULL_RANGE to an empty
  // $RANGE (wrongly treating every re-review as the full PR).
  // The CI-path setup is three blocks (mode
  // parse/CI-detect/config-validate/dirs; PR-context/diff-manifest; plan/evidence, with an
  // explicit REVIEW_SCOPE model checkpoint between the second and third) — this is the third.
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const start = skill.indexOf('### Build the Review Plan & Load Evidence');
  const end = skill.indexOf('## CI Mode', start);
  assert.ok(start !== -1 && end !== -1, 'Build the Review Plan & Load Evidence / CI Mode anchors not found');
  const section = skill.slice(start, end);
  const firstLine = firstNonCommentLineOfFirstBashFence(section, 'Build the Review Plan & Load Evidence');
  assert.strictEqual(
    firstLine,
    '. /tmp/review_env.sh 2>/dev/null || true',
    'the plan-invocation block must source review_env.sh as its first non-comment line',
  );
});

test('a score-0 skip computes status from carried-forward state and surfaces open blockers', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const start = skill.indexOf('### Auto Mode Resolution');
  const skip = skill.slice(start, skill.indexOf('If auto resolved to', start));
  assert.ok(/agent-review-status/.test(skip), 'the skip path must stage a status marker');
  assert.ok(/agent-review status --ledger/.test(skip), 'skip status must be COMPUTED via the engine, never hand-authored');
  assert.ok(!/"pass":\s*true/.test(skip), 'skip status must not hardcode a pass:true literal');
  assert.ok(/previously-found blocker\(s\) remain open/.test(skip), 'carried-forward open blockers must be surfaced in the skip note');
});

// --- Skill wiring: engine consensus replaces in-context consensus ---
// --- grouping/averaging, agents hand off via files at every stage that reads findings. ---

function stageSlice(skill, startHeader, endHeader) {
  const start = skill.indexOf(startHeader);
  assert.ok(start !== -1, `stage header not found: ${startHeader}`);
  const end = skill.indexOf(endHeader, start);
  assert.ok(end !== -1, `stage header not found: ${endHeader}`);
  return skill.slice(start, end);
}

test('Stage 1 launch table fills {{AGENT_ID}} from the plan agent id', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage1 = stageSlice(skill, '## Stage 1 — Launch Specialized Review Agents', '## Stage 1B');
  assert.ok(stage1.includes('{{AGENT_ID}}'), 'the launch table must fill the AGENT_ID placeholder');
});

test('the review skill slices per agent and skips empty lanes', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review slice --plan'));
  assert.ok(skill.includes('/tmp/agent_slices'));
  assert.ok(skill.includes('mode is "empty"'), 'empty-slice lanes must be skipped, not launched');
  assert.ok(skill.includes('mkdir -p /tmp/agent_slices') || /rm -f \/tmp\/agent_slices/.test(skill), 'slice dir needs fresh-state handling in Initialize');
});

// --- Final review fix wave (I1, I2, I3, I5) ---

test('a lane with no slice_manifest entry at all (deep config-only) is a full-diff lane', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const diffPathRow = skill.split('\n').find((l) => l.includes('{{DIFF_PATH}}'));
  assert.ok(diffPathRow, '{{DIFF_PATH}} placeholder row not found');
  assert.ok(
    /no manifest entry/i.test(diffPathRow) && diffPathRow.includes('/tmp/pr_diff.txt'),
    'deep mode config-only lanes (no plan entry, never sliced) must fall back to the full diff',
  );
});

test('{{RISK_CONTEXT}} surfaces the lane\'s model tier for the archetype\'s read budget', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const riskContextRow = skill.split('\n').find((l) => l.includes('{{RISK_CONTEXT}}'));
  assert.ok(riskContextRow, '{{RISK_CONTEXT}} placeholder row not found');
  assert.ok(
    riskContextRow.includes('- Model tier: <tier>'),
    'the risk-context bullet list must include the lane\'s tier — the archetype\'s ~10-file budget on sonnet+HIGH/CRITICAL is otherwise unreachable',
  );
});

test('skipped-lane notes are plumbed through a file from Stage 1 to Stage 6', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('/tmp/skipped_lanes.txt'), 'a skipped-lanes file must exist');
  assert.ok(
    /rm -f[^\n]*\/tmp\/skipped_lanes\.txt/.test(skill),
    'fresh-state cleanup must remove /tmp/skipped_lanes.txt like the other per-run slice state',
  );
  const stage1 = stageSlice(skill, '## Stage 1 — Launch Specialized Review Agents', '## Stage 1B');
  assert.ok(
    stage1.includes('skippedIds') && stage1.includes('/tmp/skipped_lanes.txt'),
    'the same Stage 1 block that writes launched_lanes.json must also write skipped_lanes.txt',
  );
  assert.ok(
    /Stage 6[^]*?\[IF any lanes were skipped:\]/i.test(skill) ||
      skill.includes('[IF any lanes were skipped:]'),
    'Stage 6 conditional-fill list must reference the skeleton\'s skipped-lanes line',
  );
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  assert.ok(
    report.includes('[IF any lanes were skipped:] - lanes with no matching changes: [ids]'),
    'the report skeleton must carry the exact skipped-lanes conditional line',
  );
});

test('quick mode always retains a coverage-forced lane, even past the 3-agent cap', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage0b = stageSlice(skill, '## Stage 0B — Agent Selection', '## Stage 1 — Launch Specialized Review Agents');
  assert.ok(
    /unmatched-coverage/.test(stage0b) && /always/i.test(stage0b),
    'quick mode\'s bullet must state that an unmatched-coverage lane is always retained',
  );
});

test('the launched-subset plan derives at Stage 1 launch time, from lanes actually launched', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage1 = stageSlice(skill, '## Stage 1 — Launch Specialized Review Agents', '## Stage 1B');
  assert.ok(
    stage1.includes('/tmp/review_plan_launched.json') && stage1.includes('/tmp/launched_lanes.json'),
    'the launched-subset derivation must live in the Stage 1 region, not before or after it',
  );
  assert.ok(
    /after (every )?task call/i.test(stage1),
    'the derivation must run after the launch Task calls are issued, not before',
  );
  assert.ok(
    /synthesiz/i.test(stage1),
    'deep mode config-only lanes (no plan entry) need a synthesized minimal plan entry documented',
  );
  assert.ok(
    stage1.includes('fs.writeFileSync("/tmp/review_plan_launched.json", JSON.stringify({ ...plan, agents }, null, 2));'),
    'the launched plan keeps every plan field, engine included, so consensus can require the code-review lane',
  );
  const buildPlanBlock = stageSlice(
    skill,
    '### Build the Review Plan & Load Evidence',
    '## CI Mode',
  );
  assert.ok(
    buildPlanBlock.includes('agent-review slice --plan'),
    'the slice command itself must still run right after the plan is built',
  );
  assert.ok(
    !buildPlanBlock.includes('/tmp/review_plan_launched.json'),
    'the old post-slice launched-subset derivation must be gone; it derives at Stage 1 launch time',
  );
});

test('the archetype reading contract is budgeted, not unbounded', () => {
  const a = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(a.includes('{{DIFF_PATH}}'));
  assert.ok(!a.includes('READ THE FULL FILES for context'), 'the unbounded read mandate must be gone');
  assert.ok(a.includes('full-file read budget'), 'budgeted reads must be stated');
  assert.ok(a.includes('discovery grep budget'), 'bounded discovery greps must be stated');
});

test('Stage 2 collect cross-checks each lane\'s returned N against its findings file, treats unparseable JSON as missing, and relaunches a failed lane exactly once', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage2 = stageSlice(skill, '## Stage 2 — Collect Agent Reports', '## Stage 2B');
  assert.ok(/\/tmp\/agent_findings\//.test(stage2), 'collect stage must read the findings file, not pasted output');
  assert.ok(/findings\.length/.test(stage2), 'collect stage must cross-check N against the file\'s findings.length');
  assert.ok(/JSON\.parse/.test(stage2), 'collect stage must call out JSON.parse failure explicitly');
  assert.ok(
    /unparseable JSON exactly like a missing file|treat unparseable JSON.*like a missing file/i.test(stage2),
    'a lane whose findings file fails JSON.parse must be treated the same as a missing file',
  );
  assert.ok(
    skill.includes('relaunch that lane once; a lane that fails twice fails the run'),
    'the relaunch-once rule must be stated verbatim, in terms of the real fail-closed mechanism',
  );
  assert.ok(
    !skill.includes('blocks PASS'),
    'the old "blocks PASS" phrasing (conflated with the irreversible/status mechanism) must be gone',
  );
});

test('a lane that fails twice stops the run with no report and is never wired into irreversible/status', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage2 = stageSlice(skill, '## Stage 2 — Collect Agent Reports', '## Stage 2B');
  assert.ok(
    stage2.includes('❌ review incomplete: lane <id> failed twice — no report posted (the workflow will fail closed)'),
    'the loud fail-closed final line must be pinned verbatim',
  );
  assert.ok(
    stage2.includes('do not write `$AGENT_REVIEW_COMMENT_OUT`'),
    'a twice-failed lane must skip writing the comment-out file, tripping the existing empty-report check',
  );
  assert.ok(
    /local.*non-ci.*mode/i.test(stage2),
    'local (non-CI) mode must also stop the same way',
  );
  const skillWide = skill;
  assert.ok(
    !/Degraded lanes\.\*\*/.test(skillWide),
    'the old "Degraded lanes" irreversibility-wiring paragraph must be removed',
  );
  assert.ok(
    !skillWide.includes('irreversibility reason so auto-approval waits for a human'),
    'a failed lane must never be folded into the irreversible/status mechanism (false, un-clearable banner)',
  );
});

test('Stage 5 invokes the deterministic consensus engine instead of in-context grouping/averaging', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage5 = stageSlice(skill, '## Stage 5 — Consensus Synthesis', '## Stage 5B');
  assert.ok(stage5.includes('agent-review consensus --plan') || /agent-review consensus\s*\\?\s*\n?\s*--plan/.test(stage5), 'Stage 5 must invoke the consensus CLI with --plan');
  assert.ok(stage5.includes('--dir /tmp/agent_findings'), 'Stage 5 must point --dir at the agent findings directory');
  assert.ok(stage5.includes('--profile'), 'Stage 5 must pass --profile');
  assert.ok(stage5.includes('--decisions /tmp/consensus_decisions.json'), 'Stage 5 must re-run with --decisions after a bounded pass');
  assert.ok(stage5.includes('/tmp/consensus_findings.json'), 'Stage 5 must land the final array at /tmp/consensus_findings.json');
  assert.ok(stage5.includes('one bounded model pass'), 'the candidates bounded-pass instruction must be present');
  assert.ok(!skill.includes('Group findings by similarity'), 'in-context Stage 5 grouping instructions must be gone');
  assert.ok(!stage5.includes('Calculate average severity score for each finding'), 'in-context severity averaging must be gone');
});

test('Stage 6 report inputs are named as consensus JSON + plan + status, and the reversibility full-diff exception is stated', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage6 = stageSlice(skill, '## Stage 6 — Generate Review Report', '## Stage 7');
  const writeReport = stageSlice(skill, '### Write the report', '## Stage 7');
  const inputsSentence = writeReport.slice(0, writeReport.indexOf('Honor its conditionals'));
  assert.ok(!/the consensus, risk assessment, impact analysis, and agent reports/.test(inputsSentence), 'the old vague inputs sentence must be gone');
  assert.ok(inputsSentence.includes('/tmp/consensus_findings.json'), 'report inputs sentence must name the consensus JSON file');
  assert.ok(inputsSentence.includes('/tmp/review_gate_plan.json'), 'report inputs sentence must name the plan file');
  assert.ok(inputsSentence.includes('/tmp/agent_review_status.json'), 'report inputs sentence must name the status file');
  assert.ok(
    stage6.includes('/tmp/pr_full_diff.txt') && stage6.includes('never the incremental-only'),
    'the reversibility full-diff exception must still be stated in Stage 6',
  );
});

test('the emit/filter/ledger/status pipeline and static-findings prepend in Stage 6 are untouched', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage6 = stageSlice(skill, '## Stage 6 — Generate Review Report', '## Stage 7');
  assert.ok(stage6.includes("evidence.staticFindings || []"), 'static-findings prepend must be byte-identical');
  assert.ok(stage6.includes('agent-review emit --in /tmp/consensus_findings.json'), 'emit invocation must be untouched');
  assert.ok(stage6.includes('agent-review filter > /tmp/review_filtered.json'), 'filter invocation must be untouched');
  assert.ok(stage6.includes('agent-review ledger \\'), 'ledger invocation must be untouched');
  assert.ok(stage6.includes('agent-review status \\'), 'status invocation must be untouched');
});

test('Stage 3 debate prompt sources both self and peer findings from /tmp/agent_findings/*.json, not pasted output', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage3 = stageSlice(skill, '## Stage 3 — Cross-Examination Debate', '## Stage 4');
  assert.ok(/\/tmp\/agent_findings\//.test(stage3), 'debate prompt must reference the findings-file path');
  assert.ok(
    !stage3.includes("[Paste that agent's original review output with severity scores]"),
    'the old pasted-output placeholder must be gone from the debate prompt',
  );
  assert.ok(
    !stage3.includes("[All other agents' findings with severity scores]"),
    'the old pasted-output placeholder for peer findings must be gone',
  );
});

test('Stage 4 rebuttal prompt re-sources YOUR ORIGINAL FINDINGS from the agent\'s own findings file', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage4 = stageSlice(skill, '## Stage 4 — Rebuttals', '## Stage 5 — Consensus Synthesis');
  assert.ok(/\/tmp\/agent_findings\//.test(stage4), 'rebuttal prompt must reference the findings-file path');
  assert.ok(
    !stage4.includes('[Their original findings with severity scores]'),
    'the old pasted-output placeholder must be gone from the rebuttal prompt',
  );
});

test('the archetype instructs writing the findings file via node -e and JSON.stringify, never hand-escaped JSON, and caps recommendation length', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(/node -e/.test(archetype), 'archetype must show writing the findings file via node -e');
  assert.ok(/JSON\.stringify/.test(archetype), 'archetype must show JSON.stringify building the file');
  assert.ok(/never hand-escaped JSON/i.test(archetype), 'archetype must explicitly forbid hand-escaped JSON');
  assert.ok(/recommendation: ≤ ?4 lines/.test(archetype), 'archetype must cap recommendation to <=4 lines');
});

// --- CI bash-block consolidation: fewer separate Bash-tool turns ---
// --- for a CI run. Each turn is a fresh shell (see the "Cross-stage state" note), and every ---
// --- turn boundary is a place a bwrap sandbox bind-race can strike mid-review. ---

function countBashFences(text) {
  let count = 0;
  let inFence = false;
  let inBash = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        inBash = line.slice(3).trim().toLowerCase() === 'bash';
        if (inBash) count += 1;
      } else {
        inFence = false;
        inBash = false;
      }
    }
  }
  return count;
}

test('the REVIEW_SCOPE checkpoint is an explicit model decision between the diff manifest and the plan invocation', () => {
  // REVIEW_SCOPE requires the model to read the diff manifest's output before
  // the plan runs — a genuine judgment call, not scriptable, so it cannot live inside a merged
  // bash block. This pins that the checkpoint sits between the two blocks (not folded into
  // either), and that the plan block picks up whatever the model set.
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const diffManifestStart = skill.indexOf('### Gather PR Context & Diff Manifest');
  const planStart = skill.indexOf('### Build the Review Plan & Load Evidence');
  assert.ok(diffManifestStart !== -1 && planStart !== -1, 'Gather PR Context / Build the Review Plan anchors not found');
  // The checkpoint is the prose between the diff-manifest block's closing fence and the plan
  // block's heading — not the whole "Gather PR Context & Diff Manifest" section, which itself
  // contains a bash fence.
  const diffManifestFenceStart = skill.indexOf('```bash', diffManifestStart);
  const diffManifestFenceEnd = skill.indexOf('```', diffManifestFenceStart + '```bash'.length);
  assert.ok(diffManifestFenceStart !== -1 && diffManifestFenceEnd !== -1, 'diff-manifest fence not found');
  const checkpoint = skill.slice(diffManifestFenceEnd + '```'.length, planStart);
  assert.ok(checkpoint.includes('Checkpoint'), 'an explicit checkpoint must sit between the diff manifest and the plan blocks');
  assert.ok(
    /changed-file list and\s+diff stat from the previous block/.test(checkpoint),
    'the checkpoint must instruct reading the diff manifest\'s own output',
  );
  assert.ok(
    /single_feature.*multi_feature.*cross_cutting.*core_infra/.test(checkpoint),
    'the checkpoint must name all four REVIEW_SCOPE values',
  );
  assert.ok(
    checkpoint.includes('defaults to `single_feature` only when the footprint genuinely is one'),
    'the checkpoint must forbid defaulting to single_feature by omission',
  );
  const planSection = skill.slice(planStart, skill.indexOf('## CI Mode', planStart));
  assert.ok(
    planSection.includes('REVIEW_SCOPE="${REVIEW_SCOPE:-single_feature}"'),
    'the plan block must read $REVIEW_SCOPE (set at the checkpoint) rather than recomputing it',
  );
  assert.ok(
    !checkpoint.includes('```bash'),
    'the checkpoint itself must not be a bash turn — it is a model decision',
  );
});

test('the CI path uses at most 14 bash turns (Stage 0A through Stage 6)', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage0AStart = skill.indexOf('## Stage 0A — Parse Review Mode & Initialize');
  const stage7Start = skill.indexOf('## Stage 7 — Post, Print & Metrics');
  const stage5BStart = skill.indexOf('## Stage 5B — Historical Metrics Dashboard');
  const stage6Start = skill.indexOf('## Stage 6 — Generate Review Report');
  const localOnlyStart = skill.indexOf('**Locally** the opposite can be stale');
  for (const [name, index] of [
    ['Stage 0A', stage0AStart],
    ['Stage 7', stage7Start],
    ['Stage 5B', stage5BStart],
    ['Stage 6', stage6Start],
    ['the local-only version-check branch', localOnlyStart],
  ]) {
    assert.ok(index !== -1, `anchor not found: ${name}`);
  }
  // Stage 5B ("SKIP THIS ENTIRE STAGE IN CI MODE") and the local-only plugin-staleness check
  // ("**Locally** the opposite can be stale...") never execute during a CI run, so they are
  // outside the CI-path turn budget; they stay unmerged because they only ever run locally.
  //
  // The budget is 12, not 10: REVIEW_SCOPE requires the model
  // to read the diff manifest's changed-file list and stat output — a genuine decision, not
  // scriptable — before the plan invocation. That checkpoint can't sit inside a merged bash
  // block, so Stage 0A/0's setup is three turns (mode-parse/CI-detect/config-validate/dirs;
  // PR-context/diff-manifest; plan/evidence) instead of one, +2 over the fence-count-only budget.
  //
  // 13, not 12: the launched-subset plan consumed by
  // Stage 2's cross-check and Stage 5's consensus must derive from the lanes ACTUALLY launched —
  // the one point where slice-empty skips, quick mode's 3-agent cap, and deep mode's config-only
  // expansion all converge. That set is only fully known immediately after Stage 1 issues its
  // Task calls, so it cannot be folded into the pre-launch "Approved learnings & dependency
  // impact" bash block (which must run BEFORE those Task calls, to feed the archetype prompts) —
  // it is an unavoidable extra turn, +1 over the previous budget.
  //
  // 14, not 13: the start-up line is its own every-mode turn after
  // Auto Mode Resolution, because a model skips that auto-only section on a standard run.
  const ciPath = skill.slice(stage0AStart, stage5BStart) + skill.slice(stage6Start, localOnlyStart);
  const count = countBashFences(ciPath);
  assert.ok(count <= 14, `CI-path bash fence count is ${count}, expected <= 14`);
});

test('every consolidated CI-path block sources review_env.sh as its first non-comment line', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const sections = [
    [
      'Initialize',
      '### Initialize',
      '### Gather PR Context & Diff Manifest',
    ],
    [
      'Gather PR Context & Diff Manifest',
      '### Gather PR Context & Diff Manifest',
      '### Build the Review Plan & Load Evidence',
    ],
    [
      'Approved learnings & dependency impact',
      '### Approved learnings & dependency impact',
      '### Assemble each agent prompt',
    ],
    [
      'Stage 5 decisions re-run + extract findings',
      'extracts the plain findings array Stage 6 expects',
      '## Stage 5B — Historical Metrics Dashboard',
    ],
    [
      'Capture consensus for the learning layer + build the findings ledger',
      '### Capture consensus for the learning layer',
      '### Build the findings ledger',
    ],
  ];
  for (const [label, startAnchor, endAnchor] of sections) {
    const start = skill.indexOf(startAnchor);
    const end = skill.indexOf(endAnchor, start);
    assert.ok(start !== -1 && end !== -1, `${label}: anchors not found (start=${start}, end=${end})`);
    const section = skill.slice(start, end);
    const firstLine = firstNonCommentLineOfFirstBashFence(section, label);
    // A trailing inline comment (e.g. "... || true   # REVIEW_ID, set in Stage 0") is fine —
    // only the leading command matters, so this checks the prefix rather than exact equality.
    assert.ok(
      firstLine.startsWith('. /tmp/review_env.sh 2>/dev/null || true'),
      `${label} must source review_env.sh as its first non-comment line (got: "${firstLine}")`,
    );
  }
});

test('Auto Mode Resolution remains its own bash turn — its output gates whether agents launch at all', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const start = skill.indexOf('### Auto Mode Resolution');
  const end = skill.indexOf('### Start-up Line', start);
  assert.ok(start !== -1 && end !== -1, 'Auto Mode Resolution / Start-up Line anchors not found');
  const section = skill.slice(start, end);
  assert.strictEqual(
    countBashFences(section),
    1,
    'Auto Mode Resolution must stay exactly one bash turn — a skip must not launch agents',
  );
  assert.ok(section.includes('if [ "$MODE" = "auto" ]'), 'the auto-mode gate logic must still live in this block');
  // It must not have been folded into any of the preceding Stage 0A/0 setup blocks either.
  const setupStart = skill.indexOf('### Initialize');
  const setupSection = skill.slice(setupStart, start);
  assert.ok(
    !setupSection.includes('RESOLVED=$(node -e'),
    'auto-mode resolution logic must not have leaked into the earlier consolidated block',
  );
});

test('the smoke-test tier routing block remains its own bash turn — the launch table reads $ROUTING', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const start = skill.indexOf('### Smoke-Test Tier Routing');
  const end = skill.indexOf('## Stage 1 — Launch Specialized Review Agents', start);
  assert.ok(start !== -1 && end !== -1, 'Smoke-Test Tier Routing anchors not found');
  const section = skill.slice(start, end);
  assert.strictEqual(
    countBashFences(section),
    1,
    'the smoke-test ROUTING block must stay its own bash turn — it can set ROUTING=degraded, which every later launch table reads',
  );
});

test('the consolidated CI-path blocks keep every fail-closed exit message verbatim', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  for (const message of [
    '❌ No valid review config at ${AGENT_REVIEW_DIR:-.claude/review}/config.yml. Run /agent-review:init first.',
    "❌ Could not resolve a diff base (tried 'origin/$BASE_BRANCH' and '$BASE_BRANCH'). Set base_branch in config.yml.",
    '❌ No changed files in $RANGE — nothing to review. Check the base ref.',
    '✅ Head $HEAD_REF already reviewed — nothing new since the last report. Exiting.',
    '✅ No net changes since the last reviewed head — nothing to review. Exiting.',
  ]) {
    assert.ok(skill.includes(message), `fail-closed message missing or altered: ${message}`);
  }
});

test('the review gates load the config without the code-review engine checks', () => {
  const review = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(
    bashBlocks(review).includes('agent-review config show >/dev/null || {\n  echo "❌ No valid review config at ${AGENT_REVIEW_DIR:-.claude/review}/config.yml. Run /agent-review:init first."'),
    'engine=agent-review and CI must still run when the code-review engine settings are wrong; agent-review options reports them',
  );
  const yolo = readFileSync(join(ROOT, 'skills/yolo-review/SKILL.md'), 'utf8');
  assert.ok(yolo.includes('agent-review config show >/dev/null || { echo "❌ No review config — run /agent-review:init first."; exit 1; }'));
  for (const text of [review, yolo]) {
    assert.ok(!bashBlocks(text).includes('agent-review config validate'), 'config validate fails on code-review engine problems');
  }
});

test('the merged CI-path blocks never append to a scratch file other than review_env.sh', () => {
  // A bwrap bind-race rerun replays a whole merged block from the top — a `>>` onto any file
  // besides review_env.sh (whose duplicate export lines are harmless) would duplicate data on
  // retry. `>` and `mkdir -p` are fine; so is `tee -a`/`>>` when the target IS review_env.sh.
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const mergedSections = [
    ['Initialize', '### Initialize', '### Gather PR Context & Diff Manifest'],
    ['Gather PR Context & Diff Manifest', '### Gather PR Context & Diff Manifest', '### Build the Review Plan & Load Evidence'],
    ['Build the Review Plan & Load Evidence', '### Build the Review Plan & Load Evidence', '## CI Mode'],
    ['Approved learnings & dependency impact', '### Approved learnings & dependency impact', '### Assemble each agent prompt'],
    ['Stage 5 decisions re-run + extract findings', 'extracts the plain findings array Stage 6 expects', '## Stage 5B — Historical Metrics Dashboard'],
    ['Capture consensus + build ledger', '### Capture consensus for the learning layer', '### Build the findings ledger'],
  ];
  for (const [label, startAnchor, endAnchor] of mergedSections) {
    const start = skill.indexOf(startAnchor);
    const end = skill.indexOf(endAnchor, start);
    assert.ok(start !== -1 && end !== -1, `${label}: anchors not found`);
    const section = skill.slice(start, end);
    const fenceStart = section.indexOf('```bash');
    const fenceEnd = section.indexOf('```', fenceStart + '```bash'.length);
    const block = section.slice(fenceStart + '```bash'.length, fenceEnd);
    for (const line of block.split('\n')) {
      if (!line.includes('>>')) continue;
      assert.ok(
        line.includes('/tmp/review_env.sh'),
        `${label}: a rerun-unsafe append target other than review_env.sh: "${line.trim()}"`,
      );
    }
  }
});

test('agents with no configured expertise get a derived lane instead of a blank one, and the opt-out guideline cannot be used to skip review', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const expertiseRow = skill.slice(skill.indexOf('| `{{EXPERTISE}}`'), skill.indexOf('\n', skill.indexOf('| `{{EXPERTISE}}`')));
  assert.ok(
    expertiseRow.includes('judged against:'),
    'the {{EXPERTISE}} fallback must derive a lane from the agent title + rules[], not leave it blank',
  );
  assert.ok(
    !skill.includes('leave the line\'s value blank rather than inventing expertise'),
    'the old blank-EXPERTISE fallback text must be gone — a blank lane silently reviews nothing',
  );

  const archetype = readFileSync(ARCHETYPE, 'utf8');
  assert.ok(
    archetype.includes(
      "If your defined expertise genuinely does not apply to anything in this change set, leave `findings` empty and still set `overallConfidence` — but an unclear or generic expertise line is never a reason to skip review: judge the diff on your title's discipline.",
    ),
    'the opt-out guideline must be tightened to forbid using an unclear/generic expertise line as an excuse to skip review',
  );
});

test('the archetype pins an explicit severity rubric with anti-sandbagging teeth', () => {
  const archetype = readFileSync(ARCHETYPE, 'utf8');
  assert.ok(
    archetype.includes(
      'Never rate a finding below 7 to avoid the blocker evidence requirement — if the defect is severity >= 7 by these anchors, gather the evidence and rate it honestly.',
    ),
    'the archetype must forbid sandbagging severity below 7 to dodge the evidence-burden requirement',
  );
  assert.ok(
    archetype.includes('An exploitable injection is 9-10, full stop.'),
    'the severity rubric must anchor exploitable injections at 9-10',
  );
});

test('the CI posting block self-checks the marker JSON before it reaches the trusted post-job', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const postSection = skill.slice(
    skill.indexOf('### Post the report to the PR'),
    skill.indexOf('### Post the report to the PR') + 4000,
  );
  assert.ok(
    postSection.includes(
      'The marker lines are emitted ONLY by the node commands below — never type or edit them by hand; hand-transcribed JSON mangles escapes.',
    ),
    'the posting block preamble must warn against hand-transcribing marker lines',
  );
  assert.ok(
    postSection.includes('console.log("marker self-check OK")'),
    'the posting block must self-check the ledger/status marker JSON after assembling the comment',
  );
});

test('Stage 7 posts automatically, self-checks the marker JSON, and prints the report body', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage7 = skill.slice(skill.indexOf('## Stage 7 — Post, Print & Metrics'), skill.indexOf('## Stage 8'));
  assert.ok(stage7.includes('### Post and print'));
  assert.ok(!stage7.includes('Please respond: 1, 2, 3'), 'the blocking menu is gone');
  assert.ok(!stage7.includes('What would you like to do?'));
  assert.ok(stage7.includes('console.log("marker self-check OK")'), 'the marker self-check must survive');
  assert.ok(stage7.includes('ME=$(gh api user --jq .login)'), 'local post updates only the poster\'s own comment');
  assert.ok(stage7.includes("awk '/^<details>/{exit} {print}' /tmp/agent_review_report.md"), 'the visible report body is printed to the terminal');
  assert.ok(stage7.includes('💾 Saved locally, no PR'), 'no-PR case saves and says so');
  assert.ok(stage7.includes('/tmp/agent_review_post_result.txt'));
  assert.ok(stage7.includes('Never run `apply_all.sh --yes`'), 'fix scripts stay unexecuted');
});

test('the approval gate is one composite action that delegates the decision to the engine', () => {
  const { parse } = require('yaml');
  const action = parse(readFileSync(join(ROOT, '.github/actions/approve/action.yml'), 'utf8'));
  assert.equal(action.runs.using, 'composite');
  assert.deepEqual(Object.keys(action.inputs).sort(), ['approval_body', 'pr_number', 'report_comment_id']);
  assert.equal(action.inputs.pr_number.required, true);
  assert.equal(action.inputs.report_comment_id.default, '');
  const checkout = action.runs.steps.find((s) => s.uses && s.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with.repository, 'CruGlobal/agent-review');
  assert.equal(checkout.with['persist-credentials'], false);
  const run = action.runs.steps.map((s) => s.run || '').join('\n');
  assert.ok(run.includes('agent-review.cjs" approval --report'), 'the action must delegate the decision to the engine');
  assert.ok(run.includes('select(.user.login == "github-actions[bot]")'), 'without a comment id only the bot report counts');
  assert.ok(run.includes('gh pr review "$PR" --repo "$REPO" --approve'), 'the action posts the approval');
  assert.ok(!run.includes('--request-changes'), 'the action never requests changes');
  assert.ok(run.includes('::warning::'), 'an approval API failure is a warning, never a red check');
  assert.ok(!run.includes("grep -q -- '- \\[ \\]'"), 'the checkbox fallback is gone; the engine decides');
  // A report judged by comment id was posted by a person: only repository
  // writers may trigger an approval, mirroring the interact permission check.
  assert.ok(run.includes('gh api "repos/$REPO/collaborators/$AUTHOR/permission" --jq .permission'), 'comment-id reports require the author to hold write permission');
  assert.ok(run.includes('admin|maintain|write'), 'permission must be admin, maintain, or write');
  // "Could not judge" is a warning, never a failed job: a transient API error
  // must not fail the interact publish job after the ledger is already posted.
  assert.ok(run.includes("trap '"), 'errors are trapped');
  assert.ok(run.includes('could not judge'), 'a trapped error is reported as could-not-judge');
});

test('interact.yml approves through the shared action, gated by auto_approve', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(INTERACT_WORKFLOW, 'utf8'));
  const step = doc.jobs.publish.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.ok(step, 'publish job must call the shared approve action');
  assert.equal(step.if, "inputs.auto_approve && steps.engine.outputs.name == 'agent-review'");
  assert.equal(step.with.pr_number, '${{ inputs.pr_number }}');
  assert.match(step.with.approval_body, /fixed or dismissed/);
  const body = readFileSync(INTERACT_WORKFLOW, 'utf8');
  assert.ok(!body.includes('gh pr review'), 'interact.yml must not carry its own approval shell');
});

test('review.yml approves only when the caller opts in and the review job succeeded', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(REVIEW_WORKFLOW, 'utf8'));
  const on = doc.on || doc[true];
  assert.equal(on.workflow_call.inputs.auto_approve.type, 'boolean');
  assert.equal(on.workflow_call.inputs.auto_approve.default, false);
  const job = doc.jobs.approve;
  assert.ok(job, 'review.yml must define an approve job');
  assert.equal(job.needs, 'review', 'a failed or skipped review must never reach the approver');
  assert.equal(job.if, "inputs.auto_approve && needs.review.outputs.engine == 'agent-review'");
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'write' }, 'the runtime checkout needs contents: read');
  const step = job.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.equal(step.with.pr_number, '${{ github.event.pull_request.number }}');
  assert.equal(step.with.report_comment_id, undefined, 'CI judges only the bot report');
  assert.ok(doc.jobs['report-failure'], 'report-failure job must survive');
});

test('approve.yml judges the posted comment, defaults auto_approve off, and re-checks the author', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(join(ROOT, '.github/workflows/approve.yml'), 'utf8'));
  const on = doc.on || doc[true];
  const inputs = on.workflow_call.inputs;
  assert.equal(inputs.pr_number.required, true);
  assert.equal(inputs.comment_id.required, true);
  assert.equal(inputs.auto_approve.type, 'boolean');
  assert.equal(inputs.auto_approve.default, false);
  const job = doc.jobs.approve;
  assert.ok(job.if.includes('inputs.auto_approve'));
  assert.ok(job.if.includes("github.event_name == 'issue_comment'"));
  assert.ok(job.if.includes('author_association'), 'the reusable side re-checks the poster, not only the caller');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'write' }, 'the runtime checkout needs contents: read');
  const step = job.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.equal(step.with.pr_number, '${{ inputs.pr_number }}');
  assert.equal(step.with.report_comment_id, '${{ inputs.comment_id }}');
  assert.ok(!readFileSync(join(ROOT, '.github/workflows/approve.yml'), 'utf8').includes('gh pr review'));
});

test('the approve template is on by default, fires on created or edited, is collaborator-gated, and the review caller shows the knob', () => {
  const template = readFileSync(join(ROOT, 'templates/workflows/agent-review-approve.yml'), 'utf8');
  assert.ok(template.includes('auto_approve: true'));
  // A local re-post edits the poster's own earlier comment, so edited must fire
  // too; the head rule keeps a stale report from approving a newer push.
  assert.ok(template.includes('types: [created, edited]'), 'local re-posts are edits of the poster\'s own comment');
  assert.ok(template.includes("startsWith(github.event.comment.body, '<!-- agent-review -->')"));
  assert.ok(template.includes('"OWNER","MEMBER","COLLABORATOR"'));
  assert.ok(template.includes('uses: CruGlobal/agent-review/.github/workflows/approve.yml@main'));
  assert.ok(template.includes('comment_id: ${{ github.event.comment.id }}'));
  assert.match(template, /permissions:\n      contents: read\n      pull-requests: write/);
  const review = readFileSync(join(ROOT, 'templates/workflows/agent-review.yml'), 'utf8');
  assert.ok(review.includes('auto_approve: true'), 'the review caller approves by default');
});

test('the docs and skills know the approve template and the review-side auto_approve knob', () => {
  const update = readFileSync(join(ROOT, 'skills/update-files/SKILL.md'), 'utf8');
  assert.ok(update.includes('agent-review-approve.yml'), 'update-files must fetch and offer the approve template');
  assert.ok(update.includes('review, interact, and approve'), 'auto_approve is carried over on every caller');
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  assert.ok(init.includes('../../templates/workflows/agent-review-approve.yml'));
  const review = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(review.includes('agent-review-approve.yml'), 'the post-to-GitHub handler must say a posted report can trigger approval');
  // The local post must create-or-update only a comment the poster authored:
  // editing the bot's CI report would put human text under the bot's login,
  // and the approve template would never see a created/edited event it trusts.
  const menu = review.slice(review.indexOf('### Post and print'));
  assert.ok(menu.includes('ME=$(gh api user --jq .login)'), 'local post resolves the posting user');
  assert.ok(menu.includes('select(.user.login == \\"$ME\\")'), 'local post updates only the poster\'s own report comment (gh has no --arg; interpolate)');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('agent-review-approve.yml'));
  assert.ok(readme.includes('stronger trust grant'), 'README must state the local-post trust boundary');
  assert.ok(readme.includes('repository write access'), 'README must say only writers can trigger the local-post approval');
});

test('the review skill runs the incremental path locally on the `incremental` argument', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('/agent-review:review auto incremental'), 'usage must show the local incremental form');
  assert.ok(
    skill.includes('  INCREMENTAL_REQUESTED: o.incremental ? "true" : "",'),
    'the argument is read from the resolved options, like `ci`, so any case works',
  );
  assert.ok(!skill.includes('*" incremental "*)'), 'the skill must not re-parse incremental from the raw arguments');
  assert.ok(skill.includes('if { [ -n "$CI_MODE" ] || [ -n "$INCREMENTAL_REQUESTED" ]; } && [ -n "$PR_NUMBER" ] && [ -n "$HEAD_REF" ]; then'), 'the incremental gate must accept the local request');
  assert.ok(!skill.includes('# Incremental re-review (CI only)'), 'the CI-only comment is stale');
  assert.ok(skill.includes('push first'), 'unpushed local commits must stop an incremental review');
  assert.ok(skill.includes('only committed changes are reviewed'), 'a dirty tree must warn');
  assert.ok(skill.includes("bot's comment remains the CI ledger"), 'must explain the bot-canonical case');
  // A zero-risk local delta advances the head marker instead of stopping silently.
  assert.ok(skill.includes('no reviewable risk in the delta'), 'local score-0 incremental must post the skip note');
});

test('the address skill takes fix/dismiss arguments and prompts once for missing dismissal reasons', () => {
  const skill = readFileSync(ADDRESS_SKILL, 'utf8');
  assert.ok(skill.includes('/agent-review:address fix 1,2,3,4 dismiss 5,6,7,8'), 'usage shows argument mode');
  assert.ok(skill.includes('/agent-review:address fix blockers'), 'usage shows the blockers shorthand');
  assert.ok(skill.includes('agent-review address parse --command /tmp/address_command.txt --lenient --ledger /tmp/address_ledger.json'), 'argument mode parses through the engine');
  assert.ok(skill.includes('exactly ONE prompt'), 'bare dismissals prompt once per batch');
  assert.ok(skill.includes('reasonCode: null'), 'the null-reason contract is named');
  assert.ok(skill.includes('Fixes are applied, committed, and pushed before the dismissal prompt'), 'fixes never wait on the prompt');
  assert.ok(skill.includes('never dismisses on its own judgment'), 'the rule survives argument mode');
});

test('re-review and yolo-review are thin drivers over the review and address skills', () => {
  const re = readFileSync(join(ROOT, 'skills/re-review/SKILL.md'), 'utf8');
  assert.match(re, /^name: re-review$/m);
  assert.ok(re.includes('`agent-review:review` with the arguments `auto incremental`'));
  assert.ok(re.split('\n').length < 40, 're-review must stay thin');
  const yolo = readFileSync(join(ROOT, 'skills/yolo-review/SKILL.md'), 'utf8');
  assert.match(yolo, /^name: yolo-review$/m);
  assert.ok(yolo.includes('`agent-review:address` with the argument `fix blockers`'));
  assert.ok(yolo.includes('`agent-review:review` with the arguments `auto incremental`'));
  assert.ok(yolo.includes('Never dismiss'), 'yolo must not dismiss');
  assert.ok(yolo.includes('at most two more times'), 'the loop is bounded');
  assert.ok(yolo.includes('gh pr view "$PR_NUMBER" --json reviews'), 'approval is observed, not performed');
  assert.ok(yolo.includes('.author.login == \\"github-actions\\" or .author.login == \\"github-actions[bot]\\"'), 'GraphQL reports the bot as github-actions');
  assert.ok(yolo.includes('cannot approve'), 'must say the session cannot approve');
  assert.ok(yolo.includes('git status --porcelain'), 'clean tree precondition');
  assert.ok(!yolo.includes('apply_all.sh --yes'));
});

// Each invocation of `name` in a bash block, with backslash continuations joined onto one line.
function commandsIn(bash, name) {
  const lines = bash.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith(`${name} `)) continue;
    let cmd = lines[i].trim();
    while (cmd.endsWith('\\') && i + 1 < lines.length) cmd = `${cmd.slice(0, -1).trim()} ${lines[++i].trim()}`;
    found.push(cmd);
  }
  return found;
}

test('Initialize reads the options file once and evals quoted assignments', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const init = bashBlocks(stageSlice(skill, '### Initialize', '### Gather PR Context & Diff Manifest'));
  assert.equal(init.split('require("/tmp/review_options.json")').length - 1, 1, 'one node -e reads the options file');
  const start = init.indexOf('OPTION_VARS=$(node -e \'');
  const end = init.indexOf('eval "$OPTION_VARS"');
  assert.ok(start >= 0 && end > start, 'the assignments are captured first, so set -e still stops on a failed read');
  const read = init.slice(start, end);
  for (const line of [
    '  CI_MODE: o.ci ? "true" : "",',
    '  MODE: o.mode.value,',
    '  ENGINE: o.engine.value,',
    '  EFFORT: o.effort ? o.effort.value : "",',
    '  REVIEWS_RUN: o.reviewsRun.value,',
    '  INCREMENTAL_REQUESTED: o.incremental ? "true" : "",',
  ]) {
    assert.ok(read.includes(line), `the one read sets ${line.trim()}`);
  }
  assert.ok(
    read.includes('console.log(name + "=" + JSON.stringify(String(value)).replace(/[$`]/g, "\\\\$&"));'),
    'each value is double-quoted with $ and backtick escaped',
  );
  assert.ok(!/\b(CI_MODE|MODE|ENGINE|EFFORT|REVIEWS_RUN|INCREMENTAL_REQUESTED)=\$\(node -e/.test(init), 'no per-field node -e reads remain');
  const script = read.slice(read.indexOf("node -e '") + 9, read.lastIndexOf("'"));
  assert.ok(!script.includes("'"), 'the single-quoted script holds no quote of its own');

  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'review-options-'));
  const file = join(dir, 'review_options.json');
  writeFileSync(file, JSON.stringify({
    ci: false,
    mode: { value: 'auto' },
    engine: { value: 'code-review' },
    effort: { value: 'x$(touch pwned)`id`"\\' },
    reviewsRun: { value: 'local' },
    incremental: true,
  }));
  const run = (path) =>
    execFileSync(
      'bash',
      ['-c', 'set -e; OPTION_VARS=$(node -e "$1"); eval "$OPTION_VARS"; printf "%s|" "$CI_MODE" "$MODE" "$ENGINE" "$EFFORT" "$REVIEWS_RUN" "$INCREMENTAL_REQUESTED"', 'bash', script.split('/tmp/review_options.json').join(path)],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  assert.equal(run(file), '|auto|code-review|x$(touch pwned)`id`"\\|local|true|', 'values round-trip without running anything');
  assert.throws(() => run(join(dir, 'missing.json')), 'a failed read stops the shell');
});

test('review skill wires the code-review engine', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const bash = bashBlocks(skill);

  const init = stageSlice(skill, '### Initialize', '### Gather PR Context & Diff Manifest');
  assert.ok(
    bashBlocks(init).includes('agent-review options --args-file /tmp/review_args.txt ${CI_MODE:+--ci} > /tmp/review_options.json'),
    'Initialize resolves options from the raw arguments, forcing the default engine in CI',
  );
  const ciDetect = init.indexOf('CI_MODE="true"');
  const optionsCall = init.indexOf('agent-review options --args-file');
  assert.notStrictEqual(ciDetect, -1, 'Initialize must detect CI');
  assert.notStrictEqual(optionsCall, -1, 'Initialize must resolve options');
  assert.ok(ciDetect < optionsCall, 'CI is detected before options are resolved, so --ci reaches the resolver');
  assert.ok(init.includes('[ -n "${AGENT_REVIEW_CI:-}" ] && CI_MODE="true"'), 'the workflow signal still forces CI');
  assert.ok(!init.includes('*" ci "*)'), 'the skill must not re-parse ci from the raw arguments');
  const ciRead = init.indexOf('  CI_MODE: o.ci ? "true" : "",');
  assert.ok(ciRead > optionsCall, 'CI mode is read back from the resolved options, which lowercase the ci argument');
  assert.match(
    bashBlocks(init),
    /^export ENGINE="\$ENGINE" EFFORT="\$EFFORT" REVIEWS_RUN="\$REVIEWS_RUN"$/m,
    'ENGINE, EFFORT, and REVIEWS_RUN are persisted to review_env.sh for later stages',
  );
  for (const banner of [
    '[ "$ENGINE" = "code-review" ] || echo "• 3 agents (testing, standards + the first triggered agent)"',
    '[ "$ENGINE" = "code-review" ] || echo "• Every enabled agent in config.yml"',
  ]) {
    assert.ok(bashBlocks(init).includes(banner), `mode banner must be skipped under code-review: ${banner}`);
  }

  const plans = commandsIn(bash, 'agent-review plan');
  assert.strictEqual(plans.length, 2, 'expected the review plan and the gate plan');
  for (const cmd of plans) {
    assert.ok(cmd.includes('--options /tmp/review_options.json'), `plan call lacks the options file: ${cmd}`);
    assert.ok(cmd.includes('--mode "$MODE"'), `plan call must take mode from MODE, not the options file: ${cmd}`);
  }

  const buildPlan = stageSlice(skill, '### Build the Review Plan & Load Evidence', '## CI Mode');
  assert.strictEqual(commandsIn(bashBlocks(buildPlan), 'agent-review startup').length, 0, 'the plan block no longer prints the start-up line');
  assert.ok(bashBlocks(buildPlan).includes('agent-review slice'), 'the plan block must slice the diff');
  const startup = commandsIn(bash, 'agent-review startup');
  assert.strictEqual(startup.length, 1, 'the skill prints the start-up line once');
  for (const part of [
    '--options /tmp/review_options.json',
    '--plan /tmp/review_plan.json',
    '--slices /tmp/slice_manifest.json',
    '--scope "$STARTUP_SCOPE"',
    '--mode "$MODE"',
  ]) {
    assert.ok(startup[0].includes(part), `startup call lacks ${part}`);
  }
  const autoOnly = stageSlice(skill, '### Auto Mode Resolution', '### Start-up Line');
  assert.ok(!autoOnly.includes('agent-review startup'), 'the auto-only section does not print the start-up line');
  const startupSection = stageSlice(skill, '### Start-up Line', '### Risk Assessment');
  assert.strictEqual(countBashFences(startupSection), 1, 'the start-up line is its own bash turn');
  const startupBash = bashBlocks(startupSection);
  assert.ok(startupBash.startsWith('. /tmp/review_env.sh 2>/dev/null || true'), 'it reads the final MODE from review_env.sh');
  assert.ok(!startupBash.includes('if [ "$MODE" = "auto" ]'), 'it runs in every mode');
  assert.ok(startupBash.includes('agent-review startup'));
  const flatStartup = startupSection.replace(/\s+/g, ' ');
  assert.ok(
    flatStartup.includes('**Every mode, not only `auto`.** Run this right after Auto Mode Resolution, before acting on a skip.'),
    flatStartup,
  );
  assert.ok(flatStartup.includes('On a real skip the `reviewers:` line reads `none (no-risk diff skipped)`.'));
  assert.ok(
    flatStartup.indexOf('agent-review startup') < flatStartup.indexOf('If auto resolved to `skip`:'),
    'a skip still prints the start-up line before it stops',
  );
  assert.ok(
    autoOnly.replace(/\s+/g, ' ').includes('The start-up line comes next, in every mode; act on the result only after it prints.'),
  );

  const stage0 = engineSection('Stage 0').replace(/\s+/g, ' ');
  assert.match(
    stage0,
    /Under the `code-review` engine, with `ENGINE` read from `\/tmp\/review_env.sh`, the launch list is the plan's `agents\[\]`, exactly, in every mode/,
    'under code-review the launch list is the plan, in every mode',
  );
  const stage0b = stageSlice(skill, '## Stage 0B — Agent Selection', '### Smoke-Test Tier Routing').replace(/\s+/g, ' ');
  assert.ok(
    stage0b.includes('The bullets below apply only when `ENGINE` is `agent-review`.'),
    'the standard, quick, and deep bullets stay gated on the default engine',
  );

  assert.ok(stage0.includes('agent-review:reviewer-code-review'), 'the smoke test must confirm the code-review agent type resolves');

  const stage1 = engineSection('Stage 1: the code-review lane');
  assert.ok(stage1.includes('templates/code-review-lane.md'), 'the code-review lane fills its own template');
  assert.ok(stage1.includes('`"agent-review:reviewer-code-review"`'), 'the code-review lane launches on its own agent type');
  for (const name of CODE_REVIEW_LANE_PLACEHOLDERS) {
    assert.ok(stage1.includes(`\`{{${name}}}\``), `Stage 1 must say how to fill {{${name}}} for the code-review lane`);
  }

  const stage2 = engineSection('Stage 2: checking the code-review lane');
  assert.ok(
    bashBlocks(stage2).includes(STAGE2_PROOF_COMMAND),
    'Stage 2 proves /code-review ran and that every raw finding was scored or dropped',
  );
  assert.ok(stage2.includes('`reason`'), 'a second proof failure prints the proof reason');
  assert.ok(
    stage2.replace(/\s+/g, ' ').includes('Under the `code-review` engine, the `code-review` lane must also prove `/code-review` ran'),
    'a default-engine repo\'s own code-review lane is an ordinary lane',
  );

  const stage3 = stageSlice(skill, '## Stage 3 — Cross-Examination Debate', '### Debate Prompt Template');
  assert.match(stage3, /ENGINE[^\n]*code-review/, 'debate is skipped under the code-review engine');
});

test('drivers pass engine tokens through', () => {
  for (const name of ['re-review', 'yolo-review']) {
    const text = readFileSync(join(ROOT, `skills/${name}/SKILL.md`), 'utf8');
    assert.ok(text.includes('engine='), `skills/${name}/SKILL.md must pass engine= through`);
    assert.ok(text.includes('effort='), `skills/${name}/SKILL.md must pass effort= through`);
  }
});

test('templates ship advisory and approving by default, label gate kept, config agrees', () => {
  const review = readFileSync(join(ROOT, 'templates/workflows/agent-review.yml'), 'utf8');
  assert.ok(review.includes('rollout_mode: advisory'));
  assert.ok(!review.includes('rollout_mode: shadow'));
  assert.ok(review.includes("contains(github.event.pull_request.labels.*.name, 'agent-review')"), 'label gate stays');
  const interact = readFileSync(join(ROOT, 'templates/workflows/agent-review-interact.yml'), 'utf8');
  assert.ok(interact.includes('auto_approve: true'));
  const config = readFileSync(join(ROOT, 'templates/config.yml'), 'utf8');
  assert.match(config, /^rollout:\n  mode: advisory$/m, 'the trusted-policy step refuses a caller that disagrees with config');
  const reusable = readFileSync(join(ROOT, '.github/workflows/interact.yml'), 'utf8');
  assert.ok(!reusable.includes('Disabled during shadow/advisory rollout'), 'stale description: advisory approves');
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  assert.ok(init.includes('`rollout` — `advisory`'), 'init generates advisory');
  const update = readFileSync(join(ROOT, 'skills/update-files/SKILL.md'), 'utf8');
  assert.ok(update.includes('rollout.mode'), 'update-files must warn when config still says shadow');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('## The flow'));
  assert.ok(readme.includes('/agent-review:yolo-review'));
  assert.ok(readme.includes('approves by default'), 'README states the default up front');
});

test('fix pass: no gh --jq --arg anywhere, local canonical comment is the user\'s own, rollout from config, no silent overwrite', () => {
  const { readdirSync } = require('node:fs');
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const body = readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8');
    assert.ok(!body.includes('--jq --arg'), `${dir}: gh's --jq takes one expression; --arg does not exist (gh 2.78)`);
  }
  const review = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const stage7 = review.slice(review.indexOf('## Stage 7 — Post, Print & Metrics'), review.indexOf('## Stage 8'));
  assert.ok(stage7.includes('agent-review config get rollout.mode'), 'a local post takes the rollout marker from config, so shadow-in-config disables approval');
  assert.ok(stage7.includes(': > /tmp/agent_review_post_result.txt'), 'the post result is truncated before posting');
  assert.ok(stage7.includes('❌ post failed'), 'a failed post is reported, never last run\'s success line');
  assert.ok(review.includes('if [ -n "$PR_NUMBER" ] && { [ -n "$INCREMENTAL" ] || [ -z "$CI_MODE" ]; }; then'), 'a plain local review merges the previous ledger instead of resetting it');
  // Local canonical comment: the current user's own marked comment when one exists, else the oldest.
  const ownFirst = '(map(select(.user.login == \\"$ME\\")) | first) // first';
  assert.ok(review.includes(ownFirst), 'review reads the previous ledger own-first locally');
  const address = readFileSync(ADDRESS_SKILL, 'utf8');
  assert.ok(address.includes(ownFirst), 'address works the user\'s own comment when one exists');
  assert.ok(address.includes('In argument mode, push without confirming'), 'argument mode and yolo never stop at the push confirmation');
  const yolo = readFileSync(join(ROOT, 'skills/yolo-review/SKILL.md'), 'utf8');
  assert.ok(yolo.includes(ownFirst), 'yolo reads the same canonical comment address writes');
});

test('posted review comments keep every marker on one line under zsh and bash, so the approver can read them', (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { evaluateApproval } = require('./approval.cjs');
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const assemblies = [...skill.matchAll(/^ {2}\{ printf[\s\S]*?^ {2}\} > \/tmp\/agent_review_comment\.md$/gm)].map((m) => m[0]);
  const selfChecks = [...skill.matchAll(/^ {2}node -e '\nconst fs[\s\S]*?^' \|\|/gm)].map((m) => m[0].slice(0, -3));
  assert.strictEqual(assemblies.length, 2, 'both comment-assembly blocks must write markers with printf');
  assert.strictEqual(selfChecks.length, 2, 'both comment-assembly blocks must be followed by the marker self-check');

  const head = 'a'.repeat(40);
  // A finding whose evidence holds a line break: zsh's echo turned its \n escape into a real one.
  const ledger = [{ n: 1, id: 'f1', evidence: 'L586: a = {...}\nL587: b = {...}', status: 'open' }];
  const status = { v: 1, head, risk: 'LOW', openBlockers: 0, pass: true, irreversible: false, irreversibleReasons: [] };
  const shells = ['bash', 'zsh'].filter((sh) => {
    try { execFileSync(sh, ['-c', 'true']); return true; } catch { return false; }
  });
  if (!shells.includes('zsh')) t.diagnostic('zsh not installed; only bash was exercised');

  for (const shell of shells) {
    for (const [i, block] of assemblies.entries()) {
      const dir = mkdtempSync(join(tmpdir(), 'agent-review-markers-'));
      try {
        writeFileSync(join(dir, 'agent_review_ledger.json'), JSON.stringify(ledger));
        writeFileSync(join(dir, 'agent_review_status.json'), JSON.stringify(status));
        writeFileSync(join(dir, 'agent_review_report.md'), 'report body\n');
        const script = `${block}\n${selfChecks[i]}`.replaceAll('/tmp/', `${dir}/`);
        execFileSync(shell, ['-c', script], { env: { ...process.env, HEAD_REF: head, AGENT_REVIEW_ROLLOUT_MODE: 'advisory' } });
        const comment = readFileSync(join(dir, 'agent_review_comment.md'), 'utf8');
        assert.deepStrictEqual(evaluateApproval(comment, { head }).approve, true, `${shell}, block ${i + 1}: ${evaluateApproval(comment, { head }).reason}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('the marker self-check fails when a split marker line hides the status from the approver', () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const selfCheck = skill.match(/^ {2}node -e '\nconst fs[\s\S]*?^'/m)[0];
  const dir = mkdtempSync(join(tmpdir(), 'agent-review-selfcheck-'));
  try {
    writeFileSync(join(dir, 'agent_review_ledger.json'), '[]');
    writeFileSync(join(dir, 'agent_review_status.json'), '{"pass":true}');
    writeFileSync(join(dir, 'agent_review_comment.md'), [
      '<!-- agent-review -->',
      '<!-- agent-review-ledger: [{"evidence":"first half',
      'second half"}] -->',
      '<!-- agent-review-status: {"pass":true} -->',
      '',
    ].join('\n'));
    assert.throws(() => execFileSync('bash', ['-c', selfCheck.replaceAll('/tmp/', `${dir}/`)], { stdio: 'pipe' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report skeleton covers the code-review engine', () => {
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const block = report.slice(report.indexOf('[IF engine is code-review'));
  assert.ok(report.includes('[IF engine is code-review]'));
  assert.ok(/effort/.test(block) && /model/.test(block) && /source/.test(block));
  assert.ok(
    report.includes('**Engine**: code-review (from [engine source]) · effort [requested effort] (from [effort source]) · model [model] (from [model source])'),
    'the engine line names where the engine setting came from',
  );
  const stage6Engine = engineSection('Stage 6: the engine block');
  assert.ok(stage6Engine.includes('`engine.source`'), 'Stage 6 fills the engine source from options.engine.source');
  assert.ok(report.includes('found [N] · scored [M] · dropped [K]'));
  assert.ok(report.includes('[FOR EACH dropped finding]'));
  assert.ok(report.includes('[IF any options notes]'));
  const localStart = report.indexOf('[IF reviews_run is local]');
  const elseStart = report.indexOf('[ELSE', localStart);
  const endIf = report.indexOf('[END IF reviews_run is local]');
  assert.ok(localStart > 0 && elseStart > localStart && endIf > elseStart, 'footer variants need an end marker');
  const localText = report.slice(localStart, elseStart);
  assert.ok(localText.includes('/agent-review:address'));
  assert.ok(!localText.includes('@claude'), 'local footer must omit @claude');
  assert.ok(report.slice(elseStart, endIf).includes('@claude fix'));
  assert.ok(report.indexOf('[IF UNRESOLVED DEBATES') > endIf, 'the debate note must sit outside both variants');
  const engStart = report.indexOf('[IF engine is code-review]');
  const engEnd = report.indexOf('[END IF engine is code-review]');
  const notes = report.indexOf('[IF any options notes');
  assert.ok(engEnd > engStart && notes > engEnd, 'the notes directive must sit outside the engine block');
  assert.ok(/under any engine/.test(report.slice(notes, notes + 200)));
  for (const f of ['/tmp/review_options.json', '/tmp/code_review_proof.json', '/tmp/agent_findings/code-review.json', 'reviews_run']) {
    assert.ok(
      (skill.slice(skill.indexOf('### Write the report')) + stage6Engine).includes(f),
      `Stage 6 must name ${f}`,
    );
  }
  assert.ok(stage6Engine.includes('Code Review (/code-review <effort>)'));
  assert.ok(!/omit both of those blocks/.test(skill), 'notes must not be tied to the engine block');
  assert.ok(/follows the\s+`notes` field alone, under any engine/.test(skill), 'notes block follows `notes` alone');
});

// Both engine steps must report `unknown` when the base commit cannot be read, so
// the exact-match approve gates never approve on a config they did not see.
const READ_ENGINE_ACTION = join(ROOT, '.github/actions/read-engine/action.yml');
const READ_ENGINE_USES = 'CruGlobal/agent-review/.github/actions/read-engine@main';

function readEngineRun() {
  const { parse } = require('yaml');
  const action = parse(readFileSync(READ_ENGINE_ACTION, 'utf8'));
  return { action, step: action.runs.steps[0] };
}

test('the engine read is one composite action', () => {
  const { action, step } = readEngineRun();
  assert.equal(action.runs.using, 'composite');
  assert.deepEqual(Object.keys(action.inputs).sort(), ['base_sha', 'extracted_review_dir', 'runtime_dir', 'trusted_dir']);
  for (const [name, input] of Object.entries(action.inputs)) assert.equal(input.required, name !== 'extracted_review_dir', name);
  assert.deepEqual(Object.keys(action.outputs), ['name']);
  assert.equal(action.outputs.name.value, '${{ steps.read.outputs.name }}');
  assert.equal(action.runs.steps.length, 1);
  assert.equal(step.id, 'read');
  assert.equal(step.shell, 'bash');
  assert.deepEqual(step.env, {
    BASE_SHA: '${{ inputs.base_sha }}',
    RUNTIME_DIR: '${{ inputs.runtime_dir }}',
    TRUSTED_DIR: '${{ inputs.trusted_dir }}',
    EXTRACTED_REVIEW_DIR: '${{ inputs.extracted_review_dir }}',
  });
  assert.ok(!step.run.includes('${{'), 'the run block must not contain expressions');
  const run = step.run;
  const unknown = run.indexOf('ENGINE=unknown');
  const guard = run.indexOf('if [ -n "$BASE_SHA" ] && git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null; then');
  assert.ok(unknown >= 0 && guard > unknown, 'the engine starts as unknown, then the base commit is checked');
  assert.ok(run.indexOf('ENGINE=agent-review') > guard, 'agent-review is set only once the base commit exists');
  assert.ok(run.includes('config get engine.name) || CONFIGURED=unknown'), 'a failed read is unknown and never fails the job');
  assert.ok(run.includes('if [ "$CONFIGURED" = "undefined" ]; then ENGINE=agent-review; else ENGINE=$CONFIGURED; fi'));
  assert.ok(run.trimEnd().endsWith('echo "name=$ENGINE" >> "$GITHUB_OUTPUT"'), 'the output is written last');
});

test('the engine read action outputs agent-review, the configured engine, or unknown, and never fails', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const os = require('node:os');
  const { step } = readEngineRun();
  const repo = mkdtempSync(join(os.tmpdir(), 'ar-read-engine-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = (message) => {
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const config = (extra = '') => [
    'version: 2', 'profile: standard',
    'risk:', '  patterns: []',
    '  volume_multiplier: [{ upTo: null, points: 0 }]',
    '  scope_multiplier: { single_feature: 1.0 }',
    '  special: []',
    '  levels: [{ range: [0, null], level: LOW, reviewer: entry }]',
    'agents:', '  - id: standards', '    always: true',
    'excluded_paths: []', extra,
  ].join('\n');
  try {
    git('init', '-q');
    const bare = commit('no config');
    mkdirSync(join(repo, '.claude/review'), { recursive: true });
    writeFileSync(join(repo, '.claude/review/config.yml'), config());
    const unset = commit('config without engine');
    writeFileSync(join(repo, '.claude/review/config.yml'), config('engine:\n  name: code-review\n'));
    const codeReview = commit('code-review engine with missing always lanes');
    writeFileSync(join(repo, '.claude/review/config.yml'), config('engine:\n  name: agent-review\n'));
    const named = commit('explicit agent-review');
    writeFileSync(join(repo, '.claude/review/config.yml'), 'version: [');
    const broken = commit('broken config');

    const read = (baseSha) => {
      const trusted = mkdtempSync(join(os.tmpdir(), 'ar-read-engine-trusted-'));
      const output = join(trusted, 'output.txt');
      writeFileSync(output, '');
      try {
        execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
          cwd: repo,
          env: {
            ...process.env,
            BASE_SHA: baseSha,
            RUNTIME_DIR: ROOT,
            TRUSTED_DIR: join(trusted, 'base'),
            GITHUB_WORKSPACE: repo,
            GITHUB_OUTPUT: output,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return readFileSync(output, 'utf8');
      } finally {
        rmSync(trusted, { recursive: true, force: true });
      }
    };
    assert.equal(read(bare), 'name=agent-review\n', 'no config at the base');
    assert.equal(read(unset), 'name=agent-review\n', 'a config with no engine');
    assert.equal(read(named), 'name=agent-review\n');
    assert.equal(read(codeReview), 'name=code-review\n', 'a code-review config that config validate would reject still reads');
    assert.equal(read(broken), 'name=unknown\n', 'an unreadable config is unknown, and the step still succeeds');
    assert.equal(read(''), 'name=unknown\n', 'no base SHA');
    assert.equal(read('0123456789abcdef0123456789abcdef01234567'), 'name=unknown\n', 'a base commit the checkout lacks');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('review.yml reads the engine through the shared action and approves only on an exact agent-review', () => {
  const { parse } = require('yaml');
  const wf = parse(readFileSync(REVIEW_WORKFLOW, 'utf8'));
  assert.equal(wf.jobs.review.outputs.engine, '${{ steps.engine.outputs.name }}');
  assert.equal(wf.jobs.approve.if, "inputs.auto_approve && needs.review.outputs.engine == 'agent-review'");
  const step = wf.jobs.review.steps.find((s) => s.id === 'engine');
  assert.ok(step, 'review job needs a step with id engine');
  assert.equal(step.uses, READ_ENGINE_USES);
  assert.equal(step.run, undefined, 'the engine shell lives in the action');
  assert.deepEqual(step.with, {
    base_sha: '${{ github.event.pull_request.base.sha }}',
    runtime_dir: '${{ runner.temp }}/agent-review-runtime',
    trusted_dir: '${{ runner.temp }}/agent-review-engine-trusted',
    extracted_review_dir: '${{ runner.temp }}/agent-review-trusted/.claude/review',
  });
  const steps = wf.jobs.review.steps;
  const isolate = steps.findIndex((s) => s.name === 'Isolate trusted base configuration and runtime');
  assert.ok(isolate >= 0 && isolate < steps.indexOf(step), 'the runtime is in place before the engine read');
});

test('review.yml runs read-engine only under inputs.auto_approve and passes extracted_review_dir', () => {
  const { parse } = require('yaml');
  const wf = parse(readFileSync(REVIEW_WORKFLOW, 'utf8'));
  const steps = wf.jobs.review.steps;
  const step = steps.find((s) => s.id === 'engine');
  assert.equal(step.if, 'inputs.auto_approve');
  assert.equal(step.with.extracted_review_dir, '${{ runner.temp }}/agent-review-trusted/.claude/review');
  const isolate = steps.find((s) => s.name === 'Isolate trusted base configuration and runtime');
  assert.equal(isolate.env.TRUSTED_DIR, '${{ runner.temp }}/agent-review-trusted');
  assert.ok(isolate.run.includes('git archive "$BASE_SHA" .claude/review | tar -x -C "$TRUSTED_DIR"'));
});

test('read-engine reads extracted_review_dir without git archive', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const os = require('node:os');
  const { step } = readEngineRun();
  const repo = mkdtempSync(join(os.tmpdir(), 'ar-read-engine-x-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const config = (extra) => [
    'version: 2', 'profile: standard',
    'risk:', '  patterns: []',
    '  volume_multiplier: [{ upTo: null, points: 0 }]',
    '  scope_multiplier: { single_feature: 1.0 }',
    '  special: []',
    '  levels: [{ range: [0, null], level: LOW, reviewer: entry }]',
    'agents:', '  - id: standards', '    always: true',
    'excluded_paths: []', extra,
  ].join('\n');
  const read = (baseSha, extracted) => {
    const scratch = mkdtempSync(join(os.tmpdir(), 'ar-read-engine-x-out-'));
    const output = join(scratch, 'output.txt');
    writeFileSync(output, '');
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        cwd: repo,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          RUNTIME_DIR: ROOT,
          TRUSTED_DIR: join(scratch, 'base'),
          EXTRACTED_REVIEW_DIR: extracted,
          GITHUB_WORKSPACE: repo,
          GITHUB_OUTPUT: output,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out: readFileSync(output, 'utf8'), archived: require('node:fs').existsSync(join(scratch, 'base')) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  try {
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'bare');
    const bare = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, '.claude/review'), { recursive: true });
    writeFileSync(join(repo, '.claude/review/config.yml'), config(''));
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'with config');
    const withConfig = git('rev-parse', 'HEAD');

    // The extracted tree says code-review while the base commit's own config says nothing, so
    // the value can only have come from the extracted directory.
    const extracted = mkdtempSync(join(os.tmpdir(), 'ar-extracted-'));
    writeFileSync(join(extracted, 'config.yml'), config('engine:\n  name: code-review\n'));
    const unset = mkdtempSync(join(os.tmpdir(), 'ar-extracted-'));
    writeFileSync(join(unset, 'config.yml'), config(''));
    const broken = mkdtempSync(join(os.tmpdir(), 'ar-extracted-'));
    writeFileSync(join(broken, 'config.yml'), 'version: [');
    try {
      const fromDir = read(withConfig, extracted);
      assert.equal(fromDir.out, 'name=code-review\n');
      assert.equal(fromDir.archived, false, 'no second git archive');
      assert.equal(read(withConfig, unset).out, 'name=agent-review\n', 'an extracted config with no engine');
      assert.equal(read(withConfig, broken).out, 'name=unknown\n', 'an unreadable extracted config');
      assert.equal(read(bare, extracted).out, 'name=agent-review\n', 'a base commit with no config is agent-review');
      assert.equal(read('', extracted).out, 'name=unknown\n', 'the base commit is still required');
      assert.equal(read('0123456789abcdef0123456789abcdef01234567', extracted).out, 'name=unknown\n');
    } finally {
      for (const d of [extracted, unset, broken]) rmSync(d, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('interact.yml reads the engine through the shared action and approves only on an exact agent-review', () => {
  const { parse } = require('yaml');
  const wf = parse(readFileSync(INTERACT_WORKFLOW, 'utf8'));
  const steps = wf.jobs.publish.steps;
  const engineIndex = steps.findIndex((s) => s.id === 'engine');
  const approveIndex = steps.findIndex((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.ok(engineIndex >= 0, 'publish job needs its own step with id engine');
  assert.ok(engineIndex < approveIndex, 'the engine is read before the approve step');
  const step = steps[engineIndex];
  assert.equal(step.uses, READ_ENGINE_USES);
  assert.equal(step.run, undefined, 'the engine shell lives in the action');
  assert.equal(step.if, 'inputs.auto_approve');
  assert.ok(!String(step.if || '').includes('is_fork'), 'the engine read must run for forks too');
  assert.deepEqual(step.with, {
    base_sha: '${{ needs.model.outputs.base_sha }}',
    runtime_dir: '${{ runner.temp }}/agent-review-runtime',
    trusted_dir: '${{ runner.temp }}/agent-review-engine-trusted',
  });
  const checkout = steps.findIndex((s) => s.name === 'Check out a credential-free PR validation tree');
  assert.ok(checkout >= 0 && checkout < engineIndex, 'the base commit is fetched before the engine read');
  assert.equal(steps[approveIndex].if, "inputs.auto_approve && steps.engine.outputs.name == 'agent-review'");
});

test('no workflow carries its own engine-read shell', () => {
  for (const path of [REVIEW_WORKFLOW, INTERACT_WORKFLOW]) {
    const body = readFileSync(path, 'utf8');
    assert.ok(!body.includes('config get engine.name'), `${path} must read the engine through the action`);
  }
});

test('init asks engine, where reviews run, and approval', () => {
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  for (const needle of ['engine:', 'reviews_run:', 'local-and-ci', 'auto_approve',
    'Review engine', 'Where reviews run', 'Should the bot approve PRs in this repo?']) {
    assert.ok(init.includes(needle), `init must mention ${needle}`);
  }
});

test('init writes engine and reviews_run only for a non-default answer', () => {
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  const flat = init.replace(/\s+/g, ' ');
  assert.ok(
    flat.includes('Write them only for a non-default answer: the `engine:` block only for the code-review engine, and `reviews_run: local` only for local only.'),
    '3A writes the new keys only when they differ from the default',
  );
  assert.ok(flat.includes('a teammate on plugin 1.0.0 can still load a config that leaves them out'), '3A says why');
  assert.ok(flat.includes('`agent-review`: write no `engine:` block'), 'the default engine writes nothing');
  assert.ok(flat.includes('Write no `reviews_run:` key; `local-and-ci` is the default.'), 'local-and-ci writes nothing');
  assert.ok(!flat.includes('write `engine.name: agent-review`'), 'the old default write is gone');

  const blocks = [...init.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const guarded = blocks.filter((block) => block.includes('if [ "$REVIEWS_RUN" = "local-and-ci" ]; then'));
  assert.equal(guarded.length, 2, 'the 3C copy block and the 3E git add block');
  for (const block of guarded) {
    // The answer is saved in 3A, so the block sources it and never reads config back.
    assert.ok(block.includes('. /tmp/agent_review_init.sh'), `the guard block sources the saved answer:\n${block}`);
    assert.ok(block.indexOf('. /tmp/agent_review_init.sh') < block.indexOf('if [ "$REVIEWS_RUN"'), 'the source comes before the guard');
  }
  assert.ok(
    flat.includes('The copies run only when the `REVIEWS_RUN` answer saved in 3A is `local-and-ci`; anything else, including an empty value, copies nothing.'),
  );

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(
    readme.includes('Repos that use the code-review engine or `reviews_run: local` need everyone on plugin 1.1.0 or later.'),
    'README names the version floor',
  );
});

test('init never copies or stages the CI workflows outside a local-and-ci guard', () => {
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  const blocks = [...init.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const guard = 'if [ "$REVIEWS_RUN" = "local-and-ci" ]; then';
  let seen = 0;
  for (const block of blocks) {
    const stripped = block.replace(/agent-review-approve\.yml/g, '');
    if (!/\b(cp|git add)\b[^\n]*(\n\s+[^\n]*)*agent-review(-interact|-readiness)?\.yml/.test(stripped)) continue;
    seen += 1;
    assert.ok(block.includes(guard), `CI workflow copy/add must sit in a local-and-ci guard:\n${block}`);
    const before = block.slice(0, block.indexOf(guard));
    assert.ok(!/agent-review(-interact|-readiness)?\.yml/.test(before.replace(/agent-review-approve\.yml/g, '')),
      'no CI workflow may be copied or staged before the guard');
  }
  assert.ok(seen >= 2, 'expected the 3C copy block and the 3E git add block');
  for (const block of blocks) {
    assert.ok(!/^\s*REVIEWS_RUN=local-and-ci\b/m.test(block), 'REVIEWS_RUN must never be hardcoded to local-and-ci');
    if (block.includes(guard)) {
      assert.ok(block.includes('. /tmp/agent_review_init.sh'), 'REVIEWS_RUN must come from the env file saved in 3A');
      assert.ok(!block.includes('config get reviews_run'), 'REVIEWS_RUN must not be read back from a config that may not load yet');
    }
  }
});

test('update-files handles local-only repos', () => {
  const skill = readFileSync(join(ROOT, 'skills/update-files/SKILL.md'), 'utf8');
  for (const needle of ['agent-review config get reviews_run', 'required_status_checks', 'rules/branches',
    'local-only', 'protection/required_status_checks']) {
    assert.ok(skill.includes(needle), `update-files must mention ${needle}`);
  }
  assert.ok(skill.includes('git diff HEAD'), 'update-files must diff against HEAD so staged removals show');
});

test('README says plainly how suppress learnings behave under the code-review engine', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(!readme.includes('match less often'), 'the soft "match less often" wording understates it');
  const start = readme.indexOf('**"Suppress" learnings');
  assert.notStrictEqual(start, -1, 'the README keeps a suppress-learnings limitation bullet');
  const bullet = readme.slice(start, readme.indexOf('\n- **', start)).replace(/\s+/g, ' ');
  assert.ok(bullet.includes('reviewer'), 'a suppress rule is tied to the reviewer that raised it');
  assert.ok(bullet.includes('category'), 'a suppress rule is tied to the category');
  assert.ok(/`architecture` or `simplification`[^.]*never match a `code-review` finding/.test(bullet),
    'learnings from the replaced reviewers never match');
  assert.ok(/rarely match/.test(bullet), 'reworded code-review findings rarely match each other');
  assert.ok(!bullet.includes('—'), 'new prose uses no em dashes');
});

test('README and spec describe CI findings under the code-review engine as more than advice', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const ci = readme.slice(readme.indexOf('**CI does not use this engine.**'), readme.indexOf('## Questions people ask'));
  assert.ok(!ci.includes('as advice'), 'CI findings are merged into the local ledger, so they are not advice-only');
  assert.ok(ci.includes('only the review you run locally can approve'));
  const spec = readFileSync(join(ROOT, 'docs/specs/2026-10-21-code-review-engine-design.md'), 'utf8');
  const amendments = spec.slice(spec.indexOf('## Amendments after the spike'));
  const { CI_NOTE } = require('./options.cjs');
  assert.ok(amendments.replace(/\s+/g, ' ').includes(CI_NOTE), 'the amendments record the new CI note wording');
});

test('README says CI findings carry in only until you post your own local report', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const ci = readme
    .slice(readme.indexOf('**CI does not use this engine.**'), readme.indexOf('## Questions people ask'))
    .replace(/\s+/g, ' ');
  assert.ok(!ci.includes('Those findings still count'), 'CI findings do not always count');
  assert.ok(ci.includes('Until you post a local report, your next local review merges CI\'s findings into its own ledger.'), ci);
  assert.ok(ci.includes('findings from later CI runs do not carry in'), ci);
  assert.ok(!ci.includes('—'), 'new prose uses no em dashes');
});

test('README names the overwritable capture file as a known limitation', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const limits = readme.slice(readme.indexOf('## Known limitations'), readme.indexOf('## Repo layout'));
  const start = limits.indexOf('**A lane could still overwrite the capture file on purpose.**');
  assert.notStrictEqual(start, -1, 'the known limitations list the capture file');
  const bullet = limits.slice(start, limits.indexOf('\n- **', start)).replace(/\s+/g, ' ');
  assert.ok(bullet.includes('cannot rule that out'), bullet);
  assert.ok(!bullet.includes('code_review_raw.txt'), 'the old lane file is gone');
  assert.ok(!bullet.includes('—'), 'new prose uses no em dashes');
});

test('the capture spec records the final-review changes to the check in section 4', () => {
  const spec = readFileSync(join(ROOT, 'docs/specs/2026-10-23-code-review-capture-design.md'), 'utf8');
  const section4 = spec.slice(spec.indexOf('### 4. The check'), spec.indexOf('### 5.'));
  const start = section4.indexOf('**Amendment, 2026-10-24 (final review).**');
  assert.notStrictEqual(start, -1, 'section 4 has a dated amendment');
  const amendment = section4.slice(start).split('\n\n')[0].replace(/\s+/g, ' ');
  for (const needle of [
    '`--capture` is removed',
    '`/tmp/agent-review-<uid>`',
    '`--promote <f>`',
    'a line from 1 to the file\'s line count',
    'within 2 lines',
    'every mention on its claimed finding line',
    'within 60 seconds',
    'Two different non-empty qualifying JSON lists fail closed with `stage: capture`',
  ]) {
    assert.ok(amendment.includes(needle), `the amendment must say ${JSON.stringify(needle)}`);
  }
  assert.ok(!amendment.includes('—'), 'new prose uses no em dashes');
});

test('README states how the capture, the wait, and the proof behave, and what they cannot catch', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const engine = readme.slice(readme.indexOf('**How the result is captured.**'), readme.indexOf('**`effort=max` works'));
  const flat = engine.replace(/\s+/g, ' ');
  for (const needle of [
    'A plugin hook writes it to a private directory, `/tmp/agent-review-<uid>`,',
    'The hooks act only while a review has armed capture, and an arm expires after 3 hours.',
    'They never touch a `/code-review` you run yourself in the main conversation.',
    "While a review is armed, though, a `/code-review` run in another subagent of yours writes a mismatch record and fails that review's wait, and the hooks keep the final message of every subagent that stops in your sessions (the newest 50) in that directory until the review disarms.",
    'If the hooks never run, for example because Claude Code was not restarted after the plugin was installed, the wait fails within a minute and says so.',
    "When the result holds a JSON findings list, the lane's list must match it one to one. `xhigh` and `max` results usually hold one.",
    "Otherwise the lane's list must match the result's finding lines, one entry per line.",
    "That text mode has a cost, and it is usual at `low`, `medium`, and `high`: a line that cites a location only as context still counts as a finding. The lane must list it and score or drop it, and a line it leaves out fails the run.",
    "The check also holds every scored finding to the field rules: its raw finding's file, a whole-number severity from 1 to 10, one of the nine category names, a confidence of High, Medium, or Low, and the `outside_range`, `doubted`, and `recategorized_from` fields.",
    'this was built and tested on 2.1.309',
    "- A finding is dropped only for one of two reasons. It is `excluded` because its file matches a glob in your `excluded_paths` and its line in the result cites no other file, or it is `disproved` by quoting the exact code right after a `path:line` in a file that exists, within 2 lines of that line. If the scorer just doubts it, the finding stays, at 4 or below, with a note. Dropped findings are listed in the report, so you can check the work.",
  ]) {
    assert.ok(flat.includes(needle), `README must say ${JSON.stringify(needle)}`);
  }
  for (const stale of [
    'a private file',
    'a capture expires after 3 hours',
    "At `xhigh` and `max` the lane's list must match",
    '2.1.306',
    'A finding is deleted only when it is proven wrong',
    'They never touch your own `/code-review` runs.',
  ]) {
    assert.ok(!flat.includes(stale), `README must no longer say ${JSON.stringify(stale)}`);
  }
  assert.ok(!engine.includes('—'), 'new prose uses no em dashes');

  const limits = readme.slice(readme.indexOf('## Known limitations'), readme.indexOf('## Repo layout'));
  const start = limits.indexOf('**A lane could add a finding `/code-review` never made.**');
  assert.notStrictEqual(start, -1, 'the known limitations name the invented no-line entry');
  const bullet = limits.slice(start, limits.indexOf('\n- **', start)).replace(/\s+/g, ' ');
  assert.ok(bullet.includes('This can only add a finding, never hide one.'), bullet);
  assert.ok(!bullet.includes('—'), 'new prose uses no em dashes');
});

test('README makes no claim about resetting a remembered /code-review limit', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(!readme.includes('resets any limit'), 'the reset claim is gone');
});

test('the spec records the fixes made after the PR\'s /code-review run', () => {
  const spec = readFileSync(join(ROOT, 'docs/specs/2026-10-21-code-review-engine-design.md'), 'utf8');
  const flat = spec.replace(/\s+/g, ' ');
  const section5 = spec.slice(spec.indexOf('### 5. The `code-review` lane'), spec.indexOf('### 6.')).replace(/\s+/g, ' ');
  assert.ok(section5.includes('and `--max-findings default` when it is not'), 'section 5 always passes the flag');
  assert.ok(!section5.includes('only when `engine.code_review.max_findings` is set'), 'section 5 drops the old rule');
  const amendments = flat.slice(flat.indexOf('## Amendments after the spike'));
  assert.ok(amendments.includes('within 5 lines of an older open or dismissed entry from the same lane, in the same file and category'));
  assert.ok(amendments.includes("after the PR's /code-review run on 2026-10-23"), 'the amendments date the change');
  const added = spec.split('\n').filter((line) => line.includes('2026-10-23') || line.includes('--max-findings default'));
  assert.ok(added.every((line) => !line.includes('—')), 'new prose uses no em dashes');
});

test('README and the spec record the third /code-review round', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(
    readme.includes('- On every review, not only re-reviews, a reworded suggestion within 5 lines of an older open or dismissed finding from the same reviewer, in the same file and category, that says much the same thing is not added again, so the PR comment stops growing.'),
    'location matching applies to every review and needs similar wording',
  );
  assert.ok(
    readme.includes('- If another reviewer flags the same spot with a lower score, a proven 7 or more from any reviewer keeps its score through the merge instead of being averaged down.'),
    'any lane\'s proven 7+ keeps its score',
  );
  assert.ok(!readme.includes('On a re-review, a reworded suggestion'), 'the re-review-only wording is gone');

  const spec = readFileSync(join(ROOT, 'docs/specs/2026-10-21-code-review-engine-design.md'), 'utf8');
  const round3 = spec.split('\n- ').find((item) => item.startsWith('A third /code-review run on the PR on 2026-10-23 (round 3)'));
  assert.ok(round3, 'the spec has one round-3 amendment line');
  const flat = round3.replace(/\s+/g, ' ');
  for (const part of ['A:', 'B:', 'C:', 'D:', 'E:', 'F:']) assert.ok(flat.includes(` ${part} `), `round 3 covers ${part}`);
  assert.ok(!round3.includes('\u2014'), 'new prose uses no em dashes');
});

test('the review skill matches ledger suggestions by location only under the code-review engine', () => {
  const usage = execFileSync(process.execPath, [join(ROOT, 'bin/agent-review'), 'help'], { encoding: 'utf8' });
  const ledgerUsage = usage.split('\n').find((line) => line.trim().startsWith('ledger '));
  assert.ok(ledgerUsage && ledgerUsage.includes('[--match-suggestions-by-location]'), 'the CLI usage lists the ledger flag');

  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const all = bashBlocks(skill);
  const stage6 = bashBlocks(stageSlice(skill, '## Stage 6 — Generate Review Report', '### Build the findings ledger'));
  assert.ok(stage6.startsWith('. /tmp/review_env.sh'), 'Stage 6 reads ENGINE from review_env.sh');
  const calls = commandsIn(stage6, 'agent-review ledger');
  assert.strictEqual(calls.length, 1, 'Stage 6 builds the ledger once');
  assert.ok(
    calls[0].includes('${LEDGER_BY_LOCATION:+--match-suggestions-by-location}'),
    `the Stage 6 ledger call passes the flag through the guard: ${calls[0]}`,
  );
  const assignments = [...all.matchAll(/^.*LEDGER_BY_LOCATION=.*$/gm)].map((m) => m[0].trim());
  assert.deepStrictEqual(
    assignments,
    ['LEDGER_BY_LOCATION=""', '[ "$ENGINE" = "code-review" ] && LEDGER_BY_LOCATION=1'],
    'the guard is set only under the code-review engine',
  );
  assert.ok(
    stage6.indexOf('LEDGER_BY_LOCATION=""') < stage6.indexOf('agent-review ledger'),
    'the guard is reset before the ledger call',
  );
  assert.strictEqual(
    all.split('--match-suggestions-by-location').length - 1,
    1,
    'no other ledger call passes the flag',
  );
});

test('docs say location matching uses only the same lane\'s open or dismissed entries', () => {
  const usage = execFileSync(process.execPath, [join(ROOT, 'bin/agent-review'), 'help'], { encoding: 'utf8' });
  const ledgerUsage = usage.split('\n').find((line) => line.trim().startsWith('ledger '));
  assert.ok(
    ledgerUsage.includes("older open or dismissed entries from the same lane"),
    `the CLI usage names which entries match: ${ledgerUsage}`,
  );
  assert.ok(ledgerUsage.includes('by file, category, nearby line, and similar wording'), ledgerUsage);
  const flatSkill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(flatSkill.includes('within 5 lines of an older open or dismissed entry from the same lane, in the same file and category'));
  assert.ok(
    flatSkill.includes('and says much the same thing (a token Jaccard of 0.5 or more between the two messages), is treated as that entry'),
    'the skill names the wording check',
  );
  assert.ok(!flatSkill.includes('older entry (any status)'));
  const flatReadme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(flatReadme.includes('within 5 lines of an older open or dismissed finding from the same reviewer, in the same file and category'));
});

test('code-review lane template names the categories in vocabulary order', () => {
  const { CATEGORIES, CLEANUP_CATEGORIES } = require('./vocabulary.cjs');
  const text = readFileSync(join(ROOT, 'templates/code-review-lane.md'), 'utf8').replace(
    /\s+/g,
    ' ',
  );
  const names = (list) => list.map((c) => `\`${c}\``);
  const nine = names(CATEGORIES);
  const five = names(CLEANUP_CATEGORIES);
  assert.ok(
    text.includes(`one of these nine names: ${nine.slice(0, -1).join(', ')}, or ${nine.at(-1)}.`),
    'nine-category sentence',
  );
  assert.ok(
    text.includes(`The cleanup categories are ${five.slice(0, -1).join(', ')}, and ${five.at(-1)}:`),
    'cleanup-category sentence',
  );
});

test('hooks.json registers both capture hooks', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(config.hooks).sort(), ['PostToolUse', 'SubagentStop']);
  const command = (name) => `node "\${CLAUDE_PLUGIN_ROOT}/bin/agent-review" hook ${name} 2>/dev/null || true`;

  assert.strictEqual(config.hooks.PostToolUse.length, 1);
  const [post] = config.hooks.PostToolUse;
  assert.strictEqual(post.matcher, 'Skill');
  assert.deepStrictEqual(post.hooks, [{ type: 'command', command: command('post-skill'), timeout: 10 }]);

  assert.strictEqual(config.hooks.SubagentStop.length, 1);
  const [stop] = config.hooks.SubagentStop;
  assert.ok(!('matcher' in stop), 'SubagentStop has no matcher');
  assert.deepStrictEqual(stop.hooks, [{ type: 'command', command: command('subagent-stop'), timeout: 10 }]);
});

test('the hook commands exit 0 and print nothing when node is not on PATH', () => {
  const { spawnSync } = require('node:child_process');
  const config = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const empty = mkdtempSync(join(os.tmpdir(), 'ar-no-node-'));
  try {
    for (const entry of [...config.hooks.PostToolUse, ...config.hooks.SubagentStop]) {
      for (const { command } of entry.hooks) {
        const r = spawnSync('/bin/sh', ['-c', command], {
          input: '{}',
          encoding: 'utf8',
          env: { PATH: empty, CLAUDE_PLUGIN_ROOT: ROOT },
        });
        assert.deepStrictEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' }, command);
      }
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

const REVIEW_SKILL = join(ROOT, 'skills/review/SKILL.md');
const ENGINE_POINTER = (name, part) =>
  `When $ENGINE is code-review, read code-review-engine.md, section "${name}"${part ? `, part "${part}"` : ''}, and follow it.`;
// The Stage 0 parts, in the order SKILL.md points at them.
const STAGE0_PARTS = ['The plan', 'The start-up line', 'The launch list', 'The agent list', 'The smoke test'];

test('SKILL.md has no code-review-engine-only prose outside one-line pointers', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const doc = engineDoc();
  for (const name of ['Stage 0', 'Stage 1: the code-review lane', 'Stage 2: checking the code-review lane', 'Stage 6: the engine block']) {
    assert.ok(doc.includes(`\n## ${name}\n`), `code-review-engine.md has the section "${name}"`);
    if (name !== 'Stage 0') assert.ok(skill.includes(ENGINE_POINTER(name)), `SKILL.md points at "${name}"`);
  }
  const moved = [
    'fill its twelve placeholders:',
    '| `{{SCORING_RULES}}`',
    'launch a second Task',
    'agent-review code-review-proof --raw',
    '/code-review did not finish',
    'Both must pass.',
    'Fill the `[IF engine is code-review]` block whenever',
    'Code Review (/code-review <effort>)',
  ];
  for (const phrase of moved) {
    assert.ok(!skill.includes(phrase), `SKILL.md must not carry: ${phrase}`);
    assert.ok(doc.includes(phrase), `code-review-engine.md must carry: ${phrase}`);
  }
  for (const gone of ['/code-review did not run', 'Both Tasks must pass']) {
    assert.ok(!skill.includes(gone) && !doc.includes(gone), `neither file may carry: ${gone}`);
  }
  const lines = skill.split('\n');
  for (const [i, line] of lines.entries()) {
    if (/^When \$ENGINE is code-review, read /.test(line.replace(/^- /, ''))) {
      assert.ok(/, and follow it\./.test(line) && line.length < 200, `pointer on line ${i + 1} is one short line`);
    }
  }
});

test('every SKILL.md line that mentions the code-review lane is gated on $ENGINE', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const blocks = skill.split(/\n\s*\n|\n(?=- |\d+\. )/);
  const mentions = blocks.filter((b) => /code-review`?\s+lane|`code-review`\s+lane/.test(b.replace(/\s+/g, ' ')));
  assert.ok(mentions.length > 0, 'the skill still names the lane somewhere');
  for (const b of mentions) {
    assert.ok(
      /ENGINE|code-review`? engine/.test(b),
      `an ungated mention of the code-review lane, which a repo's own lane with that id would trip:\n${b}`,
    );
  }
  const doc = engineDoc();
  for (const name of ['Stage 2: checking the code-review lane', 'Stage 6: the engine block']) {
    const flat = engineSection(name).replace(/\s+/g, ' ');
    assert.ok(/Under the `code-review` engine/.test(flat), `${name} gates its title rule`);
  }
  assert.ok(doc.includes('a repo\'s own lane that happens to have the id `code-review` is an ordinary lane'));
});

test('Stage 6 fills the engine block whenever $ENGINE is code-review', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const stage6 = engineSection('Stage 6: the engine block').replace(/\s+/g, ' ');
  assert.ok(
    stage6.includes('Fill the `[IF engine is code-review]` block whenever `$ENGINE` is `code-review`, whether the engine came from the config or from an `engine=code-review` argument in a repo with no `engine` key.'),
    stage6,
  );
  assert.ok(!/only when `\$ENGINE` is `code-review`/.test(stage6));
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(!flat.includes('when the config has no `engine` key'), 'the no-engine-key omission rule is gone');
  assert.ok(
    flat.includes('When `$ENGINE` is `agent-review`, omit the `[IF engine is code-review]` block.'),
    'the block is omitted on the agent-review engine alone',
  );
});

test('CI auto-skip report carries the options notes, and an incremental skip keeps the earlier notes', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const auto = bashBlocks(stageSlice(skill, '### Auto Mode Resolution', '### Start-up Line'));
  assert.ok(auto.includes('skip_notes "${AGENT_REVIEW_PREVIOUS_COMMENT:-}"'), 'the CI skip report writes the notes');
  assert.ok(auto.includes('skip_notes /tmp/previous_agent_review_comment.md'), 'the local incremental skip keeps the earlier notes');
  assert.strictEqual(auto.split('skip_notes() {').length - 1, 1, 'one definition');
  assert.strictEqual(auto.split('skip_notes ').length - 1, 2, 'two calls');
  const start = auto.indexOf('skip_notes() {');
  const end = auto.indexOf('\n  }\n', start) + 5;
  assert.ok(start !== -1 && end > start);
  const fn = auto.slice(start, end);

  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync, copyFileSync, existsSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'skip-notes-'));
  // The function reads /tmp/review_options.json; stand a private copy in by rewriting the path.
  const optionsPath = join(dir, 'options.json');
  const previous = join(dir, 'previous.md');
  writeFileSync(optionsPath, JSON.stringify({ notes: ['CI note', 'shared'] }));
  writeFileSync(previous, '<!-- agent-review -->\r\nbody\r\n\r\n**Notes**:\r\n- earlier note\r\n- shared\r\n\r\n**Debate summary**\r\n- not a note\r\n');
  const run = (prev, opts) =>
    execFileSync('bash', ['-c', `${fn.split('/tmp/review_options.json').join(opts)}\nskip_notes ${prev ? `"${prev}"` : ''}`], {
      encoding: 'utf8',
    });
  assert.equal(run(previous, optionsPath), '\n**Notes**:\n- CI note\n- shared\n- earlier note\n', 'options notes first, earlier notes kept, no repeats');
  assert.equal(run('', optionsPath), '\n**Notes**:\n- CI note\n- shared\n');
  writeFileSync(optionsPath, JSON.stringify({ notes: [] }));
  assert.equal(run('', optionsPath), '', 'no notes, no Notes line');
  assert.equal(run(previous, optionsPath), '\n**Notes**:\n- earlier note\n- shared\n');
  assert.ok(!existsSync(join(dir, 'unused')) && copyFileSync);
});

test('REVIEW_ARGS is written with a quoted heredoc to /tmp/review_args.txt and read with options --args-file', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const init = stageSlice(skill, '### Initialize', '### Gather PR Context & Diff Manifest');
  const bash = bashBlocks(init);
  assert.ok(bash.includes("cat > /tmp/review_args.txt <<'REVIEW_ARGS_END_7f3a'\n"), 'a quoted heredoc writes the file');
  assert.ok(bash.includes('\nREVIEW_ARGS_END_7f3a\n'), 'the heredoc is closed by its marker');
  assert.ok(
    bash.includes("cat > /tmp/review_args.txt <<'REVIEW_ARGS_END_7f3a'\nREVIEW_ARGS_END_7f3a\n"),
    'the shipped heredoc body is empty, so a skipped paste runs with no arguments rather than an example',
  );
  const prose = flatText(init.slice(0, init.indexOf('```bash')));
  assert.ok(
    prose.includes(
      'For example, for `/agent-review:review auto incremental engine=code-review`, the one line between the markers is `auto incremental engine=code-review`.',
    ),
    prose,
  );
  assert.ok(bash.includes('agent-review options --args-file /tmp/review_args.txt ${CI_MODE:+--ci} > /tmp/review_options.json'));
  assert.ok(!/--args "\$REVIEW_ARGS"/.test(skill), 'the raw string never goes through a double-quoted assignment');
  assert.ok(!/^REVIEW_ARGS=/m.test(bash), 'no shell assignment of the raw arguments');
  assert.ok(
    bash.indexOf("cat > /tmp/review_args.txt") < bash.indexOf('agent-review options'),
    'the file is written before options reads it',
  );

  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, readFileSync: read } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'review-args-'));
  const nasty = 'deep "focus on auth" $(touch pwned) `id` \\n';
  const script = `cat > args.txt <<'REVIEW_ARGS_END_7f3a'\n${nasty}\nREVIEW_ARGS_END_7f3a\n`;
  execFileSync('bash', ['-c', script], { cwd: dir });
  assert.equal(read(join(dir, 'args.txt'), 'utf8'), `${nasty}\n`, 'quotes, $(...), and backticks stay literal');
  assert.ok(!require('node:fs').existsSync(join(dir, 'pwned')), 'nothing in the arguments ran');
});

test('the code-review smoke test passes model haiku', () => {
  const stage0 = engineSection('Stage 0').replace(/\s+/g, ' ');
  assert.ok(
    stage0.includes('identical except for **subagent_type** `"agent-review:reviewer-code-review"` and **model** `"haiku"`'),
    stage0,
  );
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const smoke = stageSlice(skill, '### Smoke-Test Tier Routing', '## Stage 1 — Launch Specialized Review Agents');
  assert.ok(smoke.includes(ENGINE_POINTER('Stage 0', 'The smoke test')), 'the smoke test points at the second probe');
  const flatSmoke = smoke.replace(/\s+/g, ' ');
  assert.ok(flatSmoke.includes('Launch this probe as one Task, not one per tier:'), 'the default engine still launches one probe');
  assert.ok(!flatSmoke.includes('Launch exactly one Task'), 'the code-review engine launches two, so "exactly one" is false there');
  assert.ok(!flatSmoke.includes('Both Tasks must pass'), 'the two-probe rule lives in the engine doc');
  assert.ok(stage0.includes('Both must pass.'), 'the engine doc says both probes must pass');
});

test('Stage 0 pointers name the part of the engine doc they mean', () => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const stage0 = engineSection('Stage 0');
  assert.ok(!skill.includes(ENGINE_POINTER('Stage 0')), 'a bare "Stage 0" pointer does not say which part applies');
  let at = -1;
  for (const part of STAGE0_PARTS) {
    const pointer = ENGINE_POINTER('Stage 0', part);
    assert.strictEqual(skill.split(pointer).length - 1, 1, `SKILL.md points at "${part}" once`);
    assert.ok(skill.indexOf(pointer) > at, `the "${part}" pointer follows the one before it`);
    at = skill.indexOf(pointer);
    assert.ok(stage0.includes(`**${part}.**`), `the engine doc's Stage 0 has the part "${part}"`);
  }
  const at1 = (header) => skill.indexOf(header);
  const where = (part) => skill.indexOf(ENGINE_POINTER('Stage 0', part));
  assert.ok(where('The plan') < at1('## CI Mode'), 'the plan pointer sits with the plan shape');
  assert.ok(where('The start-up line') > at1('### Start-up Line') && where('The start-up line') < at1('### Risk Assessment'));
  assert.ok(where('The launch list') > at1('**Mode semantics**') && where('The launch list') < at1('- **standard** →'));
  assert.ok(where('The agent list') > at1('Announce the selection') && where('The agent list') < at1('### Smoke-Test Tier Routing'));
  assert.ok(where('The smoke test') > at1('### Smoke-Test Tier Routing') && where('The smoke test') < at1('## Stage 1 — Launch Specialized Review Agents'));
});

// Each ```bash block in `text`, as its own string.
function bashBlockList(text) {
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
}

function armBlock() {
  const blocks = bashBlockList(engineSection('Stage 1: the code-review lane')).filter((b) => b.includes('agent-review capture arm'));
  assert.strictEqual(blocks.length, 1, 'Stage 1 has one block that arms the capture');
  return blocks[0];
}

// Runs Stage 1's arm block with stub agent-review and git commands, its /tmp files moved to a
// private directory, and returns what it called and wrote.
function runArmBlock(shell, env, plan) {
  const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
  const { dirname } = require('node:path');
  const dir = mkdtempSync(join(os.tmpdir(), 'ar-arm-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'agent-review'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/agent-review.args"\n[ "$1 $2" = "capture arm" ] && echo "armed $4: $6"\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/git.args"\necho "merge-base diff"\n`, {
      mode: 0o755,
    });
    writeFileSync(join(dir, 'review_env.sh'), Object.entries(env).map(([k, v]) => `export ${k}="${v}"`).join('\n') + '\n');
    writeFileSync(join(dir, 'review_plan.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'pr_diff.txt'), 'two-dot diff\n');
    const script = armBlock().replaceAll('/tmp/', `${dir}/`);
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(shell, ['-c', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: process.env.HOME },
      });
    } catch (e) {
      status = e.status;
      stdout = String(e.stdout || '');
    }
    const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
    return {
      dir,
      status,
      stdout,
      agentReview: read('agent-review.args'),
      git: read('git.args'),
      env: read('review_env.sh'),
      diff: read('code_review_diff.txt'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function availableShells(t) {
  const shells = ['bash', 'zsh'].filter((sh) => {
    try {
      execFileSync(sh, ['-c', 'true']);
      return true;
    } catch {
      return false;
    }
  });
  if (!shells.includes('zsh')) t.diagnostic('zsh not installed; only bash was exercised');
  return shells;
}

const FULL_PR_ENV = {
  EFFORT: 'xhigh',
  REVIEW_ID: '33-20261023-120000',
  PR_NUMBER: '33',
  INCREMENTAL: '',
  LAST_REVIEWED: '',
  BASE_REF: 'aaa111',
  HEAD_REF: 'bbb222',
  RANGE: 'aaa111..bbb222',
  CODE_REVIEW_TARGET: '33',
};

test('code-review-engine.md arms capture with the composed args and fills SKILL_ARGS from it', (t) => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  assert.ok(
    bashBlocks(skill).includes('  echo "code-review target: $CODE_REVIEW_TARGET"\n  echo "export CODE_REVIEW_TARGET=\\"$CODE_REVIEW_TARGET\\"" >> /tmp/review_env.sh\nfi'),
    'the target block keeps the target for the arm block',
  );
  const block = armBlock();
  assert.ok(block.startsWith('. /tmp/review_env.sh 2>/dev/null || true\nset -e\n'), block);
  for (const line of [
    'MAX_FINDINGS_FLAG=" --max-findings ${MAX_FINDINGS:-default}"',
    'CODE_REVIEW_ARGS="$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"',
    'agent-review capture arm --run "$REVIEW_ID" --args "$CODE_REVIEW_ARGS"',
  ]) {
    assert.ok(block.split('\n').includes(line), `the arm block runs: ${line}`);
  }
  const stage1 = engineSection('Stage 1: the code-review lane');
  assert.ok(stage1.indexOf('agent-review capture arm') < stage1.indexOf('Launch the lane with the Task tool'), 'capture is armed before the lane launches');
  assert.ok(
    flatText(stage1).includes('If this block fails, stop the review and show its error.'),
    'a lane with no armed capture cannot be checked',
  );
  const row = lanePlaceholderRows().rows.get('SKILL_ARGS');
  assert.ok(row.includes('Copy them exactly from the `armed <id>: <args>` line the block prints.'), row);

  const cases = [
    [FULL_PR_ENV, { engine: { maxFindings: null } }, 'xhigh 33 --max-findings default'],
    [
      { ...FULL_PR_ENV, EFFORT: 'high', INCREMENTAL: 'true', LAST_REVIEWED: 'ccc333', CODE_REVIEW_TARGET: 'ccc333..bbb222' },
      { engine: { maxFindings: 5 } },
      'high ccc333..bbb222 --max-findings 5',
    ],
    [
      { ...FULL_PR_ENV, EFFORT: 'low', PR_NUMBER: '', BASE_REF: '', HEAD_REF: '', RANGE: 'ddd444..HEAD', CODE_REVIEW_TARGET: 'ddd444..HEAD' },
      { engine: { maxFindings: 'all' } },
      'low ddd444..HEAD --max-findings all',
    ],
  ];
  for (const shell of availableShells(t)) {
    for (const [env, plan, args] of cases) {
      const run = runArmBlock(shell, env, plan);
      assert.strictEqual(run.status, 0, `${shell}: ${run.stdout}`);
      assert.strictEqual(run.agentReview, `capture\narm\n--run\n${env.REVIEW_ID}\n--args\n${args}\n`, `${shell}: arm call`);
      assert.ok(run.stdout.includes(`armed ${env.REVIEW_ID}: ${args}\n`), `${shell}: the printed args are the armed args`);
      assert.ok(run.env.includes(`export CODE_REVIEW_ARGS="${args}"`), `${shell}: a relaunch re-arms with the same args`);
      assert.ok(run.env.includes(`CODE_REVIEW_ATTEMPT="${env.REVIEW_ID}-1"`), `${shell}: the attempt id is saved for Stage 2`);
      assert.ok(run.stdout.includes(`code-review attempt: ${env.REVIEW_ID}-1\n`), `${shell}: ${run.stdout}`);
    }
    const missing = runArmBlock(shell, { ...FULL_PR_ENV, CODE_REVIEW_TARGET: '' }, { engine: { maxFindings: null } });
    assert.notStrictEqual(missing.status, 0, `${shell}: no target, no arm`);
    assert.strictEqual(missing.agentReview, null, `${shell}: capture is never armed without a target`);
  }
});

test('full PR reviews give the lane a merge-base diff', (t) => {
  assert.ok(armBlock().includes('  git diff "$BASE_REF...$HEAD_REF" > /tmp/code_review_diff.txt\n'));
  for (const shell of availableShells(t)) {
    const full = runArmBlock(shell, FULL_PR_ENV, { engine: { maxFindings: null } });
    assert.strictEqual(full.git, 'diff\naaa111...bbb222\n', `${shell}: three dots diff against the merge base`);
    assert.strictEqual(full.diff, 'merge-base diff\n', `${shell}: the merge-base diff is written`);
    assert.ok(full.stdout.includes(`code-review diff: ${full.dir}/code_review_diff.txt\n`), `${shell}: ${full.stdout}`);
    assert.ok(full.env.includes(`CODE_REVIEW_DIFF="${full.dir}/code_review_diff.txt"`), `${shell}: the diff path is kept`);

    const incremental = runArmBlock(
      shell,
      { ...FULL_PR_ENV, INCREMENTAL: 'true', LAST_REVIEWED: 'ccc333', CODE_REVIEW_TARGET: 'ccc333..bbb222' },
      { engine: {} },
    );
    assert.strictEqual(incremental.git, null, `${shell}: an incremental review keeps the reviewed range`);
    assert.ok(incremental.stdout.includes(`code-review diff: ${incremental.dir}/pr_diff.txt\n`), `${shell}: ${incremental.stdout}`);

    const noPr = runArmBlock(
      shell,
      { ...FULL_PR_ENV, PR_NUMBER: '', BASE_REF: '', HEAD_REF: '', CODE_REVIEW_TARGET: 'ddd444..HEAD' },
      { engine: {} },
    );
    assert.strictEqual(noPr.git, null, `${shell}: a range review keeps the reviewed range`);
    assert.ok(noPr.stdout.includes(`code-review diff: ${noPr.dir}/pr_diff.txt\n`), `${shell}: ${noPr.stdout}`);
  }
});

test("Stage 2 waits for the lane's next final line after an early handback", () => {
  const stage2 = engineSection('Stage 2: checking the code-review lane');
  const flat = flatText(stage2);
  assert.ok(
    bashBlocks(stage2).includes('agent-review capture-wait --run "$REVIEW_ID" --effort "$EFFORT"'),
    'Stage 2 waits on the capture itself',
  );
  for (const needle of [
    'Any other reply is an early handback: the lane called the Skill tool and stopped',
    'A Task tool error, or a reply that shows the lane ended before it called the Skill tool, counts as `/code-review did not finish`',
    'run this with a Bash timeout of 600000',
    'run it again each time it exits 3',
    'Once it exits 0 or 1, keep collecting the same lane (TaskOutput) for up to 10 more minutes, and judge its next final line.',
    '`/code-review did not finish`',
    '`/code-review returned no usable result`',
  ]) {
    assert.ok(flat.includes(needle), `Stage 2 must say ${JSON.stringify(needle)}`);
  }
  assert.ok(
    flat.indexOf('early handback') < flat.indexOf('2. Judge the reply.'),
    'the wait comes before any judging or relaunch',
  );
  assert.ok(stage2.includes(`\`${FINAL_LINE_CONTRACT}\``), 'Stage 2 quotes the exact contract line');
  assert.ok(!engineDoc().split(FINAL_LINE_CONTRACT).join('').includes('—'), 'the contract line is the only em dash in the engine doc');
});

test('Stage 2 relaunches with the existing capture on stage lane, and re-arms on stage capture', (t) => {
  const stage2 = engineSection('Stage 2: checking the code-review lane');
  const flat = flatText(stage2);
  assert.strictEqual(
    STAGE2_PROOF_COMMAND.replaceAll('"/tmp/', '/tmp/').replaceAll('.$ATTEMPT.json"', '.{{ATTEMPT}}.json').replace('"$REVIEW_ID"', '{{RUN_ID}}'),
    `${LANE_PROOF_COMMAND} --promote ${PROMOTED_FINDINGS} > /tmp/code_review_proof.json`,
    "Stage 2 runs the lane's own check on the same attempt's files",
  );
  assert.ok(bashBlocks(stage2).includes(STAGE2_PROOF_COMMAND));
  for (const needle of [
    'cross-check the lane, then run the proof',
    '`/tmp/code_review_findings.<attempt>.json` parses and its `findings.length` equals `<N>`',
    '`stage` is `"lane"`: relaunch with the same capture (step 3), with the proof\'s `reason`.',
    '`stage` is `"capture"`: relaunch with a new capture (step 3).',
    '`/code-review did not finish` or `/code-review returned no usable result`: /code-review\'s result is missing or unusable. Relaunch with a new capture (step 3).',
    '`stage` is `"config"`: the review\'s config cannot be read, or the proved findings cannot be saved, and a relaunch cannot fix that. Fail the run now, with no relaunch (step 5).',
    '**With the same capture.** Do not re-arm',
    '**With a new capture.** Re-arm with this block first, which clears the old result',
  ]) {
    assert.ok(flat.includes(needle), `Stage 2 must say ${JSON.stringify(needle)}`);
  }
  const same = flat.slice(flat.indexOf('**With the same capture.**'), flat.indexOf('**With a new capture.**'));
  const note = /`(In STEP 1, skip the Skill call: [^`]*)`/.exec(same);
  assert.ok(note, 'the same-capture relaunch gives the lane a retry note');
  assert.ok(note[1].includes('skip the Skill call') && laneText().includes('If it says to skip the Skill call'), 'the note uses the phrase the lane acts on');
  assert.ok(note[1].endsWith('The earlier attempt failed the review\'s check with this reason: "<reason>"'), note[1]);
  assert.ok(!same.includes('capture arm'), 'the same-capture relaunch never re-arms, which would delete the saved result');
  const fresh = stage2.slice(stage2.indexOf('**With a new capture.**'), stage2.indexOf('**4. Pass.**'));
  assert.ok(
    bashBlocks(fresh).includes('agent-review capture arm --run "$REVIEW_ID" --args "$CODE_REVIEW_ARGS"'),
    'a new capture re-arms with the args Stage 1 armed',
  );
  assert.ok(flatText(fresh).includes('relaunch with an empty `{{RETRY_NOTE}}`. If the block fails, do not relaunch: the run fails (step 5).'));
  const rearm = bashBlockList(fresh).filter((b) => b.includes('capture arm'));
  assert.strictEqual(rearm.length, 1, 'one re-arm block');
  const { mkdirSync, writeFileSync } = require('node:fs');
  for (const shell of availableShells(t)) {
    for (const code of [0, 1]) {
      const dir = mkdtempSync(join(os.tmpdir(), 'ar-rearm-'));
      try {
        mkdirSync(join(dir, 'bin'));
        writeFileSync(join(dir, 'bin', 'agent-review'), `#!/bin/sh\necho "error: capture dir is a symlink" >&2\nexit ${code}\n`, { mode: 0o755 });
        writeFileSync(join(dir, 'review_env.sh'), 'export REVIEW_ID="r" CODE_REVIEW_ARGS="low 1 --max-findings default"\n');
        const run = require('node:child_process').spawnSync(shell, ['-c', rearm[0].replaceAll('/tmp/', `${dir}/`)], {
          encoding: 'utf8',
          env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
        });
        if (code === 0) {
          assert.strictEqual(run.status, 0, `${shell}: a re-arm that works lets the relaunch go ahead`);
        } else {
          assert.notStrictEqual(run.status, 0, `${shell}: a failed re-arm stops the run`);
          assert.ok(
            run.stdout.includes('❌ review incomplete: the /code-review capture could not be re-armed, so no report was posted'),
            `${shell}: ${run.stdout}`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  assert.ok(flat.includes('`{{ATTEMPT}}` is `$REVIEW_ID-2`'), 'the relaunch writes its own files');
  assert.ok(!stage2.includes('code_review_raw.txt') && !stage2.includes('/code-review did not run'));
});

const RELAUNCH_ATTEMPT_BLOCK = [
  '. /tmp/review_env.sh 2>/dev/null || true',
  `rm -f ${PROMOTED_FINDINGS}`,
  'echo "export CODE_REVIEW_ATTEMPT=\\"$REVIEW_ID-2\\"" >> /tmp/review_env.sh',
  'echo "code-review attempt: $REVIEW_ID-2"',
].join('\n');

test('Stage 2 proves and promotes the attempt saved in review_env.sh, with no hand-edited attempt id', (t) => {
  const doc = engineDoc();
  const stage2 = engineSection('Stage 2: checking the code-review lane');
  const proofBlocks = bashBlockList(stage2).filter((b) => b.includes('agent-review code-review-proof'));
  assert.deepStrictEqual(
    proofBlocks,
    [`. /tmp/review_env.sh 2>/dev/null || true\nATTEMPT="$CODE_REVIEW_ATTEMPT"\n${STAGE2_PROOF_COMMAND}\ncat /tmp/code_review_proof.json`],
    'the proof reads the attempt Stage 1 or the relaunch saved',
  );
  assert.ok(!/^ATTEMPT="\$REVIEW_ID-/m.test(doc) && !doc.includes('# ←'), 'no block asks for a hand-edited attempt id');
  assert.ok(!/\bcp\b[^\n]*agent_findings/.test(doc), 'consensus reads the file the proof promoted, never a copy');
  const relaunch = stage2.slice(stage2.indexOf('**3. Relaunch once.**'), stage2.indexOf('**With the same capture.**'));
  assert.deepStrictEqual(bashBlockList(relaunch), [RELAUNCH_ATTEMPT_BLOCK], 'both kinds of relaunch first record attempt 2');
  assert.ok(stage2.indexOf(RELAUNCH_ATTEMPT_BLOCK) < stage2.indexOf('agent-review capture arm --run'), 'the attempt block comes before the re-arm');

  const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
  for (const shell of availableShells(t)) {
    const dir = mkdtempSync(join(os.tmpdir(), 'ar-attempt-'));
    try {
      const at = (text) => text.replaceAll('/tmp/', `${dir}/`);
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'agent_findings'));
      writeFileSync(join(dir, 'bin', 'agent-review'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/agent-review.args"\necho '{"ok":true}'\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'review_env.sh'), 'export REVIEW_ID="r9" CODE_REVIEW_ATTEMPT="r9-1"\n');
      writeFileSync(join(dir, 'agent_findings', 'code-review.json'), '{"findings":[]}');
      const sh = (script) =>
        require('node:child_process').spawnSync(shell, ['-c', at(script)], {
          encoding: 'utf8',
          env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
        });
      const argsOf = () => readFileSync(join(dir, 'agent-review.args'), 'utf8').split('\n');

      assert.strictEqual(sh(proofBlocks[0]).status, 0, shell);
      let args = argsOf();
      assert.strictEqual(args[args.indexOf('--findings') + 1], `${dir}/code_review_findings.r9-1.json`, `${shell}: attempt 1`);
      assert.strictEqual(args[args.indexOf('--promote') + 1], `${dir}/agent_findings/code-review.json`, `${shell}: promotes for consensus`);

      const relaunched = sh(RELAUNCH_ATTEMPT_BLOCK);
      assert.strictEqual(relaunched.status, 0, shell);
      assert.strictEqual(relaunched.stdout, 'code-review attempt: r9-2\n', shell);
      assert.ok(!existsSync(join(dir, 'agent_findings', 'code-review.json')), `${shell}: a relaunch never inherits attempt 1's promoted file`);
      assert.strictEqual(sh(proofBlocks[0]).status, 0, shell);
      args = argsOf();
      assert.strictEqual(args[args.indexOf('--findings') + 1], `${dir}/code_review_findings.r9-2.json`, `${shell}: attempt 2`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Stage 2 disarms capture after judging the lane', () => {
  const stage2 = engineSection('Stage 2: checking the code-review lane');
  const pass = stage2.slice(stage2.indexOf('**4. Pass.**'), stage2.indexOf('**5. Fail.**'));
  assert.deepStrictEqual(bashBlockList(pass), [QUIET_DISARM], 'a pass only disarms: the proof already promoted the findings');
  assert.ok(
    flatText(pass).includes(
      `The proof already saved the passing attempt's findings as \`${PROMOTED_FINDINGS}\`, exactly as it checked them. Do not copy or edit that file.`,
    ),
    pass,
  );
  const failText = stage2.slice(stage2.indexOf('**5. Fail.**'));
  assert.ok(bashBlockList(failText).includes(QUIET_DISARM), 'a failed lane disarms in a bash block');
  const fail = flatText(failText);
  assert.ok(
    fail.includes('When the lane fails twice, fails once at `stage: "config"`, or cannot be re-armed, first disarm the capture:'),
    fail,
  );
  assert.ok(
    fail.includes(
      'Run the same disarm block whenever the run stops after Stage 1 armed the capture and before this lane is judged: another lane fails twice, a later block fails, or the run ends for any other reason.',
    ),
    fail,
  );
  assert.ok(
    flatText(engineSection('Stage 1: the code-review lane')).includes(
      'If the run stops before then for any reason, run `agent-review capture disarm` before you stop (Stage 2, step 5).',
    ),
    'the rule is in Stage 1 too, since a run can stop before Stage 2 is read',
  );
  assert.ok(fail.includes('❌ review incomplete: the code-review lane could not be checked, so no report was posted'), fail);
  assert.ok(fail.includes("print the proof's `reason` from `/tmp/code_review_proof.json`"), fail);
  const judging = stage2.slice(0, stage2.indexOf('**4. Pass.**'));
  assert.ok(!judging.includes('capture disarm'), 'capture stays armed until the lane is judged, so a relaunch can reuse it');
});

test("Stage 6 renders drops from the proof's dropped list", () => {
  const stage6 = flatText(engineSection('Stage 6: the engine block'));
  for (const needle of [
    '`[N]` is `count` from `/tmp/code_review_proof.json`',
    '`[M]` is `findings.length` in `/tmp/agent_findings/code-review.json`',
    "`[K]` is the length of the proof's `dropped` list",
    'as `<file>:<line> <summary>: <why>`',
  ]) {
    assert.ok(stage6.includes(needle), `Stage 6 must say ${JSON.stringify(needle)}`);
  }
  assert.ok(!stage6.includes('code_review_dropped'), 'the lane files are never read for the report');
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  assert.ok(report.includes('[FOR EACH dropped finding] - [file]:[line] [summary]: [why]'), 'the skeleton renders the proof fields');
  assert.ok(
    flatText(report).includes('[FOR EACH dropped finding] - [file]:[line] [summary]: [why] [when line is null, print only [file], with no ":[line]"]'),
    'the skeleton says what to print for a drop with no line',
  );
  assert.ok(!report.includes('[quoted proof]'));
  const { checkLaneOutput } = require('./codeReviewProof.cjs');
  const result = checkLaneOutput({
    rawEntries: [{ n: 1, file: 'dist/app.js', line: 3, summary: 'bundle bug' }],
    scoredText: JSON.stringify({ findings: [] }),
    droppedText: JSON.stringify([{ raw: 1, reason: 'excluded', glob: 'dist/**' }]),
    excludedPaths: ['dist/**'],
    root: ROOT,
  });
  assert.deepStrictEqual(result.dropped, [{ file: 'dist/app.js', line: 3, summary: 'bundle bug', why: 'excluded path: dist/**' }]);
});

test('Stage 0 no longer mentions /tmp/code_review_raw.txt', (t) => {
  const skill = readFileSync(REVIEW_SKILL, 'utf8');
  const init = stageSlice(skill, '### Initialize', '### Gather PR Context & Diff Manifest');
  assert.ok(!init.includes('/tmp/code_review_raw.txt'));
  assert.ok(!skill.includes('code_review_raw.txt') && !engineDoc().includes('code_review_raw.txt'));
  const bash = bashBlocks(init);
  const removals = [
    '{ rm -f /tmp/code_review_raw.*.json; } 2>/dev/null || true',
    '{ rm -f /tmp/code_review_findings.*.json; } 2>/dev/null || true',
    '{ rm -f /tmp/code_review_dropped.*.json; } 2>/dev/null || true',
    'rm -f /tmp/code_review_proof.json /tmp/code_review_diff.txt',
  ];
  for (const line of removals) assert.ok(bash.split('\n').includes(line), `Initialize runs: ${line}`);
  assert.ok(
    bash.includes('if [ "$ENGINE" = "code-review" ]; then\n  agent-review capture disarm >/dev/null 2>&1 || true\nfi'),
    'Initialize disarms capture, and only under the code-review engine',
  );

  const { writeFileSync, existsSync } = require('node:fs');
  for (const shell of availableShells(t)) {
    const dir = mkdtempSync(join(os.tmpdir(), 'ar-init-'));
    try {
      writeFileSync(join(dir, 'code_review_raw.old-1.json'), '[]');
      writeFileSync(join(dir, 'code_review_proof.json'), '{}');
      const script = `set -e\n${removals.join('\n')}\necho survived`.replaceAll('/tmp/', `${dir}/`);
      const run = require('node:child_process').spawnSync(shell, ['-c', script], { encoding: 'utf8' });
      assert.strictEqual(run.stdout, 'survived\n', `${shell}: a glob with no match never stops Initialize`);
      assert.strictEqual(run.stderr, '', `${shell}: a glob with no match prints nothing`);
      assert.ok(!existsSync(join(dir, 'code_review_raw.old-1.json')) && !existsSync(join(dir, 'code_review_proof.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the review skill never names the capture file, and the proof takes no --capture', () => {
  for (const [name, text] of [['SKILL.md', readFileSync(REVIEW_SKILL, 'utf8')], ['code-review-engine.md', engineDoc()]]) {
    for (const path of ['code_review_capture', 'agent_review_capture', '/tmp/agent-review-']) {
      assert.ok(!text.includes(path), `${name} must not name ${path}; the capture lives in a private directory`);
    }
    assert.ok(!text.includes('--capture'), `${name} must not pass --capture; the proof finds the capture itself`);
  }
});

test('Initialize keeps going when the capture dir does not exist', (t) => {
  const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
  const { dirname } = require('node:path');
  const init = bashBlocks(stageSlice(readFileSync(REVIEW_SKILL, 'utf8'), '### Initialize', '### Gather PR Context & Diff Manifest'));
  const gated = /^if \[ "\$ENGINE" = "code-review" \]; then\n {2}agent-review capture disarm[^\n]*\nfi$/m.exec(init);
  assert.ok(gated, 'Initialize has the engine-gated disarm');
  const PATH = `${join(ROOT, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`;
  const run = (shell, engine, captureDir) =>
    require('node:child_process').spawnSync(shell, ['-c', `set -e\n${gated[0]}\necho survived`], {
      encoding: 'utf8',
      env: { PATH, ENGINE: engine, AGENT_REVIEW_CAPTURE_DIR: captureDir },
    });
  for (const shell of availableShells(t)) {
    const parent = mkdtempSync(join(os.tmpdir(), 'ar-init-disarm-'));
    try {
      const missing = join(parent, 'missing');
      const fresh = run(shell, 'code-review', missing);
      assert.strictEqual(fresh.stdout, 'survived\n', `${shell}: a fresh machine with no capture dir must not stop Initialize (${fresh.stderr})`);
      assert.strictEqual(fresh.stderr, '', `${shell}: the disarm is quiet`);
      assert.strictEqual(existsSync(missing), false, `${shell}: disarm never creates the dir`);

      const dir = join(parent, 'capture');
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'agent_review_capture.json'), '{"armed":true}');
      assert.strictEqual(run(shell, 'agent-review', dir).stdout, 'survived\n');
      assert.ok(existsSync(join(dir, 'agent_review_capture.json')), `${shell}: the default engine never touches capture`);
      assert.strictEqual(run(shell, 'code-review', dir).stdout, 'survived\n');
      assert.strictEqual(existsSync(join(dir, 'agent_review_capture.json')), false, `${shell}: an old arm is cleared`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

const skillText = (name) => readFileSync(join(ROOT, `skills/${name}/SKILL.md`), 'utf8');

test('init 3C and 3E decide CI copying from the REVIEWS_RUN answer saved in 3A, not from config get', () => {
  const init = skillText('init');
  const threeA = stageSlice(init, '### 3A', '### 3B');
  assert.ok(/export REVIEWS_RUN=/.test(threeA) && threeA.includes('>> /tmp/agent_review_init.sh'), '3A persists REVIEWS_RUN to the env file');
  const rest = stageSlice(init, '### 3C', '### 3F');
  assert.ok(!rest.includes('config get reviews_run'), '3C-3E must not read reviews_run back from a config that may not load yet');
  assert.ok(rest.includes('if [ "$REVIEWS_RUN" = "local-and-ci" ]; then'), '3C and 3E gate on REVIEWS_RUN');
  assert.strictEqual(rest.split('if [ "$REVIEWS_RUN" = "local-and-ci" ]; then').length - 1, 2);
});

test('init keeps the approval answer in BOT_APPROVES and flips auto_approve without -i.bak or rm *.bak', () => {
  const init = skillText('init');
  assert.ok(/BOT_APPROVES="/.test(stageSlice(init, '### 3A', '### 3B')), '3A persists BOT_APPROVES');
  const threeC = stageSlice(init, '### 3C', '### 3D');
  const block = [...threeC.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('auto_approve: false'));
  assert.ok(block, 'the approval-off block exists');
  assert.ok(block.includes('. /tmp/agent_review_init.sh'), 'it sources the env file');
  assert.ok(block.includes('if [ "$BOT_APPROVES" = "no" ]; then'), 'wrapped in the answer');
  assert.ok(/sed [^\n]*> "\$tmp"/.test(block) && block.includes('cat "$tmp" > "$w"'), 'sed to a temp file, then write back in place (keeps the mode)');
  assert.ok(!block.includes('-i.bak') && !block.includes('.bak'), 'no .bak files');
});

test('init names no consuming repo in the approval advice', () => {
  const init = skillText('init');
  assert.ok(!init.includes('staff_accounting_app'));
  assert.ok(!init.includes('PCI-scope'));
  assert.ok(init.replace(/\s+/g, ' ').includes('recommend no for repos your team requires human review on, such as payment or financial code'));
});

test('update-files treats a classic-protection 404 as could-not-verify unless the user is an admin', () => {
  const s = stageSlice(skillText('update-files'), '### Local-only repo with CI files still installed', '### Diff and PR');
  assert.ok(/a 404 counts as "could not verify"/.test(s.replace(/\s+/g, ' ')), 'the 404 is tied to could-not-verify');
  assert.ok(s.includes('gh api "repos/$REPO" --jq .permissions.admin'), 'admin check reuses $REPO');
  assert.ok(s.includes('`true`') && /explicit yes/.test(s), 'non-admin 404 warns and needs an explicit yes');
  assert.ok(!s.includes('a 404 means none is set'), 'the old "404 means none" rule is gone');
});

test('update-files offers a missing approve workflow by default in a local-only repo and never offers CI removal without it', () => {
  const s = skillText('update-files');
  assert.ok(s.includes('this is the only path that approves'));
  assert.ok(/never offer[^.]*removal[^.]*while[^.]*approve/i.test(s.replace(/\s+/g, ' ')), 'CI removal is not offered while approve is missing');
});

test('address tells a local-only author to run /agent-review:re-review and promises no CI re-review', () => {
  const s = skillText('address');
  assert.ok(s.includes('`reviews_run` is `local`'));
  assert.ok(s.includes('/agent-review:re-review'));
  assert.ok(!s.includes('The push triggers an incremental re-review'), 'no unconditional CI re-review promise');
  assert.ok(!s.includes('the push still triggers an incremental CI re-review'), 'check mode no longer promises CI either');
});

test('yolo-review stops and shows the error when the review fails before posting', () => {
  const s = skillText('yolo-review');
  assert.ok(/fails before posting[^.]*stop[^.]*error/i.test(s.replace(/\s+/g, ' ')));
  assert.ok(/never run[s]? address against an older report/i.test(s.replace(/\s+/g, ' ')));
});

test('README labels the engine sample as a local-only code-review example, not the defaults', () => {
  const r = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(!r.includes('These are the defaults, so'));
  assert.ok(/example of a local-only, code-review repo/.test(r.replace(/\s+/g, ' ')));
});

test('init saves shadow as no and validates its answers, update-files guards Stage 4, address and yolo-review guard CI and stale reports', () => {
  const init = skillText('init');
  const flat = init.replace(/\s+/g, ' ');
  assert.ok(flat.includes('Save `no` for `BOT_APPROVES` whenever `rollout.mode` is `shadow`'), 'shadow is saved as no');
  const threeA = stageSlice(init, '### 3A', '### 3B');
  assert.ok(threeA.includes('case "$REVIEWS_RUN" in local|local-and-ci)') && threeA.includes('case "$BOT_APPROVES" in yes|no)'), '3A validates both values');
  const threeC = stageSlice(init, '### 3C', '### 3D');
  assert.ok(threeC.includes('cat "$tmp" > "$w"') && threeC.includes('rm -f "$tmp"') && !threeC.includes('mv "$tmp"'), 'keeps file mode, removes temp');
  const upd = skillText('update-files');
  const s4 = stageSlice(upd, '## Stage 4', '### Diff and PR').replace(/\s+/g, ' ');
  assert.ok(s4.includes('Never offer the removal below while the approve workflow is missing') && s4.includes('it is staged and removal is fine'), 'Stage 4 carries the guard');
  const addr = skillText('address').replace(/\s+/g, ' ');
  assert.ok(addr.includes('do not promise a CI re-review') && addr.includes('`undefined` or failed `config get reviews_run` counts as CI'));
  const yolo = skillText('yolo-review');
  assert.ok(yolo.includes('.updated_at') && yolo.includes('[[ "$UPDATED" < "$START_TS" ]]'), 'yolo step 3 has the START_TS guard in the bash block');
});
