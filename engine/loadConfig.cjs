'use strict';
const { readFileSync, existsSync, statSync } = require('node:fs');
const { dirname, resolve, relative } = require('node:path');
const { parse } = require('yaml');
const Ajv = require('ajv/dist/2020');
const { upgradeConfig } = require('./upgradeConfig.cjs');
const { validateContextManifest } = require('./contextPack.cjs');

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

  const extraFiles = [];
  const astConfig = configObj.static_analysis && configObj.static_analysis.ast_grep;
  if (astConfig && astConfig.enabled) {
    if (!astConfig.config) errors.push('static_analysis.ast_grep.enabled requires config');
    else extraFiles.push({ owner: 'static_analysis.ast_grep', path: astConfig.config, astGrep: true });
    if (!astConfig.version) errors.push('static_analysis.ast_grep.enabled requires a pinned version');
  }
  const context = configObj.context;
  if (context && context.enabled) {
    if (!context.manifest) errors.push('context.enabled requires manifest');
    else extraFiles.push({ owner: 'context', path: context.manifest, contextManifest: true });
  }
  for (const item of extraFiles) {
    const target = resolve(base, item.path);
    const rel = relative(base, target);
    if (rel.startsWith('..') || rel === '') {
      errors.push(`${item.owner} path escapes the review directory: ${item.path}`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${item.owner} references missing file: ${item.path}`);
      continue;
    }
    if (item.contextManifest) {
      try {
        validateContextManifest(JSON.parse(readFileSync(target, 'utf8')));
      } catch (e) {
        errors.push(`${item.owner} manifest is invalid: ${e.message}`);
      }
    }
    if (item.astGrep) {
      try {
        const sg = parse(readFileSync(target, 'utf8')) || {};
        if (!Array.isArray(sg.ruleDirs) || sg.ruleDirs.length === 0) {
          errors.push(`${item.owner} config requires ruleDirs`);
        }
        if (!Array.isArray(sg.testConfigs) || sg.testConfigs.length === 0) {
          errors.push(`${item.owner} config requires testConfigs`);
        }
        for (const dir of [
          ...(sg.ruleDirs || []),
          ...(sg.testConfigs || []).map((t) => t && t.testDir).filter(Boolean),
        ]) {
          const child = resolve(dirname(target), dir);
          if (!existsSync(child) || !statSync(child).isDirectory()) {
            errors.push(`${item.owner} references missing directory: ${dir}`);
          }
        }
      } catch (e) {
        errors.push(`${item.owner} config is invalid: ${e.message}`);
      }
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
