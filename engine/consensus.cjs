'use strict';
// Deterministic cross-agent finding consensus: groups paraphrased findings from
// different review lanes into one entry (severity averaging, corroboration
// counting), surfaces ambiguous near-miss pairs as `candidates` for a bounded
// model pass, and applies that pass's `decisions` on a second invocation.
//
// Pure: this module does no filesystem I/O. The CLI (`engine/cli.cjs`'s
// `consensus` case) reads the plan/lane/decisions files and hands consensusFrom
// already-in-memory values (or raw JSON text per lane, for fail-closed parsing).
//
// The grouping key computed here is intentionally NOT the ledger `signature`
// from engine/findingSignature.cjs — that hash is per-agent, persisted, and
// untouchable. This key is cross-agent, recomputed fresh every call, and never
// leaves this module as a "signature".
//
// CLIQUE SEMANTICS (controller ruling): automatic grouping only merges a set of
// findings when EVERY pair in the set satisfies `sameGroup` — a clique, not
// merely a connected component. A -> B and B -> C does not imply A -> C
// (Jaccard/line-proximity isn't transitive), so union-find over pairwise
// matches can silently fold together two genuinely distinct findings, diluting
// severity and hiding one behind the surviving message. A false split is much
// cheaper: it just yields two entries and, when they're still close (same file,
// line distance <= 10), a `candidates` pair that the bounded model pass can
// merge explicitly via `decisions`. Cliques are built deterministically (see
// `buildCliques`) so the same input always groups the same way regardless of
// input ordering (e.g. which agent's lane file was read first).

const { unwrapFindings } = require('./unwrapFindings.cjs');

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function confidenceRank(c) {
  return CONFIDENCE_RANK[String(c || '').toLowerCase()] || 0;
}

// lowercase, strip quotes/digits/punctuation, split on whitespace.
function tokenize(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// Cross-agent grouping key: same file AND (line within +/-3 OR both lines
// null) AND normalized-message token Jaccard >= 0.5.
function sameGroup(a, b) {
  if (!a.file || a.file !== b.file) return false;
  const bothNull = a.line == null && b.line == null;
  const withinRange =
    a.line != null && b.line != null && Math.abs(a.line - b.line) <= 3;
  if (!bothNull && !withinRange) return false;
  return jaccard(tokenize(a.message), tokenize(b.message)) >= 0.5;
}

// Accepts an array, an {findings:[...]} object, or raw JSON text of either
// (production path: the CLI hands us a lane file's raw text so parse failures
// are named by lane here rather than as an opaque JSON.parse stack trace).
function parseLane(value, laneId) {
  if (value === undefined) {
    throw new Error(`missing findings for lane "${laneId}"`);
  }
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      throw new Error(
        `unparseable findings JSON for lane "${laneId}": ${e.message}`,
      );
    }
  }
  const list = unwrapFindings(parsed);
  if (list) return list;
  throw new Error(
    `findings for lane "${laneId}" must be an array or {findings:[...]}`,
  );
}

function normalizeFinding(raw, laneId) {
  const line = raw.line == null || raw.line === '' ? null : Number(raw.line);
  const severity = Number(raw.severity);
  return {
    agent: laneId,
    category: raw.category != null ? String(raw.category) : '',
    severity: Number.isFinite(severity) ? severity : 0,
    file: String(raw.file || ''),
    line: Number.isFinite(line) ? line : null,
    message: raw.message != null ? String(raw.message) : '',
    confidence: raw.confidence != null ? String(raw.confidence) : '',
    evidence: raw.evidence != null ? String(raw.evidence) : '',
    recommendation: raw.recommendation != null ? String(raw.recommendation) : '',
    fix: raw.fix != null ? String(raw.fix) : '',
  };
}

function blockerBarFailure(f) {
  if (f.line === null) return 'severity >= 7 requires a line anchor';
  if (String(f.confidence || '').toLowerCase() !== 'high') {
    return 'severity >= 7 requires High confidence';
  }
  if (!String(f.evidence || '').trim()) {
    return 'severity >= 7 requires concrete evidence';
  }
  return null;
}

// Per-finding validation, run after normalizeFinding, mirroring reportState.cjs's
// cleanFinding/blocker rules so a finding that would later throw inside cleanFinding
// (invalid severity, or a severity >= 7 "blocker" missing the evidence bar) is caught
// here instead — where it can be dropped with a warning rather than detonating deep in
// the pipeline with no lane attribution. This is fail-OPEN per finding: the lane DID
// report, so one bad entry drops silently rather than failing the whole run the way a
// missing lane file does (parseLane above stays fail-closed for that).
function validateFinding(f) {
  if (!f.file) return 'missing file';
  if (!f.message) return 'missing message';
  if (!Number.isInteger(f.severity) || f.severity < 1 || f.severity > 10) {
    return `invalid severity: ${f.severity}`;
  }
  if (f.severity >= 7) return blockerBarFailure(f);
  return null;
}

