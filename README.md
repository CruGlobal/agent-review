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

## Three switches

| Switch | Where | What it controls | Default |
| --- | --- | --- | --- |
| `auto_approve` | A line in each of the three workflow files in your repo | Whether that path may approve at all. `false` skips the approval job. | `true` |
| `rollout_mode` / `rollout.mode` | `agent-review.yml` **and** `.claude/review/config.yml`, together | `advisory` reports can approve. `shadow` reports are advice only and never approve. The two must match or CI refuses to run. | `advisory` |
| The `agent-review` label | On a PR | Whether the **CI** review runs on that PR (it costs money). Reviews you run from the terminal ignore the label. | Only labelled PRs get a CI review |

The robot approves by default. To stop approvals in a repo, set `auto_approve: false` in
`agent-review-approve.yml` (terminal reviews), `agent-review.yml` (CI reviews), or both.

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
| `dist/agent-review.cjs` | esbuild bundle of the engine, committed so the plugin works with no install step |
| `schema/config.schema.json` | JSON Schema for `.claude/review/config.yml` |
| `templates/` | Files `/agent-review:init` instantiates into a consuming repo (`config.yml` skeleton, `rules/*.md` starters, `settings-snippet.json`, `workflows/agent-review*.yml`), plus `archetype.md` and `report.md` — the agent-prompt and report skeletons ship inside the plugin and are read directly by `skills/review/SKILL.md`, never copied out |
| `templates/evals/` | Seeded-bug suite format, example patch, and result-scoring workflow |
| `templates/static/` | ast-grep configuration/rule starter for deterministic changed-line findings |
| `fixtures/` | Fixture config used by engine tests |
| `.github/workflows/test.yml` | This repo's own CI — `npm ci && npm test && npm run check-dist` |
| `.github/workflows/review.yml`, `interact.yml`, `approve.yml`, `readiness.yml` | Reusable workflows the consumer callers invoke |
| `.github/actions/approve/` | Composite action shared by every approval path |

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
