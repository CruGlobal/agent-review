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
  chmodSync,
  utimesSync,
} = require('node:fs');
const { join, basename } = require('node:path');
const os = require('node:os');
const {
  LOCK_FILE,
  currentLock,
  lockGenerations,
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
  forceRelease,
  prLockDir,
  ensurePrLockDir,
  takePrLock,
  releasePrLocks,
  forceReleasePr,
  pruneRuns,
  PRUNE_AGE_SECONDS,
  prHeldMessage,
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
    assert.throws(
      () => resolveRunDir({ root: plain, env: {} }),
      (e) => e instanceof RunDirError && e.message === `${plain} is not inside a git checkout, so it has no run folder: run this from inside the checkout`,
    );
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
    const lock = currentLock(dir).lock;
    assert.equal(lock.session_id, 'session-one');
    assert.equal(lock.claude_pid, 111);
    assert.equal(lock.skill, 'review');
    assert.equal(lock.checkout, '/w/a');
    assert.equal(statSync(join(dir, `${LOCK_FILE}.1`)).mode & 0o777, 0o600);

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
    assert.equal(currentLock(dir).lock.session_id, 'session-two');
    assert.deepEqual(lockGenerations(dir), [3], 'each take is the next generation, and older ones go');
  });
});

test('a corrupt lock is free', () => {
  withTemp('ar-rundir-lock-', (dir) => {
    writeFileSync(join(dir, `${LOCK_FILE}.1`), 'not json');
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
    assert.notEqual(currentLock(dir).generation, 0);
    assert.equal(releaseLock({ dir, skill: 'yolo-review', env: S1, nowSeconds: NOW, isAlive: alive }).cleaned, true);
    assert.deepEqual(lockGenerations(dir), []);
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
    const holder = () => currentLock(dir).lock.skill;
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
    assert.deepEqual(lockGenerations(dir), []);
    // A yolo-review this session left is replaced by the next one, never kept by it.
    lock('yolo-review', true);
    assert.equal(lock('yolo-review', true).taken, true);
  });
});

test('two sessions taking over the same stale lock: exactly one wins, whatever the interleaving', () => {
  const S3 = { CLAUDE_CODE_SESSION_ID: 'session-three', CLAUDE_PID: '333' };
  const take = (dir, env, afterRead) =>
    takeLock({ dir, skill: 'review', toplevel: '/w/a', env, nowSeconds: NOW, isAlive: (pid) => pid !== 111, afterRead });
  const staleLock = (dir) => writeFileSync(join(dir, `${LOCK_FILE}.4`), JSON.stringify({ session_id: 'session-one', claude_pid: 111, skill: 'review', created: NOW }));

  // S2 reads the stale lock, then S3 reads it and takes it, and only then does S2 try.
  withTemp('ar-rundir-race-', (dir) => {
    staleLock(dir);
    let inner;
    const outer = take(dir, S2, () => {
      inner = inner ?? take(dir, S3);
    });
    assert.deepEqual([inner.ok, inner.taken], [true, true], 'the session that took it first holds it');
    assert.equal(outer.ok, false, 'the slower one is refused');
    assert.equal(outer.lock.session_id, 'session-three');
    assert.equal(currentLock(dir).lock.session_id, 'session-three');
    assert.deepEqual(lockGenerations(dir), [5]);
  });

  // Both read the stale lock; S3 takes it and frees it again before S2 tries, so S2 then takes a free checkout.
  withTemp('ar-rundir-race-', (parent) => {
    const dir = runFolder(parent);
    staleLock(dir);
    let inner;
    const outer = take(dir, S2, () => {
      if (inner) return;
      inner = take(dir, S3);
      releaseLock({ dir, skill: 'review', env: S3, nowSeconds: NOW, isAlive: () => true });
    });
    assert.equal(inner.ok, true);
    assert.deepEqual([outer.ok, outer.taken], [true, true]);
    assert.equal(currentLock(dir).lock.session_id, 'session-two');
  });

  // Three sessions read the same stale lock: exactly one ends up holding it.
  withTemp('ar-rundir-race-', (dir) => {
    staleLock(dir);
    const results = [];
    const S4 = { CLAUDE_CODE_SESSION_ID: 'session-four', CLAUDE_PID: '444' };
    results.push(take(dir, S2, () => {
      if (results.length > 0) return;
      results.push(take(dir, S3, () => {
        if (results.length > 0) return;
        results.push(take(dir, S4));
      }));
    }));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    assert.equal(currentLock(dir).lock.session_id, results.find((r) => r.ok).lock.session_id);
  });
});

test('a checkout whose path a double-quoted shell word cannot carry has no run folder, and one with a space does', () => {
  withTemp('ar-rundir-names-', (parent) => {
    const repo = (name) => {
      const root = join(parent, name);
      mkdirSync(root);
      execFileSync('git', ['init', '-q', root]);
      return root;
    };
    for (const name of ['quote"d', 'dollar$HOME', 'back`tick', 'back\\slash']) {
      assert.throws(
        () => resolveRunDir({ root: repo(name), env: { AGENT_REVIEW_CAPTURE_DIR: '/tmp/cap' } }),
        (e) => e instanceof RunDirError && /holds a character a double-quoted shell word cannot carry/.test(e.message),
        name,
      );
    }
    const spaced = resolveRunDir({ root: repo('with space'), env: { AGENT_REVIEW_CAPTURE_DIR: '/tmp/cap' } });
    assert.equal(spaced.toplevel, join(parent, 'with space'));
    assert.match(spaced.dir, /\/runs\/with_space-[0-9a-f]{12}$/, 'the run folder itself never holds the space');
  });
});

