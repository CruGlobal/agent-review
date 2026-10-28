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

// label: 'add' | 'remove' | 'keep'. Only a judged report may change the label,
// and a label a person added is never removed by the bot.
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
  if (!judged) return out(false, result.reason, 'keep', false);

  const present = Array.isArray(labels) && labels.includes(LABEL);
  const ruleOk = rules && typeof rules === 'object' && !rules.error;
  const reasons = [...result.humanReasons];
  if (ruleOk && rules.required === true) {
    for (const r of Array.isArray(rules.reasons) ? rules.reasons : []) if (!reasons.includes(r)) reasons.push(r);
  }
  if (result.humanRequired || (ruleOk && rules.required === true)) {
    return out(false, `a person must approve: ${reasons.join('; ')}`, present ? 'keep' : 'add', true);
  }
  if (!ruleOk) {
    const why = rules && rules.error ? rules.error : 'no rules supplied';
    return out(false, `could not check the human approval rules: ${why}`, 'keep', false);
  }
  if (present && labelOwner !== 'bot') {
    return out(false, `a person added the ${LABEL} label`, 'keep', false);
  }
  return out(result.approve, result.reason, present ? 'remove' : 'keep', false);
}

module.exports = { evaluateApproval, decideApproval, MARKER };
