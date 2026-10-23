'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ENGINE_DEFAULTS, CI_NOTE, alwaysLaneProblems, parseReviewArgs, resolveOptions } = require('./options.cjs');

const lanes = (ids) => ids.map((id) => ({ id, enabled: true }));
const FULL = lanes(['security', 'testing', 'standards', 'architecture', 'simplification']);

test('parse: mode words, flags, key=value in any order', () => {
  assert.deepEqual(parseReviewArgs('effort=MAX incremental Engine=code-review auto ci'), {
    mode: 'auto',
    ci: true,
    incremental: true,
    engine: 'code-review',
    effort: 'max',
    unknown: [],
  });
});

test('parse: unknown tokens are collected', () => {
  assert.deepEqual(parseReviewArgs('auto frobnicate').unknown, ['frobnicate']);
});

test('parse: conflicting duplicates throw', () => {
  assert.throws(
    () => parseReviewArgs('engine=code-review engine=agent-review'),
    /conflicting engine= values/,
  );
});

test('resolve: argument beats config beats default', () => {
  const config = { agents: FULL, engine: { name: 'agent-review' } };
  assert.deepEqual(resolveOptions({ args: 'engine=code-review', config }).engine, {
    value: 'code-review',
    source: 'argument',
  });
  assert.deepEqual(resolveOptions({ args: '', config }).engine, {
    value: 'agent-review',
    source: 'config',
  });
  assert.deepEqual(resolveOptions({ args: '', config: { agents: FULL } }).engine, {
    value: 'agent-review',
    source: 'default',
  });
});

test('resolve: code-review defaults', () => {
  const r = resolveOptions({ args: 'engine=code-review', config: { agents: FULL } });
  assert.deepEqual(r.effort, { value: 'xhigh', source: 'default' });
  assert.deepEqual(r.model, { value: 'opus', source: 'default' });
  assert.deepEqual(r.replaces, ENGINE_DEFAULTS.replaces);
  assert.deepEqual(r.always, ENGINE_DEFAULTS.always);
  assert.equal(r.maxFindings, null);
});

test('resolve: config supplies code-review settings', () => {
  const config = {
    agents: FULL,
    engine: { name: 'code-review', code_review: { effort: 'high', model: 'sonnet', max_findings: 'all' } },
  };
  const r = resolveOptions({ args: 'effort=max', config });
  assert.deepEqual(r.effort, { value: 'max', source: 'argument' });
  assert.deepEqual(r.model, { value: 'sonnet', source: 'config' });
  assert.deepEqual(r.maxFindings, { value: 'all', source: 'config' });
  assert.equal(resolveOptions({ args: '', config }).effort.source, 'config');
});

test('resolve: effort ignored under agent-review', () => {
  const r = resolveOptions({ args: 'engine=agent-review effort=max', config: { agents: FULL } });
  assert.equal(r.effort, null);
  assert.ok(r.notes.includes('effort=max ignored: the agent-review engine does not use it.'));
});

test('resolve: CI forces agent-review', () => {
  const config = { agents: FULL, engine: { name: 'code-review' } };
  const r = resolveOptions({ args: '', config, ci: true });
  assert.deepEqual(r.engine, { value: 'agent-review', source: 'ci' });
  assert.ok(r.notes.includes(CI_NOTE));
  const quiet = resolveOptions({
    args: '',
    config: { agents: FULL, engine: { name: 'agent-review' } },
    ci: true,
  });
  assert.deepEqual(quiet.notes, []);
});

test('resolve: the CI note says CI findings count and only the local review approves', () => {
  assert.equal(
    CI_NOTE,
    "The code-review engine runs locally only; CI ran agent-review's own reviewers, and only the local review can approve.",
  );
});

test('resolve: invalid values throw', () => {
  const config = { agents: FULL };
  assert.throws(
    () => resolveOptions({ args: 'effort=extreme', config }),
    /unknown effort "extreme" \(use low, medium, high, xhigh, or max\)/,
  );
  assert.throws(
    () => resolveOptions({ args: 'engine=lanes', config }),
    /unknown engine "lanes" \(use agent-review or code-review\)/,
  );
});

test('resolve: a lane in both effective lists throws, defaults included', () => {
  const replacesSecurity = { agents: FULL, engine: { code_review: { replaces: ['architecture', 'simplification', 'security'] } } };
  assert.throws(
    () => resolveOptions({ args: 'engine=code-review', config: replacesSecurity }),
    (e) => e.message.includes('security') && e.message.includes('always (default)') && e.message.includes('replaces'),
  );
  const alwaysArchitecture = { agents: FULL, engine: { code_review: { always: ['security', 'testing', 'standards', 'architecture'] } } };
  assert.throws(
    () => resolveOptions({ args: 'engine=code-review', config: alwaysArchitecture }),
    (e) => e.message.includes('architecture') && e.message.includes('always') && e.message.includes('replaces (default)'),
  );
  assert.doesNotThrow(() => resolveOptions({ args: 'engine=agent-review', config: replacesSecurity }));
});

test('resolve: missing or disabled always lane throws', () => {
  const missing = { agents: lanes(['security', 'standards']) };
  assert.throws(
    () => resolveOptions({ args: 'engine=code-review', config: missing }),
    (e) => e.message.includes('"testing"') && e.message.includes('engine.code_review.always'),
  );
  const disabled = { agents: [...lanes(['security', 'standards']), { id: 'testing', enabled: false }] };
  assert.throws(
    () => resolveOptions({ args: 'engine=code-review', config: disabled }),
    /"testing"/,
  );
  assert.doesNotThrow(() => resolveOptions({ args: 'engine=agent-review', config: missing }));
});

test('resolve: reviews_run', () => {
  assert.deepEqual(resolveOptions({ args: '', config: {} }).reviewsRun, {
    value: 'local-and-ci',
    source: 'default',
  });
  assert.deepEqual(resolveOptions({ args: '', config: { reviews_run: 'local' } }).reviewsRun, {
    value: 'local',
    source: 'config',
  });
});

test('resolve: mode defaults to standard', () => {
  assert.deepEqual(resolveOptions({ args: '', config: {} }).mode, { value: 'standard', source: 'default' });
  assert.deepEqual(resolveOptions({ args: 'deep', config: {} }).mode, { value: 'deep', source: 'argument' });
});

test('resolve: unknown tokens become a note', () => {
  const r = resolveOptions({ args: 'auto engin=code-review frobnicate', config: { agents: FULL } });
  assert.deepEqual(
    r.notes.filter((n) => n.startsWith('ignored unknown')),
    ['ignored unknown argument(s): engin=code-review, frobnicate'],
  );
  const clean = resolveOptions({ args: 'auto', config: { agents: FULL } });
  assert.equal(clean.notes.some((n) => n.startsWith('ignored unknown')), false);
});

test('alwaysLaneProblems is the one always-lane rule that resolve and validate share', () => {
  assert.deepEqual(alwaysLaneProblems({}, FULL), []);
  assert.deepEqual(
    alwaysLaneProblems({}, [...lanes(['security', 'standards']), { id: 'testing', enabled: false }]),
    [{ id: 'testing', kind: 'disabled' }],
  );
  assert.deepEqual(
    alwaysLaneProblems({ always: ['security', 'nope'], replaces: ['security'] }, FULL),
    [{ id: 'security', kind: 'overlap' }, { id: 'nope', kind: 'unknown' }],
  );
  assert.deepEqual(alwaysLaneProblems({}, undefined).map((p) => p.kind), ['unknown', 'unknown', 'unknown']);
});
