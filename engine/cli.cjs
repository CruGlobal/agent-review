'use strict';
const { join, relative, dirname, resolve, isAbsolute } = require('node:path');
const { execFileSync } = require('node:child_process');
const { MODES, FINAL_MODES, ENGINE_CODE_REVIEW, EFFORTS } = require('./vocabulary.cjs');
const {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  statSync,
  renameSync,
  lstatSync,
  openSync,
  closeSync,
  constants: fsConstants,
} = require('node:fs');
const nodeFs = require('node:fs');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { loadConfig } = require('./loadConfig.cjs');
const { resolveOptions, codeReviewEngineProblems } = require('./options.cjs');
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
const { evaluateApproval } = require('./approval.cjs');
const {
  CAPTURE_LIMIT_MINUTES,
  checkCodeReviewRun,
  looksFinished,
} = require('./codeReviewProof.cjs');
const {
  MAX_RESULT_BYTES,
  prepareAddressRequest,
  validateAddressResult,
  feedbackForAddress,
  finalizeAddress,
  parseCommand,
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
const { consensusFrom } = require('./consensus.cjs');
const { sliceForAgent } = require('./slice.cjs');
const { validateContextManifest, contextInventory, packContext } = require('./contextPack.cjs');
const { readTelemetry, summarizeTelemetry, rolloutReadiness } = require('./telemetry.cjs');
const {
  setLearningStatus,
  listLearnings,
  preflightSummary,
  formatStartup,
} = require('./cliCommands.cjs');
const {
  CAPTURE_FILES,
  STOP_BUFFER_LINES,
  CAPTURE_SOURCE,
  captureDir,
  captureDirProblem,
  armedState,
  lastAssistantText,
  postSkillWrites,
  subagentStopWrites,
} = require('./captureHook.cjs');

const { repoRoot, reviewDir } = require('./paths.cjs');

// process.stdout is asynchronous on a macOS pipe and the CLI exits right after main() returns,
// so output must be written synchronously or it is cut short at the pipe buffer. Tests capture
// it by stubbing nodeFs.writeSync, so call it through the module object.
function writeStdoutSync(text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += nodeFs.writeSync(1, buf, offset);
    } catch (e) {
      if (e.code === 'EPIPE') return;
      if (e.code !== 'EAGAIN') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

function out(s) {
  writeStdoutSync(s + '\n');
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
const CI_REVIEW_WORKFLOWS = ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml'];

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

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function captureDirError(dir) {
  let stat = null;
  try {
    stat = lstatSync(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') return `capture dir ${dir} cannot be checked: ${e.message}`;
  }
  const problem = captureDirProblem(stat, process.getuid());
  return problem ? `capture dir ${dir} ${problem}` : null;
}

function writeFileAtomic(path, text) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonOrNull(path) {
  try {
    return parseJsonOrNull(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readStops(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.trim()).map(parseJsonOrNull).filter(Boolean);
}

function readTranscript(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl')) return null;
  try {
    return lastAssistantText(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function appendStop(path, stop) {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fsConstants;
  const fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(stop) + '\n');
  } finally {
    closeSync(fd);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length > STOP_BUFFER_LINES) {
    writeFileAtomic(path, lines.slice(-STOP_BUFFER_LINES).join('\n') + '\n');
  }
}

// Hooks run in every session that has the plugin installed, so this never prints, never throws,
// and returns before reading stdin unless capture is armed.
function runHook(name) {
  try {
    const dir = captureDir();
    if (captureDirError(dir)) return 0;
    const file = (key) => join(dir, CAPTURE_FILES[key]);
    const arm = readJsonOrNull(file('arm'));
    const now = nowSeconds();
    if (!armedState(arm, now)) return 0;
    const base = { payload: JSON.parse(readFileSync(0, 'utf8')), arm, now, readTranscript };
    // Each hook writes its own record before it reads the other's, so when a fork's stop races
    // post-skill, at least one of the two hooks sees both records and writes the capture.
    if (name === 'post-skill') {
      const first = postSkillWrites({ ...base, stops: [] });
      if (first.mismatch) writeFileAtomic(file('mismatch'), JSON.stringify(first.mismatch));
      if (first.pending) writeFileAtomic(file('pending'), JSON.stringify(first.pending));
      if (!first.pending && !first.capture) return 0;
      const { capture } = postSkillWrites({ ...base, stops: readStops(file('stops')) });
      if (capture) writeFileAtomic(file('capture'), JSON.stringify(capture));
    } else if (name === 'subagent-stop') {
      const { stop } = subagentStopWrites({ ...base, pending: null, capture: null });
      if (!stop) return 0;
      appendStop(file('stops'), stop);
      const pending = readJsonOrNull(file('pending'));
      if (!pending) return 0;
      const { capture } = subagentStopWrites({
        ...base,
        pending,
        capture: readJsonOrNull(file('capture')),
      });
      if (capture) writeFileAtomic(file('capture'), JSON.stringify(capture));
    }
  } catch {
    return 0;
  }
  return 0;
}

const CAPTURE_WAIT_USAGE = `usage: agent-review capture-wait --run <id> --effort <${EFFORTS.join('|')}> [--timeout <seconds>]`;
const CAPTURE_WAIT_EXIT = { finished: 0, waiting: 3, failed: 1 };
// The Bash tool stops a command at 10 minutes, so one call must return before that.
const CAPTURE_WAIT_MAX_SECONDS = 590;

function captureWaitTimeout(value) {
  if (value === undefined) return 540;
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  return Math.min(Number(value), CAPTURE_WAIT_MAX_SECONDS);
}

function capturePollMs(env = process.env) {
  const ms = Number(env.AGENT_REVIEW_CAPTURE_POLL_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : 5000;
}

// main() is synchronous, so the wait blocks the thread with Atomics.wait instead of a timer.
function captureWait({ runId, effort, timeoutSeconds }) {
  const dir = captureDir();
  const file = (key) => join(dir, CAPTURE_FILES[key]);
  const limitMinutes = CAPTURE_LIMIT_MINUTES[effort];
  const pollMs = capturePollMs();
  const deadline = Date.now() + timeoutSeconds * 1000;
  const report = (status, reason, capture = null) => {
    out(JSON.stringify({
      status,
      reason,
      stop_count: capture ? (capture.stop_count ?? null) : null,
      mode: capture ? (capture.mode ?? null) : null,
    }));
    return CAPTURE_WAIT_EXIT[status];
  };
  for (;;) {
    const dirError = captureDirError(dir);
    if (dirError) return report('failed', dirError);
    const arm = readJsonOrNull(file('arm'));
    const armed = armedState(arm, nowSeconds());
    if (!armed) return report('failed', `/code-review capture is not armed for run ${runId}`);
    if (armed.run_id !== runId) {
      return report('failed', `/code-review capture is armed for run ${armed.run_id}, not run ${runId}`);
    }
    const armedEffort = armed.args.trim().split(/\s+/)[0];
    if (armedEffort !== effort) {
      return report(
        'failed',
        `capture-wait --effort ${effort} does not match the armed args ${JSON.stringify(armed.args)}, whose effort is ${JSON.stringify(armedEffort)}`,
      );
    }
    const found = readJsonOrNull(file('capture'));
    const capture = found?.source === CAPTURE_SOURCE && found.run_id === runId ? found : null;
    if (capture && looksFinished(capture.result, effort)) {
      return report('finished', `the /code-review capture for run ${runId} looks finished`, capture);
    }
    const mismatch = readJsonOrNull(file('mismatch'));
    if (mismatch?.run_id === runId) {
      return report(
        'failed',
        `/code-review was called with args ${JSON.stringify(mismatch.got)}, but capture was armed for ` +
          `${JSON.stringify(mismatch.expected)}; the run must be re-armed with capture arm before /code-review is called again`,
        capture,
      );
    }
    const now = Date.now();
    const limitAt = (armed.created + limitMinutes * 60) * 1000;
    if (now >= limitAt) {
      return report(
        'failed',
        `/code-review did not finish within the ${limitMinutes}-minute limit for effort ${effort}`,
        capture,
      );
    }
    if (now >= deadline) {
      const left = Math.ceil((limitAt - now) / 60000);
      return report(
        'waiting',
        `no finished /code-review capture for run ${runId} yet; about ${left} of the ${limitMinutes} minutes are left, so run capture-wait again`,
        capture,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, deadline - now, limitAt - now));
  }
}

const CODE_REVIEW_PROOF_USAGE =
  'usage: agent-review code-review-proof --raw <f> --findings <f> --dropped <f> --run <id> [--capture <f>]';

const USAGE = `usage: agent-review <command>
  config show|validate|get <k>   show / validate / read a config value
  index                          rebuild the import-graph cache
  impact [--base <ref>]          cross-file blast radius for the current diff
  plan --files <f> --diff <f> --stat <f> [--scope <s>] [--mode <auto|quick|standard|deep>] [--options <f>]   compute a review plan (JSON)
  options --args "<raw>" [--ci]   resolve review mode, engine, and effort from arguments and config (JSON)
  startup --options <f> --plan <f> [--slices <f>] [--scope <label>] [--mode <skip|quick|standard|deep>]   print the one-line engine, effort, and reviewers summary (--mode is the final mode after auto resolution)
  consensus --plan <f> --dir <d> [--profile <p>] [--decisions <f>]   deterministic cross-agent finding consensus
  slice --plan <f> --diff <f> --out-dir <d>   write per-agent diff slices from path/content triggers (JSON manifest)
  emit --in <findings.json> --review <id>   emit findings + a pending outcomes file
  filter --in <findings.json>    drop findings suppressed by approved learnings
  address parse|prepare|validate|feedback|finalize   trusted fix/dismiss handoff tools (parse: lenient local grammar)
  ledger --findings <f> [--previous <f>] [--match-suggestions-by-location]   merge stable incremental finding state (the flag matches suggestions to older open or dismissed entries from the same lane by file, category, nearby line, and similar wording)
  status --ledger <f> --plan <f> --safety <f> [--head <sha>] [--evidence <f>]   compute approval status
  approval --report <f> --head <sha>   decide whether a published report authorizes approving its PR
  code-review-proof --raw <f> --findings <f> --dropped <f> --run <id> [--capture <f>]   prove the lane's raw findings match the captured /code-review result and that each is scored or dropped once (JSON; exit 1 if not)
  capture arm --run <id> --args "<args>"   turn on /code-review result capture for one review run: delete old capture files and write the arm file
  capture disarm                 turn off /code-review result capture: delete the arm file
  capture show --run <id>        print the captured /code-review result for that run exactly, with no added newline (exit 1 if there is none)
  capture-wait --run <id> --effort <${EFFORTS.join('|')}> [--timeout <seconds>]   wait up to --timeout (default 540, at most 590) for that run's capture to look finished; --effort must be the armed args' first word; print one JSON line {status, reason, stop_count, mode}; exit 0 finished, 3 not yet (run it again), 1 failed (args mismatch, not armed, another effort, or the effort's time limit passed)
  hook post-skill|subagent-stop   plugin hook entry: read the hook payload on stdin and save /code-review's result while capture is armed (always exits 0, prints nothing)
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
  // Before ctx(): process.cwd() throws when the session's cwd was removed, and a hook must never fail.
  if (rawArgv[0] === 'hook') return runHook(rawArgv[1]);
  const C = ctx(rawArgv);
  const argv = stripGlobalFlags(rawArgv);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'config': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      if (rest[0] === 'validate') {
        const engineName = cfg.engine && cfg.engine.name;
        const problems = engineName === ENGINE_CODE_REVIEW ? codeReviewEngineProblems(cfg) : [];
        if (problems.length) {
          out(`Invalid review config (${C.CONFIG}):\n- ${problems.join('\n- ')}`);
          return 1;
        }
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
    case 'options': {
      try {
        const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
        const resolved = resolveOptions({
          args: flag(rest, '--args') || '',
          config: cfg,
          ci: rest.includes('--ci'),
        });
        out(JSON.stringify(resolved, null, 2));
        return 0;
      } catch (e) {
        out(`error: ${e.message}`);
        return 1;
      }
    }
    case 'startup': {
      try {
        const mode = flag(rest, '--mode');
        if (mode !== undefined && !FINAL_MODES.includes(mode)) {
          out(`error: unknown final mode "${mode}" (use ${FINAL_MODES.join('/')})`);
          return 1;
        }
        const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
        const slicesPath = flag(rest, '--slices');
        out(
          formatStartup({
            options: JSON.parse(readFileSync(flag(rest, '--options'), 'utf8')),
            plan: JSON.parse(readFileSync(flag(rest, '--plan'), 'utf8')),
            sliceManifest: slicesPath
              ? JSON.parse(readFileSync(slicesPath, 'utf8'))
              : {},
            configAgents: cfg.agents || [],
            scopeLabel: flag(rest, '--scope'),
            ciFilesPresent: CI_REVIEW_WORKFLOWS.some((name) =>
              existsSync(join(C.ROOT, '.github/workflows', name)),
            ),
            mode,
          }),
        );
        return 0;
      } catch (e) {
        out(`error: ${e.message}`);
        return 1;
      }
    }
    case 'plan': {
      const cfg = loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA });
      const filesPath = flag(rest, '--files');
      const diffPath = flag(rest, '--diff');
      const statPath = flag(rest, '--stat');
      const scope = flag(rest, '--scope') || 'single_feature';
      const mode = flag(rest, '--mode') || 'standard';
      if (!MODES.includes(mode)) {
        out(`error: unknown mode "${mode}" (use ${MODES.join('/')})`);
        return 1;
      }
      const files = readFileSync(filesPath, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const diffText = diffPath ? readFileSync(diffPath, 'utf8') : '';
      const linesChanged = statPath
        ? linesChangedFromStat(readFileSync(statPath, 'utf8'))
        : 0;
      const optionsPath = flag(rest, '--options');
      const options = optionsPath
        ? JSON.parse(readFileSync(optionsPath, 'utf8'))
        : undefined;
      const plan = buildPlan(
        { files, diffText, linesChanged, scope, reviewDirRel: C.reviewDirRel, mode, options },
        cfg,
      );
      out(JSON.stringify(plan, null, 2));
      return 0;
    }
    case 'consensus': {
      const planPath = flag(rest, '--plan');
      const dirPath = flag(rest, '--dir');
      if (!planPath || !dirPath) {
        out('usage: agent-review consensus --plan <f> --dir <d> [--profile <p>] [--decisions <f>]');
        return 1;
      }
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const profile = flag(rest, '--profile') || plan.profile || 'standard';
      const findingsByAgent = {};
      for (const agent of plan.agents || []) {
        const lanePath = join(dirPath, `${agent.id}.json`);
        findingsByAgent[agent.id] = existsSync(lanePath)
          ? readFileSync(lanePath, 'utf8')
          : undefined;
      }
      const decisionsPath = flag(rest, '--decisions');
      const decisions = decisionsPath
        ? JSON.parse(readFileSync(decisionsPath, 'utf8'))
        : undefined;
      out(
        JSON.stringify(
          consensusFrom({ plan, findingsByAgent, profile, decisions }),
          null,
          2,
        ),
      );
      return 0;
    }
    case 'slice': {
      const planPath = flag(rest, '--plan');
      const diffPath = flag(rest, '--diff');
      const outDir = flag(rest, '--out-dir');
      if (!planPath || !diffPath || !outDir) {
        out('usage: agent-review slice --plan <f> --diff <f> --out-dir <d>');
        return 1;
      }
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const diffText = readFileSync(diffPath, 'utf8');
      mkdirSync(outDir, { recursive: true });
      const manifest = {};
      for (const agent of plan.agents || []) {
        if (String(agent.id).includes('/') || String(agent.id).includes('..')) {
          out(`error: unsafe agent id for slice output filename: "${agent.id}"`);
          return 1;
        }
        const result = sliceForAgent({ agent, diffText });
        writeFileSync(join(outDir, `${agent.id}.diff`), result.diff);
        manifest[agent.id] = {
          mode: result.mode,
          files: result.files,
          hunks: result.hunks,
        };
      }
      out(JSON.stringify(manifest, null, 2));
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
      if (sub === 'parse') {
        const commandPath = flag(rest, '--command');
        if (!commandPath) {
          out('usage: agent-review address parse --command <f> [--lenient] [--ledger <f>]');
          return 1;
        }
        const ledgerPath = flag(rest, '--ledger');
        try {
          out(JSON.stringify(parseCommand(readFileSync(commandPath, 'utf8'), {
            lenient: rest.includes('--lenient'),
            ledger: ledgerPath ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null,
          })));
          return 0;
        } catch (e) {
          out(`error: ${e.message}`);
          return 1;
        }
      }
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
        writeStdoutSync(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
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
      out('usage: agent-review address parse|prepare|validate|feedback|finalize');
      return 1;
    }
    case 'ledger': {
      const findingsPath = flag(rest, '--findings');
      if (!findingsPath) {
        out('usage: agent-review ledger --findings <file> [--previous <file>] [--match-suggestions-by-location]');
        return 1;
      }
      const previousPath = flag(rest, '--previous');
      const previous = previousPath
        ? JSON.parse(readFileSync(previousPath, 'utf8'))
        : [];
      const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
      const matchSuggestionsByLocation = rest.includes('--match-suggestions-by-location');
      out(JSON.stringify(mergeLedger(previous, findings, { matchSuggestionsByLocation }), null, 2));
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
    case 'approval': {
      const reportPath = flag(rest, '--report');
      const head = flag(rest, '--head');
      if (!reportPath || !head) {
        out('usage: agent-review approval --report <f> --head <sha>');
        return 1;
      }
      out(JSON.stringify(evaluateApproval(readFileSync(reportPath, 'utf8'), { head })));
      return 0;
    }
    case 'code-review-proof': {
      const rawPath = flag(rest, '--raw');
      const findingsPath = flag(rest, '--findings');
      const droppedPath = flag(rest, '--dropped');
      const runId = flag(rest, '--run');
      if (!rawPath || !findingsPath || !droppedPath || !runId) {
        out(CODE_REVIEW_PROOF_USAGE);
        return 1;
      }
      const readIfPresent = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
      const refuse = (stage, reason) => {
        out(JSON.stringify({ ok: false, stage, reason, count: 0, mode: null, dropped: [] }));
        return 1;
      };
      let excludedPaths;
      try {
        excludedPaths = existsSync(C.CONFIG)
          ? loadConfig({ configPath: C.CONFIG, schemaPath: C.SCHEMA }).excluded_paths || []
          : [];
      } catch (e) {
        return refuse('config', `could not read excluded_paths from the review config: ${e.message}`);
      }
      let capturePath = flag(rest, '--capture');
      if (!capturePath) {
        const dir = captureDir();
        const dirError = captureDirError(dir);
        if (dirError) return refuse('capture', dirError);
        capturePath = join(dir, CAPTURE_FILES.capture);
      }
      const fileExists = (p) => {
        const target = resolve(C.ROOT, p);
        const rel = relative(C.ROOT, target);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
        return existsSync(target) && statSync(target).isFile();
      };
      const r = checkCodeReviewRun({
        captureText: readIfPresent(capturePath),
        runId,
        rawText: readIfPresent(rawPath),
        scoredText: readIfPresent(findingsPath),
        droppedText: readIfPresent(droppedPath),
        excludedPaths,
        fileExists,
        root: C.ROOT,
      });
      out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'capture': {
      const sub = rest[0];
      const runId = flag(rest, '--run');
      // Read raw, not through flag(): the args must match the Skill call exactly and may start with "--".
      const argsAt = rest.indexOf('--args');
      const args = argsAt < 0 ? undefined : rest[argsAt + 1];
      if (
        !['arm', 'disarm', 'show'].includes(sub) ||
        (sub !== 'disarm' && !runId) ||
        (sub === 'arm' && !args)
      ) {
        out('usage: agent-review capture arm --run <id> --args "<args>" | capture disarm | capture show --run <id>');
        return 1;
      }
      const fail = (reason) => {
        process.stderr.write(`error: ${reason}\n`);
        return 1;
      };
      const dir = captureDir();
      const file = (key) => join(dir, CAPTURE_FILES[key]);
      if (sub === 'arm') {
        try {
          mkdirSync(dir, { mode: 0o700 });
        } catch (e) {
          if (e.code !== 'EEXIST') return fail(`could not create capture dir ${dir}: ${e.message}`);
        }
      }
      const dirError = captureDirError(dir);
      if (dirError) return fail(dirError);
      if (sub === 'arm') {
        for (const key of ['capture', 'pending', 'stops', 'mismatch']) {
          rmSync(file(key), { force: true });
        }
        writeFileAtomic(
          file('arm'),
          JSON.stringify({ armed: true, run_id: runId, args, created: nowSeconds() }),
        );
        out(`armed ${runId}: ${args}`);
        return 0;
      }
      if (sub === 'disarm') {
        rmSync(file('arm'), { force: true });
        out('disarmed');
        return 0;
      }
      const capture = readJsonOrNull(file('capture'));
      if (!capture || capture.source !== CAPTURE_SOURCE || typeof capture.result !== 'string') {
        return fail(`no capture for run ${runId}`);
      }
      if (capture.run_id !== runId) {
        return fail(`the capture is for run ${capture.run_id}, not run ${runId}`);
      }
      writeStdoutSync(capture.result);
      return 0;
    }
    case 'capture-wait': {
      const runId = flag(rest, '--run');
      const effort = flag(rest, '--effort');
      const timeoutSeconds = captureWaitTimeout(flag(rest, '--timeout'));
      if (!runId || !EFFORTS.includes(effort) || timeoutSeconds === null) {
        out(CAPTURE_WAIT_USAGE);
        return 1;
      }
      return captureWait({ runId, effort, timeoutSeconds });
    }
    case 'hook':
      return runHook(rest[0]);
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
      const options = resolveOptions({ args: mode, config: cfg, ci: false });
      const plan = buildPlan(
        {
          files,
          diffText: diff,
          linesChanged: linesChangedFromStat(stat),
          scope,
          reviewDirRel: C.reviewDirRel,
          mode,
          options,
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
  readTranscript,
  captureWaitTimeout,
};
