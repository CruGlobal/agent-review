'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consensusFrom, tokenize, jaccard } = require('./consensus.cjs');

test('(a) paraphrased findings from two agents on nearby lines group into one, corroboration 2, comma-joined agent', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/user.rb',
        line: 120,
        severity: 6,
        category: 'correctness',
        confidence: 'Medium',
        message: 'missing null check on user input before save',
        evidence: 'user.save without checking params[:name]',
        recommendation: 'add a null check before save',
      },
    ],
    agentB: [
      {
        file: 'app/models/user.rb',
        line: 122,
        severity: 8,
        category: 'correctness',
        confidence: 'High',
        message: 'user input is missing a null check before saving',
        evidence:
          'params[:name] used directly in user.save call without validation, see spec/models/user_spec.rb for reproduction',
        recommendation: 'validate input is present before calling save',
      },
    ],
  };

  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });

  assert.equal(findings.length, 1);
  assert.equal(candidates.length, 0);
  const f = findings[0];
  assert.equal(f.corroboration, 2);
  assert.equal(f.agent, 'agentB'); // primary (highest-severity member) — signature-stable
  assert.equal(f.agents, 'agentA,agentB'); // full corroborating set, display/corroboration field
  assert.equal(f.severity, 7); // rounded mean of 6 and 8
  assert.equal(f.line, 122); // highest-severity member's line (agentB, severity 8)
  assert.equal(f.confidence, 'High');
  assert.equal(f.needsHumanReview, false);
});

test('(b) same file, nearby-but-not-close-enough lines, unrelated wording -> two findings + one candidate pair', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/user.rb',
        line: 120,
        severity: 5,
        message: 'missing null check on user input before save',
      },
    ],
    agentC: [
      {
        file: 'app/models/user.rb',
        line: 128,
        severity: 4,
        message: 'inefficient N+1 query when loading associated posts',
      },
    ],
  };

  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });

  assert.equal(findings.length, 2);
  assert.equal(candidates.length, 1);
  // sorted by severity desc: severity 5 first (index 0), severity 4 second (index 1)
  assert.equal(findings[0].severity, 5);
  assert.equal(findings[1].severity, 4);
  assert.deepEqual(
    { a: candidates[0].a, b: candidates[0].b },
    { a: 0, b: 1 },
  );
  assert.match(candidates[0].reason, /app\/models\/user\.rb/);
});

test('(c) severity spread >= 4 within a group sets needsHumanReview', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/order.rb',
        line: 50,
        severity: 9,
        category: 'security',
        confidence: 'High',
        evidence: 'raw string interpolation of order id into the SQL query builder call',
        message: 'SQL injection risk from unsanitized order id in raw query',
      },
    ],
    agentB: [
      {
        file: 'app/models/order.rb',
        line: 51,
        severity: 4,
        category: 'security',
        confidence: 'Low',
        message: 'unsanitized order id used in raw query risks SQL injection',
      },
    ],
  };

  const { findings } = consensusFrom({ findingsByAgent, profile: 'standard' });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].needsHumanReview, true);
  assert.equal(findings[0].severity, 7); // Math.round((9 + 4) / 2)
});

test('(d) missing lane file with --plan throws naming the lane', () => {
  const plan = { agents: [{ id: 'agentA' }, { id: 'agentB' }] };
  const findingsByAgent = { agentA: [] }; // agentB has no entry at all

  assert.throws(
    () => consensusFrom({ plan, findingsByAgent, profile: 'standard' }),
    /agentB/,
  );
});

test('(e) truncated JSON for a lane throws', () => {
  const plan = { agents: [{ id: 'agentA' }] };
  const findingsByAgent = {
    agentA: '{"findings": [ { "file": "x.js", "message": "oops"',
  };

  assert.throws(
    () => consensusFrom({ plan, findingsByAgent, profile: 'standard' }),
    /agentA/,
  );
});

test('(f) empty findings array is valid and contributes nothing', () => {
  const { findings, candidates, stats } = consensusFrom({
    findingsByAgent: { agentA: [] },
    profile: 'standard',
  });

  assert.deepEqual(findings, []);
  assert.deepEqual(candidates, []);
  assert.equal(stats.raw, 0);
});

