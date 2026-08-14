'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const {
  parseConfig,
  validateConfig,
  validateConfigReferences,
} = require('./loadConfig.cjs');
const schema = require('../schema/config.schema.json');

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
