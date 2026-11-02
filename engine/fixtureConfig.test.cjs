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

test('the config template loads with its human_approval example uncommented', () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const tpl = readFileSync(path.join(__dirname, '../templates/config.yml'), 'utf8');
  const lines = tpl.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# human_approval:'));
  assert.ok(start >= 0, 'the template has the example');
  let end = start + 1;
  while (end < lines.length && /^#   /.test(lines[end])) end++;
  const block = lines.slice(start, end).map((l) => l.replace(/^# ?/, ''));
  const body = [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-template-'));
  const file = path.join(dir, 'config.yml');
  writeFileSync(file, body);
  mkdirSync(path.join(dir, 'rules'));
  for (const r of ['security', 'architecture', 'data-integrity', 'testing', 'standards', 'simplification']) writeFileSync(path.join(dir, 'rules', `${r}.md`), '# rules\n');
  const cfg = loadConfig({ configPath: file, schemaPath });
  assert.equal(typeof cfg.human_approval.always, 'boolean');
  assert.ok(Array.isArray(cfg.human_approval.paths) && cfg.human_approval.paths.length > 0);
});
