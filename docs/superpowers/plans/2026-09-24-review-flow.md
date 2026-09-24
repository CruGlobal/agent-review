# One-command review flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/agent-review:review` posts and prints its findings; `/agent-review:address` takes fix/dismiss arguments; `/agent-review:re-review` runs a local incremental review; `/agent-review:yolo-review` chains them and waits for the bot's approval; templates ship approving by default.

**Architecture:** The review and address skills gain modes (`incremental`, auto-post + terminal print, argument mode). Two new thin skills drive them. The engine owns the lenient command grammar (`parseCommand` with `lenient`, `agent-review address parse`). Defaults flip to `advisory` + `auto_approve: true` across templates and the config skeleton. Ships as 0.8.0.

**Tech Stack:** Node 20+ CommonJS engine, `node:test`, esbuild bundle in `dist/`, GitHub Actions YAML, markdown skill files read by Claude Code, `yaml` package in tests.

**Spec:** `docs/specs/2026-09-24-review-flow-design.md`

## Global Constraints

- Branch `feat/review-flow` must be rebased onto `main` **after PR #29 (0.7.0) merges** before Task 1 starts; the anchors below are quoted from the 0.7.0 file state.
- Release is 0.8.0: `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, the marker on all four templates; `npm run stamp-templates`; `npm run build`; `npm test` and `npm run check-dist` green.
- No stage text is copied between skills: `re-review` and `yolo-review` invoke `agent-review:review` / `agent-review:address` with arguments.
- Nothing dismisses on the AI's judgment; yolo fixes only.
- Fix scripts under `/tmp/automated_fixes` are never executed by any skill.
- The canonical report comment is the oldest PR comment starting with `<!-- agent-review -->`; a local post updates only a comment the posting user authored (0.7.0 rule).
- Every `npm test` run must stay green at each task's commit; the version bump lives in Task 6 with the template edits so the manifest test never fails at an intermediate commit.
- Run every command from `/Users/danielbisgrove/Documents/Web_Dev/agent-review-wt/review-flow`.

## Review Focus

1. The user's own spelling `fix: 1,2,3,4, dimiss 5,6,7,8` (colon after `fix`, trailing comma before the keyword, `dimiss` typo): must parse to four fixes and four bare dismissals. Pinned in Task 1.
2. `fix all` / `fix blockers` against a ledger where some entries are already fixed or dismissed: only `open` entries expand, and `blockers` means severity ≥ 7. Pinned in Task 1.
3. A number listed twice across clauses (`fix 1 dismiss 1 [other]: x`): rejected, as strict mode already does. Pinned in Task 1.
4. Strict (CI) mode must still reject every lenient form, so a PR comment cannot smuggle a bare dismissal. Pinned in Task 1.
5. A re-review when the canonical comment belongs to the bot and the user has no comment of their own: the previous ledger is still read from the bot's comment and the merged report is posted as the user's new comment. Pinned as a text assertion in Task 2 (the skill must say this) — it cannot be executed in the unit suite.

---

### Task 1: Lenient address grammar in the engine and `agent-review address parse`

**Files:**
- Modify: `engine/addressState.cjs` (`parseCommand`, ~line 91; export list ~line 483)
- Modify: `engine/cli.cjs` (`case 'address'` block ~line 391; `USAGE` ~line 205)
- Test: `engine/addressState.test.cjs`, `engine/cli.test.cjs`

**Interfaces:**
- Produces: `parseCommand(body, { lenient = false, ledger = null } = {})` returning `[{ n, action: 'fix' }]` and `[{ n, action: 'dismiss', reasonCode, reason }]` where `reasonCode`/`reason` are `null` for a bare lenient dismissal. `agent-review address parse --command <file> [--lenient] [--ledger <file>]` prints that array as JSON and exits 0; exits 1 with the error message on invalid syntax. Task 4's skill and Task 5's yolo skill call it.

- [ ] **Step 1: Write the failing engine tests**

Append to `engine/addressState.test.cjs`:

```js
test('parseCommand lenient accepts colons, whitespace-separated clauses, the dimiss typo, and bare dismissals', () => {
  const ops = parseCommand('fix: 1,2,3,4, dimiss 5,6,7,8', { lenient: true });
  assert.deepEqual(ops.map((o) => [o.n, o.action, o.reasonCode, o.reason]), [
    [1, 'fix', undefined, undefined], [2, 'fix', undefined, undefined],
    [3, 'fix', undefined, undefined], [4, 'fix', undefined, undefined],
    [5, 'dismiss', null, null], [6, 'dismiss', null, null],
    [7, 'dismiss', null, null], [8, 'dismiss', null, null],
  ]);
  const inline = parseCommand('fix 1\ndismiss 2, 3 [pre-existing]: legacy importer', { lenient: true });
  assert.deepEqual(inline.map((o) => [o.n, o.action, o.reasonCode]), [[1, 'fix', undefined], [2, 'dismiss', 'pre-existing'], [3, 'dismiss', 'pre-existing']]);
  assert.equal(inline[1].reason, 'legacy importer');
});

test('parseCommand lenient expands fix all and fix blockers against open ledger entries only', () => {
  const ledger = [
    { n: 1, severity: 9, status: 'open' },
    { n: 2, severity: 4, status: 'open' },
    { n: 3, severity: 8, status: 'fixed' },
    { n: 4, severity: 7, status: 'open' },
    { n: 5, severity: 7, status: 'dismissed' },
  ];
  assert.deepEqual(parseCommand('fix blockers', { lenient: true, ledger }).map((o) => o.n), [1, 4]);
  assert.deepEqual(parseCommand('fix all', { lenient: true, ledger }).map((o) => o.n), [1, 2, 4]);
  assert.throws(() => parseCommand('fix all', { lenient: true }), /requires a ledger/);
});

