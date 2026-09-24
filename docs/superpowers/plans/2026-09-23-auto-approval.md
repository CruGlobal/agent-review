# Auto-approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One engine-owned approval rule, applied by one composite action, reachable from the CI review, the fix/dismiss interaction, and locally posted reports, each opt-in via `auto_approve`.

**Architecture:** `engine/approval.cjs` decides from a report body and the PR head; `agent-review approval` exposes it on the CLI; `.github/actions/approve` fetches the report, runs the command, and posts the approval. `interact.yml` swaps its inline shell for the action, `review.yml` gains an opt-in `approve` job, and a new reusable `approve.yml` plus consumer template `agent-review-approve.yml` cover locally posted reports. Ships as 0.7.0.

**Tech Stack:** Node 20+ CommonJS engine bundled with esbuild into `dist/agent-review.cjs`; `node:test` via `npm test`; GitHub Actions composite action and reusable workflows; `yaml` package (already a dependency) for workflow tests.

**Spec:** `docs/specs/2026-09-23-auto-approval-design.md`

## Global Constraints

- Every path fails closed, never requests changes, and downgrades an approval API failure to `::warning::`.
- The legacy `- [ ]` checkbox fallback is dropped: a report without a status marker never approves.
- Callers reference the action and workflows at `@main`, matching the existing runtime checkout pinning.
- `auto_approve` is a boolean input defaulting to `false` on all three reusable workflows; both consumer templates that expose it pass the literal `false`.
- The approve template triggers only on `issue_comment: types: [created]`, never `edited`.
- Release is 0.7.0: `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, and the marker on all four templates must agree; `npm run stamp-templates` must be re-run; `dist/` must be rebuilt and committed (`npm run check-dist`).
- No new npm dependencies.
- Run every command from the worktree root `/Users/danielbisgrove/Documents/Web_Dev/agent-review-wt/auto-approval` on branch `feat/auto-approval`.

## Review Focus

1. Report bodies with CRLF line endings (GitHub returns `\r\n` for comments edited in the web UI): markers must still match. Pinned in Task 1.
2. A head SHA with surrounding whitespace or uppercase hex (command substitution adds a newline): must compare equal after normalization. Pinned in Task 1.
3. A status marker whose `pass` is the string `"true"` rather than boolean `true`: must not approve. Pinned in Task 1.
4. A report that quotes a marker line later in its body (for example in the ledger explanation): the first, top-of-comment marker wins. Pinned in Task 1.
5. `enforce` rollout must approve exactly like `advisory`; any other non-shadow value is rejected. Pinned in Task 1.

---

### Task 1: Engine approval rule

**Files:**
- Create: `engine/approval.cjs`
- Test: `engine/approval.test.cjs`

**Interfaces:**
- Produces: `evaluateApproval(body: string, { head: string }) => { approve: boolean, reason: string }` and `MARKER = '<!-- agent-review -->'`. Task 2 calls `evaluateApproval`; the action in Task 3 reads the JSON it prints.

- [ ] **Step 1: Install dependencies in the worktree**

Run: `npm ci`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 2: Write the failing tests**

Create `engine/approval.test.cjs`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateApproval } = require('./approval.cjs');

const HEAD = 'abc123def4567890abc123def4567890abc12345';

function report({ marker = true, rollout = 'advisory', head = HEAD, status = { v: 1, head: HEAD, pass: true, irreversible: false }, statusRaw, eol = '\n' } = {}) {
  const lines = [];
  if (marker) lines.push('<!-- agent-review -->');
  if (rollout !== null) lines.push(`<!-- agent-review-rollout: ${rollout} -->`);
  if (head !== null) lines.push(`<!-- agent-review-head: ${head} -->`);
  if (statusRaw !== undefined) lines.push(`<!-- agent-review-status: ${statusRaw} -->`);
  else if (status !== null) lines.push(`<!-- agent-review-status: ${JSON.stringify(status)} -->`);
  lines.push('', '# 🤖 Multi-Agent Code Review Report', '', 'body text');
  return lines.join(eol);
}

test('approves an advisory report whose head and status match the PR head', () => {
  const result = evaluateApproval(report(), { head: HEAD });
  assert.equal(result.approve, true);
  assert.match(result.reason, /passes/);
});

test('approves an enforce report the same way', () => {
  assert.equal(evaluateApproval(report({ rollout: 'enforce' }), { head: HEAD }).approve, true);
});

test('never approves without an expected head', () => {
  assert.equal(evaluateApproval(report(), {}).approve, false);
  assert.equal(evaluateApproval(report(), { head: '  ' }).approve, false);
});

test('refuses a body that is not an agent-review report', () => {
  const result = evaluateApproval(report({ marker: false }), { head: HEAD });
  assert.equal(result.approve, false);
  assert.match(result.reason, /not an agent-review report/);
  assert.equal(evaluateApproval('', { head: HEAD }).approve, false);
  assert.equal(evaluateApproval(undefined, { head: HEAD }).approve, false);
});

test('refuses a report with no rollout marker, a shadow one, or an unknown one', () => {
  assert.match(evaluateApproval(report({ rollout: null }), { head: HEAD }).reason, /no rollout marker/);
  assert.match(evaluateApproval(report({ rollout: 'shadow' }), { head: HEAD }).reason, /shadow/);
  assert.match(evaluateApproval(report({ rollout: 'yolo' }), { head: HEAD }).reason, /unknown rollout/);
});

test('refuses a report whose reviewed head is missing or differs from the PR head', () => {
  assert.match(evaluateApproval(report({ head: null }), { head: HEAD }).reason, /no reviewed-head marker/);
  const stale = evaluateApproval(report({ head: 'ffff' + HEAD.slice(4) }), { head: HEAD });
  assert.equal(stale.approve, false);
  assert.match(stale.reason, /PR head/);
});

test('refuses a report with no status marker or an unparseable one', () => {
  assert.match(evaluateApproval(report({ status: null }), { head: HEAD }).reason, /no status marker/);
  assert.match(evaluateApproval(report({ statusRaw: '{not json' }), { head: HEAD }).reason, /not valid JSON/);
  assert.match(evaluateApproval(report({ statusRaw: '"pass"' }), { head: HEAD }).reason, /not valid JSON|not an object/);
});

test('refuses a failing, irreversible, or head-disagreeing status', () => {
  const failing = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 2 } }), { head: HEAD });
  assert.equal(failing.approve, false);
  assert.match(failing.reason, /2 open blockers/);
  const irreversible = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: true, irreversible: true } }), { head: HEAD });
  assert.equal(irreversible.approve, false);
  assert.match(irreversible.reason, /irreversible/);
  const disagree = evaluateApproval(report({ status: { v: 1, head: '0000' + HEAD.slice(4), pass: true } }), { head: HEAD });
  assert.equal(disagree.approve, false);
  assert.match(disagree.reason, /status head/);
});

test('a status without a head field is judged by the head marker alone', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, pass: true, irreversible: false } }), { head: HEAD }).approve, true);
});

test('pass must be boolean true, not a truthy string', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, head: HEAD, pass: 'true' } }), { head: HEAD }).approve, false);
});

test('tolerates CRLF bodies and whitespace or case differences in the expected head', () => {
  assert.equal(evaluateApproval(report({ eol: '\r\n' }), { head: HEAD }).approve, true);
  assert.equal(evaluateApproval(report(), { head: `${HEAD.toUpperCase()}\n` }).approve, true);
});

test('the first marker of each kind wins over one quoted later in the body', () => {
  const body = report() + '\n<!-- agent-review-head: 1111111111111111111111111111111111111111 -->\n';
  assert.equal(evaluateApproval(body, { head: HEAD }).approve, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test engine/approval.test.cjs`