test('(g) decisions merge combines two candidates into a group', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/user.rb',
        line: 120,
        severity: 5,
        message: 'missing null check on user input before save',
      },
    ],
    agentC: [
      {
        file: 'app/models/user.rb',
        line: 128,
        severity: 4,
        message: 'inefficient N+1 query when loading associated posts',
      },
    ],
  };

  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(first.findings.length, 2);
  assert.equal(first.candidates.length, 1);
  const { a, b } = first.candidates[0];

  const second = consensusFrom({
    findingsByAgent,
    profile: 'standard',
    decisions: [{ merge: [a, b] }],
  });

  assert.equal(second.findings.length, 1);
  assert.equal(second.findings[0].corroboration, 2);
  assert.equal(second.findings[0].agent, 'agentA'); // primary: severity 5 > agentC's 4
  assert.equal(second.findings[0].agents, 'agentA,agentC');
});

test('unknown decision index throws', () => {
  const findingsByAgent = {
    agentA: [
      { file: 'a.rb', line: 1, severity: 5, message: 'one thing' },
    ],
  };
  assert.throws(
    () =>
      consensusFrom({
        findingsByAgent,
        profile: 'standard',
        decisions: [{ merge: [0, 99] }],
      }),
    /unknown finding index/,
  );
});

test('(h) chill profile drops an uncorroborated severity-3 finding but keeps a corroborated one', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'a.rb',
        line: 10,
        severity: 3,
        message: 'minor style nit about extra whitespace at end of line',
      },
      {
        file: 'b.rb',
        line: 30,
        severity: 3,
        message: 'duplicate require statement for lodash near top of file',
      },
    ],
    agentB: [
      {
        file: 'b.rb',
        line: 31,
        severity: 3,
        message: 'duplicate lodash require statement found near the top of the file',
      },
    ],
  };

  const { findings } = consensusFrom({ findingsByAgent, profile: 'chill' });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'b.rb');
  assert.equal(findings[0].corroboration, 2);
  assert.equal(findings[0].severity, 3);
});

// --- Controller ruling: automatic merging requires a clique, not a connected ---
// --- component. A-B and B-C can each satisfy sameGroup while A-C does not.   ---

test('(clique) A-B and B-C match but A-C does not: NOT one group of 3 -- A+B merge, C stays separate, with a candidate pair', () => {
  const findingsByAgent = {
    agentA: [{ file: 'app/models/user.rb', line: 10, severity: 5, message: 'apple banana cherry', agent: 'agentA' }],
    agentB: [{ file: 'app/models/user.rb', line: 11, severity: 6, message: 'apple banana date', agent: 'agentB' }],
    agentC: [{ file: 'app/models/user.rb', line: 12, severity: 7, confidence: 'High', evidence: 'concrete verified path', message: 'banana date elderberry', agent: 'agentC' }],
  };

  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });

  // Sanity: this is a genuine chain, not a clique.
  assert.ok(jaccard(tokenize('apple banana cherry'), tokenize('apple banana date')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana date'), tokenize('banana date elderberry')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana cherry'), tokenize('banana date elderberry')) < 0.5);

  assert.equal(findings.length, 2); // NOT one group of 3
  // Canonical order (agentA, agentB, agentC) greedily merges A+B first; C can't
  // join that clique (fails against A) and forms its own singleton.
  const merged = findings.find((f) => f.corroboration === 2);
  const singleton = findings.find((f) => f.corroboration === 1);
  assert.ok(merged, 'expected an A+B group with corroboration 2');
  assert.equal(merged.agent, 'agentB'); // primary: severity 6 > agentA's 5
  assert.equal(merged.agents, 'agentA,agentB');
  assert.equal(merged.message, 'apple banana date'); // highest-severity member (agentB, sev 6)
  assert.equal(merged.line, 11);
  assert.ok(singleton, 'expected agentC to remain its own singleton');
  assert.equal(singleton.agent, 'agentC');
  assert.equal(singleton.message, 'banana date elderberry');

  // The two output entries are still close (same file, line distance <= 10),
  // so they surface as a candidate pair for the bounded model pass.
  assert.equal(candidates.length, 1);
  const [i, j] = [candidates[0].a, candidates[0].b];
  const pair = [findings[i].agents || findings[i].agent, findings[j].agents || findings[j].agent].sort();
  assert.deepEqual(pair, ['agentA,agentB', 'agentC']);
});

