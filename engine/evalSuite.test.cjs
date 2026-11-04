'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { validateSuite, scoreSuite, compareEvaluation, materializeCase } = require('./evalSuite.cjs');

function suite() {
  return {
    version: 1,
    name: 'test-suite',
    thresholds: {
      blocker_recall: 0.8,
      blocker_precision: 0.5,
      clean_false_blocker_rate: 0,
      category_recall: 0.5,
      minimum_runs: 2,
    },
    cases: [
      {
        id: 'seed-auth', kind: 'seeded_bug', category: 'security',
        expected: [{
          id: 'auth', must_block: true, min_severity: 7,
          match: { paths: ['app/**'], categories: ['security'], message_any: ['authorize'] },
        }],
      },
      { id: 'clean', kind: 'clean_control', expected: [] },
    ],
  };
}

test('seeded suite scores blocker recall, precision, controls, categories, and stability', () => {
  const result = scoreSuite(suite(), [
    {
      case_id: 'seed-auth', run_id: 'one', findings: [
        { severity: 8, file: 'app/x.rb', category: 'security', message: 'Missing authorize call', outcome: 'accepted' },
      ],
    },
    { case_id: 'clean', run_id: 'one', findings: [] },
  ]);
  assert.equal(result.metrics.blockerRecall, 1);
  assert.equal(result.metrics.blockerPrecision, 1);
  assert.equal(result.metrics.cleanFalseBlockerRate, 0);
  assert.equal(result.categories.security.recall, 1);
  assert.equal(result.stability['seed-auth'].detectionRate, 1);
  assert.equal(result.gate.pass, true);
});

test('unmatched blockers count against precision and clean controls', () => {
  const result = scoreSuite(suite(), [
    { case_id: 'seed-auth', run_id: 'one', findings: [] },
    { case_id: 'clean', run_id: 'one', findings: [
      { severity: 9, file: 'app/clean.rb', category: 'security', message: 'Invented blocker', outcome: 'dismissed', dismissal_reason: 'false-positive' },
    ] },
  ]);
  assert.equal(result.metrics.blockerRecall, 0);
  assert.equal(result.metrics.blockerPrecision, 0);
  assert.equal(result.metrics.cleanFalseBlockerRate, 1);
  assert.equal(result.metrics.falsePositiveDismissalRate, 1);
  assert.equal(result.gate.pass, false);
});

function suggestionSuite(thresholds = {}) {
  const raw = suite();
  raw.thresholds = { ...raw.thresholds, minimum_runs: 1, ...thresholds };
  raw.cases.push({
    id: 'seed-i18n', kind: 'seeded_bug', category: 'i18n',
    expected: [{
      id: 'missing-msgid', must_block: false, min_severity: 3, category: 'i18n',
      match: { paths: ['app/**'], message_any: ['catalog'] },
    }],
  });
  return raw;
}
const passing = [
  { case_id: 'seed-auth', run_id: 'one', findings: [{ severity: 8, file: 'app/x.rb', category: 'security', message: 'Missing authorize call' }] },
  { case_id: 'clean', run_id: 'one', findings: [] },
];
const i18nRun = (findings) => ({ case_id: 'seed-i18n', run_id: 'one', findings });

test('a must_block false case found below the blocker bar counts as detected', () => {
  const result = scoreSuite(suggestionSuite(), [...passing, i18nRun([{ severity: 5, file: 'app/y.rb', category: 'i18n', message: 'msgid missing from the catalog' }])]);
  assert.deepEqual([result.totals.expectedSuggestions, result.totals.detectedSuggestions], [1, 1]);
  assert.equal(result.metrics.suggestionRecall, 1);
  assert.equal(result.stability['seed-i18n'].detectionRate, 1);
  assert.deepEqual([result.totals.cleanRuns, result.metrics.cleanFalseBlockerRate], [2, 0], 'a case that expects no blocker counts as a clean run');
  assert.equal(result.metrics.blockerRecall, 1, 'suggestions never enter blocker recall');
  assert.equal(result.gate.pass, true);
});

test('a must_block false case the review blocks fails: a false blocker on a run that must pass', () => {
  const result = scoreSuite(suggestionSuite(), [...passing, i18nRun([{ severity: 8, file: 'app/y.rb', category: 'i18n', message: 'msgid missing from the catalog' }])]);
  assert.equal(result.totals.detectedSuggestions, 0, 'a blocker never matches a suggestion');
  assert.equal(result.totals.falsePositiveBlockers, 1);
  assert.equal(result.metrics.cleanFalseBlockerRate, 0.5);
  assert.equal(result.stability['seed-i18n'].detectionRate, 0);
  assert.equal(result.gate.pass, false);
  assert.equal(result.gate.checks.cleanFalseBlockerRate, false);
});

