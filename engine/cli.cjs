'use strict';
const { join, relative, dirname } = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  statSync,
} = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadConfig } = require('./loadConfig.cjs');
const { buildPlan, linesChangedFromStat } = require('./plan.cjs');
const {
  loadOrBuildIndex,
  gitHead,
  listRepoFiles,
} = require('./indexStore.cjs');
const { queryImpact } = require('./queryImpact.cjs');
const { mineLearnings } = require('./mineLearnings.cjs');
const {
  parsePending,
  appendFeedback,
  loadFeedback,
  loadLearnings,
  saveLearnings,
  mergeProposals,
  loadApproved,
  emitFindings,
} = require('./learningsStore.cjs');
const { filterFindings, rulesFromLearnings } = require('./applyLearnings.cjs');
const { mergeLedger, buildStatus } = require('./reportState.cjs');
const {
  MAX_RESULT_BYTES,
  prepareAddressRequest,
  validateAddressResult,
  feedbackForAddress,
  finalizeAddress,
} = require('./addressState.cjs');
const {
  readData,
  validateSuite,
  loadResultRuns,
  scoreSuite,
  compareEvaluation,
  materializeCase,
} = require('./evalSuite.cjs');
const { buildEvidence, verifyEvidenceLedger } = require('./evidence.cjs');
const { validateContextManifest, contextInventory, packContext } = require('./contextPack.cjs');
const { readTelemetry, summarizeTelemetry, rolloutReadiness } = require('./telemetry.cjs');
const {
  setLearningStatus,
  listLearnings,
  preflightSummary,
} = require('./cliCommands.cjs');

const { repoRoot, reviewDir } = require('./paths.cjs');

function out(s) {
  process.stdout.write(s + '\n');
}

// Returns the value after `name`, or undefined if absent or the next token is itself a flag.
function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

// Global flags (parsed before dispatch): --root, --review-dir.
function ctx(argv) {
  const opts = { root: flag(argv, '--root'), reviewDir: flag(argv, '--review-dir') };
  const ROOT = repoRoot(opts);
  const RD = reviewDir({ ...opts, root: ROOT });
  return {
    ROOT,
    RD,
    // Relative form of RD under ROOT — used to suppress self-matches on the reviewer's own
    // config when scanning diff content (see selectAgents.codeDiff's reviewDirRel param).
    reviewDirRel: relative(ROOT, RD),
    CONFIG: join(RD, 'config.yml'),
    SCHEMA: join(__dirname, '../schema/config.schema.json'),
    INDEX: join(RD, 'index'),
  };
}
const MODES = ['quick', 'standard', 'deep'];

// learning paths come from config (learning.path, default '.claude/review/learnings')
function learningPaths(cfg, C) {
  const lp = (cfg.learning && cfg.learning.path) || null;
  const base = lp ? (require('node:path').isAbsolute(lp) ? lp : join(C.ROOT, lp)) : join(C.RD, 'learnings');
  return { FEEDBACK: join(base, 'feedback.jsonl'), LEARNINGS: join(base, 'learnings.yml') };
}

function validRef(ref) {
  return /^[A-Za-z0-9._/~^-]+$/.test(ref) && !ref.startsWith('-');
}

