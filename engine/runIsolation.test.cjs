'use strict';
// Two review runs on one machine at once: separate checkouts and sessions, each with its own run
// folder, lock and /code-review capture, through the real CLI and the plugin's hook entry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const { runDirName } = require('./runDir.cjs');

const CLI = join(__dirname, 'cli.cjs');
const HOOK_ENTRY = join(__dirname, '..', 'bin', 'agent-review-hook');
const ARGS = 'xhigh 12 --max-findings default';

function setup() {
  const base = realpathSync(mkdtempSync(join(os.tmpdir(), 'ar-isolation-')));
  const cap = join(base, 'cap');
  const a = join(base, 'repo-a');
  const b = join(base, 'repo-b');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', a);
  git('-C', a, 'config', 'user.email', 'test@example.com');
  git('-C', a, 'config', 'user.name', 'Test');
  writeFileSync(join(a, 'x.txt'), 'x\n');
  git('-C', a, 'add', '-A');
  git('-C', a, 'commit', '-q', '-m', 'init');
  git('-C', a, 'worktree', 'add', '-q', '-b', 'other', b);
  return { base, cap, a, b, runA: join(cap, 'runs', runDirName(a)), runB: join(cap, 'runs', runDirName(b)) };
}

const session = (id, pid = process.pid) => ({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(pid) });

function cli(cwd, args, { cap, env = {} }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: cap, AGENT_REVIEW_RUN_DIR: '', AGENT_REVIEW_CI: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function hook(name, payload, { cap, cwd = os.tmpdir() }) {
  const r = spawnSync(process.execPath, [HOOK_ENTRY, name], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: cap, AGENT_REVIEW_RUN_DIR: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' },
  });
  assert.deepEqual({ code: r.status, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout: '', stderr: '' });
}

function skillCall({ sessionId, agentId = 'lane-1', args = ARGS, skill = 'code-review', result }) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    agent_id: agentId,
    agent_type: 'agent-review:reviewer-code-review',
    tool_name: 'Skill',
    tool_input: { skill, args },
    tool_response: { result },
  };
}

const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

