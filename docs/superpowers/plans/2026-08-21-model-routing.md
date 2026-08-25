# Model Routing (Phase 2 of token-cost design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review agents actually run on tiered models (Opus only for escalating lanes on HIGH/CRITICAL; Sonnet default; Haiku for quick mode) via plugin agent definitions, with engine-resolved routing, a degrade-safely smoke test, and a deterministic pass status on score-0 skips.

**Architecture:** The Task tool has no `model` parameter (removed in Claude Code v2.1.69) — routing ships as three thin agent definitions in the plugin's `agents/` dir selected via `subagent_type`. All resolution logic (mode from risk score, tier per agent) moves into the engine (`plan.cjs`/`selectAgents.cjs`), leaving the skill to read `plan.mode.resolved` and each agent's `tier`. Config gains `escalates`; loadConfig defaults it for the security/data-integrity/architecture lanes with a trigger-based fallback so renamed lanes never silently lose Opus.

**Tech Stack:** Node (engine, `npm test`), Claude Code plugin agent frontmatter, skill/template prose, `npm run test:e2e`.

**Spec:** `docs/specs/2026-08-20-token-cost-design.md` (Pillar O, items O1-O5, incl. the feasibility amendments) plus the skip-status determinism addition agreed 2026-08-21.

## Global Constraints

- The existing ledger `signature` and every machine contract (markers, ledger line shapes, status JSON schema fields) stay untouched.
- Both blanket escalation sites die: the `smart → opus when HIGH/CRITICAL` rule in SKILL.md's launch table AND auto-mode's `CRITICAL → MODEL_OVERRIDE="opus"`.
- Routing must DEGRADE, never fail: unknown subagent_type → `general-purpose` fallback + a "routing degraded — ran on the default model" line inside the report's `Review detail & stats` section.
- Engine changes ⇒ `npm run build` and commit `dist/` (check-dist gate).
- Version bump to 0.4.0 at the end (plugin.json, package.json, template markers, `npm run stamp-templates`) — agents/ is a new plugin capability.
- Tier vocabulary everywhere: `opus` | `sonnet` | `haiku`. Subagent types: `agent-review:reviewer-opus` etc.

---

### Task 1: `escalates` config field + normalization

**Files:**
- Modify: `schema/config.schema.json` (agents item properties)
- Modify: `engine/loadConfig.cjs`
- Modify: `templates/config.yml` (document the field on the three lanes)
- Test: `engine/loadConfig.test.cjs`

**Interfaces:**
- Produces: after `loadConfig`, every agent object has boolean `escalates` (explicit value kept; defaulted `true` for ids `security`, `data-integrity`, `architecture`; if NONE of those ids exist in the config, defaulted `true` for any agent whose triggers reference the `migration_change` or `config_security_change` special patterns, with a `console.warn`; else `false`). Task 2 consumes `agent.escalates`.

- [ ] **Step 1: Write the failing tests** — append to `engine/loadConfig.test.cjs`:

```js
test('escalates defaults: named lanes true, others false, explicit value wins', () => {
  const cfg = loadFixtureWith({ agents: [
    { id: 'security', triggers: { always: true } },
    { id: 'ux', triggers: { always: true } },
    { id: 'architecture', escalates: false, triggers: { always: true } },
  ]});
  const byId = Object.fromEntries(cfg.agents.map((a) => [a.id, a.escalates]));
  assert.equal(byId.security, true);
  assert.equal(byId.ux, false);
  assert.equal(byId.architecture, false); // explicit false is respected
});

test('escalates falls back to special-pattern triggers when no named lane exists', () => {
  const cfg = loadFixtureWith({ agents: [
    { id: 'database', triggers: { specials: ['migration_change'] } },
    { id: 'style', triggers: { always: true } },
  ]});
  const byId = Object.fromEntries(cfg.agents.map((a) => [a.id, a.escalates]));
  assert.equal(byId.database, true);
  assert.equal(byId.style, false);
});

test('schema accepts an explicit escalates boolean', () => {
  // config validate must not reject a consumer writing escalates: true
  const cfg = loadFixtureWith({ agents: [{ id: 'security', escalates: true, triggers: { always: true } }] });
  assert.equal(cfg.agents[0].escalates, true);
});
```

Adapt `loadFixtureWith` to however this test file builds configs today (read the file first; if there is no such helper, build a minimal v2 config object inline the way neighboring tests do — the assertions are the contract, the helper name is not).

- [ ] **Step 2: Run to verify they fail** — `npm test 2>&1 | grep escalates` → FAIL (schema rejects / field absent).
- [ ] **Step 3: Implement** — schema: add `"escalates": { "type": "boolean" }` to the agents item properties. loadConfig: an always-run normalization pass AFTER validation and any v1→v2 upgrade (never inside the version gate), implementing the default rules from Interfaces. templates/config.yml: `escalates: true` with a one-line comment on the security/data-integrity/architecture entries.
- [ ] **Step 4: Full suite green** — `npm test`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: escalates config field with safe lane defaults"`