test('(clique) same repro with reversed input agent order produces an identical result', () => {
  const forwardOrder = {
    agentA: [{ file: 'app/models/user.rb', line: 10, severity: 5, message: 'apple banana cherry', agent: 'agentA' }],
    agentB: [{ file: 'app/models/user.rb', line: 11, severity: 6, message: 'apple banana date', agent: 'agentB' }],
    agentC: [{ file: 'app/models/user.rb', line: 12, severity: 7, message: 'banana date elderberry', agent: 'agentC' }],
  };
  const reversedOrder = {
    agentC: forwardOrder.agentC,
    agentB: forwardOrder.agentB,
    agentA: forwardOrder.agentA,
  };

  const forward = consensusFrom({ findingsByAgent: forwardOrder, profile: 'standard' });
  const reversed = consensusFrom({ findingsByAgent: reversedOrder, profile: 'standard' });

  assert.deepEqual(reversed, forward);
  const merged = reversed.findings.find((f) => f.corroboration === 2);
  assert.equal(merged.message, 'apple banana date');
  assert.equal(merged.line, 11);
});

test('(clique) a genuine 3-clique (every pair matches) still merges into one group, corroboration 3', () => {
  const findingsByAgent = {
    agentA: [{ file: 'svc/order.rb', line: 40, severity: 5, message: 'apple banana cherry date', agent: 'agentA' }],
    agentB: [{ file: 'svc/order.rb', line: 41, severity: 6, message: 'apple banana cherry elderberry', agent: 'agentB' }],
    agentC: [{ file: 'svc/order.rb', line: 42, severity: 7, confidence: 'High', evidence: 'concrete verified path', message: 'apple banana date elderberry', agent: 'agentC' }],
  };

  // Sanity: every pair meets the threshold -- a genuine clique.
  assert.ok(jaccard(tokenize('apple banana cherry date'), tokenize('apple banana cherry elderberry')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana cherry date'), tokenize('apple banana date elderberry')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana cherry elderberry'), tokenize('apple banana date elderberry')) >= 0.5);

  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].corroboration, 3);
  assert.equal(findings[0].agent, 'agentC'); // primary: highest severity (7)
  assert.equal(findings[0].agents, 'agentA,agentB,agentC');
  assert.equal(candidates.length, 0);
});

// --- Jaccard boundary pins ---

test('(jaccard) token sets at exactly 0.5 Jaccard are pinned and group', () => {
  const a = tokenize('alpha bravo charlie'); // {alpha,bravo,charlie}
  const b = tokenize('bravo charlie delta'); // {bravo,charlie,delta}
  assert.equal(jaccard(a, b), 0.5); // intersection 2 / union 4

  const findingsByAgent = {
    agentA: [{ file: 'lib/x.rb', line: 5, severity: 5, message: 'alpha bravo charlie', agent: 'agentA' }],
    agentB: [{ file: 'lib/x.rb', line: 6, severity: 5, message: 'bravo charlie delta', agent: 'agentB' }],
  };
  const { findings } = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].corroboration, 2);
});

test('(jaccard) token sets just under 0.5 Jaccard are pinned and do not group', () => {
  const a = tokenize('alpha bravo charlie'); // {alpha,bravo,charlie}
  const b = tokenize('bravo charlie delta echo'); // {bravo,charlie,delta,echo}
  assert.equal(jaccard(a, b), 0.4); // intersection 2 / union 5

  const findingsByAgent = {
    agentA: [{ file: 'lib/x.rb', line: 5, severity: 5, message: 'alpha bravo charlie', agent: 'agentA' }],
    agentB: [{ file: 'lib/x.rb', line: 6, severity: 5, message: 'bravo charlie delta echo', agent: 'agentB' }],
  };
  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(findings.length, 2);
  assert.equal(candidates.length, 1); // still close in file/line, so it's a candidate
});

// --- Controller ruling: `fix` threads through the pipeline additively, merged like `line` ---
// --- (highest-severity member's fix wins). ---

