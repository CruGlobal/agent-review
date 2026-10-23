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
  const first = [{ file: 'lib.js', line: 2, summary: 'an earlier list' }];
  const raw = `${HEADER}\n\nResult:\n\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\nlater\n\`\`\`js\nconst x = 1;\n\`\`\`\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\`\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, FINDINGS);
});

test('"No findings." never passes over a broken JSON block', () => {
  const broken = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\n\`\`\`json\n[{"file":"app.js",\n\`\`\`\nNo findings.\n`,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /no findings list/);
  assert.deepEqual(broken.findings, []);
});

test('a findings array must hold only objects, each with a non-empty string file', () => {
  for (const list of [
    '[1,2]',
    '["app.js","lib.js"]',
    '[{"file":"a.js"},null]',
    '[[{"file":"a.js"}]]',
    '{"findings":[1]}',
    '[{"name":"a"}]',
    '[{"file":""}]',
    '[{"file":"  "}]',
    '[{"file":3}]',
    '{"findings":[{"file":"a.js"},{"line":2}]}',
  ]) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n\`\`\`json\n${list}\n\`\`\`\n` });
    assert.equal(r.ok, false, `${list} must not pass as a findings list`);
    assert.match(r.reason, /no findings list/);
    assert.deepEqual(r.findings, []);
  }
});

const J = (value) => JSON.stringify(value);

const scoredAt = (file, over = {}) => ({ file, line: 1, severity: 5, category: 'correctness', ...over });
const RAW = (...spots) => spots.map(([file, line]) => ({ file, line, summary: `${file} summary`, failure_scenario: 'f' }));
const drop = (file, line, over = {}) => ({ file, line, summary: `${file} summary`, proof: `already handled: ${file}:1 return;`, ...over });

test('accounting: every raw finding is scored or dropped', () => {
  const scored = [scoredAt('a.js'), scoredAt('b.js')];
  const dropped = [drop('c.js', 9)];
  assert.deepEqual(
    checkFindingAccounting({
      rawFindings: RAW(['a.js', 1], ['b.js', 2], ['c.js', 9]),
      findingsText: J({ findings: scored }),
      droppedText: J(dropped),
    }),
    { ok: true, reason: 'ok' },
  );
  assert.equal(
    checkFindingAccounting({ rawFindings: RAW(['a.js', 1], ['b.js', 2]), findingsText: J(scored), droppedText: null }).ok,
    true,
    'a lane file may be a bare array, and a missing dropped file counts as 0',
  );
  assert.equal(checkFindingAccounting({ rawFindings: [], findingsText: J({ findings: [] }), droppedText: '[]' }).ok, true);
});

