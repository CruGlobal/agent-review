'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTelemetry, rolloutReadiness } = require('./telemetry.cjs');

test('telemetry separates all dismissals from false-positive dismissals', () => {
  const out = summarizeTelemetry([
    { outcome: 'accepted', severity: 8, category: 'security' },
    { outcome: 'dismissed', severity: 8, category: 'security', dismissalReason: 'intentional' },
    { outcome: 'dismissed', severity: 5, category: 'style', dismissalReason: 'false-positive' },
  ]);
  assert.equal(out.metrics.dismissalRate, 2 / 3);
  assert.equal(out.metrics.falsePositiveDismissalRate, 1 / 3);
  assert.equal(out.dismissalReasons.intentional, 1);
});

test('rollout readiness fails closed on missing sample sizes', () => {
  const out = rolloutReadiness({
    evaluation: { gate: { pass: true }, details: [{}] },
    telemetry: { totals: { dispositioned: 1 }, metrics: { dismissalRate: 0, falsePositiveDismissalRate: 0 } },
    rollout: { minimum_evaluated_runs: 2, minimum_dispositions: 2 },
  });
  assert.equal(out.readyForEveryPr, false);
  assert.deepEqual(out.blockers.sort(), ['minimumDispositions', 'minimumEvaluatedRuns']);
});