test('parseCommand rejects a number listed twice in lenient mode too', () => {
  assert.throws(() => parseCommand('fix 1 dismiss 1 [other]: x', { lenient: true }), /more than once/);
});

test('parseCommand strict mode still rejects every lenient form', () => {
  for (const cmd of ['fix: 1', 'fix 1 dismiss 2 [other]: x', 'dimiss 2 [other]: x', 'dismiss 2', 'fix all', 'fix blockers']) {
    assert.throws(() => parseCommand(cmd), Error, cmd);
  }
});
```

Add `parseCommand` to the destructured require at the top of the test file if it is not already imported (check the first 20 lines; `prepareAddressRequest` is imported the same way).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test engine/addressState.test.cjs`
Expected: the four new tests FAIL (`parseCommand` not exported, or `invalid address syntax` thrown on the lenient inputs).

- [ ] **Step 3: Implement the lenient grammar**

In `engine/addressState.cjs`, replace the whole `parseCommand` function with:

```js
const DISMISS_ALIASES = /^(?:dismiss|dimiss)\b/i;

function expandKeyword(word, ledger) {
  if (!ledger) throw new Error(`"fix ${word}" requires a ledger to expand`);
  const open = ledger.filter((e) => e.status === 'open');
  const picked = word === 'blockers' ? open.filter((e) => e.severity >= 7) : open;
  return picked.map((e) => e.n);
}

// Strict grammar (CI, PR comments): `fix 1, 3; dismiss 2 [code]: reason`. Lenient
// grammar (local argument mode) additionally accepts an optional colon after the
// keyword, clauses separated by whitespace/newlines before the next keyword, the
// `dimiss` typo, `fix all` / `fix blockers` (expanded against `ledger`), and a bare
// `dismiss N, M` whose reason the skill prompts for (reasonCode/reason are null).
function parseCommand(body, { lenient = false, ledger = null } = {}) {
  const raw = String(body || '');
  if (!raw.trim() || raw.length > 10000) throw new Error('address command is empty or too long');
  // A PR comment usually carries prose after the instruction ("@claude fix 1\n\nThanks!"),
  // so the command is the first non-empty line once the mention is stripped. Lenient
  // input is the whole argument string.
  const command = lenient
    ? raw.replace(/^\s*@claude\b/i, '').replace(/\s+/g, ' ').trim()
    : (raw.replace(/^\s*@claude\b/i, '').split(/\r?\n/).find((line) => line.trim()) || '').trim();
  if (!command) throw new Error('address command is empty');
  if (command.length > 2000) throw new Error('address command is too long');
  const clauses = lenient
    ? command.split(/\s*;\s*|\s*,?\s+(?=(?:fix|dismiss|dimiss)\b)/i).filter(Boolean)
    : command.split(/\s*;\s*/);
  const operations = [];
  for (const clause of clauses) {
    let match = clause.match(lenient ? /^fix:?\s+(all|blockers)$/i : /^$/);
    if (match) {
      for (const n of expandKeyword(match[1].toLowerCase(), ledger)) operations.push({ n, action: 'fix' });
      continue;
    }
    match = clause.match(lenient ? /^fix:?\s+(#?\d+(?:\s*,\s*#?\d+)*),?$/i : /^fix\s+(#?\d+(?:\s*,\s*#?\d+)*)$/i);
    if (match) {
      for (const n of parseNumberList(match[1])) operations.push({ n, action: 'fix' });
      continue;
    }
    match = clause.match(
      lenient
        ? /^(?:dismiss|dimiss):?\s+(#?\d+(?:\s*,\s*#?\d+)*)\s+\[([a-z-]+)\]\s*:\s*(.+)$/i
        : /^dismiss\s+(#?\d+(?:\s*,\s*#?\d+)*)\s+\[([a-z-]+)\]\s*:\s*(.+)$/i,
    );
    if (match) {
      const reasonCode = match[2].toLowerCase();
      if (!DISMISSAL_REASONS.has(reasonCode)) {
        throw new Error(`invalid dismissal reason code: ${reasonCode}`);
      }
      const reason = singleLine(match[3], 'dismissal reason', 500);
      for (const n of parseNumberList(match[1])) {
        operations.push({ n, action: 'dismiss', reasonCode, reason });
      }
      continue;
    }
    match = lenient ? clause.match(/^(?:dismiss|dimiss):?\s+(#?\d+(?:\s*,\s*#?\d+)*),?$/i) : null;
    if (match) {
      for (const n of parseNumberList(match[1])) {
        operations.push({ n, action: 'dismiss', reasonCode: null, reason: null });
      }
      continue;
    }
    throw new Error(
      'invalid address syntax; use "@claude fix 1, 3" or ' +
        '"@claude dismiss 2 [false-positive]: reason" and separate mixed clauses with ";"',
    );
  }
  const seen = new Set();
  for (const operation of operations) {
    if (seen.has(operation.n)) throw new Error(`finding \`#${operation.n}\` appears more than once`);
    seen.add(operation.n);
  }
  if (operations.length === 0) throw new Error('address command contains no operations');
  return operations;
}
```

`DISMISS_ALIASES` is unused if you keep the inline alternations; delete it rather than leave a dead constant. Ensure `parseCommand` is in `module.exports` (it already is if `prepareAddressRequest` calls it internally — verify with `grep -n parseCommand engine/addressState.cjs`).

- [ ] **Step 4: Run the engine tests to verify they pass**

Run: `node --test engine/addressState.test.cjs`
Expected: all PASS, including the existing strict-mode tests.

- [ ] **Step 5: Write the failing CLI test**

Append to `engine/cli.test.cjs`:

```js
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
```

- [ ] **Step 6: Run the CLI test to verify it fails**

Run: `node --test engine/cli.test.cjs`
Expected: FAIL (`address parse` prints the address usage line and exits 1).

- [ ] **Step 7: Wire `address parse`**

In `engine/cli.cjs`, inside `case 'address': {`, before the existing `if (sub === 'prepare')` branch (read the block to find the variable holding the subcommand; it is the first token of `rest`), add:

```js
      if (sub === 'parse') {
        const commandPath = flag(rest, '--command');
        if (!commandPath) {
          out('usage: agent-review address parse --command <f> [--lenient] [--ledger <f>]');
          return 1;
        }
        const ledgerPath = flag(rest, '--ledger');
        try {
          out(JSON.stringify(parseCommand(readFileSync(commandPath, 'utf8'), {
            lenient: rest.includes('--lenient'),
            ledger: ledgerPath ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null,
          })));
          return 0;
        } catch (e) {
          out(`error: ${e.message}`);
          return 1;
        }
      }
```

Add `parseCommand` to the `require('./addressState.cjs')` destructuring near line 35-41. In `USAGE`, change the `address prepare|validate|feedback|finalize` line to `address parse|prepare|validate|feedback|finalize   trusted fix/dismiss handoff tools (parse: lenient local grammar)` and update the fallback `out('usage: agent-review address prepare|validate|feedback|finalize')` to include `parse|`.

- [ ] **Step 8: Run the suite and rebuild**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add engine/addressState.cjs engine/addressState.test.cjs engine/cli.cjs engine/cli.test.cjs dist/agent-review.cjs
git commit -m "feat(engine): lenient address grammar and address parse"
```

---

### Task 2: Review skill — local `incremental` mode

**Files:**
- Modify: `skills/review/SKILL.md` (usage block lines 14-24; Initialize block "Detect CI Mode" ~line 130; incremental gate line 199; the paragraph after the auto-mode block ~line 592-596; the auto-mode `else` branch ~line 579)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Produces: the literal argument `incremental` (any position) sets `INCREMENTAL_REQUESTED=true` in `/tmp/review_env.sh`; the Stage 0 incremental block runs when `CI_MODE` or `INCREMENTAL_REQUESTED` is set. Task 5's re-review passes `auto incremental`.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
test('the review skill runs the incremental path locally on the `incremental` argument', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('/agent-review:review auto incremental'), 'usage must show the local incremental form');
  assert.ok(skill.includes('case " $* " in *" incremental "*) INCREMENTAL_REQUESTED="true" ;; esac'), 'the argument must be detected like `ci`');
  assert.ok(skill.includes('if { [ -n "$CI_MODE" ] || [ -n "$INCREMENTAL_REQUESTED" ]; } && [ -n "$PR_NUMBER" ] && [ -n "$HEAD_REF" ]; then'), 'the incremental gate must accept the local request');
  assert.ok(!skill.includes('# Incremental re-review (CI only)'), 'the CI-only comment is stale');
  assert.ok(skill.includes('push first'), 'unpushed local commits must stop an incremental review');
  assert.ok(skill.includes('only committed changes are reviewed'), 'a dirty tree must warn');
  assert.ok(skill.includes("bot's comment remains the CI ledger"), 'must explain the bot-canonical case');
  // A zero-risk local delta advances the head marker instead of stopping silently.
  assert.ok(skill.includes('no reviewable risk in the delta'), 'local score-0 incremental must post the skip note');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS on the usage assertion.

- [ ] **Step 3: Edit the skill**

1. In the usage block (after the `/agent-review:review auto` line) add:

```
/agent-review:review auto incremental   # Local incremental: only commits since the last posted review; same PR comment
```

and, after the "Rough cost" paragraph, change the **Incremental CI re-reviews** paragraph to:

```markdown
**Incremental re-reviews**: the posted report records the reviewed head SHA. In CI, a later run
on the same PR diffs only the commits since that SHA. Locally, pass `incremental` (any position)
to do the same: `/agent-review:re-review` is the shorthand for `auto incremental`. Both fall back
to a full review after a force-push, when the recorded SHA is no longer reachable from the new
head. Only committed changes are reviewed; if local `HEAD` is ahead of the PR head, push first —
the review records the PR head and the approval workflow compares against it.
```

2. In the Initialize block, directly after `echo "export CI_MODE=\"$CI_MODE\"" >> /tmp/review_env.sh`, add:

```bash
# --- Detect a local incremental request ---
INCREMENTAL_REQUESTED=""
case " $* " in *" incremental "*) INCREMENTAL_REQUESTED="true" ;; esac
[ -n "$INCREMENTAL_REQUESTED" ] && [ -z "$CI_MODE" ] && echo "♻️  INCREMENTAL — only commits since the last posted review"
echo "export INCREMENTAL_REQUESTED=\"$INCREMENTAL_REQUESTED\"" >> /tmp/review_env.sh
```

3. Replace the comment lines above the gate (the five lines beginning `# Incremental re-review (CI only): a previous CI run recorded the head SHA it reviewed`) with:

```bash
# Incremental re-review (CI, or the local `incremental` argument): a previous run recorded the
# head SHA it reviewed inside the posted report comment (`<!-- agent-review-head: <sha> -->`).
# When that SHA is still an ancestor of the current head, review only the commits since it. A
# force-push breaks ancestry, so the recorded SHA fails the checks below and we fall back to a
# full review — the history we reviewed no longer exists, so the delta cannot be trusted.
# Locally the canonical comment may be the bot's CI report; its ledger is still the previous
# state, and the merged report is posted as this user's own comment (the bot's comment remains
# the CI ledger).
```

and change the gate line to:

```bash
if { [ -n "$CI_MODE" ] || [ -n "$INCREMENTAL_REQUESTED" ]; } && [ -n "$PR_NUMBER" ] && [ -n "$HEAD_REF" ]; then
```

Directly before that `if`, add the local guards:

```bash
if [ -n "$INCREMENTAL_REQUESTED" ] && [ -z "$CI_MODE" ]; then
  LOCAL_HEAD=$(git rev-parse HEAD)
  if [ -n "$HEAD_REF" ] && [ "$LOCAL_HEAD" != "$HEAD_REF" ] && git merge-base --is-ancestor "$HEAD_REF" "$LOCAL_HEAD" 2>/dev/null; then
    echo "❌ Local HEAD is ahead of the PR head ($HEAD_REF) — push first, then re-run. The review records the PR head and the approval workflow compares against it."
    exit 1
  fi
  [ -z "$(git status --porcelain)" ] || echo "⚠️  Working tree is dirty — only committed changes are reviewed; commit (or run /agent-review:address) first if that matters."
fi
```

4. In the auto-mode block, the local `else` branch currently reads:

```bash
    else
      echo "AUTO MODE: risk score 0 — nothing worth a review pass. Run 'quick' explicitly to force one."
    fi
```

Replace it with:

```bash
    elif [ -n "$INCREMENTAL_REQUESTED" ]; then
      # Same carry-forward as CI: keep the previous ledger and reversibility, recompute status,
      # and post a skip note so the head marker advances and the next re-review stays small.
      echo '{"kept":[],"suppressed":[]}' > /tmp/review_filtered.json
      echo '[]' > /tmp/previous_agent_review_ledger.json
      echo '{"irreversible":false,"reasons":[]}' > /tmp/agent_review_safety.json
      REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
      gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
        --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' 2>/dev/null \
        | tr -d '\r' > /tmp/previous_agent_review_comment.md
      sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' /tmp/previous_agent_review_comment.md | head -1 > /tmp/previous_agent_review_ledger.json
      [ -s /tmp/previous_agent_review_ledger.json ] || echo '[]' > /tmp/previous_agent_review_ledger.json
      sed -n 's/^<!-- agent-review-status: \(.*\) -->$/\1/p' /tmp/previous_agent_review_comment.md | head -1 > /tmp/previous_agent_review_status.json
      [ -s /tmp/previous_agent_review_status.json ] && node -e 'const s=require("/tmp/previous_agent_review_status.json"); process.stdout.write(JSON.stringify({irreversible:!!s.irreversible,reasons:s.irreversibleReasons||[]}))' > /tmp/agent_review_safety.json
      agent-review ledger --findings /tmp/review_filtered.json --previous /tmp/previous_agent_review_ledger.json > /tmp/agent_review_ledger.json
      agent-review status --ledger /tmp/agent_review_ledger.json --plan /tmp/review_gate_plan.json --safety /tmp/agent_review_safety.json --evidence /tmp/review_evidence.json ${HEAD_REF:+--head "$HEAD_REF"} > /tmp/agent_review_status.json
      OPEN_BLOCKERS=$(node -e 'const l=require("/tmp/agent_review_ledger.json"); console.log(l.filter((e) => e.status === "open" && e.severity >= 7).length)' 2>/dev/null || echo 0)
      { echo "🎚️ **agent-review: skipped** — no reviewable risk in the delta since the last review."
        [ "${OPEN_BLOCKERS:-0}" -gt 0 ] 2>/dev/null && echo "⚠️ $OPEN_BLOCKERS previously-found blocker(s) remain open — see the ledger below."
      } > /tmp/agent_review_report.md
      echo "AUTO MODE: skip (score 0) — post /tmp/agent_review_report.md via Stage 7, then exit."
    else
      echo "AUTO MODE: risk score 0 — nothing worth a review pass. Run 'quick' explicitly to force one."
    fi
```

5. Change the paragraph after the block to:

```markdown
If auto resolved to `skip`: in CI, run the **[CI Mode posting step](#post-the-report-to-the-pr-create-or-update)**
with the skip note as the report, then go straight to Stage 8 cleanup — launch no agents. Locally
with `incremental`, run Stage 7's post-and-print with the skip note, then Stage 8. Locally without
`incremental`, report the skip and stop. If it resolved to `quick`/`standard`/`deep`, continue
exactly as if that mode had been passed on the command line.
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/review/SKILL.md engine/templates.test.cjs
git commit -m "feat(review): local incremental mode"
```

---

### Task 3: Review skill — post automatically and print the findings

**Files:**
- Modify: `skills/review/SKILL.md` (Stage 7 heading line 1645; `### Interactive Menu` through the `Never run apply_all.sh --yes` paragraph, lines 1677-1794; Stage 8 "Artifacts"/"Next Steps" block)
- Test: `engine/templates.test.cjs` (tests near lines 888, 1099, 1215)

**Interfaces:**
- Produces: after Stage 6, Stage 7 always posts (when a PR resolves) and prints the report body; `/tmp/agent_review_post_result.txt` holds the one-line post result for Stage 8. Task 5's yolo reads the posted ledger afterwards via the address skill.

- [ ] **Step 1: Update the tests first**

In `engine/templates.test.cjs`:

1. Near line 888, change `'## Stage 7 — Commit Metrics & Interactive Actions'` to `'## Stage 7 — Post, Print & Metrics'`.
2. Replace the test starting `test('the Interactive Menu "Post review to GitHub" choice self-checks the marker JSON too'` (through its closing `});`) with:

```js
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
```

3. In the docs test from 0.7.0 (near line 1215) change `const menu = review.slice(review.indexOf('2. 📝 Post review to GitHub'));` to `const menu = review.slice(review.indexOf('### Post and print'));`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test engine/templates.test.cjs`
Expected: the Stage 7 test and the stage-ordering test FAIL (heading not found).

- [ ] **Step 3: Rewrite Stage 7**

Change the heading `## Stage 7 — Commit Metrics & Interactive Actions` to `## Stage 7 — Post, Print & Metrics`. Keep the CI-skip sentence and the `### Commit Metrics Dashboard` subsection unchanged. Delete everything from `### Interactive Menu` through the paragraph ending `are untrusted input.` (just before the `---` above `## Stage 8`) and put this in its place:

````markdown
### Post and print

No menu. When a PR resolves, post the report now; either way print what a reader sees on the PR.

```bash
. /tmp/review_env.sh 2>/dev/null || true   # PR_NUMBER, HEAD_REF, FIX_COUNT
if [ -z "${PR_NUMBER:-}" ]; then
  echo "💾 Saved locally, no PR — report at /tmp/agent_review_report.md" | tee /tmp/agent_review_post_result.txt
else
  REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
  { echo '<!-- agent-review -->'
    [ -n "${HEAD_REF:-}" ] && echo "<!-- agent-review-head: $HEAD_REF -->"
    echo "<!-- agent-review-rollout: ${AGENT_REVIEW_ROLLOUT_MODE:-advisory} -->"
    [ -s /tmp/agent_review_ledger.json ] \
      && echo "<!-- agent-review-ledger: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_ledger.json","utf8"))))') -->"
    [ -s /tmp/agent_review_status.json ] \
      && echo "<!-- agent-review-status: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_status.json","utf8"))))') -->"
    echo
    cat /tmp/agent_review_report.md
  } > /tmp/agent_review_comment.md

  # SELF-CHECK — same as the CI posting step: catches hand-transcribed marker lines
  # (mangled escapes) before this ever reaches GitHub. The marker lines above MUST come
  # only from the node commands; never hand-write or hand-edit them.
  node -e '
const fs = require("fs");
const c = fs.readFileSync("/tmp/agent_review_comment.md", "utf8").replace(/\r/g, "");
for (const name of ["ledger", "status"]) {
  const m = c.match(new RegExp("^<!-- agent-review-" + name + ": (.*) -->$", "m"));
  if (m) JSON.parse(m[1]);
}
console.log("marker self-check OK");
' || { echo "❌ marker JSON invalid — REGENERATE the comment using ONLY the node commands above (never hand-write marker lines), then re-run this block"; exit 1; }

  # Create-or-update ONLY a report comment this user posted. Never edit the bot's CI
  # report: that would put hand-posted text under the bot's login (which the CI and
  # interact approvers trust), and the approve template only judges comments whose
  # author is a repository writer. A consumer running agent-review-approve.yml with
  # auto_approve enabled judges the created or edited comment: it approves the PR only
  # if the report covers the current head and passes.
  ME=$(gh api user --jq .login)
  EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq --arg me "$ME" 'map(select(.user.login == $me) | select(.body | contains("<!-- agent-review -->"))) | first | .id // empty' \
    2>/dev/null | head -n1)
  if [ -n "$EXISTING" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$EXISTING" -F body=@/tmp/agent_review_comment.md >/dev/null \
      && echo "✅ Updated your review comment ($EXISTING) on PR #$PR_NUMBER" | tee /tmp/agent_review_post_result.txt
  else
    gh pr comment "$PR_NUMBER" --body-file /tmp/agent_review_comment.md >/dev/null \
      && echo "✅ Review posted to PR #$PR_NUMBER" | tee /tmp/agent_review_post_result.txt
  fi
fi

# What the PR shows, in the terminal: everything before the collapsed appendix.
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
awk '/^<details>/{exit} {print}' /tmp/agent_review_report.md
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

The metrics dashboard (`$REVIEW_DIR/metrics/PR_<n>_metrics.md`), the dependency impact
(`/tmp/review_impact.json`), and the fix dry-run (`bash /tmp/automated_fixes/apply_all.sh`,
which prints and applies nothing) are optional follow-ups named in Stage 8; do not stop to ask.

Never run `apply_all.sh --yes` on the user's behalf without an explicit, informed "yes" — the fix
scripts are model-generated from PR content and are untrusted input.
````

In Stage 8's **Artifacts** block replace `[CI] 💬 Posted to PR #[N]` with `💬 [contents of /tmp/agent_review_post_result.txt]` and add under **Next Steps**:

```
5. Optional: cat $REVIEW_DIR/metrics/PR_[N]_metrics.md · cat /tmp/review_impact.json · bash /tmp/automated_fixes/apply_all.sh (dry run)
6. /agent-review:address fix 1,2 dismiss 3 [code]: reason — then /agent-review:re-review
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/review/SKILL.md engine/templates.test.cjs
git commit -m "feat(review): post automatically and print the findings"
```

---

### Task 4: Address skill — argument mode

**Files:**
- Modify: `skills/address/SKILL.md` (usage block lines 16-21; `## Stage 1 — Get the instruction`; Stage 3 preamble)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: `agent-review address parse --command <f> --lenient --ledger /tmp/address_ledger.json` from Task 1.
- Produces: `/agent-review:address <command>` semantics that Task 5's yolo relies on: `fix blockers` applies, commits, and pushes every open severity ≥ 7 finding without prompting.

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS on the usage assertion.

- [ ] **Step 3: Edit the skill**

Replace the usage block with:

```
/agent-review:address                              # Local: converse (fix 1,3 / dismiss 2 [false-positive]: reason)
/agent-review:address fix 1,2,3,4 dismiss 5,6,7,8  # Local: argument mode — fixes run, then ONE prompt for dismissal reasons
/agent-review:address fix blockers                 # Local: fix every open severity ≥ 7 finding (also: fix all)
/agent-review:address check                        # Local: verify YOUR OWN rework against the open findings before pushing
/agent-review:address ci                           # CI: apply only trusted fix operations and write a result handoff
```

Replace the `**Local**: show the open findings and ask what to do.` paragraph's opening with a new first paragraph:

```markdown
**Argument mode** (any argument other than `check` or `ci`): do not converse. Write the raw
argument string to `/tmp/address_command.txt` and parse it through the engine — never by hand:

```bash
. /tmp/address_env.sh
agent-review address parse --command /tmp/address_command.txt --lenient --ledger /tmp/address_ledger.json \
  > /tmp/address_ops.json || { cat /tmp/address_ops.json; echo "Usage: fix 1,2 dismiss 3,4 [code]: reason · fix blockers · fix all"; exit 1; }
node -e 'for (const o of require("/tmp/address_ops.json")) console.log(`#${o.n} ${o.action}${o.reasonCode ? " ["+o.reasonCode+"]: "+o.reason : o.action === "dismiss" ? " (reason pending)" : ""}`)'
```

The lenient grammar accepts `fix: 1,2`, whitespace between clauses, the `dimiss` typo, `fix all`
(every open finding) and `fix blockers` (open severity ≥ 7). Numbers that don't exist or are
already resolved are reported and dropped; the rest proceed. A dismissal without `[code]: reason`
comes back with `reasonCode: null`.
Fixes are applied, committed, and pushed before the dismissal prompt (Stage 2); then, if any
dismissal has a null reason, ask exactly ONE prompt for the batch:

> Dismissing #5, #6, #7, #8 — give `[code]: reason` (one for all, or one `N [code]: reason` line each).

Validate the answer with the same codes as below; re-ask on an invalid code. The skill still
never dismisses on its own judgment: the reason comes from the user, in the argument or the
prompt. With reasons in hand, continue at Stage 3.

**Conversational mode** (no argument): show the open findings and ask what to do.
```

(Keep the rest of the original Stage 1 paragraph after "ask what to do." unchanged.)

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS (the CI-mode contract test still passes because the CI section is untouched).

- [ ] **Step 5: Commit**

```bash
git add skills/address/SKILL.md engine/templates.test.cjs
git commit -m "feat(address): argument mode with a single dismissal prompt"
```

---

### Task 5: `re-review` and `yolo-review` skills

**Files:**
- Create: `skills/re-review/SKILL.md`, `skills/yolo-review/SKILL.md`
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: `agent-review:review` with `auto incremental` (Task 2), Stage 7 auto-post (Task 3), `agent-review:address fix blockers` (Task 4).

- [ ] **Step 1: Write the failing test**

Append to `engine/templates.test.cjs`:

```js
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
  assert.ok(yolo.includes('github-actions[bot]'));
  assert.ok(yolo.includes('cannot approve'), 'must say the session cannot approve');
  assert.ok(yolo.includes('git status --porcelain'), 'clean tree precondition');
  assert.ok(!yolo.includes('apply_all.sh --yes'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test engine/templates.test.cjs`
Expected: FAILS with ENOENT on `skills/re-review/SKILL.md`.

- [ ] **Step 3: Create `skills/re-review/SKILL.md`**

```markdown
---
name: re-review
description: Shallow local re-review — only the commits since the last posted review, merged into the same PR comment and printed in the terminal
---

# Re-review

Runs the review skill in local incremental mode. The canonical PR comment's reviewed-head SHA
sets the range, the previous ledger is merged (fixed and dismissed items keep their numbers and
statuses, new findings are appended), the comment is updated in place, and the findings are
printed exactly as the PR shows them. A zero-risk delta costs nothing and only advances the head
marker. If the recorded SHA is not an ancestor of the PR head (force-push) or there is no
posted review yet, this becomes a full review and says so.

**Usage**: `/agent-review:re-review` (optionally `quick`, `standard`, or `deep` in place of auto).

**Do this**: invoke the `agent-review:review` skill with the arguments `auto incremental`
(substituting the user's mode for `auto` when they gave one) and follow it to the end. Nothing
else: this skill has no stages of its own.
```

- [ ] **Step 4: Create `skills/yolo-review/SKILL.md`**

```markdown
---
name: yolo-review
description: Review, fix every blocker, re-review, and wait for the bot's approval — one command, no questions, never dismisses
---

# Yolo review

One command from "PR open" to "approved", within the rules every other skill keeps: fixes are
real code changes committed to the PR branch, nothing is dismissed on the AI's judgment,
suggestions below severity 7 are left for a human, and the approval itself is the bot's.

**Usage**: `/agent-review:yolo-review` (optionally `quick`, `standard`, or `deep` for the first
review; re-reviews always run `auto incremental`).

**Cost**: up to four reviews and three address passes on a bad branch; `auto` keeps the
re-reviews cheap.

## Steps

1. **Preconditions** — run this block; stop on any ❌.

   ```bash
   PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null)
   [ -n "$PR_NUMBER" ] || { echo "❌ No PR for this branch — open one first (gh pr create)."; exit 1; }
   [ -z "$(git status --porcelain)" ] || { echo "❌ Working tree is dirty — commit or stash first; yolo reviews and fixes committed code only."; exit 1; }
   HEAD_REF=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid)
   if [ "$(git rev-parse HEAD)" != "$HEAD_REF" ]; then
     git push || { echo "❌ Could not push local commits — the review must record the PR head."; exit 1; }
   fi
   agent-review config validate >/dev/null || { echo "❌ No review config — run /agent-review:init first."; exit 1; }
   START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   echo "export PR_NUMBER=\"$PR_NUMBER\" START_TS=\"$START_TS\"" > /tmp/yolo_env.sh
   ```

2. **Review** — invoke the `agent-review:review` skill with the argument `auto` (or the user's
   mode). It posts the report and prints the findings.

3. **Fix blockers** — read the posted ledger:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' | tr -d '\r' \
     | sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' | head -1 > /tmp/yolo_ledger.json
   OPEN=$(node -e 'const l=require("/tmp/yolo_ledger.json"); console.log(l.filter(e=>e.status==="open"&&e.severity>=7).length)' 2>/dev/null || echo 0)
   echo "open blockers: $OPEN"
   ```

   If `OPEN` is greater than 0, invoke the
   `agent-review:address` skill with the argument `fix blockers`.
   Never dismiss — not with any code, not for any reason; a finding that cannot
   be fixed stays open and is reported at the end. If `OPEN` is 0, skip to step 6.

