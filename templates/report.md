<!-- This skeleton is filled by skills/review/SKILL.md. The CI posting step then prepends the
real hidden state markers before the comment is published — see skills/review/SKILL.md's posting
step for the exact format. Once posted they must stay byte-exact: addressState and the
publish-step validation parse them with anchored per-line regexes, each expecting exactly one
match. -->

[DO NOT write literal agent-review-head, agent-review-rollout, agent-review-ledger, or
agent-review-status HTML comment lines anywhere in the filled report body — the CI posting step
prepends its own single copy of each after this skeleton is filled, and a duplicate line breaks
address parsing ("report must contain exactly one findings ledger/status marker").]

🤖 agent-review · [❌ [N] blockers open | ✅ no blockers] · risk [LEVEL][ · ⚠️ irreversible]
[one-line: rollout mode ($AGENT_REVIEW_ROLLOUT_MODE, default advisory — in shadow, say plainly
this report cannot approve or block the PR) · [N] agents run ([list of launched agent titles])
· incremental since [short SHA] if scoped · [N] debate rounds if run]

## BLOCKERS — fix or dismiss to pass

[FOR EACH severity ≥7 ledger entry, ordered by severity descending, numbered 1..N:]
[IF status open:]

- [ ] **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_
      ↳ evidence: [≤8 lines/600 chars, may include one hunk excerpt]
      ↳ fix: [≤2 lines or unified diff ≤10 lines]

[IF status fixed:]

- [x] **`#[N]`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — ✅ fixed in [short sha]

[IF status dismissed:]

- [x] **`#[N]`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — 🚫 dismissed by @[user] [[reason code]]: [reason]

[IF no severity ≥7 entries exist at all:] ✅ No blockers.

[IF status.irreversible:]
⚠️ **Irreversible**: [semicolon-joined irreversibleReasons] → auto-approval stays off; a human must approve.

## OTHER FINDINGS ([N])

[FOR EACH severity <7 ledger entry, ordered by severity descending, ONE line, no sub-bullets:]
[IF status open:]

- **`#[N]`** · [severity]/10 · `[file:line]` — [one-line message] _([agent])_

[IF status fixed:]

- **`#[N]`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — ✅ fixed in [short sha]

[IF status dismissed:]

- **`#[N]`** · [severity]/10 · `[file:line]` — ~~[one-line message]~~ — 🚫 dismissed by @[user] [[reason code]]: [reason]

<details><summary>🔧 Fix suggestions ([N])</summary>

[IF FIX_COUNT is 0:] No automated fixes for this review.
[FOR EACH suggested fix:] **`#[N]`** — [Title]: `[file:line]`

```diff
[≤10-line unified diff]
```

[Local mode only — never in CI, nothing is executed there:]
Apply: `bash /tmp/automated_fixes/fix_N_category.sh` (omit `--yes` first for a dry run)

</details>

<details><summary>📦 Dependency impact</summary>

[blastRadius, direct dependents, and topImpacted table from /tmp/review_impact.json; say
"index disabled" when Stage 1B was skipped]

**Breaking changes** [omit this subsection when none were detected]: [removed exports or other
breaking changes as reported by the agents]

</details>

<details><summary>📊 Review detail & stats</summary>

**Generated**: [timestamp] · **Day**: [day of week] · **Files changed**: [N] (+[X] -[Y] lines)
**Risk score**: [X]/[max] — [LOW/MEDIUM/HIGH/CRITICAL] · **Required reviewer**: [role for that level]
[IF FRIDAY/WEEKEND:] ⚠️ **[DAY] deployment**: [appropriate warning based on risk score]

**Risk factors detected**: [list specific factors, or "none"]

**Deterministic evidence**:

- AST/static rules: [N findings, list rule ids or "none"]
- CI snapshot: [N passed, N failed, N pending; name failed/pending checks with links]
- Cross-repo context: [available repo ids + pinned short SHAs, or "none"]

**Agent summary** [one row per launched agent, using each agent's `title`, in launch order]:

| Agent         | Critical | High    | Important | Suggestions | Confidence |
| ------------- | -------- | ------- | --------- | ----------- | ---------- |
| [Agent title] | [N]      | [N]     | [N]       | [N]         | [H/M/L]    |
| **Total**     | **[N]**  | **[N]** | **[N]**   | **[N]**     | -          |

**Per-agent perspectives on blockers** [FOR EACH blocker, the agents that flagged it]:

- **`#[N]`**: [Agent 1] (Severity: [X]/10): [their specific concern] · [Agent 2] (Severity:
  [Y]/10): [their specific concern]

**Debate summary** (omit this whole block if debate rounds were not run):

- Rounds: [N] · Challenges raised: [N] (defended [N], conceded [N]) · Findings revised: [N] ·
  Severity adjustment: [+/-X] average · Escalated to human: [N]
- [FOR EACH unresolved debate: topic, severity range agents disagree by, each agent's position,
  and why it needs a senior developer rather than reflexive dismissal]

**Review quality**:

- Average agent confidence: [High/Medium/Low] · Consensus rate: [X]% · Review time: [X] minutes
- [IF learning layer enabled:] Findings suppressed by approved learnings: [N]
- [IF a quality trend is available:] Quality trend: [description]

</details>

<details><summary>💬 How to act on this review</summary>

Every finding above is numbered. Severity ≥ 7 findings carry a checkbox and must each be **fixed or
dismissed** before this review counts as passed; lower severities are advisory. Interact from a
PR comment — `@claude fix 1, 3` · `@claude dismiss 2 [false-positive]: <one-line reason>`
(a reason code and explanation are required) — or locally with `/agent-review:address`. Valid
codes: `false-positive`, `intentional`, `pre-existing`, `deferred`, `duplicate`,
`insufficient-evidence`, `other`.

- `@claude fix 1, 3, 5` — AI applies those fixes on this branch and checks them off
- `@claude dismiss 2 [intentional]: matches legacy import behavior` — checks it off with your
  reason; repeated dismissals of the same finding class teach the review to stop raising it
- `@claude fix 1, 3; dismiss 2 [false-positive]: guarded by the caller` — mixed operations use a
  semicolon between clauses

Or locally: `/agent-review:address` pulls this ledger into a Claude Code session.

[IF UNRESOLVED DEBATES: note that ledger items marked needs-human should be resolved by a senior
developer, not dismissed reflexively.]

</details>

[version-check footer line, when stale — unchanged from current: appended after the visible body,
never inside the hidden markers]