test('accounting: an omitted finding fails with the numbers', () => {
  const r = checkFindingAccounting({
    rawFindings: RAW(['a.js', 1], ['b.js', 2], ['c.js', 3]),
    findingsText: J({ findings: [scoredAt('a.js')] }),
    droppedText: J([drop('c.js', 3)]),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /found 3/);
  assert.match(r.reason, /scored 1/);
  assert.match(r.reason, /dropped 1/);
  const extra = checkFindingAccounting({
    rawFindings: RAW(['a.js', 1]),
    findingsText: J([scoredAt('a.js'), scoredAt('b.js')]),
    droppedText: null,
  });
  assert.equal(extra.ok, false, 'an added finding is as wrong as an omitted one');
});

test('accounting: a missing or unreadable lane file, or an unreadable dropped file, fails', () => {
  for (const findingsText of [null, '{"findings": [', J({ x: 1 })]) {
    const r = checkFindingAccounting({ rawFindings: [], findingsText, droppedText: '[]' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /findings file/);
  }
  for (const droppedText of ['[{', J({ x: 1 })]) {
    const r = checkFindingAccounting({ rawFindings: [], findingsText: '[]', droppedText });
    assert.equal(r.ok, false);
    assert.match(r.reason, /dropped file/);
  }
});

const dropCheck = (rawFindings, dropped, scored = [], excludedPaths = []) =>
  checkFindingAccounting({ rawFindings, findingsText: J({ findings: scored }), droppedText: J(dropped), excludedPaths });

test('accounting: each dropped entry needs a file, a line, a summary, and a proof', () => {
  const raw = RAW(['a.js', 4]);
  const cases = [
    [{}, /dropped entry 1 needs a non-empty string file/],
    ['a.js:4', /dropped entry 1 needs a non-empty string file/],
    [null, /dropped entry 1 needs a non-empty string file/],
    [drop('', 4), /dropped entry 1 needs a non-empty string file/],
    [drop(7, 4), /dropped entry 1 needs a non-empty string file/],
    [drop('a.js', '4'), /dropped entry 1 needs an integer line, or null when the raw finding has no line/],
    [drop('a.js', 4.5), /dropped entry 1 needs an integer line/],
    [drop('a.js', undefined), /dropped entry 1 needs an integer line/],
    [drop('a.js', 4, { summary: '  ' }), /dropped entry 1 needs a non-empty summary/],
    [drop('a.js', 4, { summary: undefined }), /dropped entry 1 needs a non-empty summary/],
    [drop('a.js', 4, { proof: '' }), /dropped entry 1 needs a non-empty proof/],
    [drop('a.js', 4, { proof: undefined }), /dropped entry 1 needs a non-empty proof/],
  ];
  for (const [entry, reason] of cases) {
    const r = dropCheck(raw, [entry]);
    assert.equal(r.ok, false, JSON.stringify(entry));
    assert.match(r.reason, reason, JSON.stringify(entry));
  }
});

test('accounting: each dropped entry matches its own raw finding by file and line', () => {
  const raw = RAW(['a.js', 4], ['b.js', null]);
  const scored = [scoredAt('x.js')];

  const elsewhere = dropCheck(raw, [drop('a.js', 5)], scored);
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.reason, /dropped entry 1 \(a\.js:5\) matches no raw \/code-review finding at that file and line/);

  const otherFile = dropCheck(raw, [drop('c.js', 4)], scored);
  assert.equal(otherFile.ok, false);
  assert.match(otherFile.reason, /\(c\.js:4\) matches no raw/);

  const lineless = dropCheck(raw, [drop('a.js', null)], scored);
  assert.equal(lineless.ok, false, 'null fits only a raw finding with no line');
  assert.match(lineless.reason, /\(a\.js, no line\) matches no raw/);

  const twice = dropCheck(RAW(['a.js', 4], ['b.js', 2]), [drop('a.js', 4), drop('a.js', 4)]);
  assert.equal(twice.ok, false, 'one raw finding cannot cover two drops');
  assert.match(twice.reason, /dropped entry 2 \(a\.js:4\) matches a raw finding that another dropped entry already accounts for/);

  assert.deepEqual(dropCheck(raw, [drop('b.js', null)], scored), { ok: true, reason: 'ok' });
  assert.deepEqual(
    dropCheck(RAW(['a.js', 4], ['a.js', 4]), [drop('a.js', 4), drop('a.js', 4)]),
    { ok: true, reason: 'ok' },
    'two raw findings at one spot can each be dropped',
  );
  assert.deepEqual(
    dropCheck([{ file: 'r.js', line: '42-45', summary: 's' }], [drop('r.js', 42)]),
    { ok: true, reason: 'ok' },
    'a raw line range matches its first line',
  );
});

test('accounting: only a number at the start of a raw line counts', () => {
  const raw = [{ file: 'r.js', line: 'L42', summary: 's' }];
  const numbered = dropCheck(raw, [drop('r.js', 42)]);
  assert.equal(numbered.ok, false, '"L42" does not start with a number, so it has no line');
  assert.match(numbered.reason, /\(r\.js:42\) matches no raw/);
  assert.deepEqual(dropCheck(raw, [drop('r.js', null)]), { ok: true, reason: 'ok' });
  assert.deepEqual(dropCheck([{ file: 'r.js', line: ' 42 ', summary: 's' }], [drop('r.js', 42)]), { ok: true, reason: 'ok' });
});

test('accounting: every scored finding needs a numeric severity from 1 to 10', () => {
  const raw = RAW(['a.js', 1], ['b.js', 2]);
  const check = (severity) =>
    checkFindingAccounting({
      rawFindings: raw,
      findingsText: J({ findings: [scoredAt('a.js'), scoredAt('b.js', { line: 2, severity })] }),
      droppedText: '[]',
    });
  for (const severity of [1, 10, 7.5, 6.5]) {
    assert.deepEqual(check(severity), { ok: true, reason: 'ok' }, String(severity));
  }
  for (const [severity, shown] of [['8/10', '"8/10"'], ['8', '"8"'], [undefined, 'none'], [null, 'null'], [0, '0'], [11, '11'], [-2, '-2'], [true, 'true']]) {
    const r = check(severity);
    assert.equal(r.ok, false, String(severity));
    assert.equal(
      r.reason,
      `the code-review scored finding 2 (b.js:2) needs a numeric severity from 1 to 10, not ${shown}`,
      String(severity),
    );
  }
  for (const entry of [5, null, 'a.js:2', [{ file: 'b.js' }]]) {
    const r = checkFindingAccounting({ rawFindings: raw, findingsText: J([scoredAt('a.js'), entry]), droppedText: '[]' });
    assert.equal(r.ok, false, JSON.stringify(entry));
    assert.equal(r.reason, 'the code-review scored finding 2 is not an object', JSON.stringify(entry));
  }
  const unanchored = checkFindingAccounting({
    rawFindings: RAW(['a.js', null]),
    findingsText: J([scoredAt('a.js', { line: null, severity: 'high' })]),
    droppedText: null,
  });
  assert.match(unanchored.reason, /scored finding 1 \(a\.js, no line\) needs a numeric severity/);
});

test('accounting: every scored finding names one of the nine categories', () => {
  const raw = RAW(['a.js', 1]);
  const check = (category) =>
    checkFindingAccounting({ rawFindings: raw, findingsText: J([scoredAt('a.js', { category })]), droppedText: '[]' });
  for (const category of ['correctness', 'security', 'data-integrity', 'testing', 'simplification', 'efficiency', 'reuse', 'altitude', 'conventions']) {
    assert.deepEqual(check(category), { ok: true, reason: 'ok' }, category);
  }
  for (const [category, shown] of [['bug', '"bug"'], ['Correctness', '"Correctness"'], [' reuse', '" reuse"'], [undefined, 'none']]) {
    const r = check(category);
    assert.equal(r.ok, false, String(category));
    assert.equal(
      r.reason,
      `the code-review scored finding 1 (a.js:1) has category ${shown}, which is not one of the nine names: correctness, security, data-integrity, testing, simplification, efficiency, reuse, altitude, conventions`,
    );
  }
});

test('accounting: an excluded-path drop needs a configured glob that matches the file', () => {
  const raw = RAW(['dist/app.js', 4], ['src/a.js', 2]);
  const excluded = (file, line, glob) => drop(file, line, { proof: `excluded path: ${glob}` });
  const config = ['dist/**', 'vendor/**', '**/*.min.js'];

  assert.deepEqual(dropCheck(raw, [excluded('dist/app.js', 4, 'dist/**')], [scoredAt('src/a.js', { line: 2 })], config), { ok: true, reason: 'ok' });
  assert.deepEqual(
    dropCheck(RAW(['.cache/x.js', 1]), [excluded('.cache/x.js', 1, '**/*.js')], [], ['**/*.js']),
    { ok: true, reason: 'ok' },
    'globs match dotfiles, as selectAgents does',
  );

  const unlisted = dropCheck(raw, [excluded('dist/app.js', 4, 'dist/*')], [scoredAt('src/a.js', { line: 2 })], config);
  assert.equal(unlisted.ok, false);
  assert.equal(unlisted.reason, 'the code-review dropped entry 1 (dist/app.js:4) cites excluded path "dist/*", which is not in the config\'s excluded_paths');

  const none = dropCheck(raw, [excluded('dist/app.js', 4, 'dist/**')], [scoredAt('src/a.js', { line: 2 })]);
  assert.equal(none.ok, false, 'a repo with no excluded_paths accepts no excluded-path drop');
  assert.match(none.reason, /cites excluded path "dist\/\*\*", which is not in the config's excluded_paths/);

  const mismatch = dropCheck(raw, [excluded('src/a.js', 2, 'dist/**')], [scoredAt('dist/app.js', { line: 4 })], config);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'the code-review dropped entry 1 (src/a.js:2) cites excluded path "dist/**", which src/a.js does not match');

  const prefixes = [
    'Excluded path: ',
    '  excluded path:',
    'EXCLUDED PATH: ',
    'Excluded paths: ',
    'excluded path - ',
    'excluded path : ',
    'excluded  path: ',
    'excluded_path: ',
    'excluded-paths - ',
  ];
  for (const prefix of prefixes) {
    const unlisted = dropCheck(raw, [drop('dist/app.js', 4, { proof: `${prefix}dist/*` })], [scoredAt('src/a.js', { line: 2 })], config);
    assert.equal(unlisted.ok, false, `${prefix} is still checked`);
    assert.match(unlisted.reason, /cites excluded path "dist\/\*", which is not in the config's excluded_paths/, prefix);
    const listed = dropCheck(raw, [drop('dist/app.js', 4, { proof: `${prefix}dist/**` })], [scoredAt('src/a.js', { line: 2 })], config);
    assert.deepEqual(listed, { ok: true, reason: 'ok' }, prefix);
  }
  assert.deepEqual(
    dropCheck(raw, [drop('dist/app.js', 4, { proof: 'Excluded paths do not apply: already handled: dist/app.js:3 return;' })], [scoredAt('src/a.js', { line: 2 })], config),
    { ok: true, reason: 'ok' },
    'an ordinary proof that only mentions excluded paths is not an excluded-path drop',
  );

  const elsewhere = dropCheck(raw, [excluded('dist/app.js', 9, 'dist/**')], [scoredAt('src/a.js', { line: 2 })], config);
  assert.equal(elsewhere.ok, false, 'an excluded-path drop still matches its own raw finding');
  assert.match(elsewhere.reason, /\(dist\/app\.js:9\) matches no raw/);
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

test('plain text is read only when the result has no list block', () => {
  const line = 'a.js:1 — x';
  const cases = [
    `${HEADER}\n\nResult:\n${line}\n\n\`\`\`json\n[{"file":"a.js",\n\`\`\`\n`,
    `${HEADER}\n\nResult:\n\`\`\`json\n[{"file":"a.js",\n${line}\n`,
    `${HEADER}\n\nResult:\n${line}\n\n\`\`\`json\n[1,2]\n\`\`\`\n`,
  ];
  for (const rawText of cases) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false, rawText);
    assert.equal(r.reason, NEW_REASON);
    assert.deepEqual(r.findings, []);
  }
});

test('an unbackticked colon is not a finding separator', () => {
  const raw = `${HEADER}\n\nResult:\nERROR:12: boom\nlocalhost:3000: server started\n`;
  const r = checkCodeReviewProof({ rawText: raw });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NEW_REASON);
});

test('text findings need the Result: marker', () => {
  const r = checkCodeReviewProof({ rawText: `${HEADER}\n\napp.js:13 — something.\n` });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NEW_REASON);
});