### Task 2: engine tier + mode resolution in the plan

**Files:**
- Modify: `engine/plan.cjs`, `engine/selectAgents.cjs` (carry `escalates` through), `engine/cli.cjs` (plan gains `--mode`)
- Test: `engine/plan.test.cjs` (or the file where plan output is tested today — find it; `engine/selectAgents.test.cjs` exists)

**Interfaces:**
- Consumes: `agent.escalates` from Task 1.
- Produces: plan JSON gains `mode: { requested, resolved }` and per-agent `tier`. Resolution rules (pure function, exported as `resolveTiers({ agents, riskLevel, mode })` for testability):
  - mode resolution: requested `auto` → resolved from risk: score 0 → `skip`, LOW → `quick`, MEDIUM/HIGH → `standard`, CRITICAL → `deep`; any other requested value passes through as resolved.
  - tier per agent: explicit config `model` of `opus`/`sonnet`/`haiku` → that tier; `smart` → `escalates && riskLevel in {HIGH, CRITICAL}` ? `opus` : `sonnet`; then if resolved mode is `quick`, non-escalating agents drop to `haiku`. Deep mode adds nothing (escalation already covers it).
- CLI: `agent-review plan ... [--mode <auto|quick|standard|deep>]`, default `standard`.

- [ ] **Step 1: Write the failing tests**:

```js
test('resolveTiers routes smart lanes by escalation and risk', () => {
  const agents = [
    { id: 'security', model: 'smart', escalates: true },
    { id: 'standards', model: 'smart', escalates: false },
    { id: 'perf', model: 'haiku', escalates: false },
  ];
  const high = resolveTiers({ agents, riskLevel: 'CRITICAL', mode: 'standard' });
  assert.deepEqual(high.map((a) => a.tier), ['opus', 'sonnet', 'haiku']);
  const low = resolveTiers({ agents, riskLevel: 'LOW', mode: 'quick' });
  assert.deepEqual(low.map((a) => a.tier), ['sonnet', 'haiku', 'haiku']);
});

test('plan resolves auto mode from the risk score and stamps tiers', () => {
  // build a plan via the same fixture path the existing plan tests use;
  // assert plan.mode = { requested: 'auto', resolved: 'quick' } for a LOW diff
  // and every plan.agents[i].tier is one of opus|sonnet|haiku.
});
```

(Second test: flesh out against the existing plan-test fixtures in the file — the assertions named in the comment are the contract.)

- [ ] **Step 2: Verify RED** → `npm test 2>&1 | grep -i "resolveTiers\|stamps tiers"`.
- [ ] **Step 3: Implement** per Interfaces. `selectAgents` carries `escalates` onto its output objects; `plan.cjs` computes `mode.resolved` from its own risk result and calls `resolveTiers`; cli passes `--mode` through.
- [ ] **Step 4: Full suite green; `npm run build`; `npm run check-dist` expects a diff staged (dist changed — commit it).**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: engine-resolved review mode and per-agent model tiers"`

### Task 3: tier agent definitions

**Files:**
- Create: `agents/reviewer-opus.md`, `agents/reviewer-sonnet.md`, `agents/reviewer-haiku.md`
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Produces: three subagent types (`agent-review:reviewer-<tier>`) Task 4's launch table names.

- [ ] **Step 1: Failing test** — append to `engine/templates.test.cjs`:

```js
test('the plugin ships one thin reviewer agent per model tier', () => {
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    const body = readFileSync(join(ROOT, `agents/reviewer-${tier}.md`), 'utf8');
    assert.match(body, new RegExp(`^model: ${tier}$`, 'm'), `reviewer-${tier} must pin model: ${tier}`);
    assert.ok(/^name: reviewer-/m.test(body));
    assert.ok(body.length < 2000, 'tier agents are thin shells — the real prompt arrives via Task');
  }
});
```

- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Create the three files.** Each:

```markdown
---
name: reviewer-<tier>
description: agent-review specialist reviewer running on the <tier> model tier. Selected by the review skill's launch table; never invoke directly.
model: <tier>
---

You are one lane of a multi-agent code review. Your entire assignment — role,
rules, diff, output contract — arrives in the task prompt. Follow it exactly;
add nothing beyond it. Keep reasoning brief and focused: verify before you
report, and spend your effort on the diff, not on narrating.
```

