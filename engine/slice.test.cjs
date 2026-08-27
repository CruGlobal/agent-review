'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sliceForAgent } = require('./slice.cjs');

// Two files, two hunks each — a realistic unified diff to slice against.
const DIFF = [
  'diff --git a/src/api/users.js b/src/api/users.js',
  'index 1111111..2222222 100644',
  '--- a/src/api/users.js',
  '+++ b/src/api/users.js',
  '@@ -1,3 +1,4 @@',
  ' function getUser(id) {',
  '+  const k = process.env.SECRET;',
  '   return db.find(id);',
  ' }',
  '@@ -10,2 +11,3 @@ function listUsers()',
  ' function listUsers() {',
  '+  return db.all();',
  ' }',
  'diff --git a/src/ui/Widget.tsx b/src/ui/Widget.tsx',
  'index 3333333..4444444 100644',
  '--- a/src/ui/Widget.tsx',
  '+++ b/src/ui/Widget.tsx',
  '@@ -1,2 +1,3 @@',
  ' export function Widget() {',
  '+  return <div>hi</div>;',
  ' }',
  '',
].join('\n');

const pathAgent = {
  id: 'api-specialist',
  triggers: { paths: ['src/api/**'] },
};

const contentAgent = {
  id: 'security',
  escalates: false,
  triggers: { content: ['process.env.'] },
};

const noMatchAgent = {
  id: 'financial',
  triggers: { paths: ['src/finance/**'], content: ['stripe.charge'] },
};

test('path-glob slicing keeps only matching files, complete hunks, valid headers', () => {
  const result = sliceForAgent({ agent: pathAgent, diffText: DIFF });
  assert.equal(result.mode, 'sliced');
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 2);
  assert.ok(result.diff.includes('diff --git a/src/api/users.js b/src/api/users.js'));
  assert.ok(result.diff.includes('--- a/src/api/users.js'));
  assert.ok(result.diff.includes('+++ b/src/api/users.js'));
  assert.ok(result.diff.includes('@@ -1,3 +1,4 @@'));
  assert.ok(result.diff.includes('@@ -10,2 +11,3 @@'));
  assert.ok(!result.diff.includes('Widget.tsx'));
});

test('content-trigger slicing pulls a matching hunk from a non-glob-matching file', () => {
  const result = sliceForAgent({ agent: contentAgent, diffText: DIFF });
  assert.equal(result.mode, 'sliced');
  // Only the first hunk of users.js mentions process.env — the second hunk
  // and Widget.tsx must not be pulled in.
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 1);
  assert.ok(result.diff.includes('diff --git a/src/api/users.js b/src/api/users.js'));
  assert.ok(result.diff.includes('process.env.SECRET'));
  assert.ok(!result.diff.includes('listUsers'));
  assert.ok(!result.diff.includes('Widget.tsx'));
});

for (const [label, agent] of [
  ['escalates: true', { id: 'perf', escalates: true }],
  ['id architecture', { id: 'architecture' }],
  ['triggers.always via top-level always', { id: 'standards', always: true }],
]) {
  test(`full-diff rule: ${label} gets byte-identical full diff`, () => {
    const result = sliceForAgent({ agent, diffText: DIFF });
    assert.equal(result.mode, 'full');
    assert.equal(result.diff, DIFF);
    assert.equal(result.files, 2);
    assert.equal(result.hunks, 3);
  });
}

test('empty mode when a sliced specialist matches nothing', () => {
  const result = sliceForAgent({ agent: noMatchAgent, diffText: DIFF });
  assert.equal(result.mode, 'empty');
  assert.equal(result.diff, '');
  assert.equal(result.files, 0);
  assert.equal(result.hunks, 0);
});

test('manifest counts: whole-file glob match counts every hunk in that file', () => {
  const result = sliceForAgent({ agent: pathAgent, diffText: DIFF });
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 2);
});