test('(fix) singleton entries carry the raw fix field through, empty string when absent', () => {
  const findingsByAgent = {
    agentA: [
      { file: 'a.rb', line: 1, severity: 5, message: 'one thing', fix: 'add a guard clause' },
      { file: 'b.rb', line: 2, severity: 5, message: 'another distinct thing entirely' },
    ],
  };
  const { findings } = consensusFrom({ findingsByAgent, profile: 'standard' });
  const withFix = findings.find((f) => f.file === 'a.rb');
  const withoutFix = findings.find((f) => f.file === 'b.rb');
  assert.equal(withFix.fix, 'add a guard clause');
  assert.equal(withoutFix.fix, '');
});

test('(fix) automatic clique merge picks the highest-severity member\'s fix, same rule as line', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/user.rb',
        line: 120,
        severity: 6,
        message: 'missing null check on user input before save',
        fix: 'agentA fix: add a nil guard',
      },
    ],
    agentB: [
      {
        file: 'app/models/user.rb',
        line: 122,
        severity: 8,
        confidence: 'High',
        evidence: 'params[:name] used directly in user.save without validation',
        message: 'user input is missing a null check before saving',
        fix: 'agentB fix: raise ArgumentError when name is blank',
      },
    ],
  };

  const { findings } = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 122); // highest-severity member's line (agentB)
  assert.equal(findings[0].fix, 'agentB fix: raise ArgumentError when name is blank');
});

test('(fix) decisions merge also carries the higher-severity member\'s fix', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'app/models/user.rb',
        line: 120,
        severity: 5,
        message: 'missing null check on user input before save',
        fix: 'agentA fix: add a nil guard',
      },
    ],
    agentC: [
      {
        file: 'app/models/user.rb',
        line: 128,
        severity: 4,
        message: 'inefficient N+1 query when loading associated posts',
        fix: 'agentC fix: use includes(:posts)',
      },
    ],
  };

  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(first.candidates.length, 1);
  const { a, b } = first.candidates[0];

  const second = consensusFrom({
    findingsByAgent,
    profile: 'standard',
    decisions: [{ merge: [a, b] }],
  });

  assert.equal(second.findings.length, 1);
  assert.equal(second.findings[0].fix, 'agentA fix: add a nil guard'); // agentA severity 5 > agentC severity 4
});

// --- I3: `agent` (the primary lane, signature-stable) vs `agents` (full corroborating set) ---

test('(agent-signature) findingSignature on the output entry is identical whether corroboration is 1 or 3 for the same primary', () => {
  const { signature } = require('./findingSignature.cjs');

  const singletonOnly = {
    agentA: [
      {
        file: 'svc/order.rb',
        line: 10,
        severity: 9,
        category: 'security',
        confidence: 'High',
        evidence: 'concrete verified execution path',
        message: 'apple banana cherry date',
      },
    ],
  };
  const corroboratedTrio = {
    agentA: [
      {
        file: 'svc/order.rb',
        line: 10,
        severity: 9,
        category: 'security',
        confidence: 'High',
        evidence: 'concrete verified execution path',
        message: 'apple banana cherry date',
      },
    ],
    agentB: [
      { file: 'svc/order.rb', line: 11, severity: 6, category: 'security', message: 'apple banana cherry elderberry' },
    ],
    agentC: [
      { file: 'svc/order.rb', line: 12, severity: 5, category: 'security', message: 'apple banana date elderberry' },
    ],
  };

  const singleton = consensusFrom({ findingsByAgent: singletonOnly, profile: 'standard' }).findings[0];
  const trio = consensusFrom({ findingsByAgent: corroboratedTrio, profile: 'standard' }).findings[0];

  assert.equal(singleton.corroboration, 1);
  assert.equal(trio.corroboration, 3);
  // Same primary (agentA, highest severity) and identical message/category/file in both cases.
  assert.equal(singleton.agent, 'agentA');
  assert.equal(trio.agent, 'agentA');
  assert.equal(trio.message, singleton.message);
  assert.equal(signature(trio), signature(singleton), 'signature must not shift with corroboration count');

  // The display field still carries the full corroborating set.
  assert.equal(trio.agents, 'agentA,agentB,agentC');
});

// --- M1: decisions merges weight the severity mean by each member's corroboration ---

