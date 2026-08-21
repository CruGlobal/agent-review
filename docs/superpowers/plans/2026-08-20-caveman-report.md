# Caveman Report (Phase 1 of token-cost design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the CI review report to the approved "verdict + blockers" layout (~20-25KB, ~40-60 visible lines) and cap agent-output verbosity, without touching any machine contract.

**Architecture:** Three shipped-with-plugin artifacts change: `templates/report.md` (the skeleton the model fills), `templates/archetype.md` (the per-agent findings contract), and `skills/review/SKILL.md` Stage 6 fill rules. The hidden markers, ledger line format, status JSON, and inline-anchor inputs are untouched, so `addressState`, the publish checks, and the `@claude fix/dismiss` flow keep working unchanged.

**Tech Stack:** Markdown templates + skill prose; Node test runner (`npm test`) contract tests in `engine/templates.test.cjs`; `npm run test:e2e` for live verification.

**Spec:** `docs/specs/2026-08-20-token-cost-design.md` (Pillar C, items C1-C4)

## Global Constraints

- Hidden markers (`<!-- agent-review -->`, `-head:`, `-rollout:`, `-ledger:`, `-status:`) keep exact format — publish step and addressState parse them.
- Ledger display lines keep the exact shapes in templates/report.md:61-67 (code-span `**\`#[N]\`**` form) — `finalizeAddress`'s rewriter matches them.
- Blocker (severity ≥7) evidence must stay concrete — `engine/reportState.cjs` hard-fails blockers without line anchor + High confidence + evidence.
- CI report byte cap stays ≤60,000 hard; new soft target ≤25,000.
- No engine source changes in this phase (no dist rebuild needed); tests only in `engine/templates.test.cjs`.
- No version bump (report.md/archetype.md ship inside the plugin; no consumer-copied files change).

---

### Task 1: Report skeleton redesign (templates/report.md)

**Files:**
- Modify: `templates/report.md` (body sections; keep lines 1-70 marker/ledger area intact except where noted)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: existing ledger line formats (report.md:61-67), hidden marker block (report.md top).
- Produces: section names Task 2's fill rules reference verbatim: `VERDICT LINE`, `BLOCKERS`, `OTHER FINDINGS`, and `<details>` sections titled `Fix suggestions`, `Dependency impact`, `Review detail & stats`, `How to act on this review`.

- [ ] **Step 1: Write the failing contract test** — append to `engine/templates.test.cjs`:

```js
test('the report skeleton is the approved verdict+blockers caveman layout', () => {
  const report = readFileSync(join(ROOT, 'templates/report.md'), 'utf8');
  // One verdict line up top, right after the hidden markers.
  assert.ok(report.includes('🤖 agent-review · [❌ [N] blockers open | ✅ no blockers] · risk [LEVEL]'));
  // Visible blocks: blockers with evidence sub-lines, then one-liner findings.
  assert.ok(report.includes('## BLOCKERS — fix or dismiss to pass'));
  assert.ok(report.includes('↳ evidence:'));
  assert.ok(report.includes('## OTHER FINDINGS'));
  // Everything else collapses.
  for (const section of ['Fix suggestions', 'Dependency impact', 'Review detail & stats', 'How to act on this review']) {
    assert.ok(new RegExp(`<details>\\s*<summary>[^<]*${section}`).test(report), `${section} must be a <details> section`);
  }
  // The duplication is gone: no severity-section restatement, no raw-agent appendix.
  assert.ok(!report.includes('Full Agent Reports'), 'raw-agent appendix must be removed');
  assert.ok(!/## 🚫 Critical/.test(report), 'severity sections must not restate ledger findings');
  // Machine contracts survive byte-identical.
  assert.ok(report.includes('- [ ] **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_'));
  assert.ok(report.includes('<!-- agent-review-ledger:'));
  assert.ok(report.includes('<!-- agent-review-status:'));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep "caveman layout"` → FAIL (skeleton still old layout).

- [ ] **Step 3: Rewrite templates/report.md body.** Keep: the hidden-marker header block, the ledger line format definitions (lines 61-67), the `@claude fix / dismiss` usage text (moves into the collapsed `How to act on this review` section, keeping the exact command examples including the semicolon mixed-clause example). New body order:

```markdown
🤖 agent-review · [❌ [N] blockers open | ✅ no blockers] · risk [LEVEL][ · ⚠️ irreversible]
[one-line: mode, agents run, incremental?, debate rounds]

## BLOCKERS — fix or dismiss to pass
[FOR EACH open severity ≥7 ledger entry:]
- [ ] **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_
      ↳ evidence: [≤8 lines/600 chars, may include one hunk excerpt]
      ↳ fix: [≤2 lines or unified diff ≤10 lines]

[IF status.irreversible:]
⚠️ **Irreversible**: [semicolon-joined irreversibleReasons] → auto-approval stays off; a human must approve.

## OTHER FINDINGS ([N])
[FOR EACH remaining ledger entry, ONE line, no sub-bullets:]
- [ ] **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_

<details><summary>🔧 Fix suggestions ([N])</summary>
[per suggestion: finding ref + ≤10-line diff; no heredoc scripts in CI]
</details>

<details><summary>📦 Dependency impact</summary>
[blastRadius, topImpacted table, breaking changes — from /tmp/review_impact.json]
</details>

<details><summary>📊 Review detail & stats</summary>
[agent summary table, per-agent perspectives for blockers, consensus stats,
deterministic evidence, debate summary when run, quality trend when available]
</details>

<details><summary>💬 How to act on this review</summary>
[the existing fix/dismiss command documentation, verbatim]
</details>
[version-check footer line, when stale — unchanged from current]
```

  Resolved/dismissed entries keep their existing struck-through line formats wherever they appear (blocker block or OTHER FINDINGS).

- [ ] **Step 4: Run the full suite** — `npm test` → all pass (existing report-format tests at templates.test.cjs must still pass; if the `**\`#[N]\`**` assertions break, the skeleton edit lost a contract line — fix the skeleton, not the test).

- [ ] **Step 5: Commit** — `git add templates/report.md engine/templates.test.cjs && git commit -m "feat: caveman report skeleton — verdict+blockers visible, the rest collapsed"`

### Task 2: Stage 6 fill rules (skills/review/SKILL.md)

**Files:**
- Modify: `skills/review/SKILL.md` — the "Write the report" subsection (~lines 1334-1359)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: Task 1's section names verbatim.
- Produces: the fill-rule prose Task 3's archetype caps align with (same cap numbers).

- [ ] **Step 1: Write the failing test** — append to `engine/templates.test.cjs`:

```js
test('the review skill fills the caveman report and enforces the soft byte target', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('soft target 25,000 bytes'), 'Stage 6 must state the new soft size target');
  assert.ok(skill.includes('state each finding exactly once'), 'fill rules must forbid restating findings across sections');
  assert.ok(skill.includes('BLOCKERS — fix or dismiss to pass'), 'fill rules must reference the skeleton sections by name');
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep "caveman report and enforces"` → FAIL.

- [ ] **Step 3: Rewrite the "Write the report" subsection.** Replace the current filling guidance with (keeping the existing evidence/impact "do not infer" rules and the 60KB hard-cap paragraph):

