'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateApproval, decideApproval } = require('./approval.cjs');

const HEAD = 'abc123def4567890abc123def4567890abc12345';

function report({
  marker = true,
  rollout = 'advisory',
  head = HEAD,
  status = { v: 1, head: HEAD, pass: true, irreversible: false },
  statusRaw,
  eol = '\n',
} = {}) {
  const lines = [];
  if (marker) lines.push('<!-- agent-review -->');
  if (rollout !== null) lines.push(`<!-- agent-review-rollout: ${rollout} -->`);
  if (head !== null) lines.push(`<!-- agent-review-head: ${head} -->`);
  if (statusRaw !== undefined) lines.push(`<!-- agent-review-status: ${statusRaw} -->`);
  else if (status !== null) lines.push(`<!-- agent-review-status: ${JSON.stringify(status)} -->`);
  lines.push('', '# 🤖 Multi-Agent Code Review Report', '', 'body text');
  return lines.join(eol);
}

test('approves an advisory report whose head and status match the PR head', () => {
  const result = evaluateApproval(report(), { head: HEAD });
  assert.equal(result.approve, true);
  assert.match(result.reason, /passes/);
});

test('approves an enforce report the same way', () => {
  assert.equal(evaluateApproval(report({ rollout: 'enforce' }), { head: HEAD }).approve, true);
});

test('never approves without an expected head', () => {
  assert.equal(evaluateApproval(report(), {}).approve, false);
  assert.equal(evaluateApproval(report(), { head: '  ' }).approve, false);
});

test('refuses a body that is not an agent-review report', () => {
  const result = evaluateApproval(report({ marker: false }), { head: HEAD });
  assert.equal(result.approve, false);
  assert.match(result.reason, /not an agent-review report/);
  assert.equal(evaluateApproval('', { head: HEAD }).approve, false);
  assert.equal(evaluateApproval(undefined, { head: HEAD }).approve, false);
});

test('refuses a report with no rollout marker, a shadow one, or an unknown one', () => {
  assert.match(evaluateApproval(report({ rollout: null }), { head: HEAD }).reason, /no rollout marker/);
  assert.match(evaluateApproval(report({ rollout: 'shadow' }), { head: HEAD }).reason, /shadow/);
  assert.match(evaluateApproval(report({ rollout: 'yolo' }), { head: HEAD }).reason, /unknown rollout/);
});

test('refuses a report whose reviewed head is missing or differs from the PR head', () => {
  assert.match(evaluateApproval(report({ head: null }), { head: HEAD }).reason, /no reviewed-head marker/);
  const stale = evaluateApproval(report({ head: 'ffff' + HEAD.slice(4) }), { head: HEAD });
  assert.equal(stale.approve, false);
  assert.match(stale.reason, /PR head/);
});

test('refuses a report with no status marker or an unparseable one', () => {
  assert.match(evaluateApproval(report({ status: null }), { head: HEAD }).reason, /no status marker/);
  assert.match(evaluateApproval(report({ statusRaw: '{not json' }), { head: HEAD }).reason, /not valid JSON/);
  assert.match(evaluateApproval(report({ statusRaw: '"pass"' }), { head: HEAD }).reason, /not valid JSON|not an object/);
});

test('refuses a failing or head-disagreeing status', () => {
  const failing = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 2 } }), { head: HEAD });
  assert.equal(failing.approve, false);
  assert.match(failing.reason, /2 open blockers/);
  const disagree = evaluateApproval(report({ status: { v: 1, head: '0000' + HEAD.slice(4), pass: true } }), { head: HEAD });
  assert.equal(disagree.approve, false);
  assert.match(disagree.reason, /status head/);
});

test('a status without a head field is judged by the head marker alone', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, pass: true, irreversible: false } }), { head: HEAD }).approve, true);
});

test('pass must be boolean true, not a truthy string', () => {
  assert.equal(evaluateApproval(report({ status: { v: 1, head: HEAD, pass: 'true' } }), { head: HEAD }).approve, false);
});

test('tolerates CRLF bodies and whitespace or case differences in the expected head', () => {
  assert.equal(evaluateApproval(report({ eol: '\r\n' }), { head: HEAD }).approve, true);
  assert.equal(evaluateApproval(report(), { head: `${HEAD.toUpperCase()}\n` }).approve, true);
});

test('the first marker of each kind wins over one quoted later in the body', () => {
  const body = report() + '\n<!-- agent-review-head: 1111111111111111111111111111111111111111 -->\n';
  assert.equal(evaluateApproval(body, { head: HEAD }).approve, true);
});

