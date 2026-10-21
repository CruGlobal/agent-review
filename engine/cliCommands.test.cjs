'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  setLearningStatus,
  listLearnings,
  preflightSummary,
  formatStartup,
} = require('./cliCommands.cjs');

const learnings = {
  version: 1,
  learnings: [
    {
      id: 'L-a',
      kind: 'suppress',
      status: 'proposed',
      support: 3,
      paths: ['src/**'],
      example: 'x',
      rationale: 'Dismissed 3/3 times',
    },
    {
      id: 'L-b',
      kind: 'rule',
      status: 'approved',
      support: 4,
      paths: ['pages/**'],
      ruleText: 'y',
      rationale: 'Accepted 4/4 times',
    },
  ],
};

test('setLearningStatus flips target, preserves others, no mutation', () => {
  const updated = setLearningStatus(learnings, 'L-a', 'approved');
  assert.equal(
    updated.learnings.find((l) => l.id === 'L-a').status,
    'approved',
  );
  assert.equal(
    updated.learnings.find((l) => l.id === 'L-b').status,
    'approved',
  );
  assert.equal(learnings.learnings[0].status, 'proposed'); // original untouched
});

test('setLearningStatus throws on unknown id', () => {
  assert.throws(
    () => setLearningStatus(learnings, 'nope', 'approved'),
    /not found/,
  );
});

test('listLearnings filters by status', () => {
  assert.deepEqual(
    listLearnings(learnings, 'approved').map((r) => r.id),
    ['L-b'],
  );
  assert.equal(listLearnings(learnings).length, 2);
});

test('listLearnings projects rationale and ruleText alongside example', () => {
  const [suppress, rule] = listLearnings(learnings);
  assert.deepEqual(suppress, {
    id: 'L-a',
    kind: 'suppress',
    status: 'proposed',
    support: 3,
    paths: ['src/**'],
    example: 'x',
    ruleText: '',
    rationale: 'Dismissed 3/3 times',
  });
  assert.deepEqual(rule, {
    id: 'L-b',
    kind: 'rule',
    status: 'approved',
    support: 4,
    paths: ['pages/**'],
    example: 'y', // falls back to ruleText for compatibility
    ruleText: 'y',
    rationale: 'Accepted 4/4 times',
  });
});

test('preflightSummary includes risk, reviewer, agents, blast radius', () => {
  const plan = {
    profile: 'standard',
    risk: { score: 46, level: 'CRITICAL', reviewer: 'Caleb Cox', special: [] },
    // mode is a genuine buildPlan contract field — always emitted (see engine/plan.cjs).
    mode: { requested: 'standard', resolved: 'standard' },
    agents: [{ id: 'financial', matchedBy: 'path:src/components/HrTools/**' }],
  };
  const impact = {
    blastRadius: 166,
    truncated: false,
    topImpacted: [{ file: 'src/x.tsx', dependentCount: 29 }],
  };
  const s = preflightSummary(plan, impact);
  assert.match(s, /CRITICAL/);
  assert.match(s, /Caleb Cox/);
  assert.match(s, /financial/);
  assert.match(s, /blastRadius 166/);
  assert.match(s, /mode: standard/);
});

function startupInput(over = {}) {
  return {
    options: {
      mode: { value: 'auto', source: 'default' },
      engine: { value: 'code-review', source: 'config' },
      effort: { value: 'xhigh', source: 'default' },
      model: { value: 'opus', source: 'default' },
      reviewsRun: { value: 'both', source: 'default' },
      replaces: ['architecture', 'simplification'],
      notes: [],
    },
    plan: {
      mode: { requested: 'auto', resolved: 'standard' },
      engine: { replaces: ['architecture', 'simplification'] },
      agents: [
        { id: 'code-review', matchedBy: 'engine' },
        { id: 'security', matchedBy: 'engine-always' },
        { id: 'testing', matchedBy: 'always' },
        { id: 'standards', matchedBy: 'engine-always' },
      ],
    },
    sliceManifest: {},
    configAgents: [
      { id: 'architecture' },
      { id: 'simplification' },
      { id: 'security' },
      { id: 'testing' },
      { id: 'standards' },
      { id: 'data-integrity' },
      { id: 'off', enabled: false },
    ],
    scopeLabel: 'since a1b2c3d (re-review)',
    ciFilesPresent: false,
    ...over,
  };
}

test('startup: code-review engine', () => {
  const [l1, l2] = formatStartup(startupInput()).split('\n');
  assert.equal(
    l1,
    'agent-review · engine: code-review (config) · effort: xhigh (default) · mode: auto → standard · scope: since a1b2c3d (re-review)',
  );
  assert.equal(
    l2,
    'reviewers: code-review [opus], security [always], testing [always], standards [always], data-integrity [skipped: no trigger matched]',
  );
});

