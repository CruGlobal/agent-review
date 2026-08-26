# Ponytail Consensus (Phase 3 of token-cost design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main thread stops holding nine agent essays: agents hand off findings as JSON files, a deterministic `agent-review consensus` engine command does the grouping/averaging/tiering with one bounded model pass for ambiguous merges, and the CI setup turns consolidate — attacking the measured $8.80 Opus main-thread share of a $9.60 review.

**Architecture:** Two new engine modules (`consensus.cjs` for grouping, decisions applied in the same command via `--decisions`), a rewritten agent output contract in `templates/archetype.md` (JSON file + one-line return), and skill rewiring of Stages 2/5/6 plus CI bash-block consolidation. Fail-closed throughout: a missing or unparseable lane file errors the consensus command; the skill relaunches that lane once, else the run cannot report PASS. The ledger's existing `signature` (agent id inside the hash) is untouchable — dismissal stores depend on it; cross-agent grouping uses a NEW agent-less key that never leaves the consensus computation.

**Tech Stack:** Node engine + `npm test`; skill/template prose; `npm run test:e2e`.

**Spec:** `docs/specs/2026-08-20-token-cost-design.md` (Pillar P, items P1-P4, incl. the red-team and feasibility amendments).

## Global Constraints

- `engine/findingSignature.cjs` and every ledger/status/marker contract: byte-identical behavior. The workflow's publish check requires every `evidence.staticFindings[].signature` to survive into the ledger — the consensus command must preserve that invariant (static findings pass through with their existing signatures, never merged away).
- Blocker discipline unchanged: consensus output feeds `agent-review emit/filter/ledger/status` exactly as `/tmp/consensus_findings.json` does today — same entry shape `{agent, category, severity, file, line, message, confidence, evidence, recommendation}` (multi-agent groups render `agent` as comma-joined ids, matching what the HCM baseline report already did).
- FAIL CLOSED: consensus with `--plan` errors (exit 1, named lane) when any launched agent's findings file is missing or unparseable JSON; empty findings array is valid (a lane may find nothing).
- The reversibility/safety pass KEEPS its full-diff read (documented exception; feeds auto-approve).
- Debate stages (local mode) source from the findings files, never pasted prose.
- Engine changes ⇒ `npm run build` + commit dist (check-dist gate). Version bump 0.5.0 at the end.
- The auto-mode resolution block stays its own bash turn (its output directs model control flow); consolidated blocks use `set -e` and stay idempotent (bwrap rerun rule).

---

### Task 1: `agent-review consensus` — deterministic grouping core

**Files:**
- Create: `engine/consensus.cjs`, `engine/consensus.test.cjs`
- Modify: `engine/cli.cjs` (new subcommand + usage line)