test('a lock file never appears empty or partial, so a session that is still writing one is never "no lock"', () => {
  const S3 = { CLAUDE_CODE_SESSION_ID: 'session-three', CLAUDE_PID: '333' };
  withTemp('ar-rundir-whole-', (dir) => {
    writeFileSync(join(dir, `${LOCK_FILE}.4`), JSON.stringify({ session_id: 'session-one', claude_pid: 111, skill: 'review', created: NOW }));
    const isAlive = (pid) => pid !== 111;
    const seen = [];
    let inner;
    const outer = takeLock({
      dir,
      skill: 'review',
      toplevel: '/w/a',
      env: S2,
      nowSeconds: NOW,
      isAlive,
      beforeLink: () => {
        // S2 has written its lock and not yet put it in place: every lock file S3 can see is whole.
        for (const generation of lockGenerations(dir)) {
          seen.push(JSON.parse(readFileSync(join(dir, `${LOCK_FILE}.${generation}`), 'utf8')).session_id);
        }
        inner = inner ?? takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S3, nowSeconds: NOW, isAlive });
      },
    });
    assert.deepEqual(seen, ['session-one'], 'only the stale lock, and it parses');
    assert.deepEqual([inner.ok, inner.taken], [true, true]);
    assert.equal(outer.ok, false, 'the session still writing loses to the one that finished first');
    assert.equal(currentLock(dir).lock.session_id, 'session-three');
    assert.deepEqual(readdirSync(dir).sort(), [`${LOCK_FILE}.5`], 'no temp file is left behind');
  });
});

test('a leftover temp lock file is never read as a lock, and cleanup removes it', () => {
  withTemp('ar-rundir-tmp-', (parent) => {
    const dir = runFolder(parent);
    writeFileSync(join(dir, `${LOCK_FILE}.7.tmp-0123456789abcdef`), '');
    assert.deepEqual(currentLock(dir), { generation: 0, lock: null });
    assert.equal(takeLock({ dir, skill: 'review', toplevel: '/w/a', env: S1, nowSeconds: NOW, isAlive: alive }).taken, true);
    assert.deepEqual(lockGenerations(dir), [1]);
    assert.equal(releaseLock({ dir, skill: 'review', env: S1, nowSeconds: NOW, isAlive: alive }).cleaned, true);
    assert.deepEqual(readdirSync(dir).sort(), ['agent_review_report.md', 'automated_fixes'].filter((f) => existsSync(join(dir, f))));
    assert.ok(!readdirSync(dir).some((f) => f.startsWith(LOCK_FILE)), 'no lock or temp lock file survives cleanup');
  });
});

const PR = 'CruGlobal/agent-review#48';

// Two checkouts of one repo under one capture root; the first is held by session one, the second by session two.
function twoHeldCheckouts(cap, { skillB = 'review' } = {}) {
  const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
  const two = { ...S2, AGENT_REVIEW_CAPTURE_DIR: cap };
  const runA = runFolder(cap, 'repo-a-0123456789ab');
  const runB = runFolder(cap, 'repo-b-0123456789ab');
  takeLock({ dir: runA, skill: 'review', toplevel: '/w/a', env: one, nowSeconds: NOW, isAlive: alive });
  takeLock({ dir: runB, skill: skillB, toplevel: '/w/b', env: two, nowSeconds: NOW, isAlive: alive });
  return { one, two, runA, runB, prDir: prLockDir(one, PR) };
}

test('prLockDir names owner_repo_n in lower case and rejects anything else', () => {
  const env = { AGENT_REVIEW_CAPTURE_DIR: '/tmp/cap' };
  assert.equal(prLockDir(env, PR), '/tmp/cap/locks/cruglobal_agent-review_48');
  assert.equal(prLockDir(env, 'cruglobal/AGENT-REVIEW#48'), prLockDir(env, PR), 'every spelling of a PR is one lock');
  for (const bad of ['a/b', 'a/b#0', 'a b/c#1', '../x#1', 'a/b#1 ', 'a_b/c#1', 'a/b/c#1']) {
    assert.throws(() => prLockDir(env, bad), RunDirError, JSON.stringify(bad));
  }
});