test('startup: default engine omits effort', () => {
  const input = startupInput();
  input.options.engine = { value: 'agent-review', source: 'default' };
  input.options.effort = null;
  input.options.mode = { value: 'standard', source: 'argument' };
  input.plan = {
    mode: { requested: 'standard', resolved: 'standard' },
    agents: [{ id: 'security', matchedBy: 'path:src/**' }],
  };
  input.scopeLabel = undefined;
  const [l1, l2] = formatStartup(input).split('\n');
  assert.equal(
    l1,
    'agent-review · engine: agent-review (default) · mode: standard · scope: full review',
  );
  assert.ok(!l1.includes('effort:'));
  assert.match(l2, /security \[trigger\]/);
  assert.match(l2, /architecture \[skipped: no trigger matched\]/);
});

function defaultEngineInput(resolved) {
  const input = startupInput();
  input.options.engine = { value: 'agent-review', source: 'default' };
  input.options.effort = null;
  input.plan = {
    mode: { requested: resolved, resolved },
    agents: [
      { id: 'security', matchedBy: 'path:src/**' },
      { id: 'testing', matchedBy: 'always' },
      { id: 'standards', matchedBy: 'always' },
      { id: 'architecture', matchedBy: 'always' },
    ],
  };
  return input;
}

const QUICK_NOTE = 'note: quick mode keeps at most 3 of these lanes.';
const DEEP_NOTE = 'note: deep mode also runs every enabled lane listed as skipped.';

test('startup: default engine in quick mode says the 3-lane cap applies', () => {
  const lines = formatStartup(defaultEngineInput('quick')).split('\n');
  assert.ok(lines.includes(QUICK_NOTE));
  assert.ok(!lines.includes(DEEP_NOTE));
});

test('startup: default engine in deep mode says skipped lanes run too', () => {
  const lines = formatStartup(defaultEngineInput('deep')).split('\n');
  assert.ok(lines.includes(DEEP_NOTE));
  assert.ok(!lines.includes(QUICK_NOTE));
});

test('startup: default engine in standard mode adds no mode note', () => {
  const lines = formatStartup(defaultEngineInput('standard')).split('\n');
  assert.ok(!lines.includes(QUICK_NOTE));
  assert.ok(!lines.includes(DEEP_NOTE));
});

test('startup: code-review engine never adds the quick or deep note', () => {
  for (const resolved of ['quick', 'deep']) {
    const input = startupInput();
    input.plan.mode = { requested: resolved, resolved };
    const lines = formatStartup(input).split('\n');
    assert.ok(!lines.includes(QUICK_NOTE), `quick note under code-review in ${resolved}`);
    assert.ok(!lines.includes(DEEP_NOTE), `deep note under code-review in ${resolved}`);
  }
});

const maxFindingsNote = (n) =>
  `note: --max-findings ${n} is passed to /code-review on every run and may change your own remembered /code-review limit.`;

test('startup: code-review engine warns when max_findings is set', () => {
  for (const value of [15, 'all']) {
    const input = startupInput();
    input.options.maxFindings = { value, source: 'config' };
    assert.ok(formatStartup(input).split('\n').includes(maxFindingsNote(value)), `note for ${value}`);
  }
  const unset = startupInput();
  unset.options.maxFindings = null;
  assert.ok(!formatStartup(unset).includes('--max-findings'));
  const other = defaultEngineInput('standard');
  other.options.maxFindings = { value: 15, source: 'config' };
  assert.ok(!formatStartup(other).includes('--max-findings'), 'the agent-review engine never passes the flag');
});

test('startup: empty-slice lanes', () => {
  const input = startupInput({
    sliceManifest: { testing: { mode: 'empty', files: [], hunks: 0 } },
  });
  assert.match(
    formatStartup(input).split('\n')[1],
    /testing \[skipped: no matching hunks\]/,
  );
});

test('startup: coverage lanes', () => {
  const input = startupInput();
  input.plan.agents.push({ id: 'data-integrity', matchedBy: 'unmatched-coverage' });
  assert.match(formatStartup(input).split('\n')[1], /data-integrity \[coverage\]/);
});

test('startup: notes', () => {
  const input = startupInput();
  input.options.notes = ['first', 'second'];
  const lines = formatStartup(input).split('\n');
  assert.deepEqual(lines.slice(2), ['note: first', 'note: second']);
});

test('startup: leftover CI files', () => {
  const input = startupInput({ ciFilesPresent: true });
  input.options.reviewsRun = { value: 'local', source: 'config' };
  assert.ok(
    formatStartup(input)
      .split('\n')
      .includes(
        'note: this repo is local-only but still has CI review workflows, so PRs labeled agent-review still pay for CI reviews. Run /agent-review:update-files to remove them.',
      ),
  );
  const both = startupInput({ ciFilesPresent: true });
  assert.ok(!formatStartup(both).includes('local-only'));
});
