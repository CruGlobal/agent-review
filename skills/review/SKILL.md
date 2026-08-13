---
name: review
description: Multi-agent PR review with risk-scored agent selection, debate rounds, and automated fix suggestions
---

# Multi-Agent Code Review

Risk-scored agent selection, cross-examination debate, consensus synthesis, and suggested
automated fixes — driven by the consuming repository's own `.claude/review/config.yml` and
prose rule docs.

**Usage**:

```
/agent-review:review              # Standard mode (engine-selected agents, recommended)
/agent-review:review quick        # Fast feedback for simple changes
/agent-review:review deep        # Every enabled agent, maximum depth
/agent-review:review auto         # Depth picked from the engine's risk score (see Stage 0)
/agent-review:review standard ci  # Non-interactive CI run (posts to the PR)
/agent-review:review auto ci      # CI run, right-sized: skips no-risk diffs, quick for LOW,
                                  # standard for MEDIUM/HIGH, deep for CRITICAL
```

**Rough cost** (varies with diff size): quick ~$0.50 · standard ~$2-4 · deep ~$6-10.
`auto` costs whatever tier it resolves to — and $0 when it skips a no-risk diff.

**Incremental CI re-reviews**: in CI mode the posted report records the reviewed head SHA.
A later run on the same PR diffs only the commits since that SHA (falling back to a full
review after a force-push, when the recorded SHA is no longer reachable from the new head).

Everything repo-specific — risk globs, agent triggers, rule docs — comes from the consuming
repo's `.claude/review/` directory. Never hardcode repo specifics in this skill.

**Engine access**: all engine work goes through the `agent-review` binary shipped with this
plugin. Run `agent-review help` if you need the subcommand list. The binary defaults to the
current repo (`--root`) and `.claude/review` (`--review-dir`); rule-doc paths inside a plan are
relative to that review directory.

**Prompt templates**: this skill assembles agent prompts from files that ship with the plugin.
Resolve them relative to THIS skill file — `skills/review/SKILL.md` — so the plugin root is two
levels up:

- archetype prompt: `../../templates/archetype.md`
- report skeleton: `../../templates/report.md`

(If `${CLAUDE_PLUGIN_ROOT}` is set in the environment, `$CLAUDE_PLUGIN_ROOT/templates/…` is the
same file. Read the templates with the Read tool before substituting.)

---

## Stage 0A — Parse Review Mode & Initialize

### Determine Review Mode

The first argument selects the mode; the literal argument `ci` (in any position) selects CI mode.

```bash
MODE="${1:-standard}"
case "$MODE" in quick|deep|auto) ;; *) MODE="standard" ;; esac   # `ci` alone → standard mode

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
case "$MODE" in
  quick)
    echo "🏃 QUICK REVIEW MODE"
    echo "• 3 agents (testing, standards + the first triggered agent)"
    echo "• Model: Haiku (fast, cost-effective)"
    MODEL_OVERRIDE="haiku"
    AGENT_MODE="quick"
    ;;
  deep)
    echo "🔬 DEEP REVIEW MODE"
    echo "• Every enabled agent in config.yml"
    echo "• Model: Opus (maximum quality)"
    MODEL_OVERRIDE="opus"
    AGENT_MODE="deep"
    ;;
  auto)
    echo "🎚️ AUTO REVIEW MODE"
    echo "• Depth resolved from the engine's risk score after Stage 0 planning"
    echo "• score 0 → skip · LOW → quick · MEDIUM/HIGH → standard · CRITICAL → deep"
    MODEL_OVERRIDE=""
    AGENT_MODE="auto"   # placeholder — resolved right after the plan is computed
    ;;
  standard)
    echo "⚡ STANDARD REVIEW MODE (Recommended)"
    echo "• Agents selected by the review engine from the diff"
    echo "• Model: per-agent, from config.yml"
    MODEL_OVERRIDE=""
    AGENT_MODE="standard"
    ;;
esac
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ⚠️ CROSS-STAGE STATE — read this once, it applies to every bash block below.
# Each block you run is a SEPARATE shell: shell variables do NOT survive from one block to the
# next. Anything a later stage needs is persisted to /tmp/review_env.sh at the moment it is
# computed, and every later block starts by sourcing that file. Keep this discipline or later
# stages will silently operate on empty strings.
: > /tmp/review_env.sh    # fresh state for this review
cat >> /tmp/review_env.sh <<EOF
export MODE="$MODE" AGENT_MODE="$AGENT_MODE" MODEL_OVERRIDE="$MODEL_OVERRIDE"
EOF
```

### Detect CI Mode

```bash
. /tmp/review_env.sh 2>/dev/null || true
# CI mode: the `ci` argument was passed, or $AGENT_REVIEW_CI is set to anything non-empty.
CI_MODE=""
case " $* " in *" ci "*) CI_MODE="true" ;; esac
[ -n "${AGENT_REVIEW_CI:-}" ] && CI_MODE="true"
[ -n "$CI_MODE" ] && echo "🤖 CI MODE — non-interactive, no metrics, no fix execution"
echo "export CI_MODE=\"$CI_MODE\"" >> /tmp/review_env.sh
```