test("a session holding the checkout takes the PR, and another session's live PR lock refuses with its holder", () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, two, runA, runB, prDir } = twoHeldCheckouts(cap, { skillB: 'address' });
    const first = takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive });
    assert.equal(first.ok, true);
    const { session_id, skill, checkout, pr } = currentLock(prDir).lock;
    assert.deepEqual({ session_id, skill, checkout, pr }, { session_id: 'session-one', skill: 'review', checkout: '/w/a', pr: PR });
    for (const dir of [join(cap, 'locks'), prDir]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);

    const second = takePrLock({ runDir: runB, pr: 'cruglobal/agent-review#48', env: two, nowSeconds: NOW + 125, isAlive: alive });
    assert.equal(second.ok, false);
    assert.equal(second.lock.session_id, 'session-one');
    assert.equal(
      prHeldMessage(second.lock, { pr: PR, nowSeconds: NOW + 125 }),
      'another agent-review review run holds PR CruGlobal/agent-review#48: session session-one, checkout /w/a, started 2 minutes ago. ' +
        'Wait for it to finish. If that run is gone, free the PR with: agent-review run-dir --release --force --pr CruGlobal/agent-review#48',
    );
    assert.deepEqual(lockGenerations(prDir), [1], 'the refused session changed nothing');

    assert.equal(takePrLock({ runDir: runB, pr: 'CruGlobal/agent-review#49', env: two, nowSeconds: NOW, isAlive: alive }).ok, true, 'another PR is free');
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW + 5, isAlive: alive }).ok, true, 'the holding session gets back in');

    forceReleasePr(two, PR);
    assert.deepEqual(lockGenerations(prDir), []);
    const taken = takePrLock({ runDir: runB, pr: PR, env: two, nowSeconds: NOW + 130, isAlive: alive });
    assert.deepEqual([taken.ok, taken.lock.skill, taken.lock.checkout], [true, 'address', '/w/b']);
  });
});

test('the PR lock belongs to the skill that holds the checkout', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, two, runA, runB, prDir } = twoHeldCheckouts(cap);
    const lock = (skill, outer = false) => takeLock({ dir: runA, skill, toplevel: '/w/a', outer, env: one, nowSeconds: NOW, isAlive: alive });
    const takePr = (runDir, env) => takePrLock({ runDir, pr: PR, env, nowSeconds: NOW, isAlive: alive });
    const releasePrs = (env, toplevel) => releasePrLocks({ env, toplevel, nowSeconds: NOW, isAlive: alive });
    assert.equal(lock('yolo-review', true).taken, true);
    for (const skill of ['review', 'address']) {
      assert.equal(lock(skill).taken, false, `${skill} runs inside yolo-review's hold`);
      const taken = takePr(runA, one);
      assert.deepEqual([taken.ok, taken.lock.skill], [true, 'yolo-review'], `${skill} takes the PR for yolo-review`);
      assert.deepEqual(releaseLock({ dir: runA, skill, env: one, nowSeconds: NOW, isAlive: alive }), { ok: true, cleaned: false, heldBy: 'yolo-review' });
      assert.equal(currentLock(prDir).lock.skill, 'yolo-review', `${skill} leaves the PR to yolo-review`);
      assert.equal(takePr(runB, two).ok, false, 'no other checkout gets the PR in between');
    }
    assert.equal(releaseLock({ dir: runA, skill: 'yolo-review', env: one, nowSeconds: NOW, isAlive: alive }).cleaned, true);
    releasePrs(one, '/w/a');
    assert.deepEqual(lockGenerations(prDir), []);

    assert.equal(takePr(runB, two).ok, true);
    releasePrs(one, '/w/a');
    assert.equal(currentLock(prDir).lock.session_id, 'session-two', "another session's PR lock is never freed");
  });
});

test('a PR lock whose holder died or is over 21600 seconds old is taken over', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, two, runA, runB } = twoHeldCheckouts(cap);
    assert.equal(LOCK_MAX_AGE_SECONDS, 21600);
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    const died = takePrLock({ runDir: runB, pr: PR, env: two, nowSeconds: NOW, isAlive: (pid) => pid !== 111 });
    assert.deepEqual([died.ok, died.lock.session_id], [true, 'session-two'], 'its holder died');

    takeLock({ dir: runA, skill: 'review', toplevel: '/w/a', env: one, nowSeconds: NOW + 21600, isAlive: alive });
    const young = takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW + 21600, isAlive: alive });
    assert.deepEqual([young.ok, young.lock.session_id], [false, 'session-two'], 'a lock exactly 21600 seconds old still holds');
    const old = takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW + 21601, isAlive: alive });
    assert.deepEqual([old.ok, old.lock.session_id], [true, 'session-one'], 'an older one is free');
  });
});

test('this session holding a PR from one checkout is refused it from another, and takes it again from the same one', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const subagent = { CLAUDE_CODE_SESSION_ID: 'session-sub', CLAUDE_PID: '111', AGENT_REVIEW_CAPTURE_DIR: cap };
    const runA = runFolder(cap, 'repo-a-0123456789ab');
    const runB = runFolder(cap, 'repo-b-0123456789ab');
    takeLock({ dir: runA, skill: 'review', toplevel: '/w/a', env: one, nowSeconds: NOW, isAlive: alive });
    takeLock({ dir: runB, skill: 'address', toplevel: '/w/b', env: one, nowSeconds: NOW, isAlive: alive });
    const take = (runDir, env) => takePrLock({ runDir, pr: PR, env, nowSeconds: NOW, isAlive: alive });
    const prDir = prLockDir(one, PR);
    assert.equal(take(runA, one).ok, true);
    for (const env of [one, subagent]) {
      const refused = take(runB, env);
      assert.deepEqual([refused.ok, refused.lock.checkout, refused.lock.skill], [false, '/w/a', 'review']);
    }
    assert.deepEqual(lockGenerations(prDir), [1], 'the refused takes changed nothing');
    const again = take(runA, one);
    assert.deepEqual([again.ok, again.lock.checkout], [true, '/w/a'], 'the same checkout takes it again');
    assert.deepEqual(lockGenerations(prDir), [2]);
    const later = NOW + LOCK_MAX_AGE_SECONDS + 1;
    takeLock({ dir: runB, skill: 'address', toplevel: '/w/b', env: one, nowSeconds: later, isAlive: alive });
    const stale = takePrLock({ runDir: runB, pr: PR, env: one, nowSeconds: later, isAlive: alive });
    assert.deepEqual([stale.ok, stale.lock.checkout], [true, '/w/b'], 'a stale PR lock from another checkout is taken over');
  });
});