const SECTIONED = [
  'Result:',
  'Correctness:',
  '- `app.js:13` — No fallback to user.name.',
  '   Failure scenario: displayName({ name: "Ann" }) throws.',
  'Cleanup:',
  '(none)',
].join('\n');

test('a "(none)" under one heading never hides a finding line under another', () => {
  for (const empty of ['(none)', 'No findings.']) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED.replace('(none)', empty)}\n` });
    assert.equal(r.ok, true, empty);
    assert.deepEqual(r.findings, [{
      file: 'app.js',
      line: 13,
      summary: 'No fallback to user.name.',
      failure_scenario: 'displayName({ name: "Ann" }) throws.',
    }]);
  }
});

const block = (info, content) => `\`\`\`${info}\n${content}\n\`\`\`\n`;

test('a code block with another label neither qualifies nor stops the text parse', () => {
  const fix = block('js', 'return user.profile?.nickname ?? user.name;');
  const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\nSuggested fix:\n${fix}` });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, 'app.js');

  const none = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('ruby', 'x = 1')}` });
  assert.equal(none.ok, true);
  assert.deepEqual(none.findings, []);

  const listShaped = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('js', JSON.stringify(FINDINGS))}` });
  assert.equal(listShaped.ok, true, 'a js block is never the findings list');
  assert.deepEqual(listShaped.findings, []);
});

test('lines inside a skipped code block are not finding lines', () => {
  const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('diff', '- app.js:3 - stale comment')}` });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('a list-like block that does not qualify fails closed, even next to a real list', () => {
  const quoted = block('json', '[{"name":"a"}]');
  const alone = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\npackage list:\n${quoted}` });
  assert.equal(alone.ok, false, 'a list-like block that does not qualify still fails closed');
  assert.equal(alone.reason, NEW_REASON);
  assert.deepEqual(alone.findings, []);

  const real = block('json', JSON.stringify(FINDINGS));
  for (const rawText of [`${HEADER}\n\nResult:\n${quoted}\n${real}`, `${HEADER}\n\nResult:\n${real}\n${quoted}`]) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false, rawText);
    assert.equal(r.reason, NEW_REASON);
    assert.deepEqual(r.findings, []);
  }
});

test('a readable [] never covers for an unreadable real list', () => {
  const broken = [
    block('json', '[{"file": null, "line": 3, "summary": "s"}]'),
    block('json', '[{"file": "a.js", "line": 3, "summary": "s"},]'),
    block('', '[{"file": "a.js", "line": 3, "summary": "s"},]'),
    block('json', '{"findings": [{"file": "a.js"},], "level": "high"}'),
    block('json', '{"findings": "none"}'),
  ];
  for (const bad of broken) {
    for (const empty of [block('json', '[]'), block('', '{"findings":[]}')]) {
      for (const rawText of [
        `${HEADER}\n\nResult:\n${bad}\nSuggested fix:\n${empty}`,
        `${HEADER}\n\nResult:\n${empty}\n${bad}`,
        `${HEADER}\n\n${SECTIONED}\n\n${bad}\n${empty}`,
      ]) {
        const r = checkCodeReviewProof({ rawText });
        assert.equal(r.ok, false, rawText);
        assert.equal(r.reason, NEW_REASON, rawText);
        assert.deepEqual(r.findings, [], rawText);
      }
    }
  }
});

test('a JSON block that is not list-like is ignored', () => {
  const textFinding = [{
    file: 'app.js',
    line: 13,
    summary: 'No fallback to user.name.',
    failure_scenario: 'displayName({ name: "Ann" }) throws.',
  }];
  for (const quoted of [
    block('json', '{"version":"1.1.0"}'),
    block('json', '{\n  "name": "agent-review",\n  "private": true\n}'),
    block('json', '"just a string"'),
    block('json', '42'),
    block('json', 'not json at all'),
    block('', '{"name":"a"}'),
    block('', '{ name: "a" }'),
  ]) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\nThe config reads:\n${quoted}` });
    assert.equal(r.ok, true, quoted);
    assert.deepEqual(r.findings, textFinding, quoted);

    const withList = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n${quoted}\n${block('json', JSON.stringify(FINDINGS))}` });
    assert.equal(withList.ok, true, quoted);
    assert.deepEqual(withList.findings, FINDINGS, quoted);
  }

  const inside = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('json', '{"note": "x"}\napp.js:3 - not a finding')}`,
  });
  assert.equal(inside.ok, true, 'an unparseable json block that starts with { but has no "findings" is ignored');
  assert.deepEqual(inside.findings, [], 'its lines are never finding lines');
});

