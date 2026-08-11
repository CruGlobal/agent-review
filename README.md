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
/plugin marketplace add dr-bizz/agent-review
/plugin install agent-review@dr-bizz
```

This registers the `dr-bizz` marketplace and installs the `agent-review` plugin, which brings
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

## Updating

```
/plugin marketplace update dr-bizz
```

Pulls the latest `agent-review` plugin release from this repo.

## Known limitations

Current, deliberate boundaries — worth knowing before you rely on any of them.

- **Fork PRs are silently skipped.** `secrets.ANTHROPIC_API_KEY` is not exposed to workflow runs
  triggered from a fork, so the CI review job fails to start and posts nothing. PRs from branches
  in the same repository work normally; forks currently get no review and no explanation comment.
- **Impact analysis is JS/TS-only.** The import-graph index parses ES `import` and CommonJS
  `require` statements. In a repo of any other language it indexes nothing, and reviews report an
  empty blast radius — which reads like "no dependents" rather than "not measured". Set
  `index: { enabled: false }` there.
- **`new_dependency` and `critical_pkg_update` assume JSON manifests.** They diff the manifest as
  JSON, so they work for `package.json` and produce nothing for `Gemfile`, `pyproject.toml`,
  `go.mod`, or `Cargo.toml`. `lockfile_only_change` is path-based and works everywhere.
- **The skills assume the default `.claude/review` directory.** A custom location via
  `--review-dir` / `$AGENT_REVIEW_DIR` is honored by the CLI but not threaded through the skills'
  bash blocks, which reference `.claude/review/...` paths directly.
- **`config validate` checks the schema only.** It does not verify that the rule docs named in
  `agents[].rules` or `path_rules[].rules` actually exist on disk; a typo'd filename validates
  clean and silently contributes no rules at review time.
- **Some config keys are accepted but not yet enforced.** `learning.scope`,
  `learning.approval_required`, and `enforcement.mode` pass validation and are reserved for future
  behavior; today promotion is always approval-gated and reviews never block a merge.
- **Consumer workflows track `@main`.** The generated `agent-review.yml` calls the reusable
  workflow at `@main`, so consuming repos pick up changes as they land. There is no release-tag or
  SHA-pinning story yet — pin the `uses:` ref yourself if you need a frozen version.

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