If `CI_MODE` is set, follow **[CI Mode](#ci-mode)** below — it changes what several stages do.

### Verify the repo is set up

```bash
agent-review config validate || {
  echo "❌ No valid .claude/review/config.yml in this repo. Run /agent-review:init first."
  exit 1
}
```

### Initialize Directories

```bash
. /tmp/review_env.sh 2>/dev/null || true
mkdir -p /tmp/automated_fixes
# Metrics live in the consuming repo's review dir; skipped entirely in CI mode.
[ -z "${CI_MODE:-}" ] && mkdir -p .claude/review/metrics/history
```

---

## CI Mode

Active when the invocation includes the `ci` argument or `$AGENT_REVIEW_CI` is set. In CI mode:

| Stage                        | CI behavior                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| Stage 3/4 (debate/rebuttal)  | **Skipped** unless `$AGENT_REVIEW_DEBATE` is exactly `true`           |
| Stage 5B (metrics dashboard) | **Skipped entirely** — nothing written under `.claude/review/metrics/` |
| Stage 6 (report)             | Runs; fixes are described but presented as suggestions only           |
| Stage 7 (metrics commit)     | **Skipped entirely** — no commits, no pushes, no interactive menu     |
| Fix scripts                  | **Never executed.** Not even offered. They appear in the report only  |
| Ending                       | Post the report to the PR (below) instead of the interactive menu      |

When debate is skipped, say so in the report ("Debate rounds: 0 (skipped in CI)") and omit the
debate transcript and debate-statistics blocks from the report entirely.

### Post the report to the PR (create-or-update)

Always embed the `<!-- agent-review -->` marker so subsequent runs update the same comment
instead of stacking new ones.

```bash
. /tmp/review_env.sh 2>/dev/null || true
PR_NUMBER="${PR_NUMBER:-$(gh pr view --json number -q .number 2>/dev/null)}"
if [ -z "$PR_NUMBER" ]; then
  echo "⚠️  No PR number available — report left at /tmp/agent_review_report.md"
else
  REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
  # Line 2 records the head SHA this report covers — the next CI run reads it back to review
  # only the commits since (see the incremental block in Stage 0).
  { echo '<!-- agent-review -->'
    [ -n "${HEAD_REF:-}" ] && echo "<!-- agent-review-head: $HEAD_REF -->"
    echo
    cat /tmp/agent_review_report.md
  } > /tmp/agent_review_comment.md

  # `--paginate` runs `--jq` once PER PAGE, so a marker match on more than one page emits more
  # than one id. Take the first — the oldest marked comment is the one we keep updating.
  EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq 'map(select(.body | contains("<!-- agent-review -->"))) | first | .id // empty' \
    2>/dev/null | head -n1)

  if [ -n "$EXISTING" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$EXISTING" -F body=@/tmp/agent_review_comment.md
    echo "✅ Updated existing review comment ($EXISTING)"
  else
    gh pr comment "$PR_NUMBER" --body-file /tmp/agent_review_comment.md
    echo "✅ Posted review comment"
  fi
fi
```

---

## Stage 0 — Context Gathering & Risk Assessment

### Gather PR Context

```bash
. /tmp/review_env.sh 2>/dev/null || true

# Resolve the PR number ONCE, here, and persist it — every later `gh pr view`/`gh pr comment`
# depends on it. CI checks out a PR as a DETACHED HEAD, so a bare `gh pr view` has no branch to
# resolve and returns nothing; the workflow therefore exports $PR_NUMBER, which wins. Locally
# (on a PR branch) the fallback resolves it from the branch instead.
PR_NUMBER="${PR_NUMBER:-$(gh pr view --json number -q .number 2>/dev/null)}"
[ -n "$PR_NUMBER" ] && echo "PR #$PR_NUMBER" || echo "No PR context — local review"

# One id per review run, so successive runs never clobber each other's pending findings.
REVIEW_ID="${PR_NUMBER:-local}-$(date +%Y%m%d-%H%M%S)"

# PR metadata if we're on a PR (harmless when we're not). `${PR_NUMBER:+"$PR_NUMBER"}` passes the
# number when we have one and expands to NOTHING when we don't — never an empty argument.
gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json number,title,baseRefName,headRefName,additions,deletions,changedFiles 2>/dev/null \
  || echo "Not in a PR branch — falling back to the configured base branch"

DAY_OF_WEEK=$(date +%A)
echo "Today is: $DAY_OF_WEEK"
cat >> /tmp/review_env.sh <<EOF
export DAY_OF_WEEK="$DAY_OF_WEEK" PR_NUMBER="$PR_NUMBER" REVIEW_ID="$REVIEW_ID"
EOF
```

Build the diff manifest the whole review runs on:

```bash
. /tmp/review_env.sh 2>/dev/null || true

BASE_REF=$(gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json baseRefOid -q .baseRefOid 2>/dev/null)
HEAD_REF=$(gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json headRefOid -q .headRefOid 2>/dev/null)

# Incremental re-review (CI only): a previous CI run recorded the head SHA it reviewed
# inside the posted report comment (`<!-- agent-review-head: <sha> -->`). When that SHA is
# still an ancestor of the current head, review only the commits since it. A force-push
# breaks ancestry, so the recorded SHA fails the checks below and we fall back to a full
# review — the history we reviewed no longer exists, so the delta cannot be trusted.
INCREMENTAL="" LAST_REVIEWED=""
if [ -n "$CI_MODE" ] && [ -n "$PR_NUMBER" ] && [ -n "$HEAD_REF" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
  LAST_REVIEWED=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' 2>/dev/null \
    | tr -d '\r' | sed -n 's/^<!-- agent-review-head: \([0-9a-f]\{7,40\}\) -->$/\1/p' | head -1)
  if [ -n "$LAST_REVIEWED" ] \
     && git cat-file -e "$LAST_REVIEWED^{commit}" 2>/dev/null \
     && git merge-base --is-ancestor "$LAST_REVIEWED" "$HEAD_REF" 2>/dev/null; then
    if [ "$(git rev-parse "$LAST_REVIEWED")" = "$(git rev-parse "$HEAD_REF")" ]; then
      echo "✅ Head $HEAD_REF already reviewed — nothing new since the last report. Exiting."
      exit 0
    fi
    INCREMENTAL="true"
  elif [ -n "$LAST_REVIEWED" ]; then
    echo "⚠️  Recorded reviewed SHA $LAST_REVIEWED is not an ancestor of $HEAD_REF (force push?) — full review."
    LAST_REVIEWED=""
  fi
fi

if [ -n "$INCREMENTAL" ]; then
  RANGE="$LAST_REVIEWED..$HEAD_REF"
  echo "♻️  INCREMENTAL REVIEW — commits since previously reviewed $LAST_REVIEWED"
elif [ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ]; then
  RANGE="$BASE_REF..$HEAD_REF"
else
  # Fallback: merge-base against the repo's configured base branch.
  # `config get` exits 0 and prints the literal string "undefined" for a key the config omits
  # (base_branch is optional), so guard on BOTH empty and "undefined" — otherwise RANGE would
  # degrade to "..HEAD" and the whole review would silently run on an empty diff.
  BASE_BRANCH=$(agent-review config get base_branch 2>/dev/null)
  if [ -z "$BASE_BRANCH" ] || [ "$BASE_BRANCH" = "undefined" ] || [ "$BASE_BRANCH" = "null" ]; then
    BASE_BRANCH=main
  fi
  # A CI checkout has no local branches — only remote-tracking refs — so try `origin/<branch>`
  # first and fall back to the bare name for local runs where `main` exists as a local branch.
  MERGE_BASE=$(git merge-base HEAD "origin/$BASE_BRANCH" 2>/dev/null) \
    || MERGE_BASE=$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null) \
    || {
      echo "❌ Could not resolve a diff base (tried 'origin/$BASE_BRANCH' and '$BASE_BRANCH'). Set base_branch in config.yml."
      exit 1
    }
  RANGE="$MERGE_BASE..HEAD"
fi

echo "Diff range: $RANGE"
git diff $RANGE --name-only > /tmp/changed_files.txt
git diff $RANGE --stat      > /tmp/diff_stat.txt
git diff $RANGE             > /tmp/pr_diff.txt

if [ ! -s /tmp/changed_files.txt ]; then
  if [ -n "$INCREMENTAL" ]; then
    echo "✅ No net changes since the last reviewed head — nothing to review. Exiting."
    exit 0
  fi
  echo "❌ No changed files in $RANGE — nothing to review. Check the base ref."
  exit 1
fi
wc -l < /tmp/changed_files.txt

cat >> /tmp/review_env.sh <<EOF
export BASE_REF="$BASE_REF" HEAD_REF="$HEAD_REF" RANGE="$RANGE"
export INCREMENTAL="$INCREMENTAL" LAST_REVIEWED="$LAST_REVIEWED"
EOF
```

Paths listed under `excluded_paths` in config (`agent-review config get excluded_paths`) are
excluded from risk scoring and agent selection by the engine — agents should not raise findings
against them either.

### Read Project Standards

Read the repo's `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` (whichever exist) to understand the
project's conventions. That context is shared with all agents via the archetype prompt, which
instructs each agent to read them too.

### Build the Review Plan

Risk scoring, agent selection, special-pattern detection, and rule resolution are driven by the
declarative review core (`.claude/review/config.yml`) — never computed inline here:

```bash
agent-review plan \
  --files /tmp/changed_files.txt \
  --stat /tmp/diff_stat.txt \
  --diff /tmp/pr_diff.txt \
  --scope "${REVIEW_SCOPE:-single_feature}" \
  > /tmp/review_plan.json
cat /tmp/review_plan.json
```

`REVIEW_SCOPE` is the heuristic scope you set from the change footprint (default `single_feature`;
use `multi_feature`, `cross_cutting`, or `core_infra` for changes spanning unrelated feature areas
or core infrastructure). The plan JSON has this shape:

```json
{
  "profile": "standard",
  "risk": {
    "score": 0,
    "level": "LOW",
    "reviewer": "...",
    "factors": {
      "patternScore": 0,
      "volumeScore": 0,
      "specialScore": 0,
      "scopeMultiplier": 1.0,
      "subtotal": 0
    },
    "special": ["..."]
  },
  "agents": [
    {
      "id": "standards",
      "model": "smart",
      "matchedBy": "always",
      "rules": ["rules/standards.md"]
    }
  ]
}
```

### Auto Mode Resolution

**Only when `MODE` is `auto`.** The placeholder mode is resolved here, from the engine's risk
score — never from your own judgment of the diff:

```bash
. /tmp/review_env.sh 2>/dev/null || true
if [ "$MODE" = "auto" ]; then
  SCORE=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.risk.score)' 2>/dev/null)
  LEVEL=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.risk.level)' 2>/dev/null)
  if [ "${SCORE:-1}" = "0" ]; then
    # Nothing risk-scored in the diff (excluded or 0-point paths only, small volume).
    if [ -n "$CI_MODE" ]; then
      # Post a minimal skip note. The CI posting step prepends the comment markers
      # (including the reviewed-head marker, so the next run still diffs incrementally).
      echo "🎚️ **agent-review: skipped** — risk score 0 (no reviewable risk in this diff)." \
        > /tmp/agent_review_report.md
      echo "AUTO MODE: skip (score 0) — post /tmp/agent_review_report.md via the CI posting step, then exit."
    else
      echo "AUTO MODE: risk score 0 — nothing worth a review pass. Run 'quick' explicitly to force one."
    fi
    RESOLVED="skip"
  else
    case "$LEVEL" in
      LOW)      RESOLVED="quick";    MODEL_OVERRIDE="haiku" ;;
      CRITICAL) RESOLVED="deep";     MODEL_OVERRIDE="opus"  ;;
      *)        RESOLVED="standard"; MODEL_OVERRIDE=""      ;;
    esac
    echo "🎚️ AUTO MODE resolved: $LEVEL risk → $RESOLVED"
  fi
  MODE="$RESOLVED" AGENT_MODE="$RESOLVED"
  cat >> /tmp/review_env.sh <<EOF
export MODE="$MODE" AGENT_MODE="$AGENT_MODE" MODEL_OVERRIDE="$MODEL_OVERRIDE"
EOF
fi
```

If auto resolved to `skip`: in CI, run the **[CI Mode posting step](#post-the-report-to-the-pr-create-or-update)**
with the skip note as the report, then go straight to Stage 8 cleanup — launch no agents. Locally,
report the skip and stop. If it resolved to `quick`/`standard`/`deep`, continue exactly as if that
mode had been passed on the command line.

### Risk Assessment

Read `risk.score`, `risk.level`, `risk.reviewer`, and `risk.special` from `/tmp/review_plan.json`
(do NOT compute the score inline — the engine is the single source of truth). The classification
comes from `risk.levels` in config; the shipped default is:

- 0-3 points: **LOW** → entry-level+ can review
- 4-6 points: **MEDIUM** → entry-level+ can review
- 7-9 points: **HIGH** → experienced dev+ should review
- 10+ points: **CRITICAL** → senior maintainer must review

`risk.special[]` lists any special patterns that fired (e.g. `new_dependency`,
`critical_pkg_update`, `lockfile_only_change`, `migration_change`, `config_security_change`) —
surface these as risk factors.

Display the summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Risk Score: [risk.score]            ← from /tmp/review_plan.json
Risk Level: [risk.level]            ← LOW | MEDIUM | HIGH | CRITICAL
Day: [DAY_OF_WEEK]

Files Changed: [N]
Lines Changed: +[X] -[Y]

Risk Factors Detected:
• [risk.special[] entries, plus notable risk.factors highlights]

Required Reviewer: [risk.reviewer]  ← from /tmp/review_plan.json

💰 Estimated Review Cost: $[X.XX]

[IF FRIDAY/WEEKEND: warning scaled to the risk level]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Stage 0B — Agent Selection

The set of agents to launch comes from the engine, not from hardcoded checks. Each entry in the
plan's `agents[]` has:

- `id` — the agent identifier as configured (e.g. `security`, `architecture`, `testing`)
- `model` — `smart` | `opus` | `sonnet` | `haiku`
- `matchedBy` — why it was selected (`always`, `path:<glob>`, or `content:<substring>`)
- `rules` — rule docs to load into that agent's prompt, relative to `.claude/review/`

**Mode semantics** — build the launch list as follows:

- **standard** → the plan's `agents[]`, exactly. Do not add, drop, or reorder.
- **deep** → every agent with `enabled: true` in config (`agent-review config get agents`), even
  ones whose triggers did not fire. For agents also present in the plan, use the plan's entry (its
  `rules[]` already includes any matching `path_rules`); for the others, use the config entry's own
  `id`/`title`/`expertise`/`rules`. Note the asymmetry: config-only agents get their own `rules[]`
  without `path_rules` merging; only plan entries carry those.
- **quick** → at most three agents drawn from the plan's `agents[]`: `testing`, `standards`, and the
  first entry not already picked (the first triggered agent). If any of those ids do not exist in
  this repo's config, just take the first three plan entries.

```bash
# Enabled agents (used by deep mode); plan agents[] drives quick/standard.
agent-review config get agents > /tmp/config_agents.json
```

Announce the selection, including each agent's `matchedBy` reason, e.g.:

```
🤖 Agents selected:
✅ standards      — always
✅ security       — path:src/app/api/**
✅ data-integrity — content:createClient
```

---

## Stage 1 — Launch Specialized Review Agents (Parallel)

Launch the selected agents in parallel with the Task tool.

**IMPORTANT:** Use a SINGLE message with multiple Task tool invocations so they run in parallel.

Display: "🚀 Launching [N] specialized review agents in parallel..."

### Approved learnings (learning layer)

Before assembling prompts, fetch approved `rule` learnings (gated on the learning layer):

```bash
if [ "$(agent-review config get learning.enabled 2>/dev/null)" = "true" ]; then
  agent-review rules > /tmp/review_rules.json 2>/dev/null || echo "[]" > /tmp/review_rules.json
else
  echo "[]" > /tmp/review_rules.json
fi
```

Each entry is `{ paths, ruleText, agent }` — a repository-specific rule ratified by a human from
prior review feedback.

### Assemble each agent prompt from the archetype template

There are no per-agent prompts in this skill. Every agent gets the SAME prompt skeleton — the
plugin's `templates/archetype.md` (see the path note at the top of this file) — with seven
placeholders filled in. Read the template once, then for EACH entry in the launch list produce one
filled copy:

| Placeholder             | Fill with                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{TITLE}}`             | The agent's `title`. Fallback when absent: the `id` with `-`/`_` turned into spaces and each word capitalized, plus `" Review Agent"` (e.g. `data-integrity` → `Data Integrity Review Agent`).                                                          |
| `{{EXPERTISE}}`         | The agent's `expertise` string. Fallback: empty (leave the line's value blank rather than inventing expertise).                                                                                                                                        |
| `{{RISK_CONTEXT}}`      | A bullet block from the plan: `- Risk Score: <score> (<level>)`, `- Special patterns: <risk.special joined, or "none">`, `- Changed Files: <N>`, `- Lines Changed: +<X> -<Y>`, `- Selected because: <matchedBy>`.                                       |
| `{{PROFILE_INSTRUCTION}}` | From the plan's `profile`: `chill` → "Report only high-confidence, severity ≥ 7 findings; suppress nits." · `standard` → "Report findings at all severities per the output format above." · `assertive` → "Report all findings including low-severity suggestions." |
| `{{RULES}}`             | The full contents of every doc in the agent's `rules[]`, resolved against the repo's review dir (`rules/security.md` → `.claude/review/rules/security.md`), each preceded by a `----- <path> -----` line. If a listed doc is missing, note it in your output and continue with the rest. |
| `{{LEARNINGS}}`         | Entries from `/tmp/review_rules.json` whose `agent` matches this agent's `id`, rendered as `APPROVED LEARNINGS (ratified from prior reviews — apply to files under <paths>):` followed by one bullet per `ruleText`. Empty string when there are none. |
| `{{IMPACT}}`            | For the `architecture` and `data-integrity` agents only, and only when `/tmp/review_impact.json` exists: the **actual dependents, inlined** (see the block below). Empty string for every other agent, and when impact was not computed. |

**`{{IMPACT}}` content** — the template splices this in immediately after instruction 5, so it must
begin with its own step number and read as a standalone step. Build it from
`/tmp/review_impact.json` (Stage 1B), listing real file names rather than pointing at the JSON:

```
6. BLAST RADIUS — this change has <blastRadius> transitive dependents. The changed files below
   are imported by these files; verify the change does not break them:
   - <changed file>: <its directDependents, comma-separated>
   - <changed file>: <its directDependents, comma-separated>
   Highest-impact changed files: <topImpacted entries as "file (N dependents)">
   [If `truncated` is true, add: "(dependent list truncated by the traversal cap.)"]
