# 🤖 Multi-Agent Code Review Report

**Generated**: [timestamp]
**Rollout**: [shadow/advisory/enforce — shadow is advisory only and never auto-approves]
[IF INCREMENTAL] **Scope**: Incremental — commits since previously reviewed [short SHA]. The previous full report is in this comment's edit history.
**Agents**: [N] specialized reviewers ([list of launched agent titles])[ with debate rounds]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📊 RISK ASSESSMENT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Risk Score**: [X]/[max] - [LOW/MEDIUM/HIGH/CRITICAL] (full current PR)
**Day**: [day of week]
**Files Changed**: [N] (+[X] -[Y] lines)

**Risk Level Meaning**:

- **LOW** (0-3): ✅ Entry-level or above can review
- **MEDIUM** (4-6): ✅ Entry-level or above can review
- **HIGH** (7-9): ⚠️ Experienced developer or above should review
- **CRITICAL** (10+): 🚨 senior maintainer must review

**Required Reviewer**: [Based on risk level]

**Risk Factors Detected**:
[List specific factors]

**Deterministic evidence**:

- AST/static rules: [N findings, list rule ids or "none"]
- CI snapshot: [N passed, N failed, N pending; name failed/pending checks with links]
- Cross-repo context: [available repo ids + pinned short SHAs, or "none"]

[IF IRREVERSIBLE]
⚠️ **IRREVERSIBLE CHANGES** — auto-approval is disabled for this PR; a human must approve.
[FOR EACH IRREVERSIBLE REASON:]
- [reason, tied to the diff hunk]

[IF FRIDAY/WEEKEND]
⚠️ **[DAY] DEPLOYMENT WARNING**
[Appropriate warning based on risk score]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📋 FINDINGS LEDGER

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every finding, numbered. Severity ≥ 7 findings carry a checkbox and must each be **fixed or
dismissed** before this review counts as passed; lower severities are advisory. Interact from a
PR comment — `@claude fix 1, 3` · `@claude dismiss 2 [false-positive]: <one-line reason>`
(a reason code and explanation are required) — or locally with `/agent-review:address`. Valid
codes: `false-positive`, `intentional`, `pre-existing`, `deferred`, `duplicate`,
`insufficient-evidence`, `other`. Details for each number are in the
severity sections below.

[FOR EACH FINDING, ordered by severity descending, numbered 1..N:]
[IF severity >= 7 AND status open:]
- [ ] **#[N]** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_
[IF severity >= 7 AND status fixed:]
- [x] **#[N]** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — ✅ fixed in [short sha]
[IF severity >= 7 AND status dismissed:]
- [x] **#[N]** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — 🚫 dismissed by @[user] [[reason code]]: [reason]
[IF severity < 7:]
- **#[N]** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_[IF resolved: same ✅/🚫 suffix as above]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🔧 AUTOMATED FIXES AVAILABLE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**${FIX_COUNT} automated fixes available**

Review and apply these fixes to address common issues quickly.

[IF FIX_COUNT > 0, FOR EACH FIX:]

### Fix #N: [Title] ([Confidence] Confidence)

**File**: `path/to/file:line`
**Category**: [category]
**Estimated Time**: 30 seconds

<details>
<summary>📝 View Fix Details</summary>

**Issue**: [description]

**Current Code**:

```
[old code]
```

**Fixed Code**:

```
[new code]
```

**Apply This Fix**:

```bash
bash /tmp/automated_fixes/fix_N_category.sh
```

</details>

---

**To apply all fixes**:

```bash
# Review all fixes first
ls -la /tmp/automated_fixes/

# Dry run — prints what each fix would change, writes nothing
bash /tmp/automated_fixes/apply_all.sh

# Apply for real once the dry run looks right
bash /tmp/automated_fixes/apply_all.sh --yes

# Then review changes
git diff

# If good, commit
git add . && git commit -m "Apply AI-suggested fixes"

# To undo
git checkout .
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📦 DEPENDENCY IMPACT ANALYSIS

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Blast radius, direct dependents and top-impacted files from /tmp/review_impact.json]

### High-Impact Changes

Files with 10+ dependents - test thoroughly:

[List high-impact files with dependent counts]

### Breaking Changes

[Removed exports or breaking changes as reported by the agents; omit this subsection when none]

### Recommendations

- Review all dependents before merging
- Add integration tests for high-impact changes
- Update documentation for breaking changes
- Consider deprecation warnings for removed exports

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🚫 CRITICAL BLOCKERS (Severity 9-10)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Must be fixed before merge** (Average severity 9-10 from multiple agents)

[FOR EACH CRITICAL BLOCKER:]

### [Issue Title]

**Severity**: [X.X]/10 (Consensus from [N] agents)
**File**: `[file:line]`
**Flagged by**: [Agent 1 ([score]/10), Agent 2 ([score]/10), ...]

**Problem**:
[Detailed description from consensus]

**Agent Perspectives**:

- **[Agent 1]** (Severity: [X]/10): [Their specific concern]
- **[Agent 2]** (Severity: [X]/10): [Their specific concern]

**Debate Summary**:

- [Summary of any challenges and resolutions]
- Final consensus: CRITICAL BLOCKER (Average: [X.X]/10)

**Required Action**:
[Specific steps to fix]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🔴 HIGH PRIORITY BLOCKERS (Severity 8-9)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Must be fixed before merge** (Average severity 8-9)

[FOR EACH HIGH PRIORITY BLOCKER - same format as above]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## ⚠️ IMPORTANT ISSUES (Severity 7-8)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Should be addressed before merge** (Average severity 7-8)

[FOR EACH IMPORTANT ISSUE - condensed format]

### [Issue Title]

**Severity**: [X.X]/10
**File**: `[file:line]`
**Flagged by**: [Agents]

**Issue**: [Description]
**Recommended Fix**: [How to address]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 💡 MEDIUM PRIORITY (Severity 5-7)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Consider addressing** (Average severity 5-7)

[Bulleted list of issues with file:line and brief description]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 💭 SUGGESTIONS (Severity 3-5)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Nice-to-have improvements** (Average severity 3-5)

[Grouped by category, bulleted list]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🤔 UNRESOLVED DEBATES

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Requires senior developer judgment**

[FOR EACH UNRESOLVED DEBATE:]

### [Debate Topic]

**Context**: [What the debate is about]
**Severity Range**: [Low]-[High]/10 (agents disagree by [X] points)

**Positions**:

**[Agent 1]** argues (Severity: [X]/10):
[Their position with reasoning]

**[Agent 2]** counters (Severity: [Y]/10):
[Their counter-position]

**Other agents**:

- [Agent 3]: [Position] (Severity: [Z]/10)
- [Agent 4]: [Position] (Severity: [W]/10)

**Why needs human review**:
[Explanation of why agents couldn't reach consensus]

**Recommendation**:
senior maintainer should decide based on [considerations]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📝 REVIEW SUMMARY

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ONE ROW PER LAUNCHED AGENT — use each agent's `title` from the plan, in launch order]

| Agent         | Critical | High    | Important | Suggestions | Confidence |
| ------------- | -------- | ------- | --------- | ----------- | ---------- |
| [Agent title] | [N]      | [N]     | [N]       | [N]         | [H/M/L]    |
| [Agent title] | [N]      | [N]     | [N]       | [N]         | [H/M/L]    |
| **Total**     | **[N]**  | **[N]** | **[N]**   | **[N]**     | -          |

**Debate Statistics** (omit if debate rounds were not run):

- Total challenges raised: [N]
- Challenges defended: [N]
- Challenges conceded: [N]
- Findings revised: [N]
- Severity adjustments: [+/-X] average
- Escalated to human: [N]

**Review Quality**:

- Average agent confidence: [High/Medium/Low]
- Consensus rate: [X]%
- Debate rounds: [N]
- Total review time: [X] minutes

**Learning layer** (omit if disabled):

- Findings suppressed by approved learnings: [N]

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🎯 RECOMMENDED NEXT STEPS

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Work the **FINDINGS LEDGER** at the top of this report — every severity ≥ 7 finding needs to be
fixed or dismissed (with a reason) before the review passes. From a PR comment:

- `@claude fix 1, 3, 5` — AI applies those fixes on this branch and checks them off
- `@claude dismiss 2 [intentional]: matches legacy import behavior` — checks it off with your
  reason; repeated dismissals of the same finding class teach the review to stop raising it
- `@claude fix 1, 3; dismiss 2 [false-positive]: guarded by the caller` — mixed operations use a
  semicolon between clauses

Or locally: `/agent-review:address` pulls this ledger into a Claude Code session.

[IF UNRESOLVED DEBATES: note that ledger items marked needs-human should be resolved by a senior
developer, not dismissed reflexively.]

---

<details>
<summary>📋 Full Agent Reports (click to expand)</summary>

[FOR EACH LAUNCHED AGENT:]

## [Agent title] - Complete Report

[Full original report]

</details>

---

<details>
<summary>🗣️ Debate Transcript (click to expand)</summary>

[OMIT THIS BLOCK ENTIRELY IF DEBATE ROUNDS WERE NOT RUN]

## Round 1: Cross-Examination

[Full debate round 1 transcripts]

## Round 2: Rebuttals

[Full rebuttal transcripts]

</details>

---

_🤖 Generated by agent-review_
_Review time: [X] minutes | Agents: [list of launched agent titles]_