test('a PR taken by this session from another checkout between the read and the write refuses the take', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const prDir = join(cap, 'pr');
    mkdirSync(prDir);
    const take = (toplevel, afterRead) => takeLock({ dir: prDir, skill: 'review', toplevel, pr: PR, env: one, nowSeconds: NOW, isAlive: alive, afterRead });
    let raced = false;
    const r = take('/w/a', () => {
      if (raced) return;
      raced = true;
      assert.equal(take('/w/b').ok, true);
    });
    assert.deepEqual([r.ok, r.lock.checkout], [false, '/w/b']);
    assert.equal(currentLock(prDir).lock.checkout, '/w/b');
  });
});

test('takeLock says when it replaced a hold this session left', () => {
  withTemp('ar-rundir-lock-', (dir) => {
    const lock = (skill, env, { outer = false, isAlive = alive } = {}) =>
      takeLock({ dir, skill, toplevel: '/w/a', outer, env, nowSeconds: NOW, isAlive });
    assert.equal(lock('review', S1).replacedOwn, false, 'nothing to replace');
    assert.equal(lock('address', S1).replacedOwn, true, 'a stopped run of this session');
    assert.equal(lock('yolo-review', S1, { outer: true }).replacedOwn, true, 'an outer skill replacing one');
    const kept = lock('review', S1);
    assert.deepEqual([kept.taken, kept.replacedOwn], [false, undefined], 'a run inside the outer hold replaces nothing');
    assert.equal(lock('review', S2, { isAlive: dead }).replacedOwn, false, "another session's dead lock is not this session's");
  });
});

test('takePrLock without holding the checkout returns not-held and writes nothing', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const two = { ...S2, AGENT_REVIEW_CAPTURE_DIR: cap };
    const runA = runFolder(cap, 'repo-a-0123456789ab');
    const take = (env, now = NOW, isAlive = alive) => takePrLock({ runDir: runA, pr: PR, env, nowSeconds: now, isAlive });
    assert.deepEqual(take(one), { ok: false, reason: 'not-held' }, 'nobody holds the checkout');
    takeLock({ dir: runA, skill: 'review', toplevel: '/w/a', env: two, nowSeconds: NOW, isAlive: alive });
    assert.deepEqual(take(one), { ok: false, reason: 'not-held' }, 'another session holds it');
    assert.deepEqual(take(two, NOW + LOCK_MAX_AGE_SECONDS + 1), { ok: false, reason: 'not-held' }, 'its own hold went stale');
    assert.deepEqual(take(two, NOW, dead), { ok: false, reason: 'not-held' }, 'its own hold is from a process that is gone');
    assert.equal(existsSync(join(cap, 'locks')), false);
  });
});

test('a symlinked or group-writable locks folder is refused', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const runA = runFolder(cap, 'repo-a-0123456789ab');
    takeLock({ dir: runA, skill: 'review', toplevel: '/w/a', env: one, nowSeconds: NOW, isAlive: alive });
    const take = () => takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive });
    const locks = join(cap, 'locks');
    const elsewhere = join(cap, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });

    symlinkSync(elsewhere, locks);
    assert.throws(take, (e) => e instanceof RunDirError && /locks is a symlink/.test(e.message));
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing is written through the link');

    rmSync(locks);
    mkdirSync(locks, { mode: 0o700 });
    chmodSync(locks, 0o770);
    assert.throws(take, (e) => e instanceof RunDirError && /group or other permission bits/.test(e.message));

    chmodSync(locks, 0o700);
    symlinkSync(elsewhere, prLockDir(one, PR));
    assert.throws(take, (e) => e instanceof RunDirError && /cruglobal_agent-review_48 is a symlink/.test(e.message));
    assert.deepEqual(readdirSync(elsewhere), [], 'nor through a linked PR folder');
  });
});

test('a release frees the PR locks taken from that checkout, even those a stopped run left', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, runA, prDir } = twoHeldCheckouts(cap);
    const pr2 = prLockDir(one, 'CruGlobal/agent-review#49');
    const releasePrs = (toplevel) => releasePrLocks({ env: one, toplevel, nowSeconds: NOW, isAlive: alive });
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    takeLock({ dir: runA, skill: 'address', toplevel: '/w/a', env: one, nowSeconds: NOW, isAlive: alive });
    assert.equal(takePrLock({ runDir: runA, pr: 'CruGlobal/agent-review#49', env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    assert.deepEqual([currentLock(prDir).lock.skill, currentLock(pr2).lock.skill], ['review', 'address']);

    releasePrs('/w/other');
    assert.deepEqual([lockGenerations(prDir), lockGenerations(pr2)], [[1], [1]], 'another checkout frees nothing');
    releasePrs('/w/a');
    assert.deepEqual([lockGenerations(prDir), lockGenerations(pr2)], [[], []], "the stopped review's PR goes with address's");
  });
});

