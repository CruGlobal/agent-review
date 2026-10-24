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

// Grounding: the lane's raw list against the captured /code-review text.

const {
  CAPTURE_LIMIT_MINUTES,
  jsonFindings,
  explicitEmpty,
  findingLines,
  jsonLine,
  repoRelative,
  looksFinished,
  checkGrounding,
} = require('./codeReviewProof.cjs');
const { EFFORTS } = require('./vocabulary.cjs');
const { CAPTURE_SOURCE } = require('./captureHook.cjs');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const XHIGH_RESULT = readFileSync(join(__dirname, '../fixtures/code-review/xhigh-result.txt'), 'utf8');
const fenced = (info, content) => `\`\`\`${info}\n${content}\n\`\`\`\n`;
const captureOf = (result, over = {}) => ({
  source: CAPTURE_SOURCE,
  mode: 'forked',
  run_id: 'r1',
  args: 'xhigh 12',
  fork_id: 'f1',
  result,
  transcript: null,
  stop_count: 1,
  ts: 1,
  ...over,
});
const raws = (...spots) => spots.map(([file, line], i) => ({ n: i + 1, file, line, summary: `${file} finding ${i + 1}` }));
const ground = (result, rawEntries, over = {}) =>
  checkGrounding({ capture: captureOf(result), runId: 'r1', rawEntries, fileExists: () => false, root: '/repo', ...over });
const assertGrounded = (r, mode, label) => {
  assert.deepEqual(r, { ok: true, stage: null, reason: 'ok', mode }, label);
};
const assertFails = (r, stage, label) => {
  assert.equal(r.ok, false, label);
  assert.equal(r.stage, stage, `${label}: ${r.reason}`);
  assert.equal(typeof r.reason, 'string', label);
  assert.notEqual(r.reason, '', label);
};
const XHIGH_SPOTS = [
  ['app.js', 13],
  ['app.js', 13],
  ['app.js', 13],
  ['app.js', 13],
  ['app.js', 4],
  ['app.js', 5],
  ['app.js', 13],
  ['app.js', 12],
];

test('the capture limits per effort cover every effort', () => {
  assert.deepEqual({ ...CAPTURE_LIMIT_MINUTES }, { low: 10, medium: 15, high: 20, xhigh: 40, max: 120 });
  assert.deepEqual(Object.keys(CAPTURE_LIMIT_MINUTES), EFFORTS);
});

