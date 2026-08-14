'use strict';

const { readFileSync } = require('node:fs');
const { DISMISSAL_REASONS } = require('./evalSuite.cjs');

function readTelemetry(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (/\.json$/i.test(path)) {
    const raw = JSON.parse(text);
    return raw.entries || raw.feedback || (Array.isArray(raw) ? raw : [raw]);
  }
  return text.split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error(`invalid telemetry JSONL line ${i + 1}: ${e.message}`); }
  });
}

function rate(num, den) {
  return den === 0 ? null : num / den;
}

function summarizeTelemetry(entries) {
  const deduped = [];
  const positions = new Map();
  for (const entry of entries) {
    const identity = entry.reviewId && (entry.signature || entry.id)
      ? `${entry.reviewId}:${entry.signature || entry.id}`
      : null;
    if (identity && positions.has(identity)) deduped[positions.get(identity)] = entry;
    else {
      if (identity) positions.set(identity, deduped.length);
      deduped.push(entry);
    }
  }
  const totals = {
    dispositioned: 0,
    accepted: 0,
    dismissed: 0,
    falsePositiveDismissals: 0,
    blockerDispositioned: 0,
    blockerDismissed: 0,
    duplicatesIgnored: entries.length - deduped.length,
  };
  const dismissalReasons = {};
  const categories = {};
  for (const entry of deduped) {
    if (!['accepted', 'dismissed'].includes(entry.outcome)) continue;
    totals.dispositioned++;
    totals[entry.outcome]++;
    const blocker = Number(entry.severity) >= 7;
    if (blocker) totals.blockerDispositioned++;
    const category = String(entry.category || 'uncategorized');
    categories[category] ||= { dispositioned: 0, accepted: 0, dismissed: 0 };
    categories[category].dispositioned++;
    categories[category][entry.outcome]++;
    if (entry.outcome === 'dismissed') {
      if (blocker) totals.blockerDismissed++;
      const reason = entry.dismissalReason || entry.dismissal_reason || entry.reasonCode || entry.reason_code || 'other';
      if (!DISMISSAL_REASONS.has(reason)) throw new Error(`invalid dismissal reason: ${reason}`);
      dismissalReasons[reason] = (dismissalReasons[reason] || 0) + 1;
      if (reason === 'false-positive' || reason === 'insufficient-evidence') {
        totals.falsePositiveDismissals++;
      }
    }
  }
  for (const value of Object.values(categories)) {
    value.dismissalRate = rate(value.dismissed, value.dispositioned);
  }
  return {
    version: 1,
    totals,
    metrics: {
      dismissalRate: rate(totals.dismissed, totals.dispositioned),
      falsePositiveDismissalRate: rate(totals.falsePositiveDismissals, totals.dispositioned),
      blockerDismissalRate: rate(totals.blockerDismissed, totals.blockerDispositioned),
    },
    dismissalReasons,
    categories,
  };
}

function rolloutReadiness({ evaluation, telemetry, rollout = {} }) {
  const thresholds = rollout.thresholds || {};
  const checks = {
    evaluationGate: Boolean(evaluation && evaluation.gate && evaluation.gate.pass),
    minimumEvaluatedRuns:
      Boolean(evaluation) &&
      (evaluation.details || []).length >= Number(rollout.minimum_evaluated_runs || 50),
    minimumDispositions:
      Boolean(telemetry) &&
      telemetry.totals.dispositioned >= Number(rollout.minimum_dispositions || 30),
    dismissalRate:
      Boolean(telemetry) &&
      telemetry.metrics.dismissalRate != null &&
      telemetry.metrics.dismissalRate <= Number(thresholds.dismissal_rate == null ? 0.35 : thresholds.dismissal_rate),
    falsePositiveDismissalRate:
      Boolean(telemetry) &&
      telemetry.metrics.falsePositiveDismissalRate != null &&
      telemetry.metrics.falsePositiveDismissalRate <= Number(
        thresholds.false_positive_dismissal_rate == null ? 0.2 : thresholds.false_positive_dismissal_rate,
      ),
  };
  const blockers = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    version: 1,
    readyForEveryPr: blockers.length === 0,
    checks,
    blockers,
    recommendation: blockers.length === 0
      ? 'Evaluation and shadow telemetry gates pass; every-PR advisory rollout is eligible for human approval.'
      : `Keep label-gated shadow mode; unresolved gates: ${blockers.join(', ')}.`,
  };
}

module.exports = { readTelemetry, summarizeTelemetry, rolloutReadiness };
