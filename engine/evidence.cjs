'use strict';

const { readFileSync } = require('node:fs');
const { Minimatch } = require('minimatch');
const { signature } = require('./findingSignature.cjs');

const AST_SEVERITY = { error: 8, warning: 6, info: 4, hint: 2, off: 0 };
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const PENDING = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

function addedLines(diffText) {
  const files = new Map();
  let path = null;
  let line = 0;
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      const value = raw.slice(4).trim();
      path = value === '/dev/null' ? null : value.replace(/^b\//, '');
      if (path && !files.has(path)) files.set(path, new Set());
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || raw.startsWith('diff --git')) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      files.get(path).add(line++);
    } else if (!raw.startsWith('-') && !raw.startsWith('---')) {
      line++;
    }
  }
  return files;
}

function parseJsonOrStream(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : parsed.matches || [parsed];
  } catch {
    return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

function staticFindings({ astGrep, diffText, severity = {}, excludedPaths = [] }) {
  const changed = addedLines(diffText);
  const severityMap = { ...AST_SEVERITY, ...severity };
  const excluded = excludedPaths.map((p) => new Minimatch(p, { dot: true }));
  const findings = [];
  for (const match of parseJsonOrStream(astGrep)) {
    const file = String(match.file || '').replace(/^\.\//, '');
    const line = Number(match.range && match.range.start && match.range.start.line) + 1;
    if (!file || !Number.isInteger(line)) continue;
    if (excluded.some((m) => m.match(file))) continue;
    if (!changed.has(file) || !changed.get(file).has(line)) continue;
    const level = String(match.severity || 'warning').toLowerCase();
    const numeric = Number(severityMap[level]);
    if (!Number.isFinite(numeric) || numeric < 1) continue;
    const ruleId = String(match.ruleId || 'ast-grep');
    const message = String(match.message || match.note || `Structural rule ${ruleId} matched`);
    const finding = {
      agent: 'static-analysis',
      category: `static-analysis/${ruleId}`,
      severity: numeric,
      file,
      line,
      message,
      confidence: 'High',
      evidence: `ast-grep rule ${ruleId} matched added line ${file}:${line}: ${String(match.lines || match.text || '').trim().slice(0, 500)}`,
      recommendation: String(match.note || 'Resolve the structural rule or document an intentional suppression.'),
      source: 'ast-grep',
      ruleId,
    };
    finding.signature = signature(finding);
    findings.push(finding);
  }
  return findings.sort(
    (a, b) => b.severity - a.severity || a.file.localeCompare(b.file) || a.line - b.line,
  );
}

function cleanCheck(check) {
  const status = String(check.status || '');
  const conclusion = check.conclusion == null ? null : String(check.conclusion);
  let state = 'neutral';
  if (PENDING.has(status) || (status !== 'completed' && !conclusion)) state = 'pending';
  else if (FAILED.has(conclusion)) state = 'failed';
  else if (conclusion === 'success') state = 'success';
  return {
    id: check.id,
    name: String(check.name || 'unnamed check'),
    status,
    conclusion,
    state,
    url: check.html_url || check.details_url || null,
    title: check.output && check.output.title ? String(check.output.title).slice(0, 500) : null,
    summary: check.output && check.output.summary ? String(check.output.summary).slice(0, 2000) : null,
    annotations: Array.isArray(check.annotations) ? check.annotations.slice(0, 100).map((a) => ({
      path: a.path || null,
      line: a.start_line || null,
      level: a.annotation_level || null,
      title: a.title || null,
      message: String(a.message || '').slice(0, 1000),
    })) : [],
  };
}

function ciSummary(raw, { ignoreChecks = [] } = {}) {
  const checks = (raw && (raw.check_runs || raw.checks || raw)) || [];
  if (!Array.isArray(checks)) throw new Error('CI input must contain a check_runs array');
  const ignored = ignoreChecks.map((p) => new Minimatch(p, { nocase: true }));
  const clean = checks
    .map(cleanCheck)
    .filter((c) => !/^agent-review(?:\b|\s|\/|$)/i.test(c.name))
    .filter((c) => !ignored.some((m) => m.match(c.name)));
  const counts = { total: clean.length, success: 0, failed: 0, pending: 0, neutral: 0 };
  for (const c of clean) counts[c.state]++;
  return {
    version: 1,
    summary: counts,
    checks: clean,
  };
}

function buildEvidence({ diffPath, astGrepPath, ciPath, staticConfig = {}, ciConfig = {} }) {
  const diffText = diffPath ? readFileSync(diffPath, 'utf8') : '';
  return {
    version: 1,
    staticFindings: astGrepPath && staticConfig.enabled !== false
      ? staticFindings({
          astGrep: readFileSync(astGrepPath, 'utf8'),
          diffText,
          severity: staticConfig.severity,
          excludedPaths: staticConfig.excluded_paths || [],
        })
      : [],
    ci: ciPath && ciConfig.enabled !== false
      ? ciSummary(JSON.parse(readFileSync(ciPath, 'utf8')), ciConfig)
      : null,
  };
}

function verifyEvidenceLedger(evidence, commentText) {
  const marker = String(commentText || '').replace(/\r/g, '').match(
    /^<!-- agent-review-ledger: (.*) -->$/m,
  );
  if (!marker) throw new Error('report has no findings ledger');
  let ledger;
  try { ledger = JSON.parse(marker[1]); }
  catch { throw new Error('report findings ledger is invalid JSON'); }
  if (!Array.isArray(ledger)) throw new Error('report findings ledger must be an array');
  const present = new Set(ledger.map((entry) => entry.signature));
  const missing = (evidence.staticFindings || [])
    .map((finding) => finding.signature || signature(finding))
    .filter((value) => !present.has(value));
  if (missing.length) {
    throw new Error(`report omitted ${missing.length} deterministic static finding(s): ${missing.join(', ')}`);
  }
  return { required: (evidence.staticFindings || []).length, present: true };
}

module.exports = {
  AST_SEVERITY,
  addedLines,
  parseJsonOrStream,
  staticFindings,
  ciSummary,
  buildEvidence,
  verifyEvidenceLedger,
};
