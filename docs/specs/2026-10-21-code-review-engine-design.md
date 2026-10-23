# `/code-review` as a review engine: design

## Why

On 2026-10-20 the team decided that AI reviews are enough to merge a PR. Humans still review
PCI-related work and anything in staff_accounting_app, but nothing else. Two facts follow:

- The team trusts Claude Code's built-in `/code-review` (run at `xhigh`) more than agent-review's
  own specialist lanes for finding bugs. `/code-review` is tuned for recall: at high effort and
  above it is told to "err on the side of surfacing." agent-review's lanes are tuned for
  precision so that noise does not block approvals.
- agent-review is the only thing that turns a review into an approval. It has the numbered PR
  ledger, the 1-10 severity gate, the reversibility check, fix/dismiss through `address`,
  incremental `re-review`, and the `agent-review-approve.yml` workflow. `/code-review` has none
  of these. It only ranks findings and prints them.

Repos are also moving to local-only reviews (no CI review, no API key in the repo) to cut cost.

This design lets a repo or a single run tell agent-review to use `/code-review` as its main
finder, while everything around the review stays as it is.

## Goals

1. A new review engine, `code-review`. When it is on, agent-review runs `/code-review` (default
   effort `xhigh`) in place of the architecture and simplification lanes and the debate rounds.
2. `/code-review` stands in for exactly two lanes, `architecture` and `simplification`. Every
   other enabled lane keeps running: `security`, `testing`, and `standards` on every PR, and the
   rest (`data-integrity` and any repo-specific specialist such as `financial`) when their own
   triggers match.
3. agent-review scores every `/code-review` finding on its own 1-10 scale, using the same
   severity anchors and blocker bar as every lane. A 7 means the same thing no matter which
   engine found the bug.
4. `re-review` stays incremental: `/code-review` looks only at the commits since the last
   posted review.
5. The engine is chosen in `.claude/review/config.yml` and can be overridden by a command
   argument. The argument wins over the config, and the config wins over the built-in default.
6. Every run (review, re-review, yolo-review) starts by printing the options it is running with
   and where each one came from.
7. `/agent-review:init` asks each setup choice explicitly: which engine (and its effort and
   always-on lanes), whether reviews run locally only or locally plus in CI, and whether the bot
   may approve PRs in the repo.
8. A repo set up as local-only stops being offered the CI workflow files.

## Non-goals

- Running the `code-review` engine in CI. CI keeps using agent-review's own lanes (see
  "CI behavior").
- Changing mpdx_api or mpdx-react. They keep today's engine until someone edits their config.
- Changing the ledger format, the hidden markers, the approval rule (`engine/approval.cjs`), the
  approve workflow, `address`, or `learn`.
- Changing `/code-review` itself.

## Anti-goals

Any of these would make the feature a failure even if it technically works:

- A `/code-review` finding blocks approval without clearing the same bar as a lane finding:
  a line anchor, High confidence, and concrete evidence.
- A cleanup finding (simplification, efficiency, reuse, altitude, conventions) ever blocks.
- The security lane silently does not run while this engine is on.
- A run quietly changes the developer's own remembered `/code-review` settings (their last-used
  effort level, their `--max-findings` choice).
- The report or the start-up line misstates what actually ran.
- Behavior changes for any repo that does not opt in.

## Facts the builder needs

### About `/code-review` (Claude Code 2.1.306; the recipe is built into the CLI)

- **The recipe depends on model and effort.** On Opus, `xhigh` runs 10 finder angles one after
  another in a single context (5 correctness, 3 cleanup, 1 altitude, 1 conventions), dedups,
  then runs a "sweep for gaps" pass. It has **no verify step**. Only `max` fans out to subagents
  and runs a one-vote verifier per candidate (CONFIRMED / PLAUSIBLE / REFUTED). Medium and high
  differ by model. The CLI picks the recipe; agent-review cannot.
- **There is no severity score.** Findings come back "most severe first" with `file`, `line`,
  `summary`, and `failure_scenario`. When the `ReportFindings` tool path is active they also
  carry `short_summary`, `category` (`correctness`, `simplification`, `efficiency`, `reuse`,
  `altitude`, `conventions`, or a more specific slug), and `verdict` only when a verify pass ran.
  When that tool path is not active, the output is a fenced JSON array with the four basic
  fields. Correctness findings always outrank cleanup when the cap forces a cut.