test('(weighted-mean) decisions merge weights severity mean by corroboration, not a flat member average', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'a.rb', line: 10, severity: 9, confidence: 'High',
        evidence: 'concrete verified execution path',
        message: 'apple banana cherry date elderberry fig',
      },
    ],
    agentB: [
      {
        file: 'a.rb', line: 11, severity: 7, confidence: 'High',
        evidence: 'concrete verified execution path',
        message: 'apple banana cherry date elderberry grape',
      },
    ],
    agentC: [
      { file: 'a.rb', line: 30, severity: 4, message: 'totally unrelated finding about something else' },
    ],
  };

  // First pass: agentA (9) + agentB (7) auto-merge into one clique (corroboration 2, severity
  // round((9+7)/2) = 8). agentC (severity 4, unrelated message) stays a singleton, far enough
  // away (line 30 vs 11) that it is not even a candidate.
  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  const pairEntry = first.findings.find((f) => f.corroboration === 2);
  const singletonEntry = first.findings.find((f) => f.corroboration === 1);
  assert.ok(pairEntry && singletonEntry);
  assert.equal(pairEntry.severity, 8);
  assert.equal(singletonEntry.severity, 4);

  const pairIndex = first.findings.indexOf(pairEntry);
  const singletonIndex = first.findings.indexOf(singletonEntry);

  // Force-merge the (severity 8, corroboration 2) group with the (severity 4, corroboration 1)
  // singleton via a decision. Weighted mean: (8*2 + 4*1) / 3 = 6.67 -> rounds to 7, not the flat
  // (8+4)/2 = 6.
  const second = consensusFrom({
    findingsByAgent,
    profile: 'standard',
    decisions: [{ merge: [pairIndex, singletonIndex] }],
  });

  assert.equal(second.findings.length, 1);
  assert.equal(second.findings[0].corroboration, 3);
  assert.equal(second.findings[0].severity, 7); // weighted mean, not 6
});

// --- I2: per-finding validation after normalization mirrors cleanFinding/blocker rules ---

test('(invalid) a finding with a non-integer/out-of-range severity is dropped and warned, not thrown', () => {
  const findingsByAgent = {
    agentA: [
      { file: 'a.rb', line: 5, severity: 'not-a-number', message: 'garbled severity from a flaky lane' },
      { file: 'a.rb', line: 6, severity: 5, message: 'a perfectly fine finding' },
    ],
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = consensusFrom({ findingsByAgent, profile: 'standard' });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].message, 'a perfectly fine finding');
  assert.equal(result.stats.droppedInvalid.length, 1);
  assert.equal(result.stats.droppedInvalid[0].lane, 'agentA');
  assert.match(result.stats.droppedInvalid[0].reason, /severity/i);
  assert.ok(warnings.some((w) => w.includes('agentA')), 'console.warn must name the lane');
});

test('(invalid) a severity >= 7 finding missing evidence/High confidence/line is dropped and warned', () => {
  const findingsByAgent = {
    agentA: [
      {
        file: 'a.rb',
        line: 5,
        severity: 8,
        confidence: 'Medium', // not High
        message: 'a would-be blocker missing the evidence bar',
      },
      {
        file: 'a.rb',
        line: 8,
        severity: 9,
        confidence: 'High',
        evidence: 'concrete verified execution path',
        message: 'a real blocker that survives',
      },
    ],
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = consensusFrom({ findingsByAgent, profile: 'standard' });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].message, 'a real blocker that survives');
  assert.equal(result.stats.droppedInvalid.length, 1);
  assert.equal(result.stats.droppedInvalid[0].lane, 'agentA');
  assert.match(result.stats.droppedInvalid[0].reason, /confidence|evidence|line/i);
});

test('(invalid) a run with no invalid findings at all reports an empty droppedInvalid, not undefined', () => {
  const findingsByAgent = {
    agentA: [{ file: 'a.rb', line: 1, severity: 5, message: 'fine' }],
  };
  const { stats } = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.deepEqual(stats.droppedInvalid, []);
});

const crFinding = (over) => ({
  file: 'a.rb',
  line: 10,
  severity: 8,
  category: 'correctness',
  confidence: 'High',
  message: 'something is wrong here',
  evidence: 'concrete evidence',
  ...over,
});
const runCr = (findings, lane = 'code-review') =>
  consensusFrom({ findingsByAgent: { [lane]: findings }, profile: 'standard' });

