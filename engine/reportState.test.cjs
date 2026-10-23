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

test('ledger carries the fix field and bounds it to 2000 chars like the other optional fields', () => {
  const ledger = mergeLedger([], [finding({ fix: 'add a nil guard before save' })]);
  assert.equal(ledger[0].fix, 'add a nil guard before save');

  const long = 'x'.repeat(2500);
  const ledger2 = mergeLedger([], [finding({ signature: 'sig-3', fix: long })]);
  assert.equal(ledger2[0].fix.length, 2000);
});

test('ledger carries the agents field (full corroborating set) bounded to 2000 chars, optional', () => {
  const ledger = mergeLedger([], [finding({ agents: 'agentA,agentB' })]);
  assert.equal(ledger[0].agents, 'agentA,agentB');

  const withoutAgents = mergeLedger([], [finding({ signature: 'sig-2' })]);
  assert.equal('agents' in withoutAgents[0], false);
});

test('ledger carries needsHumanReview as an optional boolean flag, only when truthy', () => {
  const ledger = mergeLedger([], [finding({ needsHumanReview: true })]);
  assert.equal(ledger[0].needsHumanReview, true);

  const withoutFlag = mergeLedger([], [finding({ signature: 'sig-2', needsHumanReview: false })]);
  assert.equal('needsHumanReview' in withoutFlag[0], false);
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

const BY_LOCATION = { matchSuggestionsByLocation: true };

function oldEntry(over = {}) {
  return {
    n: 3,
    ...finding({
      signature: 'old-sig',
      agent: 'code-review',
      category: 'Correctness',
      severity: 5,
      line: 40,
      message: 'cache is never invalidated',
    }),
    status: 'open',
    ...over,
  };
}

function reworded(over = {}) {
  return finding({
    signature: 'new-sig',
    agent: 'code-review',
    category: ' correctness ',
    severity: 4,
    line: 44,
    message: 'stale cache entries survive updates',
    ...over,
  });
}

test('location mode skips a reworded suggestion near an old entry of any status; default mode appends it', () => {
  for (const status of ['open', 'fixed', 'dismissed']) {
    const previous = [oldEntry({ status })];
    const byLocation = mergeLedger(previous, [reworded()], BY_LOCATION);
    assert.deepEqual(byLocation.map((entry) => entry.n), [3], `status ${status}`);

    const plain = mergeLedger(previous, [reworded()]);
    assert.deepEqual(plain.map((entry) => [entry.n, entry.signature]), [[3, 'old-sig'], [4, 'new-sig']]);
  }
  const unanchored = mergeLedger([oldEntry({ line: null })], [reworded({ line: null })], BY_LOCATION);
  assert.equal(unanchored.length, 1, 'two unanchored entries in the same file and category match');
});

test('location mode never folds a reworded blocker into an old entry', () => {
  const previous = [oldEntry({ severity: 8, status: 'fixed', sha: 'abc1234' })];
  const ledger = mergeLedger(previous, [reworded({ severity: 7, line: 42 })], BY_LOCATION);
  assert.deepEqual(ledger.map((entry) => [entry.n, entry.signature, entry.status]), [
    [3, 'old-sig', 'fixed'],
    [4, 'new-sig', 'open'],
  ]);
});

test('location mode appends a suggestion in another category, file, or more than 5 lines away', () => {
  const previous = [oldEntry()];
  const cases = {
    'different category': reworded({ category: 'performance' }),
    'different file': reworded({ file: 'app/other.rb' }),
    '6 lines away': reworded({ line: 46 }),
    '6 lines before': reworded({ line: 34 }),
    'one line missing': reworded({ line: null }),
  };
  for (const [label, next] of Object.entries(cases)) {
    const ledger = mergeLedger(previous, [next], BY_LOCATION);
    assert.deepEqual(ledger.map((entry) => entry.n), [3, 4], label);
  }
  assert.equal(mergeLedger(previous, [reworded({ line: 45 })], BY_LOCATION).length, 1, 'exactly 5 lines away matches');
  assert.equal(mergeLedger(previous, [reworded({ line: 35 })], BY_LOCATION).length, 1, 'exactly 5 lines before matches');
});

test('the default ledger merge ignores location, with or without an options object', () => {
  const previous = [oldEntry()];
  const findings = [reworded(), reworded({ signature: 'other-sig', line: 41, severity: 3 })];
  const plain = JSON.stringify(mergeLedger(previous, findings));
  assert.equal(JSON.stringify(mergeLedger(previous, findings, {})), plain);
  assert.equal(JSON.stringify(mergeLedger(previous, findings, { matchSuggestionsByLocation: false })), plain);
  assert.deepEqual(JSON.parse(plain).map((entry) => entry.n), [3, 4, 5]);
});