test('xhigh spike result grounds a matching raw list', () => {
  assert.doesNotMatch(XHIGH_RESULT, /\/(?:private|tmp|Users|home)\//, 'the public fixture holds no local absolute path');
  assert.match(XHIGH_RESULT, /touches only `app\.js`/);
  const { list, problem } = jsonFindings(XHIGH_RESULT);
  assert.equal(problem, null);
  assert.deepEqual(list.map((f) => [f.file, f.line]), XHIGH_SPOTS);
  assertGrounded(ground(XHIGH_RESULT, raws(...XHIGH_SPOTS)), 'json');
  assertGrounded(
    ground(XHIGH_RESULT, raws(...XHIGH_SPOTS.map(([file, line], i) => [i % 2 ? `/repo/${file}` : `./${file}`, line]))),
    'json',
    'paths compare repo-relative',
  );
});

test('json raw list must match count, file, and line one to one', () => {
  const cases = {
    'one short': XHIGH_SPOTS.slice(0, -1),
    'one extra': [...XHIGH_SPOTS, ['app.js', 13]],
    'two swapped': [...XHIGH_SPOTS.slice(0, 4), XHIGH_SPOTS[5], XHIGH_SPOTS[4], ...XHIGH_SPOTS.slice(6)],
    'a wrong line': [...XHIGH_SPOTS.slice(0, -1), ['app.js', 11]],
    'a wrong file': [...XHIGH_SPOTS.slice(0, -1), ['lib/app.js', 12]],
    'a null line for a lined finding': [...XHIGH_SPOTS.slice(0, -1), ['app.js', null]],
    'an empty list': [],
  };
  for (const [label, spots] of Object.entries(cases)) {
    const r = ground(XHIGH_RESULT, raws(...spots));
    assertFails(r, 'lane', label);
    assert.equal(r.mode, 'json', label);
  }
  assert.match(ground(XHIGH_RESULT, raws(...cases['one short'])).reason, /8\b.*\b7|7\b.*\b8/);
  assert.match(ground(XHIGH_RESULT, raws(...cases['two swapped'])).reason, /raw entry 5\b/);
});

test('json line "42-45" grounds raw line 42, and "L42" grounds null', () => {
  const result = fenced('json', J([
    { file: 'a.rb', line: '42-45', summary: 'x' },
    { file: 'b.rb', line: 'L42', summary: 'y' },
    { file: 'c.rb', summary: 'z' },
    { file: 'd.rb', line: 'n/a', summary: 'w' },
  ]));
  assertGrounded(ground(result, raws(['a.rb', 42], ['b.rb', null], ['c.rb', null], ['d.rb', null])), 'json');
  assertFails(ground(result, raws(['a.rb', 42], ['b.rb', 42], ['c.rb', null], ['d.rb', null])), 'lane', 'L42 is no line');
  assertFails(ground(result, raws(['a.rb', 45], ['b.rb', null], ['c.rb', null], ['d.rb', null])), 'lane', 'a range is its start');

  assert.equal(jsonLine(7), 7);
  assert.equal(jsonLine('42-45'), 42);
  assert.equal(jsonLine('42'), 42);
  assert.equal(jsonLine('L42'), null);
  assert.equal(jsonLine('n/a'), null);
  assert.equal(jsonLine(4.5), null);
  assert.equal(jsonLine(null), null);
  assert.equal(jsonLine(undefined), null);
  assert.equal(jsonLine([42]), null);
});

test('jsonLine returns null for 0 or a negative number', () => {
  for (const value of [0, -0, -1, -42, '0', '00', ' 0', '-3', '-3-5']) {
    assert.equal(jsonLine(value), null, J(value));
  }
  assert.equal(jsonLine(1), 1);
  assert.equal(jsonLine('01'), 1);
  const result = fenced('json', J([
    { file: 'a.rb', line: 0, summary: 'a file-level finding' },
    { file: 'b.rb', line: -2, summary: 'x' },
    { file: 'c.rb', line: '0', summary: 'y' },
  ]));
  assertGrounded(ground(result, raws(['a.rb', null], ['b.rb', null], ['c.rb', null])), 'json');
  assertFails(ground(result, raws(['a.rb', 0], ['b.rb', null], ['c.rb', null])), 'lane', 'a raw line of 0 is still a shape error');
});

test('a quoted [] after a real list never replaces it', () => {
  const real = fenced('json', J([{ file: 'a.rb', line: 3, summary: 's' }]));
  for (const empty of [fenced('json', '[]'), fenced('', '[]'), fenced('json', '{"findings":[]}')]) {
    for (const result of [`Findings:\n${real}\nSuggested fix:\n${empty}`, `${empty}\n${real}`]) {
      assert.deepEqual(jsonFindings(result), { list: [{ file: 'a.rb', line: 3, summary: 's' }], problem: null });
      assertGrounded(ground(result, raws(['a.rb', 3])), 'json');
      assertFails(ground(result, []), 'lane', 'the [] does not make an empty raw list pass');
    }
  }
  const later = fenced('json', J([{ file: 'b.rb', line: 9 }]));
  assert.deepEqual(jsonFindings(`${real}${fenced('json', '[]')}${later}`).list, [{ file: 'b.rb', line: 9 }], 'the last non-empty list wins');
  assert.deepEqual(jsonFindings(`All good.\n${fenced('json', '[]')}`), { list: [], problem: null });
  assert.deepEqual(jsonFindings('All good.'), { list: null, problem: null });
});

test('an unusable list-like block fails with stage capture even beside a usable one', () => {
  const real = fenced('json', J([{ file: 'a.rb', line: 3, summary: 's' }]));
  for (const bad of [
    '[{"line": 3}]',
    '[{"file": "a.rb", "line": 3},]',
    '{"findings": "none"}',
    '{"findings": [{"file": ""}]}',
    '[1, 2]',
  ]) {
    for (const info of ['json', '']) {
      for (const result of [`${real}\n${fenced(info, bad)}`, `${fenced(info, bad)}\n${real}`]) {
        assert.equal(typeof jsonFindings(result).problem, 'string', result);
        const r = ground(result, raws(['a.rb', 3]));
        assertFails(r, 'capture', result);
        assert.equal(r.mode, null, result);
      }
    }
  }
});

test('a list padded with a no-break space or BOM is usable (final review #42)', () => {
  for (const pad of ['\u00a0', '\ufeff', '  ']) {
    const result = fenced('json', `${pad}${J([{ file: 'a.rb', line: 3 }])}${pad}`);
    assert.deepEqual(jsonFindings(result), { list: [{ file: 'a.rb', line: 3 }], problem: null }, J(pad));
  }
});

test('a quoted JSON config object is ignored', () => {
  const config = fenced('json', '{"engine": {"name": "x"}, "excluded_paths": ["dist/**"]}');
  for (const quoted of [config, fenced('json', '"just a string"'), fenced('', '{ name: "a" }'), fenced('ruby', '[1, 2')]) {
    assert.deepEqual(jsonFindings(`The config reads:\n${quoted}`), { list: null, problem: null }, quoted);
    assertGrounded(ground(`(none)\n\nThe config reads:\n${quoted}`, []), 'empty', quoted);
    assertGrounded(ground(`${quoted}\n${fenced('json', J([{ file: 'a.rb', line: 3 }]))}`, raws(['a.rb', 3])), 'json', quoted);
  }
});

test('an unclosed fence fails with stage capture', () => {
  const real = fenced('json', J([{ file: 'a.rb', line: 3 }]));
  for (const result of [
    '```json\n[{"file": "a.rb", "line": 3',
    '(none)\n```ruby\nx = 1\n',
    '- a.rb:3: bug\n```\n',
    `${real}\`\`\`json\n[{"file": "b.rb"`,
  ]) {
    assert.equal(typeof jsonFindings(result).problem, 'string', result);
    assertFails(ground(result, raws(['a.rb', 3])), 'capture', result);
    assertFails(ground(result, []), 'capture', result);
  }
});

test('an all-empty JSON list never erases text finding lines', () => {
  for (const empty of [fenced('json', '[]'), fenced('', '{"findings": []}')]) {
    const result = `- a.rb:3: total skips the guard\n\nSuggested fix:\n${empty}`;
    assert.deepEqual(jsonFindings(result).list, []);
    const r = ground(result, []);
    assertFails(r, 'lane', 'the finding line is unclaimed');
    assert.equal(r.mode, 'text');
    assertGrounded(ground(result, raws(['a.rb', 3])), 'text');
  }
});

test('text shapes from final review #3 each ground a matching entry', () => {
  for (const [line, file, at] of [
    ['**app/a.rb:12**: x', 'app/a.rb', 12],
    ['1. `a.js:3`: x', 'a.js', 3],
    ['a.rb:12 (pre-existing) - x', 'a.rb', 12],
    ['a.rb:12: x', 'a.rb', 12],
    ['see lib/b.rb:40 where the guard is skipped', 'lib/b.rb', 40],
    ['1. **`src/cart.js:12`** - total() reads items before the empty-cart guard', 'src/cart.js', 12],
    ['- lib/cart.rb:50: `total` multiplies before it rounds', 'lib/cart.rb', 50],
    ['- /repo/lib/cart.rb:50 - an absolute path', 'lib/cart.rb', 50],
    ['| lib/cart.rb:50 | total is wrong |', 'lib/cart.rb', 50],
    ['- [lib/cart.rb:50](https://example.com/lib/cart.rb#L50) total is wrong', 'lib/cart.rb', 50],
    ['- app/(shop)/[id]/page.tsx:8 reads params before the guard', 'app/(shop)/[id]/page.tsx', 8],
  ]) {
    const result = `Correctness:\n${line}\nCleanups:\n(none)\n`;
    assert.deepEqual(
      findingLines(result).map((l) => [l.index, l.mentions.map((m) => [repoRelative(m.file, '/repo'), m.line])]),
      [[1, [[file, at]]]],
      line,
    );
    assertGrounded(ground(result, raws([file, at])), 'text', line);
    assertFails(ground(result, raws([file, at + 1])), 'lane', `${line} at the wrong line`);
    assertFails(ground(result, []), 'lane', `${line} unclaimed`);
  }
});

test('src/a.js:49-59 grounds raw line 49, but not raw line 51', () => {
  for (const dash of ['-', '\u2013', '\u2014']) {
    const result = `src/a.js:49${dash}59 \u2014 x`;
    assert.deepEqual(findingLines(result)[0].mentions, [{ file: 'src/a.js', line: 49 }], J(dash));
    assertGrounded(ground(result, raws(['src/a.js', 49])), 'text', J(dash));
    assertFails(ground(result, raws(['src/a.js', 51])), 'lane', J(dash));
    assertFails(ground(result, raws(['src/a.js', 59])), 'lane', J(dash));
  }
});

test('a nested bullet with a mention fails when no raw entry claims it', () => {
  const result = '- a.rb:3: total skips the guard\n  - b.rb:9 calls total() with an empty cart\n';
  const r = ground(result, raws(['a.rb', 3]));
  assertFails(r, 'lane', 'the nested bullet is a finding line');
  assert.match(r.reason, /line 2\b/);
  assert.match(r.reason, /b\.rb:9/);
  assertGrounded(ground(result, raws(['a.rb', 3], ['b.rb', 9])), 'text');
});

test('two findings at one location need two raw entries', () => {
  const result = '- a.rb:3: total skips the guard\n- a.rb:3: total also rounds too early\n';
  assertFails(ground(result, raws(['a.rb', 3])), 'lane', 'one entry for two lines');
  assertGrounded(ground(result, raws(['a.rb', 3], ['a.rb', 3])), 'text');
  const extra = ground(result, raws(['a.rb', 3], ['a.rb', 3], ['a.rb', 3]));
  assertFails(extra, 'lane', 'three entries for two lines');
  assert.match(extra.reason, /raw entry 3\b/);
});

test('localhost:3000 and https://example.com:443/x are not mentions', () => {
  const prose = 'Start the server at localhost:3000, then open https://example.com:443/x, 127.0.0.1:8080, or file://host/a.rb:3.';
  assert.deepEqual(findingLines(prose, () => false), []);
  assertGrounded(ground(`(none)\n\n${prose}`, []), 'empty');
  assertFails(ground(prose, []), 'capture', 'prose with no marker');

  const exists = (path) => path === 'Gemfile';
  assert.deepEqual(findingLines('Gemfile:12 pins an old rack', exists)[0].mentions, [{ file: 'Gemfile', line: 12 }]);
  assert.deepEqual(findingLines('Gemfile:12 pins an old rack', () => false), [], 'a bare name needs the file to exist');
  assert.deepEqual(findingLines('Gemfile:12 pins an old rack'), [], 'no callback means no bare names');
  assert.deepEqual(findingLines('2026:10 and a.rb:x are not mentions', () => true), []);
});

test('snake_case paths survive normalization', () => {
  for (const [line, file, at] of [
    ['- *app/user_account.rb:7*: the balance is never checked in `user_account.rb`', 'app/user_account.rb', 7],
    ['- pkg/__init__.py:3 imports the package twice', 'pkg/__init__.py', 3],
    ['- `pkg/__init__.py:3`: imports the package twice', 'pkg/__init__.py', 3],
    ['- **app/views/users/_form.html.erb:3**: the field is not escaped', 'app/views/users/_form.html.erb', 3],
    ['- _lib/a_b.rb:9_ is still a finding line, underscores and all', '_lib/a_b.rb', 9],
  ]) {
    assert.deepEqual(findingLines(line)[0].mentions, [{ file, line: at }], line);
    assertGrounded(ground(line, raws([file, at])), 'text', line);
  }
  assertFails(ground('- app/user_account.rb:7: x', raws(['app/useraccount.rb', 7])), 'lane', 'the underscore is kept');
  assertFails(ground('- pkg/__init__.py:3: x', raws(['pkg/_init_.py', 3])), 'lane', 'no underscore is dropped');
  assertGrounded(
    ground('- pkg/__init__.py imports the package twice\n- a.rb:3: bug\n', raws(['pkg/__init__.py', null], ['a.rb', 3])),
    'text',
    'a no-line entry names a dunder path',
  );
});

test('matching is not greedy', () => {
  const result = 'A: x.rb:1 and y.rb:2 disagree about the total\nB: x.rb:1 rounds the total\n';
  assertGrounded(ground(result, raws(['x.rb', 1], ['y.rb', 2])), 'text');
  assertGrounded(ground(result, raws(['y.rb', 2], ['x.rb', 1])), 'text');
});

test('an entry with no line takes a line that names its path and has no mention', () => {
  const result = '- lib/cart.rb never freezes its constants\n- a.rb:3: total skips the guard\n';
  assertGrounded(ground(result, raws(['lib/cart.rb', null], ['a.rb', 3])), 'text');
  assertGrounded(ground(result, raws(['/repo/lib/cart.rb', null], ['a.rb', 3])), 'text');
  assertFails(ground(result, raws(['cart.rb', null], ['a.rb', 3])), 'lane', 'a path inside a longer path is not its path');
  assertFails(ground(result, raws(['a.rb', null], ['a.rb', 3])), 'lane', 'a line with a mention is not a no-line line');
  assertFails(ground(result, raws(['lib/cart.rb', null], ['lib/cart.rb', null], ['a.rb', 3])), 'lane', 'one line per entry');
  const fencedOnly = `${fenced('', 'lib/cart.rb')}- a.rb:3: total skips the guard\n`;
  assertFails(ground(fencedOnly, raws(['lib/cart.rb', null], ['a.rb', 3])), 'lane', 'a fenced line is not text');
  for (const longer of ['lib/cart.rbs', 'lib/cart.rb.bak', 'lib/cart.rb/x', 'lib/cart.rb-old']) {
    const r = ground(`- ${longer} declares the cart types\n- a.rb:3: bug\n`, raws(['lib/cart.rb', null], ['a.rb', 3]));
    assertFails(r, 'lane', `${longer} is not lib/cart.rb`);
  }
  assertGrounded(ground('- The constants live in lib/cart.rb.\n- a.rb:3: bug\n', raws(['lib/cart.rb', null], ['a.rb', 3])), 'text', 'a full stop ends the path');
});

test('finding lines skip fenced lines and index every line of the result', () => {
  const result = `intro\n${fenced('ruby', 'a.rb:1 inside a fence')}- b.rb:2: x\n`;
  assert.deepEqual(findingLines(result).map((l) => [l.index, l.mentions]), [[4, [{ file: 'b.rb', line: 2 }]]]);
  assert.equal(explicitEmpty(`${fenced('', '(none)')}`), false, 'a fenced marker does not count');
  assert.equal(explicitEmpty('  (none)  \r'), true);
  assert.equal(explicitEmpty('No findings.'), true);
  assert.equal(explicitEmpty('- (none)'), false);
  assert.equal(explicitEmpty('No findings. None at all.'), false);
});

test('a 50,000-character whitespace line is read in under 100 ms', () => {
  const lines = [
    ' '.repeat(50000) + 'x',
    '\t'.repeat(50000) + 'a.rb:1',
    ' '.repeat(25000) + 'a.rb:1' + ' '.repeat(25000) + '\r',
    'a'.repeat(50000),
    'a:'.repeat(25000),
    '_'.repeat(50000),
    '*'.repeat(50000) + ':1',
    `${'1-'.repeat(25000)}`,
  ];
  for (const line of lines) {
    const result = `- a.rb:1: bug\n${line}\n`;
    const start = process.hrtime.bigint();
    findingLines(result, () => false);
    explicitEmpty(result);
    jsonFindings(result);
    ground(result, raws(['a.rb', 1], ['a.rb', 1]));
    looksFinished(result, 'max');
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 100, `${J(line.slice(0, 12))}... took ${ms.toFixed(1)} ms`);
  }
});