test("a release in one checkout leaves this session's PR lock taken from another checkout", () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const runA = runFolder(cap, 'repo-a-0123456789ab');
    const runB = runFolder(cap, 'repo-b-0123456789ab');
    const hold = (dir, toplevel) => takeLock({ dir, skill: 'review', toplevel, env: one, nowSeconds: NOW, isAlive: alive });
    hold(runA, '/w/a');
    hold(runB, '/w/b');
    const prB = 'CruGlobal/agent-review#50';
    assert.equal(takePrLock({ runDir: runB, pr: prB, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    releasePrLocks({ env: one, toplevel: '/w/a', nowSeconds: NOW, isAlive: alive });
    assert.deepEqual(lockGenerations(prLockDir(one, prB)), [1]);
    releasePrLocks({ env: one, toplevel: '/w/b', nowSeconds: NOW, isAlive: alive });
    assert.deepEqual(lockGenerations(prLockDir(one, prB)), []);
  });
});

test('releasePrLocks skips a symlinked entry under locks and keeps a newer generation', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, runA, prDir } = twoHeldCheckouts(cap);
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    const elsewhere = join(cap, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    const mine = { ...one, CLAUDE_PID: '111' };
    writeFileSync(join(elsewhere, `${LOCK_FILE}.1`), JSON.stringify({ ...holderFrom(mine), skill: 'review', checkout: '/w/a', created: NOW }));
    symlinkSync(elsewhere, join(cap, 'locks', 'linked'));
    let raced = false;
    releasePrLocks({
      env: one,
      toplevel: '/w/a',
      nowSeconds: NOW,
      isAlive: () => {
        if (!raced) {
          raced = true;
          writeFileSync(join(prDir, `${LOCK_FILE}.2`), JSON.stringify({ session_id: 'session-two', claude_pid: 222, skill: 'review', checkout: '/w/b', created: NOW }));
        }
        return true;
      },
    });
    assert.deepEqual(readdirSync(elsewhere), [`${LOCK_FILE}.1`], 'nothing is removed through the link');
    assert.deepEqual(lockGenerations(prDir), [2], "the newer generation is another session's and survives");
  });
});

test('forceReleasePr follows no symlink, ignores a missing folder, and refuses a bad one', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const one = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    assert.doesNotThrow(() => forceReleasePr({ ...one, AGENT_REVIEW_CAPTURE_DIR: join(cap, 'missing') }, PR), 'no capture folder at all');
    assert.doesNotThrow(() => forceReleasePr(one, PR), 'no locks folder');
    mkdirSync(join(cap, 'locks'), { mode: 0o700 });
    assert.doesNotThrow(() => forceReleasePr(one, PR), 'no PR folder');

    const elsewhere = join(cap, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, `${LOCK_FILE}.1`), '{}');
    symlinkSync(elsewhere, prLockDir(one, PR));
    assert.throws(() => forceReleasePr(one, PR), (e) => e instanceof RunDirError && /is a symlink/.test(e.message));
    rmSync(prLockDir(one, PR));
    rmSync(join(cap, 'locks'), { recursive: true });
    symlinkSync(elsewhere, join(cap, 'locks'));
    assert.throws(() => forceReleasePr(one, PR), (e) => e instanceof RunDirError && /locks is a symlink/.test(e.message));
    const linkedRoot = join(os.tmpdir(), `ar-linked-root-${process.pid}`);
    symlinkSync(cap, linkedRoot);
    try {
      assert.throws(() => forceReleasePr({ ...one, AGENT_REVIEW_CAPTURE_DIR: linkedRoot }, PR), (e) => e instanceof RunDirError && /is a symlink/.test(e.message));
    } finally {
      rmSync(linkedRoot);
    }
    assert.deepEqual(readdirSync(elsewhere), [`${LOCK_FILE}.1`], 'nothing is removed through a link');
  });
});

const DAY = 86400;
const age = (path, seconds) => utimesSync(path, NOW - seconds, NOW - seconds);

// A capture root with `runs/` and `locks/`.
function pruneRoot(cap) {
  for (const d of [cap, join(cap, 'runs'), join(cap, 'locks')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { env: { AGENT_REVIEW_CAPTURE_DIR: cap }, runs: join(cap, 'runs'), locks: join(cap, 'locks') };
}

function oldRun(runs, name, { files = ['pr_diff.txt'], seconds = PRUNE_AGE_SECONDS + DAY } = {}) {
  const dir = join(runs, name);
  mkdirSync(dir, { mode: 0o700 });
  for (const f of files) {
    writeFileSync(join(dir, f), 'x');
    age(join(dir, f), seconds);
  }
  age(dir, seconds);
  return dir;
}

const prune = (env, extra = {}) => pruneRuns({ env, nowSeconds: NOW, isAlive: alive, ...extra });

test('prune removes a run folder untouched for 7 days with no live lock', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs } = pruneRoot(cap);
    assert.equal(PRUNE_AGE_SECONDS, 604800);
    const old = oldRun(runs, 'old-0123456789ab');
    const justUnder = oldRun(runs, 'recent-0123456789ab', { seconds: PRUNE_AGE_SECONDS - 60 });
    assert.deepEqual(prune(env).removed, [old]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(justUnder), true);
  });
});