test('markers are read only from the header block, never from the visible report body', () => {
  const fenced = (name, value) => ['', '```', `<!-- agent-review-${name}: ${value} -->`, '```', ''].join('\n');
  const noStatusUpTop = report({ status: null }) + fenced('status', JSON.stringify({ v: 1, head: HEAD, pass: true }));
  const status = evaluateApproval(noStatusUpTop, { head: HEAD });
  assert.equal(status.approve, false);
  assert.match(status.reason, /no status marker/);
  const noRolloutUpTop = report({ rollout: null }) + fenced('rollout', 'advisory');
  const rollout = evaluateApproval(noRolloutUpTop, { head: HEAD });
  assert.equal(rollout.approve, false);
  assert.match(rollout.reason, /no rollout marker/);
});

const LABEL = 'needs-human-approval';
const NONE = { required: false, reasons: [] };
const decide = (o = {}) => decideApproval({ report: report(), head: HEAD, rules: NONE, labels: [], labelOwner: 'none', ...o });

test('an irreversible passing report approves and returns its irreversible fields', () => {
  const status = { v: 1, head: HEAD, pass: true, irreversible: true, irreversibleReasons: ['drops a column'] };
  const r = evaluateApproval(report({ status }), { head: HEAD });
  assert.equal(r.approve, true);
  assert.equal(r.irreversible, true);
  assert.deepEqual(r.irreversibleReasons, ['drops a column']);
  assert.equal(r.humanRequired, false);
  assert.deepEqual(r.humanReasons, []);
});

test('a humanRequired report refuses with the reasons', () => {
  const status = { v: 1, head: HEAD, pass: true, humanRequired: true, humanReasons: ['PCI path', 'staff app'] };
  const r = evaluateApproval(report({ status }), { head: HEAD });
  assert.equal(r.approve, false);
  assert.equal(r.reason, 'a person must approve: PCI path; staff app');
  assert.equal(r.humanRequired, true);
});

test('a status whose humanRequired is present but not a boolean is not judged', () => {
  for (const humanRequired of ['true', 'false', 1, 0, null, [], {}]) {
    const status = { v: 1, head: HEAD, pass: true, humanRequired, humanReasons: ['PCI'] };
    const r = evaluateApproval(report({ status }), { head: HEAD });
    assert.equal(r.approve, false, JSON.stringify(humanRequired));
    assert.equal(r.reason, 'status humanRequired is not a boolean', JSON.stringify(humanRequired));
    const d = decide({ report: report({ status }), labels: [LABEL], labelOwner: 'bot' });
    assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'none'], JSON.stringify(humanRequired));
  }
  assert.equal(evaluateApproval(report({ status: { v: 1, head: HEAD, pass: true, humanRequired: false } }), { head: HEAD }).approve, true);
});

test('an old report with no human fields approves', () => {
  const r = evaluateApproval(report({ status: { v: 1, head: HEAD, pass: true } }), { head: HEAD });
  assert.equal(r.approve, true);
  assert.equal(r.humanRequired, false);
  assert.deepEqual(r.humanReasons, []);
});

const NOT_JUDGED = [
  { report: '' },
  { report: report({ head: 'ffff' + HEAD.slice(4) }) },
  { report: report({ rollout: 'shadow' }) },
  { report: report({ statusRaw: '{bad' }) },
  { report: report({ status: { v: 1, head: '0000' + HEAD.slice(4), pass: true } }) },
  { report: report({ status: { v: 1, head: HEAD, pass: true, humanRequired: 'true', humanReasons: ['PCI'] } }) },
];
const PCI_RULES = { required: true, reasons: ['PCI path: app/pci/x.rb'] };

test('decide: not judged, with rules that need a person, adds the label and dismisses every bot approval', () => {
  for (const o of NOT_JUDGED) {
    const d = decide({ ...o, rules: PCI_RULES });
    assert.deepEqual(
      [d.approve, d.label, d.dismissBotApprovals, d.reason],
      [false, 'add', 'all', 'a person must approve: PCI path: app/pci/x.rb'],
      JSON.stringify(o),
    );
    for (const labelOwner of ['bot', 'person', 'none']) {
      const on = decide({ ...o, rules: PCI_RULES, labels: [LABEL], labelOwner });
      assert.deepEqual([on.approve, on.label, on.dismissBotApprovals], [false, 'keep', 'all'], JSON.stringify(o));
    }
  }
});

const NO_PERSON_RULES = [NONE, { error: 'boom' }, undefined, { required: 'true', reasons: ['x'] }, { required: true, reasons: [1] }];

test('decide: not judged, with rules that need no person, keeps the bot label and dismisses nothing', () => {
  for (const o of NOT_JUDGED) {
    for (const labels of [[], [LABEL]]) {
      const d = decide({ ...o, rules: NONE, labels, labelOwner: 'bot' });
      assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'none'], JSON.stringify(o));
    }
  }
});