test('an unlabeled block that starts with [ or { follows the json rules', () => {
  const real = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n${block('', JSON.stringify(FINDINGS))}` });
  assert.equal(real.ok, true);
  assert.equal(real.findings.length, 2);

  const indented = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n${block('', `  ${JSON.stringify(FINDINGS, null, 2)}`)}` });
  assert.equal(indented.ok, true, 'the content is trimmed before the check');
  assert.equal(indented.findings.length, 2);

  for (const quoted of ['[{"name":"a"}]', '[1,2', '{"findings": [1]}', '{ "findings": [', '{"x": 1, "findings": null}']) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\n${block('', quoted)}` });
    assert.equal(r.ok, false, `${quoted} must fail closed`);
    assert.equal(r.reason, NEW_REASON);
    assert.deepEqual(r.findings, []);
  }
});

test('an unlabeled code snippet neither qualifies nor stops the text parse', () => {
  const code = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\n${block('', 'return user.name;')}` });
  assert.equal(code.ok, true);
  assert.deepEqual(code.findings, [{
    file: 'app.js',
    line: 13,
    summary: 'No fallback to user.name.',
    failure_scenario: 'displayName({ name: "Ann" }) throws.',
  }]);

  const inside = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('', '- app.js:3 - stale comment')}` });
  assert.equal(inside.ok, true, 'lines inside the snippet are never finding lines');
  assert.deepEqual(inside.findings, []);

  const empty = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n\n${block('', '')}` });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.findings, []);

  const unclosed = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\n\`\`\`\nreturn user.name;\n` });
  assert.equal(unclosed.ok, false, 'an unclosed snippet still fails closed');
  assert.equal(unclosed.reason, NEW_REASON);
});