- **The default cap at `xhigh` is 15 findings.** `--max-findings <n>|all|default` changes it,
  and that choice is remembered across runs until `default` is passed.
- **Arguments.** After the effort level and flags are removed, the remaining text is placed at
  the top of the recipe as ``Review target: `<text>` ``. The recipe officially handles a PR
  number, branch name, or file path. A commit range such as `a1b2c3d..e4f5g6h` is not listed;
  it works when a person asks because the model reads the target and runs `git diff` on it.
- **Remembered level.** With no level given, `/code-review` reuses the level the user typed
  last. It is not known whether a level passed through the Skill tool by another skill is
  recorded as "typed last."
- **Side effects to suppress.** After reporting, the recipe may hand off to another built-in
  check that runs the app when the diff has a runtime surface. It also asks to re-report
  outcomes if findings are fixed later in the session.
- **What it reads.** Its conventions angle reads CLAUDE.md files, including the developer's
  personal `~/.claude/CLAUDE.md`. It does not read AGENTS.md or `.claude/review/rules/*.md`. It
  has no security angle (SQL injection appears once, as an example in the xhigh/max
  language-pitfall angle) and never flags missing tests.

### About agent-review (1.0.0)

- `schema/config.schema.json` has `additionalProperties: false` at the top level and in most
  blocks, so new keys need schema changes.
- `agent-review consensus` reads one findings file per id in the launched plan
  (`/tmp/agent_findings/<id>.json`), fails closed on a missing or unparseable file, and drops any
  finding that claims severity 7+ without a line anchor, High confidence, and evidence
  (`validateFinding`). A new lane gets that bar for free.
- Quick mode caps the launch list at three lanes (`testing`, `standards`, the first triggered
  one). Under this engine that cap would drop `security`, so it must not apply.
- `resolveTiers` already handles per-lane model tiers by mode and risk.
- Stage 2 cross-checks each lane's final line, `done — <N> findings, max severity <X>`, against
  the file it wrote.
- Locally, the deterministic evidence (ast-grep findings, the CI snapshot, cross-repo context) is
  always empty; only the CI workflow builds it. This design does not change that.
- The `re-review` and `yolo-review` skills pass only a depth word today (`quick`, `standard`,
  `deep`, `auto`).

## Design

### 1. Config

