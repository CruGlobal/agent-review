'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  existsSync,
  realpathSync,
} = require('node:fs');
const { join, basename } = require('node:path');
const os = require('node:os');
const {
  LOCK_FILE,
  LOCK_MAX_AGE_SECONDS,
  RunDirError,
  runDirName,
  resolveRunDir,
  ensureRunDir,
  holderFrom,
  sameHolder,
  lockIsLive,
  takeLock,
  foreignLock,
  heldMessage,
  cleanRunDir,
  releaseLock,
} = require('./runDir.cjs');

const NOW = 1_800_000_000;
const alive = () => true;
const dead = () => false;

function gitRepo() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'ar-rundir-repo-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}

function withTemp(prefix, fn) {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  try {
    return fn(realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the run folder name is the checkout folder name plus 12 hex of its path hash', () => {
  assert.equal(runDirName('/a/my repo'), `my_repo-${createHash('sha256').update('/a/my repo').digest('hex').slice(0, 12)}`);
  assert.match(runDirName('/w/mpdx-react.v2'), /^mpdx-react\.v2-[0-9a-f]{12}$/);
  assert.notEqual(runDirName('/a/x'), runDirName('/b/x'), 'two checkouts with one name get two folders');
});

test('one checkout gives one folder from its top, a subfolder, or a symlink to it', () => {
  const { root } = gitRepo();
  try {
    withTemp('ar-rundir-cap-', (cap) => {
      mkdirSync(join(root, 'sub/deeper'), { recursive: true });
      const link = `${root}-link`;
      symlinkSync(root, link);
      try {
        const env = { AGENT_REVIEW_CAPTURE_DIR: cap };
        const dirs = [root, join(root, 'sub/deeper'), link].map((r) => resolveRunDir({ root: r, env }));
        for (const d of dirs) {
          assert.equal(d.source, 'checkout');
          assert.equal(d.toplevel, root);
          assert.equal(d.dir, join(cap, 'runs', runDirName(root)));
        }
      } finally {
        rmSync(link, { force: true });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two worktrees of one repo get two folders', () => {
  const { root, git } = gitRepo();
  const wt = `${root}-wt`;
  try {
    git('worktree', 'add', '-q', '-b', 'other', wt);
    const env = { AGENT_REVIEW_CAPTURE_DIR: '/tmp/agent-review-test' };
    const a = resolveRunDir({ root, env });
    const b = resolveRunDir({ root: wt, env });
    assert.notEqual(a.dir, b.dir);
    assert.equal(b.toplevel, realpathSync(wt));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a flag beats AGENT_REVIEW_RUN_DIR, which beats CI, which beats the checkout', () => {
  const { root } = gitRepo();
  try {
    const env = { AGENT_REVIEW_CAPTURE_DIR: '/tmp/cap', AGENT_REVIEW_RUN_DIR: '/tmp/env-run', AGENT_REVIEW_CI: '1' };
    assert.deepEqual(resolveRunDir({ root, env, flagDir: '/tmp/flag-run/' }), { dir: '/tmp/flag-run', source: 'flag', toplevel: null });
    assert.deepEqual(resolveRunDir({ root, env }), { dir: '/tmp/env-run', source: 'env', toplevel: null });
    assert.deepEqual(resolveRunDir({ root, env: { ...env, AGENT_REVIEW_RUN_DIR: '' } }), { dir: '/tmp', source: 'ci', toplevel: null });
    assert.equal(resolveRunDir({ root, env: { AGENT_REVIEW_CAPTURE_DIR: '/tmp/cap', GITHUB_ACTIONS: 'true' } }).source, 'checkout', 'only AGENT_REVIEW_CI means CI');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a checkout, or with an unsafe path, there is no run folder', () => {
  withTemp('ar-rundir-plain-', (plain) => {
    assert.throws(() => resolveRunDir({ root: plain, env: {} }), (e) => e instanceof RunDirError && /not inside a git checkout/.test(e.message));
  });
  for (const bad of ['relative/dir', '/tmp/has space', '/tmp/$HOME', '/tmp/quote"d', '']) {
    assert.throws(() => resolveRunDir({ root: '/', env: {}, flagDir: bad }), RunDirError, JSON.stringify(bad));
  }
  assert.throws(() => resolveRunDir({ root: '/', env: { AGENT_REVIEW_RUN_DIR: '/tmp/a b' } }), RunDirError);
});

test('ensureRunDir makes the capture root, runs and the run folder private, and refuses a symlinked folder', () => {
  const { root } = gitRepo();
  try {
    withTemp('ar-rundir-cap-', (parent) => {
      const env = { AGENT_REVIEW_CAPTURE_DIR: join(parent, 'cap') };
      const resolved = ensureRunDir(resolveRunDir({ root, env }), env);
      for (const dir of [join(parent, 'cap'), join(parent, 'cap/runs'), resolved.dir]) {
        assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
      }
      rmSync(resolved.dir, { recursive: true });
      mkdirSync(join(parent, 'elsewhere'), { mode: 0o700 });
      symlinkSync(join(parent, 'elsewhere'), resolved.dir);
      assert.throws(() => ensureRunDir(resolveRunDir({ root, env }), env), /is a symlink/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const S1 = { CLAUDE_CODE_SESSION_ID: 'session-one', CLAUDE_PID: '111' };
const S2 = { CLAUDE_CODE_SESSION_ID: 'session-two', CLAUDE_PID: '222' };

test('a lock is live while its Claude Code process runs, for at most 6 hours', () => {
  const lock = { session_id: 's', claude_pid: 5, created: NOW };
  assert.equal(lockIsLive(lock, NOW + 60, alive), true);
  assert.equal(lockIsLive(lock, NOW + LOCK_MAX_AGE_SECONDS + 1, alive), false, 'too old');
  assert.equal(lockIsLive(lock, NOW + 60, dead), false, 'its process is gone');
  assert.equal(lockIsLive({ ...lock, claude_pid: null }, NOW + 60, dead), true, 'no pid: only the age counts');
  for (const bad of [null, 'x', [], {}, { created: 'yesterday' }]) assert.equal(lockIsLive(bad, NOW, alive), false);
});

test('a holder is this session, or this process when no session id is set', () => {
  assert.deepEqual(holderFrom(S1), { session_id: 'session-one', claude_pid: 111 });
  assert.deepEqual(holderFrom({ CLAUDE_CODE_SESSION_ID: ' ', CLAUDE_PID: 'x' }), { session_id: null, claude_pid: null });
  assert.equal(sameHolder({ session_id: 'session-one', claude_pid: 999 }, holderFrom(S1)), true, 'the same session');
  assert.equal(sameHolder({ session_id: 'session-two', claude_pid: 111 }, holderFrom(S1)), true, 'the same process after /clear');
  assert.equal(sameHolder({ session_id: 'session-two', claude_pid: 222 }, holderFrom(S1)), false);
  assert.equal(sameHolder({ session_id: null, claude_pid: 7 }, holderFrom({ CLAUDE_PID: '7' })), true);
  assert.equal(sameHolder({ session_id: 's', claude_pid: 8 }, holderFrom({ CLAUDE_PID: '7' })), false);
  assert.equal(sameHolder({ session_id: null, claude_pid: null }, holderFrom({})), false, 'nobody is the same as an unknown holder');
});

test('takeLock takes a free checkout, lets its session back in, and refuses another live session', () => {
  withTemp('ar-rundir-lock-', (dir) => {
    const first = takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S1, nowSeconds: NOW, isAlive: alive });
    assert.equal(first.ok, true);
    assert.equal(first.taken, true);
    const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'));
    assert.equal(lock.session_id, 'session-one');
    assert.equal(lock.claude_pid, 111);
    assert.equal(lock.skill, 'review');
    assert.equal(lock.checkout, '/w/a');
    assert.equal(statSync(join(dir, LOCK_FILE)).mode & 0o777, 0o600);

    const again = takeLock({ dir, skill: 'address', toplevel: '/w/a', env: S1, nowSeconds: NOW + 5, isAlive: alive });
    assert.deepEqual([again.ok, again.taken, again.lock.skill], [true, true, 'address'], 'a hold this session left is replaced');

    const other = takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S2, nowSeconds: NOW + 5, isAlive: alive });
    assert.equal(other.ok, false);
    assert.equal(other.lock.session_id, 'session-one');
    assert.equal(foreignLock({ dir, env: S2, nowSeconds: NOW + 5, isAlive: alive }).session_id, 'session-one');
    assert.equal(foreignLock({ dir, env: S1, nowSeconds: NOW + 5, isAlive: alive }), null);

    const message = heldMessage(other.lock, { dir, toplevel: '/w/a', nowSeconds: NOW + 125 });
    assert.match(message, /^another agent-review address run holds this checkout \(\/w\/a\): session session-one, started 2 minutes ago\./);
    assert.match(message, /agent-review run-dir --release --force/);

    const takeover = takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S2, nowSeconds: NOW + 5, isAlive: dead });
    assert.deepEqual([takeover.ok, takeover.taken], [true, true], 'a lock whose process is gone is free');
    assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')).session_id, 'session-two');
  });
});

test('a corrupt lock is free', () => {
  withTemp('ar-rundir-lock-', (dir) => {
    writeFileSync(join(dir, LOCK_FILE), 'not json');
    assert.equal(takeLock({ dir, skill: 'review', toplevel: null, env: S2, nowSeconds: NOW, isAlive: alive }).ok, true);
  });
});

function runFolder(parent, name = 'repo-0123456789ab') {
  const dir = join(parent, 'runs', name);
  mkdirSync(join(dir, 'automated_fixes'), { recursive: true });
  mkdirSync(join(dir, 'agent_findings'));
  for (const f of ['review_env.sh', 'pr_diff.txt', 'agent_review_report.md', 'agent_review_capture.json', 'agent_findings/security.json']) {
    writeFileSync(join(dir, f), 'x');
  }
  return dir;
}

test('release by the skill that took the lock cleans the folder but keeps the report and fix scripts', () => {
  withTemp('ar-rundir-clean-', (parent) => {
    const dir = runFolder(parent);
    writeFileSync(join(dir, 'automated_fixes/fix_1_security.sh'), 'echo fix');
    takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S1, nowSeconds: NOW, isAlive: alive });
    const r = releaseLock({ dir, skill: 'review', env: S1, nowSeconds: NOW + 1, isAlive: alive });
    assert.deepEqual(r, { ok: true, cleaned: true });
    assert.deepEqual(readdirSync(dir).sort(), ['agent_review_report.md', 'automated_fixes']);

    const empty = runFolder(parent, 'other-0123456789ab');
    rmSync(join(empty, 'agent_review_report.md'));
    releaseLock({ dir: empty, skill: 'review', env: S1, nowSeconds: NOW, isAlive: alive });
    assert.equal(existsSync(empty), false, 'a folder with nothing to keep is removed, fix folder with no scripts included');
  });
});

test('release leaves a hold another skill of this session took, and refuses another live session', () => {
  withTemp('ar-rundir-clean-', (parent) => {
    const dir = runFolder(parent);
    takeLock({ dir, skill: 'yolo-review', toplevel: '/w/a', outer: true, env: S1, nowSeconds: NOW, isAlive: alive });
    assert.deepEqual(releaseLock({ dir, skill: 'review', env: S1, nowSeconds: NOW, isAlive: alive }), { ok: true, cleaned: false, heldBy: 'yolo-review' });
    const refused = releaseLock({ dir, skill: 'yolo-review', env: S2, nowSeconds: NOW, isAlive: alive });
    assert.equal(refused.ok, false);
    assert.ok(existsSync(join(dir, 'review_env.sh')), 'nothing was deleted');
    assert.ok(existsSync(join(dir, LOCK_FILE)));
    assert.equal(releaseLock({ dir, skill: 'yolo-review', env: S1, nowSeconds: NOW, isAlive: alive }).cleaned, true);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  });
});

test('cleanup refuses any folder that is not directly under runs', () => {
  withTemp('ar-rundir-clean-', (parent) => {
    writeFileSync(join(parent, 'keep.txt'), 'x');
    assert.throws(() => cleanRunDir(parent), /not a run folder/);
    assert.throws(() => cleanRunDir('/tmp'), /not a run folder/);
    assert.ok(existsSync(join(parent, 'keep.txt')));
    assert.equal(basename(parent).startsWith('ar-rundir-clean-'), true);
  });
});

test('an outer hold keeps the runs inside it from cleaning up, and replaces whatever its session left', () => {
  withTemp('ar-rundir-outer-', (parent) => {
    const dir = runFolder(parent);
    const lock = (skill, outer = false) => takeLock({ dir, skill, toplevel: '/w/a', outer, env: S1, nowSeconds: NOW, isAlive: alive });
    const release = (skill) => releaseLock({ dir, skill, env: S1, nowSeconds: NOW, isAlive: alive });
    const holder = () => JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')).skill;
    // A review this session stopped before its end left its hold behind.
    assert.equal(lock('review').taken, true);
    // yolo-review replaces it, and the review and address it runs work inside its hold.
    assert.equal(lock('yolo-review', true).taken, true);
    assert.equal(holder(), 'yolo-review');
    writeFileSync(join(dir, 'yolo_env.sh'), 'export PR_NUMBER=1\n');
    for (const skill of ['review', 'address', 'review']) {
      const inner = lock(skill);
      assert.deepEqual([inner.ok, inner.taken], [true, false], `${skill} re-enters`);
      assert.deepEqual(release(skill), { ok: true, cleaned: false, heldBy: 'yolo-review' }, `${skill} leaves the folder`);
      assert.ok(existsSync(join(dir, 'yolo_env.sh')), `${skill} never cleans yolo-review's files`);
    }
    assert.equal(release('yolo-review').cleaned, true);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
    // A yolo-review this session left is replaced by the next one, never kept by it.
    lock('yolo-review', true);
    assert.equal(lock('yolo-review', true).taken, true);
  });
});
