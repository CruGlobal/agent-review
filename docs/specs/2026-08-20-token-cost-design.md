# Token-cost reduction for CI reviews — design (evaluated)

Baseline: real CRITICAL run (mpdx_api PR 3545, 27 files/+3070, 9 agents, all Opus):
**$32.29** = 30.1M cache-read ($15.07) + 1.16M cache-write ($7.24) + 399K output ($9.98).
Pricing model closes against the run to the cent (Opus 5: $5/$25, cache read 0.1x,
cache write 1.25x).

Three independent adversarial evaluations (quality red-team, cost audit, feasibility
audit) shaped this revision. Audited target: **~$8 central, $6.5–12 range** for the
same CRITICAL review (−65–75%); LOW-risk PRs on cheap tiers: well under $1; score-0
diffs: $0. All named baseline findings preserved (see Verification).

## Pillar O — OmniRoute: real model routing

The Task tool has **no `model` parameter** (removed in Claude Code v2.1.69; silently
stripped by `additionalProperties: false`). Today's SKILL.md model instructions and
quick-mode's `MODEL_OVERRIDE="haiku"` have therefore never worked — every subagent
has always inherited the main-thread model.

- O1. Ship tiered subagents in the plugin: `agents/reviewer-opus.md`,
  `reviewer-sonnet.md`, `reviewer-haiku.md` — thin definitions whose only job is
  `model:` frontmatter (+ low reasoning effort, see O5); the full per-lane prompt
  still comes from archetype.md via the Task prompt. Launch table selects
  `subagent_type: agent-review:reviewer-<tier>`.
- O2. Stage 0 smoke test: launch a trivial tier-agent task; if the subagent type is
  unknown (plugin-agent loading under claude-code-action `-p` mode is undocumented),
  fall back to `general-purpose` and add a "routing degraded — ran on the default
  model" note to the report. Degrades to today's cost, never fails the review.