```

Truncate sensibly — at most ~15 dependent paths per changed file and ~15 changed files, with a
"…and N more" tail — so a wide blast radius cannot crowd out the rest of the prompt. Omit the
placeholder entirely (empty string) if `blastRadius` is 0.

Then launch each one with the Task tool:

- **description**: `"<title> review"`
- **subagent_type**: `"general-purpose"`
- **model**: `MODEL_OVERRIDE` if set by the mode (quick → `haiku`, deep → `opus`); otherwise the
  agent's `model` from the plan, where `smart` resolves to `sonnet` — or `opus` when `risk.level`
  is `HIGH` or `CRITICAL`.
- **prompt**: the filled archetype text

The rule docs are authoritative for what each agent checks; they carry all repo-specific focus
areas. Do not add repo-specific instructions here.

After launching, display:

```
✅ All [N] agents launched in parallel
⏳ Waiting for agents to complete their reviews...
💰 Estimated cost: $[X.XX]
```

---

## Stage 1B — Dependency Impact Analysis (Parallel)

Compute dependency impact from the persisted import graph (not grep). Run this **before** Stage 1
whenever the launch list contains the `architecture` or `data-integrity` agent — their `{{IMPACT}}`
slot needs the output; otherwise run it in parallel while the agents work. It is fast. Gated on the
index being enabled in config:

```bash
. /tmp/review_env.sh 2>/dev/null || true
echo "🔍 Analyzing dependency impact (index engine)..."

