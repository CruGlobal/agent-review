'use strict';

const { signature } = require('./findingSignature.cjs');

const STATUSES = new Set(['open', 'fixed', 'dismissed']);
const RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function findingList(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.kept)) return input.kept;
  if (input && Array.isArray(input.findings)) return input.findings;
  throw new Error('findings must be an array or an object with kept/findings');
}

function cleanFinding(raw, { requireBlockerEvidence = false } = {}) {
  const severity = Number(raw.severity);
  if (!Number.isFinite(severity) || severity < 1 || severity > 10) {
    throw new Error(`invalid finding severity: ${raw.severity}`);
  }
  if (!raw.file || !raw.message) {
    throw new Error('each finding requires file and message');
  }
  const line = raw.line == null || raw.line === '' ? null : Number(raw.line);
  if (line !== null && (!Number.isInteger(line) || line < 1)) {
    throw new Error(`invalid finding line: ${raw.line}`);
  }
  if (
    requireBlockerEvidence &&
    severity >= 7 &&
    (line === null ||
      String(raw.confidence || '').toLowerCase() !== 'high' ||
      !String(raw.evidence || '').trim())
  ) {
    throw new Error(
      'severity >= 7 requires a line anchor, High confidence, and concrete evidence',
    );
  }
  const clean = {
    id: String(raw.id || ''),
    signature: String(raw.signature || signature(raw)),
    agent: String(raw.agent || ''),
    category: String(raw.category || ''),
    severity,
    file: String(raw.file),
    line,
    message: String(raw.message),
  };
  // Keep enough verified context for a later incremental run to address an old
  // finding after the visible report body has been replaced. Bound each field so
  // the hidden ledger cannot grow past GitHub's comment limit unexpectedly.
  for (const field of ['evidence', 'recommendation', 'detail', 'confidence']) {
    if (raw[field]) clean[field] = String(raw[field]).slice(0, 2000);
  }
  return clean;
}

function cleanPrevious(raw) {
  if (!Array.isArray(raw)) throw new Error('previous ledger must be an array');
  const numbers = new Set();
  const signatures = new Set();
  return raw.map((entry) => {
    if (!Number.isInteger(entry.n) || entry.n < 1 || numbers.has(entry.n)) {
      throw new Error(`invalid or duplicate ledger number: ${entry.n}`);
    }
    numbers.add(entry.n);
    if (!entry.signature || signatures.has(entry.signature)) {
      throw new Error(`missing or duplicate ledger signature: ${entry.signature || ''}`);
    }
    signatures.add(entry.signature);
    if (!STATUSES.has(entry.status)) {
      throw new Error(`invalid ledger status: ${entry.status}`);
    }
    const finding = cleanFinding(entry);
    const clean = { n: entry.n, ...finding, status: entry.status };
    if (entry.status === 'fixed' && entry.sha) clean.sha = String(entry.sha);
    if (entry.status === 'dismissed') {
      if (entry.by) clean.by = String(entry.by);
      if (entry.reason) clean.reason = String(entry.reason);
      if (entry.reasonCode) clean.reasonCode = String(entry.reasonCode);
    }
    return clean;
  });
}

function mergeLedger(previousInput, findingsInput) {
  const previous = cleanPrevious(previousInput || []);
  const seen = new Set(previous.map((entry) => entry.signature));
  let next = previous.reduce((max, entry) => Math.max(max, entry.n), 0) + 1;
  const additions = findingList(findingsInput)
    .map((finding) =>
      cleanFinding(finding, { requireBlockerEvidence: true }),
    )
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        a.file.localeCompare(b.file) ||
        (a.line || 0) - (b.line || 0) ||
        a.message.localeCompare(b.message),
    );
  const merged = [...previous];
  for (const finding of additions) {
    if (seen.has(finding.signature)) continue;
    seen.add(finding.signature);
    merged.push({ n: next++, ...finding, status: 'open' });
  }
  return merged;
}

function buildStatus({ ledger, head, plan, safety, evidence }) {
  const clean = cleanPrevious(ledger || []);
  const risk = plan && plan.risk && plan.risk.level;
  if (!RISKS.has(risk)) throw new Error(`invalid gate-plan risk: ${risk}`);
  const irreversible = Boolean(safety && safety.irreversible);
  const irreversibleReasons = irreversible
    ? (safety.reasons || safety.irreversibleReasons || []).map(String)
    : [];
  if (irreversible && irreversibleReasons.length === 0) {
    throw new Error('irreversible safety result requires at least one reason');
  }
  const openBlockers = clean.filter(
    (entry) => entry.status === 'open' && entry.severity >= 7,
  ).length;
  const ci = evidence && evidence.ci && evidence.ci.summary
    ? Object.fromEntries(['total', 'success', 'failed', 'pending', 'neutral'].map((key) => {
        const value = Number(evidence.ci.summary[key] || 0);
        if (!Number.isInteger(value) || value < 0) throw new Error(`invalid CI summary count: ${key}`);
        return [key, value];
      }))
    : null;
  return {
    v: 1,
    ...(head ? { head: String(head) } : {}),
    risk,
    openBlockers,
    pass: openBlockers === 0,
    irreversible,
    irreversibleReasons,
    ...(ci ? { ci } : {}),
  };
}

module.exports = { findingList, mergeLedger, buildStatus };