test('(none) plus an explanation with no mentions grounds an empty raw list', () => {
  for (const result of [
    '(none)\n\nThe diff only renames a local variable in app/a.rb, and nothing else changed.',
    'No findings.\n',
    `All good.\n${fenced('json', '[]')}`,
    `I reviewed it.\n${fenced('json', '{"findings": []}')}`,
  ]) {
    assertGrounded(ground(result, []), 'empty', result);
  }
});

test('text with no finding lines and no marker fails with stage capture', () => {
  for (const result of ['I looked at the diff and it seems fine.', '- lib/cart.rb never freezes its constants', '**(none)**']) {
    const r = ground(result, []);
    assertFails(r, 'capture', result);
    assert.match(r.reason, /no findings list and no explicit \(none\)/);
    assert.equal(r.mode, null);
  }
});

test('a non-empty raw list against (none) fails with stage lane', () => {
  const r = ground('(none)\n', raws(['a.rb', 3]));
  assertFails(r, 'lane', '(none)');
  assert.equal(r.mode, 'empty');
  assertFails(ground(`All good.\n${fenced('json', '[]')}`, raws(['a.rb', 3])), 'lane', 'a lone []');
});

test('the capture must exist, come from the hook, match the run, and hold text', () => {
  const good = captureOf('(none)');
  const cases = [
    ['missing capture', null, /no .*capture/i],
    ['not an object', 'text', /no .*capture/i],
    ['wrong source', { ...good, source: 'something-else' }, /source/],
    ['run_id from another run', { ...good, run_id: 'r2' }, /r2.*r1|r1.*r2/],
    ['no run_id', { ...good, run_id: undefined }, /run/],
    ['result not a string', { ...good, result: null }, /result/],
    ['empty result', { ...good, result: '' }, /empty/],
    ['blank result', { ...good, result: ' \n\t' }, /empty/],
  ];
  for (const [label, capture, reason] of cases) {
    const r = checkGrounding({ capture, runId: 'r1', rawEntries: [], fileExists: () => false, root: '/repo' });
    assertFails(r, 'capture', label);
    assert.match(r.reason, reason, label);
    assert.equal(r.mode, null, label);
  }
  assertGrounded(checkGrounding({ capture: good, runId: 'r1', rawEntries: [], root: '/repo' }), 'empty');
});

