'use strict';
const {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} = require('node:fs');
const { randomBytes } = require('node:crypto');
const { join, dirname } = require('node:path');
const YAML = require('yaml');
const { signature } = require('./findingSignature.cjs');
const { DISMISSAL_REASONS } = require('./evalSuite.cjs');
const { mineLearnings } = require('./mineLearnings.cjs');
const { filterFindings, rulesFromLearnings } = require('./applyLearnings.cjs');

function mergeProposals(existing, proposals) {
  const out = {
    version: 1,
    learnings: [...((existing && existing.learnings) || [])],
  };
  const ids = new Set(out.learnings.map((l) => l.id));
  for (const p of proposals) {
    if (!ids.has(p.id)) {
      out.learnings.push(p);
      ids.add(p.id);
    } // existing entries keep their status
  }
  return out;
}

function parsePending(yamlText) {
  const doc = YAML.parse(yamlText) || {};
  const out = [];
  for (const f of doc.findings || []) {
    if (f.outcome === 'accepted' || f.outcome === 'dismissed') {
      const dismissalReason = f.dismissal_reason || f.dismissalReason || f.reason_code;
      if (f.outcome === 'dismissed' && dismissalReason && !DISMISSAL_REASONS.has(dismissalReason)) {
        throw new Error(`invalid dismissal reason: ${dismissalReason}`);
      }
      out.push({
        reviewId: doc.reviewId,
        id: f.id,
        signature: f.signature,
        agent: f.agent,
        category: f.category,
        severity: f.severity,
        file: f.file,
        message: f.message,
        outcome: f.outcome,
        ...(dismissalReason
          ? { dismissalReason }
          : {}),
        ...(f.reason ? { dismissalDetail: String(f.reason) } : {}),
      });
    }
  }
  return out;
}

// Shapes raw findings into ids/signatures, writes <dir>/findings.json and
// <dir>/pending/<reviewId>.yml, and returns the shaped findings. Shared by
// learningsStore's own `--emit` CLI branch and cli.cjs's `emit` subcommand so
// the pending-file shape only has one place to change.
function emitFindings({ dir, reviewId, rawFindings }) {
  const findings = (rawFindings.findings || rawFindings).map((f, i) => ({
    ...f,
    // IDs and signatures are trusted engine state. Never let model/PR-authored
    // JSON override them and collide with a previously dismissed finding.
    id: `f${i + 1}`,
    signature: signature(f),
  }));
  mkdirSync(join(dir, 'pending'), { recursive: true });
  writeFileSync(
    join(dir, 'findings.json'),
    JSON.stringify({ reviewId, findings }, null, 2),
  );
  const pending = {
    reviewId,
    findings: findings.map((f) => ({
      id: f.id,
      signature: f.signature,
      agent: f.agent,
      category: f.category,
      severity: f.severity,
      file: f.file,
      message: f.message,
      outcome: '',
      dismissal_reason: '',
      reason: '',
    })),
  };
  writeFileSync(join(dir, 'pending', `${reviewId}.yml`), YAML.stringify(pending));
  return findings;
}

function loadApproved(learnings) {
  return ((learnings && learnings.learnings) || []).filter(
    (l) => l.status === 'approved',
  );
}

function loadLearnings(path) {
  return existsSync(path)
    ? YAML.parse(readFileSync(path, 'utf8')) || { version: 1, learnings: [] }
    : { version: 1, learnings: [] };
}
function saveLearnings(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(obj));
}
// Feedback lives in <learnings>/feedback/, one JSONL file per write, so two PRs
// that both record outcomes add two different files and never conflict. The
// old single feedback.jsonl is still read if a repo has one; nothing moves.
function feedbackDir(base) {
  return join(base, 'feedback');
}
// The old file first, then the folder's files in name order. A name starts
// with its reviewId and then the UTC time, so one review's writes stay in order.
function feedbackFiles(base) {
  const files = [];
  const legacy = join(base, 'feedback.jsonl');
  if (existsSync(legacy)) files.push(legacy);
  const dir = feedbackDir(base);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.jsonl')) files.push(join(dir, name));
    }
  }
  return files;
}
function loadFeedback(base) {
  const out = [];
  for (const file of feedbackFiles(base)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}
// 20261117T190312Z
function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
// Writes entries to a new file in the feedback folder and returns its path, or
// null when there is nothing to write. 'wx' never reuses an existing file.
function writeFeedbackBatch(base, reviewId, entries) {
  if (!entries.length) return null;
  const id = String(reviewId || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'feedback';
  const dir = feedbackDir(base);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${utcStamp()}-${randomBytes(3).toString('hex')}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e) + '\n').join(''), { flag: 'wx' });
  return path;
}

module.exports = {
  mergeProposals,
  parsePending,
  loadApproved,
  loadLearnings,
  saveLearnings,
  feedbackDir,
  feedbackFiles,
  loadFeedback,
  writeFeedbackBatch,
  emitFindings,
};

if (require.main === module) {
  const { parseArgs } = require('./args.cjs');
  const { reviewDir } = require('./paths.cjs');
  const a = parseArgs(process.argv.slice(2));
  const base =
    a['learning-dir'] ||
    join(reviewDir({ root: a.root, reviewDir: a['review-dir'] }), 'learnings');
  const learningsPath = join(base, 'learnings.yml');
  const findingsPath = join(base, 'findings.json');

  if (a.emit) {
    const raw = JSON.parse(readFileSync(a.in, 'utf8'));
    const reviewId = typeof a.review === 'string' ? a.review : 'review';
    const findings = emitFindings({ dir: base, reviewId, rawFindings: raw });
    process.stdout.write(
      `Emitted ${findings.length} findings; pending/${reviewId}.yml\n`,
    );
  } else if (a.ingest) {
    const pendingFile = typeof a.ingest === 'string' ? a.ingest : a.in;
    const entries = parsePending(readFileSync(pendingFile, 'utf8')).map(
      (e) => ({ ts: new Date().toISOString(), ...e }),
    );
    writeFeedbackBatch(base, entries.length && entries[0].reviewId, entries);
    process.stdout.write(`Ingested ${entries.length} outcomes\n`);
  } else if (a.mine) {
    const minSupport =
      typeof a['min-support'] === 'string' ? Number(a['min-support']) : 3;
    const proposals = mineLearnings(loadFeedback(base), { minSupport });
    const merged = mergeProposals(loadLearnings(learningsPath), proposals);
    saveLearnings(learningsPath, merged);
    process.stdout.write(
      `Mined ${proposals.length} proposals; ${merged.learnings.length} total\n`,
    );
  } else if (a.rules) {
    process.stdout.write(
      JSON.stringify(
        rulesFromLearnings(loadApproved(loadLearnings(learningsPath))),
        null,
        2,
      ) + '\n',
    );
  } else if (a.filter) {
    const raw = JSON.parse(
      readFileSync(typeof a.in === 'string' ? a.in : findingsPath, 'utf8'),
    );
    process.stdout.write(
      JSON.stringify(
        filterFindings(
          raw.findings || raw,
          loadApproved(loadLearnings(learningsPath)),
        ),
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(
      'usage: learningsStore.cjs [--emit --in <json> --review <id> | --ingest <pending.yml> | --mine [--min-support N] | --rules | --filter --in <json>]\n',
    );
  }
}