// Two live sessions are two Claude Code processes: this test process and its parent.
test('two runs in two checkouts and two sessions keep their own folders, locks, state and results', () => {
  const t = setup();
  try {
    const one = { cap: t.cap, env: session('session-one') };
    const two = { cap: t.cap, env: session('session-two', process.ppid) };
    const lockA = cli(t.a, ['run-dir', '--lock', 'review'], one);
    const lockB = cli(t.b, ['run-dir', '--lock', 'review'], two);
    assert.deepEqual([lockA.code, lockA.stdout, lockA.stderr], [0, `${t.runA}\n`, '']);
    assert.deepEqual([lockB.code, lockB.stdout], [0, `${t.runB}\n`]);
    assert.notEqual(t.runA, t.runB);
    assert.equal(cli(join(t.a), ['run-dir'], one).stdout, `${t.runA}\n`, 'every later step finds the same folder');

    // Each run's state, diff, ledger and report stay in its own folder.
    for (const [dir, tag] of [[t.runA, 'A'], [t.runB, 'B']]) {
      for (const f of ['review_env.sh', 'code_review_diff.txt', 'agent_review_ledger.json', 'agent_review_report.md']) {
        writeFileSync(join(dir, f), `${tag}\n`);
      }
    }
    for (const f of ['review_env.sh', 'code_review_diff.txt', 'agent_review_ledger.json', 'agent_review_report.md']) {
      assert.equal(readFileSync(join(t.runA, f), 'utf8'), 'A\n');
      assert.equal(readFileSync(join(t.runB, f), 'utf8'), 'B\n');
    }

    // Both arm /code-review with the same args, from two sessions: allowed, since the session tells them apart.
    assert.equal(cli(t.a, ['capture', 'arm', '--run', 'run-a', '--args', ARGS], one).code, 0);
    assert.equal(cli(t.b, ['capture', 'arm', '--run', 'run-b', '--args', ARGS], two).code, 0);
    assert.equal(read(t.runA, 'agent_review_capture.json').session_id, 'session-one');
    assert.equal(read(t.runB, 'agent_review_capture.json').session_id, 'session-two');

    hook('post-skill', skillCall({ sessionId: 'session-one', result: 'findings for A' }), t);
    hook('post-skill', skillCall({ sessionId: 'session-two', agentId: 'lane-2', result: 'findings for B' }), t);
    assert.equal(read(t.runA, 'code_review_capture.json').result, 'findings for A');
    assert.equal(read(t.runA, 'code_review_capture.json').run_id, 'run-a');
    assert.equal(read(t.runB, 'code_review_capture.json').result, 'findings for B');
    assert.equal(read(t.runB, 'code_review_capture.json').run_id, 'run-b');

    // A lane reads its own run's result by folder, from a shell that starts outside any repo.
    const shown = cli(os.tmpdir(), ['capture', 'show', '--run', 'run-b', '--run-dir', t.runB], { cap: t.cap });
    assert.deepEqual([shown.code, shown.stdout], [0, 'findings for B']);
    const crossed = cli(os.tmpdir(), ['capture', 'show', '--run', 'run-a', '--run-dir', t.runB], { cap: t.cap });
    assert.equal(crossed.code, 1, 'one run never reads the other run as its own');

    // An unrelated /code-review in a third session, even with the same args, touches neither run.
    const before = [readdirSync(t.runA).sort(), readdirSync(t.runB).sort(), read(t.runA, 'code_review_capture.json'), read(t.runB, 'code_review_capture.json')];
    hook('post-skill', skillCall({ sessionId: 'session-three', agentId: 'helper', result: 'someone else' }), t);
    hook('post-skill', skillCall({ sessionId: 'session-three', agentId: 'helper', args: 'low 12' }), t);
    hook('subagent-stop', { hook_event_name: 'SubagentStop', session_id: 'session-three', agent_id: 'helper', last_assistant_message: 'x' }, t);
    assert.deepEqual([readdirSync(t.runA).sort(), readdirSync(t.runB).sort(), read(t.runA, 'code_review_capture.json'), read(t.runB, 'code_review_capture.json')], before);

    // A wrong call from run A's own session fails run A only.
    hook('post-skill', skillCall({ sessionId: 'session-one', args: 'high 12 --max-findings default' }), t);
    assert.equal(read(t.runA, 'code_review_capture.mismatch.json').run_id, 'run-a');
    assert.equal(existsSync(join(t.runB, 'code_review_capture.mismatch.json')), false);

    // Run A ends: its folder is cleaned, run B's is untouched, and the checkout is free again.
    const releasedA = cli(t.a, ['run-dir', '--release', 'review'], one);
    assert.equal(releasedA.code, 0, releasedA.stderr);
    assert.deepEqual(readdirSync(t.runA), ['agent_review_report.md']);
    assert.equal(readFileSync(join(t.runB, 'review_env.sh'), 'utf8'), 'B\n');
    assert.ok(existsSync(join(t.runB, 'run.lock')));
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], two).code, 0, 'another session can now take checkout A');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('a second review of the same checkout from another live session is refused with a clear message', () => {
  const t = setup();
  try {
    const one = { cap: t.cap, env: session('session-one') };
    const two = { cap: t.cap, env: session('session-two', process.ppid) };
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], one).code, 0);
    writeFileSync(join(t.runA, 'review_env.sh'), 'A\n');
    for (const args of [['run-dir', '--lock', 'review'], ['run-dir'], ['run-dir', '--release', 'review']]) {
      const r = cli(t.a, args, two);
      assert.equal(r.code, 4, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^error: another agent-review review run holds this checkout \(.*\): session session-one, started 0 minutes ago\./, args.join(' '));
      assert.match(r.stderr, /agent-review run-dir --release --force/);
    }
    assert.equal(readFileSync(join(t.runA, 'review_env.sh'), 'utf8'), 'A\n', 'the refused session changed nothing');
    assert.equal(cli(t.a, ['run-dir', '--lock', 're-review'], one).code, 0, 'the holding session gets back in');
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], { cap: t.cap, env: session('after-clear') }).code, 0, 'so does its process after /clear');

    const dead = { cap: t.cap, env: session('session-one', 2 ** 22 + 12345) };
    rmSync(join(t.runA, 'run.lock'));
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], dead).code, 0);
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], two).code, 0, 'a lock whose Claude Code process is gone is free');

    const forced = cli(t.a, ['run-dir', '--release', '--force'], one);
    assert.deepEqual([forced.code, forced.stdout], [0, `released the lock on ${t.a}\n`]);
    assert.equal(existsSync(join(t.runA, 'review_env.sh')), true, '--force frees the lock and deletes no files');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('within one session, runs with different args capture apart and the same args are refused at arm time', () => {
  const t = setup();
  try {
    const one = { cap: t.cap, env: session('session-one') };
    assert.equal(cli(t.a, ['capture', 'arm', '--run', 'run-a', '--args', ARGS], one).code, 0);
    const clash = cli(t.b, ['capture', 'arm', '--run', 'run-b', '--args', ARGS], one);
    assert.equal(clash.code, 1);
    assert.match(clash.stderr, /^error: another review in this session armed \/code-review with the same args "xhigh 12 --max-findings default" \(run folder .*\)\. Their results cannot be told apart, so run those reviews one at a time/);
    assert.equal(existsSync(join(t.runB, 'agent_review_capture.json')), false);

    assert.equal(cli(t.b, ['capture', 'arm', '--run', 'run-b', '--args', 'xhigh 34 --max-findings default'], one).code, 0);
    hook('post-skill', skillCall({ sessionId: 'session-one', agentId: 'lane-b', args: 'xhigh 34 --max-findings default', result: 'B' }), t);
    hook('post-skill', skillCall({ sessionId: 'session-one', agentId: 'lane-a', result: 'A' }), t);
    assert.equal(read(t.runA, 'code_review_capture.json').result, 'A');
    assert.equal(read(t.runB, 'code_review_capture.json').result, 'B');

    // A /code-review with an unrelated target in the same session is not either run's mistake.
    hook('post-skill', skillCall({ sessionId: 'session-one', agentId: 'helper', args: 'low 99' }), t);
    hook('post-skill', skillCall({ sessionId: 'session-one', agentId: 'helper', args: 'low' }), t);
    for (const dir of [t.runA, t.runB]) assert.equal(existsSync(join(dir, 'code_review_capture.mismatch.json')), false);

    // The plugin command with run B's target is run B's lane calling the wrong skill.
    hook('post-skill', skillCall({ sessionId: 'session-one', agentId: 'lane-b', skill: 'code-review:code-review', args: 'xhigh 34 --max-findings default' }), t);
    assert.equal(read(t.runB, 'code_review_capture.mismatch.json').reason, 'wrong skill');
    assert.equal(existsSync(join(t.runA, 'code_review_capture.mismatch.json')), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('two arms that slip past the refusal with the same args both fail rather than take one result', () => {
  const t = setup();
  try {
    const one = { cap: t.cap, env: session('session-one') };
    assert.equal(cli(t.a, ['capture', 'arm', '--run', 'run-a', '--args', ARGS], one).code, 0);
    assert.equal(cli(t.b, ['capture', 'arm', '--run', 'run-b', '--args', ARGS], { cap: t.cap, env: session('session-two') }).code, 0);
    const arm = read(t.runB, 'agent_review_capture.json');
    writeFileSync(join(t.runB, 'agent_review_capture.json'), JSON.stringify({ ...arm, session_id: 'session-one' }));
    hook('post-skill', skillCall({ sessionId: 'session-one', result: 'whose?' }), t);
    for (const [dir, run] of [[t.runA, 'run-a'], [t.runB, 'run-b']]) {
      assert.equal(existsSync(join(dir, 'code_review_capture.json')), false);
      assert.deepEqual((({ run_id, reason }) => ({ run_id, reason }))(read(dir, 'code_review_capture.mismatch.json')), { run_id: run, reason: 'ambiguous' });
    }
    const wait = cli(t.a, ['capture-wait', '--run', 'run-a', '--effort', 'xhigh', '--timeout', '1'], one);
    assert.equal(wait.code, 1);
    assert.match(JSON.parse(wait.stdout).reason, /more than one review in this session armed/);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('a subagent stop reaches only its own session run folders', () => {
  const t = setup();
  try {
    assert.equal(cli(t.a, ['capture', 'arm', '--run', 'run-a', '--args', ARGS], { cap: t.cap, env: session('session-one') }).code, 0);
    assert.equal(cli(t.b, ['capture', 'arm', '--run', 'run-b', '--args', ARGS], { cap: t.cap, env: session('session-two') }).code, 0);
    hook('post-skill', { ...skillCall({ sessionId: 'session-one' }), tool_response: { background: true, agentId: 'fork-a' } }, t);
    assert.equal(read(t.runA, 'code_review_capture.pending.json').fork_id, 'fork-a');
    hook('subagent-stop', { hook_event_name: 'SubagentStop', session_id: 'session-two', agent_id: 'fork-a', last_assistant_message: 'not A' }, t);
    assert.equal(existsSync(join(t.runA, 'code_review_capture.json')), false, "another session's stop never completes run A");
    assert.equal(existsSync(join(t.runA, 'code_review_capture.stops.jsonl')), false);
    hook('subagent-stop', { hook_event_name: 'SubagentStop', session_id: 'session-one', agent_id: 'fork-a', last_assistant_message: 'A done' }, t);
    assert.equal(read(t.runA, 'code_review_capture.json').result, 'A done');
    const stopsB = readFileSync(join(t.runB, 'code_review_capture.stops.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).last_assistant_message);
    assert.deepEqual(stopsB, ['not A'], "run B's buffer holds only its own session's stop");
    assert.equal(existsSync(join(t.runB, 'code_review_capture.json')), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('a 1.1.4 arm in the capture root is never read', () => {
  const t = setup();
  try {
    const { mkdirSync } = require('node:fs');
    mkdirSync(t.cap, { mode: 0o700 });
    writeFileSync(join(t.cap, 'agent_review_capture.json'), JSON.stringify({ armed: true, run_id: 'old', args: ARGS, created: Math.floor(Date.now() / 1000) }));
    hook('post-skill', skillCall({ sessionId: 'session-one', result: 'x' }), t);
    assert.deepEqual(readdirSync(t.cap), ['agent_review_capture.json']);
    assert.equal(cli(t.a, ['run-dir'], { cap: t.cap, env: session('session-one') }).stdout, `${t.runA}\n`);
    assert.equal(existsSync(join(t.runA, 'agent_review_capture.json')), false, 'a new run starts with no arm');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('in CI the run folder is /tmp, with no lock and nothing cleaned', () => {
  const t = setup();
  try {
    const ci = { cap: t.cap, env: { ...session('session-one'), AGENT_REVIEW_CI: '1' } };
    assert.deepEqual(cli(t.a, ['run-dir', '--lock', 'review'], ci), { code: 0, stdout: '/tmp\n', stderr: '' });
    assert.deepEqual(cli(t.a, ['run-dir', '--release', 'review'], ci), { code: 0, stdout: '', stderr: '' });
    assert.equal(existsSync(t.cap), false, 'CI never makes a capture root or a lock');
    const arm = cli(t.a, ['capture', 'arm', '--run', 'r', '--args', ARGS], ci);
    assert.equal(arm.code, 1, 'the hooks never read /tmp itself');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('run-dir refuses bad arguments and a shell outside any checkout', () => {
  const t = setup();
  try {
    for (const bad of [['--lock'], ['--lock', 'Review'], ['--release'], ['--release', 'review', '--force'], ['--force'], ['--lock', 'review', '--release', 'review'], ['extra'], ['--outer'], ['--release', 'review', '--outer']]) {
      const r = cli(t.a, ['run-dir', ...bad], { cap: t.cap, env: session('s') });
      assert.equal(r.code, 1, bad.join(' '));
      assert.match(r.stdout, /^usage: agent-review run-dir/, bad.join(' '));
    }
    const outside = cli(os.tmpdir(), ['run-dir'], { cap: t.cap });
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /^error: .* is not inside a git checkout/);
    assert.equal(outside.stdout, '');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('capture refuses to arm in a checkout with no session id, since another session could not be told apart', () => {
  const t = setup();
  try {
    const r = cli(t.a, ['capture', 'arm', '--run', 'r', '--args', ARGS], { cap: t.cap, env: { CLAUDE_PID: String(process.pid) } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: CLAUDE_CODE_SESSION_ID is not set, so the capture hooks could not tell/);
    assert.equal(existsSync(join(t.runA, 'agent_review_capture.json')), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test('a review this session left behind never lets the review inside yolo-review clean up yolo-review', () => {
  const t = setup();
  try {
    const one = { cap: t.cap, env: session('session-one') };
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], one).code, 0, 'a review that then stopped without releasing');
    assert.equal(cli(t.a, ['run-dir', '--lock', 'yolo-review', '--outer'], one).code, 0);
    writeFileSync(join(t.runA, 'yolo_env.sh'), 'export PR_NUMBER=7\n');
    for (const skill of ['review', 'address']) {
      assert.equal(cli(t.a, ['run-dir', '--lock', skill], one).code, 0);
      const kept = cli(t.a, ['run-dir', '--release', skill], one);
      assert.deepEqual([kept.code, kept.stdout], [0, `kept ${t.runA}: this session's yolo-review run still holds it\n`]);
      assert.equal(readFileSync(join(t.runA, 'yolo_env.sh'), 'utf8'), 'export PR_NUMBER=7\n');
    }
    assert.equal(cli(t.a, ['run-dir', '--lock', 'review'], { cap: t.cap, env: session('session-two', process.ppid) }).code, 4, 'yolo-review still holds the checkout');
    assert.equal(cli(t.a, ['run-dir', '--release', 'yolo-review'], one).code, 0);
    assert.equal(existsSync(join(t.runA, 'yolo_env.sh')), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

// Runs the light hook entry with a preload that records whether the bundle was loaded.
function hookEntryLoads(cap, input) {
  const probe = mkdtempSync(join(os.tmpdir(), 'ar-hook-probe-'));
  try {
    const loaded = join(probe, 'loaded.json');
    writeFileSync(join(probe, 'record.cjs'), `process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(Object.keys(require.cache))));\n`);
    const r = spawnSync(process.execPath, ['--require', join(probe, 'record.cjs'), HOOK_ENTRY, 'post-skill'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, AGENT_REVIEW_CAPTURE_DIR: cap, AGENT_REVIEW_RUN_DIR: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' },
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    return JSON.parse(readFileSync(loaded, 'utf8')).some((m) => m.endsWith(join('dist', 'agent-review.cjs')));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test('the light hook entry scans runs/ and loads the bundle only when some run there is armed', () => {
  const t = setup();
  try {
    const { mkdirSync, symlinkSync } = require('node:fs');
    const input = JSON.stringify(skillCall({ sessionId: 'session-one', result: 'x' }));
    assert.equal(hookEntryLoads(t.cap, input), false, 'no capture dir at all');
    mkdirSync(join(t.cap, 'runs', 'released-0123456789ab'), { recursive: true, mode: 0o700 });
    writeFileSync(join(t.cap, 'runs', 'released-0123456789ab', 'agent_review_report.md'), 'kept report');
    writeFileSync(join(t.cap, 'agent_review_capture.json'), JSON.stringify({ armed: true, run_id: 'old', args: ARGS, created: Math.floor(Date.now() / 1000) }));
    assert.equal(hookEntryLoads(t.cap, input), false, 'a released run and a 1.1.4 arm load nothing');
    assert.equal(cli(t.a, ['capture', 'arm', '--run', 'run-a', '--args', ARGS], { cap: t.cap, env: session('session-one') }).code, 0);
    assert.equal(hookEntryLoads(t.cap, input), true, 'a live arm under runs/ loads the bundle');
    assert.equal(read(t.runA, 'code_review_capture.json').result, 'x');

    writeFileSync(join(t.cap, 'runs', 'a-file'), '');
    symlinkSync(t.runA, join(t.cap, 'runs', 'a-link'));
    const { hookRunDirs: light } = require(HOOK_ENTRY);
    const { hookRunDirs: bundle } = require('./cli.cjs');
    for (const env of [{ AGENT_REVIEW_CAPTURE_DIR: t.cap }, { AGENT_REVIEW_CAPTURE_DIR: t.cap, AGENT_REVIEW_RUN_DIR: '/tmp/pinned' }, { AGENT_REVIEW_CAPTURE_DIR: join(t.base, 'none') }]) {
      assert.deepEqual(light(env).sort(), bundle(env).sort(), `the light entry reads the same run folders: ${JSON.stringify(env)}`);
    }
    assert.deepEqual(light({ AGENT_REVIEW_CAPTURE_DIR: t.cap }).sort(), [join(t.cap, 'runs', 'released-0123456789ab'), t.runA].sort(), 'files and symlinks are skipped');
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});