test('code-review cleanup findings cap at 6', () => {
  const { findings } = runCr([crFinding({ category: 'conventions' })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 6);
});

test('cap ignores case and whitespace', () => {
  const { findings } = runCr([
    crFinding({ category: ' Reuse ', file: 'r.rb', message: 'reuse the helper' }),
    crFinding({ category: 'Conventions', file: 'c.rb', message: 'follow the naming rule' }),
    crFinding({ category: 'test-coverage', file: 't.rb', message: 'no test for branch' }),
  ]);
  const by = Object.fromEntries(findings.map((f) => [f.file, f.severity]));
  assert.deepEqual(by, { 'r.rb': 6, 'c.rb': 6, 't.rb': 8 });
});

test('a 7+ without the blocker bar is capped, not dropped', () => {
  const { findings, stats } = runCr([
    crFinding({ line: null, file: 'n.rb', message: 'no line anchor' }),
    crFinding({ confidence: 'Medium', file: 'm.rb', message: 'medium confidence' }),
    crFinding({ evidence: '  ', file: 'e.rb', message: 'no evidence here' }),
  ]);
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.severity === 6));
  assert.deepEqual(stats.droppedInvalid, []);
});

test('other lanes are unchanged', () => {
  const kept = runCr([crFinding({ category: 'simplification', severity: 7 })], 'simplification');
  assert.equal(kept.findings[0].severity, 7);
  const dropped = runCr([crFinding({ line: null })], 'correctness');
  assert.equal(dropped.findings.length, 0);
  assert.equal(dropped.stats.droppedInvalid.length, 1);
});

test('the code-review engine fails closed when the code-review lane was not launched', () => {
  const findingsByAgent = { security: [], 'code-review': [] };
  const plan = (ids) => ({ engine: { name: 'code-review' }, agents: ids.map((id) => ({ id })) });
  assert.throws(
    () => consensusFrom({ plan: plan(['security', 'testing']), findingsByAgent: { security: [], testing: [] } }),
    /code-review engine.*code-review lane was not launched/,
  );
  assert.doesNotThrow(() => consensusFrom({ plan: plan(['code-review', 'security']), findingsByAgent }));
  assert.doesNotThrow(
    () => consensusFrom({ plan: { agents: [{ id: 'security' }] }, findingsByAgent: { security: [] } }),
    'a plan with no engine block keeps the lanes it launched',
  );
});

test('code-review findings outside the reviewed range cap at 6', () => {
  const { findings } = runCr([
    crFinding({ file: 'o.rb', evidence: 'Outside the reviewed range: old_helper drops the last row.' }),
    crFinding({ file: 'l.rb', severity: 5, evidence: 'Outside the reviewed range: low already.' }),
    crFinding({ file: 'i.rb', evidence: 'new code calls Outside the reviewed range: as a phrase mid-text' }),
  ]);
  const by = Object.fromEntries(findings.map((f) => [f.file, f.severity]));
  assert.deepEqual(by, { 'o.rb': 6, 'l.rb': 5, 'i.rb': 8 });
});

test('doubted code-review findings cap at 4 at any prefix boundary', () => {
  const { findings } = runCr([
    crFinding({ file: 'a.rb', evidence: 'Doubted: depends on a caller I could not see.' }),
    crFinding({ file: 'b.rb', severity: 6, category: 'conventions', evidence: 'Doubted: may be intended.' }),
    crFinding({ file: 'c.rb', severity: 6, evidence: 'Outside the reviewed range: Doubted: the old path may be dead.' }),
    crFinding({
      file: 'd.rb',
      category: 'security',
      evidence: 'Recategorized from conventions: line 14 commits a key. Doubted: it may be a test fixture.',
    }),
    crFinding({ file: 'e.rb', evidence: 'Recategorized from reuse: drops writes\nDoubted: the queue may retry.' }),
    crFinding({ file: 'f.rb', severity: 3, evidence: 'Doubted: minor.' }),
    crFinding({ file: 'g.rb', evidence: 'input x reaches line 10; nobody doubted: the guard is gone' }),
  ]);
  const by = Object.fromEntries(findings.map((f) => [f.file, f.severity]));
  assert.deepEqual(by, { 'a.rb': 4, 'b.rb': 4, 'c.rb': 4, 'd.rb': 4, 'e.rb': 4, 'f.rb': 3, 'g.rb': 8 });
});