test('prune keeps an old run folder that holds a recent file', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs } = pruneRoot(cap);
    const dir = oldRun(runs, 'old-0123456789ab', { files: ['a.txt', 'b.txt'] });
    age(join(dir, 'b.txt'), DAY);
    age(dir, PRUNE_AGE_SECONDS + DAY);
    assert.deepEqual(prune(env).removed, []);
    assert.equal(existsSync(dir), true);
  });
});

test('prune keeps an old run folder with a live lock, and removes one whose lock is dead or stale', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs } = pruneRoot(cap);
    const live = oldRun(runs, 'live-0123456789ab');
    const dead = oldRun(runs, 'dead-0123456789ab');
    const stale = oldRun(runs, 'stale-0123456789ab');
    const lock = (dir, holder, created) => {
      const file = join(dir, `${LOCK_FILE}.1`);
      writeFileSync(file, JSON.stringify({ ...holderFrom(holder), skill: 'review', checkout: '/w/a', created }));
      age(file, PRUNE_AGE_SECONDS + DAY);
      age(dir, PRUNE_AGE_SECONDS + DAY);
    };
    lock(live, S1, NOW - 60);
    lock(dead, S2, NOW - 60);
    lock(stale, S1, NOW - LOCK_MAX_AGE_SECONDS - 1);
    const { removed } = prune(env, { isAlive: (pid) => pid !== 222 });
    assert.deepEqual(removed.sort(), [dead, stale].sort());
    assert.equal(existsSync(live), true);
  });
});

test('prune keeps the caller\'s own run folder', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs } = pruneRoot(cap);
    const mine = oldRun(runs, 'mine-0123456789ab');
    const other = oldRun(runs, 'other-0123456789ab');
    assert.deepEqual(prune(env, { keep: mine }).removed, [other]);
    assert.equal(existsSync(mine), true);
  });
});

test('prune follows no symlink under runs/ or locks/', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs, locks } = pruneRoot(cap);
    const target = join(cap, 'target');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'keep.txt'), 'x');
    writeFileSync(join(target, `${LOCK_FILE}.1`), '{}');
    age(join(target, 'keep.txt'), PRUNE_AGE_SECONDS + DAY);
    age(target, PRUNE_AGE_SECONDS + DAY);
    symlinkSync(target, join(runs, 'linked-0123456789ab'));
    symlinkSync(target, join(locks, 'linked'));
    const real = oldRun(runs, 'old-0123456789ab');
    assert.deepEqual(prune(env).removed, [real]);
    assert.deepEqual(readdirSync(target).sort(), ['keep.txt', `${LOCK_FILE}.1`]);
  });
});

test('prune does not follow a symlinked runs or locks folder', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs, locks } = pruneRoot(cap);
    const target = join(cap, 'target');
    mkdirSync(join(target, 'old-0123456789ab'), { recursive: true, mode: 0o700 });
    age(join(target, 'old-0123456789ab'), PRUNE_AGE_SECONDS + DAY);
    rmSync(runs, { recursive: true });
    rmSync(locks, { recursive: true });
    symlinkSync(target, runs);
    symlinkSync(target, locks);
    assert.deepEqual(prune(env).removed, []);
    assert.deepEqual(readdirSync(target), ['old-0123456789ab']);
  });
});

test('prune skips a plain file under runs/ and locks/', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs, locks } = pruneRoot(cap);
    for (const file of [join(runs, 'note.txt'), join(locks, 'note.txt')]) {
      writeFileSync(file, 'x');
      age(file, PRUNE_AGE_SECONDS + DAY);
    }
    assert.deepEqual(prune(env).removed, []);
    assert.equal(existsSync(join(runs, 'note.txt')) && existsSync(join(locks, 'note.txt')), true);
  });
});

test('prune touches nothing when the capture root belongs to another uid', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, runs, locks } = pruneRoot(cap);
    const run = oldRun(runs, 'old-0123456789ab');
    const pr = join(locks, 'a_b_1');
    mkdirSync(pr, { mode: 0o700 });
    const other = process.getuid() + 1;
    assert.deepEqual(prune(env, { uid: other }).removed, []);
    assert.equal(existsSync(run) && existsSync(pr), true);
  });
});