function changedFiles(base, C, cfg) {
  let b = base;
  if (b && !validRef(b)) throw new Error(`invalid --base ref: "${b}"`);
  if (!b) {
    b = (cfg && cfg.base_branch) || 'main';
    // config-supplied refs get the same validation as --base: they reach git argv too.
    if (!validRef(b)) throw new Error(`invalid --base ref: "${b}"`);
  }
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['-C', C.ROOT, 'diff', '--name-only', `${b}...HEAD`],
      { encoding: 'utf8' },
    );
  } catch (e) {
    if (base) {
      throw new Error(
        `could not determine a diff base (tried "${b}"). Pass --base <ref>. [${e.message.split('\n')[0]}]`,
      );
    }
    // Default base wasn't resolvable (e.g. no "main" branch locally) — fall back to HEAD~1.
    try {
      b = 'HEAD~1';
      raw = execFileSync(
        'git',
        ['-C', C.ROOT, 'diff', '--name-only', `${b}...HEAD`],
        { encoding: 'utf8' },
      );
    } catch (e2) {
      throw new Error(
        `could not determine a diff base (tried default base and "HEAD~1"). Pass --base <ref>. [${e2.message.split('\n')[0]}]`,
      );
    }
  }
  return {
    base: b,
    files: raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// Resolves `learn`'s --min-support: explicit flag wins, else cfg.learning.min_support, else 3.
function resolveMinSupport(cfg, explicit) {
  if (explicit === undefined) {
    return { minSupport: (cfg.learning && cfg.learning.min_support) || 3 };
  }
  const n = Number(explicit);
  if (!Number.isInteger(n) || n < 1) {
    return { error: '--min-support must be a positive integer' };
  }
  return { minSupport: n };
}

// Namespaces `run`'s tmp plan file per-repo so concurrent runs against different repos
// (or repeated runs against the same one) don't collide/clobber each other.
function planTmpPath(root) {
  return join(
    os.tmpdir(),
    'agent-review-plan-' +
      createHash('sha1').update(root).digest('hex').slice(0, 12) +
      '.json',
  );
}

function indexOpts(cfg) {
  const ix = (cfg && cfg.index) || {};
  return { aliases: ix.aliases, exts: ix.extensions, roots: ix.roots };
}

function loadIndex(C, cfg, { force } = {}) {
  const c = cfg || loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
  const indexPath =
    c.index && c.index.path ? join(C.ROOT, c.index.path) : C.INDEX;
  if (force) {
    const gf = join(indexPath, 'graph.json');
    if (existsSync(gf)) rmSync(gf);
  }
  const opts = indexOpts(c);
  return loadOrBuildIndex({
    repoRoot: C.ROOT,
    indexPath,
    head: gitHead(C.ROOT),
    files: listRepoFiles(C.ROOT, opts),
    opts,
  });
}

const USAGE = `usage: agent-review <command>
  config show|validate|get <k>   show / validate / read a config value
  index                          rebuild the import-graph cache
  impact [--base <ref>]          cross-file blast radius for the current diff
  plan --files <f> --diff <f> --stat <f> [--scope <s>]   compute a review plan (JSON)
  emit --in <findings.json> --review <id>   emit findings + a pending outcomes file
  filter --in <findings.json>    drop findings suppressed by approved learnings
  address prepare|validate|feedback|finalize   trusted fix/dismiss handoff tools
  ledger --findings <f> [--previous <f>]   merge stable incremental finding state
  status --ledger <f> --plan <f> --safety <f> [--head <sha>] [--evidence <f>]   compute approval status
  evidence [--diff <f>] [--ast-grep <f>] [--ci <f>]   normalize deterministic review evidence
  context validate|inventory|pack --manifest <f> [--dir <d>]   validate/inventory/package SHA-pinned context
  eval validate --suite <f> | score --suite <f> --results <f>   seeded-bug evaluation tools
  eval prepare --suite <f> --case <id> --repo <d> --out <d>   create a seeded disposable worktree
  telemetry --in <feedback.jsonl>   summarize review dispositions and dismissal reasons
  rollout --eval <summary.json> --telemetry <summary.json>   check every-PR readiness gates
  rules                          list rules synthesized from approved learnings
  feedback <pendingFile>         ingest marked outcomes
  learn [--min-support N]        mine feedback into proposed learnings
  learnings [--status S]         list learnings
  approve <id> | reject <id>     set a learning's status
  run [--base <ref>] [--scope <s>] [mode]   pre-flight + launch the Claude Code review
  help`;

// Strips global `--root <v>` / `--review-dir <v>` tokens so subcommand parsing never sees them.
function stripGlobalFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--root' || tok === '--review-dir') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) i++;
      continue;
    }
    out.push(tok);
  }
  return out;
}

