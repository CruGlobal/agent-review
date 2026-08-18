'use strict';

const { createHash } = require('node:crypto');
const { DISMISSAL_REASONS } = require('./evalSuite.cjs');
const { cleanPrevious } = require('./reportState.cjs');

const RESULT_STATUSES = new Set(['applied', 'not-applied']);
const TEST_STATUSES = new Set(['passed', 'failed', 'not-run']);
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CHANGED_FILES = 25;
const SENSITIVE_PATHS = [
  '.github/workflows/',
  '.claude/',
  '.gitmodules',
  '.gitattributes',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function singleLine(value, field, max = 1000) {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) {
    throw new Error(`${field} must be a non-empty single line of at most ${max} characters`);
  }
  if (text.includes('<!--')) throw new Error(`${field} may not contain an HTML comment marker`);
  return text;
}

function safeRepoPath(value, field = 'path') {
  const path = String(value || '');
  if (
    !path ||
    path.length > 500 ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    path.includes('\\') ||
    /[\r\n\0]/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`invalid repository-relative ${field}: ${path}`);
  }
  return path;
}

function extractReportState(report) {
  const ledgerMatches = [...String(report).matchAll(/^<!-- agent-review-ledger: (.*) -->$/gm)];
  const statusMatches = [...String(report).matchAll(/^<!-- agent-review-status: (.*) -->$/gm)];
  if (ledgerMatches.length !== 1) throw new Error('report must contain exactly one findings ledger');
  if (statusMatches.length !== 1) throw new Error('report must contain exactly one status marker');
  let ledger;
  let status;
  try {
    ledger = cleanPrevious(JSON.parse(ledgerMatches[0][1]));
  } catch (error) {
    throw new Error(`invalid report ledger: ${error.message}`);
  }
  try {
    status = JSON.parse(statusMatches[0][1]);
  } catch {
    throw new Error('invalid report status JSON');
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('report status must be an object');
  }
  return { ledger, status };
}