Expected: FAIL with `Cannot find module './approval.cjs'`.

- [ ] **Step 4: Write the implementation**

Create `engine/approval.cjs`:

```js
'use strict';
// Decides whether a published agent-review report authorizes approving its PR.
// The CI review, the fix/dismiss interaction, and a locally posted report all
// run this one rule; the shell around it only fetches the report and posts the
// approval. Fails closed: any missing, malformed, or disagreeing marker is a no.
const MARKER = '<!-- agent-review -->';
const ROLLOUTS_THAT_APPROVE = new Set(['advisory', 'enforce']);

// First `<!-- agent-review-<name>: … -->` line in the body. The hidden markers
// sit at the top of the comment, so the first match is the trusted one even if
// the visible report later quotes a marker line.
function markerLine(text, name) {
  const m = text.match(new RegExp(`^<!-- agent-review-${name}: (.*) -->$`, 'm'));
  return m ? m[1].trim() : null;
}

function no(reason) {
  return { approve: false, reason };
}

function evaluateApproval(body, { head } = {}) {
  const expected = String(head || '').trim().toLowerCase();
  if (!expected) return no('no expected head SHA supplied');
  const text = String(body || '').replace(/\r/g, '');
  if (!text.startsWith(MARKER)) return no('not an agent-review report');

  const rollout = markerLine(text, 'rollout');
  if (!rollout) return no('report carries no rollout marker');
  if (rollout === 'shadow') return no('shadow reports never approve');
  if (!ROLLOUTS_THAT_APPROVE.has(rollout)) return no(`unknown rollout mode "${rollout}"`);

  const reportHead = markerLine(text, 'head');
  if (!reportHead) return no('report carries no reviewed-head marker');
  if (reportHead.toLowerCase() !== expected) {
    return no(`report covers ${reportHead} but the PR head is ${expected}`);
  }

  const statusRaw = markerLine(text, 'status');
  if (!statusRaw) return no('report carries no status marker');
  let status;
  try {
    status = JSON.parse(statusRaw);
  } catch {
    return no('status marker is not valid JSON');
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return no('status marker is not an object');
  }
  if (status.head !== undefined && String(status.head).toLowerCase() !== expected) {
    return no(`status head ${status.head} disagrees with the PR head ${expected}`);
  }
  if (status.pass !== true) {
    const open = Number.isInteger(status.openBlockers) ? status.openBlockers : 'unknown';
    return no(`status is not passing (${open} open blockers)`);
  }
  if (status.irreversible === true) return no('change is irreversible; a human must approve');

  return {
    approve: true,
    reason: `report for ${expected} passes with no open blockers and the change is reversible`,
  };
}

module.exports = { evaluateApproval, MARKER };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test engine/approval.test.cjs`
Expected: all 12 tests PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS (the suite requires every `*.test.cjs`, so the new file is picked up automatically).

