'use strict';
const { readFileSync } = require('node:fs');
const { parseArgs } = require('./args.cjs');
const { loadConfig } = require('./loadConfig.cjs');
const { scoreRisk } = require('./scoreRisk.cjs');
const { selectAgents } = require('./selectAgents.cjs');
const { resolveRules } = require('./resolveRules.cjs');
const { detectSpecial } = require('./detectSpecial.cjs');
const { resolveTiers } = require('./resolveTiers.cjs');
const { ENGINE_CODE_REVIEW, CODE_REVIEW_LANE } = require('./vocabulary.cjs');

// requested `auto` resolves from the risk score/level; any other requested
// value (quick|standard|deep, or a future value) passes straight through.
function resolveMode(requested, risk) {
  if (requested !== 'auto') return requested;
  if (risk.score === 0) return 'skip';
  if (risk.level === 'LOW') return 'quick';
  if (risk.level === 'MEDIUM' || risk.level === 'HIGH') return 'standard';
  if (risk.level === 'CRITICAL') return 'deep';
  return 'standard';
}

function buildPlan(
  { files, diffText, linesChanged, scope, reviewDirRel, mode = 'standard', options },
  config,
) {
  const special = detectSpecial(diffText, files, config);
  const risk = scoreRisk({ files, linesChanged, scope, special }, config);
  const external = options && options.engine.value === ENGINE_CODE_REVIEW;
  const engine = external
    ? {
        name: ENGINE_CODE_REVIEW,
        effort: options.effort.value,
        model: options.model.value,
        maxFindings: options.maxFindings ? options.maxFindings.value : null,
        replaces: options.replaces,
        always: options.always,
      }
    : null;
  const selected = selectAgents({ files, diffText, reviewDirRel }, config, engine);
  const resolved = resolveMode(mode, risk);
  const tiered = resolveTiers({
    agents: selected,
    riskLevel: risk.level,
    mode: resolved,
  });
  const agents = tiered.map((a) => ({
    ...a,
    rules: resolveRules(a.id, files, config),
  }));
  if (!engine) {
    return {
      profile: config.profile,
      risk: { ...risk, special },
      mode: { requested: mode, resolved },
      agents,
    };
  }
  const agentById = new Map(config.agents.map((a) => [a.id, a]));
  const sources = [
    CODE_REVIEW_LANE,
    ...engine.replaces.filter((id) => agentById.has(id) && agentById.get(id).enabled !== false),
  ];
  const rules = [];
  for (const id of sources) {
    for (const r of resolveRules(id, files, config))
      if (!rules.includes(r)) rules.push(r);
  }
  return {
    profile: config.profile,
    risk: { ...risk, special },
    mode: { requested: mode, resolved },
    engine,
    agents: [
      {
        id: CODE_REVIEW_LANE,
        model: engine.model,
        escalates: false,
        always: true,
        matchedBy: 'engine',
        tier: engine.model,
        rules,
      },
      ...agents,
    ],
  };
}

function linesChangedFromStat(statText) {
  const ins = statText.match(/(\d+) insertions?\(\+\)/);
  const del = statText.match(/(\d+) deletions?\(-\)/);
  return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const config = loadConfig({ configPath: a.config, schemaPath: a.schema });
  const files = readFileSync(a.files, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const diffText = a.diff ? readFileSync(a.diff, 'utf8') : '';
  const linesChanged = a.stat
    ? linesChangedFromStat(readFileSync(a.stat, 'utf8'))
    : 0;
  const plan = buildPlan(
    {
      files,
      diffText,
      linesChanged,
      scope: a.scope || 'single_feature',
      mode: a.mode || 'standard',
    },
    config,
  );
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}

module.exports = { buildPlan, parseArgs, linesChangedFromStat, resolveMode };
