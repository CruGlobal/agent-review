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