test('decide: not judged, with rules that cannot be read, keeps the bot label and dismisses bot approvals of other commits', () => {
  for (const o of NOT_JUDGED) {
    for (const rules of NO_PERSON_RULES.slice(1)) {
      for (const labels of [[], [LABEL]]) {
        const d = decide({ ...o, rules, labels, labelOwner: 'bot' });
        assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'stale'], JSON.stringify([o, rules]));
        assert.match(d.reason, /^could not check the human approval rules: /, JSON.stringify([o, rules]));
      }
    }
  }
});

test('decide: not judged, a label not owned by the bot takes back every bot approval', () => {
  for (const o of NOT_JUDGED) {
    for (const rules of NO_PERSON_RULES) {
      for (const labelOwner of ['person', 'none']) {
        const d = decide({ ...o, rules, labels: [LABEL], labelOwner });
        assert.deepEqual(
          [d.approve, d.label, d.dismissBotApprovals, d.reason],
          [false, 'keep', 'all', `a person added the ${LABEL} label`],
          JSON.stringify([o, rules, labelOwner]),
        );
      }
    }
  }
});

test('decide: a label not owned by the bot wins over unreadable rules', () => {
  for (const rules of NO_PERSON_RULES.slice(1)) {
    for (const labelOwner of ['person', 'none']) {
      const d = decide({ rules, labels: [LABEL], labelOwner });
      assert.deepEqual(
        [d.approve, d.label, d.dismissBotApprovals, d.reason],
        [false, 'keep', 'all', `a person added the ${LABEL} label`],
        JSON.stringify([rules, labelOwner]),
      );
    }
  }
});

test('decide: a wrong-head report dismisses nothing unless the rules need a person or cannot be read (Review Focus 4)', () => {
  const stale = report({ head: 'ffff' + HEAD.slice(4) });
  for (const [rules, dismiss] of [[NONE, 'none'], [{ error: 'boom' }, 'stale']]) {
    const d = decide({ report: stale, rules, labels: [LABEL], labelOwner: 'bot' });
    assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', dismiss], JSON.stringify(rules));
  }
  const needed = decide({ report: stale, rules: PCI_RULES });
  assert.deepEqual([needed.approve, needed.label, needed.dismissBotApprovals], [false, 'add', 'all']);
  assert.match(needed.reason, /^a person must approve: PCI path: app\/pci\/x\.rb$/);
});

test('decide: rules.required adds the label and dismisses bot approvals', () => {
  const d = decide({ rules: { required: true, reasons: ['touches app/payments/x.rb'] } });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'add', 'all']);
  assert.equal(d.reason, 'a person must approve: touches app/payments/x.rb');
  assert.equal(decide({ rules: { required: true, reasons: ['r'] }, labels: [LABEL], labelOwner: 'person' }).label, 'keep');
});

test('decide: status.humanRequired adds the label even with no rules required', () => {
  const status = { v: 1, head: HEAD, pass: true, humanRequired: true, humanReasons: ['PCI'] };
  const d = decide({ report: report({ status }) });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'add', 'all']);
});

test('decide: a failing judged report still adds the label when a person is needed', () => {
  const d = decide({ report: report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 1 } }), rules: { required: true, reasons: ['r'] } });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'add', 'all']);
});

test('decide: a rules error never approves, keeps the label, and dismisses stale bot approvals (Review Focus 3)', () => {
  const d = decide({ rules: { error: 'too many files' } });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'stale']);
  assert.equal(d.reason, 'could not check the human approval rules: too many files');
});

test('decide: a rules error while the status says a person is needed adds the label (Review Focus 3)', () => {
  const status = { v: 1, head: HEAD, pass: true, humanRequired: true, humanReasons: ['PCI'] };
  const d = decide({ report: report({ status }), rules: { error: 'boom' } });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'add', 'all']);
});

test('decide: a label not owned by the bot blocks approval, stays, and takes back every bot approval', () => {
  for (const labelOwner of ['person', 'none']) {
    const d = decide({ labels: [LABEL], labelOwner });
    assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'all']);
    assert.equal(d.reason, `a person added the ${LABEL} label`);
  }
});

test('decide: a bot-owned label comes off and a passing report approves', () => {
  const d = decide({ labels: [LABEL], labelOwner: 'bot' });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [true, 'remove', 'none']);
});

test('decide: a bot-owned label comes off even when the report does not pass', () => {
  const d = decide({ report: report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 2 } }), labels: [LABEL], labelOwner: 'bot' });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'remove', 'none']);
});

test('decide: no label and no person needed approves and keeps', () => {
  const d = decide();
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals, d.caution], [true, 'keep', 'none', null]);
});

