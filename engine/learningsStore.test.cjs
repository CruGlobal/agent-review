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
