'use strict';
const { execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, isAbsolute, join } = require('node:path');
const { captureDir, captureDirProblem, ARM_MAX_AGE_SECONDS, RUNS_DIR } = require('./captureHook.cjs');

const LOCK_FILE = 'run.lock';
const LOCK_MAX_AGE_SECONDS = ARM_MAX_AGE_SECONDS;
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

function writeLock(path, lock, { exclusive }) {
  const text = JSON.stringify(lock) + '\n';
  if (exclusive) {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

// Takes the checkout's lock for `skill`. Never takes a live lock from another session. Inside this
// session's own hold, a skill run by an outer skill (review inside yolo-review) leaves the hold to
// it; any other hold this session left was a run that stopped, so it is replaced, and an outer
// skill always replaces it.
function takeLock({ dir, skill, toplevel, outer = false, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const path = join(dir, LOCK_FILE);
  const me = holderFrom(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = !existsSync(path);
    const existing = readJsonOrNull(path);
    const live = existing && lockIsLive(existing, nowSeconds, isAlive);
    if (live && !sameHolder(existing, me)) return { ok: false, lock: existing };
    if (live && !outer && existing.outer === true) return { ok: true, taken: false, lock: existing };
    const lock = {
      ...me,
      skill,
      outer,
      checkout: toplevel,
      created: nowSeconds,
      nonce: randomBytes(8).toString('hex'),
    };
    try {
      writeLock(path, lock, { exclusive: missing });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw new RunDirError(`could not write ${path}: ${e.message}`);
    }
    const written = readJsonOrNull(path);
    if (written && written.nonce === lock.nonce) return { ok: true, taken: true, lock };
  }
  const winner = readJsonOrNull(path);
  return { ok: false, lock: winner || {} };
}

// Another live session's lock on this checkout, or null.
function foreignLock({ dir, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const lock = readJsonOrNull(join(dir, LOCK_FILE));
  if (!lock || !lockIsLive(lock, nowSeconds, isAlive) || sameHolder(lock, holderFrom(env))) return null;
  return lock;
}

function heldMessage(lock, { dir, toplevel, nowSeconds }) {
  const skill = SKILL_NAME.test(lock.skill || '') ? lock.skill : 'review';
  const session = typeof lock.session_id === 'string' && lock.session_id ? `session ${lock.session_id}` : 'an unknown session';
  const minutes = Number.isFinite(lock.created) ? Math.max(0, Math.round((nowSeconds - lock.created) / 60)) : null;
  const started = minutes === null ? '' : `, started ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return (
    `another agent-review ${skill} run holds this checkout${toplevel ? ` (${toplevel})` : ''}: ${session}${started}. ` +
    `Wait for it to finish, or run it from another checkout. If that run is gone, free the checkout with: ` +
    `agent-review run-dir --release --force (run folder ${dir})`
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
    if (name === LOCK_FILE) continue;
    const kept = KEPT_AFTER_RUN.includes(name) && (name !== 'automated_fixes' || hasFixScripts(join(dir, name)));
    if (!kept) rmSync(join(dir, name), { recursive: true, force: true });
  }
  rmSync(join(dir, LOCK_FILE), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    // Not empty: it keeps the report or fix scripts.
  }
}

// Ends `skill`'s hold on the checkout. Only the skill that took the lock frees it and cleans the
// folder, so a skill run by another (review inside yolo-review) leaves both to the outer one.
function releaseLock({ dir, skill, env = process.env, nowSeconds, isAlive = pidAlive }) {
  const path = join(dir, LOCK_FILE);
  const lock = readJsonOrNull(path);
  const me = holderFrom(env);
  if (lock && lockIsLive(lock, nowSeconds, isAlive)) {
    if (!sameHolder(lock, me)) return { ok: false, lock };
    if (lock.skill !== skill) return { ok: true, cleaned: false, heldBy: lock.skill };
  }
  cleanRunDir(dir);
  return { ok: true, cleaned: true };
}

function forceRelease(dir) {
  rmSync(join(dir, LOCK_FILE), { force: true });
}

module.exports = {
  RUNS_DIR,
  LOCK_FILE,
  LOCK_MAX_AGE_SECONDS,
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
  pidAlive,
  lockIsLive,
  takeLock,
  foreignLock,
  heldMessage,
  cleanRunDir,
  releaseLock,
  forceRelease,
};