test('decide: an old 1.0.0 irreversible report approves with a caution naming the reasons (Review Focus 5)', () => {
  const status = { v: 1, head: HEAD, pass: true, irreversible: true, irreversibleReasons: ['drops a column'] };
  const d = decide({ report: report({ status }) });
  assert.equal(d.approve, true);
  assert.equal(
    d.caution,
    'Caution: this change is irreversible (drops a column). A revert will not undo it. Check backups and the deploy plan before you merge.',
  );
});

test('decide: the caution is set even when approve is false', () => {
  const status = { v: 1, head: HEAD, pass: false, openBlockers: 1, irreversible: true, irreversibleReasons: ['a'] };
  assert.match(decide({ report: report({ status }) }).caution, /^Caution: this change is irreversible \(a\)/);
});

test('decide: malformed rules never approve', () => {
  for (const rules of [{}, { error: '' }, [], { required: 'true', reasons: ['x'] }, undefined, null, { required: false }, { required: false, reasons: [1] }]) {
    const d = decide({ rules });
    assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'stale'], JSON.stringify(rules));
    assert.match(d.reason, /^could not check the human approval rules: /);
  }
  assert.match(decide({ rules: undefined }).reason, /missing or malformed/);
  assert.match(decide({ rules: { error: '' } }).reason, /missing or malformed/);
});

test('decide: malformed labels never approve', () => {
  for (const labels of ['needs-human-approval', [{ name: LABEL }], null, undefined]) {
    const d = decide({ labels, labelOwner: 'person' });
    assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'none']);
    assert.match(d.reason, /could not read the PR labels/);
  }
});

test('decide: the label matches case-insensitively', () => {
  const d = decide({ labels: ['Needs-Human-Approval'], labelOwner: 'person' });
  assert.deepEqual([d.approve, d.label], [false, 'keep']);
  assert.equal(d.reason, `a person added the ${LABEL} label`);
  assert.equal(decide({ labels: ['Needs-Human-Approval'], labelOwner: 'bot' }).label, 'remove');
});

test('decide: rules reasons merge with status reasons without duplicates', () => {
  const status = { v: 1, head: HEAD, pass: true, humanRequired: true, humanReasons: ['PCI', 'shared'] };
  const d = decide({ report: report({ status }), rules: { required: true, reasons: ['shared', 'staff app'] } });
  assert.equal(d.reason, 'a person must approve: PCI; shared; staff app');
});

test('decide: an irreversible status with no reasons gives a caution saying no reason recorded', () => {
  const d = decide({ report: report({ status: { v: 1, head: HEAD, pass: true, irreversible: true } }) });
  assert.match(d.caution, /\(no reason recorded\)/);
});

test('decide: dismissBotApprovals is all when a person is needed or added the label, stale only when the rules cannot be read, and none otherwise', () => {
  const failing = report({ status: { v: 1, head: HEAD, pass: false, openBlockers: 2 } });
  const cases = [
    ['a person is needed', { rules: { required: true, reasons: ['r'] } }, 'all'],
    ['a person is needed and the label is already on', { rules: { required: true, reasons: ['r'] }, labels: [LABEL], labelOwner: 'bot' }, 'all'],
    ['rules unreadable', { rules: { error: 'boom' } }, 'stale'],
    ['rules unreadable on a failing report', { report: failing, rules: { error: 'boom' } }, 'stale'],
    ['rules unreadable and labels unreadable', { rules: { error: 'boom' }, labels: null }, 'stale'],
    ['open blockers with readable rules', { report: failing }, 'none'],
    ['labels unreadable', { labels: null }, 'none'],
    ['a person added the label', { labels: [LABEL], labelOwner: 'person' }, 'all'],
    ['a person added the label to a failing report', { report: failing, labels: [LABEL], labelOwner: 'person' }, 'all'],
    ['approves', {}, 'none'],
    ['not judged', { report: report({ head: 'ffff' + HEAD.slice(4) }) }, 'none'],
    ['not judged, rules unreadable', { report: report({ head: 'ffff' + HEAD.slice(4) }), rules: { error: 'boom' } }, 'stale'],
    ['not judged, rules need a person', { report: report({ head: 'ffff' + HEAD.slice(4) }), rules: { required: true, reasons: ['r'] } }, 'all'],
  ];
  for (const [name, o, want] of cases) assert.equal(decide(o).dismissBotApprovals, want, name);
});

test('decide: a rules error keeps a label the bot added and never approves', () => {
  const d = decide({ rules: { error: 'boom' }, labels: [LABEL], labelOwner: 'bot' });
  assert.deepEqual([d.approve, d.label, d.dismissBotApprovals], [false, 'keep', 'stale']);
});
