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

**Rough cost** (varies with diff size): quick ~$0.50 · standard ~$2-4 · deep varies with
escalating-lane count.
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

The first argument selects the mode; the literal argument `ci` (in any position) selects CI mode.

- **quick** — 3 agents (testing, standards + the first triggered agent); model tiers per-agent (see plan)
- **deep** — every enabled agent in config.yml; model tiers per-agent (see plan)
- **auto** — depth resolved from the engine's risk score after Stage 0 planning: score 0 → skip ·
  LOW → quick · MEDIUM/HIGH → standard · CRITICAL → deep
- **standard** (default, recommended) — agents selected by the review engine from the diff; model
  per-agent from config.yml

CI mode is on when the `ci` argument was passed, or `$AGENT_REVIEW_CI` is set to anything
non-empty. If so, follow **[CI Mode](#ci-mode)** below — it changes what several stages do.

⚠️ **CROSS-STAGE STATE** — read this once, it applies to every bash block below. Each block you
run is a SEPARATE shell: shell variables do NOT survive from one block to the next. Anything a
later stage needs is persisted to `/tmp/review_env.sh` at the moment it is computed, and every
later block starts by sourcing that file. Keep this discipline or later stages will silently
operate on empty strings.

### Initialize

Mode parsing, CI detection, config validation, and working directories are read-only setup with no
required decision in between — one shell handles all of it, so a bwrap bind-race rerun replays it
as a single unit:

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e

# --- Determine Review Mode ---
MODE="${1:-standard}"
case "$MODE" in quick|deep|auto) ;; *) MODE="standard" ;; esac   # `ci` alone → standard mode

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
case "$MODE" in
  quick)
    echo "🏃 QUICK REVIEW MODE"
    echo "• 3 agents (testing, standards + the first triggered agent)"
    echo "• Model tiers: per-agent (see plan)"
    AGENT_MODE="quick"
    ;;
  deep)
    echo "🔬 DEEP REVIEW MODE"
    echo "• Every enabled agent in config.yml"
    echo "• Model tiers: per-agent (see plan)"
    AGENT_MODE="deep"
    ;;
  auto)
    echo "🎚️ AUTO REVIEW MODE"
    echo "• Depth resolved from the engine's risk score after Stage 0 planning"
    echo "• score 0 → skip · LOW → quick · MEDIUM/HIGH → standard · CRITICAL → deep"
    AGENT_MODE="auto"   # placeholder — resolved right after the plan is computed
    ;;
  standard)
    echo "⚡ STANDARD REVIEW MODE (Recommended)"
    echo "• Agents selected by the review engine from the diff"
    echo "• Model: per-agent, from config.yml"
    AGENT_MODE="standard"
    ;;
esac
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

