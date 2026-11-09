'use strict';
const { execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, isAbsolute, join } = require('node:path');
const { captureDir, captureDirProblem, ARM_MAX_AGE_SECONDS, RUNS_DIR } = require('./captureHook.cjs');

const LOCK_FILE = 'run.lock';
const LOCK_MAX_AGE_SECONDS = ARM_MAX_AGE_SECONDS;
const LOCKS_DIR = 'locks';
const PRUNE_AGE_SECONDS = 604800;
const PR_REF = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
const CI_RUN_DIR = '/tmp';
// Skills paste the run folder into prompts, JS strings and unquoted shell words.
const SAFE_DIR = /^\/[A-Za-z0-9._/-]+$/;
const SKILL_NAME = /^[a-z][a-z-]{0,31}$/;
// What a finished run leaves for the person who ran it; the review's Initialize clears both.
const KEPT_AFTER_RUN = Object.freeze(['agent_review_report.md', 'automated_fixes']);

class RunDirError extends Error {}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function runDirName(toplevel) {
  const name = basename(toplevel).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  return `${name}-${createHash('sha256').update(toplevel).digest('hex').slice(0, 12)}`;
}

// Prompts name the checkout as "{{REPO_ROOT}}" inside a double-quoted shell word.
const QUOTE_BREAKER = /["$`\\\r\n]/;

function gitToplevel(root) {
  let top;
  try {
    top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    top = '';
  }
  if (!top) {
    throw new RunDirError(
      `${root} is not inside a git checkout, so it has no run folder: run this from the checkout being reviewed`,
    );
  }
  for (const path of [top, realpathSync(top)]) {
    if (QUOTE_BREAKER.test(path)) {
      throw new RunDirError(
        `the checkout path ${JSON.stringify(path)} holds a character a double-quoted shell word cannot carry (", $, \`, \\ or a line break), so review prompts could not name it safely: move or rename the checkout`,
      );
    }
  }
  return realpathSync(top);
}

function safeDir(dir, from) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !SAFE_DIR.test(dir)) {
    throw new RunDirError(
      `${from} must be an absolute path made only of letters, digits, ".", "_", "-" and "/": ${JSON.stringify(dir)}`,
    );
  }
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

// The run folder of the checkout `root` is in, unless a flag, AGENT_REVIEW_RUN_DIR, or CI names one.
function resolveRunDir({ root, env = process.env, flagDir } = {}) {
  if (flagDir !== undefined) return { dir: safeDir(flagDir, '--run-dir'), source: 'flag', toplevel: null };
  if (env.AGENT_REVIEW_RUN_DIR) {
    return { dir: safeDir(env.AGENT_REVIEW_RUN_DIR, 'AGENT_REVIEW_RUN_DIR'), source: 'env', toplevel: null };
  }
  if (env.AGENT_REVIEW_CI) return { dir: CI_RUN_DIR, source: 'ci', toplevel: null };
  const toplevel = gitToplevel(root);
  const dir = safeDir(join(captureDir(env), RUNS_DIR, runDirName(toplevel)), 'the run folder');
  return { dir, source: 'checkout', toplevel };
}

function dirProblem(dir) {
  let stat = null;
  try {
    stat = lstatSync(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') return `${dir} cannot be checked: ${e.message}`;
  }
  const problem = captureDirProblem(stat, process.getuid());
  return problem ? `${dir} ${problem}` : null;
}

function makeDir(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw new RunDirError(`could not create ${dir}: ${e.message}`);
  }
  const problem = dirProblem(dir);
  if (problem) throw new RunDirError(problem);
}