4. **Re-review** — invoke the `agent-review:review` skill with the arguments `auto incremental`.

5. **Bounded loop** — recompute `OPEN` as in step 3. If it is greater than 0 and any open
   blocker is one this run has not yet tried to fix, repeat steps 3-4, at most two more times
   (three address passes in total). After that, stop looping regardless of what is open.

6. **Approval** — this session cannot approve: GitHub rejects self-approval, and the plugin's
   approval is the bot's, triggered by the posted comment through the consumer's
   `agent-review-approve.yml` (0.7.0+). Read the posted status:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   STATUS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' | tr -d '\r' \
     | sed -n 's/^<!-- agent-review-status: \(.*\) -->$/\1/p' | head -1)
   PASS=$(printf '%s' "$STATUS" | jq -r '.pass // false'); IRREVERSIBLE=$(printf '%s' "$STATUS" | jq -r '.irreversible // false')
   echo "pass=$PASS irreversible=$IRREVERSIBLE"
   if [ "$PASS" = "true" ] && [ "$IRREVERSIBLE" != "true" ]; then
     for i in $(seq 1 9); do
       APPROVED=$(gh pr view "$PR_NUMBER" --json reviews \
         --jq --arg since "$START_TS" '[.reviews[] | select(.author.login == "github-actions[bot]") | select(.state == "APPROVED") | select(.submittedAt > $since)] | length')
       [ "${APPROVED:-0}" -gt 0 ] && { echo "✅ Approved by github-actions[bot]"; break; }
       [ "$i" -lt 9 ] && sleep 20
     done
     [ "${APPROVED:-0}" -gt 0 ] || echo "⏳ Ledger passes but no bot approval arrived within 3 minutes — this repo may not run agent-review-approve.yml with auto_approve on, or the workflow is still queued. The PR is ready for a human."
   fi
   ```

7. **Report** — one of: approved by the bot; ledger passes, no approval (say which of the two
   causes above applies if you can tell from `gh run list --workflow "agent-review approve"`);
   `N` blockers remain that could not be fixed (list each with its number, file:line, and the
   reason the fix was not applied); or the change is irreversible and a human must approve.
   End with the open suggestions (severity < 7) as a plain list. Do not run anything under
   `/tmp/automated_fixes`.
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/re-review skills/yolo-review engine/templates.test.cjs
git commit -m "feat(skills): re-review and yolo-review drivers"
```