Proposed keys (names are the builder's call; the shape is the decision):

```yaml
# Which engine finds the issues. `agent-review` = today's specialist lanes + debate.
engine:
  name: code-review            # agent-review (default) | code-review
  code_review:
    effort: xhigh              # low | medium | high | xhigh | max
    model: opus                # tier for the code-review lane's subagent
    replaces: [architecture, simplification]   # lanes that do not run under this engine
    always: [security, testing, standards]     # lanes forced on for every PR under this engine
    # max_findings: 15         # optional; omitted = /code-review's own cap (see section 5)

# Where reviews run. `local` repos install only agent-review-approve.yml.
reviews_run: local             # local | local-and-ci
```

- Missing `engine` means `agent-review`, so no existing repo changes.
- Every enabled lane not listed in `replaces` keeps running under its own config (rules,
  triggers, model). That includes `data-integrity` and the repo-specific specialists init creates
  (`financial`, `api-contracts`, novel lanes). Nothing outside `replaces` is ever silently turned
  off.
- `always` forces those lanes on for this engine only. It does not change a lane's own `always`
  value for the default engine.
- The built-in defaults for `replaces` and `always` are the values shown above, so
  `engine=code-review` on a repo with no `engine` block behaves exactly like a repo that wrote
  this block out.
- `config validate` fails loudly if an id in `always` is not in `agents[]` or is disabled, or if
  an id appears in both lists. An id in `replaces` that the repo does not have is ignored.
- Missing `reviews_run` means `local-and-ci` (today's assumption).

### 2. Command arguments

Two new `key=value` tokens, usable with `review`, `re-review`, and `yolo-review`:

- `engine=code-review` or `engine=agent-review`
- `effort=low|medium|high|xhigh|max`

Order of precedence: argument, then config, then the built-in default (`agent-review`; effort
`xhigh`). `effort=` with the `agent-review` engine is ignored, and the start-up line says so.
`re-review` and `yolo-review` pass these tokens through unchanged. `address` does not review, so
it takes neither.

The engine resolves the options so they can be unit-tested: either a new `agent-review options`
subcommand or part of `agent-review plan`. Either way it takes the raw argument string plus the
config and returns the resolved values with a source for each (`argument`, `config`, `default`).

### 3. Start-up line

Printed after the plan is built and before any lane is launched, so it costs nothing to read.
The first line is the options, the second is who will run:

```
agent-review · engine: code-review (config) · effort: xhigh (default) · mode: auto → standard · scope: since a1b2c3d (re-review)
reviewers: code-review [opus], security [always], testing [always], standards [always], data-integrity [skipped: no trigger matched]
```

The same facts go into the report's "Review detail & stats" block, so the PR shows what ran.

### 4. Who runs under the `code-review` engine

- The launch list is the `code-review` lane, every lane in `always`, and every other enabled lane
  not in `replaces` whose triggers match. Lanes in `replaces` never run, including through the
  unmatched-file coverage rule. Security is always in, which already satisfies that rule.
- Depth words do not cap or expand the list. `quick` does not apply its three-lane cap and
  `deep` does not add lanes. They still set the kept lanes' model tiers through
  `resolveTiers`, as today. `auto` still resolves a depth from the risk score, and a score of 0
  still skips the whole review at no cost.
- The plan carries an `engine` block and a synthetic agent entry
  `{ id: "code-review", tier: <engine.code_review.model>, matchedBy: "engine" }`. The
  `code-review` lane always gets the full diff, never a slice.
- Debate rounds (Stages 3 and 4) are skipped. Stage 5 consensus runs as it does today and merges
  the `code-review` lane with the kept lanes. Overlapping findings combine; near-misses go
  through the existing bounded model pass.

### 5. The `code-review` lane

One subagent, launched in the same parallel Task batch as the kept lanes. It starts with a fresh
context, which matches how the team runs `/code-review` today. It uses a new agent file,
`agents/reviewer-code-review.md` (model from `engine.code_review.model`, no `effort: medium`, and
none of the "keep reasoning brief" wording the other reviewer files carry), because those
settings could weaken both the recipe and the scoring. Its prompt is a new template,
`templates/code-review-lane.md`, and it does four things in order:

1. **Run `/code-review`** with the Skill tool, `skill: "code-review"` (the built-in, not the
   `code-review:code-review` plugin command), and `args: "<effort> <target>"`. Always pass the
   effort level explicitly; goals 1 and 5 depend on it. Pass `--max-findings <n>` only when
   `engine.code_review.max_findings` is set. The target is the PR number for a full review, or
   `<last-reviewed sha>..<PR head sha>` for an incremental one. Never pass `--fix` or
   `--comment`. Tell it not to hand off to any run or verify check, not to post anything, and not
   to publish an artifact.
2. **Save the raw output** (the `ReportFindings` call arguments or the JSON block) to
   `/tmp/code_review_raw.json` exactly as returned, plus the recipe's first line (its tag, for
   example `` `xhigh effort → 10 inline angles → dedup (no verify) → sweep → ≤15 findings` ``) so
   the report can say what actually ran.
3. **Score each raw finding** against the archetype's severity anchors (9-10 exploitable security
   flaw or data loss; 7-8 a correctness bug reachable in production; 5-6 a reliability gap; 3-4
   conventions). For each one, read the finding and the code around it and write a lane-format
   entry: `agent: "code-review"`, `category`, `severity`, `file`, `line`, `message`,
   `confidence`, `evidence`, `recommendation`, `fix`. The rules:
   - Cleanup categories (`simplification`, `efficiency`, `reuse`, `altitude`, `conventions`)
     score 6 at most. This cap is enforced in the engine on the final category, not only in the
     prompt.
   - The scorer may move a finding out of a cleanup category only when its failure scenario is a
     real correctness or security defect (for example, a "conventions" finding that is really a
     leaked secret). It must say why in `evidence`, and the report shows the original category
     next to the new one.
   - The scorer gets the repo knowledge the replaced lanes used to carry, as scoring context only:
     `rules/architecture.md`, `rules/simplification.md`, approved `rule` learnings for those
     lanes, and the impact summary when the index is enabled. It uses them to judge severity,
     never to add findings.
   - A finding scored 7+ must anchor to an added or changed line (or cite the changed line that
     makes it reachable), have High confidence, and name the execution path in `evidence`.
     Otherwise it is capped at 6 and kept as a suggestion, not dropped.
   - A `REFUTED` verdict (only possible at `max`) is dropped. `PLAUSIBLE` or no verdict leaves
     the confidence to the scorer's own read of the code.
   - The scorer may drop a finding only when it can prove it wrong, using the same bar as
     `/code-review`'s own REFUTED verdict: the finding misreads the code, the failure is
     impossible (a type, constant, or invariant rules it out), or this diff already handles it.
     The proof is a quote of the exact line or lines. "Speculative" or "depends on runtime state"
     is not proof when that state is realistic. A finding the scorer doubts but cannot disprove
     stays, scored low with a note saying why it is doubted. At `xhigh` there is no verify step,
     so this is the only place a false positive is removed.
   - Every dropped finding is listed in the report's "Review detail & stats" block with its
     quoted proof, so a reader can check the scorer's work.
   - The scorer adds no findings of its own. Every raw finding is either scored or listed as
     dropped with a reason, so the report can say "found N, scored M, dropped K."
