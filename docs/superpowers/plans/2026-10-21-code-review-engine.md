# `/code-review` Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a repo (config) or a single run (argument) make agent-review use Claude Code's built-in `/code-review` (default `xhigh`) in place of the architecture and simplification lanes and the debate rounds, while agent-review keeps scoring, the ledger, the reversibility check, and approval.

**Architecture:** The engine (Node, `engine/*.cjs`) gains option resolution, an engine-aware plan, a start-up line, a cleanup cap for the new lane, and a proof check, all unit-tested. The review skill wires them in and launches one new `code-review` lane subagent (its own agent file and prompt template) next to the remaining lanes. Init, update-files, the CI reusable workflow, and the README learn the new settings.

**Tech Stack:** Node >= 20 CommonJS (`.cjs`), `node:test`, ajv (draft 2020), yaml, esbuild bundle in `dist/`, Claude Code plugin skills and agents, GitHub Actions.

**Spec:** `docs/specs/2026-10-21-code-review-engine-design.md` (read it before any task).

## Global Constraints

- No new dependencies. Engine code is `.cjs`, tests are `engine/<module>.test.cjs` using `node:test` + `node:assert/strict`, run by `npm test`.
- Any change under `engine/` is followed by `npm run build` before committing. `engine/templates.test.cjs` runs `bin/agent-review help` (the dist bundle), so new subcommands must appear in `USAGE` (`engine/cli.cjs:198`) and in a rebuilt `dist/`.
- A config with no `engine` key must produce byte-identical plans, reports, and behavior to 1.0.0.
- Literal values (from the spec): engine names `agent-review` | `code-review`; efforts `low|medium|high|xhigh|max`; default effort `xhigh`; default model `opus`; default `replaces` `[architecture, simplification]`; default `always` `[security, testing, standards]`; `reviews_run` `local|local-and-ci`, default `local-and-ci`; lane id `code-review`; cleanup categories `simplification, efficiency, reuse, altitude, conventions`; cleanup cap 6; release version `1.1.0`.
- Lane handoff files: `/tmp/code_review_raw.json`, `/tmp/code_review_tag.txt`, `/tmp/code_review_dropped.json`, `/tmp/agent_findings/code-review.json`.
- CI note, verbatim: `The code-review engine runs locally only; CI ran agent-review's own reviewers as advice, and approval comes from the local review.`
- The lane's final reply keeps the existing contract string exactly: `done — <N> findings, max severity <X>`.
- Comments only state a constraint the code cannot express (an invariant, a hazard, an external contract). Design rationale goes in the commit message. New prose in skills, templates, and the README uses no em dashes (the contract string above is the only exception).
- Never push, open a PR, or touch any repo other than this clone without Justin's go-ahead. The PR title needs a Jira key (repo PR template); propose the ticket to Justin, never create it.

## Review Focus

1. **A developer on an older Claude Code with no built-in `/code-review`.** Expect: the lane fails its proof check, no report is posted, and the message names the fix (update Claude Code, or rerun with `engine=agent-review`). Pinned in Task 6.
2. **`engine=code-review` passed on a repo whose config lacks a default `always` lane (no `testing` lane, say).** Expect: a clear error naming the missing lane and the config key to set, before any model spend. Pinned in Task 2.
3. **The scorer emits a 7+ finding without a line, High confidence, or evidence.** Today `validateFinding` silently drops it. Expect: for the `code-review` lane it is capped at 6 and kept. Pinned in Task 5.
4. **Category spelling (`Conventions`, ` reuse `, `test-coverage`).** Expect: the cleanup cap matches case- and whitespace-insensitively, and unknown categories are not capped. Pinned in Task 5.
5. **A repo switched to `reviews_run: local` that still has `agent-review.yml` installed.** Expect: the start-up line warns that labeled PRs still pay for CI reviews and points at `/agent-review:update-files`. Pinned in Task 4.

---

### Task 0: Spike (throwaway; controller runs it, no product code)

Answers the spec's six spike questions before anything is built. Runs headless Claude Code in a scratch repo so the session's working directory is a git repo, which is how the review skill runs in real use. Spends a small amount of usage on Justin's account.

**Files:**
- Create (scratch only, never committed): `$SCRATCH/cr-spike/` where `$SCRATCH` is the session scratchpad
- Modify: this plan, a new `## Spike results` section at the end