test('an empty list never erases finding lines after Result:', () => {
  const textFinding = [{
    file: 'app.js',
    line: 13,
    summary: 'No fallback to user.name.',
    failure_scenario: 'displayName({ name: "Ann" }) throws.',
  }];
  for (const empty of [block('json', '[]'), block('', '[]'), block('json', '{"findings":[]}')]) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\n${SECTIONED}\n\nSuggested fix:\n${empty}` });
    assert.equal(r.ok, true, empty);
    assert.deepEqual(r.findings, textFinding, empty);
  }

  const lone = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nAll good.\n\n${block('json', '[]')}` });
  assert.equal(lone.ok, true, 'a lone [] with no finding lines still passes');
  assert.deepEqual(lone.findings, []);

  const real = checkCodeReviewProof({
    rawText: `${HEADER}\n\n${SECTIONED}\n\n${block('json', '[]')}\n${block('json', JSON.stringify(FINDINGS))}`,
  });
  assert.equal(real.ok, true);
  assert.deepEqual(real.findings, FINDINGS, 'a non-empty JSON list still wins over finding lines');
});

test('a later [] never replaces a real findings list', () => {
  const real = block('json', JSON.stringify(FINDINGS));
  for (const empty of [block('json', '[]'), block('', '[]'), block('json', '{"findings":[]}')]) {
    for (const rawText of [`${HEADER}\n\nResult:\n${real}\nSuggested fix:\n${empty}`, `${HEADER}\n\nResult:\n${empty}\n${real}`]) {
      const r = checkCodeReviewProof({ rawText });
      assert.equal(r.ok, true, rawText);
      assert.deepEqual(r.findings, FINDINGS, rawText);
    }
  }

  const other = [{ file: 'lib.js', line: 2, summary: 'a later real list' }];
  const last = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n${real}\n${block('json', '[]')}\n${block('json', JSON.stringify(other))}` });
  assert.deepEqual(last.findings, other, 'the last non-empty list wins');

  const lone = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nAll good.\n\n${block('json', '[]')}` });
  assert.equal(lone.ok, true, 'a lone [] still passes');
  assert.deepEqual(lone.findings, []);
});

