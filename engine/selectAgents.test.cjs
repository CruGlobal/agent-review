'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectAgents, codeDiff, contentMatches } = require('./selectAgents.cjs');

const config = {
  excluded_paths: ['**/*.snap'],
  agents: [
    { id: 'architecture', always: true, escalates: true },
    { id: 'testing', always: true },
    { id: 'standards', always: true },
    {
      id: 'security',
      triggers: { paths: ['pages/api/**'], content: ['process.env.'] },
    },
    {
      id: 'ux',
      model: 'opus',
      triggers: { paths: ['src/components/**/*.tsx'] },
    },
    {
      id: 'financial',
      enabled: false,
      triggers: { paths: ['src/components/Reports/**'] },
    },
  ],
};

test('UI-only change selects always-on agents + ux', () => {
  const sel = selectAgents(
    { files: ['src/components/Tasks/TaskRow.tsx'], diffText: '+ const x = 1;' },
    config,
  );
  assert.deepEqual(sel.map((a) => a.id).sort(), [
    'architecture',
    'standards',
    'testing',
    'ux',
  ]);
  assert.equal(sel.find((a) => a.id === 'ux').model, 'opus');
  assert.equal(sel.find((a) => a.id === 'architecture').escalates, true);
});

test('content trigger selects security via process.env', () => {
  const sel = selectAgents(
    { files: ['src/lib/foo.ts'], diffText: '+ const k = process.env.SECRET;' },
    config,
  );
  assert.ok(
    sel.some(
      (a) => a.id === 'security' && a.matchedBy === 'content:process.env.',
    ),
  );
});

test('disabled agent never selected', () => {
  const sel = selectAgents(
    { files: ['src/components/Reports/Report.tsx'], diffText: '' },
    config,
  );
  assert.ok(!sel.some((a) => a.id === 'financial'));
});

test('selected agents carry their config triggers verbatim', () => {
  const sel = selectAgents(
    { files: ['pages/api/foo.ts'], diffText: '' },
    config,
  );
  const security = sel.find((a) => a.id === 'security');
  assert.deepEqual(security.triggers, {
    paths: ['pages/api/**'],
    content: ['process.env.'],
  });
  const architecture = sel.find((a) => a.id === 'architecture');
  assert.ok('triggers' in architecture);
  assert.equal(architecture.triggers, undefined);
});

// Task 2 (slice) reads `always` off the plan agent directly — it sits beside
// `triggers` in config, not inside it — to decide the full-diff rule.
test('selected agents carry the config always flag beside triggers', () => {
  const sel = selectAgents(
    { files: ['pages/api/foo.ts'], diffText: '' },
    config,
  );
  assert.equal(sel.find((a) => a.id === 'architecture').always, true);
  assert.equal(sel.find((a) => a.id === 'security').always, false);
});

// Coverage guarantee: an unmatched reviewable file (outside the risk map, same
// set scoreRisk floors) must not slip through on always-on, non-escalating
// agents alone. Local config below deliberately omits the shared `config`
// above's always-on escalating `architecture` lane so the guarantee's own
// force-include is what's under test.
const coverageConfig = {
  excluded_paths: ['**/*.md'],
  risk: {
    patterns: [{ glob: 'src/known/**', points: 1, tier: 'low' }],
  },
  agents: [
    {
      id: 'security',
      escalates: true,
      triggers: { paths: ['pages/api/**'] },
    },
    { id: 'style', always: true },
  ],
};

test('an escalating lane is force-included when unmatched reviewable files exist', () => {
  const sel = selectAgents(
    { files: ['src/unmatched.js'], diffText: '' },
    coverageConfig,
  );
  assert.ok(sel.some((a) => a.id === 'style'), 'always-on lane still selected');
  const security = sel.find((a) => a.id === 'security');
  assert.ok(security, 'security force-included for unmatched coverage');
  assert.equal(security.matchedBy, 'unmatched-coverage');
});

test('an already-selected escalating lane suppresses the coverage guarantee', () => {
  const cfg = {
    ...coverageConfig,
    agents: [
      { id: 'architecture', always: true, escalates: true },
      ...coverageConfig.agents,
    ],
  };
  const sel = selectAgents(
    { files: ['src/unmatched.js'], diffText: '' },
    cfg,
  );
  assert.ok(sel.some((a) => a.id === 'architecture' && a.escalates));
  assert.ok(
    !sel.some((a) => a.id === 'security'),
    'security not force-included once an escalating lane is already selected',
  );
});

