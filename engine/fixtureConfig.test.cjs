'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { parse } = require('yaml');
const { loadConfig } = require('./loadConfig.cjs');

const configPath = path.join(__dirname, '../fixtures/wealthtracker/config.yml');
const schemaPath = path.join(__dirname, '../schema/config.schema.json');

test('real config.yml loads and validates', () => {
  const raw = parse(readFileSync(configPath, 'utf8'));
  assert.equal(raw.version, 1);

  const cfg = loadConfig({ configPath, schemaPath });
  assert.equal(cfg.version, 2);
});

test('wealthtracker fixture config defines its 7 agents', () => {
  const cfg = loadConfig({ configPath, schemaPath });
  assert.deepEqual(cfg.agents.map((a) => a.id).sort(), [
    'architecture',
    'data-integrity',
    'financial',
    'security',
    'standards',
    'testing',
    'ux',
  ]);
});

test('real config enables the index layer and reserves inert learning', () => {
  const cfg = loadConfig({ configPath, schemaPath });
  assert.equal(cfg.index.enabled, true);
  assert.equal(cfg.index.path, '.claude/review/index');
  assert.equal(cfg.learning.enabled, true);
  assert.equal(cfg.learning.approval_required, true);
  assert.equal(cfg.learning.min_support, 3);
});
