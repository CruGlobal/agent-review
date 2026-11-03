'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { humanRules, LABEL } = require('./humanApproval.cjs');

const NONE = { required: false, reasons: [] };
const PCI = 'human_approval:\n  paths:\n    - "app/payments/**"\n';

test('the label is needs-human-approval', () => {
  assert.equal(LABEL, 'needs-human-approval');
});

test('no config, an empty config, or no human_approval block means no rules', () => {
  assert.deepEqual(humanRules(null, ['a.rb']), NONE);
  assert.deepEqual(humanRules('', ['a.rb']), NONE);
  assert.deepEqual(humanRules('reviews_run: local\n', ['a.rb']), NONE);
});

test('always: true requires a person for any change', () => {
  assert.deepEqual(humanRules('human_approval:\n  always: true\n', ['README.md']), {
    required: true,
    reasons: ['every PR in this repo needs a person (human_approval.always)'],
  });
});

test('a changed file under a PCI glob is named', () => {
  assert.deepEqual(humanRules(PCI, ['app/payments/charge.rb', 'lib/x.rb']), {
    required: true,
    reasons: ['PCI path: app/payments/charge.rb'],
  });
});

test('a rename out of a PCI path still requires a person', () => {
  const r = humanRules(PCI, ['app/payments/old.rb', 'app/billing/new.rb']);
  assert.equal(r.required, true);
  assert.deepEqual(r.reasons, ['PCI path: app/payments/old.rb']);
});

test('a bare folder in paths covers everything under it, with or without a trailing slash', () => {
  for (const glob of ['app/payments/', 'app/payments', 'app/payments//']) {
    const config = `human_approval:\n  paths:\n    - "${glob}"\n`;
    assert.deepEqual(humanRules(config, ['app/payments/charge.rb', 'app/payments/tsys/sale.rb', 'lib/x.rb']).reasons, [
      'PCI path: app/payments/charge.rb',
      'PCI path: app/payments/tsys/sale.rb',
    ], glob);
    assert.equal(humanRules(config, ['app/payments_report.rb', 'app/paymentsx/a.rb']).required, false, `${glob}: a sibling with the same prefix is not inside`);
  }
  const files = humanRules('human_approval:\n  paths:\n    - "app/*.rb"\n    - "Gemfile"\n', ['app/a.rb', 'Gemfile', 'app/b/c.rb']);
  assert.deepEqual(files.reasons, ['PCI path: Gemfile', 'PCI path: app/a.rb'], 'file globs and file names keep matching as before');
  assert.equal(humanRules('human_approval:\n  paths:\n    - "/"\n', ['a.rb']).required, false, 'a lone slash is not every file');
});

test('dotfiles match a PCI glob', () => {
  assert.deepEqual(humanRules(PCI, ['app/payments/.secret.rb']).reasons, [
    'PCI path: app/payments/.secret.rb',
  ]);
});

test('PCI reasons are sorted and list each file once', () => {
  assert.deepEqual(
    humanRules(PCI, ['app/payments/b.rb', 'app/payments/a.rb', 'app/payments/b.rb']).reasons,
    ['PCI path: app/payments/a.rb', 'PCI path: app/payments/b.rb'],
  );
});

test('reasons come in order: always, PCI paths, config change', () => {
  const cfg = 'human_approval:\n  always: true\n  paths: ["app/payments/**"]\n';
  assert.deepEqual(humanRules(cfg, ['.claude/review/config.yml', 'app/payments/a.rb']).reasons, [
    'every PR in this repo needs a person (human_approval.always)',
    'PCI path: app/payments/a.rb',
    'changes the human_approval config',
  ]);
});

test('changing the config under a base that sets paths requires a person', () => {
  assert.deepEqual(humanRules(PCI, ['.claude/review/config.yml']), {
    required: true,
    reasons: ['changes the human_approval config'],
  });
});

test('changing the config with no human_approval block is not required', () => {
  assert.deepEqual(humanRules('reviews_run: local\n', ['.claude/review/config.yml']), NONE);
  assert.deepEqual(humanRules('human_approval:\n  always: false\n  paths: []\n', ['.claude/review/config.yml']), NONE);
});

test('a bad human_approval block or bad YAML throws', () => {
  assert.throws(() => humanRules("human_approval:\n  always: 'yes'\n", []));
  assert.throws(() => humanRules('human_approval:\n  paths: "app/**"\n', []));
  assert.throws(() => humanRules('human_approval:\n  paths: [1]\n', []));
  assert.throws(() => humanRules('human_approval:\n  reviewers: []\n', []));
  assert.throws(() => humanRules('human_approval: yes\n', []));
  assert.throws(() => humanRules('a: [unclosed\n', []));
});

test('an incomplete file list is an error when the base config sets paths', () => {
  assert.throws(() => humanRules(PCI, ['lib/x.rb'], { incomplete: true }), /^Error: the PR's file list is incomplete$/);
  assert.throws(
    () => humanRules(PCI, ['app/payments/a.rb'], { incomplete: true }),
    /the PR's file list is incomplete/,
    'a partial list cannot prove the rest is clean, even when it already matches',
  );
});

test('an incomplete file list is an error when the base config sets always', () => {
  assert.throws(
    () => humanRules('human_approval:\n  always: true\n', ['README.md'], { incomplete: true }),
    /the PR's file list is incomplete/,
  );
});

test('an incomplete file list changes nothing when the base config sets no rules', () => {
  for (const cfg of [null, '', 'reviews_run: local\n', 'human_approval:\n  always: false\n  paths: []\n']) {
    assert.deepEqual(humanRules(cfg, ['app/payments/a.rb'], { incomplete: true }), NONE);
  }
});

test('a complete file list is judged as before', () => {
  assert.deepEqual(humanRules(PCI, ['lib/x.rb'], { incomplete: false }), NONE);
  assert.deepEqual(humanRules(PCI, ['lib/x.rb']), NONE);
});

test('unrelated keys do not break the rule check', () => {
  assert.deepEqual(humanRules('future_key: {x: 1}\n' + PCI, ['app/payments/a.rb']).required, true);
});
