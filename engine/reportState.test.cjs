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

const NO_HUMAN = { required: false, reasons: [] };
const NO_CARD = { cardData: false, reasons: [] };

test('status is computed from ledger blockers and full gate plan', () => {
  const ledger = mergeLedger([], [finding(), finding({ signature: 'sig-2', severity: 4 })]);
  const status = buildStatus({
    ledger,
    head: 'abc1234',
    plan: { risk: { level: 'CRITICAL' } },
    safety: { irreversible: false, reasons: [] },
    human: NO_HUMAN,
    cardScan: NO_CARD,
  });
  assert.deepEqual(status, {
    v: 1,
    head: 'abc1234',
    risk: 'CRITICAL',
    openBlockers: 1,
    pass: false,
    irreversible: false,
    irreversibleReasons: [],
    humanRequired: false,
    humanReasons: [],
  });
});

test('irreversible status fails closed without a concrete reason', () => {
  assert.throws(
    () =>
      buildStatus({
        ledger: [],
        plan: { risk: { level: 'LOW' } },
        safety: { irreversible: true, reasons: [] },
        human: NO_HUMAN,
    cardScan: NO_CARD,
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
    human: NO_HUMAN,
    cardScan: NO_CARD,
    evidence: { ci: { summary: { total: 2, success: 1, failed: 1, pending: 0, neutral: 0 } } },
  });
  assert.equal(status.pass, true);
  assert.deepEqual(status.ci, { total: 2, success: 1, failed: 1, pending: 0, neutral: 0 });
});

function humanStatus(human, cardScan) {
  return buildStatus({
    ledger: [],
    plan: { risk: { level: 'LOW' } },
    safety: { irreversible: false, reasons: [] },
    human,
    cardScan,
  });
}

test('status needs a person when the rules or the card scan say so', () => {
  assert.deepEqual(
    [humanStatus(NO_HUMAN, NO_CARD).humanRequired, humanStatus(NO_HUMAN, NO_CARD).humanReasons],
    [false, []],
  );
  const rules = humanStatus({ required: true, reasons: ['PCI path'] }, NO_CARD);
  assert.equal(rules.humanRequired, true);
  assert.deepEqual(rules.humanReasons, ['PCI path']);
  const card = humanStatus(NO_HUMAN, { cardData: true, reasons: ['stores PAN'] });
  assert.equal(card.humanRequired, true);
  assert.deepEqual(card.humanReasons, ['stores PAN']);
});

test('status human reasons keep order and drop repeats', () => {
  const status = humanStatus(
    { required: true, reasons: ['a', 'b'] },
    { cardData: true, reasons: ['b', 'c'] },
  );
  assert.equal(status.humanRequired, true);
  assert.deepEqual(status.humanReasons, ['a', 'b', 'c']);
});

test('status human inputs fail closed', () => {
  assert.throws(() => humanStatus(NO_HUMAN, { cardData: true, reasons: [] }), /requires at least one reason/);
  assert.throws(() => humanStatus({ required: true, reasons: [] }, NO_CARD), /requires at least one reason/);
  assert.throws(() => humanStatus(undefined, NO_CARD), /human/);
  assert.throws(() => humanStatus(NO_HUMAN, undefined), /cardScan/);
});

test('status human inputs must have exact shapes', () => {
  const cases = [
    ['a misnamed card_data', NO_HUMAN, { card_data: true, reasons: ['stores PAN'] }, /cardScan\.cardData must be a boolean/],
    ['a missing cardData', NO_HUMAN, { reasons: [] }, /cardScan\.cardData must be a boolean/],
    ['a string cardData', NO_HUMAN, { cardData: 'false', reasons: [] }, /cardScan\.cardData must be a boolean/],
    ['cardData false with reasons', NO_HUMAN, { cardData: false, reasons: ['stores PAN'] }, /cardScan\.cardData is false but lists reasons/],
    ['missing card reasons', NO_HUMAN, { cardData: false }, /cardScan\.reasons must be a list of strings/],
    ['card reasons that are not a list', NO_HUMAN, { cardData: true, reasons: 'stores PAN' }, /cardScan\.reasons must be a list of strings/],
    ['non-string card reasons', NO_HUMAN, { cardData: true, reasons: ['stores PAN', 4] }, /cardScan\.reasons must be a list of strings/],
    ['a string required', { required: 'true', reasons: ['PCI path'] }, NO_CARD, /human\.required must be a boolean/],
    ['a missing required', { reasons: [] }, NO_CARD, /human\.required must be a boolean/],
    ['missing human reasons', { required: false }, NO_CARD, /human\.reasons must be a list of strings/],
    ['non-string human reasons', { required: true, reasons: [{ path: 'app/pci' }] }, NO_CARD, /human\.reasons must be a list of strings/],
    ['an array for human', [], NO_CARD, /human\.required must be a boolean/],
  ];
  for (const [name, human, card, error] of cases) {
    assert.throws(() => humanStatus(human, card), error, name);
  }
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
      message: 'the cache is never invalidated after a write',
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
    message: 'the cache is never invalidated after a write, so reads return stale data',
    ...over,
  });
}