if [ "$(agent-review config get index.enabled 2>/dev/null)" = "true" ]; then
  if [ -n "${BASE_REF:-}" ]; then
    agent-review impact --base "$BASE_REF" > /tmp/review_impact.json
  else
    agent-review impact > /tmp/review_impact.json
  fi
  cat /tmp/review_impact.json
else
  echo "ℹ️  Index disabled in config.yml — skipping impact analysis."
fi
echo "✅ Dependency analysis complete"
```

The JSON report has these fields:

- `directDependents` — `{ [changedFile]: string[] }`, the immediate importers of each changed file
- `transitiveDependents` — flat list of all files transitively reachable as dependents (blast radius)
- `blastRadius` — count of `transitiveDependents`
- `topImpacted` — `[{ file, dependentCount }]`, highest impact first
- `truncated` — `true` if the traversal cap was hit

**Display** `blastRadius` and `topImpacted` as the dependency-impact summary (flag `truncated` if
set). **Feed** the actual dependent file names into the architecture and data-integrity agents by
inlining them in `{{IMPACT}}` (Stage 1) — the agents never read this JSON themselves, so whatever
you do not inline is invisible to them.

---

## Stage 2 — Collect Agent Reports

Wait for all agents to complete and display progress, one line per launched agent:

```
Agent Reviews Complete:
✅ [Agent title] - Found [X] critical, [Y] concerns
✅ [Agent title] - Found [X] critical, [Y] concerns
```

Parse each agent's output and extract:

- Critical issues with severity scores
- Important concerns with severity scores
- Suggestions
- Rule checklist results (if the agent emitted that section)
- Questions for other agents
- Confidence level

Store these in structured form for the debate rounds.

---

## Stage 2B — Extract & Organize Automated Fixes

Parse agent outputs for automated fixes:

```bash
. /tmp/review_env.sh 2>/dev/null || true
echo "🔧 Extracting automated fixes from agent reports..."