const CODE_REVIEW_LANE = 'code-review';
const CLEANUP_CATEGORIES = new Set([
  'simplification',
  'efficiency',
  'reuse',
  'altitude',
  'conventions',
]);
const CODE_REVIEW_CAP = 6;
const DOUBTED_CAP = 4;
// The lane template's evidence prefixes, in order: Outside, Recategorized, Doubted.
const OUTSIDE_PREFIX = /^Outside the reviewed range: /i;
// Recategorized's free-text reason ends at no fixed marker, so Doubted counts at
// the start, at a line start, or right after a prior prefix or sentence ends.
const DOUBTED_PREFIX = /(?:^|[\n.:!?]\s*)Doubted: /i;

function codeReviewCap(f) {
  const evidence = String(f.evidence || '').trimStart();
  if (DOUBTED_PREFIX.test(evidence)) return DOUBTED_CAP;
  const cleanup = CLEANUP_CATEGORIES.has(String(f.category).trim().toLowerCase());
  if (cleanup || OUTSIDE_PREFIX.test(evidence)) return CODE_REVIEW_CAP;
  if (f.severity >= 7 && blockerBarFailure(f)) return CODE_REVIEW_CAP;
  return null;
}

function isNumericSeverity(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

// Applies only to the code-review lane, before validateFinding: cleanups,
// out-of-range and doubted findings never block, and a 7+ that misses the
// blocker bar is kept as a suggestion at the cap instead of being dropped by
// validateFinding. Flooring and clamping must come first: the cap and the bar
// judge the whole 1 to 10 severity, and a half point never makes a blocker.
// The raw severity decides whether to clamp, since normalizeFinding turns a
// missing or non-numeric one into 0, which validateFinding must still drop.
function capCodeReviewFinding(input, rawSeverity) {
  if (!isNumericSeverity(rawSeverity)) return input;
  const severity = Math.min(10, Math.max(1, Math.floor(input.severity)));
  const f = severity === input.severity ? input : { ...input, severity };
  const cap = codeReviewCap(f);
  return cap !== null && f.severity > cap ? { ...f, severity: cap } : f;
}

// Canonical order for deterministic clique construction: agent id, then file,
// then line (nulls first), then message. Sorting on this before greedily
// assigning findings to cliques guarantees the same grouping regardless of
// which order the lane files were read/flattened in.
function canonicalOrder(a, b) {
  return (
    a.agent.localeCompare(b.agent) ||
    a.file.localeCompare(b.file) ||
    (a.line == null ? -1 : a.line) - (b.line == null ? -1 : b.line) ||
    a.message.localeCompare(b.message)
  );
}

// Deterministic maximal-clique-ish partition: process findings in canonical
// order and greedily assign each one to the FIRST existing clique where it
// matches (via sameGroup) EVERY current member; otherwise start a new clique.
// This is a clique cover, not necessarily the maximum clique for pathological
// inputs, but it is total, deterministic, and matches the controller ruling's
// prescribed algorithm exactly.
function buildCliques(findings) {
  const ordered = [...findings].sort(canonicalOrder);
  const cliques = [];
  for (const finding of ordered) {
    const clique = cliques.find((c) => c.every((m) => sameGroup(m, finding)));
    if (clique) clique.push(finding);
    else cliques.push([finding]);
  }
  return cliques;
}

// A singleton "group" of one raw finding, shaped like a combined entry so
// downstream logic (profile cutoff, candidates, decision merges) never has to
// special-case group size 1.
function toEntry(m) {
  return {
    agent: m.agent,
    category: m.category,
    severity: m.severity,
    file: m.file,
    line: m.line,
    message: m.message,
    confidence: m.confidence,
    evidence: m.evidence,
    recommendation: m.recommendation,
    fix: m.fix,
    corroboration: 1,
    needsHumanReview: false,
    _minSeverity: m.severity,
    _maxSeverity: m.severity,
  };
}

// A combined entry's agent and severity come from an earlier merge, so only its
// tracked `_provenBlocker` counts; raw and singleton members are tested directly.
// `anyLane` is true only under the code-review engine.
function provenBlockerOf(m, anyLane) {
  if (m._provenBlocker !== undefined) return m._provenBlocker;
  const counts = anyLane || m.agent === CODE_REVIEW_LANE;
  return counts && m.severity >= 7 && !blockerBarFailure(m) ? m : null;
}

// Combines >=2 members (raw findings on first grouping, or already-combined
// entries on a decisions merge) into one output entry per the group rules:
// agent = comma-joined sorted lane ids, severity = rounded mean, confidence =
// highest member's, evidence/recommendation = longest member's (independently
// per field), line/category/message/fix = the highest-severity member's,
// corroboration = summed member count, needsHumanReview = true when the
// severity spread across every underlying original finding is >= 4.
// Exception: a member at 7+ that passes the blocker bar keeps its severity when
// the mean would be lower, and is then the primary. Under the code-review engine
// a member of any lane qualifies; otherwise only a code-review member does.
//
// Deterministic tie-break: when two members tie on the selection criterion
// (severity for `primary`, confidence rank for `bestConfidence`, string length
// for `longestField`), the member with the alphabetically earlier `agent`
// wins. reduce() with a strict `>` comparison always keeps the first member it
// saw on a tie, so sorting a local copy of `members` by agent id ascending
// first is sufficient to make every tie-break deterministic.
function combineMembers(members, anyLane) {
  const ordered = [...members].sort((a, b) => a.agent.localeCompare(b.agent));
  const primary = ordered.reduce(
    (best, m) => (m.severity > best.severity ? m : best),
    ordered[0],
  );
  // Full corroborating lane set for display — collected from each member's own
  // `agents` (if it is itself an already-combined entry from a prior merge) or
  // its single-lane `agent` otherwise. NOT used for `agent` below: that stays
  // the primary member's single lane id so the ledger signature (which hashes
  // `agent`) never shifts with how many lanes corroborated.
  const agents = [
    ...new Set(
      ordered.flatMap((m) =>
        String(m.agents || m.agent || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ),
  ].sort();
  const bestConfidence = ordered.reduce(
    (best, m) =>
      confidenceRank(m.confidence) > confidenceRank(best.confidence) ? m : best,
    ordered[0],
  );
  const longestField = (field) =>
    ordered.reduce(
      (best, m) =>
        String(m[field] || '').length > String(best[field] || '').length
          ? m
          : best,
      ordered[0],
    )[field];
  const corroboration = ordered.reduce(
    (sum, m) => sum + (m.corroboration || 1),
    0,
  );
  const minSeverity = Math.min(
    ...ordered.map((m) => (m._minSeverity != null ? m._minSeverity : m.severity)),
  );
  const maxSeverity = Math.max(
    ...ordered.map((m) => (m._maxSeverity != null ? m._maxSeverity : m.severity)),
  );
  // Weighted by each member's own corroboration count (default 1 for a raw/singleton
  // member) — otherwise re-merging an already-corroborated group with a singleton via
  // `decisions` silently discounts the group's weight down to a single vote.
  // A raised group is weighted at its own mean, so the raise is never counted twice.
  const weightedSum = ordered.reduce(
    (sum, m) =>
      sum + (m._meanSeverity !== undefined ? m._meanSeverity : m.severity) * (m.corroboration || 1),
    0,
  );
  const meanSeverity = Math.round(weightedSum / corroboration);
  const blocker = ordered.reduce((best, m) => {
    const candidate = provenBlockerOf(m, anyLane);
    return candidate && (!best || candidate.severity > best.severity) ? candidate : best;
  }, null);
  const raised = blocker !== null && blocker.severity > meanSeverity;
  const lead = raised ? blocker : primary;
  return {
    agent: lead.agent,
    agents: agents.join(','),
    category: lead.category,
    severity: raised ? blocker.severity : meanSeverity,
    file: lead.file,
    line: lead.line,
    message: lead.message,
    confidence: bestConfidence.confidence,
    evidence: longestField('evidence'),
    recommendation: longestField('recommendation'),
    fix: lead.fix,
    corroboration,
    needsHumanReview: maxSeverity - minSeverity >= 4,
    _minSeverity: minSeverity,
    _maxSeverity: maxSeverity,
    _meanSeverity: meanSeverity,
    _provenBlocker: blocker,
  };
}

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x, y) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }
  return { find, union };
}