- O3. Engine-resolved tiers (no prose logic): plan emits per-agent `escalates` and a
  deterministic resolver maps mode + risk + config to a tier:
  explicit config model → that tier; `smart` → sonnet; `smart` + `escalates: true` +
  HIGH/CRITICAL → opus; quick mode → haiku for non-escalating lanes. Both blanket
  escalation sites die: SKILL.md:694-695 AND auto-mode's `CRITICAL →
  MODEL_OVERRIDE="opus"`.
- O4. Config: `escalates: boolean` added to the agent schema (additionalProperties
  currently rejects it). loadConfig gains an always-run normalization pass (separate
  from the v1→v2 gate) defaulting `escalates: true` for agent ids `security`,
  `data-integrity`, `architecture`; if none of those ids exist, warn and default
  `escalates: true` for agents whose triggers match the migration/config-security
  special patterns (so renamed lanes never silently lose Opus). Documented in
  templates/config.yml and surfaced in plan output.
- O5. Reasoning effort: subagents run at low/medium effort (in the tier-agent
  definitions); main thread stays default. Cuts uncapped thinking output and turn
  count — the cost audit's cheapest lever.
- Honest sizing (audited): Sonnet 5 is $3/$15 = only 1.67x cheaper than Opus 5 —
  routing is a 15–20% lever, not 50%. Haiku 4.5 ($1/$5) is the real 5x tier; the
  resolver sends non-escalating lanes to haiku on LOW/quick and sonnet otherwise.
  Report writing moves to the main model regardless (mechanical assembly).

## Pillar R — RTK: read less by default, never less when it matters

- R1. `agent-review slice`: per-agent diff slices from the agent's path globs AND
  content triggers (`contentMatches()` reused per-hunk; plan carries `triggers`).
  Hard rules from the quality red-team: agents with `escalates: true`, and
  `architecture` always, get the FULL diff — cross-file findings (the FK blocker)
  must never be severed. Sliced agents also get the changed-file list + diff stat
  inline so they can pull other hunks deliberately. Always-on generalists (~half the
  lanes) keep the full diff; their lever is R2, not slicing. Agents whose slice is
  empty are not launched at all.
- R2. archetype.md reading contract (all lanes):
  - drop "read the FULL file content of EACH changed file"; the slice/diff carries
    hunk context; full-file reads are budgeted (~5; ~10 for sonnet lanes on
    HIGH/CRITICAL per the red-team's compounding-cuts rule)
  - the unbounded grep loop becomes a bounded DISCOVERY budget, not zero: for each
    identifier/constant/enum/contract the diff introduces or modifies, at most one
    repo-wide grep (~10 total), plus verification greps before reporting any
    finding. (Verify-only grep is circular — the enum-duplication finding class
    cannot be discovered under it.)
- R3. CLAUDE.md/AGENTS.md reads stay (one cached read per agent, conventions
  matter).

## Pillar C — Caveman: compact outputs, two-tier evidence

- C1. Findings are structured JSON with caps: message ≤2 sentences; evidence ≤2
  lines for severity <7, ≤8 lines/600 chars (may include one hunk excerpt) for
  severity ≥7 — the engine hard-fails blockers without concrete evidence, so the
  cap must not starve them. Optional `questions[]` (cross-agent questions) and
  `overallConfidence` fields survive. Fix hint ≤2 lines or unified diff ≤10 lines.
- C2. CI mode: no automated-fix heredoc scripts (never executed in CI — pure
  waste); local mode keeps them. Rule checklists: violations only.
- C3. The raw-agent-report appendix is dropped in CI always. Ledger, status, inline
  anchors, blocker detail blocks (with per-agent perspectives from the findings
  JSON): unchanged.

## Pillar P — Ponytail: files not prose, engine not model

- P1. Agents write findings JSON to `/tmp/agent_findings/<id>.json` (the shape
  emit/cleanFinding already accepts) and return one line: "done — N findings, max
  severity X". FAIL CLOSED: `agent-review consensus` takes the plan and errors when
  any launched agent's file is missing or unparseable; the skill cross-checks N
  against the file and treats mismatch as a failed lane (relaunch once, else the
  run cannot report PASS). Local debate (Stages 3/4) and Stage 2B re-spec to source
  from the findings files.
- P2. Consensus splits between engine and model:
  - engine (`agent-review consensus`): cross-agent grouping via a NEW agent-less
    key (file + line proximity ±3 + normalized-message token overlap) — the
    existing ledger `signature` keeps the agent id and MUST NOT change (dismissal
    stores depend on it); severity averaging; corroboration counts; tier table;
    profile cutoff; severity-spread ≥4 → needs-human-review; staticFindings
    prepended (their signatures must survive to the ledger — workflow-verified).
  - model: ONE bounded pass over engine-nominated merge candidates (same file,
    overlapping lines, different wording) and contradictions — merge/keep/resolve
    decisions only, tiny context. Engine applies the decisions.
  Pure-code-only consensus is infeasible: it triples blockers (inflating
  `openBlockers`, a governance signal) and can never fire the corroboration tiers.
- P3. Report writing reads consensus JSON + plan + status — with one documented
  exception: the reversibility/safety pass KEEPS its full-diff read (it feeds
  `irreversible` and the auto-approval gate; the baseline's 4 irreversibility
  reasons came from exactly that read).
- P4. CI bash blocks ~18 → ~8: merged blocks use `set -e`, stay idempotent (bwrap
  bind-race reruns re-execute whole blocks), keep `/tmp/review_env.sh` sourcing
  discipline; the auto-mode resolution block stays its own turn (its output directs
  model control flow — skip must not launch agents).

## Cost model (audited numbers)

Central: 3 Opus + 6 Sonnet/Haiku agents, ~38K avg context (20K fixed floor is
real), ~16 turns each; main ~50K avg × ~30 turns; output ~122K → **~$8.1**.
Pessimistic (50K avg, 18 turns, slices 50% effective): **~$10.6** (−67%).
Worst-plausible (slices useless, 22 turns): ~$15.4 (−52%). Breaching a 50% saving
requires slices failing AND turn discipline collapsing simultaneously.

## Verification (gates, in order)

1. Unit tests: tier resolver matrix, `escalates` normalization (incl. no-matching-
   ids warning path), slice (path + content triggers, empty-slice skip, full-diff
   for escalating lanes), consensus (grouping, fail-closed on missing lane file,
   corroboration, static-finding survival), schema.
2. `npm run test:e2e` on the seeded diff: same blockers found; assert the routing
   smoke-test outcome is visible in the transcript.
3. CI canary on a LOW-risk mpdx PR: confirm modelUsage shows multiple models (the
   first proof routing works at all under the action).
4. Full A/B on a CRITICAL-class PR vs the $32 baseline report. Named regression
   sentinels beyond the 3 blockers: the enum 4-place-duplication finding, the
   alert-email batching finding, and all four irreversibility reasons. Cost target
   ≤ $12.

## Rollout order (each lands green before the next)

1. O (routing + effort) — biggest risk (undocumented agent loading), canaried
   first, degrades safely.
2. C + report changes — pure output savings, no discovery risk.
3. P1/P2 (files + consensus split) — the structural change, behind full unit
   coverage.
4. R (slicing + reading contract) + P4 — the context/turn cuts, measured last so
   the A/B isolates their effect.

## Explicitly not cut

Agent count per mode, rules docs, evidence discipline for blockers, ledger/status/
inline-anchor contracts, incremental review, debate (local), the report sections
humans read, the reversibility full-diff read.
