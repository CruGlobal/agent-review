'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLedger, buildStatus } = require('./reportState.cjs');

function finding(over = {}) {
  return {
    id: 'f1',
    signature: 'sig-1',
    agent: 'security',
    category: 'auth',
    severity: 8,
    file: 'app/controller.rb',
    line: 12,
    message: 'Missing authorization',
    confidence: 'High',
    evidence: 'request reaches the action without authorize()',
    ...over,
  };
}

test('ledger orders initial findings by severity and numbers them', () => {
  const ledger = mergeLedger([], {
    kept: [finding({ severity: 5 }), finding({ signature: 'sig-2', severity: 9 })],
  });
  assert.deepEqual(ledger.map((entry) => entry.severity), [9, 5]);
  assert.deepEqual(ledger.map((entry) => entry.n), [1, 2]);
  assert.ok(ledger.every((entry) => entry.status === 'open'));
});

test('incremental ledger preserves prior state and appends only new signatures', () => {
  const previous = [
    { n: 4, ...finding(), status: 'dismissed', by: 'dev', reason: 'intentional' },
  ];
  const ledger = mergeLedger(previous, [
    finding({ severity: 10, message: 'wording changed' }),
    finding({ signature: 'sig-2', severity: 7, line: 20 }),
  ]);
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger[0], previous[0]);
  assert.equal(ledger[1].n, 5);
  assert.equal(ledger[1].signature, 'sig-2');
});

test('ledger carries bounded evidence needed to address findings after re-review', () => {
  const ledger = mergeLedger([], [
    finding({ evidence: 'request reaches the action without authorize()', recommendation: 'add authorize(record)' }),
  ]);
  assert.equal(ledger[0].evidence, 'request reaches the action without authorize()');
  assert.equal(ledger[0].recommendation, 'add authorize(record)');
});

test('new blockers fail closed without high-confidence evidence', () => {
  assert.throws(
    () => mergeLedger([], [finding({ confidence: 'Medium' })]),
    /requires a line anchor, High confidence, and concrete evidence/,
  );
  assert.throws(
    () => mergeLedger([], [finding({ evidence: '' })]),
    /requires a line anchor, High confidence, and concrete evidence/,
  );
});

test('status is computed from ledger blockers and full gate plan', () => {
  const ledger = mergeLedger([], [finding(), finding({ signature: 'sig-2', severity: 4 })]);
  const status = buildStatus({
    ledger,
    head: 'abc1234',
    plan: { risk: { level: 'CRITICAL' } },
    safety: { irreversible: false, reasons: [] },
  });
  assert.deepEqual(status, {
    v: 1,
    head: 'abc1234',
    risk: 'CRITICAL',
    openBlockers: 1,
    pass: false,
    irreversible: false,
    irreversibleReasons: [],
  });
});

test('irreversible status fails closed without a concrete reason', () => {
  assert.throws(
    () =>
      buildStatus({
        ledger: [],
        plan: { risk: { level: 'LOW' } },
        safety: { irreversible: true, reasons: [] },
      }),
    /requires at least one reason/,
  );
});

test('status carries the deterministic CI snapshot without changing review pass semantics', () => {
  const status = buildStatus({
    ledger: [],
    head: 'abc',
    plan: { risk: { level: 'LOW' } },
    safety: { irreversible: false, reasons: [] },
    evidence: { ci: { summary: { total: 2, success: 1, failed: 1, pending: 0, neutral: 0 } } },
  });
  assert.equal(status.pass, true);
  assert.deepEqual(status.ci, { total: 2, success: 1, failed: 1, pending: 0, neutral: 0 });
});
