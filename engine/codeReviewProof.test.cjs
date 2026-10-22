'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCodeReviewProof, checkFindingAccounting } = require('./codeReviewProof.cjs');

const HEADER = 'Skill "code-review" completed (forked execution).';
const FINDINGS = [
  { file: 'app.js', line: 13, summary: 'No fallback to user.name.', failure_scenario: 'displayName({ name: "Ann" }) throws.' },
  { file: 'app.js', line: 4, summary: 'firstN loops one too far.', failure_scenario: 'firstN([1,2,3], 2) returns 3 items.' },
];
const PROSE = [
  'Result:',
  'I reviewed `7cef894..16910c5`. It touches `app.js` only.',
  '- **Main problem:** `displayName` has no fallback.',
].join('\n');
const FIXTURE = `${HEADER}\n\n${PROSE}\n\n\`\`\`json\n${JSON.stringify(FINDINGS, null, 2)}\n\`\`\`\n`;
const body = (fixture) => fixture.split('\n').slice(1).join('\n');

test('missing raw output fails with the fix', () => {
  for (const rawText of [null, '']) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false);
    assert.match(r.reason, /did not run/);
    assert.match(r.reason, /update Claude Code/);
    assert.match(r.reason, /engine=agent-review/);
    assert.deepEqual(r.findings, []);
  }
});

test('the Skill header is required', () => {
  const r = checkCodeReviewProof({ rawText: body(FIXTURE) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Skill "code-review"/);
  assert.deepEqual(r.findings, []);
});

test('a findings list is required', () => {
  const prose = checkCodeReviewProof({ rawText: `${HEADER}\n\n${PROSE}\n` });
  assert.equal(prose.ok, false);
  assert.match(prose.reason, /no findings list/);
  const obj = checkCodeReviewProof({ rawText: `${HEADER}\n\n${PROSE}\n\n\`\`\`json\n{"x":1}\n\`\`\`\n` });
  assert.equal(obj.ok, false);
  assert.match(obj.reason, /no findings list/);
  assert.deepEqual(obj.findings, []);
});

test('passing results', () => {
  const full = checkCodeReviewProof({ rawText: FIXTURE });
  assert.equal(full.ok, true);
  assert.equal(full.findings.length, 2);
  assert.equal(full.findings[0].file, 'app.js');

  const empty = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nAll good.\n\n\`\`\`json\n[]\n\`\`\`\n` });
  assert.equal(empty.ok, true);
  assert.equal(empty.findings.length, 0);

  const none = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nNo findings.\n` });
  assert.equal(none.ok, true);
  assert.equal(none.findings.length, 0);

  const wrapped = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\n\`\`\`json\n{"level":"high","findings":${JSON.stringify(FINDINGS)}}\n\`\`\`\n`,
  });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.findings.length, 2);
});

test('the last fenced JSON array wins', () => {
  const raw = `${HEADER}\n\nResult:\n\`\`\`json\n[{"a":1}]\n\`\`\`\nlater\n\`\`\`js\nconst x = 1;\n\`\`\`\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\`\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 2);
});

test('"No findings." counts only when the result has no fenced block', () => {
  const broken = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\n\`\`\`json\n[{"file":"app.js",\n\`\`\`\nNo findings.\n`,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /no findings list/);
  assert.deepEqual(broken.findings, []);
});

test('a findings array must hold only objects', () => {
  for (const list of ['[1,2]', '["app.js","lib.js"]', '[{"file":"a.js"},null]', '[[{"file":"a.js"}]]', '{"findings":[1]}']) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n\`\`\`json\n${list}\n\`\`\`\n` });
    assert.equal(r.ok, false, `${list} must not pass as a findings list`);
    assert.match(r.reason, /no findings list/);
    assert.deepEqual(r.findings, []);
  }
});

const J = (value) => JSON.stringify(value);