---

### Task 6: Advisory-and-approving defaults, docs, and the 0.8.0 release

**Files:**
- Modify: `templates/workflows/agent-review.yml`, `templates/workflows/agent-review-interact.yml`, `templates/workflows/agent-review-approve.yml`, `templates/workflows/agent-review-readiness.yml` (markers)
- Modify: `templates/config.yml` (`rollout:` block ~line 217)
- Modify: `.github/workflows/interact.yml` (line 23 input description)
- Modify: `skills/init/SKILL.md` (line ~582 `rollout` bullet; summary items 6-7 ~line 622), `skills/update-files/SKILL.md` (Stage 3 knobs), `README.md` (rollout paragraph ~line 116; CI setup ~line 136; new "The flow" section)
- Modify: `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, `templates/workflows/template-manifest.json`
- Test: `engine/templates.test.cjs` (0.7.0 assertions on `auto_approve: false` in the approve-template test and the "review caller shows the knob" assertion; new defaults test)

**Interfaces:**
- Produces: templates at marker 0.8.0 with `rollout_mode: advisory` and `auto_approve: true`.

- [ ] **Step 1: Update and add tests**

In `engine/templates.test.cjs`, in the test titled `the approve template is opt-in, fires on created or edited, is collaborator-gated, and the review caller shows the knob`: change `assert.ok(template.includes('auto_approve: false'));` to `assert.ok(template.includes('auto_approve: true'));`, change the title's `opt-in` to `on by default`, and change `assert.ok(review.includes('auto_approve: false'), 'the review caller must show the opt-in knob');` to `assert.ok(review.includes('auto_approve: true'), 'the review caller approves by default');`. Then append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test engine/templates.test.cjs`
Expected: both the edited test and the new test FAIL.

