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

const averaged = (over = {}) => ({
  ...finding({
    id: 'old-id',
    severity: 6,
    line: 12,
    confidence: 'Medium',
    evidence: 'averaged with a standards 4',
    recommendation: 'the averaged group\'s advice',
    fix: 'the averaged group\'s fix',
    agents: 'security,standards',
    needsHumanReview: true,
    ...over,
  }),
  status: 'open',
});

test('a finding that comes back higher raises its open entry, which then blocks', () => {
  const previous = [{ n: 1, ...averaged() }];
  const next = finding({ id: 'new-id', severity: 8, line: 14, evidence: 'request reaches line 14 unchecked', recommendation: 'authorize the record' });
  const ledger = mergeLedger(previous, [next]);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger, [{ ...mergeLedger([], [next])[0], n: 1 }], 'the raised entry is the new finding under the old number');
  const status = buildStatus({ ledger, plan: { risk: { level: 'LOW' } }, safety: { irreversible: false, reasons: [] } });
  assert.equal(status.openBlockers, 1);
  assert.equal(status.pass, false);
});

test('a raised entry takes the new finding\'s file, line, message and evidence across files', () => {
  const { signature } = require('./findingSignature.cjs');
  const a = { agent: 'security', category: 'sql', file: 'app/models/a.rb', message: 'raw SQL built from `posts` input' };
  const b = { agent: 'security', category: 'sql', file: 'app/models/b.rb', message: 'raw SQL built from `users` input' };
  assert.equal(signature(a), signature(b), 'the premise: both share one signature');
  const previous = [
    { n: 3, ...finding({ ...a, signature: signature(a), severity: 4, line: 10, confidence: 'Low', evidence: 'a.rb line 10' }), status: 'open' },
  ];
  const ledger = mergeLedger(previous, [finding({ ...b, signature: undefined, line: 20, evidence: 'b.rb line 20 runs it' })]);
  assert.equal(ledger.length, 1);
  assert.deepEqual(
    [ledger[0].n, ledger[0].severity, ledger[0].file, ledger[0].line, ledger[0].message, ledger[0].evidence, ledger[0].agent, ledger[0].category],
    [3, 8, 'app/models/b.rb', 20, 'raw SQL built from `users` input', 'b.rb line 20 runs it', 'security', 'sql'],
  );
});

test('a raised entry keeps nothing from the old entry but its number', () => {
  const previous = [{ n: 2, ...averaged({ severity: 3, line: 5 }) }];
  const ledger = mergeLedger(previous, [finding({ id: undefined, severity: 6, line: null, confidence: undefined, evidence: undefined })]);
  assert.equal(ledger.length, 1);
  assert.deepEqual([ledger[0].n, ledger[0].status, ledger[0].severity, ledger[0].line, ledger[0].id], [2, 'open', 6, null, '']);
  for (const field of ['confidence', 'evidence', 'recommendation', 'fix', 'agents', 'needsHumanReview']) {
    assert.equal(field in ledger[0], false, `${field} comes only from the new finding`);
  }
});

test('dismissed and fixed entries never change when their finding comes back higher', () => {
  const previous = [
    { n: 1, ...finding({ severity: 6 }), status: 'dismissed', by: 'dev', reason: 'intentional' },
    { n: 2, ...finding({ signature: 'sig-2', severity: 5 }), status: 'fixed', sha: 'abc1234' },
  ];
  const ledger = mergeLedger(previous, [
    finding({ severity: 9, line: 30, evidence: 'new trace' }),
    finding({ signature: 'sig-2', severity: 8, line: 31, evidence: 'new trace' }),
  ]);
  assert.deepEqual(ledger, previous);
});