function applyProfileCutoff(entries, profile) {
  if (profile !== 'chill') return entries;
  return entries.filter((e) => e.severity >= 4 || e.corroboration >= 2);
}

function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      b.severity - a.severity ||
      a.file.localeCompare(b.file) ||
      (a.line || 0) - (b.line || 0) ||
      a.message.localeCompare(b.message),
  );
}

function lineDistance(a, b) {
  if (a == null && b == null) return 0;
  if (a == null || b == null) return null;
  return Math.abs(a - b);
}

// Ungrouped pairs sharing a file with line distance <= 10, over the output
// findings array, for the skill's bounded model pass. This is also how
// cross-clique pairs (findings that were connected-but-not-clique, per the
// controller ruling) resurface for the model to merge explicitly if it agrees.
function buildCandidates(entries) {
  const candidates = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.file !== b.file || !a.file) continue;
      const dist = lineDistance(a.line, b.line);
      if (dist == null || dist > 10) continue;
      const reason =
        a.line == null && b.line == null
          ? `both findings in ${a.file} have no line anchor`
          : `both findings in ${a.file} within ${dist} line(s) (L${a.line} vs L${b.line})`;
      candidates.push({ a: i, b: j, reason });
    }
  }
  return candidates;
}

// decisions are explicit, model-authored merges (not automatic grouping), so
// they stay union-find: a `merge` decision is a deliberate instruction to
// combine those two entries (and, transitively, anything else a decision also
// merges them with), unlike the clique-restricted automatic pass above.
function applyDecisions(entries, decisions, anyLane) {
  if (!Array.isArray(decisions)) {
    throw new Error('consensus: decisions must be an array');
  }
  const n = entries.length;
  const { find, union } = unionFind(n);
  for (const d of decisions) {
    const pair = d && (d.merge || d.keep);
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`consensus: invalid decision entry ${JSON.stringify(d)}`);
    }
    const [i, j] = pair;
    if (
      !Number.isInteger(i) ||
      !Number.isInteger(j) ||
      i < 0 ||
      j < 0 ||
      i >= n ||
      j >= n
    ) {
      throw new Error(
        `consensus: unknown finding index in decision ${JSON.stringify(d)}`,
      );
    }
    if (d.merge) union(i, j);
  }
  const groupsByRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(entries[i]);
  }
  return [...groupsByRoot.values()].map((members) =>
    members.length === 1 ? members[0] : combineMembers(members, anyLane),
  );
}

