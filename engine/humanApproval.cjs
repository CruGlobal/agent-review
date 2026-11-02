'use strict';
const { parse } = require('yaml');
const { minimatch } = require('minimatch');

const LABEL = 'needs-human-approval';
const CONFIG_PATH = '.claude/review/config.yml';
const OPTS = { dot: true };

// Reads only `human_approval` so keys from other schema versions never block the check.
// An absent block means no rules; a malformed one throws, and callers must not approve on a throw.
function readBlock(configText) {
  if (configText === null || configText === undefined || configText.trim() === '') return null;
  const doc = parse(configText);
  if (doc === null || doc === undefined) return null;
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('config must be a mapping');
  const block = doc.human_approval;
  if (block === undefined) return null;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('human_approval must be a mapping');
  }
  for (const key of Object.keys(block)) {
    if (key !== 'always' && key !== 'paths') throw new Error(`human_approval has unknown key: ${key}`);
  }
  if (block.always !== undefined && typeof block.always !== 'boolean') {
    throw new Error('human_approval.always must be a boolean');
  }
  if (
    block.paths !== undefined &&
    !(Array.isArray(block.paths) && block.paths.every((p) => typeof p === 'string'))
  ) {
    throw new Error('human_approval.paths must be an array of strings');
  }
  return { always: block.always === true, paths: block.paths || [] };
}

// `files` must hold both sides of a rename so a move out of a PCI path still matches.
// `incomplete` marks a partial list, which cannot prove that no rule matches, so it
// throws when the config sets any rule; with no rules the list does not matter.
function humanRules(configText, files, { incomplete = false } = {}) {
  const rules = readBlock(configText);
  if (!rules) return { required: false, reasons: [] };
  const hasRules = rules.always || rules.paths.length > 0;
  if (incomplete && hasRules) throw new Error("the PR's file list is incomplete");
  const reasons = [];
  if (rules.always) reasons.push('every PR in this repo needs a person (human_approval.always)');
  const hits = [...new Set(files)]
    .filter((f) => rules.paths.some((g) => minimatch(f, g, OPTS)))
    .sort();
  for (const f of hits) reasons.push(`PCI path: ${f}`);
  if (files.includes(CONFIG_PATH) && hasRules) {
    reasons.push('changes the human_approval config');
  }
  return { required: reasons.length > 0, reasons };
}

module.exports = { humanRules, LABEL };
