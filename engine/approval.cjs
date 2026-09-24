'use strict';
// Decides whether a published agent-review report authorizes approving its PR.
// The CI review, the fix/dismiss interaction, and a locally posted report all
// run this one rule; the shell around it only fetches the report and posts the
// approval. Fails closed: any missing, malformed, or disagreeing marker is a no.
const MARKER = '<!-- agent-review -->';
const ROLLOUTS_THAT_APPROVE = new Set(['advisory', 'enforce']);

// First `<!-- agent-review-<name>: … -->` line in the body. The hidden markers
// sit at the top of the comment, so the first match is the trusted one even if
// the visible report later quotes a marker line.
function markerLine(text, name) {
  const m = text.match(new RegExp(`^<!-- agent-review-${name}: (.*) -->$`, 'm'));
  return m ? m[1].trim() : null;
}

function no(reason) {
  return { approve: false, reason };
}

function evaluateApproval(body, { head } = {}) {
  const expected = String(head || '').trim().toLowerCase();
  if (!expected) return no('no expected head SHA supplied');
  const text = String(body || '').replace(/\r/g, '');
  if (!text.startsWith(MARKER)) return no('not an agent-review report');

  const rollout = markerLine(text, 'rollout');
  if (!rollout) return no('report carries no rollout marker');
  if (rollout === 'shadow') return no('shadow reports never approve');
  if (!ROLLOUTS_THAT_APPROVE.has(rollout)) return no(`unknown rollout mode "${rollout}"`);

  const reportHead = markerLine(text, 'head');
  if (!reportHead) return no('report carries no reviewed-head marker');
  if (reportHead.toLowerCase() !== expected) {
    return no(`report covers ${reportHead} but the PR head is ${expected}`);
  }

  const statusRaw = markerLine(text, 'status');
  if (!statusRaw) return no('report carries no status marker');
  let status;
  try {
    status = JSON.parse(statusRaw);
  } catch {
    return no('status marker is not valid JSON');
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return no('status marker is not an object');
  }
  if (status.head !== undefined && String(status.head).toLowerCase() !== expected) {
    return no(`status head ${status.head} disagrees with the PR head ${expected}`);
  }
  if (status.pass !== true) {
    const open = Number.isInteger(status.openBlockers) ? status.openBlockers : 'unknown';
    return no(`status is not passing (${open} open blockers)`);
  }
  if (status.irreversible === true) return no('change is irreversible; a human must approve');

  return {
    approve: true,
    reason: `report for ${expected} passes with no open blockers and the change is reversible`,
  };
}

module.exports = { evaluateApproval, MARKER };