test('deterministic ordering: sliced hunks preserve input order across files', () => {
  const bothAgent = {
    id: 'both',
    triggers: { paths: ['src/ui/**'], content: ['process.env.'] },
  };
  const result = sliceForAgent({ agent: bothAgent, diffText: DIFF });
  const usersIdx = result.diff.indexOf('src/api/users.js');
  const widgetIdx = result.diff.indexOf('src/ui/Widget.tsx');
  assert.ok(usersIdx >= 0 && widgetIdx >= 0);
  assert.ok(usersIdx < widgetIdx, 'users.js hunk (earlier in input) must precede Widget.tsx slice');
  assert.equal(result.files, 2);
  assert.equal(result.hunks, 2);
});

test('sliceForAgent does not mutate agent.triggers (by-reference alias of config)', () => {
  const triggers = { paths: ['src/api/**'], content: ['process.env.'] };
  const agent = { id: 'api-specialist', triggers };
  const before = JSON.stringify(triggers);
  sliceForAgent({ agent, diffText: DIFF });
  assert.equal(JSON.stringify(triggers), before);
  assert.equal(agent.triggers, triggers, 'reference identity preserved');
});

test('sliceForAgent is pure — same inputs, same output, no I/O side effects', () => {
  const a = sliceForAgent({ agent: pathAgent, diffText: DIFF });
  const b = sliceForAgent({ agent: pathAgent, diffText: DIFF });
  assert.deepEqual(a, b);
});

// --- Fix report follow-ups (controller rulings) ---

test('content-trigger slicing sees deletions too — a removed dangerous call must be caught', () => {
  const diff = [
    'diff --git a/src/db/repo.js b/src/db/repo.js',
    'index 5555555..6666666 100644',
    '--- a/src/db/repo.js',
    '+++ b/src/db/repo.js',
    '@@ -10,3 +10,2 @@',
    ' function fetchAll() {',
    '-  return db.query("SELECT * FROM users");',
    '+  return cache.get("users");',
    ' }',
    '',
  ].join('\n');
  const securityAgent = {
    id: 'security',
    triggers: { content: ['db.query('] },
  };
  const result = sliceForAgent({ agent: securityAgent, diffText: diff });
  assert.equal(result.mode, 'sliced');
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 1);
  assert.ok(result.diff.includes('db.query("SELECT * FROM users")'));
});

test('a path-matched binary file with zero hunks still belongs in the slice', () => {
  const diff = [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'index 1234567..89abcde 100644',
    'Binary files a/assets/logo.png and b/assets/logo.png differ',
    'diff --git a/src/other.js b/src/other.js',
    'index aaaaaaa..bbbbbbb 100644',
    '--- a/src/other.js',
    '+++ b/src/other.js',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  const assetsAgent = { id: 'assets', triggers: { paths: ['assets/**'] } };
  const result = sliceForAgent({ agent: assetsAgent, diffText: diff });
  assert.equal(result.mode, 'sliced');
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 0);
  assert.ok(result.diff.includes('diff --git a/assets/logo.png b/assets/logo.png'));
  assert.ok(result.diff.includes('Binary files a/assets/logo.png and b/assets/logo.png differ'));
  assert.ok(!result.diff.includes('src/other.js'), 'unrelated (non-matching) file logic is unchanged');
});

test('a path-matched mode-only change with zero hunks still belongs in the slice', () => {
  const diff = [
    'diff --git a/scripts/run.sh b/scripts/run.sh',
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n');
  const scriptsAgent = { id: 'scripts', triggers: { paths: ['scripts/**'] } };
  const result = sliceForAgent({ agent: scriptsAgent, diffText: diff });
  assert.equal(result.mode, 'sliced');
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 0);
  assert.ok(result.diff.includes('old mode 100644'));
  assert.ok(result.diff.includes('new mode 100755'));
});

test('a path-matched pure rename with zero hunks still belongs in the slice', () => {
  const diff = [
    'diff --git a/src/old-name.js b/src/new-name.js',
    'similarity index 100%',
    'rename from src/old-name.js',
    'rename to src/new-name.js',
    '',
  ].join('\n');
  const renameAgent = { id: 'renamed', triggers: { paths: ['src/new-name.js'] } };
  const result = sliceForAgent({ agent: renameAgent, diffText: diff });
  assert.equal(result.mode, 'sliced');
  assert.equal(result.files, 1);
  assert.equal(result.hunks, 0);
  assert.ok(result.diff.includes('rename from src/old-name.js'));
  assert.ok(result.diff.includes('rename to src/new-name.js'));
});
