'use strict';

const { signature } = require('./findingSignature.cjs');
const { unwrapFindings } = require('./unwrapFindings.cjs');
const { tokenize, jaccard } = require('./consensus.cjs');

const STATUSES = new Set(['open', 'fixed', 'dismissed']);
const RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function findingList(input) {
  if (input && !Array.isArray(input) && Array.isArray(input.kept)) return input.kept;
  const list = unwrapFindings(input);
  if (!list) throw new Error('findings must be an array or an object with kept/findings');
  return list;
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
  // `agents` is the consensus engine's full corroborating-lane display field (see
  // engine/consensus.cjs combineMembers) — `agent` itself stays the single primary
  // lane id so the signature above never shifts with corroboration count.
  for (const field of ['evidence', 'recommendation', 'detail', 'confidence', 'fix', 'agents']) {
    if (raw[field]) clean[field] = String(raw[field]).slice(0, 2000);
  }
  // Optional boolean carry — set by the consensus engine when a group's member
  // severities spread >= 4, flagging it for senior-human review rather than
  // reflexive dismissal (see templates/report.md and skills/review/SKILL.md).
  if (raw.needsHumanReview) clean.needsHumanReview = true;
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

const LOCATION_WINDOW = 5;
const LOCATION_WORDING = 0.5;
const CANDIDATE_WINDOW = 10;
const PAIR_TEXT_LIMIT = 500;

class MatchesRejected extends Error {}

function sameCategory(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function nearLine(a, b, window) {
  if (a === null && b === null) return true;
  return a !== null && b !== null && Math.abs(a - b) <= window;
}

function similarWording(a, b) {
  return jaccard(tokenize(a), tokenize(b)) >= LOCATION_WORDING;
}

function isStaticFinding(finding) {
  return finding.agent === 'static-analysis' || finding.category.startsWith('static-analysis/');
}

// Blockers are excluded so a real or regressed blocker never hides behind an older entry.
// Static findings are excluded because every static signature must reach the ledger.
// Fixed entries and other lanes' entries never match, so a regression or a second lane's
// finding at the same spot still reaches the ledger.
function matchesEarlierSpot(finding, previous) {
  return (
    finding.severity < 7 &&
    !isStaticFinding(finding) &&
    previous.some(
      (entry) =>
        entry.status !== 'fixed' &&
        entry.agent === finding.agent &&
        entry.file === finding.file &&
        sameCategory(entry.category, finding.category) &&
        nearLine(entry.line, finding.line, LOCATION_WINDOW) &&
        similarWording(entry.message, finding.message),
    )
  );
}

// Everything mergeLedger does before it appends. ledgerCandidates reads the same result, so the
// pairs a matcher answers always name exactly the findings the merge would append.
function mergeSteps(previousInput, findingsInput, matchSuggestionsByLocation) {
  const previous = cleanPrevious(previousInput || []);
  const bySignature = new Map(previous.map((entry, i) => [entry.signature, i]));
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
  const unmatched = [];
  for (const finding of additions) {
    const at = bySignature.get(finding.signature);
    if (at === undefined) {
      unmatched.push(finding);
      continue;
    }
    // A raise never lowers an entry and never changes a dismissed or fixed one.
    if (merged[at].status === 'open' && finding.severity > merged[at].severity) {
      merged[at] = { n: merged[at].n, ...finding, status: 'open' };
    }
  }
  // Location matching runs after every raise, against the moved entries.
  const seen = new Set(bySignature.keys());
  const fresh = [];
  for (const finding of unmatched) {
    if (seen.has(finding.signature)) continue;
    if (matchSuggestionsByLocation && matchesEarlierSpot(finding, merged)) continue;
    seen.add(finding.signature);
    fresh.push(finding);
  }
  return { earlier: merged, fresh };
}

// Same exclusions as matchesEarlierSpot, a wider window, and no category or wording bar: the
// matcher judges sameness. Each fresh finding has its own signature, so pair ids are unique.
function candidatePairs(earlier, fresh) {
  const pairs = [];
  for (const finding of fresh) {
    if (finding.severity >= 7 || isStaticFinding(finding)) continue;
    const near = earlier
      .filter(
        (entry) =>
          entry.status !== 'fixed' &&
          entry.agent === finding.agent &&
          entry.file === finding.file &&
          nearLine(entry.line, finding.line, CANDIDATE_WINDOW),
      )
      .sort((a, b) => a.n - b.n);
    for (const entry of near) pairs.push({ id: `${finding.signature}#${entry.n}`, finding, entry });
  }
  return pairs;
}

// The matcher must never see how either side was scored or handled: no severity, status, agent,
// or confidence leaves this function, and no evidence, which can hold the reason for a score.
function problemFields(finding) {
  return {
    line: finding.line,
    category: finding.category,
    message: finding.message.slice(0, PAIR_TEXT_LIMIT),
    recommendation: (finding.recommendation || '').slice(0, PAIR_TEXT_LIMIT),
  };
}

function ledgerCandidates(previousInput, findingsInput) {
  const { earlier, fresh } = mergeSteps(previousInput, findingsInput, true);
  return candidatePairs(earlier, fresh).map(({ id, finding, entry }) => ({
    id,
    file: finding.file,
    earlier: problemFields(entry),
    finding: problemFields(finding),
  }));
}

function matchedSignatures(matches, pairs) {
  if (!Array.isArray(matches)) throw new MatchesRejected('matches must be an array');
  const signatureOf = new Map(pairs.map((pair) => [pair.id, pair.finding.signature]));
  const answered = new Set();
  const matched = new Set();
  matches.forEach((item, i) => {
    const wellFormed =
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.keys(item).length === 2 &&
      Object.hasOwn(item, 'id') &&
      Object.hasOwn(item, 'same') &&
      typeof item.id === 'string' &&
      typeof item.same === 'boolean';
    if (!wellFormed) {
      throw new MatchesRejected(`item ${i} must be an object with exactly "id" (a string) and "same" (a boolean)`);
    }
    if (!signatureOf.has(item.id)) {
      throw new MatchesRejected(`${JSON.stringify(item.id)} is not a candidate pair for these findings`);
    }
    if (answered.has(item.id)) throw new MatchesRejected(`${JSON.stringify(item.id)} is answered twice`);
    answered.add(item.id);
    if (item.same) matched.add(signatureOf.get(item.id));
  });
  return matched;
}

// A match only keeps the new finding out. The earlier entry is never raised or rewritten, so a
// wrong match can hide only the new wording, never the issue the ledger already holds.
function mergeLedger(previousInput, findingsInput, { matchSuggestionsByLocation = false, matches } = {}) {
  if (matches !== undefined && !matchSuggestionsByLocation) {
    throw new MatchesRejected('matches need location matching (--match-suggestions-by-location)');
  }
  const { earlier, fresh } = mergeSteps(previousInput, findingsInput, matchSuggestionsByLocation);
  const matched = matches === undefined ? new Set() : matchedSignatures(matches, candidatePairs(earlier, fresh));
  const merged = [...earlier];
  let next = earlier.reduce((max, entry) => Math.max(max, entry.n), 0) + 1;
  for (const finding of fresh) {
    if (matched.has(finding.signature)) continue;
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

module.exports = { findingList, cleanPrevious, mergeLedger, ledgerCandidates, MatchesRejected, buildStatus };
