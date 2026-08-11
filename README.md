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