FIX_COUNT=$(find /tmp/automated_fixes -name "fix_*.sh" 2>/dev/null | wc -l | tr -d ' ')
echo "export FIX_COUNT=\"$FIX_COUNT\"" >> /tmp/review_env.sh

if [ "$FIX_COUNT" -gt 0 ]; then
  echo "Found $FIX_COUNT automated fixes"

  # Organize by category (categories come from the agents' own Category: fields)
  echo "By Category:" > /tmp/fix_summary.txt
  for fix in /tmp/automated_fixes/fix_*.sh; do
    [ -f "$fix" ] || continue
    basename "$fix" | sed 's/^fix_[0-9]*_//; s/\.sh$//'
  done | sort | uniq -c | while read -r count category; do
    echo "  • $category: $count fixes" | tee -a /tmp/fix_summary.txt
  done
  cat /tmp/fix_summary.txt

  # Create master apply script.
  # SECURITY: these fix_*.sh scripts are MODEL-GENERATED from (attacker-influenceable) PR content
  # and are UNTRUSTED. apply_all.sh therefore DRY-RUNS by default — it prints each fix for human
  # review and applies nothing unless explicitly re-run with `--yes`.
  cat > /tmp/automated_fixes/apply_all.sh << 'EOF'
#!/bin/bash
set -euo pipefail
# fix_*.sh are model-generated from PR content and UNTRUSTED — review each before applying.
if [ "${1:-}" != "--yes" ]; then
  echo "DRY RUN — review each fix, then re-run with --yes to apply. Nothing applied yet."
  for fix in /tmp/automated_fixes/fix_*.sh; do
    [ -f "$fix" ] || continue
    echo ""; echo "===== $(basename "$fix") ====="; cat "$fix"
  done
  echo ""; echo "To apply after review:  bash /tmp/automated_fixes/apply_all.sh --yes"
  exit 0
fi
echo "Applying all automated fixes..."
for fix in /tmp/automated_fixes/fix_*.sh; do
  if [ -f "$fix" ]; then
    echo "Applying: $(basename "$fix")"
    bash "$fix"
  fi
done
echo "✅ All fixes applied"
echo "Review changes with: git diff"
echo "To undo: git checkout ."
EOF
  chmod +x /tmp/automated_fixes/apply_all.sh
else
  echo "No automated fixes available"
fi
```

**In CI mode, fix scripts are never executed** — not by `apply_all.sh`, not individually. They are
described in the report as suggestions for a human to review and run locally.

---

## Stage 3 — Cross-Examination Debate (Round 1)

**Skip this stage in CI mode unless `$AGENT_REVIEW_DEBATE` is exactly `true`.**

Facilitate the first debate round where agents challenge each other.

Display: "🗣️ Starting cross-examination debate round..."

For each launched agent, launch a new Task with their original findings plus all other agents'
findings.

### Debate Prompt Template

Debate reuses each agent's Stage-1 model — a deliberate deviation from the in-repo review system
this skill was extracted from, which pinned every debate round to the largest model. A cheap agent
therefore stays cheap through debate and rebuttal.

Use the Task tool for each agent with:

- **description**: "[Agent title] cross-examination"
- **subagent_type**: "general-purpose"
- **model**: same model that agent used in Stage 1
- **prompt**:

```
You are the [Agent Title] in the cross-examination debate phase.