test('prune removes a PR lock folder whose lock is stale, dead or unreadable, and keeps a live one', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, locks } = pruneRoot(cap);
    const make = (name, text) => {
      const dir = join(locks, name);
      mkdirSync(dir, { mode: 0o700 });
      if (text !== null) writeFileSync(join(dir, `${LOCK_FILE}.1`), text);
      return dir;
    };
    const lock = (holder, created) => JSON.stringify({ ...holderFrom(holder), skill: 'review', checkout: '/w/a', pr: 'a/b#1', created });
    const live = make('a_b_1', lock(S1, NOW - 60));
    const dead = make('a_b_2', lock(S2, NOW - 60));
    const stale = make('a_b_3', lock(S1, NOW - LOCK_MAX_AGE_SECONDS - 1));
    const corrupt = make('a_b_4', '{not json');
    const empty = make('a_b_5', null);
    const { removed } = prune(env, { isAlive: (pid) => pid !== 222 });
    assert.deepEqual(removed.sort(), [dead, stale, corrupt, empty].sort());
    assert.deepEqual(readdirSync(locks), ['a_b_1']);
    assert.equal(existsSync(live), true);
  });
});

test('prune keeps a PR lock another session writes while it runs', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, locks } = pruneRoot(cap);
    const dir = join(locks, 'a_b_1');
    mkdirSync(dir, { mode: 0o700 });
    const lock = (holder) => JSON.stringify({ ...holderFrom(holder), skill: 'review', checkout: '/w/b', pr: 'a/b#1', created: NOW });
    writeFileSync(join(dir, `${LOCK_FILE}.1`), lock(S2));
    let raced = false;
    const { removed } = prune(env, {
      isAlive: (pid) => {
        if (!raced) {
          raced = true;
          writeFileSync(join(dir, `${LOCK_FILE}.2`), lock(S1));
        }
        return pid !== 222;
      },
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(lockGenerations(dir), [2], 'the live generation survives with its folder');
  });
});

test('prune keeps a PR lock folder made under a minute ago that holds no lock yet', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, locks } = pruneRoot(cap);
    const fresh = join(locks, 'a_b_1');
    const older = join(locks, 'a_b_2');
    for (const d of [fresh, older]) mkdirSync(d, { mode: 0o700 });
    age(fresh, 10);
    age(older, 61);
    assert.deepEqual(prune(env).removed, [older]);
    assert.equal(existsSync(fresh), true);
  });
});

test('prune removes a temp lock file a killed take left over a minute ago, and then the PR lock folder', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, locks } = pruneRoot(cap);
    const dir = join(locks, 'a_b_1');
    mkdirSync(dir, { mode: 0o700 });
    const tmp = join(dir, `${LOCK_FILE}.1.tmp-0123456789abcdef`);
    writeFileSync(tmp, JSON.stringify({ ...holderFrom(S2), skill: 'review', checkout: '/w/b', pr: 'a/b#1', created: NOW - 120 }));
    age(tmp, 61);
    age(dir, 61);
    assert.deepEqual(prune(env).removed, [dir]);
    assert.equal(existsSync(dir), false);

    const withLock = join(locks, 'a_b_2');
    mkdirSync(withLock, { mode: 0o700 });
    writeFileSync(join(withLock, `${LOCK_FILE}.1`), JSON.stringify({ ...holderFrom(S2), skill: 'review', checkout: '/w/b', pr: 'a/b#2', created: NOW - 120 }));
    writeFileSync(join(withLock, `${LOCK_FILE}.2.tmp-fedcba9876543210`), '');
    age(join(withLock, `${LOCK_FILE}.2.tmp-fedcba9876543210`), 3600);
    assert.deepEqual(prune(env, { isAlive: dead }).removed, [withLock], 'a dead lock and an old temp file go together');
  });
});

test('prune keeps a temp lock file under a minute old, and the PR lock folder with it', () => {
  withTemp('ar-prune-', (cap) => {
    const { env, locks } = pruneRoot(cap);
    const dir = join(locks, 'a_b_1');
    mkdirSync(dir, { mode: 0o700 });
    const tmp = join(dir, `${LOCK_FILE}.1.tmp-0123456789abcdef`);
    writeFileSync(tmp, '');
    age(tmp, 10);
    age(dir, 61);
    assert.deepEqual(prune(env).removed, []);
    assert.deepEqual(readdirSync(dir), [`${LOCK_FILE}.1.tmp-0123456789abcdef`], 'a take still between write and link keeps its file');
  });
});