test('no force-include when the diff has no unmatched reviewable files', () => {
  // excluded path: never reaches the reviewable set at all.
  const excluded = selectAgents(
    { files: ['docs/readme.md'], diffText: '' },
    coverageConfig,
  );
  assert.ok(!excluded.some((a) => a.id === 'security'));

  // reviewable but matched by a risk pattern: not "unmatched".
  const matched = selectAgents(
    { files: ['src/known/thing.js'], diffText: '' },
    coverageConfig,
  );
  assert.ok(!matched.some((a) => a.id === 'security'));
});

test('a disabled security agent is never force-included for coverage', () => {
  const cfg = {
    ...coverageConfig,
    agents: [
      {
        id: 'security',
        enabled: false,
        escalates: true,
        triggers: { paths: ['pages/api/**'] },
      },
      { id: 'style', always: true },
    ],
  };
  const sel = selectAgents(
    { files: ['src/unmatched.js'], diffText: '' },
    cfg,
  );
  assert.ok(!sel.some((a) => a.id === 'security'));
  assert.ok(!sel.some((a) => a.matchedBy === 'unmatched-coverage'));
});

test('falls back to the first escalating agent in config order when there is no security agent', () => {
  const cfg = {
    ...coverageConfig,
    agents: [
      { id: 'style', always: true },
      {
        id: 'data-integrity',
        escalates: true,
        triggers: { paths: ['migrations/**'] },
      },
      { id: 'perf', escalates: true, triggers: { paths: ['perf/**'] } },
    ],
  };
  const sel = selectAgents(
    { files: ['src/unmatched.js'], diffText: '' },
    cfg,
  );
  const forced = sel.find((a) => a.matchedBy === 'unmatched-coverage');
  assert.ok(forced, 'an escalating lane was force-included');
  assert.equal(forced.id, 'data-integrity', 'first escalates:true agent in config order wins');
});

// I4a (final review, belt-and-suspenders): an operator explicitly de-escalating
// the security lane must not silently defeat the coverage guarantee when a
// genuinely escalating lane is available — prefer it over an id-only match.
test('coverage guarantee prefers a genuinely escalating lane over a de-escalated security lane', () => {
  const cfg = {
    ...coverageConfig,
    agents: [
      {
        id: 'security',
        escalates: false,
        triggers: { paths: ['pages/api/**'] },
      },
      {
        id: 'data-integrity',
        escalates: true,
        triggers: { paths: ['migrations/**'] },
      },
      { id: 'style', always: true },
    ],
  };
  const sel = selectAgents({ files: ['src/unmatched.js'], diffText: '' }, cfg);
  const forced = sel.find((a) => a.matchedBy === 'unmatched-coverage');
  assert.ok(forced, 'a lane was force-included');
  assert.equal(forced.id, 'data-integrity', 'the genuinely escalating lane wins over de-escalated security');
  assert.equal(forced.escalates, true);
});

// When EVERY lane is explicitly de-escalated (including security), the engine
// still forces security-by-id as today — the operator override is honored,
// but templates/config.yml's WARNING says plainly this disables escalation.
test('coverage guarantee still forces security-by-id when every lane is de-escalated', () => {
  const cfg = {
    ...coverageConfig,
    agents: [
      {
        id: 'security',
        escalates: false,
        triggers: { paths: ['pages/api/**'] },
      },
      { id: 'style', always: true, escalates: false },
    ],
  };
  const sel = selectAgents({ files: ['src/unmatched.js'], diffText: '' }, cfg);
  const forced = sel.find((a) => a.matchedBy === 'unmatched-coverage');
  assert.ok(forced, 'security is still force-included by id');
  assert.equal(forced.id, 'security');
  assert.equal(forced.escalates, false, 'the operator override is honored — the lane does not actually escalate');
});

test('codeDiff drops the reviewer config under a custom review dir', () => {
  const cfg = { excluded_paths: [], agents: [] };
  const diff = 'diff --git a/.review/config.yml b/.review/config.yml\n+content: [foo]\n';
  assert.strictEqual(codeDiff(diff, cfg, '.review'), '');
});

test('identifier content triggers do not match inside larger identifiers', () => {
  assert.equal(contentMatches('+ concurrency:\n', 'currency'), false);
  assert.equal(contentMatches('+ currency = donation.currency\n', 'currency'), true);
  assert.equal(contentMatches('+ process.env.SECRET\n', 'process.env'), true);
  assert.equal(contentMatches('+ total.round(2)\n', '.round('), true);
});
