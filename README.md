# agent-review

A robot code reviewer for [Claude Code](https://docs.claude.com/en/docs/claude-code).

It reads your pull request, writes what it found as a comment on the PR, prints the same thing
in your terminal, and, when the PR is clean, **approves the PR for you**. It runs a small team of
specialist reviewers (security, architecture, testing, standards, and any your repo adds) and
picks how many to use from how risky the change is. Everything it knows about *your* repo lives
in your repo, under `.claude/review/`.

## The flow

You type one command at a time. Here is the whole thing:

```
/agent-review:review                              # 1. review my PR
/agent-review:address fix 1,2,3 dismiss 4,5       # 2. fix these, dismiss those
/agent-review:re-review                           # 3. check my fixes (fast)
/agent-review:yolo-review                         # or: do all three for me and wait for the approval
```

## The four commands

| Command | Type it when | What it does | What you will see |
| --- | --- | --- | --- |
| `/agent-review:review` | Your PR is open and pushed | Reviews the whole PR. Posts the findings as a PR comment. | The findings in your terminal, numbered `#1, #2, …`, each with a severity out of 10, the file and line, why it matters, and how to fix it. |
| `/agent-review:address fix 1,2 dismiss 3` | You have read the findings | Fixes the numbers you list, commits, pushes. Dismisses the numbers you list. | The commit it pushed. One question asking why you dismissed 3 (skip it by writing `dismiss 3 [intentional]: legacy behaviour` yourself). Then the PR comment updates: fixed items get ✅, dismissed get 🚫. |
| `/agent-review:re-review` | After you fixed things | Reviews **only the new commits** since the last review. Same PR comment, same numbers. | The updated findings. Anything new is added with the next number. |
| `/agent-review:yolo-review` | You want it all done | Runs review, fixes every blocker itself, re-reviews, and waits for the robot's approval. Never dismisses anything. | Everything above, then one of: "Approved", "ready for a human", or "these blockers I could not fix". |

Three more you will use less often:

| Command | Type it when | What it does |
| --- | --- | --- |
| `/agent-review:init` | Once, in a repo that has never had agent-review | Reads the repo and its PR history, proposes the config, rule docs, and workflow files. Writes nothing until you say yes. |
| `/agent-review:update-files` | The review tells you your workflow files are old | Refreshes the copied `.github/workflows/agent-review*.yml` files, keeping your settings. |
| `/agent-review:learn` | Every few weeks | Turns the findings you keep dismissing into rules so they stop coming up. |

**Words to know.** A **blocker** is a finding with severity 7 or higher. The robot will not
approve while a blocker is open. Everything below 7 is a **suggestion**: it is shown, it is
kept, but it never blocks. **Fix** means the robot changes the code. **Dismiss** means you say
"no, that is fine" and give a one-line reason.

## Your first review, step by step

1. Open a PR and push your branch. The robot reviews what is on GitHub, not your unpushed work.
2. In Claude Code, in that repo, type `/agent-review:review`.
3. Read the findings in the terminal. They are also on the PR as a comment.
4. Decide, per number: fix it, or dismiss it with a reason.
   `/agent-review:address fix 1,2 dismiss 3 [false-positive]: guarded by the caller`
5. Type `/agent-review:re-review`. It checks only your new commits and updates the same comment.
6. When no blocker is open, the robot approves the PR within a minute or two.
   If it does not, the "How the robot approves" section below says why.

Or type `/agent-review:yolo-review` and let it do steps 2 to 6, fixing every blocker itself.

## How the robot approves your PR

Your terminal never approves anything. GitHub does not let you approve your own PR, and the
approval has to come from an account the branch rules trust. So:

1. `/agent-review:review` posts the findings on the PR as a comment from **your** account.
   The comment carries hidden markers: which commit was reviewed, and whether it passed.
2. That comment starts a small GitHub Actions job in your repo (`agent-review-approve.yml`).
   No AI runs in it. It only checks.
3. The job checks that you have repository write access, that the reviewed commit is still the
   PR's newest commit, and that the report passed with no open blocker.
4. If all of that is true, the `github-actions` bot approves the PR.
5. If not, the job says why in its summary and does nothing else. It never requests changes.

**It will NOT approve if:**

- a blocker (severity 7+) is still open — fix or dismiss it, then `re-review`
- you have commits that are not pushed — push, then `re-review`
- the change is **irreversible** (drops a column, deletes data, sends email): a human must approve
- the repo's report mode is `shadow` (see "Three switches")
- the person who posted the report does not have write access to the repo
- the repo setting "Allow GitHub Actions to create and approve pull requests" is off
- the `agent-review-approve.yml` workflow is not on the default branch yet

The same rules apply when the review ran in CI instead of your terminal, and when you fix or
dismiss from a PR comment (`@claude fix 1, 3` / `@claude dismiss 2 [intentional]: reason`).

When reviewers flag the same spot, their findings are combined into one and the scores are
averaged, with two exceptions. A 7 or more keeps its score when it is combined with lower scores,
on every engine. This only counts for a score that is still 7 or more after its reviewer's caps
and the blocker bar: a line, High confidence, and evidence. When two findings of 7 or more are
combined, the group takes the higher score.

A later review can raise an earlier finding. If the same finding comes back with a higher score
and the earlier one is still open, the new finding replaces it and keeps only its number. The
score, file, line, message, evidence, and everything else come from the new finding. A dismissed
or fixed finding never changes.

## Set up a repo (once)

Do these in order. Steps 5 and 6 are the ones people miss.

1. Install the plugin in Claude Code:
   ```
   /plugin marketplace add CruGlobal/agent-review
   /plugin install agent-review@cruglobal
   ```
2. In the repo, run `/agent-review:init`. Say yes to the proposal. Accept all four workflow
   files: `agent-review.yml` (CI review), `agent-review-interact.yml` (`@claude fix` comments),
   `agent-review-approve.yml` (approval of reviews you run in the terminal), and
   `agent-review-readiness.yml` (optional quality gate).
3. Add the `ANTHROPIC_API_KEY` secret to the repo: Settings → Secrets and variables → Actions.
   It must be a Console API key (`sk-ant-api03-…`), not a Claude subscription token.
4. Open a PR with those files and merge it.
5. Wait for that merge: GitHub only runs comment-triggered workflows from the **default branch**,
   so approvals cannot happen until `agent-review-approve.yml` is on `main`.
6. Turn on Settings → Actions → General → "Allow GitHub Actions to create and approve pull
   requests". Without it the approval job passes but cannot approve.
7. Open your next PR and type `/agent-review:review`.

To have CI review a PR without anyone typing anything, add the `agent-review` label to the PR.

**Local-only setup.** If you do not want CI to review PRs, set `reviews_run: local` in
`.claude/review/config.yml`. Then skip step 3 (no API key is needed) and install only
`agent-review-approve.yml` in step 2. That one file is what lets the robot approve a review you
ran in your terminal. Steps 4 to 6 still apply. `/agent-review:init` asks you which setup you
want. If your repo already has the other workflow files, run `/agent-review:update-files`. It
offers to remove them (it never removes anything without a yes) and warns you first if a branch
rule requires a check those files produce.

## Three switches

| Switch | Where | What it controls | Default |
| --- | --- | --- | --- |
| `auto_approve` | A line in each of the three workflow files in your repo | Whether that path may approve at all. `false` skips the approval job. | `true` |
| `rollout_mode` / `rollout.mode` | `agent-review.yml` **and** `.claude/review/config.yml`, together | `advisory` reports can approve. `shadow` reports are advice only and never approve. The two must match or CI refuses to run. | `advisory` |
| The `agent-review` label | On a PR | Whether the **CI** review runs on that PR (it costs money). Reviews you run from the terminal ignore the label. | Only labelled PRs get a CI review |

The robot approves by default. To stop approvals in a repo, set `auto_approve: false` in
`agent-review-approve.yml` (terminal reviews), `agent-review.yml` (CI reviews), or both.

## Use /code-review as the engine

By default, agent-review finds problems with its own team of specialist reviewers. You can
switch to Claude Code's built-in `/code-review` as the main finder instead. Everything around
the review stays the same: the numbered findings, the 1 to 10 severity, fix and dismiss, the
re-review, and the approval.

**Turn it on** in `.claude/review/config.yml`. This is an example of a local-only, code-review
repo, not the defaults. `name: code-review` alone keeps CI reviews on, because `reviews_run`
defaults to `local-and-ci`:

```yaml
engine:
  name: code-review              # agent-review (default) | code-review
  code_review:
    effort: xhigh                # low | medium | high | xhigh | max
    model: opus
    replaces: [architecture, simplification]
    always: [security, testing, standards]
    # max_findings: 15           # leave out to use /code-review's own limit
reviews_run: local               # local | local-and-ci (default: local-and-ci)
```

Repos that use the code-review engine or `reviews_run: local` need everyone on plugin 1.1.0 or
later.

Or turn it on for one run, with `review`, `re-review`, or `yolo-review`:

```
/agent-review:review engine=code-review effort=high
```

The argument wins over the config, and the config wins over the built-in default
(`agent-review` engine, `xhigh` effort). `effort=` does nothing with the `agent-review` engine,
and the start-up line tells you so.

**Every run prints what it is using.** Before any reviewer starts, you get two lines: the
engine, effort, mode, scope, and the reviewers that will run, each with where the setting came
from (argument, config, or default). The same facts go into the report, so the PR shows what ran.

**Who runs.** `/code-review` takes the place of the `architecture` and `simplification`
reviewers, and the debate rounds are skipped. These keep running: `security`, `testing`, and
`standards` on every PR, plus any other reviewer your repo has (such as `data-integrity` or a
repo-specific one) when its own triggers match. The depth words (`quick`, `standard`, `deep`)
do not add or remove reviewers under this engine. `/code-review` has no security pass and never
asks for tests, which is why those reviewers stay on.

**How the result is captured.** The lane does not copy `/code-review`'s answer by hand. A plugin
hook writes it to a private directory, `/tmp/agent-review-<uid>`, which only your user can open
(mode 0700, owned by you, checked before every read and write). The hooks act only while a
review has armed capture, and an arm expires after 6 hours. They never touch a `/code-review` you
run yourself in the main conversation. While a review is armed, though, a `/code-review` run in
another subagent of yours writes a mismatch record and fails that review's wait, and the hooks
keep the final message of every subagent that stops in your sessions (the newest 50) in that
directory until the review disarms. The lane reads the capture with `agent-review capture show`.

**The review waits for `/code-review` to finish.** The lane waits with `agent-review
capture-wait`, up to a limit that depends on the effort: `low` 10 minutes, `medium` 15, `high`
20, `xhigh` 40, `max` 120. If the limit passes first, the review fails closed and posts no
report. If the hooks never run, for example because Claude Code was not restarted after the
plugin was installed, the wait fails within a minute and gives the reason, and the lane's reply, which the
review prints when it fails, carries it as `/code-review did not finish: <reason>`.

**How findings are scored.** The lane lists the findings it read from the captured text, and then
agent-review reads each finding, looks at the code, and scores it on its own 1 to 10 scale. A 7 means the
same thing whichever engine found it. The rules:

- Cleanups (simplification, efficiency, reuse, and similar) score 6 at most, so they never block.
- To score 7 or more, a finding needs a changed line, High confidence, and evidence of how it
  fails. Without those it stays as a suggestion at 6.
- A finding is dropped only for one of two reasons. It is `excluded` because its file matches a
  glob in your `excluded_paths` and its line in the result cites no other file, or it is
  `disproved` by quoting the whole cited line right after its `path:line`, from the file as
  committed at the reviewed head, never your working copy. That line must have at least 6
  characters besides spaces, so `end` or `}` never proves anything. If the scorer just doubts it, the finding stays, at 4 or below, with a note. Dropped
  findings are listed in the report, so you can check the work.
- Every finding the lane listed must be scored or dropped exactly once, by its number.
- On a re-review, a finding outside the new commits scores 6 at most. It shows up as a
  suggestion and cannot block you.
- On every review, not only re-reviews, a reworded suggestion within 5 lines of an older open or
  dismissed finding from the same reviewer, in the same file and category, that says much the
  same thing is not added again, so the PR comment stops growing.
- Most rewordings use different words, so that check misses them. For those, the engine pairs
  each new suggestion (below 7, not from static analysis) with every older open or dismissed
  finding from the same reviewer and file within 10 lines. A separate, fresh agent sees only the
  text of each pair, never a score or status, and says whether the two are the same problem. A
  new suggestion it calls the same is not added. The older finding never changes, so a wrong call
  can hide only the new wording, never the issue. If the matcher fails, the review goes on and the
  suggestion is added, as before.
- As on every engine, if another reviewer flags the same spot with a lower score, a proven 7 or
  more from any reviewer keeps its score through the merge instead of being averaged down.

**It stops if `/code-review` did not really run.** The check `agent-review code-review-proof`
compares the lane's list with the text the hook captured. When the result holds a JSON findings
list, the lane's list must match it one to one. `xhigh` and `max` results usually hold one.
Otherwise the lane's list must match the result's finding lines, one entry per line. That text
mode has a cost, and it is usual at `low`, `medium`, and `high`: a line that cites a location
only as context still counts as a finding. The lane must list it and score or drop it, and a
line it leaves out fails the run. The check also holds every scored finding to the field rules:
its raw finding's file, a whole-number severity from 1 to 10, one of the nine category names, a
confidence of High, Medium, or Low, and the `outside_range`, `doubted`, and `recategorized_from`
fields. If the capture is missing, or the lane's list does not match it, the review stops and
posts nothing. It never quietly falls back to the old reviewers, and it never approves without
its main finder. It needs a Claude Code that has the built-in `/code-review` (this was built and
tested on 2.1.309). If you see the stop message, update Claude Code, or run again with
`engine=agent-review`.

**`effort=max` works, but it is slow and costly.** It fans out to many helper agents. On a
15-line diff, the test run used about 20 of them and took more than 15 minutes. `xhigh` is the
default for a reason.

**CI does not use this engine.** If CI runs in a repo set to `code-review`, it ignores the
setting, runs agent-review's own reviewers, and says so in the report. Until you post a local
report, your next local review merges CI's findings into its own ledger. After that, local
re-reviews read your own report's ledger, so findings from later CI runs do not carry in. CI
never approves in that repo, and neither does `@claude fix` or `@claude dismiss`;
only the review you run locally can approve.

## Questions people ask

**Is `auto_approve` a label?** No. It is a line in a workflow file. The label is a different thing:
it decides whether CI spends money reviewing a PR.

**Is `auto_approve` only for the CI review?** No. There are three copies, one per workflow file.
The one in `agent-review-approve.yml` is the one that approves after a review you ran in the
terminal.

**Is `auto_approve` true by default?** Yes, in plugin version 1.0.0 and later. Repos that copied
older files keep `false` until they run `/agent-review:update-files`, which never flips it for
you.

**Does the terminal review approve the PR by itself?** No. It posts the comment; the
`github-actions` bot approves, via the small workflow in your repo. See "How the robot approves".

**Why did nothing approve?** Check the list under "It will NOT approve if". The two usual
reasons are unpushed commits and the workflow file not being on the default branch yet.

**Is a terminal review as trusted as a CI review?** Almost. The CI review judges only the bot's own
report. A terminal review judges a report *you* posted, so approving from it is a
stronger trust grant: anyone with repository write access could post a passing report. That is
why the approval job requires write access, and why a branch rule requiring a non-author human
approval is still worth keeping if it matters to you.

**How much does it cost?** Roughly: a quick review under a dollar, a standard one a few dollars,
a deep one more. `re-review` only looks at new commits, so it is usually the cheap one.
`yolo-review` can run up to four reviews and three fix passes on a messy branch.

**Where do the rules come from?** From your repo: `.claude/review/config.yml` and
`.claude/review/rules/*.md`. `/agent-review:init` writes the first version; `/agent-review:learn`
grows it from what you dismiss.

---

# For maintainers

Everything below is about how the plugin works inside, and how to change it.

## Deterministic evidence

The model is not the only source of findings. The reusable workflow can run SHA-pinned
[ast-grep](https://ast-grep.github.io/) structural rules from the PR base, snapshot GitHub check
runs plus annotations, and fetch bounded files from related repositories at immutable commit SHAs.
The model receives those artifacts as evidence, but cannot silently remove a static finding: the
publishing step verifies every static signature is present in the final ledger.

Relevant config keys:

```yaml
static_analysis:
  ast_grep: { enabled: true, config: static/sgconfig.yml, version: 0.45.0 }
ci: { enabled: true, ignore_checks: [] }
context: { enabled: true, manifest: context/repositories.json }
```

Copy `templates/static/` for an ast-grep starter. Context manifests accept only full 40-character
commit SHAs, allowlisted path globs, and file/byte budgets. Public related repositories work with
the normal token; private ones need an `AGENT_REVIEW_CONTEXT_TOKEN` secret with read-only access,
passed to the reusable workflow as `context_token`.

## Evaluation and rollout

Templates ship in `advisory` mode and approve by default. Teams that want proof before letting the
robot approve can run `shadow` first: a seeded suite introduces realistic, known bugs into
disposable worktrees and mixes them with clean controls. Run each case repeatedly, adjudicate
unexpected blockers, then score the result bundle:

```bash
agent-review eval validate --suite .claude/review/evals/suite.yml
agent-review eval prepare --suite .claude/review/evals/suite.yml \
  --case missing-policy --repo . --out ../eval-missing-policy --base <known-good-sha>
agent-review eval score --suite .claude/review/evals/suite.yml \
  --results .claude/review/evals/results --baseline previous-summary.json --fail-on-gate
```

The summary reports blocker recall/precision, clean-control false blockers, dismissal rates,
per-category recall, and repeated-run detection stability. Dismissals use explicit reason codes:
`false-positive`, `intentional`, `pre-existing`, `deferred`, `duplicate`,
`insufficient-evidence`, or `other`.

After shadow PRs accumulate dispositions:

```bash
agent-review telemetry --in .claude/review/learnings/feedback.jsonl > telemetry.json
agent-review rollout --eval evaluation.json --telemetry telemetry.json --fail-on-gate
```

`rollout` fails closed until the configured sample sizes, evaluation thresholds, and dismissal
thresholds all pass. `.github/workflows/readiness.yml` provides the same gate as a reusable,
manual GitHub Actions check. Keep a private holdout suite; a benchmark committed beside every
expected answer is useful for development but cannot protect against prompt overfitting.

## How the CI workflows fit together

Consumers copy four caller files from `templates/workflows/`; each calls a reusable workflow in
this repo at `@main`.

| Caller in the consumer repo | Reusable workflow here | Trigger | What it does |
| --- | --- | --- | --- |
| `agent-review.yml` | `review.yml` | PR opened/pushed, with the `agent-review` label | Runs `/agent-review:review auto ci`, publishes the report, then (with `auto_approve`) approves a passing report. Later pushes review only the new commits. |
| `agent-review-interact.yml` | `interact.yml` | `@claude fix …` / `@claude dismiss … [code]: reason` comment from a writer | Applies fixes in a read-only, credential-scrubbed model job; a separate trusted job validates and publishes them, updates the ledger, and (with `auto_approve`) approves once the ledger passes. |
| `agent-review-approve.yml` | `approve.yml` | A PR comment starting with the report marker, created or edited by a writer | Judges a report a person posted from a terminal review and (with `auto_approve`) approves it. |
| `agent-review-readiness.yml` | `readiness.yml` | Manual | Scores the seeded suite and telemetry against the rollout gates. |

All three approval paths share one rule (`agent-review approval`, `engine/approval.cjs`) and one
composite action (`.github/actions/approve`). They fail closed, never request changes, never fail
the calling job, and report an approval API failure as a warning. The terminal path
(`agent-review-approve.yml`) judges a comment authored by a person rather than the bot, so it
additionally requires the poster to hold repository write access (the same bar interact applies
to `@claude fix`); it is a stronger trust grant than the CI path. In every path the bot approves
regardless of who authored the PR.

Address runs split authority across two fresh jobs: Claude receives a read-only,
credential-scrubbed workspace and produces a validated patch/result handoff; only the trusted
publisher receives write permissions. The handoff artifact has one-day retention and is deleted
after a successful publish. Every check fails closed and reports back on the PR, so a rejected
command never just goes quiet. Numbers that are unknown or already resolved are skipped and named
in the reply; the remaining operations still run.

Fixes on fork PRs remain advisory because the base repository token cannot push to a fork.
Maintainer-authorized dismissals still update the canonical ledger, but they do not reach
`learnings/feedback.jsonl` — that file is committed alongside the fix, so the learning loop
records outcomes from same-repository PRs only.

The `agent-review.yml` template calls `review.yml` with `mode: auto` (depth from the risk score:
score 0 skips for free, LOW runs quick, MEDIUM/HIGH standard, CRITICAL deep). Set the
`ANTHROPIC_API_KEY` secret before merging the workflow; it must be a Console API key, since
Anthropic rejects subscription OAuth tokens for CI use.

## Testing CI changes locally

```
npm run test:e2e            # full model-step run with your working copy (~5-15 min, one model call)
npm run test:e2e -- --keep  # keep the scratch repo and transcript for debugging
```

Fails fast, before a CI round-trip: it seeds a scratch consumer repo with a known-vulnerable
diff, generates the trusted artifacts with the real engine exactly as `review.yml` does, runs
your local plugin in CI mode with the allowlist and sandbox settings **parsed from the workflow
file** (so the test cannot drift from CI), and applies the publish step's validation to the
staged report. It never talks to GitHub. Not covered: the trusted workflow steps themselves and
Linux-only sandbox behavior — those still need one real Actions run to confirm.

## Updating

Two things can go stale in a consumer repo, and each has its own update path:

```
/plugin marketplace update cruglobal      # the plugin itself (local Claude Code sessions)
/agent-review:update-files                # the copied .github/workflows/agent-review*.yml files
```

CI never needs the first — the workflows pull the plugin fresh from this repo on every run. The
second refreshes the repo's copied caller workflows to the latest templates while preserving the
repo's own settings (`auto_approve` on each caller, `rollout_mode`, secret names, label gates,
pinned refs), shows the diff, and offers a PR. If the fresh caller says `advisory` but the repo's
`.claude/review/config.yml` still says `rollout.mode: shadow`, it offers to change the config in
the same PR, because the reusable workflow refuses a caller whose mode disagrees with config.
Reviews flag both kinds of staleness automatically: the report gains a footer when a repo's
workflow files carry an older `# agent-review-template-version:` marker, and local runs note when
the installed plugin is behind the latest version.

## Versioning & releases

`.claude-plugin/plugin.json` is the single source of truth for the version; `package.json` and
the `# agent-review-template-version:` marker in every `templates/workflows/*.yml` must match it,
and `templates/workflows/template-manifest.json` pins each template's exact contents to that
version (`npm test` enforces all of it — editing a template fails the suite until the version is
bumped and the manifest restamped; rewriting a released manifest entry in place would evade the
test, but that edit is loud in code review, unlike a forgotten bump). To cut a release:

1. Bump the version in `.claude-plugin/plugin.json`, `package.json`, and the four template
   markers; run `npm install --package-lock-only` (syncs the version mirrored in
   `package-lock.json`), then `npm run stamp-templates`, then `npm test`.
2. Merge to `main`, then tag it: `git tag v<version> && git push origin v<version>`.

1.0.0 is the first production-ready release: the one-command flow, approval on every path, and
advisory defaults. Minor bumps from here keep the four commands and the caller-template inputs stable.

## Known limitations

Current, deliberate boundaries — worth knowing before you rely on any of them.

- **Fork PRs are silently skipped.** `secrets.ANTHROPIC_API_KEY` is not exposed to workflow runs
  triggered from a fork, so the CI review job fails to start and posts nothing. PRs from branches
  in the same repository work normally; forks currently get no review and no explanation comment.
- **A repository's bootstrap PR cannot review its own new agent config.** Claude Code Action
  restores `.claude/` from the PR's base branch as a prompt-injection boundary. Human-review the
  bootstrap, merge it, then validate CI on a follow-up PR. The reusable workflow fails if Claude
  exits without publishing a report for the current head, so this limitation is visible rather
  than a misleading green review check.
- **Impact analysis is JS/TS-only.** The import-graph index parses ES `import` and CommonJS
  `require` statements. In a repo of any other language it indexes nothing, and reviews report an
  empty blast radius — which reads like "no dependents" rather than "not measured". Set
  `index: { enabled: false }` there.
- **Cross-repository context is a pinned snapshot, not a dependency graph.** It exposes only the
  manifest's allowlisted files and does not infer runtime compatibility by itself. Refresh pinned
  SHAs deliberately and review those bumps like dependency updates.
- **`new_dependency` and `critical_pkg_update` assume JSON manifests.** They diff the manifest as
  JSON, so they work for `package.json` and produce nothing for `Gemfile`, `pyproject.toml`,
  `go.mod`, or `Cargo.toml`. `lockfile_only_change` is path-based and works everywhere.
- **Use `$AGENT_REVIEW_DIR` for a custom review directory in a skill run.** The CLI also accepts
  one-off `--review-dir` flags, but a flag passed to one command cannot carry into later skill
  stages. CI sets `$AGENT_REVIEW_DIR` to a hashed base-branch snapshot so PR changes cannot replace
  the active review policy or rule docs mid-review.
- **Some config keys are accepted but not yet enforced.** `learning.scope`,
  `learning.approval_required`, and `enforcement.mode` pass validation and are reserved for future
  behavior; today promotion is always approval-gated and reviews never block a merge.
- **"Suppress" learnings mostly stop working under the `code-review` engine.** A suppress rule
  only hides a finding from the same reviewer, in the same category, with nearly the same wording.
  So rules learned from the `architecture` or `simplification` reviewer never match a `code-review`
  finding. And `/code-review` rewords the same finding from run to run, so its findings rarely
  match each other either. Expect dismissed findings to come back, and dismiss them again.
- **A lane could still overwrite the capture file on purpose.** A hook writes the capture, not the
  lane, and the check reads that file. But a lane runs as the same user, so it could replace the
  file. The check cannot rule that out.
- **A lane could add a finding `/code-review` never made.** In text mode, a raw entry with no
  line number may claim any result line that names its file and cites no location, which a line
  of context can do. The check cannot tell such a line from a finding. This can only add a
  finding, never hide one.
- **Consumer workflows track `@main`.** The generated callers use the reusable workflows at
  `@main`, so consuming repos pick up changes as they land. There is no release-tag or
  SHA-pinning story yet — pin the `uses:` ref yourself if you need a frozen version.

CI report publication is deliberately split across trust boundaries: Claude may use Bash to build
the review artifacts, but subprocess secrets are scrubbed and Claude receives no direct GitHub CLI
token. Its engine and rule lookups are forced to a hashed base-branch snapshot. A deterministic
workflow step rechecks that snapshot and the evidence/context hashes, validates the reviewed-head
marker, publishes the comment, and fails the check if any postcondition is not met.

## Repo layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/` | `marketplace.json` + `plugin.json` — plugin/marketplace manifests |
| `hooks/` | `hooks.json` - the capture hooks (`PostToolUse` on `Skill`, and `SubagentStop`). They run `bin/agent-review-hook`, which loads the engine only when a review has armed capture |
| `skills/init/` | `/agent-review:init` — bootstrap skill (stack scan + PR-history mining) |
| `skills/review/` | `/agent-review:review` — review orchestrator skill (also the `incremental` mode) |
| `skills/re-review/` | `/agent-review:re-review` — thin driver: `review auto incremental` |
| `skills/address/` | `/agent-review:address` — fix/dismiss findings, locally or as the CI patch producer |
| `skills/yolo-review/` | `/agent-review:yolo-review` — thin driver: review → fix blockers → re-review → wait for approval |
| `skills/learn/` | `/agent-review:learn` — learning-loop ratification skill |
| `skills/update-files/` | `/agent-review:update-files` — refresh a consumer's copied workflow files |
| `agents/` | Thin per-tier subagent shells (`reviewer-opus`/`-sonnet`/`-haiku`) that the review skill's launch table selects by plan-resolved tier |
| `engine/` | Node engine: risk scoring, agent selection, import-graph index, learnings store, approval rule, address grammar, CLI commands, unit tests (`*.test.cjs`) |
| `bin/agent-review` | Thin shim that requires the bundled `dist/agent-review.cjs` |
| `bin/agent-review-hook` | Plain-Node hook entry: exits at once unless the capture arm file holds a live arm (`armed: true`, created within the last 6 hours), then hands the hook to `dist/agent-review.cjs` |
| `dist/agent-review.cjs` | esbuild bundle of the engine, committed so the plugin works with no install step |
| `schema/config.schema.json` | JSON Schema for `.claude/review/config.yml` |
| `templates/` | Files `/agent-review:init` instantiates into a consuming repo (`config.yml` skeleton, `rules/*.md` starters, `settings-snippet.json`, `workflows/agent-review*.yml`), plus `archetype.md`, `code-review-lane.md`, `ledger-match.md`, and `report.md`. The agent-prompt and report skeletons ship inside the plugin and are read directly by `skills/review/SKILL.md`, never copied out |
| `templates/evals/` | Seeded-bug suite format, example patch, and result-scoring workflow |
| `templates/static/` | ast-grep configuration/rule starter for deterministic changed-line findings |
| `fixtures/` | Fixture config used by engine tests |
| `.github/workflows/test.yml` | This repo's own CI — `npm ci && npm test && npm run check-dist` |
| `.github/workflows/review.yml`, `interact.yml`, `approve.yml`, `readiness.yml` | Reusable workflows the consumer callers invoke |
| `.github/actions/approve/` | Composite action shared by every approval path |
| `.github/actions/read-engine/` | Composite action that reads the review engine from the base commit's config, so the CI approval steps run only on an exact `agent-review` |

## Development

```bash
npm install
npm test
```

The CLI is bundled with esbuild and the bundle is committed to `dist/` so the plugin runs with no
install step for consumers. **Any change under `engine/` must be rebuilt before committing**:

```bash
npm run build          # rebuilds dist/agent-review.cjs
npm run check-dist      # rebuilds and fails if dist/ isn't up to date — run before every push
```

CI (`.github/workflows/test.yml`) runs `npm ci && npm test && npm run check-dist` on every push
and pull request, so a stale `dist/` fails the build.