YOUR ORIGINAL FINDINGS:
[Paste that agent's original review output with severity scores]

OTHER AGENTS' FINDINGS:
[All other agents' findings with severity scores]

MISSION: Review other agents' findings from your specialized perspective.

DEBATE ACTIONS (use severity scores to prioritize):
1. **CHALLENGE** - Disagree with a finding (max 3 challenges, focus on severity 7+)
   - Cite your reasoning with evidence
   - Suggest revised severity score
2. **SUPPORT** - Strongly agree and add context (for severity 8+)
3. **EXPAND** - Build on a finding with additional concerns
4. **QUESTION** - Ask for clarification

RULES:
- Maximum 3 challenges (focus on important disagreements)
- Provide specific reasoning and evidence
- Reference file:line when possible
- Suggest severity score adjustments (1-10)
- Be constructive, not combative

OUTPUT FORMAT:

## [Agent Title] - Cross-Examination

### Challenges
- **Challenge to [Agent X] re: [finding]**
  - Original severity: [X]/10
  - Why I disagree: [reasoning]
  - Evidence: [supporting evidence]
  - Revised severity: [Y]/10
  - Revised view: [your assessment]

### Strong Support
- **Support for [Agent X] re: [finding at severity [X]/10]**
  - Additional context: [your perspective]
  - Added concerns: [related issues]
  - Severity agreement: [X]/10 is correct

### Expansions
- **Building on [Agent X]'s [topic]**:
  - Additional severity: [+N] points
  - Reasoning: [why more severe]

### Questions
- **To [Agent X]**: [question]
  - Why asking: [reason]

### Summary
- Challenges: [N]
- Supports: [N]
- Key disagreements: [main contentions]
```

Launch all debate agents in parallel.

```
✅ All agents engaged in cross-examination
⏳ Waiting for debate round 1 to complete...
```

---

## Stage 4 — Rebuttals (Debate Round 2)

**Skip this stage whenever Stage 3 was skipped.**

Collect all challenges from Stage 3 and give each challenged agent a chance to respond.

Display: "🔄 Starting rebuttal round..."

Use the Task tool with:

- **description**: "[Agent title] rebuttal"
- **subagent_type**: "general-purpose"
- **model**: same model that agent used in Stage 1
- **prompt**:

```
You are the [Agent Title] responding to challenges from debate round 1.

YOUR ORIGINAL FINDINGS:
[Their original findings with severity scores]

CHALLENGES RAISED AGAINST YOU:
[List each challenge with severity score adjustments]

MISSION: Respond to each challenge, adjusting severity scores based on evidence.

RESPONSE OPTIONS:
1. **DEFEND** - Additional evidence supports your finding
   - Maintain original severity score
2. **CONCEDE** - Acknowledge challenge, downgrade/remove finding
   - Lower severity score or remove
3. **REVISE** - Update finding based on new perspective
   - Adjust severity score
4. **ESCALATE** - Flag as unresolved, needs human senior review
   - Mark for human decision

OUTPUT FORMAT:

## [Agent Title] - Rebuttals

### Response to Challenge #1 from [Agent]
- Original Severity: [X]/10
- Decision: DEFEND/CONCEDE/REVISE/ESCALATE
- Reasoning: [explanation]
- Final Severity: [Y]/10
- Updated Finding (if revised):
  - Severity: [Y]/10
  - Description: [updated]

### Response to Challenge #2
[Same format]

### Summary
- Defended: [N]
- Conceded: [N]
- Revised: [N]
- Escalated: [N]
- Average severity adjustment: [+/-X]
```

Launch rebuttal tasks for all challenged agents.

```
✅ Rebuttal round complete
📊 Synthesizing consensus...
```

---

## Stage 5 — Consensus Synthesis

Analyze all findings, debates, and final severity scores to build consensus.

**Process:**

1. Collect all final findings with severity scores
2. Group by similarity (same file:line or same general issue)
3. Calculate average severity score for each finding
4. Count agent agreement

**Consensus Levels (using severity scores):**

- **Average 9-10, 4+ agents**: CRITICAL BLOCKER
- **Average 8-9, 3+ agents**: HIGH PRIORITY BLOCKER
- **Average 7-8, 3+ agents**: IMPORTANT (should fix before merge)
- **Average 5-7, 2+ agents**: MEDIUM PRIORITY
- **Average 3-5, 1-2 agents**: SUGGESTION
- **Unresolved Debate** (agents couldn't agree, severity differs by 4+): NEEDS HUMAN REVIEW

When fewer agents ran than a tier's agent count requires (small reviews, quick mode, or CI without
debate), fall back to the severity average alone and note the reduced corroboration.

**Profile-scaled reporting cutoff** (from the plan's `profile`) — apply the same floor the agents
used so consensus output stays consistent with what was collected:

- `chill` → only surface consensus findings with average severity ≥ 7; drop MEDIUM/SUGGESTION tiers.
- `standard` → report all tiers above (default).
- `assertive` → report all tiers, including low-severity suggestions, and do not collapse them.

For each grouped finding, determine: final severity (average), classification, which agents flagged
it, debate summary, consensus strength.

Display a summary:

```
📊 Consensus Analysis:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Critical Blockers (Severity 9-10): [N]
High Priority Blockers (Severity 8-9): [N]
Important Issues (Severity 7-8): [N]
Medium Priority (Severity 5-7): [N]
Suggestions (Severity 3-5): [N]
Unresolved Debates: [N]

Total Findings: [N]
Average Confidence: [High/Medium/Low]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Stage 5B — Historical Metrics Dashboard

**SKIP THIS ENTIRE STAGE IN CI MODE.** Nothing under `.claude/review/metrics/` is written in CI.

```bash
. /tmp/review_env.sh 2>/dev/null || true   # AGENT_MODE, FIX_COUNT, CI_MODE …
echo "📊 Generating quality metrics dashboard..."

PR_NUM="${PR_NUMBER:-$(gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json number -q .number 2>/dev/null)}"
[ -n "$PR_NUM" ] || PR_NUM="local"
CURRENT_DATE=$(date +%Y-%m-%d)
AUTHOR=$(git config user.name || echo "Developer")

# Average consensus severity for this review (from Stage 5) — substitute the real number.
CURRENT_SEVERITY="[X.X]"

cat >> /tmp/review_env.sh <<EOF
export PR_NUM="$PR_NUM" CURRENT_DATE="$CURRENT_DATE" CURRENT_SEVERITY="$CURRENT_SEVERITY"
EOF

if [ -f .claude/review/metrics/severity_history.txt ]; then
  AVG_SEVERITY=$(awk '{sum+=$2; count++} END {printf "%.1f", sum/count}' \
    .claude/review/metrics/severity_history.txt 2>/dev/null || echo "N/A")
  LAST_10=$(tail -10 .claude/review/metrics/severity_history.txt | awk '{print $2}')
else
  AVG_SEVERITY="N/A"
  LAST_10=""
fi

cat > .claude/review/metrics/PR_${PR_NUM}_metrics.md << EOF
# 📊 Code Quality Metrics Dashboard

**PR**: #${PR_NUM}
**Date**: ${CURRENT_DATE}
**Author**: ${AUTHOR}
**Review Mode**: ${AGENT_MODE}

---

## 📈 Quality Trend

### Current Review
- **Quality Score**: ${CURRENT_SEVERITY}/10
- **Risk Level**: [from Stage 0]
- **Findings**: [N] blockers, [N] important, [N] suggestions

### Historical Comparison
- **Repo Average**: ${AVG_SEVERITY}/10 (last 10 reviews)
- **Trend**: [↗️ Improving / → Stable / ↘️ Declining]

\`\`\`
Last 10 reviews:
${LAST_10}
\`\`\`

---

## 🔍 This Review

- **Mode**: ${AGENT_MODE}
- **Agents**: [list of launched agent titles]
- **Time**: [X] minutes

### Key Findings
1. [Top category] - [count] issues
2. [Second category] - [count] issues
3. [Third category] - [count] issues

### Suggested Fixes
- **Total**: ${FIX_COUNT}
- **High Confidence**: [count]
- **Categories**: [list]

---

## 📦 Dependency Impact

[High-impact changes from Stage 1B]

---

_Generated by agent-review | Full report: /tmp/agent_review_report.md_
EOF

echo "✅ Metrics dashboard created: .claude/review/metrics/PR_${PR_NUM}_metrics.md"
```

### Update Review History

```bash
. /tmp/review_env.sh 2>/dev/null || true
echo "$PR_NUM $CURRENT_SEVERITY $CURRENT_DATE" >> .claude/review/metrics/severity_history.txt

cat > .claude/review/metrics/history/${CURRENT_DATE}_${PR_NUM}.json << EOF
{
  "date": "$CURRENT_DATE",
  "pr_number": "$PR_NUM",
  "severity": $CURRENT_SEVERITY,
  "mode": "$AGENT_MODE",
  "agents_used": [N],
  "time_minutes": "[actual time]",
  "findings": {
    "critical": [N],
    "high": [N],
    "important": [N],
    "suggestions": [N]
  },
  "fixes_available": $FIX_COUNT
}
EOF

echo "✅ Review history updated"
```

---

## Stage 6 — Generate Review Report

### Capture consensus for the learning layer

Gated on the learning layer being enabled. Write the consensus findings as a JSON array to
`/tmp/consensus_findings.json` — each entry shaped
`{ agent, category, severity, file, line, message }` — then emit them and apply approved learnings:

```bash
. /tmp/review_env.sh 2>/dev/null || true   # REVIEW_ID, set once in Stage 0
if [ "$(agent-review config get learning.enabled 2>/dev/null)" = "true" ]; then
  # REVIEW_ID is "<pr-or-local>-<timestamp>", so two reviews of the same branch never write to the
  # same pending/<reviewId>.yml.
  agent-review emit --in /tmp/consensus_findings.json --review "${REVIEW_ID:-local}"
  agent-review filter > /tmp/review_filtered.json   # defaults to the just-emitted findings.json
fi
```

Report the `kept` findings from `/tmp/review_filtered.json` and note the count of `suppressed`
findings (suppressed by approved learnings). Tell the user they can mark outcomes in the emitted
`pending/<reviewId>.yml` (set each finding's `outcome` to `accepted` or `dismissed`), then run
`agent-review feedback <that file>` and `agent-review learn` to mine new proposed learnings, and
`agent-review learnings` / `agent-review approve <id>` to ratify them.

### Write the report

Read the plugin's report skeleton — `../../templates/report.md`, relative to this skill file — and
fill it in from the consensus, risk assessment, impact analysis, and agent reports. The skeleton's
bracketed placeholders and `[IF …]` / `[FOR EACH …]` directives tell you exactly what goes where.
Honor its conditionals:

- One summary-table row per **launched** agent, using each agent's `title`, in launch order.
- Omit the debate-statistics block and the debate transcript entirely when debate rounds did not run.
- Omit the learning-layer line when the learning layer is disabled.
- Fill the DEPENDENCY IMPACT section from `/tmp/review_impact.json` (`blastRadius`, `topImpacted`,
  `truncated`) — that is the only impact artifact this skill produces. State "index disabled" there
  when Stage 1B was skipped, and drop the breaking-changes subsection when nothing was detected.

Save the filled report to `/tmp/agent_review_report.md`.

In CI mode, the "AUTOMATED FIXES AVAILABLE" section stays — but frame it as suggestions a human can
apply locally after review, and never execute anything.

---

## Stage 7 — Commit Metrics & Interactive Actions

**SKIP THIS ENTIRE STAGE IN CI MODE** — no commits, no pushes, no interactive menu. In CI, go
straight to the [CI Mode](#ci-mode) posting step, then Stage 8.

### Commit Metrics Dashboard

```bash
. /tmp/review_env.sh 2>/dev/null || true   # PR_NUM, CURRENT_DATE, CURRENT_SEVERITY, AGENT_MODE, FIX_COUNT
if [ -f ".claude/review/metrics/PR_${PR_NUM:-}_metrics.md" ]; then
  echo "📊 Committing quality metrics dashboard..."
  git add .claude/review/metrics/PR_${PR_NUM}_metrics.md \
          .claude/review/metrics/severity_history.txt \
          .claude/review/metrics/history/${CURRENT_DATE}_${PR_NUM}.json

  git commit -m "chore(review): add code review metrics

Quality Score: ${CURRENT_SEVERITY}/10
Mode: ${AGENT_MODE}
Fixes suggested: ${FIX_COUNT}

Generated by agent-review" || echo "Nothing to commit"

  git push || echo "Failed to push, push manually later"
else
  echo "⚠️  No metrics dashboard to commit"
fi
```

Only commit metrics when the user asked for a committed dashboard — if the working tree has
unrelated staged changes, report the dashboard path and skip the commit instead.

### Interactive Menu

Ask the user:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ REVIEW COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Found:
• [N] CRITICAL BLOCKERS (severity 9-10)
• [N] HIGH PRIORITY BLOCKERS (severity 8-9)
• [N] IMPORTANT issues (severity 7-8)
• [N] MEDIUM priority (severity 5-7)
• [N] Suggestions (severity 3-5)
• [N] Unresolved debates (needs senior review)

⏱️ Review Time: [X] minutes
🔧 Suggested Fixes: [FIX_COUNT] available

Risk Level: [LOW/MEDIUM/HIGH/CRITICAL]
Required Reviewer: [risk.reviewer]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

What would you like to do?

1. 📊 View metrics dashboard
2. 📝 Post review to GitHub
3. 🔧 Review suggested fixes (dry run first!)
4. 📦 View dependency impact
5. 💾 Save report locally only
6. ❌ Exit

Please respond: 1, 2, 3, 4, 5, or 6
```

Handle the choice:

```bash
. /tmp/review_env.sh 2>/dev/null || true   # PR_NUM, PR_NUMBER, FIX_COUNT
case "$choice" in
  1) cat .claude/review/metrics/PR_${PR_NUM}_metrics.md ;;
  2)
    # Same create-or-update path as CI: the marker makes repeat posts update one comment instead
    # of stacking new ones, so an interactive re-post never duplicates the CI comment.
    if [ -z "${PR_NUMBER:-}" ]; then
      echo "⚠️  No PR number available — report left at /tmp/agent_review_report.md"
    else
      REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
      { echo '<!-- agent-review -->'
        [ -n "${HEAD_REF:-}" ] && echo "<!-- agent-review-head: $HEAD_REF -->"
        echo
        cat /tmp/agent_review_report.md
      } > /tmp/agent_review_comment.md
      EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
        --jq 'map(select(.body | contains("<!-- agent-review -->"))) | first | .id // empty' \
        2>/dev/null | head -n1)
      if [ -n "$EXISTING" ]; then
        gh api -X PATCH "repos/$REPO/issues/comments/$EXISTING" -F body=@/tmp/agent_review_comment.md \
          && echo "✅ Updated existing review comment ($EXISTING)"
      else
        gh pr comment "$PR_NUMBER" --body-file /tmp/agent_review_comment.md \
          && echo "✅ Review posted"
      fi
    fi
    ;;
  3)
    if [ "$FIX_COUNT" -gt 0 ]; then
      cat /tmp/fix_summary.txt
      # DRY RUN — prints every fix, applies nothing.
      bash /tmp/automated_fixes/apply_all.sh
      echo ""
      echo "These scripts are model-generated from PR content and UNTRUSTED."
      echo "After reading each one: bash /tmp/automated_fixes/apply_all.sh --yes"
      echo "Then: git diff   (undo with: git checkout .)"
    else
      echo "No suggested fixes available"
    fi
    ;;
  4) cat /tmp/review_impact.json ;;
  5)
    echo "Report saved to: /tmp/agent_review_report.md"
    echo "Metrics saved to: .claude/review/metrics/PR_${PR_NUM}_metrics.md"
    ;;
  *) echo "Exiting..." ;;