- [ ] **Step 3: Edit the templates**

`templates/workflows/agent-review.yml`: change `rollout_mode: shadow` to `rollout_mode: advisory`; replace the two comment lines above `auto_approve: false` and the value with:

```yaml
      # Approve the PR when the CI report passes for the current head (advisory
      # reports approve; set rollout_mode: shadow to post advice only).
      auto_approve: true
```

and replace the three-line job comment beginning `# Shadow rollout: adding this label starts a review; later pushes re-review.` with:

```yaml
    # Label gate: adding the `agent-review` label starts a review; later pushes
    # re-review incrementally. The gate controls review cost, not trust — drop the
    # first condition and `labeled` from the trigger to review every PR.
```

`templates/workflows/agent-review-interact.yml`: `auto_approve: false` → `auto_approve: true`.

`templates/workflows/agent-review-approve.yml`: `auto_approve: false` → `auto_approve: true`; in its job comment change `Enabling auto_approve here trusts a writer's posted report` to `auto_approve here trusts a writer's posted report`.

All four templates: first line marker `0.7.0` → `0.8.0`.

`templates/config.yml`: replace the two comment lines above `rollout:` and `mode: shadow` with:

```yaml
# Reports approve by default (`advisory`). Set `shadow` to post advice only; the
# review workflow refuses a caller whose rollout_mode disagrees with this value,
# so change the caller templates and this key together. `agent-review rollout`
# still scores the seeded suite and dismissal telemetry for teams that want the
# gate before turning approval on.
rollout:
  mode: advisory
```