test('a lock folder removed between the read and the link is made again and taken', () => {
  for (const seam of ['afterRead', 'beforeLink']) {
    withTemp('ar-rundir-gone-', (cap) => {
      const env = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
      const dir = join(cap, 'runs', 'repo-0123456789ab');
      const resolved = { dir, source: 'checkout', toplevel: '/w/a' };
      ensureRunDir(resolved, env);
      let removed = 0;
      const r = takeLock({
        dir,
        skill: 'review',
        toplevel: '/w/a',
        env,
        nowSeconds: NOW,
        isAlive: alive,
        remake: () => ensureRunDir(resolved, env),
        [seam]: () => {
          if (removed++ === 0) rmSync(join(cap, 'runs'), { recursive: true });
        },
      });
      assert.deepEqual([r.ok, r.taken], [true, true], seam);
      for (const d of [join(cap, 'runs'), dir]) assert.equal(statSync(d).mode & 0o777, 0o700, `${seam}: ${d}`);
      assert.equal(currentLock(dir).lock.session_id, 'session-one', seam);
      assert.deepEqual(readdirSync(dir), [`${LOCK_FILE}.1`], `${seam}: no temp file is left behind`);
    });
  }

  withTemp('ar-rundir-gone-', (cap) => {
    const env = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const dir = ensurePrLockDir(env, PR);
    let removed = 0;
    const r = takeLock({
      dir,
      skill: 'review',
      toplevel: '/w/a',
      pr: PR,
      env,
      nowSeconds: NOW,
      isAlive: alive,
      remake: () => ensurePrLockDir(env, PR),
      afterRead: () => {
        if (removed++ === 0) rmSync(join(cap, 'locks'), { recursive: true });
      },
    });
    assert.deepEqual([r.ok, r.taken], [true, true], 'a PR folder and its locks folder are made again');
    for (const d of [join(cap, 'locks'), dir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  });

  withTemp('ar-rundir-gone-', (cap) => {
    const env = { ...S1, AGENT_REVIEW_CAPTURE_DIR: cap };
    const dir = ensurePrLockDir(env, PR);
    let removed = 0;
    const afterRead = () => {
      if (removed++ === 0) rmSync(dir, { recursive: true });
    };
    const r = takeLock({ dir, skill: 'review', toplevel: '/w/a', pr: PR, env, nowSeconds: NOW, isAlive: alive, afterRead });
    assert.deepEqual([r.ok, r.taken], [true, true], 'with no remake given, the folder itself is made again');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('a lock folder replaced by a symlink between the read and the link is refused', () => {
  withTemp('ar-rundir-gone-', (cap) => {
    const dir = join(cap, 'runs', 'repo-0123456789ab');
    const elsewhere = join(cap, 'elsewhere');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(elsewhere, { mode: 0o700 });
    let swapped = 0;
    const take = () =>
      takeLock({
        dir,
        skill: 'review',
        toplevel: '/w/a',
        env: S1,
        nowSeconds: NOW,
        isAlive: alive,
        beforeLink: () => {
          if (swapped++ > 0) return;
          rmSync(dir, { recursive: true });
          symlinkSync(elsewhere, dir);
        },
      });
    assert.throws(take, (e) => e instanceof RunDirError && /repo-0123456789ab is a symlink/.test(e.message));
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing is written through the link');
  });
});

test('a release frees the PRs it took before it frees the checkout, and only when it cleans', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, two, runA, prDir } = twoHeldCheckouts(cap);
    takeLock({ dir: runA, skill: 'yolo-review', toplevel: '/w/a', outer: true, env: one, nowSeconds: NOW, isAlive: alive });
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    const seen = [];
    const release = (skill, env) =>
      releaseLock({
        dir: runA,
        skill,
        toplevel: '/w/a',
        env,
        nowSeconds: NOW,
        isAlive: alive,
        beforeClean: () => seen.push({ pr: lockGenerations(prDir), checkout: lockGenerations(runA).length > 0 }),
      });
    assert.equal(release('yolo-review', two).ok, false);
    assert.deepEqual(release('review', one), { ok: true, cleaned: false, heldBy: 'yolo-review' });
    assert.deepEqual([seen, lockGenerations(prDir)], [[], [1]], 'a refused or kept release frees no PR');

    assert.deepEqual(release('yolo-review', one), { ok: true, cleaned: true });
    assert.deepEqual(seen, [{ pr: [], checkout: true }], 'the PR is free while the checkout is still held');
    assert.deepEqual(lockGenerations(runA), []);
  });
});

test('a forced release frees the PRs taken from its checkout whoever holds them, and no others', () => {
  withTemp('ar-rundir-pr-', (cap) => {
    const { one, two, runA, runB, prDir } = twoHeldCheckouts(cap);
    assert.equal(takePrLock({ runDir: runA, pr: PR, env: one, nowSeconds: NOW, isAlive: alive }).ok, true);
    assert.equal(takePrLock({ runDir: runB, pr: 'CruGlobal/agent-review#49', env: two, nowSeconds: NOW, isAlive: alive }).ok, true);
    const nameless = join(cap, 'locks', 'nameless');
    mkdirSync(nameless, { mode: 0o700 });
    writeFileSync(join(nameless, `${LOCK_FILE}.1`), JSON.stringify({ ...holderFrom(S2), skill: 'review', checkout: '/w/a', created: NOW }));
    const elsewhere = join(cap, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, `${LOCK_FILE}.1`), JSON.stringify({ ...holderFrom(S1), skill: 'review', checkout: '/w/a', pr: 'a/b#1', created: NOW }));
    symlinkSync(elsewhere, join(cap, 'locks', 'linked'));

    const freed = forceRelease({ dir: runA, toplevel: '/w/a', env: two });
    assert.deepEqual(freed.sort((x, y) => x.dir.localeCompare(y.dir)), [{ dir: prDir, pr: PR }, { dir: nameless, pr: null }]);
    assert.deepEqual([lockGenerations(runA), lockGenerations(prDir), lockGenerations(nameless)], [[], [], []]);
    assert.deepEqual(lockGenerations(prLockDir(one, 'CruGlobal/agent-review#49')), [1], "another checkout's PR stays");
    assert.deepEqual(lockGenerations(runB), [1]);
    assert.deepEqual(readdirSync(elsewhere), [`${LOCK_FILE}.1`], 'nothing is removed through a link');
  });
});