test('outside and doubted prefixes leave other lanes alone', () => {
  const { findings } = runCr(
    [crFinding({ evidence: 'Outside the reviewed range: Doubted: still a real bug in this lane.' })],
    'correctness',
  );
  assert.equal(findings[0].severity, 8);
});

// --- a proven code-review blocker keeps its severity through a merge ---

const { mergeLedger } = require('./reportState.cjs');

const REFUND = 'refund amount is rounded before fees are subtracted';
const crBlocker = (over) => ({
  file: 'app/billing.rb',
  line: 20,
  severity: 7,
  category: 'correctness',
  confidence: 'High',
  message: REFUND,
  evidence: 'refund_total rounds at line 20, then subtracts fees from the rounded value',
  fix: 'subtract fees before rounding',
  ...over,
});
const financialNote = (over) => ({
  file: 'app/billing.rb',
  line: 22,
  severity: 4,
  category: 'financial',
  confidence: 'Medium',
  message: 'refund amount rounded before fees subtracted',
  evidence: 'rounding order looks off',
  fix: 'check the rounding order',
  ...over,
});
const quiet = (fn) => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
};

test('(code-review blocker) a financial 4 cannot pull a proven code-review 7 below the bar', () => {
  const { findings } = consensusFrom({
    findingsByAgent: { 'code-review': [crBlocker()], financial: [financialNote()] },
    profile: 'standard',
  });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.corroboration, 2);
  assert.equal(f.severity, 7);
  assert.equal(f.agent, 'code-review');
  assert.equal(f.agents, 'code-review,financial');
  assert.equal(f.line, 20);
  assert.equal(f.message, REFUND);
  assert.equal(f.fix, 'subtract fees before rounding');
  assert.equal(f.confidence, 'High');
  assert.equal('_codeReviewBlocker' in f, false);

  const ledger = mergeLedger([], findings);
  assert.equal(ledger[0].severity, 7, 'the merged entry still passes the ledger blocker rules');
});

test('(code-review blocker) the code-review member becomes the primary when it drives the severity', () => {
  const group = (lane) => ({
    [lane]: [crBlocker()],
    security: [crBlocker({ line: 21, severity: 8, category: 'security', message: 'refund amount is rounded before fees are removed', fix: 'use decimal math' })],
    financial: [financialNote({ line: 22, severity: 2, message: 'refund amount is rounded before the fees are subtracted' })],
    testing: [financialNote({ line: 23, severity: 2, category: 'testing', message: 'the refund amount is rounded before fees are subtracted' })],
  });

  const withCr = consensusFrom({ findingsByAgent: group('code-review'), profile: 'standard' }).findings;
  assert.equal(withCr.length, 1);
  assert.equal(withCr[0].corroboration, 4);
  assert.equal(withCr[0].severity, 7, 'rounded mean is 5, the proven code-review member is 7');
  assert.deepEqual(
    [withCr[0].agent, withCr[0].category, withCr[0].line, withCr[0].message, withCr[0].fix],
    ['code-review', 'correctness', 20, REFUND, 'subtract fees before rounding'],
  );
  assert.equal(withCr[0].confidence, 'High');

  const without = consensusFrom({ findingsByAgent: group('correctness'), profile: 'standard' }).findings;
  assert.equal(without.length, 1);
  assert.equal(without[0].severity, 5, 'without code-review the group keeps the rounded mean');
  assert.deepEqual([without[0].agent, without[0].line], ['security', 21]);
});