**Interfaces:**
- Produces: `consensusFrom({ plan, findingsByAgent, profile, decisions })` returning `{ findings, candidates, stats }`, and CLI `agent-review consensus --plan <f> --dir <d> [--profile <p>] [--decisions <f>] > out.json`.
- Grouping key (cross-agent, NEVER persisted): same file AND (line within ±3 OR both lines null) AND normalized-message token Jaccard ≥ 0.5 (normalize: lowercase, strip quotes/digits/punctuation, split on whitespace).
- Group output entry: `agent` = comma-joined sorted lane ids, `severity` = rounded mean, `confidence` = highest member's, `evidence`/`recommendation` = longest member's, `line` = the highest-severity member's, `corroboration` = member count, `needsHumanReview: true` when member severity spread ≥ 4.
- `candidates`: ungrouped pairs sharing a file with line distance ≤ 10 — each `{a: <index>, b: <index>, reason}` over the output findings array, for the skill's bounded model pass.
- `decisions` file (second invocation): `[{merge: [i, j]} | {keep: [i, j]}]` — merge combines per the group rules; keep is a no-op marker. Unknown indices error.
- Profile cutoff: `chill` drops findings below severity 4 unless corroboration ≥ 2; `standard`/`assertive` keep all (mirror the thresholds documented in templates/config.yml's profile comment — read it and use its exact numbers if they differ from these).
- `evidence.staticFindings` are NOT input here — the skill continues to prepend them via the existing Stage 6 merge (`[...staticFindings, ...model]`), keeping the signature-survival invariant where it already lives. The consensus command handles ONLY agent findings.
- Fail-closed: with `--plan`, every `plan.agents[].id` must have `<dir>/<id>.json` parseable as `{findings: [...]}` or a bare array; otherwise exit 1 naming the lane(s).

- [ ] **Step 1: failing tests** (`engine/consensus.test.cjs`) — cover, with hand-built fixtures: (a) two agents, same file, lines 120/122, paraphrased messages sharing ≥half their tokens → one group, corroboration 2, comma-joined agent; (b) same file, lines 120/134, different wording → two findings + one candidate pair; (c) severity spread ≥4 in a group → needsHumanReview; (d) missing lane file with --plan → throws naming the lane; (e) truncated JSON → throws; (f) empty findings array → valid, contributes nothing; (g) decisions merge combines two candidates into a group; (h) chill profile drops an uncorroborated severity-3 finding but keeps a corroborated one. Write the test bodies concretely — the shapes above are the contract.
- [ ] **Step 2: RED** — `npm test 2>&1 | grep -i consensus`.
- [ ] **Step 3: implement** `engine/consensus.cjs` + the CLI case (usage: `consensus --plan <f> --dir <d> [--profile <p>] [--decisions <f>]   deterministic cross-agent finding consensus`).
- [ ] **Step 4:** full suite green; `npm run build`; check-dist expects the staged dist change.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: deterministic cross-agent consensus engine command"`

### Task 2: agent findings-file contract (templates/archetype.md)

**Files:**
- Modify: `templates/archetype.md` (report format section)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Produces: every agent writes `/tmp/agent_findings/<AGENT_ID>.json` — `{findings: [{agent, category, severity, file, line, message, confidence, evidence, recommendation, fix}], questions: [], overallConfidence: "High|Medium|Low"}` — where `<AGENT_ID>` and the `agent` field value are the plan agent id (a new `{{AGENT_ID}}` placeholder the skill fills; add it to the archetype placeholder set AND update the placeholder-vocabulary test in templates.test.cjs). The Task return message becomes exactly: `done — <N> findings, max severity <X>`.
- The markdown findings sections are REPLACED by the JSON contract (the per-finding caps from Phase 1 apply to the JSON string fields verbatim); Rule Checklist violations become findings with category `standards-checklist`; the Automated Fix local-mode script instructions survive unchanged.

- [ ] **Step 1: failing test** — templates.test: archetype includes `/tmp/agent_findings/`, the `done — ` return contract, `{{AGENT_ID}}`, and no longer instructs the `## {{TITLE}} — Findings` markdown report; placeholder-vocabulary test updated to include AGENT_ID.
- [ ] **Step 2: RED.** **Step 3:** rewrite the section (keep severity/evidence cap text, restate against JSON fields). **Step 4:** suite green. **Step 5: Commit** — `git commit -m "feat: agents hand off findings as JSON files, one-line returns"`

### Task 3: skill rewiring — Stages 1/2/5/6 (skills/review/SKILL.md)

**Files:**
- Modify: `skills/review/SKILL.md`
- Test: `engine/templates.test.cjs`

**Interfaces:** consumes Task 1's CLI and Task 2's file contract.

- [ ] **Step 1: failing tests** — skill contains: `agent-review consensus --plan`, the relaunch-once rule ("relaunch that lane once; a lane that fails twice blocks PASS"), the candidates bounded-pass instruction, and no longer instructs in-context Stage 5 grouping ("Group findings by similarity" gone); Stage 6 report inputs named as consensus JSON + plan + status with the reversibility full-diff exception stated; debate Stage 3 prompt sources peer findings from `/tmp/agent_findings/*.json` paths, not pasted output.
- [ ] **Step 2: RED.** **Step 3:** edits:
  - Stage 1 launch prompts fill `{{AGENT_ID}}`; the collect stage cross-checks each lane's one-line `N` against its file's array length (mismatch = failed lane → relaunch once).
  - Stage 2 becomes: run `agent-review consensus --plan /tmp/review_plan.json --dir /tmp/agent_findings --profile <profile> > /tmp/consensus_raw.json` (fail-closed errors surface verbatim); if `candidates` is non-empty, ONE model pass reading only the named candidate pairs → write `/tmp/consensus_decisions.json` → re-run with `--decisions`; final output to `/tmp/consensus_findings.json`.
  - Stage 5's manual grouping/averaging prose is deleted; the existing Stage 6 emit/filter/ledger/status pipeline and static-findings prepend stay byte-identical.
  - Stage 6 report-writing inputs sentence + reversibility exception; debate/rebuttal prompts point at the JSON files.
- [ ] **Step 4:** full suite green. **Step 5: Commit** — `git commit -m "feat: engine consensus with one bounded merge pass; main thread never holds agent essays"`

### Task 4: CI bash-block consolidation (P4)

**Files:**
- Modify: `skills/review/SKILL.md`
- Test: `engine/templates.test.cjs`

- [ ] **Step 1: failing test** — count ```bash fences in the CI path sections (Stage 0A through Stage 6; use the file's stage anchors to slice) and assert ≤ 10; assert every consolidated block's first non-comment line sources `/tmp/review_env.sh` (extend the existing Task-style contract-test idiom); assert the Auto Mode Resolution block remains its own fence.
- [ ] **Step 2: RED.** **Step 3:** merge adjacent read-only setup blocks (mode parse + CI detect + config validate + dirs; PR context + diff manifest; evidence load + plan; learnings + impact), each merged block starting with the env source and `set -e`, appends to review_env.sh at its end, and stays idempotent (`>` redirects, `mkdir -p`). Fail-closed exits keep their messages. Auto-mode resolution and the smoke test remain separate turns.
- [ ] **Step 4:** full suite green. **Step 5: Commit** — `git commit -m "perf: consolidate CI setup to <=10 bash turns"`

### Task 5: version 0.5.0

- [ ] Bump plugin.json + package.json to 0.5.0; sed the three template markers; `npm run stamp-templates`; `npm test` green. Commit `chore: release 0.5.0 — engine consensus and file handoff`.

### Task 6: live verification (controller-run)

- [ ] `npm test` + `npm run check-dist` clean.
- [ ] `caffeinate -dims npm run test:e2e -- --keep` on AC — PASS required; transcript checks: agents returned one-liners (no essays in main context), `agent-review consensus` invoked, candidates pass bounded (grep the decisions file usage); report still passes every publish check.
- [ ] Push, open PR; after merge + tag, canary on a real mpdx PR: compare cost vs the $9.60 phase-2 baseline — the target is the Opus main-thread share dropping materially (audited expectation: total ≤ ~$6-7 for the same class).