test('a finding that comes back lower or equal leaves its open entry as it was', () => {
  const previous = [{ n: 1, ...finding({ severity: 8, evidence: 'the original trace' }), status: 'open' }];
  for (const severity of [8, 6]) {
    const ledger = mergeLedger(previous, [finding({ severity, line: 40, evidence: 'a later trace' })]);
    assert.deepEqual(ledger, previous, `severity ${severity}`);
  }
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

test('location mode matches against the ledger after this merge\'s raises', () => {
  const { signature } = require('./findingSignature.cjs');
  const base = { agent: 'code-review', category: 'correctness', file: 'app/models/a.rb' };
  const old = { ...base, line: 10, severity: 4, message: 'refund rounds before fees in `a`', confidence: 'Medium', evidence: 'x' };
  const previous = [{ n: 1, ...old, signature: signature(old), status: 'open' }];
  const raise = { ...base, line: 60, severity: 8, message: 'refund rounds before fees in `b`', confidence: 'High', evidence: 'trace' };
  const reworded = (line) => ({ ...base, line, severity: 5, message: 'refund rounds before fees in the `a` path', confidence: 'Medium', evidence: 'y' });
  assert.equal(signature(raise), previous[0].signature, 'the premise: the 8 raises entry 1');
  assert.notEqual(signature(reworded(11)), previous[0].signature, 'the premise: the 5 is matched only by location');

  const awayFromMoved = mergeLedger(previous, [raise, reworded(11)], BY_LOCATION);
  assert.deepEqual(
    awayFromMoved.map((entry) => [entry.n, entry.severity, entry.line]),
    [[1, 8, 60], [2, 5, 11]],
    'a suggestion near the raised entry\'s old spot gets its own entry',
  );

  const nearMoved = mergeLedger(previous, [raise, reworded(61)], BY_LOCATION);
  assert.deepEqual(nearMoved.map((entry) => [entry.n, entry.severity, entry.line]), [[1, 8, 60]], 'a suggestion near the raised entry\'s new spot matches it');
});

const { ledgerCandidates, MatchesRejected } = require('./reportState.cjs');

// A rewording the automatic location match misses: its wording shares too few tokens with oldEntry's.
function rephrased(over = {}) {
  return reworded({
    line: 48,
    message: 'Writes leave stale rows behind in the lookup store.',
    evidence: 'save() skips the expire call',
    recommendation: 'expire the key after save',
    ...over,
  });
}

const blind = (f) => ({
  line: f.line,
  category: f.category,
  message: f.message,
  evidence: f.evidence || '',
  recommendation: f.recommendation || '',
});

test('candidates pair a reworded suggestion within 10 lines with an open or a dismissed entry of the same lane and file', () => {
  for (const status of ['open', 'dismissed']) {
    const entry = oldEntry({ status, recommendation: 'invalidate on write' });
    const next = rephrased({ line: 50 });
    assert.equal(mergeLedger([entry], [next], BY_LOCATION).length, 2, 'the premise: the automatic match misses it');
    assert.deepEqual(ledgerCandidates([entry], [next]), [{
      id: 'new-sig#3',
      file: 'app/controller.rb',
      earlier: blind(entry),
      finding: { ...blind(next), category: ' correctness ' },
    }], status);
  }
  assert.equal(ledgerCandidates([oldEntry()], [rephrased({ line: 30 })]).length, 1, 'exactly 10 lines before pairs');
});

test('candidates leave out a suggestion 11 lines away, or in another lane or file, and every fixed entry', () => {
  const cases = {
    '11 lines after': [oldEntry(), rephrased({ line: 51 })],
    '11 lines before': [oldEntry(), rephrased({ line: 29 })],
    'a fixed entry': [oldEntry({ status: 'fixed', sha: 'abc1234' }), rephrased()],
    'another agent': [oldEntry({ agent: 'testing' }), rephrased()],
    'only a corroborating agent': [oldEntry({ agent: 'security', agents: 'security,code-review' }), rephrased()],
    'another file': [oldEntry(), rephrased({ file: 'app/other.rb' })],
  };
  for (const [label, [entry, next]] of Object.entries(cases)) {
    assert.deepEqual(ledgerCandidates([entry], [next]), [], label);
  }
});

test('candidates leave out a new finding of 7 or more and a static finding', () => {
  assert.deepEqual(ledgerCandidates([oldEntry()], [rephrased({ severity: 7 })]), [], 'a 7');
  assert.deepEqual(ledgerCandidates([oldEntry()], [rephrased({ severity: 9 })]), [], 'a 9');
  assert.equal(ledgerCandidates([oldEntry()], [rephrased({ severity: 6 })]).length, 1, 'a 6 pairs');
  const staticEntry = oldEntry({ agent: 'static-analysis', category: 'static-analysis/no-raw-sql' });
  for (const next of [
    rephrased({ agent: 'static-analysis', category: 'static-analysis/no-raw-sql' }),
    rephrased({ category: 'static-analysis/no-raw-sql' }),
  ]) {
    assert.deepEqual(ledgerCandidates([staticEntry, oldEntry({ n: 4, signature: 'old-sig-2' })], [next]), [], `${next.agent} ${next.category}`);
  }
});

test('candidates pair two unanchored findings, but not an anchored one with an unanchored one', () => {
  assert.deepEqual(ledgerCandidates([oldEntry({ line: null })], [rephrased({ line: null })]).map((p) => p.id), ['new-sig#3']);
  assert.deepEqual(ledgerCandidates([oldEntry({ line: null })], [rephrased()]), [], 'the entry has no line');
  assert.deepEqual(ledgerCandidates([oldEntry()], [rephrased({ line: null })]), [], 'the finding has no line');
});

test('candidates leave out a finding the ledger already matches by signature or by location', () => {
  const sameSignature = rephrased({ signature: 'old-sig', severity: 3 });
  assert.deepEqual(ledgerCandidates([oldEntry()], [sameSignature]), [], 'a signature match');
  const higher = rephrased({ signature: 'old-sig', severity: 6 });
  assert.deepEqual(ledgerCandidates([oldEntry()], [higher]), [], 'a signature match that raises its entry');
  assert.equal(mergeLedger([oldEntry()], [reworded()], BY_LOCATION).length, 1, 'the premise: the automatic match takes it');
  assert.deepEqual(ledgerCandidates([oldEntry()], [reworded()]), [], 'an automatic location match');
});

test('candidates pair against a raised entry where the raise moved it', () => {
  const previous = [oldEntry({ n: 1, signature: 'raised-sig', line: 10, severity: 4 })];
  const raise = finding({ signature: 'raised-sig', agent: 'code-review', category: 'Correctness', severity: 8, line: 60, message: 'the cache is never invalidated after a write' });
  const nearOld = rephrased({ signature: 'near-old', line: 12 });
  const nearNew = rephrased({ signature: 'near-new', line: 66 });
  const pairs = ledgerCandidates(previous, [raise, nearOld, nearNew]);
  assert.deepEqual(pairs.map((p) => [p.id, p.earlier.line]), [['near-new#1', 60]]);
});

test('candidate order is the merge order of new findings, then entry number, whatever the input order', () => {
  const previous = [
    oldEntry({ n: 5, signature: 'e5', line: 20 }),
    oldEntry({ n: 2, signature: 'e2', line: 25 }),
  ];
  const a = rephrased({ signature: 'a', severity: 3, line: 22 });
  const b = rephrased({ signature: 'b', severity: 5, line: 24, message: 'Reads may return rows a write already replaced.' });
  const twin = rephrased({ signature: 'b', severity: 2, line: 21, message: 'A later write is not seen by the lookup.' });
  const expected = ['b#2', 'b#5', 'a#2', 'a#5'];
  assert.deepEqual(ledgerCandidates(previous, [a, b, twin]).map((p) => p.id), expected);
  assert.deepEqual(ledgerCandidates([...previous].reverse(), [twin, b, a]).map((p) => p.id), expected);
});

test('candidates carry only the fields that describe each problem', () => {
  const entry = oldEntry({ status: 'dismissed', by: 'dev', reason: 'intentional', fix: 'patch', agents: 'code-review,testing', needsHumanReview: true });
  const [pair] = ledgerCandidates([entry], [rephrased({ confidence: 'Low', fix: 'patch', agents: 'code-review' })]);
  assert.deepEqual(Object.keys(pair).sort(), ['earlier', 'file', 'finding', 'id']);
  for (const side of ['earlier', 'finding']) {
    assert.deepEqual(Object.keys(pair[side]).sort(), ['category', 'evidence', 'line', 'message', 'recommendation'], side);
  }
});

function matchCase(over = {}) {
  const entry = oldEntry({ severity: 3, ...over });
  const next = rephrased({ severity: 6 });
  return { previous: [entry], findings: [next], id: 'new-sig#3' };
}

test('a same: true answer hides the new finding and leaves the entry exactly as it was, even when the new score is higher', () => {
  const { previous, findings, id } = matchCase();
  const ledger = mergeLedger(previous, findings, { ...BY_LOCATION, matches: [{ id, same: true }] });
  assert.deepEqual(ledger, previous);
});

test('a same: false answer, or no answer, appends the new finding', () => {
  const { previous, findings, id } = matchCase();
  const plain = mergeLedger(previous, findings, BY_LOCATION);
  assert.deepEqual(plain.map((entry) => [entry.n, entry.signature]), [[3, 'old-sig'], [4, 'new-sig']]);
  assert.deepEqual(mergeLedger(previous, findings, { ...BY_LOCATION, matches: [{ id, same: false }] }), plain);
  assert.deepEqual(mergeLedger(previous, findings, { ...BY_LOCATION, matches: [] }), plain);
});

test('a match keeps a dismissed entry dismissed', () => {
  const { previous, findings, id } = matchCase({ status: 'dismissed', by: 'dev', reason: 'intentional' });
  assert.deepEqual(mergeLedger(previous, findings, { ...BY_LOCATION, matches: [{ id, same: true }] }), previous);
});

test('one same: true pair hides a finding, and a later finding with its signature stays out too', () => {
  const previous = [oldEntry(), oldEntry({ n: 4, signature: 'old-sig-2', line: 52 })];
  const next = rephrased({ line: 45 });
  const twin = rephrased({ line: 60, severity: 2, message: 'Nothing clears the stale rows later.' });
  const pairs = ledgerCandidates(previous, [next, twin]);
  assert.deepEqual(pairs.map((p) => p.id), ['new-sig#3', 'new-sig#4'], 'the premise: only the first finding of a signature pairs');
  const ledger = mergeLedger(previous, [next, twin], {
    ...BY_LOCATION,
    matches: [{ id: 'new-sig#3', same: false }, { id: 'new-sig#4', same: true }],
  });
  assert.deepEqual(ledger, previous);
  const other = rephrased({ signature: 'other-sig', line: 41, message: 'Rows outlive the record that made them.' });
  const kept = mergeLedger(previous, [next, other], { ...BY_LOCATION, matches: [{ id: 'new-sig#3', same: true }] });
  assert.deepEqual(kept.map((entry) => [entry.n, entry.signature]), [[3, 'old-sig'], [4, 'old-sig-2'], [5, 'other-sig']], 'a hidden finding takes no number');
});

test('matches are refused unless every item is a known, unrepeated pair with exactly id and a boolean same', () => {
  const { previous, findings, id } = matchCase();
  const bad = {
    'not an array': { id, same: true },
    'null': null,
    'an unknown id': [{ id: 'new-sig#9', same: true }],
    'an id for another finding': [{ id: 'old-sig#3', same: true }],
    'an extra key': [{ id, same: true, severity: 2 }],
    'a missing key': [{ id }],
    'a string same': [{ id, same: 'true' }],
    'a number id': [{ id: 3, same: true }],
    'a non-object item': [id],
    'an array item': [[id, true]],
    'a repeated id': [{ id, same: false }, { id, same: false }],
  };
  for (const [label, matches] of Object.entries(bad)) {
    assert.throws(() => mergeLedger(previous, findings, { ...BY_LOCATION, matches }), MatchesRejected, label);
  }
});

test('matches are refused without location matching, because candidates assume it', () => {
  const { previous, findings, id } = matchCase();
  assert.throws(() => mergeLedger(previous, findings, { matches: [{ id, same: true }] }), MatchesRejected);
  assert.throws(() => mergeLedger(previous, findings, { matchSuggestionsByLocation: false, matches: [] }), /location/);
});
