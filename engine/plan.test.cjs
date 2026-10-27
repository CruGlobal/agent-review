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

test('plan agents carry their config triggers verbatim', () => {
  const plan = buildPlan(
    {
      files: ['src/components/Tasks/TaskRow.tsx'],
      diffText: '+x',
      linesChanged: 20,
      scope: 'single_feature',
    },
    config,
  );
  assert.ok(plan.agents.every((a) => 'triggers' in a));
  const ux = plan.agents.find((a) => a.id === 'ux');
  assert.deepEqual(ux.triggers, { paths: ['src/components/**/*.tsx'] });
  const arch = plan.agents.find((a) => a.id === 'architecture');
  // architecture has no `triggers` in config (it's an always-on lane) — the
  // key must still be present, just carrying the config's undefined verbatim.
  assert.equal(arch.triggers, undefined);
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

const crConfig = {
  ...config,
  agents: [
    { id: 'architecture', always: true, escalates: true, rules: ['rules/architecture.md'] },
    { id: 'simplification', escalates: false, rules: ['rules/simplification.md', 'rules/architecture.md'] },
    { id: 'testing', always: true, rules: ['rules/testing.md'] },
    { id: 'security', escalates: true, triggers: {}, rules: ['rules/security.md'] },
    { id: 'data-integrity', triggers: { paths: ['db/**'] }, rules: ['rules/data.md'] },
    { id: 'financial', triggers: { paths: ['src/money/**'] }, rules: ['rules/fin.md'] },
    { id: 'standards', escalates: false, rules: ['rules/standards.md'] },
  ],
  path_rules: [],
};

function crOptions(over = {}) {
  return {
    mode: { value: 'standard', source: 'default' },
    engine: { value: 'code-review', source: 'arg' },
    effort: { value: 'high', source: 'default' },
    model: { value: 'opus', source: 'default' },
    maxFindings: null,
    replaces: ['architecture', 'simplification'],
    always: ['security', 'testing'],
    reviewsRun: { value: 1, source: 'default' },
    incremental: false,
    ci: false,
    notes: [],
    ...over,
  };
}

const crInput = {
  files: ['src/other/a.ts'],
  diffText: '+x',
  linesChanged: 20,
  scope: 'single_feature',
};

test('default engine plans are unchanged', () => {
  const base = buildPlan(crInput, crConfig);
  const withOpts = buildPlan(
    { ...crInput, options: crOptions({ engine: { value: 'agent-review', source: 'default' } }) },
    crConfig,
  );
  assert.deepEqual(withOpts, base);
  assert.equal('engine' in base, false);
});

test('code-review: replaced lanes never run', () => {
  const plan = buildPlan({ ...crInput, options: crOptions() }, crConfig);
  const ids = plan.agents.map((a) => a.id);
  assert.ok(!ids.includes('architecture'));
  assert.ok(!ids.includes('simplification'));
  const noEsc = {
    ...crConfig,
    agents: crConfig.agents.map((a) => ({ ...a, escalates: false })),
  };
  const p2 = buildPlan({ ...crInput, options: crOptions() }, noEsc);
  assert.ok(!p2.agents.some((a) => a.id === 'architecture' || a.id === 'simplification'));
});

test('code-review: always lanes are forced', () => {
  const plan = buildPlan({ ...crInput, options: crOptions() }, crConfig);
  const sec = plan.agents.find((a) => a.id === 'security');
  assert.equal(sec.always, true);
  assert.equal(sec.matchedBy, 'engine-always');
  const testing = plan.agents.find((a) => a.id === 'testing');
  assert.equal(testing.always, true);
  assert.equal(testing.matchedBy, 'always');
});

test('code-review: trigger lanes keep their triggers', () => {
  const none = buildPlan({ ...crInput, options: crOptions() }, crConfig);
  assert.ok(!none.agents.some((a) => a.id === 'data-integrity' || a.id === 'financial'));
  const hit = buildPlan(
    { ...crInput, files: ['db/x.sql', 'src/money/a.ts'], options: crOptions() },
    crConfig,
  );
  assert.ok(hit.agents.some((a) => a.id === 'data-integrity'));
  assert.ok(hit.agents.some((a) => a.id === 'financial'));
});

test('code-review: synthetic lane', () => {
  const plan = buildPlan({ ...crInput, options: crOptions() }, crConfig);
  const lane = plan.agents[0];
  assert.equal(lane.id, 'code-review');
  assert.equal(lane.tier, 'opus');
  assert.equal(lane.model, 'opus');
  assert.equal(lane.matchedBy, 'engine');
  assert.equal(lane.always, true);
  assert.equal(lane.escalates, false);
  assert.deepEqual(lane.rules, ['rules/architecture.md', 'rules/simplification.md']);
  assert.deepEqual(plan.engine, {
    name: 'code-review',
    effort: 'high',
    model: 'opus',
    maxFindings: null,
    replaces: ['architecture', 'simplification'],
    always: ['security', 'testing'],
  });
});

test('code-review: quick mode keeps the lane list', () => {
  const std = buildPlan({ ...crInput, options: crOptions() }, crConfig);
  const quick = buildPlan({ ...crInput, mode: 'quick', options: crOptions() }, crConfig);
  assert.deepEqual(quick.agents.map((a) => a.id), std.agents.map((a) => a.id));
  assert.equal(quick.agents[0].tier, 'opus');
  for (const a of quick.agents.slice(1)) {
    if (!a.escalates && a.model === 'smart') assert.equal(a.tier, 'haiku');
  }
});

test('code-review: path_rules reach the lane, even with nothing replaced', () => {
  const cfg = { ...crConfig, path_rules: [{ paths: ['src/other/**'], rules: ['rules/other.md'] }] };
  const none = buildPlan({ ...crInput, options: crOptions({ replaces: [] }) }, cfg);
  assert.equal(none.agents[0].id, 'code-review');
  assert.deepEqual(none.agents[0].rules, ['rules/other.md']);

  const replaced = buildPlan({ ...crInput, options: crOptions() }, cfg);
  assert.deepEqual(
    replaced.agents[0].rules,
    ['rules/other.md', 'rules/architecture.md', 'rules/simplification.md'],
    'deduplicated, in first-seen order',
  );

  const unmatched = buildPlan({ ...crInput, files: ['lib/a.ts'], options: crOptions({ replaces: [] }) }, cfg);
  assert.deepEqual(unmatched.agents[0].rules, [], 'a path rule applies only when a changed file matches');
});

test('code-review: a disabled replaced lane lends the lane no rules', () => {
  const cfg = {
    ...crConfig,
    agents: crConfig.agents.map((a) => (a.id === 'simplification' ? { ...a, enabled: false } : a)),
  };
  const plan = buildPlan({ ...crInput, options: crOptions() }, cfg);
  assert.deepEqual(plan.agents[0].rules, ['rules/architecture.md']);
});