- [ ] **Step 1: Build the scratch repo.** `git init`; commit 1 adds `app.js` with two functions; commit 2 introduces an off-by-one in function A; commit 3 introduces a null dereference in function B. Record the three SHAs. Add `.claude/agents/reviewer-code-review.md` with the frontmatter from Task 7 (`model: opus`, no `effort:` line).
- [ ] **Step 2: Snapshot remembered settings.** Save every key in `~/.claude.json` whose name contains `review` (case-insensitive) to `$SCRATCH/cr-spike/before.json`.
- [ ] **Step 3: xhigh in a subagent, commit range.** From the scratch repo run `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "Task,Skill,Read,Grep,Glob,Write,Bash(git:*),Bash(mkdir:*)"` with a prompt that has the `reviewer-code-review` subagent call the Skill tool with `skill: "code-review"`, `args: "xhigh <c2>..<c3>"`, save the findings exactly as returned to `$SCRATCH/cr-spike/raw-xhigh.json` and the recipe's first line to `$SCRATCH/cr-spike/tag-xhigh.txt`, and not run or launch the app. Save the stream to `run-xhigh.jsonl`.
  Expected answers: Q1 (did the Skill call succeed in the subagent), Q2 (only the function B bug reported), Q3 (ReportFindings arguments or JSON block), Q5 (any Skill or tool call after the findings that launches or verifies the app), Q6 (the tag is a built-in recipe tag, not the plugin command's output).
- [ ] **Step 4: max in a subagent.** Same as Step 3 with `max`. Expected answer: whether the tag contains `tool unavailable` (degraded single-pass recipe) or the fan-out recipe ran.
- [ ] **Step 5: Remembered level.** Snapshot again to `after.json` and diff with `before.json`. Then run `claude -p "/code-review"` (no level) in the scratch repo and capture the "No effort level given" line. Expected answer: Q4, whether a level passed through the Skill tool became the remembered level.
- [ ] **Step 6: Record and gate.** Write `## Spike results` (one line per question, with the evidence file). If Q1 at `xhigh` fails or Q2 fails, stop and bring the spec's fallback trade-off to Justin before Task 1. Otherwise set Task 4's `CODE_REVIEW_PERSISTS_LEVEL` and Task 8's `max` handling from the results and commit the plan update: `git commit -m "docs: record code-review engine spike results"`.

---

### Task 1: Config schema and validation

**Files:**
- Modify: `schema/config.schema.json` (top-level `properties`)
- Modify: `engine/loadConfig.cjs` (`validateConfigReferences`)
- Modify: `templates/config.yml` (new `engine` and `reviews_run` keys)
- Test: `engine/schema.test.cjs`, `engine/loadConfig.test.cjs`

**Interfaces:**
- Produces: config keys `engine.name`, `engine.code_review.{effort, model, replaces, always, max_findings}`, `reviews_run`, readable via `agent-review config get <dot.path>`.

- [ ] **Step 1: Write the failing tests.**
  - `schema accepts the engine block and reviews_run`: a config with `engine: { name: 'code-review', code_review: { effort: 'xhigh', model: 'opus', replaces: ['architecture','simplification'], always: ['security','testing','standards'], max_findings: 15 } }` and `reviews_run: 'local'` validates; `max_findings: 'all'` validates.
  - `schema rejects bad engine values`: `name: 'lanes'`, `effort: 'extreme'`, `model: 'gpt'`, `max_findings: 0`, `reviews_run: 'ci'`, and an unknown key under `code_review` each fail.
  - `references: always id must exist and be enabled`: `validateConfigReferences` returns `engine.code_review.always references unknown agent: testing` and `engine.code_review.always references disabled agent: standards` for the matching configs.
  - `references: an id in both lists`: returns `engine.code_review lists security in both always and replaces`.
  - `references: unknown replaces id is ignored`: `replaces: ['nope']` adds no error.
  - `template config still validates`: `templates/config.yml` loads with `loadConfig` and `config get engine.name` is `agent-review`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Schema: `engine` object (`additionalProperties: false`) with `name` enum, `code_review` object (`additionalProperties: false`) with `effort` enum, `model` enum `opus|sonnet|haiku`, `replaces`/`always` unique string arrays, `max_findings` integer >= 1 or `"all"`; top-level `reviews_run` enum. `validateConfigReferences`: the three checks above, run only when `engine.code_review` is present. Template: add `engine: { name: agent-review, code_review: <the default values> }` and `reviews_run: local-and-ci`, each with a one-line comment naming the allowed values.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the existing fixture and template tests.
- [ ] **Step 5: Commit.** `npm run build`, then `git add schema engine templates/config.yml dist && git commit -m "feat(config): engine and reviews_run keys"`.

---

### Task 2: Option resolution

**Files:**
- Create: `engine/options.cjs`
- Modify: `engine/cli.cjs` (new `options` case, `USAGE` line)
- Test: `engine/options.test.cjs`, `engine/cli.test.cjs`

**Interfaces:**
- Consumes: the Task 1 config keys.
- Produces:
  - `ENGINE_DEFAULTS = { effort: 'xhigh', model: 'opus', replaces: ['architecture','simplification'], always: ['security','testing','standards'] }`
  - `CI_NOTE` (the verbatim string in Global Constraints)
  - `parseReviewArgs(raw: string) -> { mode: 'auto'|'quick'|'standard'|'deep'|null, ci: boolean, incremental: boolean, engine: string|null, effort: string|null, unknown: string[] }`
  - `resolveOptions({ args, config, ci }) -> ResolvedOptions`, where `ResolvedOptions = { mode: {value, source}, engine: {value, source}, effort: {value, source}|null, model: {value, source}|null, maxFindings: {value, source}|null, replaces: string[], always: string[], reviewsRun: {value, source}, incremental: boolean, ci: boolean, notes: string[] }` and `source` is `'argument'|'config'|'default'|'ci'`.
  - CLI: `agent-review options --args "<raw>" [--ci]` prints `ResolvedOptions` JSON; on error prints `error: <message>` and returns 1.

- [ ] **Step 1: Write the failing tests** (`engine/options.test.cjs`).
  - `parse: mode words, flags, key=value in any order`: `parseReviewArgs('effort=MAX incremental Engine=code-review auto ci')` deep-equals `{ mode: 'auto', ci: true, incremental: true, engine: 'code-review', effort: 'max', unknown: [] }`.
  - `parse: unknown tokens are collected`: `parseReviewArgs('auto frobnicate')` has `unknown: ['frobnicate']`.
  - `parse: conflicting duplicates throw`: `parseReviewArgs('engine=code-review engine=agent-review')` throws `/conflicting engine= values/`.
  - `resolve: argument beats config beats default`: config `engine.name: agent-review` + arg `engine=code-review` gives `engine: { value: 'code-review', source: 'argument' }`; no arg gives source `config`; no config key gives `{ value: 'agent-review', source: 'default' }`.
  - `resolve: code-review defaults`: with `engine=code-review` and no `code_review` block, `effort` is `{ value: 'xhigh', source: 'default' }`, `model` is `{ value: 'opus', source: 'default' }`, `replaces`/`always` equal `ENGINE_DEFAULTS`.
  - `resolve: effort ignored under agent-review`: `engine=agent-review effort=max` gives `effort: null` and `notes` includes `effort=max ignored: the agent-review engine does not use it.`
  - `resolve: CI forces agent-review`: config `engine.name: code-review` with `ci: true` gives `engine: { value: 'agent-review', source: 'ci' }` and `notes` includes `CI_NOTE`; with config `agent-review` and `ci: true`, `notes` is empty.
  - `resolve: invalid values throw`: `effort=extreme` throws `unknown effort "extreme" (use low, medium, high, xhigh, or max)`; `engine=lanes` throws `unknown engine "lanes" (use agent-review or code-review)`.
  - `resolve: missing always lane throws` (Review Focus 2): config with no `testing` agent and arg `engine=code-review` throws a message containing `"testing"` and `engine.code_review.always`.
  - `resolve: reviews_run`: missing key gives `{ value: 'local-and-ci', source: 'default' }`.
  - In `engine/cli.test.cjs`: `options prints resolved JSON` (code 0, parses, `engine.value` as expected) and `options reports errors` (code 1, output starts `error: `).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `engine/options.cjs` and the CLI case. Tokens split on whitespace and lowercased; `mode` defaults to `standard` with source `default`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `npm run build`, then `git add engine dist && git commit -m "feat(engine): resolve review options from arguments and config"`.

---

### Task 3: Engine-aware plan

**Files:**
- Modify: `engine/selectAgents.cjs` (`selectAgents`)
- Modify: `engine/plan.cjs` (`buildPlan`)
- Modify: `engine/cli.cjs` (`plan` case gains `--options <f>`; `USAGE`)
- Test: `engine/selectAgents.test.cjs`, `engine/plan.test.cjs`, `engine/slice.test.cjs`

**Interfaces:**
- Consumes: `ResolvedOptions` (Task 2).
- Produces:
  - `selectAgents({ files, diffText, reviewDirRel }, config, engine = null)` where `engine` is `{ name, replaces, always } | null`.
  - `buildPlan({ ..., options }, config)`; under `code-review` the plan gains `engine: { name: 'code-review', effort, model, maxFindings, replaces, always }` and `agents[0]` is `{ id: 'code-review', model, escalates: false, always: true, matchedBy: 'engine', tier: model, rules: [...] }`. Under `agent-review` (or no options) the plan has no `engine` key.
  - Forced lanes carry `always: true` and `matchedBy: 'always'` (their own config said always) or `'engine-always'`.

- [ ] **Step 1: Write the failing tests.**
  - `default engine plans are unchanged`: for an existing `plan.test.cjs` fixture, `buildPlan` with `options` resolving to `agent-review` deep-equals `buildPlan` with no `options`.
  - `code-review: replaced lanes never run`: `architecture` (`always: true`) and `simplification` are absent, including when an unmatched reviewable file would trigger the coverage rule.
  - `code-review: always lanes are forced`: `security` with empty triggers is present with `always: true`, `matchedBy: 'engine-always'`; `testing` (already `always: true`) has `matchedBy: 'always'`.
  - `code-review: trigger lanes keep their triggers`: `data-integrity` and a custom `financial` lane appear only when a matching path is in `files`.
  - `code-review: synthetic lane`: `agents[0].id === 'code-review'`, `tier === 'opus'`, and `rules` equals the union of `resolveRules` for `architecture` and `simplification`.
  - `code-review: quick mode keeps the lane list`: with mode `quick`, the agent ids equal the `standard` result; non-escalating smart lanes get tier `haiku`; `code-review` stays `opus`.
  - In `engine/slice.test.cjs`: `code-review lane gets the full diff` (`mode: 'full'`).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `selectAgents`, when `engine?.name === 'code-review'`, drop `replaces` ids from the candidate list before matching and before the coverage rule, then force `always` ids. In `buildPlan`, pass the engine, prepend the synthetic lane after `resolveTiers` (its tier is its explicit model), and add the `engine` key. The CLI `plan` case reads `--options` JSON when given.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `npm run build`, then `git add engine dist && git commit -m "feat(engine): plan the code-review engine's lanes"`.

---

### Task 4: Start-up line

**Files:**
- Modify: `engine/cliCommands.cjs` (new `formatStartup`, constant `CODE_REVIEW_PERSISTS_LEVEL`)
- Modify: `engine/cli.cjs` (new `startup` case, `USAGE` line)
- Test: `engine/cliCommands.test.cjs`

**Interfaces:**
- Consumes: `ResolvedOptions` (Task 2), the plan (Task 3), the slice manifest.
- Produces:
  - `formatStartup({ options, plan, sliceManifest, configAgents, scopeLabel, ciFilesPresent }) -> string`
  - CLI: `agent-review startup --options <f> --plan <f> [--slices <f>] [--scope <label>]`. It reads config agents itself and sets `ciFilesPresent` from whether `.github/workflows/agent-review.yml` exists under `--root`.

- [ ] **Step 1: Write the failing tests.**
  - `startup: code-review engine`: line 1 equals `agent-review · engine: code-review (config) · effort: xhigh (default) · mode: auto → standard · scope: since a1b2c3d (re-review)`; line 2 equals `reviewers: code-review [opus], security [always], testing [always], standards [always], data-integrity [skipped: no trigger matched]`.
  - `startup: default engine omits effort`: line 1 has no `effort:` segment and reads `engine: agent-review (default)`.
  - `startup: empty-slice lanes`: a plan lane whose manifest entry is `mode: 'empty'` shows `[skipped: no matching hunks]`.
  - `startup: notes`: each `options.notes` entry is its own `note: <text>` line.
  - `startup: leftover CI files` (Review Focus 5): `reviewsRun` `local` and `ciFilesPresent: true` adds `note: this repo is local-only but still has CI review workflows, so PRs labeled agent-review still pay for CI reviews. Run /agent-review:update-files to remove them.`
  - `startup: remembered level`: when `CODE_REVIEW_PERSISTS_LEVEL` is true and the engine is `code-review`, adds `note: this run sets your remembered /code-review level to xhigh.` (set the constant from Task 0's result; the test stubs both values).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `formatStartup` and the CLI case. Lanes in `replaces` are not listed.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `npm run build`, then `git add engine dist && git commit -m "feat(engine): start-up line for every review run"`.

---

### Task 5: Cleanup cap and blocker floor for the `code-review` lane

**Files:**
- Modify: `engine/consensus.cjs` (new `capCodeReviewFinding`, applied after `normalizeFinding` for lane `code-review` only)
- Test: `engine/consensus.test.cjs`

**Interfaces:**
- Produces: `capCodeReviewFinding(finding) -> finding` (exported). Other lanes are untouched.

- [ ] **Step 1: Write the failing tests.**
  - `code-review cleanup findings cap at 6`: a `code-review` finding with `category: 'conventions'`, severity 8, a line, High confidence, and evidence comes out of `consensusFrom` at severity 6.
  - `cap ignores case and whitespace` (Review Focus 4): `' Reuse '` and `'Conventions'` are capped; `'test-coverage'` at 8 with the full bar is not.
  - `a 7+ without the blocker bar is capped, not dropped` (Review Focus 3): a `code-review` finding at 8 with `line: null` survives at 6; likewise with confidence `Medium` and with empty evidence.
  - `other lanes are unchanged`: a `simplification`-lane finding with category `simplification` at 7 with the full bar stays 7, and a non-`code-review` 8 with `line: null` is still dropped.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `capCodeReviewFinding` and call it in the lane-flattening path before `validateFinding`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `npm run build`, then `git add engine dist && git commit -m "feat(consensus): cap code-review cleanups and unproven blockers at 6"`.

---

### Task 6: Proof that `/code-review` ran

**Files:**
- Create: `engine/codeReviewProof.cjs`
- Modify: `engine/cli.cjs` (new `code-review-proof` case, `USAGE` line)
- Test: `engine/codeReviewProof.test.cjs`, `engine/cli.test.cjs`

**Interfaces:**
- Produces:
  - `checkCodeReviewProof({ rawText, tagText, effort }) -> { ok: boolean, reason: string }`
  - CLI: `agent-review code-review-proof --raw <f> --tag <f> --effort <level>` prints `reason`, returns 0 when `ok`, else 1. A missing file is read as `null`.

- [ ] **Step 1: Write the failing tests.**
  - `missing raw output fails with the fix` (Review Focus 1): `rawText: null` gives `ok: false` and a `reason` containing `did not run`, `update Claude Code`, and `engine=agent-review`.
  - `unparseable or wrong-shape raw fails`: `'{'` fails; `'{"x":1}'` fails; `'[]'` and `'{"level":"xhigh","findings":[]}'` pass with a valid tag.
  - `missing tag fails`.
  - `tag must name the requested effort`: tag `` `high effort → 8 inline angles → dedup (no verify) → ≤10 findings` `` with `effort: 'xhigh'` fails; tag `` `xhigh effort → 10 inline angles → dedup (no verify) → sweep → ≤15 findings` `` with `effort: 'xhigh'` passes; a tag naming no level (`` `minimal prompt → single careful diff pass → ≤15 findings` ``) passes.
  - `degraded max fails`: `effort: 'max'` with a tag containing `tool unavailable` fails with a reason containing `max`.
  - In `engine/cli.test.cjs`: `code-review-proof exit codes` (0 for a passing pair of temp files, 1 when `--raw` points at a missing file).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Effort detection regex: `/\b(low|medium|xhigh|high|max) effort\b/`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `npm run build`, then `git add engine dist && git commit -m "feat(engine): fail closed when /code-review did not run"`.

---

### Task 7: The `code-review` lane's agent file and prompt template

**Files:**
- Create: `agents/reviewer-code-review.md`
- Create: `templates/code-review-lane.md`
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Produces: subagent type `agent-review:reviewer-code-review`; template placeholders exactly `{{EFFORT}}`, `{{TARGET}}`, `{{MAX_FINDINGS_FLAG}}`, `{{RISK_CONTEXT}}`, `{{DIFF_PATH}}`, `{{SCORING_RULES}}`, `{{LEARNINGS}}`, `{{IMPACT}}`. Output files: `/tmp/code_review_raw.json`, `/tmp/code_review_tag.txt`, `/tmp/code_review_dropped.json` (array of `{ file, line, summary, proof }`), `/tmp/agent_findings/code-review.json`.

- [ ] **Step 1: Write the failing tests.**
  - `reviewer-code-review pins opus and no effort`: frontmatter has `name: reviewer-code-review` and `model: opus`, no `effort:` line, and the body does not contain `Keep reasoning brief`.
  - `code-review-lane.md uses exactly the documented placeholders` (same approach as the existing archetype test).
  - `code-review-lane.md carries the contracts`: contains `skill: "code-review"`, the four handoff paths, the literal `done — <N> findings, max severity <X>`, `Recategorized from `, each of the five cleanup categories, and the four severity anchor lines copied verbatim from `templates/archetype.md`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Write both files.** The template follows spec section 5, steps 1 to 4, in order:
  - The Skill call is `args: "{{EFFORT}} {{TARGET}}{{MAX_FINDINGS_FLAG}}"`. Never pass `--fix` or `--comment`. No run or verify hand-off, no posting, no artifact.
  - Save the raw output and the recipe's first line verbatim.
  - The scoring rules: anchors, cleanup cap, recategorization with an `evidence` prefix `Recategorized from <original>: <why>`, the 7+ bar, REFUTED drops, the prove-it-wrong drop rule with a quoted line written to `/tmp/code_review_dropped.json`, no new findings, and `{{SCORING_RULES}}`/`{{LEARNINGS}}`/`{{IMPACT}}` used for severity only.
  - The lane-format JSON written with `node -e` and `JSON.stringify` (same pattern as `templates/archetype.md`), then the final-line contract.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add agents templates engine/templates.test.cjs && git commit -m "feat(review): code-review lane agent and prompt"`.

---

### Task 8: Review skill wiring and thin drivers

**Files:**
- Modify: `skills/review/SKILL.md` (Stage 0A Initialize, Build the Review Plan, Stage 0B, Smoke-Test Tier Routing, Stage 1 launch, Stage 2, Stages 3 and 4)
- Modify: `skills/re-review/SKILL.md`, `skills/yolo-review/SKILL.md`
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: CLI `options`, `plan --options`, `startup`, `code-review-proof` (Tasks 2, 3, 4, 6); the Task 7 template and agent.
- Produces: `/tmp/review_options.json`; `ENGINE` and `EFFORT` persisted in `/tmp/review_env.sh`.

- [ ] **Step 1: Write the failing tests** in `engine/templates.test.cjs`:
  - `review skill wires the code-review engine`: `skills/review/SKILL.md` contains `agent-review options --args`, `--options /tmp/review_options.json` (both plan calls), `agent-review startup`, `agent-review code-review-proof`, `agent-review:reviewer-code-review`, and `templates/code-review-lane.md`.
  - `drivers pass engine tokens through`: `skills/re-review/SKILL.md` and `skills/yolo-review/SKILL.md` each mention `engine=` and `effort=`.
  - The existing `every agent-review subcommand used in skill bash blocks exists in the CLI` test must keep passing.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Edit the review skill.** Each change replaces or extends the named section:
  - **Initialize:** detect CI first. Set `REVIEW_ARGS` to the full argument string the skill was invoked with, run `agent-review options --args "$REVIEW_ARGS" ${CI_MODE:+--ci} > /tmp/review_options.json` (stop on error, printing it), and take `MODE`, `ENGINE`, and `EFFORT` from that JSON.
  - **Build the Review Plan:** both `agent-review plan` calls add `--options /tmp/review_options.json`. After slicing, print `agent-review startup --options /tmp/review_options.json --plan /tmp/review_plan.json --slices /tmp/slice_manifest.json --scope "<full review | since <short LAST_REVIEWED> (re-review)>"`. The `auto` score-0 skip is unchanged.
  - **Stage 0B:** when `ENGINE` is `code-review`, the launch list is the plan's `agents[]` exactly in every mode (no quick cap, no deep expansion).
  - **Smoke test:** when `ENGINE` is `code-review`, also confirm `agent-review:reviewer-code-review` resolves; if it does not, `ROUTING="degraded"` as today.
  - **Stage 1:** the `code-review` lane fills `templates/code-review-lane.md`, not the archetype.
    - `{{TARGET}}` is `$PR_NUMBER` for a full review, `$LAST_REVIEWED..$HEAD_REF` when incremental, or the current branch name when no PR resolves.
    - `{{MAX_FINDINGS_FLAG}}` is ` --max-findings <n>` only when `plan.engine.maxFindings` is set.
    - `{{SCORING_RULES}}` is the lane's `rules[]`, rendered like `{{RULES}}`.
    - `{{LEARNINGS}}` is the entries whose `agent` is in `plan.engine.replaces` or is `code-review`.
    - `{{IMPACT}}` is the block the architecture lane would have received.
    - Launch it with `subagent_type: "agent-review:reviewer-code-review"` and `model: <its tier>`. Apply Task 0's `max` result here: route `max` to the main-session fallback or reject it with the message from Task 0.
  - **Stage 2:** for the `code-review` lane, the cross-check also runs `agent-review code-review-proof --raw /tmp/code_review_raw.json --tag /tmp/code_review_tag.txt --effort "$EFFORT"`. A non-zero exit is a failed cross-check (relaunch once; a second failure stops the run and prints the proof's reason).
  - **Stages 3 and 4:** skipped when `ENGINE` is `code-review`.
- [ ] **Step 4: Edit the drivers.** `re-review` invokes `agent-review:review` with `auto incremental` plus every other token the user gave (mode word replaces `auto`). `yolo-review` passes the user's `engine=`/`effort=` tokens to the first review and to every re-review.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add skills engine/templates.test.cjs && git commit -m "feat(review): run the code-review engine from the review skill"`.

---

### Task 9: Report changes

**Files:**
- Modify: `templates/report.md`
- Modify: `skills/review/SKILL.md` (Stage 6 "Write the report")
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: `/tmp/review_options.json`, `/tmp/code_review_tag.txt`, `/tmp/code_review_raw.json`, `/tmp/code_review_dropped.json`, `plan.engine`, `agent-review config get reviews_run`.

- [ ] **Step 1: Write the failing test** `report skeleton covers the code-review engine`. `templates/report.md` contains:
  - an `[IF engine is code-review]` block in "Review detail & stats" that names the engine, effort, model, the source of each, the recipe tag, and `found <N> · scored <M> · dropped <K>`, plus a `[FOR EACH dropped finding]` line with its quoted proof;
  - an `[IF any options notes]` block;
  - an `[IF reviews_run is local]` variant of the footer that omits `@claude fix` and names only `/agent-review:address`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Edit.**
  - The header's agents list and the agent summary table include the `code-review` lane, titled `Code Review (/code-review <effort>)`.
  - The debate block stays omitted when debate was skipped.
  - Stage 6 tells the model which files feed each new block. N is the raw finding count, M is the lane's findings count, and K is the dropped count.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add templates/report.md skills/review/SKILL.md engine/templates.test.cjs && git commit -m "feat(report): show what the code-review engine ran"`.

---

### Task 10: CI never approves under the code-review engine

**Files:**
- Modify: `.github/workflows/review.yml` (review job `outputs`, a new step after "Enforce the trusted rollout policy", the `approve` job's `if:`)
- Test: `engine/templates.test.cjs`

- [ ] **Step 1: Write the failing test** `review.yml skips approval under the code-review engine`. Parse the workflow with `yaml` and assert:
  - `jobs.review.outputs.engine` exists;
  - `jobs.approve.if` contains `inputs.auto_approve` and `needs.review.outputs.engine != 'code-review'`;
  - the new step's `run` block contains no `${{` (it reads `TRUSTED_REVIEW_DIR` and `RUNTIME_DIR` from `env`).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The step has `id: engine` and runs `config get engine.name` against the trusted review dir, the same way the rollout step does. It writes `name=<value>` to `$GITHUB_OUTPUT` (`agent-review` when the value is `undefined` or there is no trusted config).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add .github/workflows/review.yml engine/templates.test.cjs && git commit -m "feat(ci): never auto-approve when the repo uses the code-review engine"`.

---

### Task 11: Init asks the three setup choices

**Files:**
- Modify: `skills/init/SKILL.md` (Phase 3A, 3B item 6 and item 7, 3C, 3F)
- Test: `engine/templates.test.cjs`

- [ ] **Step 1: Write the failing test** `init asks engine, where reviews run, and approval`. `skills/init/SKILL.md` contains `engine:`, `reviews_run:`, `local-and-ci`, and `auto_approve`, plus the three question titles `Review engine`, `Where reviews run`, and `Should the bot approve PRs in this repo?`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Edit init** per spec section 9:
  - Each choice shows a one-line trade-off and a recommendation, and the user picks.
  - The engine choice lists the lanes it replaces and the repo-specific lanes that keep running.
  - Local-only installs only `agent-review-approve.yml` and skips the API-key step.
  - Local + CI installs all four files.
  - The approval answer sets `auto_approve` on every installed caller. A "no" still installs the approve workflow with `false`.
  - Answers are written into `config.yml` (`engine`, `reviews_run`) and shown again at the 3B gate.
  - 3F's next steps match the choice: the Actions approval setting, and the default-branch reminder.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add skills/init/SKILL.md engine/templates.test.cjs && git commit -m "feat(init): ask engine, where reviews run, and approval explicitly"`.

---

### Task 12: update-files respects local-only repos

**Files:**
- Modify: `skills/update-files/SKILL.md` (Stage 2, Stage 4)
- Test: `engine/templates.test.cjs`

- [ ] **Step 1: Write the failing test** `update-files handles local-only repos`. The skill contains `agent-review config get reviews_run`, `required_status_checks`, and `rules/branches`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Edit.**
  - When `reviews_run` is `local`, compare only `agent-review-approve.yml`, and say the CI files were skipped because the repo is local-only.
  - When CI files are present in a local repo, offer to remove `agent-review.yml`, `agent-review-interact.yml`, and `agent-review-readiness.yml` in the same PR.
    - First check `gh api repos/<owner>/<repo>/branches/<default>/protection/required_status_checks` and `gh api repos/<owner>/<repo>/rules/branches/<default>` for a required check those workflows produce, and warn if one exists.
    - Never remove a file without a yes.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add skills/update-files/SKILL.md engine/templates.test.cjs && git commit -m "feat(update-files): local-only repos"`.

---

### Task 13: Docs and release 1.1.0

**Files:**
- Modify: `README.md`, `templates/config.yml` (comments), `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, `templates/workflows/*.yml` (version markers), `templates/workflows/template-manifest.json`

- [ ] **Step 1: README.** A new section "Use /code-review as the engine" covering:
  - the config block and the `engine=` / `effort=` arguments, and which wins;
  - the start-up line;
  - which lanes are replaced and which keep running;
  - the scoring rules in one paragraph;
  - fail-closed behavior and the Claude Code version it needs;
  - that CI ignores the engine and never approves under it.
  Add the `reviews_run: local` setup to "Set up a repo". Add the caveat that "suppress" learnings match less often under this engine because `/code-review` rewords findings between runs.
- [ ] **Step 2: Release steps.** Bump `version` to `1.1.0` in `.claude-plugin/plugin.json` and `package.json` and in the four `# agent-review-template-version:` markers. Then run `npm install --package-lock-only`, then `npm run stamp-templates`.
- [ ] **Step 3: Verify.** Run `npm run build && npm test && npm run check-dist`. Expected: all PASS, and `check-dist` reports no diff.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "chore: release 1.1.0 (code-review engine)"`.

---

### Task 14: Verification gate (needs Justin)

Not a coding task. The controller brings this to Justin, because it spends usage, needs a test repo he names, and changes his local plugin install.

- [ ] **Step 1:** Install this branch's plugin locally (from `/Users/justinsabelko/Work/non-rails/agent-review`) with Justin's OK.
- [ ] **Step 2:** In the local-only test repo Justin names, on a PR with a seeded bug, run:
  1. `/agent-review:review engine=code-review`
  2. `/agent-review:address fix <n>`
  3. `/agent-review:re-review engine=code-review`

  Confirm:
  - the start-up line is printed;
  - the report shows the engine block;
  - re-review looks only at the new commits;
  - the approve workflow approves.
- [ ] **Step 3:** Run the same PR with `engine=agent-review` and compare the two reports.
- [ ] **Step 4:** With Justin's OK, run `npm run test:e2e` with `engine.name: code-review` in the fixture config. Confirm the lanes engine ran and the report carries the CI note.
- [ ] **Step 5:** Propose the Jira ticket and PR title to Justin. Push and open the PR only after his yes.

## Spike results

Run 2026-10-21 on Claude Code 2.1.306, headless, in a scratch repo. Evidence lives in `/private/tmp/claude-502/-Users-justinsabelko-Work-rails/9b54ead0-8b00-4792-b25a-024db73347e0/scratchpad/cr-spike/` (not committed). The Skill tool runs `/code-review` as a forked general-purpose agent one level below the caller, so the recipe tag line is in the stream (`task_started` event, `spawn_depth` 2), not in the lane's context.

- Q1 xhigh: YES. A `reviewer-code-review` subagent called Skill `code-review` and got 8 findings back; the fork's tag was `xhigh effort → 10 inline angles → dedup (no verify) → sweep → ≤15 findings` (evidence: `run-xhigh.jsonl`, `tag-xhigh.txt`, `skill-result-xhigh.txt`).
- Q1 max: YES, fan-out ran inside a lane. The fork's tag was `max effort → 5+5 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings`, and it started about 20 depth-3 agents (angles, verifiers, sweep). It did NOT finish inside the 15 minute cap on a 2-commit diff, so there is no max findings file (evidence: `run-max.jsonl`, `tag-max.txt`).
- Q2: PARTIAL. The fork ran `git diff 7cef894..16910c5` and the function B bug was the headline, but it also reported both function A (firstN) bugs, labeled "(Pre-existing, outside the reviewed range)" (evidence: `skill-result-xhigh.txt`, `raw-xhigh.json`).
- Q3: JSON. No ReportFindings call; the Skill result is a few lines of prose, then a fenced JSON array of `file`, `line`, `summary`, `failure_scenario`. The lane saved the array verbatim when told to (evidence: `skill-result-xhigh.txt`, `raw-xhigh.json`). A direct `/code-review` run instead printed a numbered prose list with no JSON (`run-nolevel.jsonl`).
- Q4: NO CHANGE. `codeReviewLastEffort` in `~/.claude.json` was `xhigh` before and after, and a plain `/code-review` still said "reusing xhigh". Only the `max` run discriminates, because the level before the spike was already xhigh. `--max-findings` was not tested (evidence: `before.json`, `after.json`, `run-nolevel.jsonl`).
- Q5: NOT FIRED at xhigh. The lane's only Skill call was `code-review`; no server, app run, or tests after the findings, in the lane or in the fork (evidence: `run-xhigh.jsonl`, fork transcript). The max run never reached the findings, so it is untested there (evidence: `run-max.jsonl`).
- Q6: BUILT-IN. The Skill input was `code-review` (not `code-review:code-review`) in all three runs, and the fork prompt carried a built-in recipe tag (evidence: `run-xhigh.jsonl`, `run-max.jsonl`, `run-nolevel.jsonl`).

CODE_REVIEW_PERSISTS_LEVEL = false

max inside a lane: works

Open items for Justin: the Skill result has no recipe tag, so the lane cannot copy it into the report. Max cost about 20 forked agents and more than 15 minutes on a tiny diff. Out-of-range findings leak through the commit range target.