4. **Write `/tmp/agent_findings/code-review.json`** in the standard lane format and reply with
   the standard final line.

**Proof that `/code-review` ran (fails closed).** For this lane, Stage 2's cross-check also
requires `/tmp/code_review_raw.json` to exist and parse, and the saved recipe tag to name the
effort level that was requested. Otherwise the lane fails its cross-check. Without this, a lane
that never ran `/code-review` could write an empty findings list, report 0 findings, and let the
PR auto-approve without its main finder. A lane that fails twice stops the run with no report,
as today, and prints the likely fix: update Claude Code, or rerun with `engine=agent-review`.
There is no silent fallback to the replaced lanes.

### 6. Incremental re-review

The commit range comes from the same values Stage 0A already computes: the reviewed-head marker
on the canonical comment, and the PR head. A force-push still falls back to a full review, as
today. The kept lanes use their existing slices.

### 7. Report

- The header's "agents run" list includes `code-review` and the kept lanes.
- The agent summary table gets a row titled "Code Review (/code-review <effort>)".
- "Review detail & stats" adds: engine, effort and model, where each came from, the recipe tag
  from step 2, and the found / scored / dropped counts with reasons.
- The debate summary block is left out, as it already is whenever debate is skipped.
- The ledger, hidden markers, status JSON, and reversibility judgment are unchanged, so the
  approve workflow needs no change.

### 8. CI behavior

When a CI run reads `engine.name: code-review`, it uses agent-review's own lanes, as today, and
the report says: "The code-review engine runs locally only; CI ran agent-review's own reviewers
as advice, and approval comes from the local review." It does not fail.

**CI never approves under this engine.** The reusable `review.yml` skips its approve job when the
trusted config says `engine.name: code-review`. Otherwise the bot's lanes report could approve a
PR while the developer's own `/code-review` report on the same PR still lists open blockers, and
the engine the team trusts less would decide merges. This changes only the reusable workflow, not
the caller templates.

Reasons the engine stays local for now: the built-in skill has not been tested inside
`claude-code-action`, the CI tool allowlist would need the Skill tool, and the point of this work
is to move reviews off CI.

### 9. `/agent-review:init`

Phase 3A gains three explicit choices. Each is shown with a one-line tradeoff and a recommended
answer, and the user picks. The answers are written into `config.yml` and the workflow files,
and shown again in the 3B proposal before anything is written.

1. **Review engine.** `/code-review` plus agent-review's other lanes (recommended), or
   agent-review's own reviewers. If `/code-review`: the effort level (recommended `xhigh`), and
   the `always` list (recommended: security, testing, standards). Show which lanes it replaces
   and which repo-specific lanes will keep running on their triggers.
2. **Where reviews run.**
   - **Local only (recommended):** install only `agent-review-approve.yml`. Skip the
     `ANTHROPIC_API_KEY` step. Still remind the user to turn on "Allow GitHub Actions to create
     and approve pull requests" and that the approve workflow must be on the default branch
     before it can approve.
   - **Local + CI:** the review, interact, and readiness workflows plus the API key step, as
     today, and now `agent-review-approve.yml` by default too (today it is optional).
3. **Should the bot approve PRs in this repo?** Recommended yes. Recommend no for PCI-scope repos
   and staff_accounting_app, which keep human review under team policy. The answer sets
   `auto_approve` on every installed caller. A "no" still installs the approve workflow, with
   `auto_approve: false`, so turning it on later is a one-line change.

### 10. Local-only repos after setup

