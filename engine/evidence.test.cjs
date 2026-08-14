'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { addedLines, staticFindings, ciSummary, buildEvidence, verifyEvidenceLedger } = require('./evidence.cjs');

const DIFF = `diff --git a/app/x.rb b/app/x.rb
--- a/app/x.rb
+++ b/app/x.rb
@@ -3,2 +3,3 @@
 old
-gone
+dangerous_call(value)
+safe_call(value)
`;

test('unified diff parser tracks only new-side added line numbers', () => {
  assert.deepEqual([...addedLines(DIFF).get('app/x.rb')], [4, 5]);
});

test('ast-grep findings are normalized and restricted to changed lines', () => {
  const matches = [
    { ruleId: 'danger', severity: 'error', message: 'Danger', file: 'app/x.rb', range: { start: { line: 3 } }, lines: 'dangerous_call(value)' },
    { ruleId: 'old', severity: 'error', message: 'Old', file: 'app/x.rb', range: { start: { line: 1 } }, lines: 'old' },
  ];
  const out = staticFindings({ astGrep: JSON.stringify(matches), diffText: DIFF });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 8);
  assert.equal(out[0].line, 4);
  assert.equal(out[0].confidence, 'High');
});

test('CI summary excludes agent-review itself and preserves annotations', () => {
  const out = ciSummary({ check_runs: [
    { id: 1, name: 'tests', status: 'completed', conclusion: 'failure', html_url: 'https://x', annotations: [{ path: 'a.rb', start_line: 4, annotation_level: 'failure', message: 'boom' }] },
    { id: 2, name: 'lint', status: 'in_progress', conclusion: null },
    { id: 3, name: 'agent-review / review', status: 'in_progress', conclusion: null },
  ] });
  assert.deepEqual(out.summary, { total: 2, success: 0, failed: 1, pending: 1, neutral: 0 });
  assert.equal(out.checks[0].annotations[0].message, 'boom');
});

test('disabled evidence sources remain disabled even when input files are supplied', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-evidence-'));
  const diff = join(root, 'diff.txt');
  const ast = join(root, 'ast.json');
  const ci = join(root, 'ci.json');
  writeFileSync(diff, DIFF);
  writeFileSync(ast, JSON.stringify([{ ruleId: 'danger', severity: 'error', message: 'Danger', file: 'app/x.rb', range: { start: { line: 3 } } }]));
  writeFileSync(ci, JSON.stringify({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] }));
  const out = buildEvidence({
    diffPath: diff,
    astGrepPath: ast,
    ciPath: ci,
    staticConfig: { enabled: false },
    ciConfig: { enabled: false },
  });
  assert.deepEqual(out.staticFindings, []);
  assert.equal(out.ci, null);
});

test('deterministic static findings must be present in the posted ledger', () => {
  const finding = staticFindings({
    astGrep: JSON.stringify([{ ruleId: 'danger', severity: 'error', message: 'Danger', file: 'app/x.rb', range: { start: { line: 3 } }, lines: 'dangerous_call(value)' }]),
    diffText: DIFF,
  })[0];
  const comment = `<!-- agent-review-ledger: ${JSON.stringify([{ signature: finding.signature }])} -->`;
  assert.equal(verifyEvidenceLedger({ staticFindings: [finding] }, comment).required, 1);
  assert.throws(() => verifyEvidenceLedger({ staticFindings: [finding] }, '<!-- agent-review-ledger: [] -->'), /omitted/);
});
