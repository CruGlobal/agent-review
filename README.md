# agent-review

Multi-agent PR review for [Claude Code](https://docs.claude.com/en/docs/claude-code): risk-scored
agent selection, cross-examination debate, consensus synthesis, per-repo bootstrapped rules, and
a human-ratified learning loop. Each review dispatches a small set of specialist agents (security,
architecture, data-integrity, testing, standards, plus any repo-specific agents) chosen by a risk
score computed from the diff itself, so trivial changes get a fast pass and risky ones get deeper
scrutiny. Everything repo-specific — risk globs, agent triggers, prose rule docs — lives in the
consuming repo's own `.claude/review/` directory, so the same plugin adapts to any codebase without
hardcoding anything about it.

## Install

In a Claude Code session:

```
/plugin marketplace add CruGlobal/agent-review
/plugin install agent-review@cruglobal
```

This registers the `cruglobal` marketplace and installs the `agent-review` plugin, which brings
three slash commands (`/agent-review:init`, `/agent-review:review`, `/agent-review:learn`) and the
bundled `agent-review` CLI binary.

## Bootstrap a repo

Run once per repo you want reviews in:

```
/agent-review:init
```

This scans the codebase and mines merged PR history (50 PRs by default) to propose a
`.claude/review/config.yml`, prose rule docs, a CI workflow, and a settings snippet — tailored to
that repo's stack and habits. **Nothing is written until you approve the proposal.**

Useful flags:

```
/agent-review:init --prs 100        # mine more PR history
/agent-review:init --skip-history   # codebase scan only, skip PR mining
/agent-review:init --migrate        # upgrade an existing v1 config.yml to v2, then stop
```

## Daily use

Review the current diff:

```
/agent-review:review              # standard mode — engine-selected agents (recommended)
/agent-review:review quick        # fast feedback for simple changes
/agent-review:review deep         # every enabled agent, maximum depth
```

Rough cost per run (varies with diff size): quick ~$0.50 · standard ~$2-4 · deep ~$6-10.

After a review, mark findings as accepted or dismissed, then ratify recurring feedback into
repo-specific rules or suppressions:

```
/agent-review:learn
```

Approved `rule` learnings get injected into future review prompts; approved `suppress` learnings
filter matching findings out of future runs. Nothing is applied automatically — every proposal is
approved or rejected by you.

## Deterministic evidence

The model is no longer the only source of findings. The reusable workflow can run SHA-pinned
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

Do not enable paid reviews on every PR by intuition alone. A seeded suite introduces realistic,
known bugs into disposable worktrees and mixes them with clean controls. Run each case repeatedly,
adjudicate unexpected blockers, then score the result bundle:

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
thresholds all pass. The generated consumer workflow is label-gated in `shadow` mode, which posts
advice but never approves. `.github/workflows/readiness.yml` provides the same gate as a reusable,
manual GitHub Actions check. Keep a private holdout suite; a benchmark committed beside every
expected answer is useful for development but cannot protect against prompt overfitting.

## CI setup

To run reviews automatically on pull requests, copy the workflow template into the consuming
repo (this is also proposed automatically by `/agent-review:init`):

```
cp templates/workflows/agent-review.yml <consuming-repo>/.github/workflows/agent-review.yml
```

It calls this repo's reusable workflow (`.github/workflows/review.yml`), which runs
`/agent-review:review <mode> ci` via `anthropics/claude-code-action`. Set the `ANTHROPIC_API_KEY`
secret in the consuming repo before merging the workflow — `Settings → Secrets and variables →
Actions → New repository secret`.

The template starts label-gated with `rollout_mode: shadow`. Add the `agent-review` label to trial
a PR. Removing the label gate or enabling approval is a separate maintainer decision after the
readiness command passes; the tool never edits that policy automatically.
Copy `templates/workflows/agent-review-interact.yml` as well to enable trusted collaborators to
use `@claude fix …` and taxonomy-coded `@claude dismiss … [code]: reason` comments; its reusable
workflow defaults `auto_approve` to false. Address runs split authority across two fresh jobs:
Claude receives a read-only, credential-scrubbed workspace and produces a validated patch/result
handoff; only the trusted publisher receives write permissions. The handoff artifact has one-day
retention and is deleted immediately after a successful publish, so it is retained only long
enough to diagnose a failed publish. Every check fails closed and reports back on the PR, so a
rejected command never just goes quiet. Numbers that are unknown or already resolved are skipped
and named in the reply; the remaining operations still run.

Fixes on fork PRs remain advisory because the base repository token cannot push to a fork.
Maintainer-authorized dismissals still update the canonical ledger, but they do not reach
`learnings/feedback.jsonl` — that file is committed alongside the fix, so the learning loop
records outcomes from same-repository PRs only.

## Updating

```
/plugin marketplace update cruglobal
```

Pulls the latest `agent-review` plugin release from this repo.

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
- **Consumer workflows track `@main`.** The generated `agent-review.yml` calls the reusable
  workflow at `@main`, so consuming repos pick up changes as they land. There is no release-tag or
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
| `skills/review/` | `/agent-review:review` — review orchestrator skill |
| `skills/learn/` | `/agent-review:learn` — learning-loop ratification skill |
| `engine/` | Node engine: risk scoring, agent selection, import-graph index, learnings store, CLI commands, unit tests (`*.test.cjs`) |
| `bin/agent-review` | Thin shim that requires the bundled `dist/agent-review.cjs` |
| `dist/agent-review.cjs` | esbuild bundle of the engine, committed so the plugin works with no install step |
| `schema/config.schema.json` | JSON Schema for `.claude/review/config.yml` |
| `templates/` | Files `/agent-review:init` instantiates into a consuming repo: `config.yml` skeleton, `rules/*.md` starters, `archetype.md` + `report.md` prompt/report skeletons, `settings-snippet.json`, `workflows/agent-review.yml` |
| `templates/evals/` | Seeded-bug suite format, example patch, and result-scoring workflow |
| `templates/static/` | ast-grep configuration/rule starter for deterministic changed-line findings |
| `fixtures/` | Fixture config used by engine tests |
| `.github/workflows/test.yml` | This repo's own CI — `npm ci && npm test && npm run check-dist` |
| `.github/workflows/review.yml` | Reusable workflow consuming repos call from their `agent-review.yml` |

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
