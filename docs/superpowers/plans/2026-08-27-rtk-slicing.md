# RTK Slicing (Phase 4 of token-cost design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Specialist review agents read per-agent diff slices instead of the full diff, with budgeted reading discipline for all lanes; the engine guarantees an escalating lane launches whenever unmatched reviewable files exist; and two deferred CI/UX gaps close (review.yml failure reporting, `run` mode passthrough). Target: the remaining ~$6.63 Opus share of a $7.78 review → total ~$5-6.

**Architecture:** `plan.agents[]` gains `triggers` (carried through `selectAgents` like `escalates` was); a new `agent-review slice` command writes per-agent diff files from path globs + content triggers; escalating lanes, `architecture`, and always-on lanes ALWAYS get the full diff (the quality red-team's hard rule — cross-file findings must never be severed); triggered specialists with an empty slice are not launched. The archetype's reading contract (R2) replaces "READ THE FULL FILES" with budgets. Coverage stops depending on prose: the engine force-includes an escalating lane when unmatched reviewable files exist and none was selected.

**Tech Stack:** Node engine + `npm test`; skill/template prose; cold-start `npm run test:e2e` with the seeded-blocker quality gate.

**Spec:** `docs/specs/2026-08-20-token-cost-design.md` (Pillar R + red-team/feasibility amendments) plus deferred items ledgered in phases 2-3.

## Global Constraints

- The E2E quality gate must keep passing: the seeded SQL-injection diff must still yield an open severity ≥7 blocker from cold start. Slicing must never starve escalating lanes (they get the full diff by rule).
- Machine contracts untouched (markers, signatures, status, consensus shapes). Engine changes ⇒ `npm run build` + dist committed (check-dist).
- Slice files are model-READ inputs living beside `/tmp/pr_diff.txt` (`/tmp/agent_slices/<id>.diff`); the workflow's SHA-pinned files are never written.
- Fresh-state discipline: slice dir is cleaned in Stage 0A's Initialize block like `/tmp/agent_findings`.
- Version bump 0.6.0 at the end (plugin.json, package.json, markers, stamp-templates).

---

### Task 1: plan carries triggers + engine coverage guarantee

**Files:**
- Modify: `engine/selectAgents.cjs` (carry `triggers` onto output; coverage guarantee), `engine/plan.cjs` (pass through)
- Test: `engine/selectAgents.test.cjs`, `engine/plan.test.cjs`

**Interfaces:**
- Produces: every `plan.agents[]` entry carries `triggers` (the agent's config triggers object, verbatim) — Task 2 consumes it for slicing.
- Coverage guarantee (deterministic, in `selectAgents` after normal selection): if the diff has ≥1 unmatched reviewable file (the same set risk scoring floors — reuse its computation) AND no selected agent has `escalates: true`, force-include the config's `security` agent when it exists (else the first `escalates: true` agent in config order) with `matchedBy: 'unmatched-coverage'`. Disabled agents are never force-included.

- [ ] **Step 1: failing tests**:

```js
test('plan agents carry their config triggers verbatim', () => {
  // build a plan via existing fixtures; assert plan.agents.every(a => 'triggers' in a)
  // and that a path-triggered agent's triggers.paths matches its config entry.
});

test('an escalating lane is force-included when unmatched reviewable files exist', () => {
  // config: security (escalates, paths that DO NOT match), style (always, no escalates);
  // diff touching src/unmatched.js (reviewable, unmatched) →
  // selection includes security with matchedBy 'unmatched-coverage'.
  // Counter-case: same diff but architecture (escalates) already selected via always → security NOT force-included.
  // Counter-case: diff touching only excluded/docs paths → no force-include.
});
```

Flesh both against the existing fixture idioms in the two test files; the assertions are the contract.

- [ ] **Step 2: RED.** **Step 3: implement.** **Step 4:** full suite; `npm run build`; commit dist. **Step 5: Commit** — `git commit -m "feat: plan carries agent triggers; escalating-lane coverage guarantee for unmatched files"`

### Task 2: `agent-review slice`

**Files:**
- Create: `engine/slice.cjs`, `engine/slice.test.cjs`
- Modify: `engine/cli.cjs` (subcommand + usage line)

**Interfaces:**
- CLI: `agent-review slice --plan <f> --diff <f> --out-dir <d>` → writes `<out-dir>/<agent-id>.diff` per agent and prints a JSON manifest to stdout: `{ "<id>": { "mode": "full"|"sliced"|"empty", "files": N, "hunks": N } }`.
- Rules per agent (module export `sliceForAgent({ agent, diffText })` pure):
  - `mode: "full"` (file is the whole diff) when `agent.escalates === true`, OR `agent.id === 'architecture'`, OR `agent.triggers.always === true`.
  - else `mode: "sliced"`: include every hunk whose file matches any `triggers.paths` glob (reuse the same matcher `selectAgents` uses) PLUS every hunk whose added/context lines contain any `triggers.content` marker (reuse `contentMatches`' token semantics). Keep complete hunks with their `diff --git`/`@@` headers.
  - `mode: "empty"` when a sliced agent matches nothing — the file is still written (empty) and the manifest says so.
- Task 3 consumes the manifest (`empty` lanes are not launched) and the file paths.

- [ ] **Step 1: failing tests** — cover: path-glob slicing keeps only matching files' hunks with valid diff headers; content-trigger slicing pulls a hunk from a non-glob-matching file; escalating/architecture/always agents get byte-identical full diff; empty mode for a no-match specialist; manifest counts; deterministic output ordering (input order of hunks preserved).
- [ ] **Step 2: RED.** **Step 3: implement** (parse hunks once, filter per agent; no I/O in `sliceForAgent`; CLI does file work). **Step 4:** suite + build + dist. **Step 5: Commit** — `git commit -m "feat: per-agent diff slices from path and content triggers"`

### Task 3: skill + archetype wiring (R1 consumption + R2 reading budgets)

**Files:**
- Modify: `skills/review/SKILL.md`, `templates/archetype.md`
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes Task 2's CLI + manifest. New archetype placeholder `{{DIFF_PATH}}` (added to the placeholder-vocabulary test) replaces the hardcoded `/tmp/pr_diff.txt` read instruction; the skill fills it with `/tmp/agent_slices/<id>.diff` (sliced) or `/tmp/pr_diff.txt` (full-mode lanes may be given the original path directly).

- [ ] **Step 1: failing tests**:

```js
test('the review skill slices per agent and skips empty lanes', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review slice --plan'));
  assert.ok(skill.includes('/tmp/agent_slices'));
  assert.ok(skill.includes('mode is "empty"'), 'empty-slice lanes must be skipped, not launched');
  assert.ok(skill.includes('mkdir -p /tmp/agent_slices') || /rm -f \/tmp\/agent_slices/.test(skill), 'slice dir needs fresh-state handling in Initialize');
});

test('the archetype reading contract is budgeted, not unbounded', () => {
  const a = readFileSync(join(ROOT, 'templates/archetype.md'), 'utf8');
  assert.ok(a.includes('{{DIFF_PATH}}'));
  assert.ok(!a.includes('READ THE FULL FILES for context'), 'the unbounded read mandate must be gone');
  assert.ok(a.includes('full-file read budget'), 'budgeted reads must be stated');
  assert.ok(a.includes('discovery grep budget'), 'bounded discovery greps must be stated');
});
```

- [ ] **Step 2: RED.** **Step 3: edits:**
  - SKILL Stage 0A Initialize: add `/tmp/agent_slices` to the mkdir + fresh-state cleanup set.
  - After the plan block: run `agent-review slice --plan /tmp/review_plan.json --diff /tmp/pr_diff.txt --out-dir /tmp/agent_slices > /tmp/slice_manifest.json`.
  - Launch table: fill `{{DIFF_PATH}}` per the manifest (`full` → `/tmp/pr_diff.txt`; `sliced` → the slice file); a lane whose manifest `mode` is `"empty"` is NOT launched — note it in `Review detail & stats` as "lane <id>: no matching changes"; the Stage-2 cross-check and consensus `--plan` must therefore use the LAUNCHED lane set (write the launched ids to `/tmp/launched_lanes.json` and have the consensus invocation pass a filtered plan — simplest: `node -e` derive a plan copy whose `agents` are the launched subset into `/tmp/review_plan_launched.json`, and use that for `consensus --plan`). Sliced lanes' prompts also get one inline line: "Other changed files in this PR (not in your slice): <list from /tmp/changed_files.txt>".
  - archetype: replace the `/tmp/pr_diff.txt` read with `{{DIFF_PATH}}`; replace `READ THE FULL FILES for context` with: "full-file read budget: open at most 5 complete files (10 when your model tier is sonnet and risk is HIGH/CRITICAL — the launch prompt tells you); prefer the hunk context in your diff"; replace the open-ended grep guidance with: "discovery grep budget: at most 10 repo-wide greps for identifiers/contracts the diff introduces or modifies, plus verification greps before reporting any finding" (keep the CROSS-CUTTING DUTY and verification-before-report language intact).
- [ ] **Step 4:** full suite. **Step 5: Commit** — `git commit -m "feat: sliced diffs per lane with budgeted reading; empty lanes skipped"`

### Task 4: deferred CI/UX gaps

**Files:**
- Modify: `.github/workflows/review.yml` (report-failure job), `engine/cli.cjs` (`run` mode), `engine/cliCommands.cjs` if run lives there — find it
- Test: `engine/templates.test.cjs`, `engine/cli.test.cjs`

- [ ] **Step 1: failing tests** — templates.test: review.yml defines a `report-failure` job (`needs: review`, `if: failure()`, `pull-requests: write`, posts via `gh pr comment` a "review did not complete — no report posted" message with the run link, mirroring interact.yml's job shape). cli.test: `run quick` passes mode into buildPlan (plan.mode.resolved === 'quick' in the preflight output or the tmp plan file), and `run auto` is accepted (MODES gains auto).
- [ ] **Step 2: RED.** **Step 3: implement** (copy interact.yml's report-failure job shape, adjusted: no failure_reason plumbing — a simple static message + run URL; `run`: pass `mode` through to buildPlan, add `auto` to MODES). **Step 4:** suite + build + dist (cli changed). **Step 5: Commit** — `git commit -m "feat: review failure reporting on the PR; run passes mode through"`

### Task 5: version 0.6.0

- [ ] Bump plugin.json + package.json to 0.6.0; sed the three template markers; `npm run stamp-templates`; `npm test`. Commit `chore: release 0.6.0 — per-agent diff slicing`.

### Task 6: live verification (controller-run)

- [ ] `npm test` + `npm run check-dist` clean; AC power confirmed.
- [ ] Cold-start `caffeinate -dims npm run test:e2e -- --keep` — FULL PASS required (publish + quality gate); transcript checks: `agent-review slice` invoked, the manifest consumed, security lane full-diff, seeded blocker ≥7.
- [ ] Push, open the PR (mechanism, measured expectations, rulings); after merge + tag: canary the identical mpdx PR 3569 diff again (delete old report first) vs the $7.78 phase-3 baseline.