test('accounting: every raw finding is scored or dropped', () => {
  const scored = [{ file: 'a.js' }, { file: 'b.js' }];
  const dropped = [{ file: 'c.js', proof: 'p' }];
  assert.deepEqual(
    checkFindingAccounting({ count: 3, findingsText: J({ findings: scored }), droppedText: J(dropped) }),
    { ok: true, reason: 'ok' },
  );
  assert.equal(
    checkFindingAccounting({ count: 2, findingsText: J(scored), droppedText: null }).ok,
    true,
    'a lane file may be a bare array, and a missing dropped file counts as 0',
  );
  assert.equal(checkFindingAccounting({ count: 0, findingsText: J({ findings: [] }), droppedText: '[]' }).ok, true);
});

test('accounting: an omitted finding fails with the numbers', () => {
  const r = checkFindingAccounting({
    count: 3,
    findingsText: J({ findings: [{ file: 'a.js' }] }),
    droppedText: J([{ file: 'c.js' }]),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /found 3/);
  assert.match(r.reason, /scored 1/);
  assert.match(r.reason, /dropped 1/);
  const extra = checkFindingAccounting({ count: 1, findingsText: J([{ file: 'a.js' }, { file: 'b.js' }]), droppedText: null });
  assert.equal(extra.ok, false, 'an added finding is as wrong as an omitted one');
});

test('accounting: a missing or unreadable lane file, or an unreadable dropped file, fails', () => {
  for (const findingsText of [null, '{"findings": [', J({ x: 1 })]) {
    const r = checkFindingAccounting({ count: 0, findingsText, droppedText: '[]' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /findings file/);
  }
  for (const droppedText of ['[{', J({ x: 1 })]) {
    const r = checkFindingAccounting({ count: 0, findingsText: '[]', droppedText });
    assert.equal(r.ok, false);
    assert.match(r.reason, /dropped file/);
  }
});

const NEW_REASON = '/code-review ran but returned no findings list the engine can read; rerun with effort=xhigh or engine=agent-review';

test('low effort: the exact "(none)" result passes with zero findings', () => {
  const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n` });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('low effort: file:line lines parse into findings', () => {
  const raw = `${HEADER}\n\nResult:\napp.js:13 — No fallback to user.name; displayName({name:"Ann"}) throws.\n\`lib/x.js:4\` – firstN loops one too far.\n- src/a.rb:7 - old marker form.\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 3);
  assert.deepEqual(r.findings[0], { file: 'app.js', line: 13, summary: 'No fallback to user.name; displayName({name:"Ann"}) throws.' });
  assert.equal(r.findings[1].file, 'lib/x.js');
  assert.equal(r.findings[1].line, 4);
  assert.equal(r.findings[2].file, 'src/a.rb');
  assert.equal(r.findings[2].line, 7);
});

test('rendered numbered list with Failure scenario lines', () => {
  const raw = `${HEADER}\n\nResult:\n2 findings, most severe first:\n\n1. \`app.js:13\`: No fallback to user.name.\n   Failure scenario: displayName({ name: "Ann" }) throws.\n2. \`app.js:4\`: firstN loops one too far.\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], {
    file: 'app.js',
    line: 13,
    summary: 'No fallback to user.name.',
    failure_scenario: 'displayName({ name: "Ann" }) throws.',
  });
  assert.equal('failure_scenario' in r.findings[1], false);
});

test('a fenced JSON findings block wins over finding-shaped text', () => {
  const raw = `${HEADER}\n\nResult:\nother.js:1 — a stray line.\n\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\`\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].failure_scenario, FINDINGS[0].failure_scenario);
});

test('header present but nothing parses: the reason is not "update Claude Code"', () => {
  const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${PROSE}\n` });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NEW_REASON);
  assert.doesNotMatch(r.reason, /update Claude Code/);
  assert.deepEqual(r.findings, []);
});

test('a missing header keeps the did-not-run reason', () => {
  const r = checkCodeReviewProof({ rawText: 'Result:\napp.js:13 — something.\n' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not run/);
  assert.match(r.reason, /update Claude Code/);
});
