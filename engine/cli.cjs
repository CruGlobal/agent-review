'use strict';
const { join, relative, dirname } = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
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
} = require('./learningsStore.cjs');
const { signature } = require('./findingSignature.cjs');
const { filterFindings, rulesFromLearnings } = require('./applyLearnings.cjs');
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
      const findings = (raw.findings || raw).map((f, i) => ({
        id: `f${i + 1}`,
        signature: signature(f),
        ...f,
      }));
      mkdirSync(join(base, 'pending'), { recursive: true });
      writeFileSync(
        join(base, 'findings.json'),
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
        })),
      };
      writeFileSync(
        join(base, 'pending', `${reviewId}.yml`),
        YAML.stringify(pending),
      );
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
      let minSupport = (cfg.learning && cfg.learning.min_support) || 3;
      const ms = flag(rest, '--min-support');
      if (ms !== undefined) {
        const n = Number(ms);
        if (!Number.isInteger(n) || n < 1) {
          out('error: --min-support must be a positive integer');
          return 1;
        }
        minSupport = n;
      }
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
      const planPath = join(
        os.tmpdir(),
        'agent-review-plan-' +
          createHash('sha1').update(C.ROOT).digest('hex').slice(0, 12) +
          '.json',
      );
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

module.exports = { main, ctx };