If Claude Code agent frontmatter documents a reasoning-effort key (check https://code.claude.com/docs/en/sub-agents via WebFetch), add `effort: low` (haiku/sonnet) / `effort: medium` (opus) — if the key is not documented, OMIT it and note that in your report (spec O5 then lands via prompt text, which the "keep reasoning brief" line already provides).

- [ ] **Step 4: Suite green.**
- [ ] **Step 5: Commit** — `git add agents engine/templates.test.cjs && git commit -m "feat: tiered reviewer agent definitions (opus/sonnet/haiku)"`

### Task 4: skill wiring — launch table, smoke test, skip status

**Files:**
- Modify: `skills/review/SKILL.md` (auto-mode resolution block ~line 475-531; launch table ~line 689-696; skip-note posting block ~line 470-505; Stage 0)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes: `plan.mode.resolved` and `plan.agents[].tier` (Task 2), subagent types (Task 3).

- [ ] **Step 1: Failing tests** — append to `engine/templates.test.cjs`:

```js
test('the review skill routes agents by plan tier and degrades safely', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  assert.ok(skill.includes('agent-review:reviewer-'), 'launch table must select tier subagent types');
  assert.ok(!skill.includes('or `opus` when `risk.level`'), 'the blanket smart→opus escalation must be gone');
  assert.ok(!skill.includes('MODEL_OVERRIDE'), 'mode overrides are engine-resolved now — no model prose logic');
  assert.ok(skill.includes('routing degraded'), 'unknown subagent type must fall back with a report note');
  assert.ok(skill.includes('plan.mode.resolved') || skill.includes('mode.resolved'), 'auto resolution comes from the plan');
});

test('a score-0 skip posts a deterministic pass status', () => {
  const skill = readFileSync(join(ROOT, 'skills/review/SKILL.md'), 'utf8');
  const skip = skill.slice(skill.indexOf('skip note'), skill.indexOf('skip note') + 2500);
  assert.ok(/agent-review-status/.test(skip), 'the skip path must stage a status marker');
  assert.ok(/"pass":\s*true|pass:true|"pass":true/.test(skip), 'skip status must be pass:true with zero blockers');
});
```

- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Edit SKILL.md:**
  - Auto-mode block: delete the score→tier case logic and `MODEL_OVERRIDE` entirely; read `RESOLVED=$(node -e '...plan.mode.resolved...')` from `/tmp/review_plan.json` (plan is now invoked with `--mode "$MODE"`).
  - Launch table: `subagent_type: "agent-review:reviewer-<tier>"` where `<tier>` is the agent's `tier` from the plan. Delete the model bullet and its escalation sentence.
  - Stage 0 smoke test (after config validate): launch one Task with `subagent_type: "agent-review:reviewer-haiku"`, prompt `Reply with exactly: OK`. On error/unknown type: `export ROUTING="degraded"`; the launch table then uses `general-purpose` for every agent and Stage 6 adds the line `⚠️ routing degraded — ran on the default model` inside `Review detail & stats`.
  - Skip path: the skip note block additionally writes `/tmp/agent_review_status.json` as `{"v":1,"head":"$HEAD_REF","risk":"NONE","openBlockers":0,"pass":true,"irreversible":false,"irreversibleReasons":[],"ci":null}` (the posting step's existing `[ -s ... ]` guard then embeds the status marker automatically — verify by reading the posting block, and state in the skip text that the review passed with nothing to review).
- [ ] **Step 4: Suite green.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: tier-routed agent launches, degrade-safe smoke test, deterministic skip pass"`

### Task 5: version 0.4.0

**Files:**
- Modify: `.claude-plugin/plugin.json`, `package.json`, three `templates/workflows/*.yml` markers, `templates/workflows/template-manifest.json`

- [ ] **Step 1:** bump versions to `0.4.0` in plugin.json + package.json; sed the three markers; `npm run stamp-templates`.
- [ ] **Step 2:** `npm test` green (version-sync test enforces completeness).
- [ ] **Step 3: Commit** — `git add -A && git commit -m "chore: release 0.4.0 — model routing"`

### Task 6: live verification (controller-run)

- [ ] **Step 1:** `npm test` full suite; `npm run check-dist` clean.
- [ ] **Step 2:** `caffeinate -dims npm run test:e2e -- --keep` on AC power — PASS required; then grep the transcript for the smoke test (`reviewer-haiku`) and record whether routing worked or degraded under `--plugin-dir` locally (either is acceptable locally; the CI canary is authoritative).
- [ ] **Step 3:** Push, open the PR (base main) summarizing: routing mechanism (Task tool model param does not exist — tier agents via subagent_type), engine resolution, degrade-safety, skip-pass status, 0.4.0.
- [ ] **Step 4 (post-merge, with the user):** trigger a review on a LOW/MEDIUM mpdx PR and read `modelUsage` from the transcript artifact — **the phase gate is modelUsage showing more than one model** (first proof routing ever worked). If it shows only the main model, the smoke test's degraded path should be visible in the report — either way we learn the truth cheaply.