: > /tmp/review_env.sh    # fresh state for this review
# Cross-run state from a prior review on this same machine/runner must never leak into this
# one: a stale consensus_decisions.json silently merges unrelated findings (or throws an
# unknown-index error against this run's smaller candidates array), and a stale per-lane
# findings file can coincidentally pass Stage 2's N cross-check even though no agent wrote it
# this run.
rm -f /tmp/consensus_decisions.json /tmp/consensus_raw.json /tmp/consensus_findings.json
rm -f /tmp/agent_findings/*.json 2>/dev/null || true
# A stale per-agent slice or launched-lane plan from a prior review would otherwise let this
# run's Stage 1 launch a lane against last run's diff, or let consensus silently accept a
# launched-subset plan this run never wrote.
rm -f /tmp/slice_manifest.json /tmp/review_plan_launched.json /tmp/launched_lanes.json /tmp/skipped_lanes.txt
rm -rf /tmp/agent_slices 2>/dev/null || true
REVIEW_DIR="${AGENT_REVIEW_DIR:-.claude/review}"
cat >> /tmp/review_env.sh <<EOF
export MODE="$MODE" AGENT_MODE="$AGENT_MODE" REVIEW_DIR="$REVIEW_DIR"
EOF

# --- Detect CI Mode ---
CI_MODE=""
case " $* " in *" ci "*) CI_MODE="true" ;; esac
[ -n "${AGENT_REVIEW_CI:-}" ] && CI_MODE="true"
[ -n "$CI_MODE" ] && echo "🤖 CI MODE — non-interactive, no metrics, no fix execution"
echo "export CI_MODE=\"$CI_MODE\"" >> /tmp/review_env.sh

# --- Verify the repo is set up ---
agent-review config validate || {
  echo "❌ No valid review config at ${AGENT_REVIEW_DIR:-.claude/review}/config.yml. Run /agent-review:init first."
  exit 1
}

# --- Initialize Directories ---
mkdir -p /tmp/automated_fixes
# On a cold runner this dir does not exist yet — without it every lane's findings-file write
# throws ENOENT, the unchanged-prompt retry reproduces the same error, and the review posts
# nothing.
mkdir -p /tmp/agent_findings
mkdir -p /tmp/agent_slices
# Metrics live in the consuming repo's review dir; skipped entirely in CI mode.
[ -z "${CI_MODE:-}" ] && mkdir -p "$REVIEW_DIR/metrics/history"

# --- Enabled agents (used by deep mode; plan agents[] drives quick/standard) ---
agent-review config get agents > /tmp/config_agents.json || true
```

### Gather PR Context & Diff Manifest

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e

# --- Gather PR Context ---
# Resolve the PR number ONCE, here, and persist it — every later `gh pr view`/`gh pr comment`
# depends on it. CI checks out a PR as a DETACHED HEAD, so a bare `gh pr view` has no branch to
# resolve and returns nothing; the workflow therefore exports $PR_NUMBER, which wins. Locally
# (on a PR branch) the fallback resolves it from the branch instead.
PR_NUMBER="${PR_NUMBER:-$(gh pr view --json number -q .number 2>/dev/null || true)}"
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

# --- Build the diff manifest the whole review runs on ---
BASE_REF="${BASE_REF:-$(gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json baseRefOid -q .baseRefOid 2>/dev/null || true)}"
HEAD_REF="${HEAD_REF:-$(gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json headRefOid -q .headRefOid 2>/dev/null || true)}"

# Incremental re-review (CI only): a previous CI run recorded the head SHA it reviewed
# inside the posted report comment (`<!-- agent-review-head: <sha> -->`). When that SHA is
# still an ancestor of the current head, review only the commits since it. A force-push
# breaks ancestry, so the recorded SHA fails the checks below and we fall back to a full
# review — the history we reviewed no longer exists, so the delta cannot be trusted.
INCREMENTAL="" LAST_REVIEWED=""
if [ -n "$CI_MODE" ] && [ -n "$PR_NUMBER" ] && [ -n "$HEAD_REF" ]; then
  if [ -s "${AGENT_REVIEW_PREVIOUS_COMMENT:-}" ]; then
    LAST_REVIEWED=$(tr -d '\r' < "$AGENT_REVIEW_PREVIOUS_COMMENT" \
      | sed -n 's/^<!-- agent-review-head: \([0-9a-f]\{7,40\}\) -->$/\1/p' | head -1)
  else
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    LAST_REVIEWED=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
      --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' 2>/dev/null \
      | tr -d '\r' | sed -n 's/^<!-- agent-review-head: \([0-9a-f]\{7,40\}\) -->$/\1/p' | head -1)
  fi
  if [ -n "$LAST_REVIEWED" ] \
     && git cat-file -e "$LAST_REVIEWED^{commit}" 2>/dev/null \
     && git merge-base --is-ancestor "$LAST_REVIEWED" "$HEAD_REF" 2>/dev/null; then
    if [ "$(git rev-parse "$LAST_REVIEWED")" = "$(git rev-parse "$HEAD_REF")" ]; then
      if [ -s "${AGENT_REVIEW_PREVIOUS_COMMENT:-}" ] && [ -n "${AGENT_REVIEW_COMMENT_OUT:-}" ]; then
        cp "$AGENT_REVIEW_PREVIOUS_COMMENT" "$AGENT_REVIEW_COMMENT_OUT" || true
      fi
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
  BASE_BRANCH=$(agent-review config get base_branch 2>/dev/null || true)
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

# Review effort may be incremental, but approval metadata must always describe
# the entire current PR. Otherwise a small follow-up commit can erase an earlier
# destructive migration or downgrade the PR-wide required-reviewer level.
if [ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ]; then
  FULL_RANGE="$BASE_REF..$HEAD_REF"
else
  FULL_RANGE="$MERGE_BASE..HEAD"
fi

echo "Diff range: $RANGE"
echo "Full PR range: $FULL_RANGE"
git diff "$RANGE" --name-only > /tmp/changed_files.txt
git diff "$RANGE" --stat      > /tmp/diff_stat.txt
git diff "$RANGE"             > /tmp/pr_diff.txt
if [ "$FULL_RANGE" = "$RANGE" ]; then
  cp /tmp/changed_files.txt /tmp/full_changed_files.txt
  cp /tmp/diff_stat.txt /tmp/full_diff_stat.txt
  cp /tmp/pr_diff.txt /tmp/pr_full_diff.txt
else
  git diff "$FULL_RANGE" --name-only > /tmp/full_changed_files.txt
  git diff "$FULL_RANGE" --stat      > /tmp/full_diff_stat.txt
  git diff "$FULL_RANGE"             > /tmp/pr_full_diff.txt
fi

if [ ! -s /tmp/changed_files.txt ]; then
  if [ -n "$INCREMENTAL" ]; then
    if [ -s "${AGENT_REVIEW_PREVIOUS_COMMENT:-}" ] && [ -n "${AGENT_REVIEW_COMMENT_OUT:-}" ]; then
      # The commits cancel out to the already-reviewed tree. Advance only the
      # reviewed-head marker; all findings and safety state remain valid.
      sed -e "s/^<!-- agent-review-head: [0-9a-f]\{7,40\} -->$/<!-- agent-review-head: $HEAD_REF -->/" \
        -e "s/^<!-- agent-review-rollout: [a-z]* -->$/<!-- agent-review-rollout: ${AGENT_REVIEW_ROLLOUT_MODE:-advisory} -->/" \
        -e "/^<!-- agent-review-status:/ s/\"head\":\"[0-9a-f]\{7,40\}\"/\"head\":\"$HEAD_REF\"/" \
        "$AGENT_REVIEW_PREVIOUS_COMMENT" > "$AGENT_REVIEW_COMMENT_OUT" || true
    fi
    echo "✅ No net changes since the last reviewed head — nothing to review. Exiting."
    exit 0
  fi
  echo "❌ No changed files in $RANGE — nothing to review. Check the base ref."
  exit 1
fi
wc -l < /tmp/changed_files.txt

cat >> /tmp/review_env.sh <<EOF
export BASE_REF="$BASE_REF" HEAD_REF="$HEAD_REF" RANGE="$RANGE" FULL_RANGE="$FULL_RANGE"
export INCREMENTAL="$INCREMENTAL" LAST_REVIEWED="$LAST_REVIEWED"
EOF
```

**Checkpoint — set REVIEW_SCOPE (not a bash turn; a decision).** Read the changed-file list and
diff stat from the previous block's output (`/tmp/changed_files.txt`, `/tmp/diff_stat.txt`) and
set REVIEW_SCOPE (`single_feature` | `multi_feature` | `cross_cutting` | `core_infra`) **before**
running the next block; it defaults to `single_feature` only when the footprint genuinely is one
— use `multi_feature`, `cross_cutting`, or `core_infra` for changes spanning unrelated feature
areas or core infrastructure. Carry your decision into the next block by setting
`REVIEW_SCOPE="<value>"` right after that block's `set -e` line, overriding the shown default.

### Build the Review Plan & Load Evidence

Risk scoring, agent selection, special-pattern detection, and rule resolution are driven by the
declarative review core (`.claude/review/config.yml`) — never computed inline here:

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e
REVIEW_SCOPE="${REVIEW_SCOPE:-single_feature}"   # ← set at the checkpoint above

# --- Build the Review Plan ---
agent-review plan \
  --files /tmp/changed_files.txt \
  --stat /tmp/diff_stat.txt \
  --diff /tmp/pr_diff.txt \
  --scope "$REVIEW_SCOPE" \
  --mode "$MODE" \
  > /tmp/review_plan.json
cat /tmp/review_plan.json

# --- Slice the diff per lane ---
# `always`/`escalates`/`architecture` lanes get the whole diff (mode "full"); every other lane
# gets only the hunks its triggers matched (mode "sliced", possibly with hunks: 0 for a
# header-only binary/mode/rename section — that lane still launches). A lane with no matching
# hunks at all gets mode "empty" — Stage 1 does not launch it (see Stage 0B/Stage 1 below).
agent-review slice --plan /tmp/review_plan.json --diff /tmp/pr_diff.txt \
  --out-dir /tmp/agent_slices > /tmp/slice_manifest.json
cat /tmp/slice_manifest.json

# A second plan covers the full PR and is the source of truth for governance:
# displayed risk, required reviewer, and the machine-readable approval status.
if [ "$FULL_RANGE" = "$RANGE" ]; then
  cp /tmp/review_plan.json /tmp/review_gate_plan.json
else
  agent-review plan \
    --files /tmp/full_changed_files.txt \
    --stat /tmp/full_diff_stat.txt \
    --diff /tmp/pr_full_diff.txt \
    --scope "$REVIEW_SCOPE" \
    --mode "$MODE" \
    > /tmp/review_gate_plan.json
fi
cat /tmp/review_gate_plan.json

# --- Load deterministic evidence and cross-repository context ---
# The reusable workflow creates these artifacts outside the model. Treat them as immutable inputs.
if [ -s "${AGENT_REVIEW_EVIDENCE:-}" ]; then
  cp "$AGENT_REVIEW_EVIDENCE" /tmp/review_evidence.json
else
  echo '{"version":1,"staticFindings":[],"ci":null}' > /tmp/review_evidence.json
fi
if [ -s "${AGENT_REVIEW_CONTEXT_INVENTORY:-}" ]; then
  cp "$AGENT_REVIEW_CONTEXT_INVENTORY" /tmp/review_context.json
else
  echo '{"version":1,"repositories":[]}' > /tmp/review_context.json
fi
node - <<'NODE' || true
const evidence = require('/tmp/review_evidence.json');
const context = require('/tmp/review_context.json');
const ci = evidence.ci && evidence.ci.summary;
console.log(`Deterministic AST findings: ${(evidence.staticFindings || []).length}`);
console.log(ci ? `CI snapshot: ${ci.success} passed, ${ci.failed} failed, ${ci.pending} pending` : 'CI snapshot: unavailable');
for (const repo of context.repositories || []) {
  console.log(`Context ${repo.id}: ${repo.available ? `${repo.files.length} allowlisted files at ${repo.ref}` : 'unavailable'}`);
}
NODE
```

Paths listed under `excluded_paths` in config (`agent-review config get excluded_paths`) are
excluded from risk scoring and agent selection by the engine — agents should not raise findings
against them either.

The plan JSON has this shape:

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
  "mode": { "requested": "auto", "resolved": "quick" },
  "agents": [
    {
      "id": "standards",
      "model": "smart",
      "escalates": false,
      "tier": "sonnet",
      "matchedBy": "always",
      "rules": ["rules/standards.md"]
    }
  ]
}
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
| Fix scripts                  | **Never written or executed in CI.** Suggestions appear only as ≤10-line diffs in the report's 🔧 Fix suggestions section |
| Ending                       | Post the report to the PR (below) instead of the interactive menu      |

When debate is skipped, omit the **Debate summary** block from `Review detail & stats` entirely,
per the skeleton's own instruction — that block is the only place debate output ever appears.

Two CI-sandbox behaviors to expect (both harmless if handled):

- A Bash call may fail with `bwrap: Can't find source path ... No such file or directory`
  naming a transient file (usually a git lockfile). That is a sandbox bind race, not a real
  error — rerun the same command; it succeeds on retry.
- **The run has succeeded ONLY when `$AGENT_REVIEW_COMMENT_OUT` exists and is non-empty.** As
  your final action, verify it: `wc -c "$AGENT_REVIEW_COMMENT_OUT"` and confirm the head,
  rollout, ledger, and status markers are present. If that file is missing when you end your
  turn, the workflow fails and the whole review is discarded — whatever else you accomplished.

### Post the report to the PR (create-or-update)

Always embed the `<!-- agent-review -->` marker so subsequent runs update the same comment
instead of stacking new ones.
The marker lines are emitted ONLY by the node commands below — never type or edit them by hand; hand-transcribed JSON mangles escapes.

```bash
. /tmp/review_env.sh 2>/dev/null || true
PR_NUMBER="${PR_NUMBER:-$(gh pr view --json number -q .number 2>/dev/null)}"
if [ -z "$PR_NUMBER" ]; then
  echo "⚠️  No PR number available — report left at /tmp/agent_review_report.md"
else
  # Line 2 records the head SHA this report covers — the next CI run reads it back to review
  # only the commits since (see the incremental block in Stage 0). Line 3 carries the findings
  # ledger's machine state, which /agent-review:address and the dismiss fast path mutate.
  { echo '<!-- agent-review -->'
    [ -n "${HEAD_REF:-}" ] && echo "<!-- agent-review-head: $HEAD_REF -->"
    echo "<!-- agent-review-rollout: ${AGENT_REVIEW_ROLLOUT_MODE:-advisory} -->"
    [ -s /tmp/agent_review_ledger.json ] \
      && echo "<!-- agent-review-ledger: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_ledger.json","utf8"))))') -->"
    [ -s /tmp/agent_review_status.json ] \
      && echo "<!-- agent-review-status: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_status.json","utf8"))))') -->"
    echo
    cat /tmp/agent_review_report.md
  } > /tmp/agent_review_comment.md

  # SELF-CHECK — catches hand-transcribed marker lines (mangled escapes) before they ever reach
  # the trusted post-job. Reads the just-assembled file itself (not $AGENT_REVIEW_COMMENT_OUT,
  # which may still hold a stale file from a prior run at this point). The marker lines above
  # MUST come only from the node commands; never hand-write or hand-edit them.
  node -e '
const fs = require("fs");
const c = fs.readFileSync("/tmp/agent_review_comment.md", "utf8").replace(/\r/g, "");
for (const name of ["ledger", "status"]) {
  const m = c.match(new RegExp("^<!-- agent-review-" + name + ": (.*) -->$", "m"));
  if (m) JSON.parse(m[1]);
}
console.log("marker self-check OK");
' || { echo "❌ marker JSON invalid — REGENERATE the comment using ONLY the node commands above (never hand-write marker lines), then re-run this block"; exit 1; }

  # In the reusable workflow, the model never receives a GitHub token. It only
  # stages a comment; a deterministic post-step validates the reviewed head and
  # performs the write. Local CI-like runs retain the direct gh fallback.
  if [ -n "${AGENT_REVIEW_COMMENT_OUT:-}" ]; then
    if [ "$AGENT_REVIEW_COMMENT_OUT" != /tmp/agent_review_comment.md ]; then
      cp /tmp/agent_review_comment.md "$AGENT_REVIEW_COMMENT_OUT"
    fi
    echo "✅ Staged review comment for trusted workflow publication"
  else
    REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
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
fi
```

---

## Stage 0 — Context Gathering & Risk Assessment

### Read Project Standards

Read the repo's `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` (whichever exist) to understand the
project's conventions. That context is shared with all agents via the archetype prompt, which
instructs each agent to read them too.

Every `staticFindings[]` entry is a trusted, changed-line-anchored finding and MUST be copied into
`/tmp/consensus_findings.json` unchanged before Stage 6 emission. Agents may add corroborating
context but may not suppress, downgrade, or duplicate it. CI failures are evidence to investigate,
not automatic code-review blockers: distinguish a failure caused by this diff from a pending,
flaky, or unrelated check. The workflow verifies the final ledger contains every deterministic
static signature and rejects publication otherwise.

`/tmp/review_context.json` contains only a bounded inventory. Repositories marked `available` are
under `$AGENT_REVIEW_CONTEXT_DIR/<id>/`. Read only inventory-listed files relevant to the changed
API/schema/contract. Cite the repository id, pinned SHA, and file when cross-repo evidence changes
a finding. Never search outside those roots.

### Auto Mode Resolution

**Only when `MODE` is `auto`.** The placeholder mode is resolved here, from the engine's risk
score — never from your own judgment of the diff:

```bash
. /tmp/review_env.sh 2>/dev/null || true
if [ "$MODE" = "auto" ]; then
  LEVEL=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.risk.level)' 2>/dev/null)
  RESOLVED=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.mode.resolved)' 2>/dev/null)
  RESOLVED="${RESOLVED:-standard}"
  STATIC_FINDINGS=$(node -e 'const e=require("/tmp/review_evidence.json"); console.log((e.staticFindings||[]).length)' 2>/dev/null || echo 0)
  if [ "$RESOLVED" = "skip" ] && [ "${STATIC_FINDINGS:-0}" = "0" ]; then
    # Nothing risk-scored in the diff (excluded or 0-point paths only, small volume).
    if [ -n "$CI_MODE" ]; then
      # A zero-risk incremental delta must not erase earlier open findings or
      # irreversible state when the canonical comment is updated.
      echo '{"kept":[],"suppressed":[]}' > /tmp/review_filtered.json
      echo '[]' > /tmp/previous_agent_review_ledger.json
      echo '{"irreversible":false,"reasons":[]}' > /tmp/agent_review_safety.json
      if [ -s "${AGENT_REVIEW_PREVIOUS_COMMENT:-}" ]; then
        tr -d '\r' < "$AGENT_REVIEW_PREVIOUS_COMMENT" \
          | sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' | head -1 \
          > /tmp/previous_agent_review_ledger.json
        [ -s /tmp/previous_agent_review_ledger.json ] \
          || echo '[]' > /tmp/previous_agent_review_ledger.json
        tr -d '\r' < "$AGENT_REVIEW_PREVIOUS_COMMENT" \
          | sed -n 's/^<!-- agent-review-status: \(.*\) -->$/\1/p' | head -1 \
          > /tmp/previous_agent_review_status.json
        if [ -s /tmp/previous_agent_review_status.json ]; then
          node -e 'const s=require("/tmp/previous_agent_review_status.json"); process.stdout.write(JSON.stringify({irreversible:!!s.irreversible,reasons:s.irreversibleReasons||[]}))' \
            > /tmp/agent_review_safety.json
        fi
      fi
      agent-review ledger --findings /tmp/review_filtered.json \
        --previous /tmp/previous_agent_review_ledger.json > /tmp/agent_review_ledger.json
      # Status is always COMPUTED, never hand-authored — a zero-risk delta carries forward
      # whatever the ledger already holds, so an incremental skip with prior open blockers must
      # still report pass:false. Only a truly clean carried-forward ledger yields pass:true.
      agent-review status --ledger /tmp/agent_review_ledger.json \
        --plan /tmp/review_gate_plan.json --safety /tmp/agent_review_safety.json \
        --evidence /tmp/review_evidence.json \
        ${HEAD_REF:+--head "$HEAD_REF"} > /tmp/agent_review_status.json
      # Post a minimal skip note. The CI posting step prepends the comment markers
      # (including the reviewed-head marker, so the next run still diffs incrementally). A
      # carried-forward open blocker from a prior run still blocks, so surface it here rather
      # than letting a zero-risk delta read as silently clean.
      OPEN_BLOCKERS=$(node -e 'const l=require("/tmp/agent_review_ledger.json"); console.log(l.filter((e) => e.status === "open" && e.severity >= 7).length)' 2>/dev/null || echo 0)
      { echo "🎚️ **agent-review: skipped** — risk score 0 (no reviewable risk in this diff)."
        [ "${OPEN_BLOCKERS:-0}" -gt 0 ] 2>/dev/null \
          && echo "⚠️ $OPEN_BLOCKERS previously-found blocker(s) remain open — see the ledger below."
      } > /tmp/agent_review_report.md
      echo "AUTO MODE: skip (score 0) — post /tmp/agent_review_report.md via the CI posting step, then exit."
    else
      echo "AUTO MODE: risk score 0 — nothing worth a review pass. Run 'quick' explicitly to force one."
    fi
  else
    [ "$RESOLVED" = "skip" ] && RESOLVED="standard"   # static findings exist — deterministic evidence outranks a 0-risk skip
    echo "🎚️ AUTO MODE resolved: $LEVEL risk → $RESOLVED"
  fi
  MODE="$RESOLVED" AGENT_MODE="$RESOLVED"
  cat >> /tmp/review_env.sh <<EOF
export MODE="$MODE" AGENT_MODE="$AGENT_MODE"
EOF
fi
```

If auto resolved to `skip`: in CI, run the **[CI Mode posting step](#post-the-report-to-the-pr-create-or-update)**
with the skip note as the report, then go straight to Stage 8 cleanup — launch no agents. Locally,
report the skip and stop. If it resolved to `quick`/`standard`/`deep`, continue exactly as if that
mode had been passed on the command line.

### Risk Assessment

Read `risk.score`, `risk.level`, `risk.reviewer`, and `risk.special` from
`/tmp/review_gate_plan.json`
(do NOT compute the score inline — the engine is the single source of truth). The classification
comes from `risk.levels` in config; the shipped default is:

- 0-3 points: **LOW** → entry-level+ can review
- 4-6 points: **MEDIUM** → entry-level+ can review
- 7-9 points: **HIGH** → experienced dev+ should review
- 10+ points: **CRITICAL** → senior maintainer must review

`risk.special[]` lists any special patterns that fired (e.g. `new_dependency`,
`critical_pkg_update`, `lockfile_only_change`, `migration_change`, `config_security_change`) —
surface these as risk factors. Also surface `risk.factors.unmatchedFiles`: these are reviewable
paths the repository's risk map does not know yet, so they received the conservative
`unmatchedFilePoints` floor and should prompt a config follow-up.

Display the summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Risk Score: [risk.score]            ← from /tmp/review_gate_plan.json (full PR)
Risk Level: [risk.level]            ← LOW | MEDIUM | HIGH | CRITICAL
Day: [DAY_OF_WEEK]

Files Changed: [N]
Lines Changed: +[X] -[Y]

Risk Factors Detected:
• [risk.special[] entries, unmatchedFiles, plus notable risk.factors highlights]

Required Reviewer: [risk.reviewer]  ← from /tmp/review_gate_plan.json

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
- `tier` — the engine-resolved `opus`/`sonnet`/`haiku` subagent tier (see Stage 1's launch table)
- `matchedBy` — why it was selected (`always`, `path:<glob>`, `content:<substring>`, or
  `unmatched-coverage` — the engine force-includes an escalating lane when the diff touches a
  reviewable file none of the risk map's globs recognize and no otherwise-selected lane escalates)
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
  this repo's config, just take the first three plan entries. **Exception:** any plan entry whose
  `matchedBy` is `unmatched-coverage` is ALWAYS retained in quick's launch list, occupying one of
  the three slots (bumping the "first triggered agent" pick if needed) — quick mode must never
  narrow away the one lane the coverage guarantee force-included for an otherwise-unmatched file.

`/tmp/config_agents.json` (used by deep mode; plan `agents[]` drives quick/standard) was already
fetched in Stage 0A's setup block, alongside config validation.

Announce the selection, including each agent's `matchedBy` reason, e.g.:

```
🤖 Agents selected:
✅ standards      — always
✅ security       — path:src/app/api/**
✅ data-integrity — content:createClient
```

### Smoke-Test Tier Routing

The launch table (Stage 1) selects a subagent type per agent's tier (`agent-review:reviewer-opus`
/ `-sonnet` / `-haiku`). Confirm those plugin subagent types actually resolve in this environment
before committing every later launch to them — a stale or partially-installed plugin might not
expose them yet. Run this only once a review is actually about to launch agents (the resolved
mode reached this point instead of exiting at a Stage 0 skip) — that keeps a score-0 auto skip at
$0. Launch exactly one Task:

- **description**: `"routing smoke test"`
- **subagent_type**: `"agent-review:reviewer-haiku"`
- **prompt**: `"Reply with exactly: OK"`

If the Task tool errors (unknown subagent type) or the reply is not exactly `OK`, degrade
rather than fail the review — set `ROUTING="degraded"` below; every later launch table then falls
back to `subagent_type: "general-purpose"` for every agent, and Stage 6 notes the degradation in
`Review detail & stats`. On success, leave `ROUTING` unset.

```bash
. /tmp/review_env.sh 2>/dev/null || true
ROUTING=""   # ← change to "degraded" if the smoke-test Task above errored
cat >> /tmp/review_env.sh <<EOF
export ROUTING="$ROUTING"
EOF
```

---

## Stage 1 — Launch Specialized Review Agents (Parallel)

Launch the selected agents in parallel with the Task tool.

**IMPORTANT:** Use a SINGLE message with multiple Task tool invocations so they run in parallel.

**CRITICAL (applies doubly in CI): never end your turn while launched agents are still running.**
Agents may run in the background and notify you later — but a non-interactive run has no later:
the session terminates the moment you end your turn, the pending agents are killed, and the
review is abandoned with no report (the workflow then fails). If agent results have not arrived
in your context yet, retrieve them with TaskOutput — polling repeatedly is fine — and only
proceed once every launched agent's report is in hand. Saying "I'll continue when the reports
land" and stopping IS the failure mode; do not do it.

Display: "🚀 Launching [N] specialized review agents in parallel..."

### Approved learnings & dependency impact

Before assembling prompts, fetch approved `rule` learnings (gated on the learning layer) and
compute dependency impact (Stage 1B, gated on the index being enabled in config) — both are
read-only lookups nothing else here depends on, so one shell handles both:

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e

# --- Approved learnings (learning layer) ---
if [ "$(agent-review config get learning.enabled 2>/dev/null)" = "true" ]; then
  agent-review rules > /tmp/review_rules.json 2>/dev/null || echo "[]" > /tmp/review_rules.json
else
  echo "[]" > /tmp/review_rules.json
fi

# --- Dependency impact analysis (Stage 1B) ---
echo "🔍 Analyzing dependency impact (index engine)..."
if [ "$(agent-review config get index.enabled 2>/dev/null)" = "true" ]; then
  if [ -n "${BASE_REF:-}" ]; then
    agent-review impact --base "$BASE_REF" > /tmp/review_impact.json || true
  else
    agent-review impact > /tmp/review_impact.json || true
  fi
  cat /tmp/review_impact.json
else
  echo "ℹ️  Index disabled in config.yml — skipping impact analysis."
fi
echo "✅ Dependency analysis complete"
```

Each learnings entry is `{ paths, ruleText, agent }` — a repository-specific rule ratified by a
human from prior review feedback.

### Assemble each agent prompt from the archetype template

There are no per-agent prompts in this skill. Every agent gets the SAME prompt skeleton — the
plugin's `templates/archetype.md` (see the path note at the top of this file) — with eleven
placeholders filled in. Read the template once, then for EACH entry in the launch list produce one
filled copy:

| Placeholder             | Fill with                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{TITLE}}`             | The agent's `title`. Fallback when absent: the `id` with `-`/`_` turned into spaces and each word capitalized, plus `" Review Agent"` (e.g. `data-integrity` → `Data Integrity Review Agent`).                                                          |
| `{{EXPERTISE}}`         | The agent's `expertise` string. Fallback when absent: derive the lane instead of leaving it blank — fill `<agent title>, judged against: <comma-joined basenames of its rules[] docs>` (e.g. "Architecture Review Agent, judged against: architecture.md"). Never leave the line's value blank; a blank lane means everything looks out-of-scope and the agent silently returns zero findings.       |
| `{{RISK_CONTEXT}}`      | A bullet block from the current review plan: `- Review-delta risk: <score> (<level>)`, `- Full-PR gate risk: <gate score> (<gate level>)`, `- Special patterns: <gate risk.special joined, or "none">`, `- Unmatched risk paths: <gate risk.factors.unmatchedFiles joined, or "none">`, `- Changed Files in this pass: <N>`, `- Lines Changed in this pass: +<X> -<Y>`, `- Selected because: <matchedBy>`, `- Model tier: <tier>` (this lane's resolved `opus`/`sonnet`/`haiku` tier — the archetype's full-file read budget reads this to know when it's doubled). |
| `{{PROFILE_INSTRUCTION}}` | From the plan's `profile`: `chill` → "Report only high-confidence, severity ≥ 7 findings; suppress nits." · `standard` → "Report findings at all severities per the output format above." · `assertive` → "Report all findings including low-severity suggestions." |
| `{{RULES}}`             | The full contents of every doc in the agent's `rules[]`, resolved against `$REVIEW_DIR` (`rules/security.md` → `$REVIEW_DIR/rules/security.md`), each preceded by a `----- <path> -----` line. In CI, `$AGENT_REVIEW_DIR` points to the immutable base-branch copy; never read rule docs from the PR checkout. If a listed doc is missing, note it in your output and continue with the rest. |
| `{{LEARNINGS}}`         | Entries from `/tmp/review_rules.json` whose `agent` matches this agent's `id`, rendered as `APPROVED LEARNINGS (ratified from prior reviews — apply to files under <paths>):` followed by one bullet per `ruleText`. Empty string when there are none. |
| `{{IMPACT}}`            | For the `architecture` and `data-integrity` agents only, and only when `/tmp/review_impact.json` exists: the **actual dependents, inlined** (see the block below). Empty string for every other agent, and when impact was not computed. |
| `{{EVIDENCE}}`          | A compact rendering of `/tmp/review_evidence.json`: every static finding as `ruleId severity file:line message`, then every failed or pending CI check with its URL and at most five annotations. Say `none` when empty. Do not paste unbounded check output. |
| `{{CONTEXT}}`           | A compact rendering of `/tmp/review_context.json`: each repository id, pinned SHA, description, root, and its inventory-listed paths. Say `none` when no repositories are available. Never list or inspect files outside the inventory. |
| `{{AGENT_ID}}`          | The agent's `id` from the review plan. Stage 2 reads this lane's findings back from `/tmp/agent_findings/<id>.json`, and every finding the agent writes must carry this same id in its `agent` field. |
| `{{DIFF_PATH}}`         | Read `/tmp/slice_manifest.json` (written right after the plan — see above) for this agent's `<id>` entry. `mode: "full"` → `/tmp/pr_diff.txt` (the whole diff — the lane is `always`/`escalates`/`architecture`). `mode: "sliced"` → `/tmp/agent_slices/<id>.diff` (may have `hunks: 0` for a header-only binary/mode/rename section — still fill it, the lane still launches). `mode: "empty"` → do not launch this lane at all (see below); there is no `{{DIFF_PATH}}` to fill. **No manifest entry at all** (deep mode's config-only lanes — agents with no plan entry, so `agent-review slice` never sliced them) → treat it as a full-diff lane: fill `/tmp/pr_diff.txt`. |

**`{{IMPACT}}` content** — the template splices this in immediately after instruction 5, so it must
begin with its own step number and read as a standalone step. Build it from
`/tmp/review_impact.json` (Stage 1B), listing real file names rather than pointing at the JSON:

```
7. BLAST RADIUS — this change has <blastRadius> transitive dependents. The changed files below
   are imported by these files; verify the change does not break them:
   - <changed file>: <its directDependents, comma-separated>
   - <changed file>: <its directDependents, comma-separated>
   Highest-impact changed files: <topImpacted entries as "file (N dependents)">
   [If `truncated` is true, add: "(dependent list truncated by the traversal cap.)"]
```

Truncate sensibly — at most ~15 dependent paths per changed file and ~15 changed files, with a
"…and N more" tail — so a wide blast radius cannot crowd out the rest of the prompt. Omit the
placeholder entirely (empty string) if `blastRadius` is 0.

**Skipping empty-slice lanes.** A lane whose `/tmp/slice_manifest.json` entry has
`mode is "empty"` has no changes matching its triggers anywhere in this diff — do NOT launch it;
there is nothing for it to review. Track its id — the launched-subset derivation below writes the
full skipped-lane list to `/tmp/skipped_lanes.txt` for Stage 6 to note in `Review detail & stats`
as `lane <id>: no matching changes` for every skipped lane. A `mode: "sliced"` lane with `hunks: 0`
(a header-only binary/mode/rename section) is NOT empty — it still launches, told only that the
file changed.

**Sliced lanes see only their slice.** A lane launched with `mode: "sliced"` cannot see the rest
of the diff, so append one line to its filled prompt, right after the INSTRUCTIONS block: "Other
changed files in this PR (not in your slice): <comma-joined contents of /tmp/changed_files.txt>.
Diff stat: <contents of /tmp/diff_stat.txt>" (spec R1 — the changed-file list plus the diff stat,
together, so a sliced lane can pull other hunks deliberately). Omit this line for `mode: "full"`
lanes — they already have the whole diff.

The launched-lane set (whatever remains after the empty-lane skip above — the plan's agents
minus quick's cap or plus deep's config-only additions, per Stage 0B, minus any empty-slice skip)
is exactly what Stage 2's cross-check and Stage 5's consensus `--plan` must use. It is derived
immediately below, right after every Task call is issued — not before, and not re-derived a
second way anywhere else.

Then launch each one with the Task tool:

- **description**: `"<title> review"`
- **subagent_type**: `"agent-review:reviewer-<tier>"` where `<tier>` is that agent's `tier` from
  the plan (`opus`/`sonnet`/`haiku` — already resolved by the engine from mode, risk, and
  config). Deep mode's config-only entries (agents with no plan entry, added per Stage 0B) carry
  no engine-resolved `tier`: derive one as `opus` when `escalates` is true and the gate risk level
  is HIGH or CRITICAL, else `sonnet`. If `$ROUTING` is `degraded` (the Stage 0B smoke test failed),
  use `"general-purpose"` for every agent instead.
- **prompt**: the filled archetype text

The rule docs are authoritative for what each agent checks; they carry all repo-specific focus
areas. Do not add repo-specific instructions here.

### Derive the launched-subset plan (immediately after every Task call above is issued)

This is the ONE place slice-empty skips, quick mode's 3-agent cap, and deep mode's config-only
expansion all converge: rather than re-deriving "who got launched" a second way (which drifted
from reality the first time — quick's cap and deep's config-only additions both happen AFTER any
earlier, plan-only derivation), record the exact ids you just launched — you already know this
list, you just built it to construct the Task calls above — and turn it straight into the plan
Stage 2's cross-check and Stage 5's consensus will consume.

Replace the `launchedIds` array below with the exact ids launched above (e.g.
`["testing","standards","security"]` for a quick-mode run — quick: <=3; standard: the plan agents
minus any empty-slice skip; deep: every enabled config agent minus any empty-slice skip), and
replace `skippedIds` with the ids you tracked above as empty-slice skips (`[]` if none — this is
the same list the "Skipping empty-slice lanes" note above uses for `Review detail & stats`), then
run:

```bash
. /tmp/review_env.sh 2>/dev/null || true
node -e '
const launchedIds = ["<fill with the exact ids launched above>"];
const skippedIds = ["<fill with the exact empty-slice-skipped ids, or leave empty>"];
const plan = require("/tmp/review_plan.json");
const gate = require("/tmp/review_gate_plan.json");
let cfgAgents = [];
try { cfgAgents = JSON.parse(require("fs").readFileSync("/tmp/config_agents.json", "utf8")); } catch {}
const byId = new Map(plan.agents.map((a) => [a.id, a]));
const cfgById = new Map((Array.isArray(cfgAgents) ? cfgAgents : []).map((a) => [a.id, a]));
const gateLevel = (gate.risk || {}).level;
const agents = launchedIds.map((id) => {
  if (byId.has(id)) return byId.get(id);
  // Deep mode config-only lane: no plan entry exists, so synthesize a minimal one — same
  // escalates value as config, same tier-fallback rule used to pick its subagent type above.
  const cfg = cfgById.get(id) || {};
  const escalates = cfg.escalates || false;
  const tier = escalates && (gateLevel === "HIGH" || gateLevel === "CRITICAL") ? "opus" : "sonnet";
  return { id, escalates, tier };
});
const fs = require("fs");
fs.writeFileSync("/tmp/launched_lanes.json", JSON.stringify(launchedIds));
// One id per line; an empty file (not a missing one) when nothing was skipped — Stage 6 reads
// this to fill Review detail & stats' "lanes with no matching changes" note.
fs.writeFileSync("/tmp/skipped_lanes.txt", skippedIds.length ? skippedIds.join("\n") + "\n" : "");
fs.writeFileSync("/tmp/review_plan_launched.json", JSON.stringify({ ...plan, agents }, null, 2));
'
cat /tmp/review_plan_launched.json
```

After launching, display:

```
✅ All [N] agents launched in parallel
⏳ Waiting for agents to complete their reviews...
💰 Estimated cost: $[X.XX]
```

---

## Stage 1B — Dependency Impact Analysis (Parallel)

Dependency impact is computed from the persisted import graph (not grep) — already done, in
**[Approved learnings & dependency impact](#approved-learnings--dependency-impact)** above, before
Stage 1's agents launch, since the `architecture`/`data-integrity` agents' `{{IMPACT}}` slot needs
the output.

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

Wait for all agents to complete and display progress, one line per launched agent — the same
launched-id list Stage 1 just recorded into `/tmp/launched_lanes.json`. Waiting means actively
collecting inside this same turn (TaskOutput per pending agent) — never ending the turn to "wait"
for notifications; in CI that kills the run.

Each agent's final Task message is exactly one line — `done — <N> findings, max severity <X>`
(the archetype's return contract) — never a pasted report. Do not trust `<N>` on its own; cross-
check it against the findings file the agent actually wrote:

- Read `/tmp/agent_findings/<agent id>.json`.
- The lane **fails its cross-check** when the file is missing, its contents fail `JSON.parse`
  (treat unparseable JSON exactly like a missing file — never partially trust a truncated write),
  or `findings.length` does not equal the reported `<N>`.
- On a failed cross-check: relaunch that lane once; a lane that fails twice fails the run —
  no report is posted. Use the lane's original Stage 1 prompt, unchanged, for the retry.
  Optionally append the lane's id to `/tmp/degraded_lanes.txt` (one id per line, create it if
  absent) if that helps you track which lane(s) failed — but nothing downstream may read that
  file into any status or report field; it is scratch state for you, not a report input.
  **A review with an incomplete lane must not produce a report at all** — an incomplete review
  is not a property of the diff, and folding it into `irreversible` or any other status field
  would post a false, un-clearable banner. If the retry fails the same cross-check again:
  - **CI mode:** do not write `$AGENT_REVIEW_COMMENT_OUT`, do not proceed to Stage 3 onward,
    print exactly this loud final line, and end your turn:
    `❌ review incomplete: lane <id> failed twice — no report posted (the workflow will fail closed)`.
    The publish step's existing empty-report check (see CI Mode above) then fails the run; the
    transcript carries the diagnosis.
  - **Local (non-CI) mode:** report the failed lane to the user the same way — the loud line
    above — and stop; do not continue to debate, consensus, or the report.

Display:

```
Agent Reviews Complete:
✅ [Agent title] - <N> findings, max severity <X>
✅ [Agent title] - <N> findings, max severity <X>
```

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

For each launched agent, launch a new Task pointing at their own findings file plus every other
launched agent's findings file — never pasted findings text.

### Debate Prompt Template

Debate reuses each agent's Stage-1 tier — a deliberate deviation from the in-repo review system
this skill was extracted from, which pinned every debate round to the largest model. A cheap agent
therefore stays cheap through debate and rebuttal.

Use the Task tool for each agent with:

- **description**: "[Agent title] cross-examination"
- **subagent_type**: `"agent-review:reviewer-<tier>"` where `<tier>` is that agent's `tier` from
  the plan (same resolution as Stage 1). If `$ROUTING` is `degraded`, use `"general-purpose"`
  instead, same as Stage 1.
- **prompt**:

```
You are the [Agent Title] in the cross-examination debate phase.

YOUR ORIGINAL FINDINGS:
Read /tmp/agent_findings/<this agent's id>.json.

OTHER AGENTS' FINDINGS:
Read every other launched agent's /tmp/agent_findings/<their id>.json — one path per lane, never
pasted inline.

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
- **subagent_type**: `"agent-review:reviewer-<tier>"` where `<tier>` is that agent's `tier` from
  the plan (same resolution as Stage 1). If `$ROUTING` is `degraded`, use `"general-purpose"`
  instead, same as Stage 1.
- **prompt**:

```
You are the [Agent Title] responding to challenges from debate round 1.

YOUR ORIGINAL FINDINGS:
Read /tmp/agent_findings/<this agent's id>.json.

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

Grouping, severity averaging, and corroboration counting are computed by the deterministic
engine — never in context. This stage's job is to run it, resolve any ambiguous near-miss pairs
it surfaces, and land a plain findings array at `/tmp/consensus_findings.json` for Stage 6.

```bash
. /tmp/review_env.sh 2>/dev/null || true
echo "📊 Synthesizing consensus..."
PROFILE=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.profile || "standard")')
agent-review consensus \
  --plan /tmp/review_plan_launched.json \
  --dir /tmp/agent_findings \
  --profile "$PROFILE" \
  > /tmp/consensus_raw.json
```

`agent-review consensus` is fail-closed: a missing findings file, or one that fails
`JSON.parse`, for any launched lane makes it exit non-zero naming that lane — surface that error
verbatim, never paper over it by fabricating findings or silently retrying. Every launched lane
should already have a valid findings file by this stage — a lane that failed its Stage 2
cross-check twice stopped the run before reaching here.

Read `/tmp/consensus_raw.json`. Its `candidates` array names pairs of output findings (by index)
that are close — same file, within 10 lines — but the clique rule deliberately left unmerged
rather than risk conflating two distinct findings. When `candidates` is non-empty, resolve every
pair with **one bounded model pass**: for each pair, read only the two named findings
(`findings[a]` and `findings[b]` in `/tmp/consensus_raw.json` — never the full per-agent output)
and decide whether they describe the same underlying issue. Never re-open findings outside the
named pairs. Write the decisions to `/tmp/consensus_decisions.json`:

```json
[
  { "merge": [3, 7] },
  { "keep": [1, 9] }
]
```

`merge` combines the pair into one entry per the engine's documented merge rules (severity =
rounded mean, line/message/fix = the higher-severity member's, evidence/recommendation =
whichever is longer); `keep` is a no-op kept for auditability. Skip writing
`/tmp/consensus_decisions.json` entirely when `candidates` was empty — the first invocation's
output is already final. Either way, this block re-runs the command when decisions exist and then
extracts the plain findings array Stage 6 expects:

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e
PROFILE=$(node -e 'const p = require("/tmp/review_plan.json"); console.log(p.profile || "standard")')
if [ -s /tmp/consensus_decisions.json ]; then
  agent-review consensus \
    --plan /tmp/review_plan_launched.json \
    --dir /tmp/agent_findings \
    --profile "$PROFILE" \
    --decisions /tmp/consensus_decisions.json \
    > /tmp/consensus_raw.json
fi
node -e 'const r = require("/tmp/consensus_raw.json"); process.stdout.write(JSON.stringify(r.findings, null, 2))' \
  > /tmp/consensus_findings.json
```

Display a summary from `/tmp/consensus_raw.json`'s `stats`:

```
📊 Consensus Analysis:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Raw findings: [stats.raw]   Groups: [stats.groups]   Singletons: [stats.singletons]
Dropped by profile: [stats.droppedByProfile]   Needs human review: [stats.needsHumanReview]
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

# Average consensus severity for this review — derive the mean `severity` across
# /tmp/consensus_findings.json's entries and substitute the real number.
CURRENT_SEVERITY="[X.X]"

cat >> /tmp/review_env.sh <<EOF
export PR_NUM="$PR_NUM" CURRENT_DATE="$CURRENT_DATE" CURRENT_SEVERITY="$CURRENT_SEVERITY"
EOF

if [ -f "$REVIEW_DIR/metrics/severity_history.txt" ]; then
  AVG_SEVERITY=$(awk '{sum+=$2; count++} END {printf "%.1f", sum/count}' \
    "$REVIEW_DIR/metrics/severity_history.txt" 2>/dev/null || echo "N/A")
  LAST_10=$(tail -10 "$REVIEW_DIR/metrics/severity_history.txt" | awk '{print $2}')
else
  AVG_SEVERITY="N/A"
  LAST_10=""
fi

cat > "$REVIEW_DIR/metrics/PR_${PR_NUM}_metrics.md" << EOF
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

echo "✅ Metrics dashboard created: $REVIEW_DIR/metrics/PR_${PR_NUM}_metrics.md"
```

### Update Review History

```bash
. /tmp/review_env.sh 2>/dev/null || true
echo "$PR_NUM $CURRENT_SEVERITY $CURRENT_DATE" >> "$REVIEW_DIR/metrics/severity_history.txt"

cat > "$REVIEW_DIR/metrics/history/${CURRENT_DATE}_${PR_NUM}.json" << EOF
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

Write the consensus findings as a JSON array to `/tmp/consensus_findings.json`. Each entry is
shaped `{ agent, category, severity, file, line, message, confidence, evidence, recommendation }`.
For severity ≥ 7, `confidence` must be `High`, `line` must anchor to an added/modified line, and
`evidence` must name the verified execution path or violated contract. Then emit the findings and
apply approved learnings when that layer is enabled, then build the hidden findings ledger from
the result — both steps are read-only engine calls with no required decision in between, so one
shell handles them (see **Build the findings ledger** below for what the second half does):

```bash
. /tmp/review_env.sh 2>/dev/null || true   # REVIEW_ID, INCREMENTAL, PR_NUMBER, set in Stage 0
set -e

# --- Capture consensus for the learning layer ---
# Deterministic AST matches are not subject to model consensus. Prepend them
# unchanged; the trusted publishing step verifies all their signatures survive
# filtering and ledger construction.
node - <<'NODE'
const fs = require('fs');
const model = JSON.parse(fs.readFileSync('/tmp/consensus_findings.json', 'utf8'));
const evidence = JSON.parse(fs.readFileSync('/tmp/review_evidence.json', 'utf8'));
if (!Array.isArray(model)) throw new Error('consensus findings must be an array');
fs.writeFileSync(
  '/tmp/consensus_findings.json',
  JSON.stringify([...(evidence.staticFindings || []), ...model], null, 2),
);
NODE
if [ "$(agent-review config get learning.enabled 2>/dev/null)" = "true" ]; then
  # REVIEW_ID is "<pr-or-local>-<timestamp>", so two reviews of the same branch never write to the
  # same pending/<reviewId>.yml.
  agent-review emit --in /tmp/consensus_findings.json --review "${REVIEW_ID:-local}"
  agent-review filter > /tmp/review_filtered.json   # defaults to the just-emitted findings.json
else
  # Keep one downstream shape even when learnings are disabled.
  node -e 'const f=require("/tmp/consensus_findings.json"); process.stdout.write(JSON.stringify({kept:f,suppressed:[]},null,2))' \
    > /tmp/review_filtered.json
fi

# --- Build the findings ledger ---
echo '[]' > /tmp/previous_agent_review_ledger.json
if [ -n "$INCREMENTAL" ] && [ -n "$PR_NUMBER" ]; then
  if [ -s "${AGENT_REVIEW_PREVIOUS_COMMENT:-}" ]; then
    tr -d '\r' < "$AGENT_REVIEW_PREVIOUS_COMMENT" \
      | sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' | head -1 \
      > /tmp/previous_agent_review_ledger.json
  else
    REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
    gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
      --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' \
      2>/dev/null | tr -d '\r' \
      | sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' | head -1 \
      > /tmp/previous_agent_review_ledger.json
  fi
  [ -s /tmp/previous_agent_review_ledger.json ] \
    || echo '[]' > /tmp/previous_agent_review_ledger.json
fi
agent-review ledger \
  --findings /tmp/review_filtered.json \
  --previous /tmp/previous_agent_review_ledger.json \
  > /tmp/agent_review_ledger.json
```

Report the `kept` findings from `/tmp/review_filtered.json` and note the count of `suppressed`
findings (suppressed by approved learnings). Tell the user they can mark outcomes in the emitted
`pending/<reviewId>.yml` (set each finding's `outcome` to `accepted` or `dismissed`), then run
`agent-review feedback <that file>` and `agent-review learn` to mine new proposed learnings, and
`agent-review learnings` / `agent-review approve <id>` to ratify them.

Deterministic findings merge into the ledger alongside model findings (via `agent-review ledger`)
and render as normal BLOCKERS/OTHER FINDINGS lines — there is no separate section for them. Carry
the rule id in the ledger entry's `agent` field and the rule's evidence in `evidence` so the
rendered line still shows its origin. Do not include them in agent agreement/debate counts; they
are independently reproducible checks.

### Build the findings ledger

The report's blocker checklist and findings list are the interactive surface devs work — a
hidden ledger marker carries the machine state behind them: each finding gets a stable number,
severity ≥ 7 items get a checkbox, and `/agent-review:address` (locally or via
`@claude fix/dismiss` PR comments) checks items off as **fixed** or **dismissed**. Build its
machine state now from the kept findings in `/tmp/review_filtered.json` (they already carry the
engine's `id` and `signature` from the emit step — keep both; the dismiss path writes them into
the feedback store):

- Order by severity descending; number 1..N.
- The engine, not the model, owns ledger merging and numbering. Fetch the previous hidden ledger
  on incremental runs, then call `agent-review ledger`. It preserves prior numbers/statuses,
  appends only new signatures, and fails closed on malformed state. A finding's absence from an
  incremental review does **not** prove it was fixed; only `/agent-review:address` may close it.
- The ledger also carries bounded `evidence` and `recommendation` fields. This preserves enough
  context to address an older open finding after the visible report is updated by a later run.

Computed above, in the same shell as **Capture consensus for the learning layer** — see that
block for the exact commands.

Render the ledger section of the report from this JSON, exactly per the skeleton's format.

**Inline finding anchors.** Also write `/tmp/agent_review_inline.json`: an array of
`{ "n", "file", "line", "severity", "message" }` for every ledger entry that is **open,
severity ≥ 7, and anchored to a line present in this diff** (skip entries with no line, and
cap at 25, highest severity first — inline anchors are a navigation aid, not a second report).
The publication step posts one PR review comment per entry at `file:line`, so reviewers see
each questioned location in context — and when a later commit changes those lines, GitHub
marks the comment *outdated*, a visual cue that the flagged code was actually touched.
Entries carried over from a previous incremental run keep their numbers; the publisher
dedupes by number, so already-anchored findings are never re-posted.

### Assess reversibility & build the status marker

Workflows gate auto-approval on a machine-readable status line — never on grepping the report's
prose. Build it now.

**Reversibility.** Judge from `/tmp/pr_full_diff.txt` — never the incremental-only
`/tmp/pr_diff.txt` — whether the full current PR contains operations that CANNOT be
cleanly undone by reverting the commit and rolling back. The question is "if this ships broken,
can we get back to the previous state?" — not how risky the change is. Classify as
**irreversible** when the diff includes any of:

- Destructive or mutating schema/data operations: `remove_column`, `drop_table`,
  `change_column` (type changes), `rename_column`/`rename_table`, `update_all`, `delete_all`,
  data backfills, raw `execute` SQL that writes
- One-way external side effects: sending email/notifications, charging or moving money, calls
  that create/mutate/delete records in external systems (MailChimp, S3 deletes, DonorHub)
- Anything else where rollback cannot restore the prior state (purging caches whose content
  can't be rebuilt, deleting files)

Purely additive changes (new column, new table, new index, new code paths, config) are
**reversible**. When genuinely uncertain, classify irreversible — the only cost is a human
look. List concrete reasons (`"change_column on donations.amount"`, `"update_all backfill in
migration X"`), each traceable to a diff hunk.

A lane that failed its Stage 2 cross-check twice never reaches this point — the run already
stopped with no report at all (see Stage 2). Reversibility judges the diff itself; it is never
used to signal incomplete review coverage.

**Status JSON.** Write the safety judgment first as `/tmp/agent_review_safety.json`:

```json
{ "irreversible": false, "reasons": [] }
```

Then have the engine compute `/tmp/agent_review_status.json` from the ledger and the **full-PR**
gate plan. Never hand-author `openBlockers`, `pass`, or `risk`:

```bash
. /tmp/review_env.sh 2>/dev/null || true
agent-review status \
  --ledger /tmp/agent_review_ledger.json \
  --plan /tmp/review_gate_plan.json \
  --safety /tmp/agent_review_safety.json \
  --evidence /tmp/review_evidence.json \
  ${HEAD_REF:+--head "$HEAD_REF"} \
  > /tmp/agent_review_status.json
```

The resulting object is:

```json
{
  "v": 1,
  "head": "<HEAD_REF sha, when known>",
  "risk": "<LOW|MEDIUM|HIGH|CRITICAL from the plan>",
  "openBlockers": 0,
  "pass": true,
  "irreversible": false,
  "irreversibleReasons": [],
  "ci": { "total": 4, "success": 2, "failed": 0, "pending": 2, "neutral": 0 }
}
```

`openBlockers` = count of ledger entries with severity ≥ 7 and `status: "open"`; `pass` =
`openBlockers == 0`. The posting steps embed this as a `<!-- agent-review-status: … -->` line;
`/agent-review:address` recomputes `openBlockers`/`pass` whenever it mutates the ledger.
`irreversible` is a property of the reviewed diff, so address never changes it — only a
re-review does.

### Write the report

Read the plugin's report skeleton — `../../templates/report.md`, relative to this skill file — and
fill it in from `/tmp/consensus_findings.json` (consensus JSON), the full-PR gate plan
(`/tmp/review_gate_plan.json`), and the status marker (`/tmp/agent_review_status.json`) built
above — plus the dependency impact analysis and each agent's own
`/tmp/agent_findings/<id>.json` for its summary-table row. The skeleton's bracketed placeholders
and `[IF …]` / `[FOR EACH …]` directives tell you exactly what goes where. Honor its conditionals:

- Set Rollout from `$AGENT_REVIEW_ROLLOUT_MODE` (default `advisory`). In `shadow`, say plainly that
  the report cannot approve or block the PR. Fill deterministic evidence from
  `/tmp/review_evidence.json` and cross-repo context from `/tmp/review_context.json`; do not infer.
- One summary-table row per **launched** agent, using each agent's `title`, in launch order.
- Each finding's `agent` field is the primary (highest-severity) corroborating lane only — kept
  single so the ledger signature never shifts with corroboration count. Wherever a finding names
  its agent(s) for a human reader — the `_([agent])_` suffix on BLOCKERS/OTHER FINDINGS lines and
  the **Per-agent perspectives** list — source the full corroborating set from the finding's
  `agents` field (comma-joined), falling back to `agent` when `agents` is absent (a singleton,
  uncorroborated finding).
- Append ` · 🤔 needs-human-review` to a BLOCKERS/OTHER FINDINGS line only when that ledger entry
  carries `needsHumanReview: true` (severity spread >= 4 across the finding's corroborating
  members — a real disagreement, not something to dismiss reflexively); omit the suffix
  otherwise.
- Omit the **Debate summary** block from `Review detail & stats` entirely when debate rounds did
  not run. That block is the only place debate output ever appears in the report.
- Omit the learning-layer line when the learning layer is disabled.
- Fill the DEPENDENCY IMPACT section from `/tmp/review_impact.json` (`blastRadius`, `topImpacted`,
  `truncated`) — that is the only impact artifact this skill produces. State "index disabled" there
  when Stage 1B was skipped, and drop the breaking-changes subsection when nothing was detected.
- Fill the skeleton's `[IF routing degraded:]` line inside `Review detail & stats` when
  `$ROUTING` is `degraded` (the Stage 0B smoke test failed and every agent launched on
  `general-purpose` instead of its tier subagent type). Omit it entirely otherwise — never
  freestyle this note; the skeleton in `templates/report.md` owns its exact wording.
- Fill the skeleton's `[IF any lanes were skipped:]` line inside `Review detail & stats` from
  `/tmp/skipped_lanes.txt` (one id per line, written at Stage 1's launched-subset derivation) as
  `- lanes with no matching changes: <comma-joined ids>`. Omit the line entirely when the file is
  empty or absent.

Fill the skeleton top-down and state each finding exactly once: open blockers in
"BLOCKERS — fix or dismiss to pass" (with their evidence and fix lines), every
other ledger entry as a single line in "OTHER FINDINGS". Never restate a finding
in another section — per-agent perspectives inside "Review detail & stats" refer
to findings by `#N`, they do not repeat the message. Everything below OTHER
FINDINGS lives in the four <details> sections from the skeleton; add nothing
outside them; soft target 25,000 bytes; the 60,000-byte hard cap and its trim
order still apply.

Save the filled report to `/tmp/agent_review_report.md`.

In CI mode, the `🔧 Fix suggestions` details section stays — but frame it as suggestions a human
can apply locally after review, and never execute anything.

GitHub issue comments are size-limited. In CI, keep `/tmp/agent_review_report.md` under 60,000
bytes (`wc -c`): prioritize the verdict line, the ledger, and blocker evidence. If still over
budget, trim in this order: drop the `📊 Review detail & stats` details section first, then the
`🔧 Fix suggestions` diffs, then non-blocker findings' `↳ evidence` lines. Never touch the hidden
markers or ledger lines.

### Version check — flag stale installs

The running plugin's version is the `version` field of `../../.claude-plugin/plugin.json`,
relative to this skill file (the same way the report skeleton is located). Read it into
`PLUGIN_VERSION`. Best-effort only: any failure in this whole subsection (no network, missing
file) skips the note — it must never block or fail a review.

**In CI** the plugin is pulled fresh every run, so the plugin itself is current — but the repo's
copied workflow files can be stale. Read the `# agent-review-template-version: X.Y.Z` marker from
each `.github/workflows/agent-review*.yml` in the repo under review. If any marker is missing or
older than the plugin version, append a short footer note to the report (after the visible body,
never inside the hidden markers):

> ⬆️ This repo's agent-review workflow files are from v[OLDEST or "pre-0.3.0"] (latest:
> v[PLUGIN_VERSION]). Run `/agent-review:update-files` in a Claude Code session to refresh them.

**Locally** the opposite can be stale: compare the installed plugin against main —

```bash
LATEST=$(gh api repos/CruGlobal/agent-review/contents/.claude-plugin/plugin.json \
  --jq .content 2>/dev/null | base64 -d | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))' \
  2>/dev/null || echo "")
```

If `LATEST` is non-empty and `PLUGIN_VERSION` is older than it (semver comparison — never flag a
mere difference, a dev install ahead of main is not stale), note it in the Stage 8 summary:
"You are on agent-review v[PLUGIN_VERSION]; the latest is v[LATEST] — run
`/plugin marketplace update cruglobal` to update." Also run the CI-style template-marker check
against the local repo's workflow files and add the `/agent-review:update-files` note if they
lag. If the repo has no `.github/workflows/agent-review*.yml` files at all, it doesn't use CI
review — skip the workflow-file note entirely rather than nagging about files that were never
installed.

---

## Stage 7 — Commit Metrics & Interactive Actions

**SKIP THIS ENTIRE STAGE IN CI MODE** — no commits, no pushes, no interactive menu. In CI, go
straight to the [CI Mode](#ci-mode) posting step, then Stage 8.

### Commit Metrics Dashboard

```bash
. /tmp/review_env.sh 2>/dev/null || true   # PR_NUM, CURRENT_DATE, CURRENT_SEVERITY, AGENT_MODE, FIX_COUNT
if [ -f "$REVIEW_DIR/metrics/PR_${PR_NUM:-}_metrics.md" ]; then
  echo "📊 Committing quality metrics dashboard..."
  git add "$REVIEW_DIR/metrics/PR_${PR_NUM}_metrics.md" \
          "$REVIEW_DIR/metrics/severity_history.txt" \
          "$REVIEW_DIR/metrics/history/${CURRENT_DATE}_${PR_NUM}.json"

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
  1) cat "$REVIEW_DIR/metrics/PR_${PR_NUM}_metrics.md" ;;
  2)
    # Same create-or-update path as CI: the marker makes repeat posts update one comment instead
    # of stacking new ones, so an interactive re-post never duplicates the CI comment.
    if [ -z "${PR_NUMBER:-}" ]; then
      echo "⚠️  No PR number available — report left at /tmp/agent_review_report.md"
    else
      REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
      { echo '<!-- agent-review -->'
        [ -n "${HEAD_REF:-}" ] && echo "<!-- agent-review-head: $HEAD_REF -->"
        echo "<!-- agent-review-rollout: ${AGENT_REVIEW_ROLLOUT_MODE:-advisory} -->"
        [ -s /tmp/agent_review_ledger.json ] \
          && echo "<!-- agent-review-ledger: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_ledger.json","utf8"))))') -->"
        [ -s /tmp/agent_review_status.json ] \
          && echo "<!-- agent-review-status: $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("/tmp/agent_review_status.json","utf8"))))') -->"
        echo
        cat /tmp/agent_review_report.md
      } > /tmp/agent_review_comment.md

      # SELF-CHECK — same as the CI posting step: catches hand-transcribed marker lines
      # (mangled escapes) before this ever reaches GitHub. The marker lines above MUST come
      # only from the node commands; never hand-write or hand-edit them.
      node -e '
const fs = require("fs");
const c = fs.readFileSync("/tmp/agent_review_comment.md", "utf8").replace(/\r/g, "");
for (const name of ["ledger", "status"]) {
  const m = c.match(new RegExp("^<!-- agent-review-" + name + ": (.*) -->$", "m"));
  if (m) JSON.parse(m[1]);
}
console.log("marker self-check OK");
' || { echo "❌ marker JSON invalid — REGENERATE the comment using ONLY the node commands above (never hand-write marker lines), then re-run this block"; exit 1; }

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
    echo "Metrics saved to: $REVIEW_DIR/metrics/PR_${PR_NUM}_metrics.md"
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
[IN CI MODE, OMIT THE LINE BELOW ENTIRELY WHEN DEBATE ROUNDS DID NOT RUN — same condition as the
Debate summary block's omission. Otherwise:] 🤔 [N] Unresolved debates ([N] = ledger entries
carrying `needsHumanReview: true`, not a debate-specific count)

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
[IF the installed plugin is older than main (local runs only):]
⬆️  agent-review update available: you are on v[PLUGIN_VERSION], latest is v[LATEST]
   → run `/plugin marketplace update cruglobal`
[IF this repo's workflow files carry an older or missing template marker:]
⬆️  agent-review workflow files are out of date (v[oldest marker, or "pre-0.3.0"] → v[PLUGIN_VERSION])
   → run `/agent-review:update-files`
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
Stage 0A truncates it and writes `MODE`/`AGENT_MODE`, then `CI_MODE`; Stage 0 adds `DAY_OF_WEEK`,
`BASE_REF`, `RANGE`; the Stage 0B smoke test adds `ROUTING`; Stage 2B adds `FIX_COUNT`; Stage 5B
adds `PR_NUM`, `CURRENT_DATE`, `CURRENT_SEVERITY`. Any block using a value it did not compute
itself begins with `. /tmp/review_env.sh 2>/dev/null || true`. If you add a stage, keep the
discipline.

**Modes**

| Mode     | Agents                                          | Model                                             | Use for                        |
| -------- | ----------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| quick    | up to 3 (testing, standards, first triggered)    | per-agent tier (non-escalating `smart` → haiku)    | small, low-risk changes        |
| standard | engine selection from the diff                  | per-agent tier (see plan)                          | normal feature work            |
| deep     | every enabled agent                             | per-agent tier (escalating on HIGH/CRITICAL → opus) | high-risk or critical changes  |

**Security posture**

Agent-generated `fix_*.sh` scripts are derived from PR content, which an outside contributor can
influence. `apply_all.sh` dry-runs by default and applies nothing without an explicit `--yes` from a
human who has read the scripts. CI never executes them at all.
