'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ENGINE_DEFAULTS,
  CI_NOTE,
  alwaysLaneProblems,
  codeReviewEngineProblems,
  parseReviewArgs,
  resolveOptions,
} = require('./options.cjs');

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
    { message: 'engine.code_review.always references unknown agent: testing' },
  );
  const disabled = { agents: [...lanes(['security', 'standards']), { id: 'testing', enabled: false }] };
  assert.throws(
    () => resolveOptions({ args: 'engine=code-review', config: disabled }),
    { message: 'engine.code_review.always references disabled agent: testing' },
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

test('resolve: a replaces id the repo lacks is a note under the code-review engine', () => {
  const NOTE = 'engine.code_review.replaces lists an unknown lane: architecure';
  const unknownNotes = (r) => r.notes.filter((n) => n.startsWith('engine.code_review.replaces lists an unknown lane'));
  const typo = { agents: FULL, engine: { code_review: { replaces: ['architecure', 'simplification'] } } };
  assert.deepEqual(unknownNotes(resolveOptions({ args: 'engine=code-review', config: typo })), [NOTE]);

  const valid = { agents: FULL, engine: { code_review: { replaces: ['architecture', 'simplification'] } } };
  assert.deepEqual(unknownNotes(resolveOptions({ args: 'engine=code-review', config: valid })), []);

  const defaults = { agents: lanes(['security', 'testing', 'standards']) };
  assert.deepEqual(
    unknownNotes(resolveOptions({ args: 'engine=code-review', config: defaults })),
    [],
    'the built-in default list is not something the repo wrote',
  );

  assert.deepEqual(unknownNotes(resolveOptions({ args: 'engine=agent-review', config: typo })), []);
  assert.deepEqual(unknownNotes(resolveOptions({ args: 'engine=code-review', config: typo, ci: true })), []);
});

const RESERVED = 'agent id "code-review" is reserved for the code-review engine';

test('resolve: the code-review id is reserved only when the engine resolves to code-review', () => {
  const config = { agents: [...FULL, { id: 'code-review' }] };
  assert.throws(() => resolveOptions({ args: 'engine=code-review', config }), { message: RESERVED });
  assert.throws(
    () => resolveOptions({ args: '', config: { ...config, engine: { name: 'code-review' } } }),
    { message: RESERVED },
  );
  for (const [args, cfg] of [
    ['', config],
    ['engine=agent-review', config],
    ['', { ...config, engine: { name: 'agent-review' } }],
    ['engine=agent-review', { ...config, engine: { name: 'code-review' } }],
  ]) {
    assert.equal(resolveOptions({ args, config: cfg }).engine.value, 'agent-review', `${args} ${JSON.stringify(cfg.engine)}`);
  }
  const ci = resolveOptions({ args: '', config: { ...config, engine: { name: 'code-review' } }, ci: true });
  assert.equal(ci.engine.value, 'agent-review', 'CI falls back to the default engine, so the reserved id does not stop the run');
});

test('codeReviewEngineProblems lists every engine-only problem in config validate wording', () => {
  assert.deepEqual(codeReviewEngineProblems({ agents: FULL }), []);
  assert.deepEqual(codeReviewEngineProblems({ agents: FULL, engine: { name: 'code-review', code_review: { effort: 'high' } } }), []);
  assert.deepEqual(
    codeReviewEngineProblems({
      agents: [{ id: 'security' }, { id: 'standards', enabled: false }, { id: 'code-review' }],
      engine: { name: 'code-review', code_review: { always: ['security', 'testing', 'standards'] } },
    }),
    [
      RESERVED,
      'engine.code_review.always references unknown agent: testing',
      'engine.code_review.always references disabled agent: standards',
    ],
  );
  assert.deepEqual(
    codeReviewEngineProblems({ agents: [{ id: 'security' }], engine: { code_review: { always: ['security'], replaces: ['security'] } } }),
    ['engine.code_review lists security in both always and replaces'],
  );
  assert.deepEqual(
    codeReviewEngineProblems({ agents: FULL, engine: { code_review: { replaces: ['architecture', 'simplification', 'security'] } } }),
    ['engine.code_review lists security in both always (default) and replaces'],
  );
  assert.deepEqual(
    codeReviewEngineProblems({ agents: FULL, engine: { code_review: { always: ['security', 'testing', 'standards', 'architecture'] } } }),
    ['engine.code_review lists architecture in both always and replaces (default)'],
  );
  assert.deepEqual(codeReviewEngineProblems({ agents: FULL, engine: { code_review: { replaces: ['nope'] } } }), []);
});

test('resolve: error messages name every vocabulary entry', () => {
  const { ENGINES, EFFORTS } = require('./vocabulary.cjs');
  const config = { agents: FULL };
  const msg = (args) => {
    try {
      resolveOptions({ args, config });
    } catch (e) {
      return e.message;
    }
    return '';
  };
  for (const e of ENGINES) assert.ok(msg('engine=lanes').includes(e), e);
  for (const e of EFFORTS) assert.ok(msg('effort=extreme').includes(e), e);
});

test('resolveOptions lists every engine problem', () => {
  const config = {
    agents: [{ id: 'security' }, { id: 'testing', enabled: false }, { id: 'standards' }, { id: 'code-review' }],
    engine: { name: 'code-review' },
  };
  const expected = codeReviewEngineProblems(config);
  assert.equal(expected.length, 2);
  assert.throws(() => resolveOptions({ args: '', config }), { message: expected.join('; ') });
  assert.ok(expected.includes('engine.code_review.always references disabled agent: testing'));
  assert.ok(expected.includes(RESERVED));

  const ghost = {
    agents: FULL,
    engine: { name: 'code-review', code_review: { always: ['ghost', 'security'], replaces: ['security'] } },
  };
  assert.throws(() => resolveOptions({ args: '', config: ghost }), {
    message: 'engine.code_review.always references unknown agent: ghost; engine.code_review lists security in both always and replaces',
  });
});

test('resolveOptions leaves a repo with no engine key, or on the agent-review engine, alone', () => {
  const bad = { agents: [{ id: 'code-review' }], engine: { code_review: { always: ['ghost'] } } };
  assert.equal(resolveOptions({ args: '', config: { agents: bad.agents } }).engine.value, 'agent-review');
  assert.equal(resolveOptions({ args: 'engine=agent-review', config: bad }).engine.value, 'agent-review');
});

test('two mode words name both words', () => {
  assert.throws(() => parseReviewArgs('auto quick'), {
    message: 'two mode words given: "auto" and "quick"; pass only one',
  });
  assert.throws(() => resolveOptions({ args: 'deep run a quick pass', config: { agents: FULL } }), {
    message: 'two mode words given: "deep" and "quick"; pass only one',
  });
  assert.equal(parseReviewArgs('quick quick').mode, 'quick', 'the same word twice is one word');
});