`.github/workflows/interact.yml` line 23: `description: Approve the PR when the ledger passes for the current head; shadow reports never approve`.

- [ ] **Step 4: Edit the skills and README**

`skills/init/SKILL.md`: change ``- `rollout` — leave in label-gated `shadow` mode with the skeleton's sample/quality thresholds.`` to ``- `rollout` — `advisory` (approving) with the skeleton's sample/quality thresholds; propose `shadow` only when the team asked for advice-only.`` and summary item 6 to:

```markdown
6. **Evaluation + rollout** — all seeded/clean cases, threshold values, and that reports approve
   by default (`advisory`); how to turn that off (`auto_approve: false` on the callers, or
   `rollout.mode: shadow` in config). Show the manual readiness workflow as optional.
```

`skills/update-files/SKILL.md`, Stage 3: add a bullet after the `auto_approve` one:

```markdown
- **`rollout_mode` vs config**: the fresh `agent-review.yml` says `advisory`. If the repo's
  `.claude/review/config.yml` still says `rollout.mode: shadow`, say so and offer to change it in
  the same PR — the reusable workflow refuses a caller whose mode disagrees with the trusted
  config, so updating the caller alone breaks CI. A repo that deliberately keeps `shadow` keeps
  it on both sides.
```

`README.md`: insert after the intro (before the first `## `) a section:

```markdown
## The flow

```
/agent-review:review                              # review; posts to the PR; prints the findings
/agent-review:address fix 1,2,3 dismiss 4,5       # fix, push; one prompt for the dismissal reasons
/agent-review:re-review                           # only the commits since; same comment; prints
/agent-review:yolo-review                         # all of the above, fixes every blocker, waits for approval
```

Reports approve by default: the templates ship `rollout_mode: advisory` with `auto_approve: true`
on every caller, label-gated so a review runs only on PRs carrying the `agent-review` label. A
posted report that passes for the PR's current head is approved by the bot. Turn it off with
`auto_approve: false`, or post advice only with `rollout_mode: shadow` (caller and config together).
```

Then in the rollout paragraph (~line 116) change `The generated consumer workflow is label-gated in `shadow` mode, which posts advice but never approves.` to `The generated consumer workflow is label-gated in `advisory` mode and approves by default; `shadow` posts advice only and is the opt-in for teams that want this gate first.` and in CI setup (~line 136) replace the paragraph beginning `The template starts label-gated with `rollout_mode: shadow`.` with:

```markdown
The template starts label-gated in `rollout_mode: advisory` with `auto_approve: true`: add the
`agent-review` label to review a PR, and a passing report approves it. Dropping the label gate is
a cost decision; turning approval off is `auto_approve: false` (or `shadow` on both the caller and
`rollout.mode` in config).
```