test('a truncated JSON list fails closed over prose, finding lines, and "(none)"', () => {
  for (const tail of ['', '\nNo findings.\n', '\n(none)\n', `\n${SECTIONED}\n`]) {
    for (const truncated of ['```json\n[{"file":"a.js",\n```\n', '```json\n[{"file":"a.js",\n']) {
      const rawText = `${HEADER}\n\n${PROSE}\n${tail}\n${truncated}`;
      const r = checkCodeReviewProof({ rawText });
      assert.equal(r.ok, false, rawText);
      assert.equal(r.reason, NEW_REASON);
      assert.deepEqual(r.findings, []);
    }
  }
});

test('"(none)" counts only after Result:, so with no Result: line nothing passes', () => {
  const cases = [
    `${HEADER}\n\nCorrectness:\napp.js:13 - real bug\nCleanup:\n(none)\n`,
    `${HEADER}\n\nNo findings.\n`,
    `${HEADER}\n\n(none)\n\nResult:\nAll good.\n`,
  ];
  for (const rawText of cases) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false, rawText);
    assert.equal(r.reason, NEW_REASON);
    assert.deepEqual(r.findings, []);
  }
});

test('an unclosed fence of any label fails closed', () => {
  const cases = {
    'unclosed js block swallowing a finding line': `${HEADER}\n\nResult:\n(none)\n\`\`\`js\nconst x = 1;\napp.js:3 - real bug\n`,
    'unclosed ruby block after finding lines': `${HEADER}\n\n${SECTIONED}\n\`\`\`ruby\nx = 1\n`,
    'unclosed json block after a qualifying list': `${HEADER}\n\nResult:\n${block('json', JSON.stringify(FINDINGS))}\`\`\`json\n[{"file":"a.js",\n`,
    'unclosed unlabeled block after a qualifying list': `${HEADER}\n\nResult:\n${block('json', JSON.stringify(FINDINGS))}\`\`\`\n[{"file":"a.js"}]\n`,
  };
  for (const [label, rawText] of Object.entries(cases)) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, NEW_REASON, label);
    assert.deepEqual(r.findings, [], label);
  }
});