function ensureRunDir(resolved, env = process.env) {
  if (resolved.source === 'checkout') {
    const root = captureDir(env);
    for (const dir of [root, join(root, RUNS_DIR), resolved.dir]) makeDir(dir);
  } else if (resolved.source === 'env') {
    try {
      mkdirSync(resolved.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw new RunDirError(`could not create ${resolved.dir}: ${e.message}`);
    }
  }
  return resolved;
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function holderFrom(env = process.env) {
  const session = typeof env.CLAUDE_CODE_SESSION_ID === 'string' ? env.CLAUDE_CODE_SESSION_ID.trim() : '';
  const pid = Number(env.CLAUDE_PID);
  return {
    session_id: session || null,
    claude_pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

function identified(me) {
  return me.session_id !== null || me.claude_pid !== null;
}

// One Claude Code process runs one session at a time, and /clear gives it a new session id.
function sameHolder(lock, me) {
  if (!isObject(lock)) return false;
  if (me.session_id && lock.session_id === me.session_id) return true;
  return me.claude_pid !== null && lock.claude_pid === me.claude_pid;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A lock is held while the Claude Code process that took it runs, for at most 6 hours.
function lockIsLive(lock, nowSeconds, isAlive = pidAlive) {
  if (!isObject(lock) || !Number.isFinite(lock.created)) return false;
  if (nowSeconds - lock.created > LOCK_MAX_AGE_SECONDS) return false;
  if (Number.isInteger(lock.claude_pid) && lock.claude_pid > 0 && !isAlive(lock.claude_pid)) return false;
  return true;
}

// The lock is a series of files, run.lock.1, run.lock.2, ..., and the highest one is the lock.
// Taking the checkout means creating the next one with O_EXCL, so of any sessions that read the
// same lock, exactly one can take it.
const LOCK_GENERATION = /^run\.lock\.([1-9][0-9]*)$/;

function lockGenerations(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => LOCK_GENERATION.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function lockPath(dir, generation) {
  return join(dir, `${LOCK_FILE}.${generation}`);
}

// The checkout's lock: its generation (0 when there is none) and its contents (null when unreadable).
function currentLock(dir) {
  const generation = lockGenerations(dir).at(-1) ?? 0;
  return { generation, lock: generation ? readJsonOrNull(lockPath(dir, generation)) : null };
}

function removeLocks(dir, below = Infinity) {
  for (const generation of lockGenerations(dir)) {
    if (generation < below) rmSync(lockPath(dir, generation), { force: true });
  }
}

// A lock file appears whole or not at all: the lock is written to a temp file first, then linked
// into place, which fails if that generation exists.
function createExclusive(path, text, beforeLink = () => {}) {
  const tmp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    beforeLink();
    linkSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Takes the checkout's lock for `skill`. Never takes a live lock from another session. Inside this
// session's own hold, a skill run by an outer skill (review inside yolo-review) leaves the hold to
// it; any other hold this session left was a run that stopped, so it is replaced, and an outer
// skill always replaces it. `afterRead` and `beforeLink` let tests run another session's steps
// between reading the lock and creating the next one.
function takeLock({
  dir,
  skill,
  toplevel,
  outer = false,
  pr,
  env = process.env,
  nowSeconds,
  isAlive = pidAlive,
  afterRead = () => {},
  beforeLink = () => {},
}) {
  const me = holderFrom(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { generation, lock: existing } = currentLock(dir);
    const live = existing && lockIsLive(existing, nowSeconds, isAlive);
    if (live && !sameHolder(existing, me)) return { ok: false, lock: existing };
    if (live && !outer && existing.outer === true) return { ok: true, taken: false, lock: existing };
    afterRead();
    const lock = { ...me, skill, outer, checkout: toplevel, ...(pr === undefined ? {} : { pr }), created: nowSeconds };
    try {
      createExclusive(lockPath(dir, generation + 1), JSON.stringify(lock) + '\n', beforeLink);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw new RunDirError(`could not write ${lockPath(dir, generation + 1)}: ${e.message}`);
    }
    removeLocks(dir, generation + 1);
    return { ok: true, taken: true, lock };
  }
  return { ok: false, lock: currentLock(dir).lock || {} };
}

// Another live session's lock on this checkout, or null.
function foreignLock({ dir, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const { lock } = currentLock(dir);
  if (!lock || !lockIsLive(lock, nowSeconds, isAlive) || sameHolder(lock, holderFrom(env))) return null;
  return lock;
}

function lockHolder(lock, nowSeconds) {
  const skill = SKILL_NAME.test(lock.skill || '') ? lock.skill : 'review';
  const session = typeof lock.session_id === 'string' && lock.session_id ? `session ${lock.session_id}` : 'an unknown session';
  const minutes = Number.isFinite(lock.created) ? Math.max(0, Math.round((nowSeconds - lock.created) / 60)) : null;
  const started = minutes === null ? '' : `, started ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return { skill, session, started };
}

function heldMessage(lock, { dir, toplevel, nowSeconds }) {
  const { skill, session, started } = lockHolder(lock, nowSeconds);
  return (
    `another agent-review ${skill} run holds this checkout${toplevel ? ` (${toplevel})` : ''}: ${session}${started}. ` +
    `Wait for it to finish, or run it from another checkout. If that run is gone, free the checkout with: ` +
    `agent-review run-dir --release --force (run folder ${dir})`
  );
}

// GitHub owner and repo names ignore case, so every spelling of one PR names one lock folder.
function prLockDir(env, pr) {
  const m = typeof pr === 'string' ? PR_REF.exec(pr) : null;
  if (!m) throw new RunDirError(`a PR must be named <owner>/<repo>#<number>: ${JSON.stringify(pr)}`);
  return join(captureDir(env), LOCKS_DIR, `${m[1]}_${m[2]}_${m[3]}`.toLowerCase());
}

// A PR lock belongs to the skill holding this session's checkout lock on `runDir` when it is taken.
function takePrLock({ runDir, pr, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const dir = prLockDir(env, pr);
  const { lock: checkout } = currentLock(runDir);
  if (!checkout || !lockIsLive(checkout, nowSeconds, isAlive) || !sameHolder(checkout, holderFrom(env))) {
    return { ok: false, reason: 'not-held' };
  }
  const root = captureDir(env);
  for (const d of [root, join(root, LOCKS_DIR), dir]) makeDir(d);
  const r = takeLock({ dir, skill: checkout.skill, toplevel: checkout.checkout, pr, env, nowSeconds, isAlive });
  return { ok: r.ok, lock: r.lock };
}

// Frees every PR lock this session took from the checkout `toplevel`, leaving any generation
// another session created after the one read.
function releasePrLocks({ env = process.env, toplevel, nowSeconds, isAlive = pidAlive }) {
  const root = captureDir(env);
  const locks = join(root, LOCKS_DIR);
  if (dirProblem(root) || dirProblem(locks)) return;
  const me = holderFrom(env);
  for (const name of readdirSync(locks)) {
    const dir = join(locks, name);
    if (dirProblem(dir)) continue;
    const { generation, lock } = currentLock(dir);
    if (lock && lock.checkout === toplevel && lockIsLive(lock, nowSeconds, isAlive) && sameHolder(lock, me)) {
      removeLocks(dir, generation + 1);
    }
  }
}

// A missing folder on the way is nothing to free; any other problem with one is an error.
function forceReleasePr(env, pr) {
  const dir = prLockDir(env, pr);
  const root = captureDir(env);
  for (const d of [root, join(root, LOCKS_DIR), dir]) {
    const problem = dirProblem(d);
    if (problem === `${d} does not exist`) return;
    if (problem) throw new RunDirError(problem);
  }
  removeLocks(dir);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realDirOwnedBy(path, uid) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid ? stat : null;
  } catch {
    return null;
  }
}

function newestMtimeSeconds(dir, stat) {
  let newest = stat.mtimeMs / 1000;
  for (const name of readdirSync(dir)) {
    newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs / 1000);
  }
  return newest;
}

// Removes run folders untouched for PRUNE_AGE_SECONDS and PR lock folders, unless their lock is
// live. Only real directories owned by `uid` are removed, and no symlink is followed.
function pruneRuns({ env = process.env, nowSeconds, keep, isAlive = pidAlive, uid = process.getuid() }) {
  const removed = [];
  const root = captureDir(env);
  const inside = (parent, old) => {
    let names = [];
    if (captureDirProblem(lstatOrNull(parent), uid)) return;
    try {
      names = readdirSync(parent);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(parent, name);
      if (dir === keep) continue;
      try {
        const stat = realDirOwnedBy(dir, uid);
        if (!stat || lockIsLive(currentLock(dir).lock, nowSeconds, isAlive)) continue;
        if (old && nowSeconds - newestMtimeSeconds(dir, stat) <= PRUNE_AGE_SECONDS) continue;
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        // This entry is skipped.
      }
    }
  };
  if (captureDirProblem(lstatOrNull(root), uid)) return { removed };
  inside(join(root, RUNS_DIR), true);
  inside(join(root, LOCKS_DIR), false);
  return { removed };
}

function prHeldMessage(lock, { pr, nowSeconds }) {
  const { skill, session, started } = lockHolder(lock, nowSeconds);
  const checkout = typeof lock.checkout === 'string' && lock.checkout ? `, checkout ${lock.checkout}` : '';
  return (
    `another agent-review ${skill} run holds PR ${pr}: ${session}${checkout}${started}. Wait for it to finish. ` +
    `If that run is gone, free the PR with: agent-review run-dir --release --force --pr ${pr}`
  );
}

function hasFixScripts(dir) {
  try {
    return readdirSync(dir).some((f) => /^fix_.*\.sh$/.test(f));
  } catch {
    return false;
  }
}

// Deletes the run's working files and its lock, keeping only KEPT_AFTER_RUN (fix scripts only
// when there are any), and the folder itself when nothing is kept.
function cleanRunDir(dir) {
  if (basename(dirname(dir)) !== RUNS_DIR) throw new RunDirError(`refusing to clean ${dir}: it is not a run folder`);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (LOCK_GENERATION.test(name)) continue;
    const kept = KEPT_AFTER_RUN.includes(name) && (name !== 'automated_fixes' || hasFixScripts(join(dir, name)));
    if (!kept) rmSync(join(dir, name), { recursive: true, force: true });
  }
  removeLocks(dir);
  try {
    rmdirSync(dir);
  } catch {
    // Not empty: it keeps the report or fix scripts.
  }
}

// Ends `skill`'s hold on the checkout. Only the skill that took the lock frees it and cleans the
// folder, so a skill run by another (review inside yolo-review) leaves both to the outer one.
function releaseLock({ dir, skill, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const { lock } = currentLock(dir);
  const me = holderFrom(env);
  if (lock && lockIsLive(lock, nowSeconds, isAlive)) {
    if (!sameHolder(lock, me)) return { ok: false, lock };
    if (lock.skill !== skill) return { ok: true, cleaned: false, heldBy: lock.skill };
  }
  cleanRunDir(dir);
  return { ok: true, cleaned: true };
}

function forceRelease(dir) {
  removeLocks(dir);
}

module.exports = {
  RUNS_DIR,
  LOCK_FILE,
  LOCK_MAX_AGE_SECONDS,
  LOCKS_DIR,
  PRUNE_AGE_SECONDS,
  PR_REF,
  CI_RUN_DIR,
  KEPT_AFTER_RUN,
  SKILL_NAME,
  RunDirError,
  runDirName,
  resolveRunDir,
  ensureRunDir,
  dirProblem,
  holderFrom,
  identified,
  sameHolder,
  currentLock,
  lockGenerations,
  pidAlive,
  lockIsLive,
  takeLock,
  foreignLock,
  heldMessage,
  cleanRunDir,
  releaseLock,
  forceRelease,
  prLockDir,
  takePrLock,
  releasePrLocks,
  forceReleasePr,
  pruneRuns,
  prHeldMessage,
};
