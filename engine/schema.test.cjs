'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Schema uses the JSON Schema draft 2020-12 dialect; Ajv's 2020 entry point
// ships that meta-schema (the default `ajv` export only knows draft-07).
const Ajv = require('ajv/dist/2020').default || require('ajv/dist/2020');
const schema = require('../schema/config.schema.json');

test('config.schema.json is a valid, compilable JSON Schema', () => {
  const validate = new Ajv({ allErrors: true }).compile(schema); // throws if malformed
  assert.equal(typeof validate, 'function');
});

const ENGINE_CFG = {
  engine: {
    name: 'code-review',
    code_review: {
      effort: 'xhigh',
      model: 'opus',
      replaces: ['architecture', 'simplification'],
      always: ['security', 'testing', 'standards'],
      max_findings: 15,
    },
  },
  reviews_run: 'local',
};

function validateWith(extra) {
  const { parseConfig } = require('./loadConfig.cjs');
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const base = parseConfig(readFileSync(join(__dirname, '..', 'templates', 'config.yml'), 'utf8'));
  delete base.engine;
  delete base.reviews_run;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  return validate({ ...base, ...extra });
}

test('schema accepts the engine block and reviews_run', () => {
  assert.equal(validateWith(ENGINE_CFG), true);
  const all = structuredClone(ENGINE_CFG);
  all.engine.code_review.max_findings = 'all';
  assert.equal(validateWith(all), true);
});

test('schema rejects bad engine values', () => {
  const mutate = (fn) => {
    const c = structuredClone(ENGINE_CFG);
    fn(c);
    return c;
  };
  const bad = [
    mutate((c) => { c.engine.name = 'lanes'; }),
    mutate((c) => { c.engine.code_review.effort = 'extreme'; }),
    mutate((c) => { c.engine.code_review.model = 'gpt'; }),
    mutate((c) => { c.engine.code_review.max_findings = 0; }),
    mutate((c) => { c.reviews_run = 'ci'; }),
    mutate((c) => { c.engine.code_review.bogus = true; }),
  ];
  for (const cfg of bad) assert.equal(validateWith(cfg), false, JSON.stringify(cfg));
});

test('engine enums in the schema match the shared vocabulary', () => {
  const { ENGINES, EFFORTS } = require('./vocabulary.cjs');
  const props = schema.properties.engine.properties;
  assert.deepEqual(props.name.enum, ENGINES);
  assert.deepEqual(props.code_review.properties.effort.enum, EFFORTS);
});
