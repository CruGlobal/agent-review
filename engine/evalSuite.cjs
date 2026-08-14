'use strict';

const {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} = require('node:fs');
const { execFileSync } = require('node:child_process');
const { basename, dirname, extname, join, resolve } = require('node:path');
const YAML = require('yaml');
const { Minimatch } = require('minimatch');

const DISMISSAL_REASONS = new Set([
  'false-positive',
  'intentional',
  'pre-existing',
  'deferred',
  'duplicate',
  'insufficient-evidence',
  'other',
]);

function readData(path) {
  const text = readFileSync(path, 'utf8');
  return /\.ya?ml$/i.test(path) ? YAML.parse(text) : JSON.parse(text);
}

function finiteRate(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number from 0 to 1`);
  }
  return n;
}

function validateSuite(raw, { suitePath } = {}) {
  if (!raw || raw.version !== 1) throw new Error('evaluation suite version must be 1');
  if (!raw.name) throw new Error('evaluation suite requires name');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('evaluation suite requires at least one case');
  }
  const ids = new Set();
  const base = suitePath ? dirname(suitePath) : process.cwd();
  for (const c of raw.cases) {
    if (!c.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(c.id)) {
      throw new Error(`invalid evaluation case id: ${c.id || ''}`);
    }
    if (ids.has(c.id)) throw new Error(`duplicate evaluation case id: ${c.id}`);
    ids.add(c.id);
    if (!['seeded_bug', 'clean_control'].includes(c.kind)) {
      throw new Error(`case ${c.id} has invalid kind: ${c.kind}`);
    }
    if (c.patch && suitePath && !existsSync(join(base, c.patch))) {
      throw new Error(`case ${c.id} references missing patch: ${c.patch}`);
    }
    const expected = c.expected || [];
    if (c.kind === 'seeded_bug' && expected.length === 0) {
      throw new Error(`seeded case ${c.id} requires expected findings`);
    }
    if (c.kind === 'clean_control' && expected.some((e) => e.must_block !== false)) {
      throw new Error(`clean control ${c.id} cannot require a blocker`);
    }
    for (const e of expected) {
      if (!e.id) throw new Error(`case ${c.id} has an expected finding without id`);
      const min = Number(e.min_severity == null ? 7 : e.min_severity);
      if (!Number.isFinite(min) || min < 1 || min > 10) {
        throw new Error(`case ${c.id}/${e.id} has invalid min_severity`);
      }
      const match = e.match || {};
      if (!Array.isArray(match.paths) || match.paths.length === 0) {
        throw new Error(`case ${c.id}/${e.id} requires match.paths`);
      }
      for (const key of ['categories', 'message_all', 'message_any']) {
        if (match[key] != null && !Array.isArray(match[key])) {
          throw new Error(`case ${c.id}/${e.id} match.${key} must be an array`);
        }
      }
    }
  }
  const thresholds = raw.thresholds || {};
  for (const key of [
    'blocker_recall',
    'blocker_precision',
    'clean_false_blocker_rate',
    'false_positive_dismissal_rate',
    'category_recall',
  ]) {
    if (thresholds[key] != null) finiteRate(thresholds[key], `thresholds.${key}`);
  }
  return raw;
}

function normalizeRun(raw, fallbackId) {
  const findings = raw.findings || raw.kept || (Array.isArray(raw) ? raw : []);
  if (!Array.isArray(findings)) throw new Error('evaluation result findings must be an array');
  const caseId = raw.case_id || raw.caseId || fallbackId;
  const runId = raw.run_id || raw.runId || 'run-1';
  if (!caseId || typeof caseId !== 'string') throw new Error('evaluation result requires case_id');
  if (!runId || typeof runId !== 'string') throw new Error(`evaluation result ${caseId} requires run_id`);
  return {
    case_id: caseId,
    run_id: runId,
    findings: findings.map((f, index) => {
      const severity = Number(f.severity);
      if (!Number.isFinite(severity) || severity < 1 || severity > 10) {
        throw new Error(`evaluation result ${caseId}/${runId} finding ${index + 1} has invalid severity`);
      }
      if (f.outcome != null && !['accepted', 'dismissed'].includes(f.outcome)) {
        throw new Error(`evaluation result ${caseId}/${runId} finding ${index + 1} has invalid outcome`);
      }
      if (f.verdict != null && !['true_positive', 'false_positive', 'duplicate'].includes(f.verdict)) {
        throw new Error(`evaluation result ${caseId}/${runId} finding ${index + 1} has invalid verdict`);
      }
      const reason = f.dismissal_reason || f.dismissalReason || f.reason_code;
      if (f.outcome === 'dismissed' && !DISMISSAL_REASONS.has(reason)) {
        throw new Error(`evaluation result ${caseId}/${runId} finding ${index + 1} requires a valid dismissal reason`);
      }
      return { ...f, severity };
    }),
  };
}

function loadResultRuns(path) {
  if (!statSync(path).isDirectory()) {
    const raw = readData(path);
    if (Array.isArray(raw.runs)) return raw.runs.map((r) => normalizeRun(r));
    return [normalizeRun(raw, basename(path, extname(path)))];
  }
  const runs = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) visit(child);
      else if (/\.(json|ya?ml)$/i.test(name)) {
        const raw = readData(child);
        const fallback = basename(name, extname(name)).replace(/\.run-[^.]+$/, '');
        if (Array.isArray(raw.runs)) runs.push(...raw.runs.map((r) => normalizeRun(r)));
        else runs.push(normalizeRun(raw, fallback));
      }
    }
  };
  visit(path);
  return runs;
}

function includesText(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle).toLowerCase());
}

function matchesExpected(finding, expected, blockerThreshold) {
  const match = expected.match || {};
  const minimum = Number(expected.min_severity == null ? blockerThreshold : expected.min_severity);
  if (!Number.isFinite(finding.severity) || finding.severity < minimum) return false;
  if (!(match.paths || []).some((p) => new Minimatch(p, { dot: true }).match(finding.file || ''))) {
    return false;
  }
  if (
    match.categories &&
    match.categories.length &&
    !match.categories.some((c) => includesText(finding.category, c))
  ) return false;
  const text = [finding.message, finding.evidence, finding.detail].filter(Boolean).join(' ');
  if ((match.message_all || []).some((term) => !includesText(text, term))) return false;
  if (
    match.message_any &&
    match.message_any.length &&
    !match.message_any.some((term) => includesText(text, term))
  ) return false;
  return true;
}

function ratio(num, den) {
  return den === 0 ? null : num / den;
}

function scoreSuite(suiteInput, runsInput) {
  const suite = validateSuite(suiteInput);
  const blockerThreshold = Number(suite.blocker_threshold || 7);
  const cases = new Map(suite.cases.map((c) => [c.id, c]));
  const seenRuns = new Set();
  const totals = {
    expectedBlockers: 0,
    truePositiveBlockers: 0,
    validBlockerFindings: 0,
    falsePositiveBlockers: 0,
    cleanRuns: 0,
    cleanRunsWithBlocker: 0,
    accepted: 0,
    dismissed: 0,
    falsePositiveDismissals: 0,
  };
  const category = new Map();
  const caseRuns = new Map();
  const details = [];

  for (const rawRun of runsInput) {
    const run = normalizeRun(rawRun);
    const c = cases.get(run.case_id);
    if (!c) throw new Error(`result references unknown case: ${run.case_id}`);
    const key = `${run.case_id}/${run.run_id}`;
    if (seenRuns.has(key)) throw new Error(`duplicate result run: ${key}`);
    seenRuns.add(key);

    const expected = (c.expected || []).filter((e) => e.must_block !== false);
    const unmatchedActual = new Set(run.findings.map((_, i) => i));
    const matched = [];
    for (const e of expected) {
      totals.expectedBlockers++;
      const cat = String(e.category || c.category || 'uncategorized');
      const cs = category.get(cat) || { expected: 0, detected: 0 };
      cs.expected++;
      let index = run.findings.findIndex(
        (f, i) => unmatchedActual.has(i) && f.verdict !== 'false_positive' && matchesExpected(f, e, blockerThreshold),
      );
      if (index >= 0) {
        totals.truePositiveBlockers++;
        cs.detected++;
        unmatchedActual.delete(index);
        matched.push({ expected: e.id, finding: index });
      }
      category.set(cat, cs);
    }

    let falseBlockers = 0;
    run.findings.forEach((finding, i) => {
      if (finding.outcome === 'accepted') totals.accepted++;
      if (finding.outcome === 'dismissed') {
        totals.dismissed++;
        const reason = finding.dismissal_reason || finding.dismissalReason || finding.reason_code;
        if (reason === 'false-positive' || reason === 'insufficient-evidence') {
          totals.falsePositiveDismissals++;
        }
      }
      if (finding.severity < blockerThreshold || finding.verdict === 'duplicate') return;
      if (
        (!unmatchedActual.has(i) && finding.verdict !== 'false_positive') ||
        finding.verdict === 'true_positive'
      ) totals.validBlockerFindings++;
      else falseBlockers++;
    });
    totals.falsePositiveBlockers += falseBlockers;
    if (c.kind === 'clean_control') {
      totals.cleanRuns++;
      if (run.findings.some((f) => f.severity >= blockerThreshold && f.verdict !== 'duplicate')) {
        totals.cleanRunsWithBlocker++;
      }
    }
    const detected = c.kind === 'clean_control' ? falseBlockers === 0 : matched.length === expected.length;
    const cr = caseRuns.get(c.id) || { kind: c.kind, runs: 0, detected: 0 };
    cr.runs++;
    if (detected) cr.detected++;
    caseRuns.set(c.id, cr);
    details.push({
      caseId: c.id,
      runId: run.run_id,
      expectedBlockers: expected.length,
      detectedBlockers: matched.length,
      falsePositiveBlockers: falseBlockers,
      matched,
    });
  }

  const precisionDen = totals.validBlockerFindings + totals.falsePositiveBlockers;
  const dispositioned = totals.accepted + totals.dismissed;
  const metrics = {
    blockerRecall: ratio(totals.truePositiveBlockers, totals.expectedBlockers),
    blockerPrecision: ratio(totals.validBlockerFindings, precisionDen),
    cleanFalseBlockerRate: ratio(totals.cleanRunsWithBlocker, totals.cleanRuns),
    dismissalRate: ratio(totals.dismissed, dispositioned),
    falsePositiveDismissalRate: ratio(totals.falsePositiveDismissals, dispositioned),
  };
  const categories = Object.fromEntries(
    [...category.entries()].sort().map(([name, value]) => [name, { ...value, recall: ratio(value.detected, value.expected) }]),
  );
  const stability = Object.fromEntries(
    [...caseRuns.entries()].sort().map(([id, value]) => [id, {
      ...value,
      ...(value.kind === 'clean_control'
        ? { cleanPassRate: ratio(value.detected, value.runs) }
        : { detectionRate: ratio(value.detected, value.runs) }),
    }]),
  );
  const t = suite.thresholds || {};
  const gateChecks = {
    blockerRecall: t.blocker_recall == null || (metrics.blockerRecall != null && metrics.blockerRecall >= t.blocker_recall),
    blockerPrecision: t.blocker_precision == null || (metrics.blockerPrecision != null && metrics.blockerPrecision >= t.blocker_precision),
    cleanFalseBlockerRate: t.clean_false_blocker_rate == null || (metrics.cleanFalseBlockerRate != null && metrics.cleanFalseBlockerRate <= t.clean_false_blocker_rate),
    falsePositiveDismissalRate: t.false_positive_dismissal_rate == null || (metrics.falsePositiveDismissalRate != null && metrics.falsePositiveDismissalRate <= t.false_positive_dismissal_rate),
    categoryRecall:
      t.category_recall == null ||
      (Object.keys(categories).length > 0 &&
        Object.values(categories).every((v) => v.recall != null && v.recall >= t.category_recall)),
    minimumRuns: runsInput.length >= Number(t.minimum_runs || 1),
    everyCaseCovered: suite.cases.every((c) => caseRuns.has(c.id)),
  };
  return {
    version: 1,
    suite: suite.name,
    generatedAt: new Date().toISOString(),
    totals,
    metrics,
    categories,
    stability,
    gate: { pass: Object.values(gateChecks).every(Boolean), checks: gateChecks },
    details,
  };
}

function compareEvaluation(current, baseline) {
  const delta = {};
  for (const key of Object.keys(current.metrics || {})) {
    const a = current.metrics[key];
    const b = baseline.metrics && baseline.metrics[key];
    delta[key] = a == null || b == null ? null : a - b;
  }
  return { baselineSuite: baseline.suite || null, metricDelta: delta };
}

function materializeCase({ suite, suitePath, caseId, repo, out, base = 'HEAD' }) {
  const valid = validateSuite(suite, { suitePath });
  const c = valid.cases.find((item) => item.id === caseId);
  if (!c) throw new Error(`evaluation case not found: ${caseId}`);
  if (!c.patch) throw new Error(`evaluation case ${caseId} has no patch`);
  const target = resolve(out);
  if (existsSync(target)) throw new Error(`refusing to overwrite existing eval worktree: ${target}`);
  const root = resolve(repo);
  const patch = resolve(dirname(suitePath), c.patch);
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', target, base], { stdio: 'pipe' });
  try {
    const baseHead = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', target, 'apply', '--check', patch], { stdio: 'pipe' });
    execFileSync('git', ['-C', target, 'apply', patch], { stdio: 'pipe' });
    execFileSync('git', ['-C', target, 'add', '--all'], { stdio: 'pipe' });
    execFileSync('git', [
      '-C', target,
      '-c', 'user.name=agent-review evaluation',
      '-c', 'user.email=agent-review-eval@invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '--no-gpg-sign', '-m', `agent-review eval seed: ${caseId}`,
    ], { stdio: 'pipe' });
    const seededHead = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { caseId, worktree: target, base, baseHead, seededHead, patch };
  } catch (e) {
    throw new Error(`seed preparation failed in ${target}; worktree was preserved for inspection: ${e.message.split('\n')[0]}`);
  }
}

module.exports = {
  DISMISSAL_REASONS,
  readData,
  validateSuite,
  loadResultRuns,
  matchesExpected,
  scoreSuite,
  compareEvaluation,
  materializeCase,
};
