'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, resolveMode } = require('./plan.cjs');
const { resolveTiers } = require('./resolveTiers.cjs');

const config = {
  profile: 'standard',
  excluded_paths: ['**/*.snap'],
  risk: {
    patterns: [
      { glob: 'src/components/**/*.{ts,tsx}', points: 1, tier: 'medium' },
    ],
    volume_multiplier: [
      { upTo: 50, points: 0 },
      { upTo: null, points: 4 },
    ],
    scope_multiplier: { single_feature: 1.0 },
    special: [],
    levels: [
      { range: [0, 3], level: 'LOW', reviewer: 'entry' },
      { range: [4, null], level: 'HIGH', reviewer: 'exp' },
    ],
  },
  agents: [
    { id: 'architecture', always: true, rules: ['rules/architecture.md'] },
    {
      id: 'ux',
      triggers: { paths: ['src/components/**/*.tsx'] },
      rules: ['rules/ux.md'],
    },
  ],
  path_rules: [{ paths: ['src/components/**/*.tsx'], rules: ['rules/ux.md'] }],
};

test('buildPlan assembles risk + agents + resolved rules', () => {
  const plan = buildPlan(
    {
      files: ['src/components/Tasks/TaskRow.tsx'],
      diffText: '+x',
      linesChanged: 20,
      scope: 'single_feature',
    },
    config,
  );
  assert.equal(plan.profile, 'standard');
  assert.equal(plan.risk.level, 'LOW');
  const ux = plan.agents.find((a) => a.id === 'ux');
  assert.ok(ux, 'ux selected');
  assert.deepEqual(ux.rules, ['rules/ux.md']);
  const arch = plan.agents.find((a) => a.id === 'architecture');
  // path_rules attach to any selected agent (per design spec §4.4): the changed
  // .tsx file matches the path_rule, so architecture also resolves rules/ux.md.
  assert.deepEqual(arch.rules, ['rules/architecture.md', 'rules/ux.md']);
});

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
  // Same fixture path as "buildPlan assembles risk + agents + resolved rules":
  // a single .tsx change scores LOW (non-zero), so auto resolves to quick.
  const plan = buildPlan(
    {
      files: ['src/components/Tasks/TaskRow.tsx'],
      diffText: '+x',
      linesChanged: 20,
      scope: 'single_feature',
      mode: 'auto',
    },
    config,
  );
  assert.equal(plan.risk.level, 'LOW');
  assert.notEqual(plan.risk.score, 0);
  assert.deepEqual(plan.mode, { requested: 'auto', resolved: 'quick' });
  assert.ok(plan.agents.length > 0, 'agents selected');
  for (const a of plan.agents) {
    assert.ok(
      ['opus', 'sonnet', 'haiku'].includes(a.tier),
      `agent ${a.id} has a valid tier, got ${a.tier}`,
    );
  }
});

test('resolveTiers: an explicit model always wins, even in quick mode', () => {
  const explicit = resolveTiers({
    agents: [{ id: 'perf', model: 'opus', escalates: false }],
    riskLevel: 'LOW',
    mode: 'quick',
  });
  assert.equal(explicit[0].tier, 'opus', 'explicit model is never downgraded by quick mode');

  const smart = resolveTiers({
    agents: [{ id: 'standards', model: 'smart', escalates: false }],
    riskLevel: 'LOW',
    mode: 'quick',
  });
  assert.equal(smart[0].tier, 'haiku', 'quick mode still downgrades non-escalating smart lanes');
});

test('resolveTiers matrix: deep mode adds nothing beyond escalation; MEDIUM risk never escalates', () => {
  const deepLow = resolveTiers({
    agents: [{ id: 'security', model: 'smart', escalates: true }],
    riskLevel: 'LOW',
    mode: 'deep',
  });
  assert.equal(deepLow[0].tier, 'sonnet', 'deep mode does not itself force opus on LOW risk');

  const mediumEscalating = resolveTiers({
    agents: [{ id: 'security', model: 'smart', escalates: true }],
    riskLevel: 'MEDIUM',
    mode: 'standard',
  });
  assert.equal(mediumEscalating[0].tier, 'sonnet', 'escalation requires HIGH/CRITICAL risk, not just escalates:true');
});

test('resolveMode maps risk score/level to a resolved mode under auto', () => {
  assert.equal(resolveMode('auto', { score: 0, level: 'LOW' }), 'skip');
  assert.equal(resolveMode('auto', { score: 5, level: 'MEDIUM' }), 'standard');
  assert.equal(resolveMode('auto', { score: 8, level: 'HIGH' }), 'standard');
  assert.equal(resolveMode('auto', { score: 12, level: 'CRITICAL' }), 'deep');
});