test('the raw list must be numbered 1..N with a file, a line, and a summary', () => {
  const result = '- a.rb:3: bug one\n- b.rb:4: bug two\n';
  const good = raws(['a.rb', 3], ['b.rb', 4]);
  assertGrounded(ground(result, good), 'text');
  const skipped = ground(result, [good[0], { ...good[1], n: 3 }]);
  assertFails(skipped, 'lane', 'n that skips a number');
  assert.match(skipped.reason, /\bn\b/);
  assert.equal(skipped.mode, 'text');
  for (const [label, rawEntries] of [
    ['not an array', null],
    ['an object', { findings: good }],
    ['n from 0', good.map((e, i) => ({ ...e, n: i }))],
    ['n as a string', [{ ...good[0], n: '1' }, good[1]]],
    ['an entry that is not an object', [good[0], 'b.rb:4']],
    ['an empty file', [good[0], { ...good[1], file: ' ' }]],
    ['a file that is not a string', [good[0], { ...good[1], file: 4 }]],
    ['a zero line', [good[0], { ...good[1], line: 0 }]],
    ['a string line', [good[0], { ...good[1], line: '4' }]],
    ['a missing line', [good[0], { ...good[1], line: undefined }]],
    ['a fractional line', [good[0], { ...good[1], line: 4.5 }]],
    ['an empty summary', [good[0], { ...good[1], summary: '' }]],
    ['a missing summary', [good[0], { ...good[1], summary: undefined }]],
  ]) {
    assertFails(ground(result, rawEntries), 'lane', label);
  }
});