- [ ] **Step 5: Bump the release**

```bash
sed -i '' 's/"version": "0.7.0"/"version": "0.8.0"/' .claude-plugin/plugin.json package.json
npm install --package-lock-only
npm run stamp-templates
npm run build
npm test && npm run check-dist
```

Expected: `stamped v0.8.0`, suite PASS, `check-dist` exit 0.

- [ ] **Step 6: Commit**

```bash
git add templates .github/workflows/interact.yml skills/init/SKILL.md skills/update-files/SKILL.md README.md engine/templates.test.cjs .claude-plugin/plugin.json package.json package-lock.json dist/
git commit -m "chore: release 0.8.0 — advisory, approving defaults and the one-command flow"
```

---

### Task 7: Push, PR, CI, review

- [ ] **Step 1: Final gate**

Run: `npm test && npm run check-dist && git status --short`
Expected: PASS, PASS, empty.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/review-flow
gh pr create --base main --head feat/review-flow \
  --title "feat: one-command review flow — auto-post, argument address, re-review, yolo; advisory defaults (0.8.0)" \
  --body-file docs/specs/2026-09-24-review-flow-design.md
```

- [ ] **Step 3: CI and review**

`gh pr checks --watch`; then a fresh-context whole-branch review (most capable model) with the plan's Review Focus verbatim; fix Critical/Important with tests that fail first; post the outcome and the manual-verification note (one `/agent-review:yolo-review` run on a real mpdx_api PR after mpdx_api adopts the 0.8.0 templates and config).