esac
```

Never run `apply_all.sh --yes` on the user's behalf without an explicit, informed "yes" — the fix
scripts are model-generated from PR content and are untrusted input.

---

## Stage 8 — Final Summary

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 CODE REVIEW COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Review Mode**: [AGENT_MODE][ (CI)]
**Agents Used**: [N] ([titles])
**Review Time**: [X] minutes

**Findings**:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 [N] Critical Blockers
🔴 [N] High Priority Issues
⚠️  [N] Important Issues
💡 [N] Suggestions
🤔 [N] Unresolved debates

**Suggested Fixes**:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 [FIX_COUNT] fixes generated (dry-run by default; review before applying)

**Dependency Impact**:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Blast radius: [N] files
⚠️  [N] high-impact changed files

**Artifacts**:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 /tmp/agent_review_report.md
📊 .claude/review/metrics/ (skipped in CI mode)
[CI] 💬 Posted to PR #[N]

**Next Steps**:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Address [N] critical/high priority issues
2. Review [FIX_COUNT] suggested fixes before applying any
3. Check [N] high-impact dependency changes
4. Mark finding outcomes and run `agent-review learn` to grow the learning layer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Notes

**Where behavior comes from**

- Risk globs, agent triggers, models, profile, exclusions, index and learning settings →
  the consuming repo's `.claude/review/config.yml` (edit with `agent-review config validate` to check).
- What each agent actually checks → the repo's `.claude/review/rules/*.md` prose docs.
- Prompt shape and report shape → this plugin's `templates/archetype.md` and `templates/report.md`.
- Everything computed (score, agent set, rule resolution, impact, learnings) → the `agent-review`
  binary. Never recompute those inline.

**Cross-stage state**

Every bash block runs in its own shell. `/tmp/review_env.sh` is the only carrier between stages:
Stage 0A truncates it and writes `MODE`/`AGENT_MODE`/`MODEL_OVERRIDE`, then `CI_MODE`; Stage 0 adds
`DAY_OF_WEEK`, `BASE_REF`, `RANGE`; Stage 2B adds `FIX_COUNT`; Stage 5B adds `PR_NUM`,
`CURRENT_DATE`, `CURRENT_SEVERITY`. Any block using a value it did not compute itself begins with
`. /tmp/review_env.sh 2>/dev/null || true`. If you add a stage, keep the discipline.

**Modes**

| Mode     | Agents                                          | Model                     | Use for                        |
| -------- | ----------------------------------------------- | ------------------------- | ------------------------------ |
| quick    | up to 3 (testing, standards, first triggered)    | Haiku                     | small, low-risk changes        |
| standard | engine selection from the diff                  | per-agent (`smart`→Sonnet) | normal feature work            |
| deep     | every enabled agent                             | Opus                      | high-risk or critical changes  |

**Security posture**

Agent-generated `fix_*.sh` scripts are derived from PR content, which an outside contributor can
influence. `apply_all.sh` dry-runs by default and applies nothing without an explicit `--yes` from a
human who has read the scripts. CI never executes them at all.
