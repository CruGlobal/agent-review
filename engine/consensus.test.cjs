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
  assert.equal(f.agent, 'agentA,agentB');
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
  assert.equal(second.findings[0].agent, 'agentA,agentC');
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
    agentC: [{ file: 'app/models/user.rb', line: 12, severity: 7, message: 'banana date elderberry', agent: 'agentC' }],
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
  assert.equal(merged.agent, 'agentA,agentB');
  assert.equal(merged.message, 'apple banana date'); // highest-severity member (agentB, sev 6)
  assert.equal(merged.line, 11);
  assert.ok(singleton, 'expected agentC to remain its own singleton');
  assert.equal(singleton.agent, 'agentC');
  assert.equal(singleton.message, 'banana date elderberry');

  // The two output entries are still close (same file, line distance <= 10),
  // so they surface as a candidate pair for the bounded model pass.
  assert.equal(candidates.length, 1);
  const [i, j] = [candidates[0].a, candidates[0].b];
  const pair = [findings[i].agent, findings[j].agent].sort();
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
    agentC: [{ file: 'svc/order.rb', line: 42, severity: 7, message: 'apple banana date elderberry', agent: 'agentC' }],
  };

  // Sanity: every pair meets the threshold -- a genuine clique.
  assert.ok(jaccard(tokenize('apple banana cherry date'), tokenize('apple banana cherry elderberry')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana cherry date'), tokenize('apple banana date elderberry')) >= 0.5);
  assert.ok(jaccard(tokenize('apple banana cherry elderberry'), tokenize('apple banana date elderberry')) >= 0.5);

  const { findings, candidates } = consensusFrom({ findingsByAgent, profile: 'standard' });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].corroboration, 3);
  assert.equal(findings[0].agent, 'agentA,agentB,agentC');
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