test('(code-review blocker) a code-review 7 that misses the bar is capped first and then averaged', () => {
  const { findings } = quiet(() =>
    consensusFrom({
      findingsByAgent: { 'code-review': [crBlocker({ confidence: 'Medium' })], financial: [financialNote()] },
      profile: 'standard',
    }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 5, 'capped 6 and 4 average to 5');
});

test('(code-review blocker) a code-review 5 with a security 9 keeps the rounded mean', () => {
  const { findings } = consensusFrom({
    findingsByAgent: {
      'code-review': [crBlocker({ severity: 5 })],
      security: [crBlocker({ line: 21, severity: 9, category: 'security', message: 'refund amount is rounded before fees are removed' })],
    },
    profile: 'standard',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 7);
  assert.equal(findings[0].agent, 'security');
  assert.equal(findings[0].line, 21);
});

test('(code-review blocker) the same grouping without code-review is unchanged', () => {
  const findingsByAgent = { correctness: [crBlocker()], financial: [financialNote()] };
  const noEngineKey = { agents: [{ id: 'correctness' }, { id: 'financial' }] };
  const expected = [
    {
      agent: 'correctness',
      agents: 'correctness,financial',
      category: 'correctness',
      severity: 6,
      file: 'app/billing.rb',
      line: 20,
      message: REFUND,
      confidence: 'High',
      evidence: 'refund_total rounds at line 20, then subtracts fees from the rounded value',
      recommendation: '',
      fix: 'subtract fees before rounding',
      corroboration: 2,
      needsHumanReview: false,
    },
  ];
  for (const plan of [undefined, noEngineKey]) {
    const { findings } = consensusFrom({ plan, findingsByAgent, profile: 'standard' });
    assert.equal(JSON.stringify(findings), JSON.stringify(expected), 'Math.round(5.5) with key order intact');
  }
});

test('(code-review blocker) a decisions merge follows the rule', () => {
  const findingsByAgent = {
    'code-review': [crBlocker({ line: 10 })],
    financial: [financialNote({ line: 16, message: 'ledger export skips the currency column' })],
  };
  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  assert.equal(first.findings.length, 2);
  assert.equal(first.candidates.length, 1);
  const { a, b } = first.candidates[0];

  const merged = consensusFrom({ findingsByAgent, profile: 'standard', decisions: [{ merge: [a, b] }] }).findings;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 7);
  assert.deepEqual([merged[0].agent, merged[0].line, merged[0].message], ['code-review', 10, REFUND]);
  assert.equal(mergeLedger([], merged)[0].severity, 7);

  const control = consensusFrom({
    findingsByAgent: { correctness: findingsByAgent['code-review'], financial: findingsByAgent.financial },
    profile: 'standard',
    decisions: [{ merge: [a, b] }],
  }).findings;
  assert.equal(control[0].severity, 6, 'without code-review a decisions merge keeps the rounded mean');
});

test('(code-review blocker) a decisions merge remembers a proven code-review member inside an earlier group', () => {
  const findingsByAgent = {
    'code-review': [crBlocker()],
    security: [crBlocker({ line: 21, severity: 9, category: 'security', message: 'refund amount is rounded before fees are removed' })],
    financial: [financialNote({ line: 26, severity: 1, message: 'ledger export skips the currency column' })],
  };
  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  const group = first.findings.findIndex((f) => f.corroboration === 2);
  const single = first.findings.findIndex((f) => f.corroboration === 1);
  assert.equal(first.findings[group].severity, 8);
  assert.equal(first.findings[group].agent, 'security', 'the mean drives here, so security stays primary');
  assert.ok(first.candidates.some((c) => [c.a, c.b].sort().join() === [group, single].sort().join()));

  const merged = consensusFrom({
    findingsByAgent,
    profile: 'standard',
    decisions: [{ merge: [group, single] }],
  }).findings;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].corroboration, 3);
  assert.equal(merged[0].severity, 7, 'weighted mean (8*2+1)/3 rounds to 6; the code-review 7 wins');
  assert.deepEqual([merged[0].agent, merged[0].line, merged[0].message], ['code-review', 20, REFUND]);
  assert.equal(merged[0].confidence, 'High');
  assert.equal('_codeReviewBlocker' in merged[0], false);
});

test('(code-review blocker) a raised group joins a later decisions merge at its own mean, not the raised severity', () => {
  const findingsByAgent = {
    'code-review': [crBlocker()],
    financial: [financialNote()],
    security: [crBlocker({ line: 28, severity: 9, category: 'security', message: 'ledger export skips the currency column' })],
  };
  const first = consensusFrom({ findingsByAgent, profile: 'standard' });
  const group = first.findings.findIndex((f) => f.corroboration === 2);
  const single = first.findings.findIndex((f) => f.corroboration === 1);
  assert.equal(first.findings[group].severity, 7, 'the code-review 7 holds the group at 7');

  const merged = consensusFrom({
    findingsByAgent,
    profile: 'standard',
    decisions: [{ merge: [group, single] }],
  }).findings;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 7, 'mean of 7, 4, 9 is 6.67; counting the raised 7 twice would give 8');
  assert.equal(merged[0].agent, 'security');
});
