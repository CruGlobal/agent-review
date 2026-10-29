'use strict';
// Decides whether a published agent-review report authorizes approving its PR.
// The CI review, the fix/dismiss interaction, and a locally posted report all
// run this one rule; the shell around it only fetches the report and posts the
// approval. Fails closed: any missing, malformed, or disagreeing marker is a no.
const MARKER = '<!-- agent-review -->';
const { LABEL } = require('./humanApproval.cjs');
const ROLLOUTS_THAT_APPROVE = new Set(['advisory', 'enforce']);

// The hidden markers form one contiguous block at the top of the comment. Only
// that block is trusted: the visible report below it is model-written and can
// quote PR content, so a marker line appearing there must never count.
function headerBlock(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    if (!/^<!-- agent-review(-[a-z]+: .*)? -->$/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n');
}

// First `<!-- agent-review-<name>: … -->` line in the header block.
function markerLine(header, name) {
  const m = header.match(new RegExp(`^<!-- agent-review-${name}: (.*) -->$`, 'm'));
  return m ? m[1].trim() : null;
}

function no(reason) {
  return { approve: false, reason };
}

function unjudged(reason) {
  return { result: no(reason), judged: false };
}

function statusFields(status) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    irreversible: status.irreversible === true,
    irreversibleReasons: strings(status.irreversibleReasons),
    humanRequired: status.humanRequired === true,
    humanReasons: strings(status.humanReasons),
  };
}

// `judged` is true only once the marker, rollout, and head checks passed and the
// status parsed to an object whose head agrees: only then may the report move
// the needs-human-approval label.
function judge(body, { head } = {}) {
  const expected = String(head || '').trim().toLowerCase();
  if (!expected) return unjudged('no expected head SHA supplied');
  const text = String(body || '').replace(/\r/g, '');
  if (!text.startsWith(MARKER)) return unjudged('not an agent-review report');
  const header = headerBlock(text);

  const rollout = markerLine(header, 'rollout');
  if (!rollout) return unjudged('report carries no rollout marker');
  if (rollout === 'shadow') return unjudged('shadow reports never approve');
  if (!ROLLOUTS_THAT_APPROVE.has(rollout)) return unjudged(`unknown rollout mode "${rollout}"`);

  const reportHead = markerLine(header, 'head');
  if (!reportHead) return unjudged('report carries no reviewed-head marker');
  if (reportHead.toLowerCase() !== expected) {
    return unjudged(`report covers ${reportHead} but the PR head is ${expected}`);
  }

  const statusRaw = markerLine(header, 'status');
  if (!statusRaw) return unjudged('report carries no status marker');
  let status;
  try {
    status = JSON.parse(statusRaw);
  } catch {
    return unjudged('status marker is not valid JSON');
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return unjudged('status marker is not an object');
  }
  if (status.humanRequired !== undefined && typeof status.humanRequired !== 'boolean') {
    return unjudged('status humanRequired is not a boolean');
  }
  if (status.head !== undefined && String(status.head).toLowerCase() !== expected) {
    return { result: { ...no(`status head ${status.head} disagrees with the PR head ${expected}`), ...statusFields(status) }, judged: false };
  }
  const fields = statusFields(status);
  if (status.pass !== true) {
    const open = Number.isInteger(status.openBlockers) ? status.openBlockers : 'unknown';
    return { result: { ...no(`status is not passing (${open} open blockers)`), ...fields }, judged: true };
  }
  if (fields.humanRequired) {
    return {
      result: { ...no(`a person must approve: ${fields.humanReasons.join('; ')}`), ...fields },
      judged: true,
    };
  }
  return {
    result: { approve: true, reason: `report for ${expected} passes with no open blockers`, ...fields },
    judged: true,
  };
}

function evaluateApproval(body, opts) {
  return judge(body, opts).result;
}

function cautionFor(result) {
  if (!result.irreversible) return null;
  const reasons = result.irreversibleReasons.length ? result.irreversibleReasons.join('; ') : 'no reason recorded';
  return `Caution: this change is irreversible (${reasons}). A revert will not undo it. Check backups and the deploy plan before you merge.`;
}

// label: 'add' | 'remove' | 'keep'. Only a judged report, or readable rules that
// need a person, may change the label, and a label a person added is never
// removed by the bot.
// dismissBotApprovals: 'all' | 'stale' | 'none'. 'all' whenever a person is needed
// or a person's label is on the PR. 'stale' means the bot's approvals of other
// heads; only unreadable rules dismiss those, since stale approvals are kept on
// purpose everywhere else.
function decideApproval({ report, head, rules, labels, labelOwner } = {}) {
  const { result, judged } = judge(report, { head });
  const caution = cautionFor(result);
  const out = (approve, reason, label, dismissBotApprovals) => ({
    approve,
    reason,
    label,
    dismissBotApprovals,
    caution,
  });
  const labelsOk = Array.isArray(labels) && labels.every((l) => typeof l === 'string');
  const present = labelsOk && labels.some((l) => l.toLowerCase() === LABEL);
  const plain = rules !== null && typeof rules === 'object' && !Array.isArray(rules);
  const ruleOk =
    plain &&
    !('error' in rules) &&
    typeof rules.required === 'boolean' &&
    Array.isArray(rules.reasons) &&
    rules.reasons.every((r) => typeof r === 'string');
  // A person's label takes back bot approvals even when the report or the
  // rules cannot be read.
  const byPerson = present && labelOwner !== 'bot' ? out(false, `a person added the ${LABEL} label`, 'keep', 'all') : null;
  const rulesUnread = () => {
    const why = plain && 'error' in rules && rules.error ? String(rules.error) : 'rules are missing or malformed';
    return out(false, `could not check the human approval rules: ${why}`, 'keep', 'stale');
  };
  // The rules re-check reads the base commit and the PR's current files, not
  // the report, so it holds even when the report cannot be judged.
  if (!judged) {
    if (ruleOk && rules.required) {
      return out(false, `a person must approve: ${rules.reasons.join('; ')}`, present ? 'keep' : 'add', 'all');
    }
    if (byPerson) return byPerson;
    return ruleOk ? out(false, result.reason, 'keep', 'none') : rulesUnread();
  }

  const reasons = [...result.humanReasons];
  if (ruleOk && rules.required) {
    for (const r of rules.reasons) if (!reasons.includes(r)) reasons.push(r);
  }
  if (result.humanRequired || (ruleOk && rules.required)) {
    return out(false, `a person must approve: ${reasons.join('; ')}`, present ? 'keep' : 'add', 'all');
  }
  if (byPerson) return byPerson;
  if (!ruleOk) return rulesUnread();
  if (!labelsOk) return out(false, 'could not read the PR labels: expected a list of names', 'keep', 'none');
  return out(result.approve, result.reason, present ? 'remove' : 'keep', 'none');
}

module.exports = { evaluateApproval, decideApproval, MARKER };
