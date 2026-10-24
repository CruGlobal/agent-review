'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const J = (value) => JSON.stringify(value);

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
  checkLaneOutput,
  checkCodeReviewRun,
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
  assert.deepEqual(jsonFindings(`All good.\n${fenced('json', '[]')}`), { list: [], problem: null });
  assert.deepEqual(jsonFindings('All good.'), { list: null, problem: null });
});

test('two different non-empty findings lists fail with stage capture', () => {
  const real = fenced('json', J([{ file: 'lib/a.rb', line: 10, summary: 'injection' }]));
  const example = fenced('json', J([{ file: 'config/x.yml', line: 1 }]));
  const p3 = `Findings:\n${real}Suggested fixture:\n${example}`;
  assert.match(jsonFindings(p3).problem, /2 different findings lists/);
  const r = ground(p3, raws(['config/x.yml', 1]));
  assertFails(r, 'capture', 'the later example list must not hide the real one');
  assertFails(ground(p3, raws(['lib/a.rb', 10])), 'capture', 'neither list is trusted');
  assertFails(ground(`${real}${fenced('json', '[]')}${example}`, raws(['config/x.yml', 1])), 'capture', 'an empty list between them changes nothing');

  const repeated = `${real}\nAgain, in full:\n${fenced('', J([{ file: 'lib/a.rb', line: 10, summary: 'injection' }]))}`;
  assert.deepEqual(jsonFindings(repeated), { list: [{ file: 'lib/a.rb', line: 10, summary: 'injection' }], problem: null });
  assertGrounded(ground(repeated, raws(['lib/a.rb', 10])), 'json');
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

test('a list padded with a no-break space or BOM is usable', () => {
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

test('each supported text shape grounds a matching entry', () => {
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
  ]) {
    assert.deepEqual(findingLines(line)[0].mentions, [{ file, line: at }], line);
    assertGrounded(ground(line, raws([file, at])), 'text', line);
  }
  const italic = '- _lib/a_b.rb:9_ is still a finding line';
  assert.deepEqual(findingLines(italic)[0].mentions, [{ file: '_lib/a_b.rb', line: 9 }], 'the mention keeps its underscores');
  assertGrounded(ground(italic, raws(['lib/a_b.rb', 9])), 'text', 'the emphasis underscore is trimmed when matching');
  assertGrounded(ground(italic, raws(['_lib/a_b.rb', 9])), 'text', 'the path as written still matches');
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
  const inRuby = `${fenced('ruby', 'lib/cart.rb')}- a.rb:3: total skips the guard\n`;
  assertFails(ground(inRuby, raws(['lib/cart.rb', null], ['a.rb', 3])), 'lane', 'a line in a language fence is not text');
  const inPlain = `${fenced('', 'lib/cart.rb never freezes its constants')}- a.rb:3: total skips the guard\n`;
  assertGrounded(ground(inPlain, raws(['lib/cart.rb', null], ['a.rb', 3])), 'text', 'a line in a plain fence is text');
  for (const longer of ['lib/cart.rbs', 'lib/cart.rb.bak', 'lib/cart.rb/x', 'lib/cart.rb-old']) {
    const r = ground(`- ${longer} declares the cart types\n- a.rb:3: bug\n`, raws(['lib/cart.rb', null], ['a.rb', 3]));
    assertFails(r, 'lane', `${longer} is not lib/cart.rb`);
  }
  assertGrounded(ground('- The constants live in lib/cart.rb.\n- a.rb:3: bug\n', raws(['lib/cart.rb', null], ['a.rb', 3])), 'text', 'a full stop ends the path');
});

test('findings inside a plain or prose fence must be claimed', () => {
  const l1 = 'Correctness:\n```\n- a.rb:3: total skips the guard\n```\nCleanups:\n(none)\n';
  const emptyL1 = ground(l1, []);
  assertFails(emptyL1, 'lane', 'L1');
  assert.equal(emptyL1.mode, 'text');
  assert.match(emptyL1.reason, /line 3\b.*a\.rb:3/);
  assertGrounded(ground(l1, raws(['a.rb', 3])), 'text', 'L1 claimed');

  const l2 = 'Correctness:\n```text\n- a.rb:3: total skips the guard\n- b.rb:9: second bug\n```\n- c.rb:1: third bug\n';
  const partialL2 = ground(l2, raws(['c.rb', 1]));
  assertFails(partialL2, 'lane', 'L2');
  assert.match(partialL2.reason, /line 3\b.*a\.rb:3/);
  assertGrounded(ground(l2, raws(['a.rb', 3], ['b.rb', 9], ['c.rb', 1])), 'text', 'L2 claimed');

  for (const info of ['', 'text', 'txt', 'md', 'markdown', 'plain', 'TEXT', 'text title="Findings"']) {
    for (const fence of ['```', '~~~']) {
      const result = `Correctness:\n${fence}${info}\n- a.rb:3: total skips the guard\n${fence}\n(none)\n`;
      assert.deepEqual(findingLines(result).map((l) => [l.index, l.mentions]), [[2, [{ file: 'a.rb', line: 3 }]]], `${fence}${info}`);
      assertFails(ground(result, []), 'lane', `${fence}${info}`);
      assertGrounded(ground(result, raws(['a.rb', 3])), 'text', `${fence}${info}`);
    }
  }
});

test('a fence labeled with a language citing lib/b.rb:9 still needs no claim', () => {
  for (const info of ['ruby', 'js', 'python', 'sh', 'console', 'diff', 'json', 'textile']) {
    const result = `- a.rb:3: total skips the guard. The caller:\n${fenced(info, '# lib/b.rb:9\ntotal(cart) # from lib/b.rb:9:in `checkout`')}`;
    assert.deepEqual(findingLines(result).map((l) => l.index), [0], info);
    assertGrounded(ground(result, raws(['a.rb', 3])), 'text', info);
  }
  const listLike = `All good.\n${fenced('', '{"findings": [], "note": "see lib/b.rb:9"}')}`;
  assert.deepEqual(findingLines(listLike), [], 'a list-like plain fence is JSON, not text');
  assertGrounded(ground(listLike, []), 'empty', 'its quoted location needs no claim');
});

test('a no-line entry grounds on its path written after the root or ./', () => {
  const tail = '- a.rb:3: bug\n';
  assertGrounded(ground(`- /repo/lib/cart.rb never freezes its constants\n${tail}`, raws(['lib/cart.rb', null], ['a.rb', 3])), 'text', 'B1');
  assertGrounded(ground(`- /repo/lib/cart.rb never freezes its constants\n${tail}`, raws(['/repo/lib/cart.rb', null], ['a.rb', 3])), 'text', 'B2');
  assertGrounded(ground(`- ./lib/cart.rb never freezes its constants\n${tail}`, raws(['lib/cart.rb', null], ['a.rb', 3])), 'text', 'B3');
  assertGrounded(
    ground(`- (/repo/lib/cart.rb) never freezes its constants\n${tail}`, raws(['lib/cart.rb', null], ['a.rb', 3]), { root: '/repo/' }),
    'text',
    'a root with a trailing slash',
  );
  for (const other of ['/other/lib/cart.rb', '/x/repo/lib/cart.rb', '../lib/cart.rb', 'x./lib/cart.rb', '/repository/lib/cart.rb']) {
    assertFails(ground(`- ${other} never freezes its constants\n${tail}`, raws(['lib/cart.rb', null], ['a.rb', 3])), 'lane', other);
  }
});

test("a mention's path matches with wrapper characters trimmed", () => {
  assert.deepEqual(findingLines('- "lib/cart.rb":50 bug').map((l) => l.mentions), [[{ file: 'lib/cart.rb"', line: 50 }]], 'C1 finds one mention as written');
  assert.deepEqual(findingLines('- _lib/a.rb_:9 bug').map((l) => l.mentions), [[{ file: '_lib/a.rb_', line: 9 }]], 'C2 finds one mention as written');
  for (const [line, file, at] of [
    ['- "lib/cart.rb":50 bug', 'lib/cart.rb', 50],
    ['- _lib/a.rb_:9 bug', 'lib/a.rb', 9],
    ["- 'lib/a.rb':9 bug", 'lib/a.rb', 9],
    ['- (lib/a.rb):9 bug', 'lib/a.rb', 9],
    ['- [lib/a.rb]:9 bug', 'lib/a.rb', 9],
    ['- {lib/a.rb}:9 bug', 'lib/a.rb', 9],
    ['- <lib/a.rb>:9 bug', 'lib/a.rb', 9],
    ['- "/repo/lib/a.rb":9 bug', 'lib/a.rb', 9],
  ]) {
    assertGrounded(ground(line, raws([file, at])), 'text', line);
    assertFails(ground(line, raws([file, at + 1])), 'lane', `${line} at the wrong line`);
    assertFails(ground(line, []), 'lane', `${line} unclaimed`);
  }
  assertFails(ground('- lib/a.rb:9 bug', raws(['_lib/a.rb', 9])), 'lane', 'trimming applies to the mention, not the raw entry');
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
    'a.rb' + ')'.repeat(50000) + ':1',
    '_'.repeat(50000) + 'a.rb' + '_'.repeat(50000) + ':1',
    'a.rb '.repeat(10000),
    './'.repeat(25000) + 'a.rb',
    '/repo/'.repeat(8000) + 'a.rb',
  ];
  for (const line of lines) {
    for (const result of [`- a.rb:1: bug\n${line}\n`, `- a.rb:1: bug\n\`\`\`\n${line}\n\`\`\`\n`]) {
      const start = process.hrtime.bigint();
      findingLines(result, () => false);
      explicitEmpty(result);
      jsonFindings(result);
      ground(result, raws(['a.rb', 1], ['a.rb', 1]));
      ground(result, raws(['a.rb', 1], ['a.rb', null]));
      looksFinished(result, 'max');
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 100, `${J(result.slice(14, 26))}... took ${ms.toFixed(1)} ms`);
    }
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

// Lane output: every raw finding is scored or dropped once, by n.

const LANE_RAW = [
  { n: 1, file: 'app/pay.js', line: 40, summary: 'double charge' },
  { n: 2, file: 'app/util.js', line: 7, summary: 'reuse' },
  { n: 3, file: 'dist/app.js', line: 2, summary: 'generated' },
];
const scoredFor = (n, over = {}) => ({
  raw: n,
  file: LANE_RAW[n - 1].file,
  line: LANE_RAW[n - 1].line,
  message: 'a problem',
  severity: 8,
  category: 'correctness',
  confidence: 'High',
  evidence: 'app/pay.js:40 charge()',
  outside_range: false,
  doubted: false,
  recategorized_from: null,
  ...over,
});
const excludedDrop = (n, over = {}) => ({ raw: n, reason: 'excluded', glob: 'dist/**', ...over });
// An in-memory repository: fileExists and readLines take repo-relative paths, as the CLI's do.
const repoOf = (files) => ({
  fileExists: (path) => Object.hasOwn(files, path),
  readLines: (path) => (Object.hasOwn(files, path) ? files[path].replace(/\n$/, '').split('\n') : null),
});
const numbered = (count, at) => Array.from({ length: count }, (_, i) => at[i + 1] ?? `// line ${i + 1}`).join('\n') + '\n';
const LANE_REPO = repoOf({
  'lib/cart.rb': numbered(20, { 18: '  if (!items) return [];' }),
  'app/pay.js': numbered(45, { 39: '  guard();' }),
  'dist/app.js': numbered(3, { 2: 'return;' }),
  Makefile: numbered(14, { 12: 'test: build lint' }),
  'a.rb': numbered(3, { 2: '  guard()' }),
});
const lane = (scored, dropped = [], over = {}) =>
  checkLaneOutput({
    rawEntries: LANE_RAW,
    scoredText: J({ findings: scored }),
    droppedText: J(dropped),
    excludedPaths: ['dist/**'],
    root: '/repo',
    ...LANE_REPO,
    ...over,
  });
const GOOD_SCORED = [scoredFor(1), scoredFor(2)];

test('a lane that scores or drops every raw entry once passes', () => {
  const r = lane(GOOD_SCORED, [excludedDrop(3)]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(lane([], [excludedDrop(3)], { scoredText: J(GOOD_SCORED) }).ok, true, 'a bare array is read too');
  assert.equal(checkLaneOutput({ rawEntries: [], scoredText: '[]', droppedText: '[]', excludedPaths: [], root: '/repo' }).ok, true);
});

test('a raw blocker left out and replaced by an invented entry fails', () => {
  const invented = [scoredFor(2), { ...scoredFor(2), line: 8 }];
  const r = lane(invented, [excludedDrop(3)]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /raw entry 2 is accounted for twice/);
  const unknown = lane([scoredFor(2), scoredFor(1, { raw: 99 })], [excludedDrop(3)]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /raw 99, which is not the n of any raw entry/);
  const omitted = lane([scoredFor(2)], [excludedDrop(3)]);
  assert.equal(omitted.ok, false);
  assert.match(omitted.reason, /raw entry 1 \(app\/pay\.js:40\) is neither scored nor dropped/);
});

test('a raw finding both scored and dropped fails', () => {
  const r = lane([scoredFor(1), scoredFor(2), scoredFor(3, { file: 'dist/app.js' })], [excludedDrop(3)]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /raw entry 3 is accounted for twice/);
});

test('scored entry with severity "8/10", 7.5, or 0 fails', () => {
  for (const severity of ['8/10', 7.5, 0, 11, '8', null]) {
    const r = lane([scoredFor(1, { severity }), scoredFor(2)], [excludedDrop(3)]);
    assert.equal(r.ok, false, J(severity));
    assert.equal(r.reason.includes('integer severity from 1 to 10'), true, r.reason);
  }
  for (const severity of [1, 10]) assert.equal(lane([scoredFor(1, { severity }), scoredFor(2)], [excludedDrop(3)]).ok, true);
});

test('scored entry with category "bug" fails', () => {
  const r = lane([scoredFor(1, { category: 'bug' }), scoredFor(2)], [excludedDrop(3)]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /category "bug"/);
  assert.equal(lane([scoredFor(1, { confidence: 'high' }), scoredFor(2)], [excludedDrop(3)]).ok, false);
});

test('scored entry with no message, empty file, or line "12" fails', () => {
  for (const [over, pattern] of [
    [{ message: undefined }, /non-empty string message/],
    [{ message: '  ' }, /non-empty string message/],
    [{ file: '' }, /has file/],
    [{ file: undefined }, /has file/],
    [{ line: '12' }, /positive integer line/],
    [{ line: 0 }, /positive integer line/],
    [{ line: 12.5 }, /positive integer line/],
    [{ evidence: undefined }, /string evidence/],
    [{ outside_range: 'false' }, /outside_range/],
    [{ doubted: undefined }, /doubted/],
    [{ recategorized_from: undefined }, /recategorized_from/],
  ]) {
    const r = lane([scoredFor(1, over), scoredFor(2)], [excludedDrop(3)]);
    assert.equal(r.ok, false, J(over));
    assert.match(r.reason, pattern, J(over));
  }
  assert.equal(lane([scoredFor(1, { line: null }), scoredFor(2)], [excludedDrop(3)]).ok, true, 'a null line is allowed');
  assert.equal(lane([5, scoredFor(2)], [excludedDrop(3)]).ok, false, 'a non-object entry fails');
});

test("scored file must equal its raw entry's file, and an absolute raw path matches a repo-relative scored path", () => {
  const wrong = lane([scoredFor(1, { file: 'app/other.js' }), scoredFor(2)], [excludedDrop(3)]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /has file "app\/other\.js"/);
  const raw = [{ n: 1, file: '/repo/app/pay.js', line: 40, summary: 's' }];
  const scored = [{ ...scoredFor(1), file: 'app/pay.js' }];
  const run = (file) =>
    checkLaneOutput({ rawEntries: raw, scoredText: J([{ ...scored[0], file }]), droppedText: '[]', excludedPaths: [], root: '/repo' });
  assert.equal(run('app/pay.js').ok, true);
  assert.equal(run('/repo/app/pay.js').ok, false, 'the scored file is repo-relative');
});

test('recategorized_from "correctness" fails', () => {
  const r = lane([scoredFor(1, { recategorized_from: 'correctness' }), scoredFor(2)], [excludedDrop(3)]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /recategorized_from/);
  assert.equal(lane([scoredFor(1), scoredFor(2, { recategorized_from: 'reuse', category: 'correctness' })], [excludedDrop(3)]).ok, true);
});

test('excluded drop passes only for a configured glob that matches the raw file', () => {
  assert.equal(lane(GOOD_SCORED, [excludedDrop(3)]).ok, true);
  const unconfigured = lane(GOOD_SCORED, [excludedDrop(3, { glob: 'build/**' })]);
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.reason, /not in the config's excluded_paths/);
  const mismatch = lane([scoredFor(2)], [excludedDrop(1), excludedDrop(3)], { excludedPaths: ['dist/**'] });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /app\/pay\.js does not match/);
  assert.equal(lane(GOOD_SCORED, [excludedDrop(3, { glob: undefined })]).ok, false);
  const absolute = checkLaneOutput({
    rawEntries: [{ n: 1, file: '/repo/dist/app.js', line: 2, summary: 's' }],
    scoredText: '[]',
    droppedText: J([excludedDrop(1)]),
    excludedPaths: ['dist/**'],
    root: '/repo',
  });
  assert.equal(absolute.ok, true, 'the glob is matched against the repo-relative path');
});

test('in text mode an excluded drop needs every location on its claimed line to be excluded', () => {
  const run = (result, raw, dropped) =>
    checkCodeReviewRun({
      captureText: J(captureOf(result)),
      runId: 'r1',
      rawText: J(raw),
      scoredText: J({ findings: [] }),
      droppedText: J(dropped),
      excludedPaths: ['dist/**', 'vendor/**'],
      fileExists: () => false,
      root: '/repo',
    });
  const raw = [{ n: 1, file: 'dist/b.js', line: 5, summary: 's' }];
  const drop = [{ raw: 1, reason: 'excluded', glob: 'dist/**' }];

  const rides = run('- lib/a.rb:10 calls dist/b.js:5 and lets user input reach eval', raw, drop);
  assert.equal(rides.ok, false);
  assert.equal(rides.stage, 'lane');
  assert.match(rides.reason, /dropped entry 1 \(raw 1, dist\/b\.js:5\) .*lib\/a\.rb:10/);

  assert.deepEqual(
    run('- dist/b.js:5 the bundle calls eval', raw, drop),
    { ok: true, stage: null, reason: 'ok', count: 1, mode: 'text', dropped: [{ file: 'dist/b.js', line: 5, summary: 's', why: 'excluded path: dist/**' }] },
    'a line whose only location is excluded still drops',
  );
  assert.equal(run('- dist/b.js:5 copies vendor/x.js:2', raw, drop).ok, true, 'every location on the line is excluded');
  assert.equal(run('- `dist/b.js:5` copies (vendor/x.js:2)', raw, drop).ok, true, 'wrappers around a location do not matter');
  assert.equal(run('- dist/b.js:5 copies ./lib/a.rb:10', raw, drop).ok, false, 'a repo-relative spelling of a kept path still counts');
});

test('a drop with reason "refuted" fails', () => {
  for (const reason of ['refuted', 'REFUTED', undefined]) {
    const r = lane(GOOD_SCORED, [{ raw: 3, reason, proof: 'REFUTED by the /code-review verifier' }]);
    assert.equal(r.ok, false, String(reason));
    assert.match(r.reason, /it must be "excluded" or "disproved"/);
  }
});

const disproved = (proof, over = {}) => lane([scoredFor(1), scoredFor(2)], [{ raw: 3, reason: 'disproved', proof }], over);

test('a disproved drop needs a proof that cites a path:line', () => {
  for (const proof of ['it is fine', '', '   ', undefined, 'see file: 12', 'discussed at 12:30', 'localhost:3000']) {
    const r = disproved(proof);
    assert.equal(r.ok, false, String(proof));
    assert.match(r.reason, /needs a proof that cites a path:line and then quotes the code there/, String(proof));
  }
});

test('a disproved proof must cite a file that exists in the repository', () => {
  for (const proof of ['x.y:1 nah', 'host.com:3000 nope', 'lib/missing.rb:18 if (!items) return [];']) {
    const r = disproved(proof);
    assert.equal(r.ok, false, proof);
    assert.match(r.reason, /dropped entry 1 \(raw 3, dist\/app\.js:2\) has a proof that cites \S+, but no file \S+ exists in the repository/, proof);
  }
  const noMakefile = disproved('Makefile:12 test: build lint', { fileExists: () => false });
  assert.equal(noMakefile.ok, false, 'a bare name is a location only when that file exists');
});

test('a disproved proof must cite a line inside the file', () => {
  for (const line of [0, 21, 99]) {
    const r = disproved(`lib/cart.rb:${line} if (!items) return [];`);
    assert.equal(r.ok, false, String(line));
    assert.match(r.reason, /cites lib\/cart\.rb:\d+, but lib\/cart\.rb has 20 lines/, String(line));
  }
});

test('a disproved proof must quote at least 3 characters of code right after path:line', () => {
  for (const proof of ['lib/cart.rb:18', 'lib/cart.rb:18 ;;', 'lib/cart.rb:18: - ', 'already handled: lib/cart.rb:18']) {
    const r = disproved(proof);
    assert.equal(r.ok, false, proof);
    assert.match(r.reason, /quotes no code after lib\/cart\.rb:18/, proof);
  }
});

test('a disproved proof whose quote is not within 2 lines of the cited line fails', () => {
  for (const proof of ['lib/cart.rb:5 if (!items) return [];', 'lib/cart.rb:15 if (!items) return [];', 'lib/cart.rb:18 if (!items) return null;']) {
    const r = disproved(proof);
    assert.equal(r.ok, false, proof);
    assert.match(r.reason, /quoted code is not in lib\/cart\.rb within 2 lines of line \d+/, proof);
  }
});

test('a disproved proof that quotes the code near the cited line passes', () => {
  for (const proof of [
    'already handled: lib/cart.rb:18 if (!items) return [];',
    'already handled: lib/cart.rb:16 if (!items) return [];',
    'already handled: lib/cart.rb:20 if (!items) return [];',
    'already handled: lib/cart.rb:17-19 if (!items) return [];',
    'lib/cart.rb:18: if(!items)\n  return [];',
    'misreads the code: `lib/cart.rb:18` - `if (!items) return [];`',
    'lib/cart.rb:18 — if (!items) return [];',
    'lib/cart.rb:18 – if (!items) return [];',
    'lib/cart.rb:18 return',
    'Makefile:12 test: build lint',
    './lib/cart.rb:18 if (!items) return [];',
    '/repo/lib/cart.rb:18 if (!items) return [];',
    'misreads: x.y:1 is wrong; lib/cart.rb:18 if (!items) return [];',
  ]) {
    const r = disproved(proof);
    assert.equal(r.ok, true, `${proof}: ${r.reason}`);
  }
});

test('a disproved drop fails closed when the repository cannot be read', () => {
  const proof = 'already handled: lib/cart.rb:18 if (!items) return [];';
  assert.equal(disproved(proof, { readLines: undefined }).ok, false);
  assert.equal(disproved(proof, { fileExists: undefined }).ok, false);
});

test('dropped output keeps each drop on one line', () => {
  const raw = [{ n: 1, file: 'a.rb', line: 3, summary: 'two\nlines  of text' }];
  const r = checkLaneOutput({
    rawEntries: raw,
    scoredText: '[]',
    droppedText: J([{ raw: 1, reason: 'disproved', proof: 'a.rb:2\n  guard()\r\n' }]),
    excludedPaths: [],
    root: '/repo',
    ...LANE_REPO,
  });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.dropped, [{ file: 'a.rb', line: 3, summary: 'two lines of text', why: 'a.rb:2 guard()' }]);
});

test('checkLaneOutput checks the raw list shape itself, and a scored file must be non-empty text', () => {
  const dup = [
    { n: 1, file: 'a.rb', line: 1, summary: 's' },
    { n: 1, file: 'b.rb', line: 1, summary: 's' },
  ];
  const r = checkLaneOutput({ rawEntries: dup, scoredText: '[]', droppedText: '[]', excludedPaths: [], root: '/repo' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /n must count 1, 2, 3/);
  const blank = [{ n: 1, file: '', line: 1, summary: 's' }];
  const empty = checkLaneOutput({
    rawEntries: blank,
    scoredText: J([{ ...scoredFor(1), file: '' }]),
    droppedText: '[]',
    excludedPaths: [],
    root: '/repo',
  });
  assert.equal(empty.ok, false);
  const root = checkLaneOutput({
    rawEntries: [{ n: 1, file: './', line: 1, summary: 's' }],
    scoredText: J([{ ...scoredFor(1), file: '' }]),
    droppedText: '[]',
    excludedPaths: [],
    root: '/repo',
  });
  assert.equal(root.ok, false, 'a raw path that reduces to nothing cannot be scored');
});

test('an excluded-glob mismatch names the repo-relative path', () => {
  const r = checkLaneOutput({
    rawEntries: [{ n: 1, file: '/repo/app/x.js', line: 1, summary: 's' }],
    scoredText: '[]',
    droppedText: J([{ raw: 1, reason: 'excluded', glob: 'dist/**' }]),
    excludedPaths: ['dist/**'],
    root: '/repo',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /which app\/x\.js does not match/);
});

test('fence closing rules: same character, at least as long, up to 3 spaces of indent', () => {
  const list = [{ file: 'a.rb', line: 3, summary: 's' }];
  const body = J(list);
  const results = (fence, closer, indent = '') => `Result:\n${indent}${fence}json\n${body}\n${indent}${closer}\n`;
  const lists = (text) => jsonFindings(text).list;
  assert.equal(jsonFindings(results('~~~', '```')).problem !== null, true, 'a tilde fence is not closed by backticks');
  assert.equal(jsonFindings(results('```', '~~~')).problem !== null, true, 'a backtick fence is not closed by tildes');
  assert.equal(jsonFindings(results('````', '```')).problem !== null, true, 'four backticks are not closed by three');
  assert.deepEqual(lists(results('~~~', '~~~')), list);
  assert.deepEqual(lists(results('```', '```', '   ')), list, 'a fence indented 3 spaces still counts');
  assert.deepEqual(lists(results('```', '`````')), list, 'a longer closer closes');
  assert.equal(lists(results('```', '```', '    ')), null, 'four spaces of indent is code, not a fence');
  const unclosed = ground(`Result:\n(none)\n\`\`\`json\n${body}\n`, raws(['a.rb', 3]));
  assertFails(unclosed, 'capture', 'an unclosed fence');
  assertFails(ground(`Result:\n(none)\n~~~json\n[{"file":"a.rb",\n~~~\n`, []), 'capture', 'a truncated tilde block');
});

test('dropped output renders "excluded path: dist/**" and the proof text', () => {
  const r = lane([scoredFor(2)], [excludedDrop(3), { raw: 1, reason: 'disproved', proof: 'app/pay.js:39 guard()' }]);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.dropped, [
    { file: 'dist/app.js', line: 2, summary: 'generated', why: 'excluded path: dist/**' },
    { file: 'app/pay.js', line: 40, summary: 'double charge', why: 'app/pay.js:39 guard()' },
  ]);
});

test('a missing or unreadable scored or dropped file fails', () => {
  for (const scoredText of [null, '{"findings": [', J({ x: 1 })]) {
    const r = lane([], [], { scoredText });
    assert.equal(r.ok, false);
    assert.match(r.reason, /scored findings file/);
  }
  for (const droppedText of [null, '[{', J({ x: 1 })]) {
    const r = lane(GOOD_SCORED, [], { droppedText });
    assert.equal(r.ok, false);
    assert.match(r.reason, /dropped file/);
  }
});

test('checkCodeReviewRun reports stage capture for an empty result, and stage lane for an accounting error', () => {
  const run = (result, raw, scored, dropped, over = {}) =>
    checkCodeReviewRun({
      captureText: J(captureOf(result)),
      runId: 'r1',
      rawText: J(raw),
      scoredText: J(scored),
      droppedText: J(dropped),
      excludedPaths: [],
      fileExists: () => false,
      root: '/repo',
      ...over,
    });
  const result = fenced('json', J([{ file: 'a.rb', line: 3, summary: 's' }]));
  const raw = [{ n: 1, file: 'a.rb', line: 3, summary: 's' }];
  const empty = run('', raw, [], []);
  assert.equal(empty.ok, false);
  assert.equal(empty.stage, 'capture');
  const accounting = run(result, raw, [], []);
  assert.equal(accounting.ok, false);
  assert.equal(accounting.stage, 'lane');
  assert.equal(accounting.count, 1);
  assert.equal(accounting.mode, 'json');
  const good = run(result, raw, [{ ...scoredFor(1), file: 'a.rb', line: 3 }], []);
  assert.deepEqual(good, { ok: true, stage: null, reason: 'ok', count: 1, mode: 'json', dropped: [] });
  assert.equal(run(result, raw, [], [], { captureText: null }).stage, 'capture');
  assert.equal(run(result, raw, [], [], { rawText: null }).stage, 'lane');
  assert.equal(run(result, raw, [], [], { rawText: '[{' }).stage, 'lane');
  assert.equal(run(result, [], [], []).stage, 'lane', 'a raw list that drops the finding fails before accounting');
});