test('location mode skips a reworded suggestion near an open or dismissed entry; default mode appends it', () => {
  for (const status of ['open', 'dismissed']) {
    const previous = [oldEntry({ status })];
    const byLocation = mergeLedger(previous, [reworded()], BY_LOCATION);
    assert.deepEqual(byLocation.map((entry) => entry.n), [3], `status ${status}`);

    const plain = mergeLedger(previous, [reworded()]);
    assert.deepEqual(plain.map((entry) => [entry.n, entry.signature]), [[3, 'old-sig'], [4, 'new-sig']]);
  }
  const unanchored = mergeLedger([oldEntry({ line: null })], [reworded({ line: null })], BY_LOCATION);
  assert.equal(unanchored.length, 1, 'two unanchored entries in the same file and category match');
});

test('location mode appends a new suggestion near a fixed entry', () => {
  const previous = [oldEntry({ status: 'fixed', sha: 'abc1234' })];
  const ledger = mergeLedger(previous, [reworded()], BY_LOCATION);
  assert.deepEqual(ledger.map((entry) => [entry.n, entry.signature, entry.status]), [
    [3, 'old-sig', 'fixed'],
    [4, 'new-sig', 'open'],
  ]);
});

test('location mode appends a new suggestion near another agent entry', () => {
  for (const status of ['open', 'dismissed']) {
    const other = mergeLedger([oldEntry({ status, agent: 'testing' })], [reworded()], BY_LOCATION);
    assert.deepEqual(other.map((entry) => entry.n), [3, 4], `another lane's ${status} entry`);
  }
  const corroborated = oldEntry({ agent: 'security', agents: 'security,code-review' });
  const byPrimary = mergeLedger([corroborated], [reworded()], BY_LOCATION);
  assert.deepEqual(byPrimary.map((entry) => entry.n), [3, 4], 'only the primary agent field counts');
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

test('location mode appends an unrelated suggestion near an entry of the same lane, file, and category', () => {
  const previous = [oldEntry({
    category: 'security',
    file: 'app/controllers/sessions_controller.rb',
    line: 20,
    message: 'The session cookie sets SameSite=Lax, so a cross-site POST still sends it.',
  })];
  const redirect = reworded({
    category: 'security',
    file: 'app/controllers/sessions_controller.rb',
    line: 23,
    severity: 5,
    message: 'The redirect target comes from params[:return_to] unchecked, so the login page is an open redirect.',
  });
  const ledger = mergeLedger(previous, [redirect], BY_LOCATION);
  assert.deepEqual(ledger.map((entry) => [entry.n, entry.signature]), [[3, 'old-sig'], [4, 'new-sig']]);
});

test('location matching needs wording Jaccard of 0.5', () => {
  const previous = [oldEntry({ message: 'alpha bravo charlie delta echo foxtrot golf' })];
  const below = mergeLedger(previous, [reworded({ message: 'alpha bravo charlie delta hotel india juliet' })], BY_LOCATION);
  assert.equal(below.length, 2, '4 shared of 10 tokens is 0.4, appended');
  const above = mergeLedger(previous, [reworded({ message: 'alpha bravo charlie delta echo hotel' })], BY_LOCATION);
  assert.equal(above.length, 1, '5 shared of 8 tokens is 0.625, matched');
  const atBar = mergeLedger(previous, [reworded({ message: 'alpha bravo charlie delta' })], BY_LOCATION);
  assert.equal(atBar.length, 1, '4 shared of 7 tokens is 0.57, matched');
});

test('the default ledger merge ignores location, with or without an options object', () => {
  const previous = [oldEntry()];
  const findings = [reworded(), reworded({ signature: 'other-sig', line: 41, severity: 3 })];
  const plain = JSON.stringify(mergeLedger(previous, findings));
  assert.equal(JSON.stringify(mergeLedger(previous, findings, {})), plain);
  assert.equal(JSON.stringify(mergeLedger(previous, findings, { matchSuggestionsByLocation: false })), plain);
  assert.deepEqual(JSON.parse(plain).map((entry) => entry.n), [3, 4, 5]);
});

test('location mode never skips a static finding, so every static signature reaches the ledger', () => {
  const staticFinding = (over = {}) => finding({
    signature: 'static-new',
    agent: 'static-analysis',
    category: 'static-analysis/no-raw-sql',
    severity: 6,
    line: 41,
    message: 'raw SQL built from interpolated input',
    ...over,
  });
  const previous = [{ n: 3, ...staticFinding({ signature: 'static-old', line: 40, message: 'avoid raw SQL strings' }), status: 'open' }];
  for (const next of [staticFinding(), staticFinding({ agent: 'no-raw-sql' })]) {
    const ledger = mergeLedger(previous, [next], BY_LOCATION);
    assert.deepEqual(ledger.map((entry) => [entry.n, entry.signature]), [[3, 'static-old'], [4, 'static-new']], next.agent);
  }
});