- [ ] **Step 7: Commit**

```bash
git add engine/approval.cjs engine/approval.test.cjs
git commit -m "feat(engine): approval rule for published reports"
```

---

### Task 2: CLI `approval` command

**Files:**
- Modify: `engine/cli.cjs` (require block near line 34; `USAGE` string near line 207; new `case` before `case 'evidence':` near line 520)
- Test: `engine/cli.test.cjs`

**Interfaces:**
- Consumes: `evaluateApproval` from Task 1.
- Produces: `agent-review approval --report <file> --head <sha>` printing `{"approve":…,"reason":"…"}` on one line and exiting 0; exits 1 with a usage line when a flag is missing. Task 3's action parses `.approve` and `.reason` with `jq`.

- [ ] **Step 1: Write the failing test**

Append to `engine/cli.test.cjs` (the file already defines `run(args)` which captures stdout and returns `{ code, out }` or similar; read its first 35 lines and use the same helper name and return shape):

```js
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
  assert.deepEqual(JSON.parse(ok.out), {
    approve: true,
    reason: `report for ${head} passes with no open blockers and the change is reversible`,
  });
  const stale = run(['approval', '--report', file, '--head', '0000000000000000000000000000000000000000']);
  assert.equal(stale.code, 0);
  assert.equal(JSON.parse(stale.out).approve, false);
  const usage = run(['approval', '--report', file]);
  assert.equal(usage.code, 1);
  assert.match(usage.out, /usage: agent-review approval/);
  rmSync(dir, { recursive: true, force: true });
});
```

If `run` returns different property names (check lines 17-32 of the file), adapt `.code` / `.out` to match; do not add a second helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/cli.test.cjs`
Expected: the new test FAILS (unknown command returns 1 and prints the usage banner, so `ok.code` is 1).

- [ ] **Step 3: Wire the command**

In `engine/cli.cjs`:

1. After `const { mergeLedger, buildStatus } = require('./reportState.cjs');` add:

```js
const { evaluateApproval } = require('./approval.cjs');
```

2. In the `USAGE` string, directly after the `status --ledger …` line, add:

```
  approval --report <f> --head <sha>   decide whether a published report authorizes approving its PR
