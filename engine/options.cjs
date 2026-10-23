'use strict';

const ENGINES = ['agent-review', 'code-review'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['auto', 'quick', 'standard', 'deep'];

const ENGINE_DEFAULTS = {
  effort: 'xhigh',
  model: 'opus',
  replaces: ['architecture', 'simplification'],
  always: ['security', 'testing', 'standards'],
};

function codeReviewLanes(crCfg) {
  return {
    always: crCfg.always || ENGINE_DEFAULTS.always,
    replaces: crCfg.replaces || ENGINE_DEFAULTS.replaces,
  };
}

function laneOverlapMessage(id, crCfg) {
  const key = (name) => (crCfg[name] ? name : `${name} (default)`);
  return `engine.code_review lists ${id} in both ${key('always')} and ${key('replaces')}`;
}

// Each problem is { id, kind }, where kind is 'unknown', 'disabled', or 'overlap'.
function alwaysLaneProblems(crCfg, agents) {
  const { always, replaces } = codeReviewLanes(crCfg);
  const byId = new Map((agents || []).map((a) => [a.id, a]));
  const problems = [];
  for (const id of always) {
    const agent = byId.get(id);
    if (!agent) problems.push({ id, kind: 'unknown' });
    else if (agent.enabled === false) problems.push({ id, kind: 'disabled' });
    if (replaces.includes(id)) problems.push({ id, kind: 'overlap' });
  }
  return problems;
}

const CI_NOTE =
  "The code-review engine runs locally only; CI ran agent-review's own reviewers, and only the local review can approve.";

function setOnce(state, key, value) {
  if (state[key] != null && state[key] !== value) {
    throw new Error(`conflicting ${key}= values ("${state[key]}" and "${value}")`);
  }
  state[key] = value;
}

function parseReviewArgs(raw) {
  const tokens = String(raw || '').toLowerCase().split(/\s+/).filter(Boolean);
  const state = { mode: null, engine: null, effort: null };
  const parsed = { ci: false, incremental: false, unknown: [] };
  for (const tok of tokens) {
    if (MODES.includes(tok)) setOnce(state, 'mode', tok);
    else if (tok === 'ci') parsed.ci = true;
    else if (tok === 'incremental') parsed.incremental = true;
    else if (/^(engine|effort)=.+$/.test(tok)) {
      const [key, value] = [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)];
      setOnce(state, key, value);
    } else parsed.unknown.push(tok);
  }
  return {
    mode: state.mode,
    ci: parsed.ci,
    incremental: parsed.incremental,
    engine: state.engine,
    effort: state.effort,
    unknown: parsed.unknown,
  };
}

function pick(argValue, configValue, defaultValue) {
  if (argValue != null) return { value: argValue, source: 'argument' };
  if (configValue != null) return { value: configValue, source: 'config' };
  return { value: defaultValue, source: 'default' };
}

function resolveOptions({ args, config, ci }) {
  const parsed = parseReviewArgs(args);
  const cfg = config || {};
  const engineCfg = cfg.engine || {};
  const crCfg = engineCfg.code_review || {};
  const notes = [];

  if (parsed.engine != null && !ENGINES.includes(parsed.engine)) {
    throw new Error(`unknown engine "${parsed.engine}" (use agent-review or code-review)`);
  }
  if (parsed.effort != null && !EFFORTS.includes(parsed.effort)) {
    throw new Error(`unknown effort "${parsed.effort}" (use low, medium, high, xhigh, or max)`);
  }

  const isCi = Boolean(ci) || parsed.ci;
  let engine = pick(parsed.engine, engineCfg.name, 'agent-review');
  if (isCi && engine.value === 'code-review') {
    engine = { value: 'agent-review', source: 'ci' };
    notes.push(CI_NOTE);
  }

  const mode = parsed.mode != null
    ? { value: parsed.mode, source: 'argument' }
    : { value: 'standard', source: 'default' };

  const reviewsRun = pick(null, cfg.reviews_run, 'local-and-ci');

  let effort = null;
  let model = null;
  let maxFindings = null;
  let replaces = [];
  let always = [];
  if (engine.value === 'code-review') {
    effort = pick(parsed.effort, crCfg.effort, ENGINE_DEFAULTS.effort);
    model = pick(null, crCfg.model, ENGINE_DEFAULTS.model);
    if (crCfg.max_findings != null) maxFindings = { value: crCfg.max_findings, source: 'config' };
    const lanes = codeReviewLanes(crCfg);
    replaces = lanes.replaces.slice();
    always = lanes.always.slice();
    const [problem] = alwaysLaneProblems(crCfg, cfg.agents);
    if (problem && problem.kind === 'overlap') {
      throw new Error(`${laneOverlapMessage(problem.id, crCfg)}; a lane cannot both run and be replaced`);
    }
    if (problem) {
      throw new Error(
        `engine.code_review.always lists "${problem.id}", but no enabled agent has that id (add it to agents or change engine.code_review.always)`,
      );
    }
  } else if (parsed.effort != null) {
    notes.push(`effort=${parsed.effort} ignored: the agent-review engine does not use it.`);
  }

  if (parsed.unknown.length) {
    notes.push(`ignored unknown argument(s): ${parsed.unknown.join(', ')}`);
  }

  return {
    mode,
    engine,
    effort,
    model,
    maxFindings,
    replaces,
    always,
    reviewsRun,
    incremental: parsed.incremental,
    ci: isCi,
    notes,
  };
}

module.exports = {
  ENGINE_DEFAULTS,
  CI_NOTE,
  alwaysLaneProblems,
  laneOverlapMessage,
  parseReviewArgs,
  resolveOptions,
};