```markdown
Fill the skeleton top-down and state each finding exactly once: open blockers in
"BLOCKERS — fix or dismiss to pass" (with their evidence and fix lines), every
other ledger entry as a single line in "OTHER FINDINGS". Never restate a finding
in another section — per-agent perspectives inside "Review detail & stats" refer
to findings by `#N`, they do not repeat the message. Everything below OTHER
FINDINGS lives in the four <details> sections from the skeleton; add nothing
outside them. Soft target 25,000 bytes; the 60,000-byte hard cap and its trim
order still apply.
```

- [ ] **Step 4: Run the suite** — `npm test` → all pass (the existing `'skills reference the CLI'` and version-check tests must survive).

- [ ] **Step 5: Commit** — `git add skills/review/SKILL.md engine/templates.test.cjs && git commit -m "feat: Stage 6 fills the caveman skeleton — one statement per finding, 25KB soft target"`

### Task 3: Agent output caps (templates/archetype.md)

**Files:**
- Modify: `templates/archetype.md` — the findings format section (~lines 38-93) and the Automated Fix block (~lines 111-141)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: cap numbers identical to Task 2's fill rules (2 lines / 8 lines-600 chars / 10-line diffs).
- Produces: the findings sections Stage 2 parses today (section names unchanged — Critical/Concerns/Suggestions, Rule Checklist Results, Questions for Other Agents, Confidence stay so Stage 2 parsing is untouched in this phase).

- [ ] **Step 1: Write the failing test** — append to `engine/templates.test.cjs`:

```js
test('the archetype caps agent verbosity two-tier and drops CI fix scripts', () => {
  const archetype = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(archetype.includes('severity ≥ 7: evidence ≤ 8 lines (600 chars max'), 'blocker evidence tier missing');
  assert.ok(archetype.includes('severity < 7: evidence ≤ 2 lines'), 'minor evidence tier missing');
  assert.ok(archetype.includes('report only the checklist items that FAIL'), 'checklists must be violations-only');
  assert.ok(archetype.includes('In CI mode do NOT write fix scripts'), 'CI fix-script ban missing');
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep "caps agent verbosity"` → FAIL.

- [ ] **Step 3: Edit templates/archetype.md.** In the findings format section, replace the open-ended Evidence/Risk/Impact field guidance with:

```markdown
Keep every finding tight — the report states it once, so write it once, well:
- message: ≤ 2 sentences naming the defect and its consequence
- severity < 7: evidence ≤ 2 lines
- severity ≥ 7: evidence ≤ 8 lines (600 chars max), including at most one hunk
  excerpt — blockers are engine-rejected without a line anchor, High confidence,
  and concrete evidence, so spend the lines on the execution/data path, never on
  restating the diff
- fix: ≤ 2 lines of direction, or a unified diff ≤ 10 lines
- Rule Checklist Results: report only the checklist items that FAIL, one line
  each; if all pass, write "all pass"
```

  In the Automated Fix block, prepend: `In CI mode do NOT write fix scripts or heredocs — CI never executes or offers them; give the ≤10-line diff in your findings instead. Local mode keeps the script blocks below.`

- [ ] **Step 4: Run the suite** — `npm test` → all pass.

- [ ] **Step 5: Commit** — `git add templates/archetype.md engine/templates.test.cjs && git commit -m "feat: two-tier evidence caps and no CI fix scripts in the agent contract"`

### Task 4: Live verification and PR

**Files:**
- None modified — verification only.

**Interfaces:**
- Consumes: everything above; `test/e2e-review.sh`.

- [ ] **Step 1: Run the full unit suite** — `npm test` → expect 155+3 = 158 pass, 0 fail.

- [ ] **Step 2: Run the live E2E** — `npm run test:e2e -- --keep`. Expect PASS. Then verify the staged report shape:

```bash
COMMENT=/tmp/agent_review_comment.md
head -12 "$COMMENT"                                # verdict line visible after markers
grep -c '<details>' "$COMMENT"                     # expect >= 3
wc -c "$COMMENT"                                   # expect well under 25000 for the seeded diff
grep -c 'Full Agent Reports' "$COMMENT" || true    # expect 0
```

- [ ] **Step 3: Validate the address flow still parses the new report** — the e2e validator already runs `extractReportState`; additionally run a one-shot prepare against the staged report:

```bash
printf '@claude dismiss 1 [intentional]: e2e check\n' > /tmp/e2e_cmd.txt
node dist/agent-review.cjs address prepare --command /tmp/e2e_cmd.txt \
  --report "$COMMENT" --actor e2e --pr 1 --comment-id 2 --report-comment-id 3 \
  --head "$(tr -d '\r' < "$COMMENT" | sed -n 's/^<!-- agent-review-head: \(.*\) -->$/\1/p' | head -1)" >/dev/null \
  && echo "address flow OK"
```

- [ ] **Step 4: Push and open the PR** on branch `token-optimization` targeting main, titled "Caveman report: verdict+blockers layout, capped agent output (phase 1 of token-cost design)", body summarizing: approved mock implemented, findings stated once, ~60KB→~25KB target, machine contracts untouched (tests prove it), spec + plan committed in docs/.

- [ ] **Step 5: After-merge measurement note** — the next organic mpdx review's report byte count and `modelUsage` output tokens vs the 399K baseline get recorded in the PR conversation (phase gate for starting Phase 2).