test('a missed must_block false case fails its run, and fails the gate only with suggestion_recall set', () => {
  const runs = [...passing, i18nRun([{ severity: 2, file: 'app/y.rb', category: 'i18n', message: 'msgid missing from the catalog' }])];
  const plain = scoreSuite(suggestionSuite(), runs);
  assert.equal(plain.metrics.suggestionRecall, 0, 'below min_severity does not count');
  assert.equal(plain.stability['seed-i18n'].detectionRate, 0);
  assert.equal(plain.gate.pass, true);
  const gated = scoreSuite(suggestionSuite({ suggestion_recall: 0.5 }), runs);
  assert.deepEqual([gated.gate.pass, gated.gate.checks.suggestionRecall], [false, false]);
  assert.throws(() => validateSuite(suggestionSuite({ suggestion_recall: 2 })), /suggestion_recall/);
});

test('suite validation rejects a must_block false finding that could never match', () => {
  const at = (min, threshold) => {
    const raw = suggestionSuite();
    raw.cases[2].expected[0].min_severity = min;
    if (threshold !== undefined) raw.blocker_threshold = threshold;
    return raw;
  };
  assert.throws(() => validateSuite(at(7)), /must_block: false with min_severity 7, which is not below blocker_threshold 7, so it can never match/);
  assert.throws(() => validateSuite(at(5, 5)), /not below blocker_threshold 5/);
  assert.doesNotThrow(() => validateSuite(at(6)));
  assert.doesNotThrow(() => validateSuite(at(7, 8)), 'a higher threshold leaves room');
  const unset = suggestionSuite();
  delete unset.cases[2].expected[0].min_severity;
  assert.doesNotThrow(() => validateSuite(unset), 'with no min_severity a suggestion matches from 1');
});

test('suite validation rejects clean controls that require blockers', () => {
  const raw = suite();
  raw.cases[1].expected = [{ id: 'bad', match: { paths: ['**'] } }];
  assert.throws(() => validateSuite(raw), /clean control/);
});

test('evaluation comparison reports metric deltas', () => {
  const current = { suite: 'x', metrics: { blockerRecall: 0.9, blockerPrecision: null } };
  const baseline = { suite: 'x-old', metrics: { blockerRecall: 0.8, blockerPrecision: 0.7 } };
  const result = compareEvaluation(current, baseline);
  assert.ok(Math.abs(result.metricDelta.blockerRecall - 0.1) < 1e-9);
  assert.equal(result.metricDelta.blockerPrecision, null);
});

test('an empty result bundle fails every coverage-dependent gate', () => {
  const result = scoreSuite(suite(), []);
  assert.equal(result.gate.pass, false);
  assert.equal(result.gate.checks.categoryRecall, false);
  assert.equal(result.gate.checks.everyCaseCovered, false);
});

test('evaluation results reject malformed severity and uncoded dismissals', () => {
  assert.throws(
    () => scoreSuite(suite(), [{ case_id: 'seed-auth', findings: [{ severity: 'high' }] }]),
    /invalid severity/,
  );
  assert.throws(
    () => scoreSuite(suite(), [{
      case_id: 'seed-auth', findings: [{ severity: 8, outcome: 'dismissed' }],
    }]),
    /valid dismissal reason/,
  );
});

test('eval prepare creates a disposable seeded commit visible in a commit range', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-eval-repo-'));
  const out = join(root, 'seeded-worktree');
  const patchDir = join(root, 'suite/patches');
  const suitePath = join(root, 'suite/suite.yml');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(patchDir, { recursive: true });
  writeFileSync(join(root, 'src/value.txt'), 'safe\n');
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', 'src/value.txt']);
  execFileSync('git', [
    '-C', root, '-c', 'user.name=test', '-c', 'user.email=test@invalid',
    'commit', '--no-gpg-sign', '-m', 'base', '-q',
  ]);
  writeFileSync(join(patchDir, 'seed.patch'), [
    'diff --git a/src/value.txt b/src/value.txt',
    '--- a/src/value.txt',
    '+++ b/src/value.txt',
    '@@ -1 +1 @@',
    '-safe',
    '+danger',
    '',
  ].join('\n'));
  const raw = {
    version: 1,
    name: 'prepare-test',
    cases: [{
      id: 'seed', kind: 'seeded_bug', patch: 'patches/seed.patch',
      expected: [{ id: 'danger', match: { paths: ['src/**'] } }],
    }],
  };
  writeFileSync(suitePath, 'version: 1\n');
  try {
    const prepared = materializeCase({
      suite: raw, suitePath, caseId: 'seed', repo: root, out, base: 'HEAD',
    });
    assert.notEqual(prepared.baseHead, prepared.seededHead);
    assert.equal(
      execFileSync('git', ['-C', out, 'diff', '--name-only', 'HEAD^..HEAD'], { encoding: 'utf8' }).trim(),
      'src/value.txt',
    );
    assert.equal(
      execFileSync('git', ['-C', out, 'show', 'HEAD:src/value.txt'], { encoding: 'utf8' }),
      'danger\n',
    );
  } finally {
    if (existsSync(out)) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', out]);
    rmSync(root, { recursive: true, force: true });
  }
});
