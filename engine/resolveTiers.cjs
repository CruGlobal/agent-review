'use strict';
// Pure per-agent model-tier resolution, kept out of plan.cjs to stay single-purpose.
//
// Rules (see docs/superpowers/plans/2026-08-21-model-routing.md Task 2):
//   1. Explicit config `model` of opus/sonnet/haiku ALWAYS wins, in every mode.
//      Operator intent beats mode economics — quick mode never downgrades an
//      agent that was explicitly pinned to a tier.
//   2. Otherwise ("smart", or unset): escalating agents on HIGH/CRITICAL risk
//      get opus; every other smart agent gets sonnet. `escalates` is the
//      rigor lever for smart lanes.
//   3. If the resolved review mode is `quick`, any SMART (non-explicit) agent
//      that does not escalate drops to haiku — quick mode only protects the
//      lanes that matter, but it only ever touches smart-resolved tiers.
//   4. `deep` mode adds nothing beyond escalation (already covered by step 2).

const EXPLICIT_TIERS = new Set(['opus', 'sonnet', 'haiku']);
const ESCALATING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL']);

function smartTier(agent, riskLevel) {
  return agent.escalates && ESCALATING_RISK_LEVELS.has(riskLevel)
    ? 'opus'
    : 'sonnet';
}

function tierFor(agent, riskLevel, mode) {
  if (EXPLICIT_TIERS.has(agent.model)) return agent.model;
  if (mode === 'quick' && !agent.escalates) return 'haiku';
  return smartTier(agent, riskLevel);
}

function resolveTiers({ agents, riskLevel, mode }) {
  return agents.map((agent) => ({
    ...agent,
    tier: tierFor(agent, riskLevel, mode),
  }));
}

module.exports = { resolveTiers };
