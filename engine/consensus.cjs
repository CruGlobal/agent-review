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
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.findings)) return parsed.findings;
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
  };
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
    corroboration: 1,
    needsHumanReview: false,
    _minSeverity: m.severity,
    _maxSeverity: m.severity,
  };
}

// Combines >=2 members (raw findings on first grouping, or already-combined
// entries on a decisions merge) into one output entry per the group rules:
// agent = comma-joined sorted lane ids, severity = rounded mean, confidence =
// highest member's, evidence/recommendation = longest member's (independently
// per field), line/category/message = the highest-severity member's,
// corroboration = summed member count, needsHumanReview = true when the
// severity spread across every underlying original finding is >= 4.
//
// Deterministic tie-break: when two members tie on the selection criterion
// (severity for `primary`, confidence rank for `bestConfidence`, string length
// for `longestField`), the member with the alphabetically earlier `agent`
// wins. reduce() with a strict `>` comparison always keeps the first member it
// saw on a tie, so sorting a local copy of `members` by agent id ascending
// first is sufficient to make every tie-break deterministic.
function combineMembers(members) {
  const ordered = [...members].sort((a, b) => a.agent.localeCompare(b.agent));
  const primary = ordered.reduce(
    (best, m) => (m.severity > best.severity ? m : best),
    ordered[0],
  );
  const agents = [
    ...new Set(
      ordered.flatMap((m) =>
        String(m.agent || '')
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
  const meanSeverity =
    ordered.reduce((sum, m) => sum + m.severity, 0) / ordered.length;
  return {
    agent: agents.join(','),
    category: primary.category,
    severity: Math.round(meanSeverity),
    file: primary.file,
    line: primary.line,
    message: primary.message,
    confidence: bestConfidence.confidence,
    evidence: longestField('evidence'),
    recommendation: longestField('recommendation'),
    corroboration,
    needsHumanReview: maxSeverity - minSeverity >= 4,
    _minSeverity: minSeverity,
    _maxSeverity: maxSeverity,
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
function applyDecisions(entries, decisions) {
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
    members.length === 1 ? members[0] : combineMembers(members),
  );
}

function stripInternal(entry) {
  const { _minSeverity, _maxSeverity, ...rest } = entry;
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
  for (const laneId of laneIds) {
    for (const raw of perLane[laneId]) {
      all.push(normalizeFinding(raw, laneId));
    }
  }

  // Clique-restricted automatic grouping (controller ruling) — see
  // buildCliques/canonicalOrder above. Grouping outcome is independent of the
  // order findings were flattened in (laneIds order, dict key order, etc.)
  // because buildCliques re-sorts canonically before assigning.
  let entries = buildCliques(all).map((members) =>
    members.length === 1 ? toEntry(members[0]) : combineMembers(members),
  );

  const beforeCutoff = entries.length;
  entries = applyProfileCutoff(entries, profile);
  const droppedByProfile = beforeCutoff - entries.length;
  entries = sortEntries(entries);

  if (decisions !== undefined) {
    entries = sortEntries(applyDecisions(entries, decisions));
  }

  const candidates = buildCandidates(entries);
  const findings = entries.map(stripInternal);

  const stats = {
    raw: all.length,
    groups: findings.filter((e) => e.corroboration > 1).length,
    singletons: findings.filter((e) => e.corroboration === 1).length,
    droppedByProfile,
    needsHumanReview: findings.filter((e) => e.needsHumanReview).length,
  };

  return { findings, candidates, stats };
}

module.exports = { consensusFrom, tokenize, jaccard, parseLane };