test('looksFinished waits at max until a findings list or an explicit empty marker appears', () => {
  const list = fenced('json', J([{ file: 'a.rb', line: 3 }]));
  assert.equal(looksFinished('I launched three helpers and will merge their findings.', 'max'), false);
  assert.equal(looksFinished(`Here is the list:\n${list}`, 'max'), true);
  assert.equal(looksFinished(`All good.\n${fenced('json', '[]')}`, 'max'), true);
  assert.equal(looksFinished('(none)', 'max'), true);
  assert.equal(looksFinished('No findings.', 'max'), true);
  assert.equal(looksFinished('', 'max'), false);
  assert.equal(looksFinished('I launched three helpers and will merge their findings.', 'xhigh'), true);
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(looksFinished('', effort), true, `${effort}: an empty result fails in the check, not by waiting`);
    assert.equal(looksFinished(null, effort), false, effort);
  }
  assert.equal(looksFinished(undefined, 'max'), false);
});

test('repoRelative strips the root and a leading ./', () => {
  assert.equal(repoRelative('/repo/app/a.rb', '/repo'), 'app/a.rb');
  assert.equal(repoRelative('/repo/app/a.rb', '/repo/'), 'app/a.rb');
  assert.equal(repoRelative('./app/a.rb', '/repo'), 'app/a.rb');
  assert.equal(repoRelative('app/a.rb', '/repo'), 'app/a.rb');
  assert.equal(repoRelative('/repository/app/a.rb', '/repo'), '/repository/app/a.rb');
  assert.equal(repoRelative('/other/app/a.rb', '/repo'), '/other/app/a.rb');
  assert.equal(repoRelative('/repo/app/a.rb', undefined), '/repo/app/a.rb');
});