test('CommonMark fences: up to 3 leading spaces, backticks or tildes, closed by the same character', () => {
  const truncated = '[{"file":"a.js",';
  const failing = {
    'indented json block': `${HEADER}\n\nResult:\n(none)\n   \`\`\`json\n${truncated}\n   \`\`\`\n`,
    'tilde json block': `${HEADER}\n\nResult:\n(none)\n~~~json\n${truncated}\n~~~\n`,
    'tilde block closed by backticks': `${HEADER}\n\nResult:\n~~~json\n${JSON.stringify(FINDINGS)}\n\`\`\`\n`,
    'backtick block closed by tildes': `${HEADER}\n\nResult:\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n~~~\n`,
    'four-backtick block closed by three': `${HEADER}\n\nResult:\n\`\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\`\n`,
  };
  for (const [label, rawText] of Object.entries(failing)) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, NEW_REASON, label);
  }
  const passing = {
    'tilde json list': `${HEADER}\n\nResult:\n~~~json\n${JSON.stringify(FINDINGS)}\n~~~\n`,
    'indented json list': `${HEADER}\n\nResult:\n  \`\`\`json\n${JSON.stringify(FINDINGS)}\n  \`\`\`\n`,
    'longer closer': `${HEADER}\n\nResult:\n\`\`\`json\n${JSON.stringify(FINDINGS)}\n\`\`\`\`\`\n`,
  };
  for (const [label, rawText] of Object.entries(passing)) {
    const r = checkCodeReviewProof({ rawText });
    assert.equal(r.ok, true, label);
    assert.deepEqual(r.findings, FINDINGS, label);
  }
  const tildeCode = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n(none)\n~~~ruby\nx = 1\n~~~\n` });
  assert.equal(tildeCode.ok, true, 'a closed tilde code example is skipped like a backtick one');
});

test('a bare text location must look like a path', () => {
  const host = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nlocalhost:3000 - is where the dev server listens\n` });
  assert.equal(host.ok, false, 'localhost is not a file');
  assert.equal(host.reason, NEW_REASON);

  const mixed = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\nlocalhost:3000 - is where the dev server listens\nsrc/a.js:4 - a real one\nMakefile.am:2 \u2014 dotted\n`,
  });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.findings.map((f) => f.file), ['src/a.js', 'Makefile.am']);

  const backticked = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n\`Makefile:3\` \u2014 wrong target\n` });
  assert.equal(backticked.ok, true, 'a backticked location needs no / or .');
  assert.deepEqual(backticked.findings, [{ file: 'Makefile', line: 3, summary: 'wrong target' }]);
});