- `/agent-review:update-files`: when `reviews_run: local`, consider only
  `agent-review-approve.yml`. Do not offer the missing CI files, and say they were skipped
  because the repo is local-only.
- **A repo that switches to local with CI files still installed:** `update-files` offers to
  remove `agent-review.yml`, `agent-review-interact.yml`, and `agent-review-readiness.yml` in the
  same PR. Before offering, it checks branch protection and rulesets for a required status check
  produced by those workflows and warns if removing them would block merges. It never removes a
  file without a yes. Until they are removed, labeled PRs keep paying for CI reviews, and the
  start-up line says so.
- The review's version-check footer already compares only the workflow files that exist. Leave
  it as is, and make sure it never suggests adding the missing ones.
- In a local-only repo, the report's footer drops the `@claude fix` / `@claude dismiss` PR-comment
  instructions (there is no interact workflow to answer them) and points only at
  `/agent-review:address`.

## Trust and safety

- The approval rule, the trust boundary for locally posted reports, and the reversibility check
  are unchanged.
- The blocker bar is enforced by the engine's consensus step, not only by the lane prompt.
- Security runs on every PR under this engine. With no human reviewer, it is the only
  security-focused pass.
- This design does not decide where human review is still required. That is team policy:
  PCI-related repos and staff_accounting_app should not get the approve workflow.

## Build order

1. **Spike first (throwaway, on a scratch PR).** Answer these before building:
   1. Can a subagent call `/code-review` through the Skill tool? Test at `xhigh` and at `max`,
      through a real agent file like the planned `reviewer-code-review`. Claude Code does not let
      a subagent start its own subagents, so `max` may fail or quietly run its single-pass
      fallback recipe inside a lane. Read the recipe tag to tell.
   2. Does a `<sha>..<sha>` target limit the review to those commits?
   3. Which output shape comes back (`ReportFindings` vs JSON block), and can it be saved
      verbatim?
   4. Does passing an effort level through the Skill tool change the developer's remembered
      `/code-review` level? Does `--max-findings` have the same problem?
   5. Does the post-review hand-off fire, and does an instruction in the lane prompt stop it?
   6. With the official `code-review` plugin also installed, does `skill: "code-review"` always
      reach the built-in and never `code-review:code-review`?
2. Engine: options resolution, schema keys, plan changes, config validation. Unit tests.
3. Review skill: start-up line, launch list, the `code-review` lane template, report changes.
4. Thin drivers: `re-review` and `yolo-review` pass the new tokens through.
5. `init` and `update-files`.
6. README and the config template comments.

**Spike outcomes that come back to Justin before building on them:**
- If a subagent cannot call `/code-review`, the fallback is to run it in the main session before
  launching the kept lanes and hand the raw output to a scoring subagent. This costs the main
  session's context.
- If a commit range is ignored, `re-review` would cost a full review under this engine, and
  re-found old findings may not match their earlier ledger entries. That trade needs his call.
**Spike outcomes the builder settles:**
- If passing the level changes the developer's remembered `/code-review` level, keep passing it
  (goals 1 and 5 need it) and add "this changes your remembered /code-review level" to the
  start-up line. If `--max-findings` behaves the same way, the same applies when `max_findings`
  is configured.
- If `max` cannot fan out inside a lane, run `max` alone through the main-session fallback above,
  or reject `effort=max` with a clear message. Never let it quietly run a different recipe.
- If the skill name can reach the plugin command, resolve the built-in explicitly or fail the
  lane with a clear message.

## Testing

- **Unit (engine):** option precedence and sources; invalid values; `effort=` ignored with the
  default engine; plan launch list under the new engine (always lanes, trigger lanes, quick does
  not drop security, deep adds nothing, the synthetic lane entry); schema accepts the new keys
  and rejects bad ones; `config validate` rejects an `always` id that is missing or disabled, or
  one listed in both `always` and `replaces`; repo-specific lanes still launch on their triggers;
  the engine caps final cleanup categories at 6; Stage 2's proof check fails a `code-review` lane
  with no raw file or a mismatched recipe tag.
- **Existing suite:** `npm test` and `npm run check-dist` stay green; default-engine plans are
  byte-identical to today's.
- **End to end, by hand:** in a local-only test repo, run a full review, `address`, `re-review`,
  and confirm the approve workflow approves. Run the same PR with `engine=agent-review` and
  compare the two reports.
