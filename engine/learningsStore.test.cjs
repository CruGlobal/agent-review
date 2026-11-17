'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeProposals,
  parsePending,
  loadApproved,
  emitFindings,
} = require('./learningsStore.cjs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync } = require('node:fs');

test('mergeProposals adds new and preserves existing status', () => {
  const existing = {
    version: 1,
    learnings: [{ id: 'L-a', kind: 'suppress', status: 'approved' }],
  };
  const proposals = [
    { id: 'L-a', kind: 'suppress', status: 'proposed' },
    { id: 'L-b', kind: 'rule', status: 'proposed' },
  ];
  const merged = mergeProposals(existing, proposals);
  const a = merged.learnings.find((l) => l.id === 'L-a');
  const b = merged.learnings.find((l) => l.id === 'L-b');
  assert.equal(a.status, 'approved'); // preserved, not reset to proposed
  assert.equal(b.status, 'proposed'); // newly added
  assert.equal(merged.learnings.length, 2);
});

test('parsePending keeps only findings with a filled outcome', () => {
  const yamlText = `
reviewId: r1
findings:
  - { id: f1, signature: s1, agent: ux, file: src/a.tsx, message: m1, outcome: dismissed }
  - { id: f2, signature: s2, agent: ux, file: src/b.tsx, message: m2, outcome: "" }
  - { id: f3, signature: s3, agent: ux, file: src/c.tsx, message: m3, outcome: accepted }
`;
  const entries = parsePending(yamlText);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['f1', 'f3'],
  );
  assert.equal(entries[0].reviewId, 'r1');
  assert.equal(entries[0].outcome, 'dismissed');
});

test('loadApproved filters by status', () => {
  const learnings = {
    version: 1,
    learnings: [
      { id: 'L-a', status: 'approved' },
      { id: 'L-b', status: 'proposed' },
    ],
  };
  assert.deepEqual(
    loadApproved(learnings).map((l) => l.id),
    ['L-a'],
  );
});

test('emitFindings never trusts model-supplied ids or signatures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-review-findings-'));
  const findings = emitFindings({
    dir,
    reviewId: 'r1',
    rawFindings: [
      {
        id: 'attacker-id',
        signature: 'previously-dismissed',
        agent: 'security',
        category: 'auth',
        file: 'app/a.rb',
        message: 'missing authorization',
      },
    ],
  });
  assert.equal(findings[0].id, 'f1');
  assert.notEqual(findings[0].signature, 'previously-dismissed');
});

test('writeFeedbackBatch writes one new file per call, never reusing a name', () => {
  const { writeFeedbackBatch, feedbackDir } = require('./learningsStore.cjs');
  const { readdirSync, readFileSync, rmSync } = require('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'fb-batch-'));
  try {
    assert.equal(writeFeedbackBatch(base, 'r1', []), null, 'nothing to write, no file');
    const entries = [{ reviewId: 'address-12', id: 'f1' }, { reviewId: 'address-12', id: 'f2' }];
    const paths = [];
    for (let i = 0; i < 20; i++) paths.push(writeFeedbackBatch(base, 'address-12', entries));
    assert.equal(new Set(paths).size, 20, 'twenty writes in the same second get twenty names');
    assert.equal(readdirSync(feedbackDir(base)).length, 20);
    for (const p of paths) {
      assert.match(p.slice(feedbackDir(base).length + 1), /^address-12-\d{8}T\d{6}Z-[0-9a-f]{6}\.jsonl$/);
      assert.equal(readFileSync(p, 'utf8'), entries.map((e) => JSON.stringify(e) + '\n').join(''));
    }
    const odd = writeFeedbackBatch(base, '../../.git/x y', [{ id: 'f1' }]);
    assert.equal(join(odd, '..'), feedbackDir(base), 'a reviewId cannot leave the folder');
    assert.match(odd, /[/\\]git-x-y-\d{8}T\d{6}Z-[0-9a-f]{6}\.jsonl$/);
    assert.match(writeFeedbackBatch(base, undefined, [{ id: 'f1' }]), /[/\\]feedback-\d{8}T/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loadFeedback reads the old feedback.jsonl, then the folder files in name order', () => {
  const { loadFeedback, feedbackFiles } = require('./learningsStore.cjs');
  const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'fb-load-'));
  try {
    assert.deepEqual(loadFeedback(base), [], 'no feedback at all is empty');
    mkdirSync(join(base, 'feedback'));
    writeFileSync(join(base, 'feedback', '.gitkeep'), '');
    assert.deepEqual(loadFeedback(base), [], 'an empty folder with .gitkeep is empty');
    writeFileSync(join(base, 'feedback', 'address-9-20261117T190312Z-bbbbbb.jsonl'), '{"n":3}\n');
    writeFileSync(join(base, 'feedback', 'address-9-20261116T080000Z-aaaaaa.jsonl'), '{"n":2}\nNOT JSON\n');
    writeFileSync(join(base, 'feedback', 'notes.txt'), '{"n":99}\n');
    assert.deepEqual(loadFeedback(base), [{ n: 2 }, { n: 3 }], 'folder only, in name order, other files skipped');
    writeFileSync(join(base, 'feedback.jsonl'), '{"n":1}\n');
    assert.deepEqual(loadFeedback(base), [{ n: 1 }, { n: 2 }, { n: 3 }], 'the old file comes first');
    assert.equal(feedbackFiles(base).length, 3);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