```

3. Directly before `case 'evidence': {` add:

```js
    case 'approval': {
      const reportPath = flag(rest, '--report');
      const head = flag(rest, '--head');
      if (!reportPath || !head) {
        out('usage: agent-review approval --report <f> --head <sha>');
        return 1;
      }
      out(JSON.stringify(evaluateApproval(readFileSync(reportPath, 'utf8'), { head })));
      return 0;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test engine/cli.test.cjs`
Expected: PASS.

- [ ] **Step 5: Rebuild the bundle and run the suite**

Run: `npm run build && npm test`
Expected: `dist/agent-review.cjs` rewritten; suite PASS. Confirm the bundle knows the command:

Run: `node dist/agent-review.cjs approval`
Expected: prints `usage: agent-review approval --report <f> --head <sha>` and exits 1.

- [ ] **Step 6: Commit**

```bash
git add engine/cli.cjs engine/cli.test.cjs dist/agent-review.cjs
git commit -m "feat(cli): approval subcommand"
```

---

### Task 3: Shared composite action

**Files:**
- Create: `.github/actions/approve/action.yml`
- Test: `engine/templates.test.cjs` (append)

**Interfaces:**
- Consumes: `node <runtime>/dist/agent-review.cjs approval --report <f> --head <sha>` from Task 2.
- Produces: action `CruGlobal/agent-review/.github/actions/approve@main` with inputs `pr_number` (required), `report_comment_id` (optional, default `''`), `approval_body` (optional). Tasks 4, 5, 6 call it.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: the new test FAILS with `ENOENT … .github/actions/approve/action.yml`.

- [ ] **Step 3: Create the action**

Create `.github/actions/approve/action.yml`:

```yaml
name: agent-review approve
description: >-
  Approve a pull request when its published agent-review report passes for the
  PR's current head. Fails closed on any missing or disagreeing marker, never
  requests changes, and downgrades an approval API failure to a warning.
inputs:
  pr_number:
    description: Pull request number
    required: true
  report_comment_id:
    description: >-
      Issue-comment id of the report to judge. Empty selects the first PR comment
      authored by github-actions[bot] whose body starts with the agent-review marker.
    required: false
    default: ''
  approval_body:
    description: Review body posted on approval
    required: false
    default: >-
      Auto-approved: the agent-review report for this head passes with no open
      blockers and the change is reversible.
runs:
  using: composite
  steps:
    - name: Load the trusted approval runtime
      uses: actions/checkout@v6
      with:
        repository: CruGlobal/agent-review
        ref: main
        path: .agent-review-approve-runtime
        persist-credentials: false
    - name: Judge the report and approve when it passes
      shell: bash
      env:
        GH_TOKEN: ${{ github.token }}
        REPO: ${{ github.repository }}
        PR: ${{ inputs.pr_number }}
        REPORT_COMMENT_ID: ${{ inputs.report_comment_id }}
        APPROVAL_BODY: ${{ inputs.approval_body }}
      run: |
        set -euo pipefail
        RUNTIME_DIR="$RUNNER_TEMP/agent-review-approve-runtime"
        rm -rf "$RUNTIME_DIR"
        mv .agent-review-approve-runtime "$RUNTIME_DIR"
        REPORT="$RUNNER_TEMP/agent-review-approve-report.md"
        if [ -n "$REPORT_COMMENT_ID" ]; then
          gh api "repos/$REPO/issues/comments/$REPORT_COMMENT_ID" --jq '.body // empty' > "$REPORT"
        else
          gh api "repos/$REPO/issues/$PR/comments" --paginate \
            | jq -sr '[.[][] | select(.user.login == "github-actions[bot]") | select(.body | startswith("<!-- agent-review -->"))] | first | .body // empty' \
            > "$REPORT"
        fi
        if [ ! -s "$REPORT" ]; then
          echo "No agent-review report found for PR #$PR — not approving." | tee -a "$GITHUB_STEP_SUMMARY"
          exit 0
        fi
        HEAD_SHA=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
        DECISION=$(node "$RUNTIME_DIR/dist/agent-review.cjs" approval --report "$REPORT" --head "$HEAD_SHA")
        APPROVE=$(printf '%s' "$DECISION" | jq -r '.approve')
        REASON=$(printf '%s' "$DECISION" | jq -r '.reason')
        if [ "$APPROVE" != "true" ]; then
          echo "Not approving PR #$PR: $REASON" | tee -a "$GITHUB_STEP_SUMMARY"
          exit 0
        fi
        # Needs the repo/org setting "Allow GitHub Actions to create and approve
        # pull requests" (off by GitHub default). A 422 here means it is disabled:
        # warn instead of failing, so a passing review never shows as a red check.
        if gh pr review "$PR" --repo "$REPO" --approve --body "$APPROVAL_BODY"; then
          echo "Approved PR #$PR: $REASON" | tee -a "$GITHUB_STEP_SUMMARY"
        else
          echo "::warning::Review passed but approval failed — enable 'Allow GitHub Actions to create and approve pull requests' in repo/org Actions settings."
        fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test engine/templates.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/actions/approve/action.yml engine/templates.test.cjs
git commit -m "feat(actions): shared approve action driven by the engine rule"
```

---

### Task 4: Interact uses the shared action

**Files:**
- Modify: `.github/workflows/interact.yml` (the step named `Approve when the ledger is fully addressed and the change is reversible`, around lines 485-526)
- Test: `engine/templates.test.cjs` (append)

**Interfaces:**
- Consumes: the action from Task 3.
- Produces: nothing new; the `auto_approve` input and gating are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
test('interact.yml approves through the shared action, gated by auto_approve', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(INTERACT_WORKFLOW, 'utf8'));
  const step = doc.jobs.publish.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.ok(step, 'publish job must call the shared approve action');
  assert.equal(step.if, 'inputs.auto_approve');
  assert.equal(step.with.pr_number, '${{ inputs.pr_number }}');
  assert.match(step.with.approval_body, /fixed or dismissed/);
  const body = readFileSync(INTERACT_WORKFLOW, 'utf8');
  assert.ok(!body.includes('gh pr review'), 'interact.yml must not carry its own approval shell');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: the new test FAILS (`step` is undefined).

- [ ] **Step 3: Replace the inline step**

In `.github/workflows/interact.yml`, delete the whole step that begins `- name: Approve when the ledger is fully addressed and the change is reversible` (its `if:`, `env:`, and multi-line `run:` block, ending with the `fi` after the `::warning::` line) and put this in its place, keeping the same indentation as the neighbouring steps:

```yaml
      - name: Approve when the ledger is fully addressed and the change is reversible
        if: inputs.auto_approve
        uses: CruGlobal/agent-review/.github/actions/approve@main
        with:
          pr_number: ${{ inputs.pr_number }}
          approval_body: >-
            Auto-approved: every agent-review finding is fixed or dismissed with
            a reason, and the change is reversible.
```

The following step `Delete the successful handoff artifact` must remain untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, including the existing interact structure tests.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/interact.yml engine/templates.test.cjs
git commit -m "refactor(interact): approve through the shared action"
```

---

### Task 5: Review workflow opt-in approve job

**Files:**
- Modify: `.github/workflows/review.yml` (inputs block lines 4-14; append a job after `report-failure`)
- Test: `engine/templates.test.cjs` (append)

**Interfaces:**
- Consumes: the action from Task 3.
- Produces: `workflow_call` input `auto_approve` (boolean, default false) and job `approve`. Task 7's template passes `auto_approve: false`.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
test('review.yml approves only when the caller opts in and the review job succeeded', () => {
  const { parse } = require('yaml');
  const doc = parse(readFileSync(REVIEW_WORKFLOW, 'utf8'));
  const on = doc.on || doc[true];
  assert.equal(on.workflow_call.inputs.auto_approve.type, 'boolean');
  assert.equal(on.workflow_call.inputs.auto_approve.default, false);
  const job = doc.jobs.approve;
  assert.ok(job, 'review.yml must define an approve job');
  assert.equal(job.needs, 'review', 'a failed or skipped review must never reach the approver');
  assert.equal(job.if, 'inputs.auto_approve');
  assert.deepEqual(job.permissions, { 'pull-requests': 'write' });
  const step = job.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.equal(step.with.pr_number, '${{ github.event.pull_request.number }}');
  assert.equal(step.with.report_comment_id, undefined, 'CI judges only the bot report');
  assert.ok(doc.jobs['report-failure'], 'report-failure job must survive');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS on `auto_approve` being undefined.

- [ ] **Step 3: Add the input and the job**

In `.github/workflows/review.yml`, after the `rollout_mode:` input (its `default: shadow` line), add:

```yaml
      auto_approve:
        description: Approve the PR when the published report passes for the current head; shadow reports never approve
        type: boolean
        default: false
```

At the end of the file, after the `report-failure` job's last line, add:

```yaml

  # Opt-in. Reads only the bot-authored report the publish step validated, so a
  # hand-typed marker comment can never be the one judged. `needs: review` with
  # a plain `if:` means a failed or skipped review never reaches this job.
  approve:
    needs: review
    if: inputs.auto_approve
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: CruGlobal/agent-review/.github/actions/approve@main
        with:
          pr_number: ${{ github.event.pull_request.number }}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. The existing `review.yml stays YAML-parseable` test and the permissions slice test (which reads everything before `  report-failure:`) still pass because the review job is untouched.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/review.yml engine/templates.test.cjs
git commit -m "feat(review): opt-in approve job after a passing CI review"
```

---

### Task 6: Reusable approval workflow for locally posted reports

**Files:**
- Create: `.github/workflows/approve.yml`
- Test: `engine/templates.test.cjs` (append)

**Interfaces:**
- Consumes: the action from Task 3.
- Produces: reusable workflow `CruGlobal/agent-review/.github/workflows/approve.yml@main` with inputs `pr_number` (string, required), `comment_id` (string, required), `auto_approve` (boolean, default false). Task 7's template calls it.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
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
  assert.deepEqual(job.permissions, { 'pull-requests': 'write' });
  const step = job.steps.find((s) => s.uses === 'CruGlobal/agent-review/.github/actions/approve@main');
  assert.equal(step.with.pr_number, '${{ inputs.pr_number }}');
  assert.equal(step.with.report_comment_id, '${{ inputs.comment_id }}');
  assert.ok(!readFileSync(join(ROOT, '.github/workflows/approve.yml'), 'utf8').includes('gh pr review'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS with `ENOENT … approve.yml`.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/approve.yml`:

```yaml
name: agent-review approve (reusable)
# Judges a report that a trusted collaborator posted from a local review run
# ("Post review to GitHub"). Unlike the CI path, the report here is authored by
# a person, so enabling auto_approve on a caller trusts that person's posted
# report; the head, rollout, and status rules still apply.
on:
  workflow_call:
    inputs:
      pr_number:
        type: string
        required: true
      comment_id:
        type: string
        required: true
      auto_approve:
        description: Approve the PR when the posted report passes for the current head; shadow reports never approve
        type: boolean
        default: false

jobs:
  approve:
    if: >-
      inputs.auto_approve &&
      github.event_name == 'issue_comment' &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: CruGlobal/agent-review/.github/actions/approve@main
        with:
          pr_number: ${{ inputs.pr_number }}
          report_comment_id: ${{ inputs.comment_id }}
          approval_body: >-
            Auto-approved: the posted agent-review report covers the current head,
            passes with no open blockers, and the change is reversible.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/approve.yml engine/templates.test.cjs
git commit -m "feat(approve): reusable workflow for locally posted reports"
```

---

### Task 7: Templates and the 0.7.0 release bump

**Files:**
- Modify: `templates/workflows/agent-review.yml`
- Create: `templates/workflows/agent-review-approve.yml`
- Modify: `templates/workflows/agent-review-interact.yml`, `templates/workflows/agent-review-readiness.yml` (marker only)
- Modify: `engine/stampTemplates.cjs:13`, `engine/templates.test.cjs` (the two `for (const name of […])` loops around lines 305 and 318, plus a new test)
- Modify: `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, `templates/workflows/template-manifest.json`

**Interfaces:**
- Consumes: `approve.yml` (Task 6) and the `auto_approve` input on `review.yml` (Task 5).
- Produces: consumer templates carrying marker `0.7.0`.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
test('the approve template is opt-in, created-only, collaborator-gated, and the review caller shows the knob', () => {
  const template = readFileSync(join(ROOT, 'templates/workflows/agent-review-approve.yml'), 'utf8');
  assert.ok(template.includes('auto_approve: false'));
  assert.ok(template.includes('types: [created]'), 'edited must never re-issue an approval');
  assert.ok(!/types: \[[^\]]*edited/.test(template));
  assert.ok(template.includes("startsWith(github.event.comment.body, '<!-- agent-review -->')"));
  assert.ok(template.includes('"OWNER","MEMBER","COLLABORATOR"'));
  assert.ok(template.includes('uses: CruGlobal/agent-review/.github/workflows/approve.yml@main'));
  assert.ok(template.includes('comment_id: ${{ github.event.comment.id }}'));
  assert.match(template, /permissions:\n      pull-requests: write/);
  const review = readFileSync(join(ROOT, 'templates/workflows/agent-review.yml'), 'utf8');
  assert.ok(review.includes('auto_approve: false'), 'the review caller must show the opt-in knob');
});
```

Then, in the existing versioning test, change both occurrences of

```js
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml']) {
```

to

```js
  for (const name of ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml', 'agent-review-approve.yml']) {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS with `ENOENT … agent-review-approve.yml`.

- [ ] **Step 3: Edit the templates**

In `templates/workflows/agent-review.yml`, after `      rollout_mode: shadow` add:

```yaml
      # Approve the PR when the CI report passes for the current head. Leave
      # false until `agent-review rollout` passes and a maintainer decides.
      auto_approve: false
```

Create `templates/workflows/agent-review-approve.yml`:

```yaml
# agent-review-template-version: 0.7.0
name: agent-review approve
on:
  issue_comment:
    types: [created]
jobs:
  approve:
    # A review run locally and posted with "Post review to GitHub" starts with
    # the agent-review marker. Only trusted collaborators' posts count, shadow
    # reports never approve, and the report must cover the PR's current head.
    # Enabling auto_approve here trusts the poster's report — a stronger grant
    # than the CI path, which judges only the bot's own report.
    if: >-
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '<!-- agent-review -->') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    permissions:
      pull-requests: write
    uses: CruGlobal/agent-review/.github/workflows/approve.yml@main
    with:
      pr_number: ${{ github.event.issue.number }}
      comment_id: ${{ github.event.comment.id }}
      auto_approve: false
```

Change the first line of `templates/workflows/agent-review.yml`, `templates/workflows/agent-review-interact.yml`, and `templates/workflows/agent-review-readiness.yml` from `# agent-review-template-version: 0.6.0` to `# agent-review-template-version: 0.7.0`.

- [ ] **Step 4: Register the template and bump the version**

In `engine/stampTemplates.cjs` change line 13 to:

```js
const TEMPLATES = ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml', 'agent-review-approve.yml'];
```

Set `"version": "0.7.0"` in `.claude-plugin/plugin.json` and `package.json`, then:

```bash
npm install --package-lock-only
npm run stamp-templates
```

Expected: `stamped v0.7.0 into templates/workflows/template-manifest.json`; the manifest gains a `"0.7.0"` entry with four hashes; `package-lock.json` shows `0.7.0` in its two version fields.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run check-dist`
Expected: PASS; `check-dist` rebuilds `dist/` and `git diff --exit-code dist/` is clean (the bundle was already rebuilt in Task 2 and no engine source changed since; if it reports a diff, `git add dist/` in the next step).

- [ ] **Step 6: Commit**

```bash
git add templates/workflows engine/stampTemplates.cjs engine/templates.test.cjs .claude-plugin/plugin.json package.json package-lock.json dist/
git commit -m "chore: release 0.7.0 — auto-approval templates"
```

---

### Task 8: Documentation and skills

**Files:**
- Modify: `README.md` (`## CI setup` from line 122; `## Updating` from line 168)
- Modify: `skills/update-files/SKILL.md` (intro paragraph; Stage 1 loop; Stage 2 missing-file bullet; Stage 3 `auto_approve` bullet)
- Modify: `skills/init/SKILL.md` (template list near line 34; summary item 7 near line 623)
- Modify: `skills/review/SKILL.md` (Stage 7 interactive menu case `2)`, near the `echo "✅ Review posted"` line)
- Test: `engine/templates.test.cjs` (append)

**Interfaces:**
- Consumes: the file and input names from Tasks 5-7.
- Produces: nothing executable.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
test('the docs and skills know the approve template and the review-side auto_approve knob', () => {
  const update = readFileSync(join(ROOT, 'skills/update-files/SKILL.md'), 'utf8');
  assert.ok(update.includes('agent-review-approve.yml'), 'update-files must fetch and offer the approve template');
  assert.ok(update.includes('review, interact, and approve'), 'auto_approve is carried over on every caller');
  const init = readFileSync(join(ROOT, 'skills/init/SKILL.md'), 'utf8');
  assert.ok(init.includes('../../templates/workflows/agent-review-approve.yml'));
  const review = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(review.includes('agent-review-approve.yml'), 'the post-to-GitHub handler must say a posted report can trigger approval');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('agent-review-approve.yml'));
  assert.ok(readme.includes('stronger trust grant'), 'README must state the local-post trust boundary');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS on the update-files assertion.

- [ ] **Step 3: Update `skills/update-files/SKILL.md`**

1. In the intro paragraph, change `(`agent-review.yml`, `agent-review-interact.yml`, `agent-review-readiness.yml`)` to `(`agent-review.yml`, `agent-review-interact.yml`, `agent-review-readiness.yml`, `agent-review-approve.yml`)`.
2. In the Stage 1 `for f in …` loop, change the list to `agent-review.yml agent-review-interact.yml agent-review-readiness.yml agent-review-approve.yml`.
3. In Stage 2, replace the "File missing" bullet with:

```markdown
- **File missing**: the repo never installed that piece. Offer it, don't force it — ask the
  user whether to add it, and default to skipping `agent-review-readiness.yml` (the rollout
  gate) and `agent-review-approve.yml` (approval of locally posted reports; a stronger trust
  grant than the CI path) unless they want them.
```

4. In Stage 3, replace the `auto_approve` bullet with:

```markdown
- **`auto_approve`** (review, interact, and approve): keep the repo's value on each caller
  (e.g. `mpdx_api` runs `false` everywhere). A repo that expresses it as
  `${{ vars.SOMETHING == 'true' }}` keeps that expression verbatim.
```

- [ ] **Step 4: Update `skills/init/SKILL.md`**

After the line `- rollout-readiness workflow: `../../templates/workflows/agent-review-readiness.yml`` add:

```markdown
- local-post approval workflow (optional): `../../templates/workflows/agent-review-approve.yml`
```

Replace summary item 7 with:

```markdown
7. **CI workflows** — the review, fix/dismiss interaction, readiness, and (optional) local-post
   approval workflow contents and where they land. Call out that every `auto_approve` is
   `false` in shadow mode, and that the approval workflow trusts a collaborator's posted
   report rather than the bot's.
```

- [ ] **Step 5: Update `skills/review/SKILL.md`**

In the Stage 7 menu handler, directly after the line containing `&& echo "✅ Review posted"` (inside case `2)`), add a comment line at the same indentation:

```bash
      # A consumer running agent-review-approve.yml with auto_approve enabled judges this
      # comment: it approves the PR only if the report covers the current head and passes.
```

- [ ] **Step 6: Update `README.md`**

In `## CI setup`, after the paragraph beginning `Copy `templates/workflows/agent-review-interact.yml` as well` (it ends `records outcomes from same-repository PRs only.`), add:

```markdown
The review workflow can also approve on its own: pass `auto_approve: true` from
`agent-review.yml` and, after the CI review publishes a passing report for the PR's current
head, an `approve` job approves the PR. It judges only the bot-authored report, never a
hand-typed comment. Reports marked `shadow` never approve, an irreversible change never
auto-approves, and a report for an older head is ignored until the incremental re-review lands.

To approve reports that developers run locally and post with the review's "Post review to
GitHub" option, copy `templates/workflows/agent-review-approve.yml` too. It fires on a new PR
comment from an OWNER/MEMBER/COLLABORATOR that starts with the report marker and applies the same
rules. Because that report is authored by the poster rather than the bot, enabling
`auto_approve` there is a stronger trust grant than the CI path — a collaborator could compose
a passing marker comment for the current head. In every path the bot approves regardless of who
authored the PR; keep a branch-protection rule requiring a non-author human approval if that
matters to you. All three approval paths share one rule (`agent-review approval`) and one
composite action (`.github/actions/approve`), fail closed, never request changes, and report an
approval API failure as a warning.
```

In `## Updating`, change `the copied .github/workflows/agent-review*.yml files` line's surrounding prose: replace `preserving the repo's own settings (`auto_approve`, secret names, label gates, pinned refs)` with `preserving the repo's own settings (`auto_approve` on each caller, secret names, label gates, pinned refs)`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add README.md skills/update-files/SKILL.md skills/init/SKILL.md skills/review/SKILL.md engine/templates.test.cjs
git commit -m "docs: auto-approval paths, trust boundary, and skill updates"
```

---

### Task 9: Push, PR, CI, review

**Files:** none new.

- [ ] **Step 1: Final local gate**

Run: `npm test && npm run check-dist && git status --short`
Expected: PASS, PASS, empty status.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/auto-approval
gh pr create --base main --head feat/auto-approval \
  --title "feat: auto-approval for CI, interact, and locally posted reports (0.7.0)" \
  --body-file docs/specs/2026-09-23-auto-approval-design.md
```

Then edit the PR body to prepend a short summary and a note that PR #28 (0.6.2) conflicts on the version files and manifest, and whichever merges second rebases and re-runs `npm run stamp-templates`.

- [ ] **Step 3: Wait for CI**

Run: `gh pr checks --watch`
Expected: `test` SUCCESS. If it fails, read the log with `gh run view --log-failed`, fix, commit, push, repeat.

- [ ] **Step 4: Run the agent-review review on the PR**

Run `/agent-review:review` from the worktree and work any severity ≥ 7 finding with `/agent-review:address` (fix or dismiss with a reason) until the ledger passes. Post the report to the PR from the menu.

- [ ] **Step 5: Manual verification note**

Add a PR comment listing what the automated suite cannot verify: one real Actions run of the composite action in a consumer repo (interact with `auto_approve: true` on a test PR in a repo with "Allow GitHub Actions to create and approve pull requests" enabled), which the README already requires for trusted workflow steps.