function main(rawArgv) {
  const C = ctx(rawArgv);
  const argv = stripGlobalFlags(rawArgv);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'config': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      if (rest[0] === 'validate') {
        out('config OK');
        return 0;
      }
      if (rest[0] === 'get') {
        if (!rest[1]) {
          out('usage: agent-review config get <dot.path>');
          return 1;
        }
        const val = rest[1]
          .split('.')
          .reduce((o, k) => (o == null ? undefined : o[k]), cfg);
        out(
          val !== null && typeof val === 'object'
            ? JSON.stringify(val)
            : String(val),
        );
        return 0;
      }
      out(JSON.stringify(cfg, null, 2));
      return 0;
    }
    case 'index': {
      const g = loadIndex(C, undefined, { force: rest.includes('--force') });
      out(
        `Indexed ${g.fileCount} files; ${Object.keys(g.importedBy).length} have dependents.`,
      );
      return 0;
    }
    case 'impact': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { files } = changedFiles(flag(rest, '--base'), C, cfg);
      out(JSON.stringify(queryImpact(files, loadIndex(C, cfg), {}), null, 2));
      return 0;
    }
    case 'plan': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const filesPath = flag(rest, '--files');
      const diffPath = flag(rest, '--diff');
      const statPath = flag(rest, '--stat');
      const scope = flag(rest, '--scope') || 'single_feature';
      const files = readFileSync(filesPath, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const diffText = diffPath ? readFileSync(diffPath, 'utf8') : '';
      const linesChanged = statPath
        ? linesChangedFromStat(readFileSync(statPath, 'utf8'))
        : 0;
      const plan = buildPlan(
        { files, diffText, linesChanged, scope, reviewDirRel: C.reviewDirRel },
        cfg,
      );
      out(JSON.stringify(plan, null, 2));
      return 0;
    }
    case 'emit': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { FEEDBACK } = learningPaths(cfg, C);
      const base = dirname(FEEDBACK);
      const reviewId = flag(rest, '--review') || 'review';
      const raw = JSON.parse(readFileSync(flag(rest, '--in'), 'utf8'));
      const findings = emitFindings({ dir: base, reviewId, rawFindings: raw });
      out(`Emitted ${findings.length} findings; pending/${reviewId}.yml`);
      return 0;
    }
    case 'filter': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { FEEDBACK, LEARNINGS } = learningPaths(cfg, C);
      const base = dirname(FEEDBACK);
      const inPath = flag(rest, '--in') || join(base, 'findings.json');
      const raw = JSON.parse(readFileSync(inPath, 'utf8'));
      out(
        JSON.stringify(
          filterFindings(
            raw.findings || raw,
            loadApproved(loadLearnings(LEARNINGS)),
          ),
          null,
          2,
        ),
      );
      return 0;
    }
    case 'address': {
      const sub = rest[0];
      if (sub === 'prepare') {
        const commandPath = flag(rest, '--command');
        const reportPath = flag(rest, '--report');
        const actor = flag(rest, '--actor');
        const pr = flag(rest, '--pr');
        const commentId = flag(rest, '--comment-id');
        const reportCommentId = flag(rest, '--report-comment-id');
        const expectedHead = flag(rest, '--head');
        if (!commandPath || !reportPath || !actor || !pr || !commentId || !reportCommentId || !expectedHead) {
          out('usage: agent-review address prepare --command <f> --report <f> --actor <u> --pr <n> --comment-id <n> --report-comment-id <n> --head <sha>');
          return 1;
        }
        out(JSON.stringify(prepareAddressRequest({
          command: readFileSync(commandPath, 'utf8'),
          report: readFileSync(reportPath, 'utf8'),
          actor,
          pr: Number(pr),
          commentId: Number(commentId),
          reportCommentId: Number(reportCommentId),
          expectedHead,
        }), null, 2));
        return 0;
      }
      if (sub === 'validate') {
        const requestPath = flag(rest, '--request');
        const resultPath = flag(rest, '--result');
        const changedFilesPath = flag(rest, '--changed-files');
        const patchPath = flag(rest, '--patch');
        if (!requestPath || !resultPath || !changedFilesPath || !patchPath) {
          out('usage: agent-review address validate --request <f> --result <f> --changed-files <f> --patch <f>');
          return 1;
        }
        if (statSync(resultPath).size > MAX_RESULT_BYTES) {
          throw new Error(`address result exceeds ${MAX_RESULT_BYTES} bytes`);
        }
        out(JSON.stringify(validateAddressResult({
          request: JSON.parse(readFileSync(requestPath, 'utf8')),
          result: JSON.parse(readFileSync(resultPath, 'utf8')),
          changedFiles: JSON.parse(readFileSync(changedFilesPath, 'utf8')),
          patchBytes: statSync(patchPath).size,
        }), null, 2));
        return 0;
      }
      if (sub === 'feedback') {
        const requestPath = flag(rest, '--request');
        const resultPath = flag(rest, '--result');
        if (!requestPath || !resultPath) {
          out('usage: agent-review address feedback --request <f> --result <f>');
          return 1;
        }
        const entries = feedbackForAddress(
          JSON.parse(readFileSync(requestPath, 'utf8')),
          JSON.parse(readFileSync(resultPath, 'utf8')),
        );
        process.stdout.write(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
        return 0;
      }
      if (sub === 'finalize') {
        const requestPath = flag(rest, '--request');
        const resultPath = flag(rest, '--result');
        const reportPath = flag(rest, '--report');
        const outDir = flag(rest, '--out-dir');
        if (!requestPath || !resultPath || !reportPath || !outDir) {
          out('usage: agent-review address finalize --request <f> --result <f> --report <f> --out-dir <d> [--fix-sha <sha>]');
          return 1;
        }
        const finalized = finalizeAddress({
          request: JSON.parse(readFileSync(requestPath, 'utf8')),
          result: JSON.parse(readFileSync(resultPath, 'utf8')),
          report: readFileSync(reportPath, 'utf8'),
          fixSha: flag(rest, '--fix-sha') || '',
        });
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'report.md'), finalized.report);
        writeFileSync(join(outDir, 'summary.md'), finalized.summary + '\n');
        writeFileSync(join(outDir, 'ledger.json'), JSON.stringify(finalized.ledger, null, 2) + '\n');
        writeFileSync(join(outDir, 'status.json'), JSON.stringify(finalized.status, null, 2) + '\n');
        out(JSON.stringify({
          appliedFixes: finalized.appliedFixes,
          dismissed: finalized.dismissed,
          pass: finalized.status.pass,
          openBlockers: finalized.status.openBlockers,
        }));
        return 0;
      }
      out('usage: agent-review address prepare|validate|feedback|finalize');
      return 1;
    }
    case 'ledger': {
      const findingsPath = flag(rest, '--findings');
      if (!findingsPath) {
        out('usage: agent-review ledger --findings <file> [--previous <file>]');
        return 1;
      }
      const previousPath = flag(rest, '--previous');
      const previous = previousPath
        ? JSON.parse(readFileSync(previousPath, 'utf8'))
        : [];
      const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
      out(JSON.stringify(mergeLedger(previous, findings), null, 2));
      return 0;
    }
    case 'status': {
      const ledgerPath = flag(rest, '--ledger');
      const planPath = flag(rest, '--plan');
      const safetyPath = flag(rest, '--safety');
      if (!ledgerPath || !planPath || !safetyPath) {
        out('usage: agent-review status --ledger <f> --plan <f> --safety <f> [--head <sha>]');
        return 1;
      }
      out(
        JSON.stringify(
          buildStatus({
            ledger: JSON.parse(readFileSync(ledgerPath, 'utf8')),
            plan: JSON.parse(readFileSync(planPath, 'utf8')),
            safety: JSON.parse(readFileSync(safetyPath, 'utf8')),
            head: flag(rest, '--head'),
            evidence: flag(rest, '--evidence')
              ? JSON.parse(readFileSync(flag(rest, '--evidence'), 'utf8'))
              : null,
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    case 'evidence': {
      const verifyComment = flag(rest, '--verify-comment');
      const evidencePath = flag(rest, '--evidence');
      if (verifyComment || evidencePath) {
        if (!verifyComment || !evidencePath) {
          out('usage: agent-review evidence --verify-comment <f> --evidence <f>');
          return 1;
        }
        out(JSON.stringify(verifyEvidenceLedger(
          JSON.parse(readFileSync(evidencePath, 'utf8')),
          readFileSync(verifyComment, 'utf8'),
        ), null, 2));
        return 0;
      }
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const astConfig = cfg.static_analysis && cfg.static_analysis.ast_grep || {};
      const result = buildEvidence({
        diffPath: flag(rest, '--diff'),
        astGrepPath: flag(rest, '--ast-grep'),
        ciPath: flag(rest, '--ci'),
        staticConfig: {
          ...astConfig,
          excluded_paths: [...(cfg.excluded_paths || []), ...(astConfig.excluded_paths || [])],
        },
        ciConfig: cfg.ci || {},
      });
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'context': {
      const action = rest[0];
      const manifestPath = flag(rest, '--manifest');
      if (!manifestPath || !['validate', 'inventory', 'pack'].includes(action)) {
        out('usage: agent-review context validate|inventory|pack --manifest <f> [--dir <d>]');
        return 1;
      }
      const manifest = validateContextManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      if (action === 'validate') out(`context OK (${manifest.repositories.length} repositories)`);
      else if (action === 'inventory') {
        const dir = flag(rest, '--dir');
        if (!dir) {
          out('usage: agent-review context inventory --manifest <f> --dir <d>');
          return 1;
        }
        out(JSON.stringify(contextInventory(manifest, dir), null, 2));
      } else {
        const source = flag(rest, '--source');
        const dir = flag(rest, '--dir');
        if (!source || !dir) {
          out('usage: agent-review context pack --manifest <f> --source <d> --dir <d>');
          return 1;
        }
        out(JSON.stringify(packContext(manifest, source, dir), null, 2));
      }
      return 0;
    }
    case 'eval': {
      const action = rest[0];
      const suitePath = flag(rest, '--suite');
      if (!suitePath || !['validate', 'score', 'prepare'].includes(action)) {
        out('usage: agent-review eval validate|score|prepare --suite <f> [...]');
        return 1;
      }
      const suite = validateSuite(readData(suitePath), { suitePath });
      if (action === 'validate') {
        out(`eval suite OK (${suite.cases.length} cases)`);
        return 0;
      }
      if (action === 'prepare') {
        const caseId = flag(rest, '--case');
        const repo = flag(rest, '--repo');
        const target = flag(rest, '--out');
        if (!caseId || !repo || !target) {
          out('usage: agent-review eval prepare --suite <f> --case <id> --repo <d> --out <d> [--base <ref>]');
          return 1;
        }
        out(JSON.stringify(materializeCase({
          suite, suitePath, caseId, repo, out: target, base: flag(rest, '--base') || 'HEAD',
        }), null, 2));
        return 0;
      }
      const resultsPath = flag(rest, '--results');
      if (!resultsPath) {
        out('usage: agent-review eval score --suite <f> --results <file-or-dir> [--baseline <f>] [--fail-on-gate]');
        return 1;
      }
      const summary = scoreSuite(suite, loadResultRuns(resultsPath));
      const baselinePath = flag(rest, '--baseline');
      if (baselinePath) summary.comparison = compareEvaluation(summary, readData(baselinePath));
      out(JSON.stringify(summary, null, 2));
      return rest.includes('--fail-on-gate') && !summary.gate.pass ? 2 : 0;
    }
    case 'telemetry': {
      const path = flag(rest, '--in');
      if (!path) {
        out('usage: agent-review telemetry --in <feedback.jsonl>');
        return 1;
      }
      out(JSON.stringify(summarizeTelemetry(readTelemetry(path)), null, 2));
      return 0;
    }
    case 'rollout': {
      const evalPath = flag(rest, '--eval');
      const telemetryPath = flag(rest, '--telemetry');
      if (!evalPath || !telemetryPath) {
        out('usage: agent-review rollout --eval <summary.json> --telemetry <summary.json>');
        return 1;
      }
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const readiness = rolloutReadiness({
        evaluation: readData(evalPath),
        telemetry: readData(telemetryPath),
        rollout: cfg.rollout || {},
      });
      out(JSON.stringify(readiness, null, 2));
      return rest.includes('--fail-on-gate') && !readiness.readyForEveryPr ? 2 : 0;
    }
    case 'rules': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { LEARNINGS } = learningPaths(cfg, C);
      out(
        JSON.stringify(
          rulesFromLearnings(loadApproved(loadLearnings(LEARNINGS))),
          null,
          2,
        ),
      );
      return 0;
    }
    case 'feedback': {
      if (!rest[0]) {
        out('usage: agent-review feedback <pendingFile>');
        return 1;
      }
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { FEEDBACK } = learningPaths(cfg, C);
      const entries = parsePending(readFileSync(rest[0], 'utf8')).map((e) => ({
        ts: new Date().toISOString(),
        ...e,
      }));
      appendFeedback(FEEDBACK, entries);
      out(`Ingested ${entries.length} outcomes`);
      return 0;
    }
    case 'learn': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const resolved = resolveMinSupport(cfg, flag(rest, '--min-support'));
      if (resolved.error) {
        out(`error: ${resolved.error}`);
        return 1;
      }
      const { minSupport } = resolved;
      const { FEEDBACK, LEARNINGS } = learningPaths(cfg, C);
      const proposals = mineLearnings(loadFeedback(FEEDBACK), { minSupport });
      const merged = mergeProposals(loadLearnings(LEARNINGS), proposals);
      saveLearnings(LEARNINGS, merged);
      out(
        `Mined ${proposals.length} proposals; ${merged.learnings.length} total`,
      );
      return 0;
    }
    case 'learnings': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { LEARNINGS } = learningPaths(cfg, C);
      out(
        JSON.stringify(
          listLearnings(loadLearnings(LEARNINGS), flag(rest, '--status')),
          null,
          2,
        ),
      );
      return 0;
    }
    case 'approve':
    case 'reject': {
      if (!rest[0]) {
        out(`usage: agent-review ${cmd} <id>`);
        return 1;
      }
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { LEARNINGS } = learningPaths(cfg, C);
      const status = cmd === 'approve' ? 'approved' : 'rejected';
      saveLearnings(
        LEARNINGS,
        setLearningStatus(loadLearnings(LEARNINGS), rest[0], status),
      );
      out(`${rest[0]} -> ${status}`);
      return 0;
    }
    case 'run': {
      const base = flag(rest, '--base');
      const scope = flag(rest, '--scope') || 'single_feature';
      const mode =
        rest.find((a) => !a.startsWith('--') && a !== base && a !== scope) ||
        'standard';
      if (!MODES.includes(mode)) {
        out(`error: unknown mode "${mode}" (use ${MODES.join('/')})`);
        return 1;
      }
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const { base: b, files } = changedFiles(base, C, cfg);
      const diff = execFileSync('git', ['-C', C.ROOT, 'diff', `${b}...HEAD`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const stat = execFileSync(
        'git',
        ['-C', C.ROOT, 'diff', '--stat', `${b}...HEAD`],
        { encoding: 'utf8' },
      );
      const plan = buildPlan(
        {
          files,
          diffText: diff,
          linesChanged: linesChangedFromStat(stat),
          scope,
          reviewDirRel: C.reviewDirRel,
        },
        cfg,
      );
      const impact =
        cfg.index && cfg.index.enabled
          ? queryImpact(files, loadIndex(C, cfg), {})
          : null;
      out(preflightSummary(plan, impact));
      const planPath = planTmpPath(C.ROOT);
      writeFileSync(planPath, JSON.stringify({ ...plan, impact }, null, 2));
      out(planPath);
      if (rest.includes('--no-launch')) {
        out(`\nwould run: claude -p "/agent-review:review ${mode}"`);
        return 0;
      }
      out(`\nlaunching: claude -p "/agent-review:review ${mode}" ...\n`);
      try {
        execFileSync('claude', ['-p', `/agent-review:review ${mode}`], {
          stdio: 'inherit',
        });
      } catch (e) {
        out(`(could not launch claude automatically: ${e.message})`);
        out(`Run it manually in Claude Code:  /agent-review:review ${mode}`);
      }
      return 0;
    }
    case 'help':
    case undefined:
      out(USAGE);
      return 0;
    default:
      out(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  ctx,
  changedFiles,
  resolveMinSupport,
  planTmpPath,
};