function stripInternal(entry) {
  const { _minSeverity, _maxSeverity, _meanSeverity, _provenBlocker, ...rest } = entry;
  return rest;
}

function consensusFrom({
  plan,
  findingsByAgent = {},
  profile = 'standard',
  decisions,
} = {}) {
  const laneIds =
    plan && Array.isArray(plan.agents)
      ? plan.agents.map((a) => a.id)
      : Object.keys(findingsByAgent);
  const codeReviewEngine = Boolean(plan && plan.engine && plan.engine.name === CODE_REVIEW_LANE);
  if (codeReviewEngine && !laneIds.includes(CODE_REVIEW_LANE)) {
    throw new Error(
      'consensus: the plan uses the code-review engine, but the code-review lane was not launched; launch it or rerun with engine=agent-review',
    );
  }

  const errors = [];
  const perLane = {};
  for (const laneId of laneIds) {
    try {
      perLane[laneId] = parseLane(findingsByAgent[laneId], laneId);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) {
    throw new Error(`consensus: ${errors.join('; ')}`);
  }

  const all = [];
  const droppedInvalid = [];
  for (const laneId of laneIds) {
    for (const raw of perLane[laneId]) {
      const normalized = normalizeFinding(raw, laneId);
      const finding =
        laneId === CODE_REVIEW_LANE ? capCodeReviewFinding(normalized, raw.severity) : normalized;
      const reason = validateFinding(finding);
      if (reason) {
        const messageSlice = String(finding.message || '').slice(0, 200);
        droppedInvalid.push({ lane: laneId, reason, message: messageSlice });
        console.warn(
          `consensus: dropping invalid finding from lane "${laneId}": ${reason} (message: "${messageSlice}")`,
        );
        continue;
      }
      all.push(finding);
    }
  }

  // Clique-restricted automatic grouping (controller ruling) — see
  // buildCliques/canonicalOrder above. Grouping outcome is independent of the
  // order findings were flattened in (laneIds order, dict key order, etc.)
  // because buildCliques re-sorts canonically before assigning.
  let entries = buildCliques(all).map((members) =>
    members.length === 1 ? toEntry(members[0]) : combineMembers(members, codeReviewEngine),
  );

  const beforeCutoff = entries.length;
  entries = applyProfileCutoff(entries, profile);
  const droppedByProfile = beforeCutoff - entries.length;
  entries = sortEntries(entries);

  if (decisions !== undefined) {
    entries = sortEntries(applyDecisions(entries, decisions, codeReviewEngine));
  }

  const candidates = buildCandidates(entries);
  const findings = entries.map(stripInternal);

  const stats = {
    raw: all.length,
    groups: findings.filter((e) => e.corroboration > 1).length,
    singletons: findings.filter((e) => e.corroboration === 1).length,
    droppedByProfile,
    droppedInvalid,
    needsHumanReview: findings.filter((e) => e.needsHumanReview).length,
  };

  return { findings, candidates, stats };
}

module.exports = { consensusFrom, capCodeReviewFinding, tokenize, jaccard, parseLane };
