'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateApproval } = require('./approval.cjs');

const HEAD = 'abc123def4567890abc123def4567890abc12345';

function report({
  marker = true,
  rollout = 'advisory',
  head = HEAD,
  status = { v: 1, head: HEAD, pass: true, irreversible: false },
  statusRaw,
  eol = '\n',
} = {}) {
  const lines = [];
  if (marker) lines.push('<!-- agent-review -->');
  if (rollout !== null) lines.push(`<!-- agent-review-rollout: ${rollout} -->`);
  if (head !== null) lines.push(`<!-- agent-review-head: ${head} -->`);
  if (statusRaw !== undefined) lines.push(`<!-- agent-review-status: ${statusRaw} -->`);
  else if (status !== null) lines.push(`<!-- agent-review-status: ${JSON.stringify(status)} -->`);
  lines.push('', '# 🤖 Multi-Agent Code Review Report', '', 'body text');
  return lines.join(eol);
}

test('approves an advisory report whose head and status match the PR head', () => {
  const result = evaluateApproval(report(), { head: HEAD });
  assert.equal(result.approve, true);
  assert.match(result.reason, /passes/);
});

test('approves an enforce report the same way', () => {
  assert.equal(evaluateApproval(report({ rollout: 'enforce' }), { head: HEAD }).approve, true);
});

test('never approves without an expected head', () => {
  assert.equal(evaluateApproval(report(), {}).approve, false);
  assert.equal(evaluateApproval(report(), { head: '  ' }).approve, false);
});

test('refuses a body that is not an agent-review report', () => {
  const result = evaluateApproval(report({ marker: false }), { head: HEAD });
  assert.equal(result.approve, false);
  assert.match(result.reason, /not an agent-review report/);
  assert.equal(evaluateApproval('', { head: HEAD }).approve, false);
  assert.equal(evaluateApproval(undefined, { head: HEAD }).approve, false);
});

test('refuses a report with no rollout marker, a shadow one, or an unknown one', () => {
  assert.match(evaluateApproval(report({ rollout: null }), { head: HEAD }).reason, /no rollout marker/);
  assert.match(evaluateApproval(report({ rollout: 'shadow' }), { head: HEAD }).reason, /shadow/);
  assert.match(evaluateApproval(report({ rollout: 'yolo' }), { head: HEAD }).reason, /unknown rollout/);
});

test('refuses a report whose reviewed head is missing or differs from the PR head', () => {
  assert.match(evaluateApproval(report({ head: null }), { head: HEAD }).reason, /no reviewed-head marker/);
  const stale = evaluateApproval(report({ head: 'ffff' + HEAD.slice(4) }), { head: HEAD });
  assert.equal(stale.approve, false);
  assert.match(stale.reason, /PR head/);
});

test('refuses a report with no status marker or an unparseable one', () => {
  assert.match(evaluateApproval(report({ status: null }), { head: HEAD }).reason, /no status marker/);
  assert.match(evaluateApproval(report({ statusRaw: '{not json' }), { head: HEAD }).reason, /not valid JSON/);
  assert.match(evaluateApproval(report({ statusRaw: '"pass"' }), { head: HEAD }).reason, /not valid JSON|not an object/);
});

test('refuses a failing, irreversible, or head-disagreeing status', () => {
  const failing = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 2 } }), { head: HEAD });
  assert.equal(failing.approve, false);
  assert.match(failing.reason, /2 open blockers/);
  const irreversible = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: true, irreversible: true } }), { head: HEAD });
  assert.equal(irreversible.approve, false);
  assert.match(irreversible.reason, /irreversible/);
  const disagree = evaluateApproval(report({ status: { v: 1, head: '0000' + HEAD.slice(4), pass: true } }), { head: HEAD });
  assert.equal(disagree.approve, false);
  assert.match(disagree.reason, /status head/);
});

test('a status without a head field is judged by the head marker alone', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, pass: true, irreversible: false } }), { head: HEAD }).approve, true);
});

test('pass must be boolean true, not a truthy string', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, head: HEAD, pass: 'true' } }), { head: HEAD }).approve, false);
});

test('tolerates CRLF bodies and whitespace or case differences in the expected head', () => {
  assert.equal(evaluateApproval(report({ eol: '\r\n' }), { head: HEAD }).approve, true);
  assert.equal(evaluateApproval(report(), { head: `${HEAD.toUpperCase()}\n` }).approve, true);
});

test('the first marker of each kind wins over one quoted later in the body', () => {
  const body = report() + '\n<!-- agent-review-head: 1111111111111111111111111111111111111111 -->\n';
  assert.equal(evaluateApproval(body, { head: HEAD }).approve, true);
});
