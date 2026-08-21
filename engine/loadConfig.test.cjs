'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { stringify } = require('yaml');
const {
  parseConfig,
  validateConfig,
  validateConfigReferences,
  loadConfig,
} = require('./loadConfig.cjs');
const schema = require('../schema/config.schema.json');
const schemaPath = join(__dirname, '..', 'schema', 'config.schema.json');

const MINIMAL = `
version: 1
profile: standard
risk:
  patterns: [{ glob: "src/**", points: 1, tier: medium }]
  volume_multiplier: [{ upTo: null, points: 0 }]
  scope_multiplier: { single_feature: 1.0 }
  special: []
  levels: [{ range: [0, null], level: LOW, reviewer: entry }]
agents: [{ id: standards, always: true }]
excluded_paths: []
`;

test('parseConfig parses YAML to an object', () => {
  const cfg = parseConfig(MINIMAL);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.agents[0].id, 'standards');
});

test('validateConfig accepts a valid config', () => {
  const { valid, errors } = validateConfig(parseConfig(MINIMAL), schema);
  assert.equal(valid, true, errors.join('; '));
});

test('validateConfig rejects a bad profile enum', () => {
  const bad = parseConfig(
    MINIMAL.replace('profile: standard', 'profile: nope'),
  );
  const { valid, errors } = validateConfig(bad, schema);
  assert.equal(valid, false);
  assert.ok(
    errors.some((e) => e.includes('profile')),
    errors.join('; '),
  );
});

test('reference validation rejects missing rule docs and duplicate agent ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-config-'));
  const reviewDir = join(root, '.claude/review');
  mkdirSync(join(reviewDir, 'rules'), { recursive: true });
  writeFileSync(join(reviewDir, 'rules/present.md'), '# Present\n');
  const cfg = parseConfig(MINIMAL);
  cfg.agents = [
    { id: 'standards', rules: ['rules/present.md'] },
    { id: 'standards', rules: ['rules/missing.md'] },
  ];
  const errors = validateConfigReferences(cfg, join(reviewDir, 'config.yml'));
  assert.ok(errors.some((e) => e.includes('duplicate agent id: standards')));
  assert.ok(errors.some((e) => e.includes('missing rule file: rules/missing.md')));
});

test('reference validation accepts existing agent and path rule docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-config-'));
  const reviewDir = join(root, '.claude/review');
  mkdirSync(join(reviewDir, 'rules'), { recursive: true });
  writeFileSync(join(reviewDir, 'rules/present.md'), '# Present\n');
  const cfg = parseConfig(MINIMAL);
  cfg.agents[0].rules = ['rules/present.md'];
  cfg.path_rules = [{ paths: ['src/**'], rules: ['rules/present.md'] }];
  assert.deepEqual(
    validateConfigReferences(cfg, join(reviewDir, 'config.yml')),
    [],
  );
});

test('reference validation checks enabled static analysis and context assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-config-'));
  const reviewDir = join(root, '.claude/review');
  mkdirSync(join(reviewDir, 'static/rules'), { recursive: true });
  mkdirSync(join(reviewDir, 'static/rule-tests'), { recursive: true });
  mkdirSync(join(reviewDir, 'context'), { recursive: true });
  writeFileSync(join(reviewDir, 'static/sgconfig.yml'), 'ruleDirs: [rules]\ntestConfigs: [{ testDir: rule-tests }]\n');
  writeFileSync(join(reviewDir, 'context/repos.json'), JSON.stringify({
    version: 1,
    repositories: [{ id: 'client', repository: 'Org/client', ref: 'a'.repeat(40), paths: ['src/**'] }],
  }));
  const cfg = parseConfig(MINIMAL);
  cfg.static_analysis = { ast_grep: { enabled: true, config: 'static/sgconfig.yml', version: '0.45.0' } };
  cfg.context = { enabled: true, manifest: 'context/repos.json' };
  assert.deepEqual(validateConfigReferences(cfg, join(reviewDir, 'config.yml')), []);

  delete cfg.static_analysis.ast_grep.version;
  assert.match(
    validateConfigReferences(cfg, join(reviewDir, 'config.yml')).join('\n'),
    /requires a pinned version/,
  );
  cfg.static_analysis.ast_grep.version = '0.45.0';

  writeFileSync(join(reviewDir, 'static/sgconfig.yml'), 'ruleDirs: [missing]\n');
  const errors = validateConfigReferences(cfg, join(reviewDir, 'config.yml'));
  assert.ok(errors.some((e) => e.includes('requires testConfigs')));
  assert.ok(errors.some((e) => e.includes('missing directory: missing')));
});

// Builds a full, schema-valid v2 config from `{ agents: [...] }` (plus any
// other top-level overrides), writes it to a temp review dir, and runs it
// through the real loadConfig() pipeline (validate -> upgrade -> normalize).
// Agent fixtures may nest `always: true` under `triggers` for brevity — that
// is hoisted to the real top-level `agents[].always` field before writing,
// since the schema only recognizes it there; `triggers.specials` (an array of
// special-pattern names) is left as-is.
function adaptAgentFixture(agent) {
  const { triggers, ...rest } = agent;
  if (!triggers) return agent;
  const { always, ...restTriggers } = triggers;
  const adapted = { ...rest };
  if (always) adapted.always = true;
  if (Object.keys(restTriggers).length) adapted.triggers = restTriggers;
  return adapted;
}

function loadFixtureWith(overrides) {
  const cfg = {
    version: 2,
    profile: 'standard',
    risk: {
      patterns: [{ glob: 'src/**', points: 1, tier: 'medium' }],
      volume_multiplier: [{ upTo: null, points: 0 }],
      scope_multiplier: { single_feature: 1.0 },
      special: [],
      levels: [{ range: [0, null], level: 'LOW', reviewer: 'entry' }],
    },
    agents: [],
    excluded_paths: [],
    ...overrides,
  };
  if (overrides.agents) cfg.agents = overrides.agents.map(adaptAgentFixture);

  const root = mkdtempSync(join(tmpdir(), 'agent-review-config-'));
  const reviewDir = join(root, '.claude/review');
  mkdirSync(reviewDir, { recursive: true });
  const configPath = join(reviewDir, 'config.yml');
  writeFileSync(configPath, stringify(cfg));
  return loadConfig({ configPath, schemaPath });
}

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

test('schema rejects a typo\'d triggers.specials value', () => {
  // triggers.specials is a closed vocabulary (same enum as risk.special[].when) —
  // a typo like 'migraton_change' must fail validation, not silently resolve
  // the escalates fallback to false.
  assert.throws(() => {
    loadFixtureWith({ agents: [
      { id: 'database', triggers: { specials: ['migraton_change'] } },
    ]});
  }, /Invalid review config/);
});

test('escalates fallback warns exactly once; named-lane path never warns', () => {
  const calls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { calls.push(args); };
  try {
    loadFixtureWith({ agents: [
      { id: 'security', triggers: { always: true } },
      { id: 'ux', triggers: { always: true } },
    ]});
    assert.equal(calls.length, 0, 'a config with a named lane must not warn');

    calls.length = 0;
    loadFixtureWith({ agents: [
      { id: 'database', triggers: { specials: ['migration_change'] } },
      { id: 'style', triggers: { always: true } },
    ]});
    assert.equal(calls.length, 1, 'the no-named-lane fallback must warn exactly once');
  } finally {
    console.warn = originalWarn;
  }
});
