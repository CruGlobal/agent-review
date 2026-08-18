'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareAddressRequest,
  validateAddressResult,
  feedbackForAddress,
  finalizeAddress,
} = require('./addressState.cjs');

function finding(overrides = {}) {
  return {
    n: 1,
    id: 'f1',
    signature: 'sig-1',
    agent: 'security',
    category: 'auth',
    severity: 9,
    file: 'app/controller.js',
    line: 12,
    message: 'authorization is missing',
    status: 'open',
    ...overrides,
  };
}

function report(ledger = [finding(), finding({ n: 2, id: 'f2', signature: 'sig-2', file: 'app/model.js' })]) {
  const status = { v: 1, head: 'a'.repeat(40), risk: 'HIGH', openBlockers: 2, pass: false, irreversible: false, irreversibleReasons: [] };
  return [
    '<!-- agent-review -->',
    `<!-- agent-review-head: ${'a'.repeat(40)} -->`,
    `<!-- agent-review-ledger: ${JSON.stringify(ledger)} -->`,
    `<!-- agent-review-status: ${JSON.stringify(status)} -->`,
    '',
    '- [ ] **#1** · 9/10 · `app/controller.js:12` — authorization is missing _(security)_',
    '- [ ] **#2** · 9/10 · `app/model.js:12` — authorization is missing _(security)_',
    '',
  ].join('\n');
}

function request(command = '@claude fix 1; dismiss 2 [false-positive]: guarded by the caller') {
  return prepareAddressRequest({
    command,
    actor: 'dr-bizz',
    pr: 42,
    commentId: 100,
    reportCommentId: 200,
    expectedHead: 'a'.repeat(40),
    report: report(),
  });
}

test('prepareAddressRequest normalizes strict fix and dismissal clauses', () => {
  const value = request();
  assert.deepEqual(value.operations.map(({ n, action }) => ({ n, action })), [
    { n: 1, action: 'fix' },
    { n: 2, action: 'dismiss' },
  ]);
  assert.equal(value.operations[1].reasonCode, 'false-positive');
  assert.equal(value.operations[0].file, 'app/controller.js');
});

test('prepareAddressRequest rejects invalid, duplicate, missing, or resolved findings', () => {
  assert.throws(() => request('@claude dismiss 2: no taxonomy'), /invalid address syntax/);
  assert.throws(() => request('@claude fix 1; fix 1'), /appears more than once/);
  assert.throws(() => request('@claude fix 99'), /does not exist/);
  const resolved = report([finding({ status: 'fixed', sha: 'b'.repeat(40) })]);
  assert.throws(() => prepareAddressRequest({
    command: '@claude fix 1', actor: 'dr-bizz', pr: 1, commentId: 2,
    reportCommentId: 3, expectedHead: 'a'.repeat(40), report: resolved,
  }), /already fixed/);
});

test('validateAddressResult requires authorized fixes and accounts for every patch path', () => {
  const req = request('@claude fix 1');
  const result = validateAddressResult({
    request: req,
    changedFiles: ['app/controller.js', 'test/controller.test.js'],
    patchBytes: 200,
    result: {
      version: 1,
      expectedHead: 'a'.repeat(40),
      fixes: [{
        n: 1,
        status: 'applied',
        summary: 'added the missing check',
        files: ['app/controller.js', 'test/controller.test.js'],
      }],
      tests: [{ command: 'npm test', status: 'passed' }],
    },
  });
  assert.equal(result.fixes[0].status, 'applied');
  assert.throws(() => validateAddressResult({
    request: req,
    changedFiles: ['app/controller.js', 'package.json'],
    patchBytes: 200,
    result: {
      version: 1, expectedHead: 'a'.repeat(40),
      fixes: [{ n: 1, status: 'applied', summary: 'x', files: ['app/controller.js'] }],
      tests: [],
    },
  }), /undeclared file/);
  assert.throws(() => validateAddressResult({
    request: req,
    changedFiles: ['.github/workflows/release.yml', 'app/controller.js'],
    patchBytes: 200,
    result: {
      version: 1, expectedHead: 'a'.repeat(40),
      fixes: [{ n: 1, status: 'applied', summary: 'x', files: ['app/controller.js', '.github/workflows/release.yml'] }],
      tests: [],
    },
  }), /sensitive path/);
});

test('validateAddressResult rejects model attempts to broaden finding authority', () => {
  const req = request('@claude fix 1');
  assert.throws(() => validateAddressResult({
    request: req,
    changedFiles: ['app/model.js'],
    patchBytes: 20,
    result: {
      version: 1, expectedHead: 'a'.repeat(40),
      fixes: [{ n: 2, status: 'applied', summary: 'changed it', files: ['app/model.js'] }],
      tests: [],
    },
  }), /unauthorized/);
  assert.throws(() => validateAddressResult({
    request: req,
    changedFiles: ['app/controller.js'],
    patchBytes: 20,
    result: {
      version: 1, expectedHead: 'b'.repeat(40),
      fixes: [{ n: 1, status: 'applied', summary: 'changed it', files: ['app/controller.js'] }],
      tests: [],
    },
  }), /different PR head/);
});

test('validateAddressResult requires the full structured contract and accepts dismissal-only handoffs', () => {
  const fixRequest = request('@claude fix 1');
  assert.throws(() => validateAddressResult({
    request: fixRequest,
    changedFiles: [],
    patchBytes: 0,
    result: {
      version: 1,
      expectedHead: 'a'.repeat(40),
      fixes: [{ n: 1, status: 'not-applied', reason: 'unsafe to change', files: [] }],
    },
  }), /tests must be an array/);

  const dismissalRequest = request('@claude dismiss 2 [intentional]: required behavior');
  assert.deepEqual(validateAddressResult({
    request: dismissalRequest,
    changedFiles: [],
    patchBytes: 0,
    result: { version: 1, expectedHead: 'a'.repeat(40), fixes: [], tests: [] },
  }).fixes, []);
});

test('feedback and finalization are derived from human authority and the pushed SHA', () => {
  const req = request();
  const result = {
    version: 1,
    expectedHead: 'a'.repeat(40),
    fixes: [{ n: 1, status: 'applied', summary: 'added authorization', files: ['app/controller.js'] }],
    tests: [],
  };
  const feedback = feedbackForAddress(req, result, '2026-01-01T00:00:00.000Z');
  assert.equal(feedback.length, 2);
  assert.equal(feedback[0].outcome, 'accepted');
  assert.equal(feedback[1].dismissalReason, 'false-positive');
  const finalized = finalizeAddress({
    request: req,
    result,
    report: report(),
    fixSha: 'c'.repeat(40),
  });
  assert.deepEqual(finalized.appliedFixes, [1]);
  assert.deepEqual(finalized.dismissed, [2]);
  assert.equal(finalized.status.openBlockers, 0);
  assert.equal(finalized.status.pass, true);
  assert.equal(finalized.status.head, 'a'.repeat(40));
  assert.match(finalized.report, /✅ fixed in ccccccc/);
  assert.match(finalized.report, /dismissed by @dr-bizz \[false-positive\]/);
  assert.match(finalized.summary, /Please review that commit/);
});

test('finalization leaves not-applied fixes open', () => {
  const req = request('@claude fix 1');
  const result = {
    version: 1,
    expectedHead: 'a'.repeat(40),
    fixes: [{ n: 1, status: 'not-applied', reason: 'the finding is stale', files: [] }],
    tests: [],
  };
  const finalized = finalizeAddress({ request: req, result, report: report(), fixSha: '' });
  assert.equal(finalized.ledger[0].status, 'open');
  assert.match(finalized.summary, /Not applied: #1/);
});