- **CI fallback:** `npm run test:e2e` with `engine.name: code-review` in the fixture config shows
  the lanes engine ran and the report carries the local-only note.

## Release

Minor version, 1.1.0. Follow the existing release steps (version in `plugin.json`,
`package.json`, template markers, `npm run stamp-templates` if a workflow template changed). The
PR goes to CruGlobal/agent-review for Daniel's review. The PR template asks for a Jira key in the
title; Justin supplies or approves the ticket.

## Left to the builder

- Exact key names, argument spellings, and the start-up line's wording.
- Whether option resolution is its own subcommand or part of `plan`.
- The lane prompt's wording, within the rules in section 5.

## Decision log

**Decided by Justin (2026-10-21):**
- agent-review scores `/code-review` findings on its own scale.
- The scorer may delete a `/code-review` finding only when it proves it wrong by quoting the
  code. Doubtful findings stay, scored low with a note.
- Keep the security, testing, standards, and data-integrity lanes.
- Choose the engine by repo config and by command argument; the argument wins.
- Every run prints the options it is running with.
- `init` asks the engine and where-reviews-run choices explicitly.
- mpdx_api and mpdx-react stay as they are.

**Calls made while writing this (check these):**
- Config key names and the `engine=` / `effort=` argument spellings.
- `/code-review` replaces exactly `architecture` and `simplification`; every other lane,
  including repo-specific specialists, keeps running on its triggers.
- The `code-review` lane runs as its own subagent with its own agent file on the opus tier, in
  parallel with the other lanes.
- Cleanup categories cap at 6, enforced in the engine. The scorer may lift a cleanup finding into
  correctness or security only with a stated reason. A 7+ without the evidence bar is capped at
  6, not dropped. `REFUTED` is dropped.
- The scorer gets the replaced lanes' rule docs and learnings as scoring context only.
- The run fails closed if `/code-review` did not run; there is no silent fallback.
- Depth words stop changing the launch list under this engine; `auto`'s free skip on a score of
  0 stays.
- CI ignores the engine setting, never approves under it, and says so, rather than failing.
- `init` asks a third question (should the bot approve here?), installs the approve workflow by
  default in local+CI repos, and recommends `/code-review` and local-only. The user always picks.
- `update-files` offers, never forces, removal of CI files when a repo switches to local.
- The effort level is always passed explicitly, even if that changes the developer's remembered
  level, and the start-up line says so when it does.
- Under this engine, "suppress" learnings will match less often, because `/code-review` rewords
  findings between runs. The README says so.

## Amendments after the spike (2026-10-21)

The spike (plan Task 0, results in the plan's "Spike results") changed three details. Everything
else stands.

- **No recipe tag.** The Skill tool runs `/code-review` as a forked agent. The lane gets back text
  that starts `Skill "code-review" completed (forked execution).`, then a short prose summary and
  a fenced JSON array of findings. The recipe tag stays inside the fork. So the lane saves that
  whole result to `/tmp/code_review_raw.txt`, and the proof check (section 5) requires the
  `Skill "code-review" completed` header and a parseable findings list instead of a tag. The
  report (section 7) shows the requested effort instead of a recipe tag.
- **`max` works inside a lane** (it fans out and verifies there), but it is slow: about 20 forked
  agents and more than 15 minutes on a 15-line diff. It stays allowed, and the README says so.
- **Commit ranges are reviewed but not fenced.** `/code-review` reviews the range and also reports
  bugs it notices outside it, labeled as pre-existing. On a commit-range target, the scorer treats
  "an added or changed line" as changed within the range and scores anything outside it at 6 at
  most, so a re-review cannot be blocked by code it was not asked to review.
- Passing an effort level through the Skill tool does not change the developer's remembered
  `/code-review` level, so the start-up line needs no note about it.
- The CI note (section 8) now reads: "The code-review engine runs locally only; CI ran
  agent-review's own reviewers, and only the local review can approve." It no longer calls CI's
  findings advice, because a developer's local review merges the bot's ledger, so those findings
  carry into the local report.
- On 2026-10-22, after the hands-on check, Justin decided two more. The ledger skips a reworded
  suggestion (below 7) within 5 lines of an older entry in the same file and category, because
  rewordings pushed the test PR's comment to 65,373 of GitHub's 65,536 bytes. A code-review 7+ that
  passes the blocker bar keeps its severity and leads a merged group, because averaging let a
  `financial` 4 pull a proven 7 down to 6.