test('a line range right after the line number is part of the location', () => {
  for (const dash of ['-', '\u2013', '\u2014']) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nsrc/a.js:12${dash}15 \u2014 wrong branch\n` });
    assert.equal(r.ok, true, dash);
    assert.deepEqual(r.findings, [{ file: 'src/a.js', line: 12, summary: 'wrong branch' }], dash);
  }
  const plain = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nsrc/a.js:12-15 - wrong branch\n` });
  assert.deepEqual(plain.findings, [{ file: 'src/a.js', line: 12, summary: 'wrong branch' }]);
  const dashed = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nsrc/a.js:12\u2013fix the branch\n` });
  assert.deepEqual(dashed.findings, [{ file: 'src/a.js', line: 12, summary: 'fix the branch' }], 'a dash before words is still the separator');
});

test('a numbered-list marker needs a space after its dot', () => {
  const ip = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n127.0.0.1:3000 - is where the dev server listens\n` });
  assert.equal(ip.ok, false, 'an address is not a numbered finding on file 0.0.1');
  assert.equal(ip.reason, NEW_REASON);

  const dated = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n2024.10/notes.md:3 - stale date\n` });
  assert.deepEqual(dated.findings, [{ file: '2024.10/notes.md', line: 3, summary: 'stale date' }]);

  const numbered = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n1. a.js:3 - off by one\n12.  src/b.js:4 - another\n` });
  assert.deepEqual(numbered.findings, [
    { file: 'a.js', line: 3, summary: 'off by one' },
    { file: 'src/b.js', line: 4, summary: 'another' },
  ]);
});

test('a bare location may name an existing file with no / or .', () => {
  const exists = (names) => (path) => names.includes(path);
  const make = checkCodeReviewProof({
    rawText: `${HEADER}\n\nResult:\nMakefile:12 - the test target skips lint\nsrc/a.js:4 - a real one\n`,
    fileExists: exists(['Makefile']),
  });
  assert.equal(make.ok, true);
  assert.deepEqual(make.findings, [
    { file: 'Makefile', line: 12, summary: 'the test target skips lint' },
    { file: 'src/a.js', line: 4, summary: 'a real one' },
  ]);

  for (const line of ['localhost:3000 - is where the dev server listens', '127.0.0.1:3000 - the dev server']) {
    const r = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\n${line}\n`, fileExists: exists([]) });
    assert.equal(r.ok, false, line);
    assert.equal(r.reason, NEW_REASON, line);
  }

  const noCallback = checkCodeReviewProof({ rawText: `${HEADER}\n\nResult:\nMakefile:12 - x\nsrc/a.js:4 - y\n` });
  assert.deepEqual(noCallback.findings.map((f) => f.file), ['src/a.js'], 'without the callback the path rule alone applies');
});
