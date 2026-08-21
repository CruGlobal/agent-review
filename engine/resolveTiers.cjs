'use strict';
// Pure per-agent model-tier resolution, kept out of plan.cjs to stay single-purpose.
//
// Rules (see docs/superpowers/plans/2026-08-21-model-routing.md Task 2):
//   1. Explicit config `model` of opus/sonnet/haiku wins outright.
//   2. Otherwise ("smart", or unset) escalating agents on HIGH/CRITICAL risk get
//      opus; every other smart agent gets sonnet.
//   3. If the resolved review mode is `quick`, any agent that does not escalate
//      drops to haiku regardless of what steps 1-2 produced — quick mode only
//      protects the lanes that matter.
//   4. `deep` mode adds nothing beyond escalation (already covered by step 2).

const EXPLICIT_TIERS = new Set(['opus', 'sonnet', 'haiku']);
const ESCALATING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL']);

function baseTier(agent, riskLevel) {
  if (EXPLICIT_TIERS.has(agent.model)) return agent.model;
  return agent.escalates && ESCALATING_RISK_LEVELS.has(riskLevel)
    ? 'opus'
    : 'sonnet';
}

function tierFor(agent, riskLevel, mode) {
  const tier = baseTier(agent, riskLevel);
  if (mode === 'quick' && !agent.escalates) return 'haiku';
  return tier;
}

function resolveTiers({ agents, riskLevel, mode }) {
  return agents.map((agent) => ({
    ...agent,
    tier: tierFor(agent, riskLevel, mode),
  }));
}

module.exports = { resolveTiers };
