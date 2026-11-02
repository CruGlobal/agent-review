'use strict';

const { ENGINE_DEFAULT, ENGINE_CODE_REVIEW } = require('./vocabulary.cjs');

const TOOL_NAME = require('../package.json').name;

function setLearningStatus(learnings, id, status) {
  const list = (learnings && learnings.learnings) || [];
  if (!list.some((l) => l.id === id))
    throw new Error(`Learning not found: ${id}`);
  return {
    ...learnings,
    learnings: list.map((l) => (l.id === id ? { ...l, status } : l)),
  };
}

function listLearnings(learnings, statusFilter) {
  const list = (learnings && learnings.learnings) || [];
  return list
    .filter((l) => !statusFilter || l.status === statusFilter)
    .map((l) => ({
      id: l.id,
      kind: l.kind,
      status: l.status,
      support: l.support,
      paths: l.paths || [],
      example: l.example || l.ruleText || '',
      ruleText: l.ruleText || '',
      rationale: l.rationale || '',
    }));
}

function preflightSummary(plan, impact) {
  const lines = [];
  lines.push(`profile: ${plan.profile}`);
  const r = plan.risk;
  lines.push(`risk: ${r.score} ${r.level} (reviewer: ${r.reviewer})`);
  if (r.special && r.special.length)
    lines.push(`special: ${r.special.join(', ')}`);
  lines.push(`mode: ${plan.mode.resolved}`);
  lines.push('agents:');
  for (const a of plan.agents) lines.push(`  - ${a.id} [${a.matchedBy}]`);
  if (impact) {
    lines.push(
      `impact: blastRadius ${impact.blastRadius}${impact.truncated ? ' (truncated)' : ''}`,
    );
    for (const t of (impact.topImpacted || [])
      .filter((x) => x.dependentCount > 0)
      .slice(0, 5)) {
      lines.push(`  - ${t.dependentCount} dependents: ${t.file}`);
    }
  }
  return lines.join('\n');
}

const LEFTOVER_CI_NOTE =
  'this repo is local-only but still has CI review workflows, so PRs labeled agent-review still pay for CI reviews. Run /agent-review:update-files to remove them.';

// The review skill's Stage 0B, not the plan, applies these under the agent-review engine.
const DEFAULT_ENGINE_MODE_NOTES = {
  quick: 'quick mode keeps at most 3 of these lanes.',
  deep: 'deep mode also runs every enabled lane listed as skipped.',
};

function reviewerTag(agent, slice, model) {
  if (slice && slice.mode === 'empty') return 'skipped: no matching hunks';
  const by = agent.matchedBy || '';
  if (by === 'engine') return model || 'engine';
  if (by === 'always' || by === 'engine-always') return 'always';
  if (by === 'unmatched-coverage') return 'coverage';
  return 'trigger';
}

function unplannedLanes({ plan, configAgents }) {
  const planned = new Set(plan.agents.map((a) => a.id));
  const replaced = new Set((plan.engine && plan.engine.replaces) || []);
  return (configAgents || []).filter(
    (a) => a.enabled !== false && !planned.has(a.id) && !replaced.has(a.id),
  );
}

function reviewerList({ plan, sliceManifest, configAgents, model }) {
  const manifest = sliceManifest || {};
  const reviewers = plan.agents.map(
    (a) => `${a.id} [${reviewerTag(a, manifest[a.id], model)}]`,
  );
  for (const a of unplannedLanes({ plan, configAgents })) {
    reviewers.push(`${a.id} [skipped: no trigger matched]`);
  }
  return reviewers.join(', ');
}

// `mode` is the mode after the review skill's auto resolution, which can differ from the plan's.
function formatStartup({
  options,
  plan,
  sliceManifest,
  configAgents,
  scopeLabel,
  ciFilesPresent,
  mode,
}) {
  const withSource = (o) => `${o.value} (${o.source})`;
  const head = [TOOL_NAME, `engine: ${withSource(options.engine)}`];
  if (options.effort) head.push(`effort: ${withSource(options.effort)}`);
  const { requested } = plan.mode;
  const resolved = mode || plan.mode.resolved;
  head.push(`mode: ${requested === resolved ? resolved : `${requested} \u2192 ${resolved}`}`);
  head.push(`scope: ${scopeLabel || 'full review'}`);

  const model = options.model && options.model.value;
  const reviewers =
    resolved === 'skip'
      ? 'none (no-risk diff skipped)'
      : reviewerList({ plan, sliceManifest, configAgents, model });

  const lines = [head.join(' \u00b7 '), `reviewers: ${reviewers}`];
  // Deep mode runs only the lanes skipped for no trigger; a lane with no matching hunks never runs.
  const modeNote =
    resolved === 'deep' && !unplannedLanes({ plan, configAgents }).length
      ? null
      : DEFAULT_ENGINE_MODE_NOTES[resolved];
  if (options.engine.value === ENGINE_DEFAULT && modeNote) lines.push(`note: ${modeNote}`);
  for (const n of options.notes || []) lines.push(`note: ${n}`);
  if (options.reviewsRun.value === 'local' && ciFilesPresent)
    lines.push(`note: ${LEFTOVER_CI_NOTE}`);
  return lines.join('\n');
}

module.exports = {
  setLearningStatus,
  listLearnings,
  preflightSummary,
  formatStartup,
};
