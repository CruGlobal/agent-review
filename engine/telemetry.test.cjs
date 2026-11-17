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

test('telemetry --in a learnings folder reads the old file and every folder file once', () => {
  const { readTelemetry } = require('./telemetry.cjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const base = mkdtempSync(join(require('node:os').tmpdir(), 'tel-'));
  try {
    const line = (o) => JSON.stringify(o) + '\n';
    writeFileSync(join(base, 'feedback.jsonl'), line({ reviewId: 'r1', signature: 's1', outcome: 'accepted' }));
    mkdirSync(join(base, 'feedback'));
    writeFileSync(join(base, 'feedback', '.gitkeep'), '');
    writeFileSync(join(base, 'feedback', 'r1-20261117T000000Z-aaaaaa.jsonl'),
      line({ reviewId: 'r1', signature: 's1', outcome: 'dismissed', dismissalReason: 'intentional' }));
    writeFileSync(join(base, 'feedback', 'r2-20261117T000000Z-bbbbbb.jsonl'),
      line({ reviewId: 'r2', signature: 's2', outcome: 'accepted' }));
    const entries = readTelemetry(base);
    assert.equal(entries.length, 3);
    const out = summarizeTelemetry(entries);
    assert.equal(out.totals.dispositioned, 2, 'r1:s1 counts once, the later folder entry wins');
    assert.equal(out.totals.dismissed, 1);
    assert.equal(out.totals.duplicatesIgnored, 1);
    assert.equal(readTelemetry(join(base, 'feedback.jsonl')).length, 1, 'one file still reads as before');
    writeFileSync(join(base, 'feedback', 'r3-20261117T000000Z-cccccc.jsonl'), 'NOT JSON\n');
    assert.throws(() => readTelemetry(base), /invalid telemetry JSONL line 1/, 'a bad line still fails loudly');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
