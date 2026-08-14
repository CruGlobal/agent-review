'use strict';
const { readFileSync, existsSync, statSync } = require('node:fs');
const { dirname, resolve, relative } = require('node:path');
const { parse } = require('yaml');
const Ajv = require('ajv/dist/2020');
const { upgradeConfig } = require('./upgradeConfig.cjs');

function parseConfig(yamlText) {
  return parse(yamlText);
}

function validateConfig(configObj, schemaObj) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schemaObj);
  const valid = validate(configObj);
  const errors = valid
    ? []
    : (validate.errors || []).map(
        (e) => `${e.instancePath || '(root)'} ${e.message}`,
      );
  return { valid, errors };
}

function validateConfigReferences(configObj, configPath) {
  const errors = [];
  const ids = new Set();
  for (const agent of configObj.agents || []) {
    if (ids.has(agent.id)) errors.push(`duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }

  const base = dirname(resolve(configPath));
  const references = [];
  for (const agent of configObj.agents || []) {
    for (const rule of agent.rules || []) {
      references.push({ owner: `agent ${agent.id}`, rule });
    }
  }
  for (const [index, pathRule] of (configObj.path_rules || []).entries()) {
    for (const rule of pathRule.rules || []) {
      references.push({ owner: `path_rules[${index}]`, rule });
    }
  }

  for (const { owner, rule } of references) {
    const target = resolve(base, rule);
    const rel = relative(base, target);
    if (rel.startsWith('..') || rel === '') {
      errors.push(`${owner} rule escapes the review directory: ${rule}`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${owner} references missing rule file: ${rule}`);
    }
  }
  return errors;
}

function loadConfig({ configPath, schemaPath }) {
  const configObj = parseConfig(readFileSync(configPath, 'utf8'));
  const schemaObj = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const { valid, errors } = validateConfig(configObj, schemaObj);
  if (!valid) {
    throw new Error(
      `Invalid review config (${configPath}):\n- ${errors.join('\n- ')}`,
    );
  }
  const referenceErrors = validateConfigReferences(configObj, configPath);
  if (referenceErrors.length) {
    throw new Error(
      `Invalid review config (${configPath}):\n- ${referenceErrors.join('\n- ')}`,
    );
  }
  return upgradeConfig(configObj);
}

module.exports = {
  parseConfig,
  validateConfig,
  validateConfigReferences,
  loadConfig,
};