function parseNumberList(value) {
  return String(value)
    .split(',')
    .map((part) => Number(part.trim().replace(/^#/, '')))
    .map((n) => {
      if (!Number.isInteger(n) || n < 1) throw new Error(`invalid finding number: ${n}`);
      return n;
    });
}

function parseCommand(body) {
  const raw = String(body || '');
  if (!raw.trim() || raw.length > 10000) throw new Error('address command is empty or too long');
  // A PR comment usually carries prose after the instruction ("@claude fix 1\n\nThanks!"),
  // so the command is the first non-empty line once the mention is stripped.
  const command = (raw.replace(/^\s*@claude\b/i, '').split(/\r?\n/).find((line) => line.trim()) || '').trim();
  if (!command) throw new Error('address command is empty');
  if (command.length > 2000) throw new Error('address command is too long');
  const operations = [];
  for (const clause of command.split(/\s*;\s*/)) {
    let match = clause.match(/^fix\s+(#?\d+(?:\s*,\s*#?\d+)*)$/i);
    if (match) {
      for (const n of parseNumberList(match[1])) operations.push({ n, action: 'fix' });
      continue;
    }
    match = clause.match(
      /^dismiss\s+(#?\d+(?:\s*,\s*#?\d+)*)\s+\[([a-z-]+)\]\s*:\s*(.+)$/i,
    );
    if (match) {
      const reasonCode = match[2].toLowerCase();
      if (!DISMISSAL_REASONS.has(reasonCode)) {
        throw new Error(`invalid dismissal reason code: ${reasonCode}`);
      }
      const reason = singleLine(match[3], 'dismissal reason', 500);
      for (const n of parseNumberList(match[1])) {
        operations.push({ n, action: 'dismiss', reasonCode, reason });
      }
      continue;
    }
    throw new Error(
      'invalid address syntax; use "@claude fix 1, 3" or ' +
        '"@claude dismiss 2 [false-positive]: reason" and separate mixed clauses with ";"',
    );
  }
  const seen = new Set();
  for (const operation of operations) {
    if (seen.has(operation.n)) throw new Error(`finding #${operation.n} appears more than once`);
    seen.add(operation.n);
  }
  if (operations.length === 0) throw new Error('address command contains no operations');
  return operations;
}

function validateRequest(request) {
  if (!request || request.version !== 1) throw new Error('address request version must be 1');
  if (!Number.isInteger(request.pr) || request.pr < 1) throw new Error('invalid request PR number');
  if (!Number.isInteger(request.commentId) || request.commentId < 1) {
    throw new Error('invalid request comment id');
  }
  if (!Number.isInteger(request.reportCommentId) || request.reportCommentId < 1) {
    throw new Error('invalid report comment id');
  }
  if (!/^[0-9a-f]{40,64}$/i.test(request.expectedHead || '')) {
    throw new Error('invalid expected PR head');
  }
  if (!/^[0-9a-f]{64}$/i.test(request.reportSha || '')) throw new Error('invalid report SHA');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(request.actor || '')) {
    throw new Error('invalid GitHub actor');
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new Error('address request has no operations');
  }
  const seen = new Set();
  return {
    version: 1,
    pr: request.pr,
    commentId: request.commentId,
    reportCommentId: request.reportCommentId,
    actor: request.actor,
    expectedHead: request.expectedHead.toLowerCase(),
    reportSha: request.reportSha.toLowerCase(),
    operations: request.operations.map((raw) => {
      const n = Number(raw.n);
      if (!Number.isInteger(n) || n < 1 || seen.has(n)) {
        throw new Error(`invalid or duplicate requested finding: ${raw.n}`);
      }
      seen.add(n);
      if (raw.action !== 'fix' && raw.action !== 'dismiss') {
        throw new Error(`invalid action for finding #${n}`);
      }
      const operation = {
        n,
        action: raw.action,
        id: String(raw.id || ''),
        signature: String(raw.signature || ''),
        agent: String(raw.agent || ''),
        category: String(raw.category || ''),
        severity: Number(raw.severity),
        file: safeRepoPath(raw.file, `finding #${n} file`),
        line: raw.line == null ? null : Number(raw.line),
        message: singleLine(raw.message, `finding #${n} message`, 2000),
      };
      if (raw.action === 'dismiss') {
        if (!DISMISSAL_REASONS.has(raw.reasonCode)) {
          throw new Error(`invalid dismissal reason code for finding #${n}`);
        }
        operation.reasonCode = raw.reasonCode;
        operation.reason = singleLine(raw.reason, `finding #${n} dismissal reason`, 500);
      }
      return operation;
    }),
    // Informational only: numbers the maintainer named that carry no authority.
    skipped: (Array.isArray(request.skipped) ? request.skipped : []).map((raw) => {
      const n = Number(raw.n);
      if (!Number.isInteger(n) || n < 1) throw new Error(`invalid skipped finding: ${raw.n}`);
      return { n, reason: singleLine(raw.reason, `finding #${n} skip reason`, 200) };
    }),
  };
}

function prepareAddressRequest({
  command,
  actor,
  pr,
  commentId,
  reportCommentId,
  expectedHead,
  report,
}) {
  const { ledger } = extractReportState(report);
  const byNumber = new Map(ledger.map((entry) => [entry.n, entry]));
  // Unknown or already-resolved numbers are reported back rather than failing the
  // whole command — the maintainer's other operations still run.
  const operations = [];
  const skipped = [];
  for (const operation of parseCommand(command)) {
    const finding = byNumber.get(operation.n);
    if (!finding) {
      skipped.push({ n: operation.n, reason: 'not in the findings ledger' });
    } else if (finding.status !== 'open') {
      skipped.push({ n: operation.n, reason: `already ${finding.status}` });
    } else {
      operations.push({ ...finding, ...operation });
    }
  }
  if (operations.length === 0) {
    throw new Error(
      `no actionable findings — ${skipped.map(({ n, reason }) => `#${n} is ${reason}`).join('; ')}`,
    );
  }
  return validateRequest({
    version: 1,
    pr: Number(pr),
    commentId: Number(commentId),
    reportCommentId: Number(reportCommentId),
    actor,
    expectedHead,
    reportSha: sha256(report),
    operations,
    skipped,
  });
}

function isSensitivePath(path) {
  return SENSITIVE_PATHS.some((sensitive) =>
    sensitive.endsWith('/') ? path.startsWith(sensitive) : path === sensitive,
  );
}

function validateAddressResult({ request: requestInput, result: resultInput, changedFiles, patchBytes }) {
  const request = validateRequest(requestInput);
  const authorizedFixes = new Map(
    request.operations.filter((operation) => operation.action === 'fix').map((operation) => [operation.n, operation]),
  );
  const result = resultInput || {};
  if (result.version !== 1) throw new Error('address result version must be 1');
  if (String(result.expectedHead || '').toLowerCase() !== request.expectedHead) {
    throw new Error('address result covers a different PR head');
  }
  if (!Array.isArray(result.fixes)) throw new Error('address result fixes must be an array');
  const cleanFiles = (changedFiles || []).map((path) => safeRepoPath(path, 'changed path'));
  if (new Set(cleanFiles).size !== cleanFiles.length) throw new Error('changed path list contains duplicates');
  if (cleanFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`address patch changes more than ${MAX_CHANGED_FILES} files`);
  }
  const bytes = Number(patchBytes || 0);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_PATCH_BYTES) {
    throw new Error(`address patch exceeds ${MAX_PATCH_BYTES} bytes`);
  }
  const seen = new Set();
  const declaredFiles = new Set();
  const fixes = result.fixes.map((raw) => {
    const n = Number(raw.n);
    const authorized = authorizedFixes.get(n);
    if (!authorized || seen.has(n)) throw new Error(`unauthorized or duplicate fix result for #${raw.n}`);
    seen.add(n);
    if (!RESULT_STATUSES.has(raw.status)) throw new Error(`invalid result status for finding #${n}`);
    const clean = { n, status: raw.status };
    if (raw.status === 'applied') {
      if (!Array.isArray(raw.files) || raw.files.length === 0) {
        throw new Error(`applied finding #${n} must list changed files`);
      }
      clean.files = [...new Set(raw.files.map((path) => safeRepoPath(path, `finding #${n} result path`)))];
      if (!clean.files.includes(authorized.file)) {
        throw new Error(`applied finding #${n} does not change its reported file ${authorized.file}`);
      }
      for (const path of clean.files) declaredFiles.add(path);
      clean.summary = singleLine(raw.summary, `finding #${n} summary`, 1000);
    } else {
      clean.reason = singleLine(raw.reason, `finding #${n} not-applied reason`, 1000);
      clean.files = [];
    }
    return clean;
  });
  if (seen.size !== authorizedFixes.size) {
    const missing = [...authorizedFixes.keys()].filter((n) => !seen.has(n));
    throw new Error(`address result omitted requested fixes: ${missing.map((n) => `#${n}`).join(', ')}`);
  }
  const changedSet = new Set(cleanFiles);
  for (const path of declaredFiles) {
    if (!changedSet.has(path)) throw new Error(`result declares unchanged file: ${path}`);
  }
  for (const path of changedSet) {
    if (!declaredFiles.has(path)) throw new Error(`patch contains undeclared file: ${path}`);
    if (
      isSensitivePath(path) &&
      !request.operations.some((operation) => operation.action === 'fix' && operation.file === path)
    ) {
      throw new Error(`patch changes sensitive path without a matching finding: ${path}`);
    }
  }
  if ((changedSet.size === 0) !== (bytes === 0)) {
    throw new Error('patch bytes and changed path list disagree');
  }
  if (!Array.isArray(result.tests)) throw new Error('address result tests must be an array');
  const tests = result.tests.map((raw, index) => {
    if (index >= 25) throw new Error('address result contains too many test records');
    if (!TEST_STATUSES.has(raw.status)) throw new Error(`invalid test status: ${raw.status}`);
    return {
      command: singleLine(raw.command, 'test command', 500),
      status: raw.status,
      ...(raw.details ? { details: singleLine(raw.details, 'test details', 1000) } : {}),
    };
  });
  return { version: 1, expectedHead: request.expectedHead, fixes, tests };
}

function feedbackForAddress(requestInput, resultInput, now = new Date().toISOString()) {
  const request = validateRequest(requestInput);
  const resultByNumber = new Map((resultInput.fixes || []).map((fix) => [fix.n, fix]));
  return request.operations.flatMap((operation) => {
    const fix = resultByNumber.get(operation.n);
    if (operation.action === 'fix' && (!fix || fix.status !== 'applied')) return [];
    return [{
      ts: now,
      reviewId: `address-${request.pr}`,
      id: operation.id,
      signature: operation.signature,
      agent: operation.agent,
      category: operation.category,
      severity: operation.severity,
      file: operation.file,
      message: operation.message,
      outcome: operation.action === 'dismiss' ? 'dismissed' : 'accepted',
      ...(operation.action === 'dismiss'
        ? { dismissalReason: operation.reasonCode, dismissalDetail: operation.reason }
        : {}),
    }];
  });
}

function ledgerLine(entry) {
  const location = `\`${entry.file}${entry.line ? `:${entry.line}` : ''}\``;
  const message = String(entry.message).replace(/[\r\n]/g, ' ');
  const prefix = entry.severity >= 7 ? '- [ ]' : '-';
  if (entry.status === 'fixed') {
    const fixedPrefix = entry.severity >= 7 ? '- [x]' : '-';
    return `${fixedPrefix} **#${entry.n}** · ${entry.severity}/10 · ${location} — ~~${message}~~ — ✅ fixed in ${String(entry.sha).slice(0, 7)}`;
  }
  if (entry.status === 'dismissed') {
    const dismissedPrefix = entry.severity >= 7 ? '- [x]' : '-';
    return `${dismissedPrefix} **#${entry.n}** · ${entry.severity}/10 · ${location} — ~~${message}~~ — 🚫 dismissed by @${entry.by} [${entry.reasonCode}]: ${entry.reason}`;
  }
  return `${prefix} **#${entry.n}** · ${entry.severity}/10 · ${location} — ${message} _(${entry.agent})_`;
}

function finalizeAddress({ request: requestInput, result, report, fixSha }) {
  const request = validateRequest(requestInput);
  if (sha256(report) !== request.reportSha) throw new Error('canonical report changed before finalization');
  const { ledger, status } = extractReportState(report);
  const byNumber = new Map(ledger.map((entry) => [entry.n, entry]));
  const resultByNumber = new Map((result.fixes || []).map((fix) => [fix.n, fix]));
  const appliedFixes = [];
  const dismissed = [];
  for (const operation of request.operations) {
    const entry = byNumber.get(operation.n);
    if (!entry || entry.status !== 'open' || entry.signature !== operation.signature) {
      throw new Error(`finding #${operation.n} changed before finalization`);
    }
    if (operation.action === 'dismiss') {
      entry.status = 'dismissed';
      entry.by = request.actor;
      entry.reasonCode = operation.reasonCode;
      entry.reason = operation.reason;
      dismissed.push(operation.n);
      continue;
    }
    const fix = resultByNumber.get(operation.n);
    if (fix && fix.status === 'applied') {
      if (!/^[0-9a-f]{40,64}$/i.test(fixSha || '')) {
        throw new Error('a pushed commit SHA is required for applied fixes');
      }
      entry.status = 'fixed';
      entry.sha = fixSha.toLowerCase();
      appliedFixes.push(operation.n);
    }
  }
  const nextStatus = {
    ...status,
    openBlockers: ledger.filter((entry) => entry.status === 'open' && entry.severity >= 7).length,
  };
  nextStatus.pass = nextStatus.openBlockers === 0;
  // Marker bodies are JSON carrying maintainer- and model-authored text, so they
  // must be inserted via a replacer function — a string replacement would expand
  // `$&`/`$'`/`$1` inside a message or dismissal reason and corrupt the ledger.
  let updatedReport = String(report)
    .replace(
      /^<!-- agent-review-ledger: .* -->$/m,
      () => `<!-- agent-review-ledger: ${JSON.stringify(ledger)} -->`,
    )
    .replace(
      /^<!-- agent-review-status: .* -->$/m,
      () => `<!-- agent-review-status: ${JSON.stringify(nextStatus)} -->`,
    )
    .replace(/^- (?:\[[ x]\] )?\*\*#(\d+)\*\*.*$/gm, (line, n) => {
      const entry = byNumber.get(Number(n));
      return entry ? ledgerLine(entry) : line;
    });
  if (Buffer.byteLength(updatedReport) > 65500) throw new Error('updated report exceeds GitHub comment limit');

  const lines = [];
  if (appliedFixes.length) {
    lines.push(
      `🔎 @${request.actor} — I pushed commit \`${fixSha.slice(0, 7)}\` for findings ${appliedFixes.map((n) => `#${n}`).join(', ')}. **Please review that commit before continuing** — these are unreviewed AI changes on your branch.`,
      '',
    );
  } else {
    lines.push(`@${request.actor} — the agent-review address request completed.`, '');
  }
  if (dismissed.length) lines.push(`Dismissed: ${dismissed.map((n) => `#${n}`).join(', ')} using the maintainer-provided reasons.`);
  const notApplied = (result.fixes || []).filter((fix) => fix.status === 'not-applied');
  if (notApplied.length) {
    lines.push(`Not applied: ${notApplied.map((fix) => `#${fix.n} (${fix.reason})`).join('; ')}.`);
  }
  if (request.skipped.length) {
    lines.push(`Skipped: ${request.skipped.map(({ n, reason }) => `#${n} (${reason})`).join('; ')}.`);
  }
  lines.push(
    nextStatus.pass
      ? 'The findings ledger has no open blocking items. Any pushed commit still requires incremental re-review.'
      : `The findings ledger still has ${nextStatus.openBlockers} open blocking item(s).`,
  );
  return {
    report: updatedReport,
    ledger,
    status: nextStatus,
    summary: lines.join('\n'),
    appliedFixes,
    dismissed,
  };
}

module.exports = {
  MAX_PATCH_BYTES,
  MAX_RESULT_BYTES,
  MAX_CHANGED_FILES,
  sha256,
  safeRepoPath,
  extractReportState,
  parseCommand,
  validateRequest,
  prepareAddressRequest,
  validateAddressResult,
  feedbackForAddress,
  finalizeAddress,
};
