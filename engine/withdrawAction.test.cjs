'use strict';
// Runs the withdraw action's shell script against a fake gh and a real git
// origin, so the keep-or-withdraw rule is pinned by real merges, rebases, and
// conflict fixes. Uses the system bash (3.2 on macOS, 5.x on the runners), jq,
// and git 2.38+ (merge-tree --write-tree); skips without them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('yaml');

const ROOT = path.join(__dirname, '..');

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BASH = which('bash');
const JQ = which('jq');
const GIT = which('git');
function mergeTreeWorks() {
  if (!GIT) return false;
  const r = spawnSync(GIT, ['merge-tree', '-h'], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.includes('--write-tree');
}
const SKIP = !BASH
  ? 'bash is not installed'
  : !JQ
    ? 'jq is not installed'
    : !mergeTreeWorks()
      ? 'git 2.38+ with merge-tree --write-tree is not installed'
      : false;

const BOT = 'github-actions[bot]';
const TOKEN = 'test-token';
const TOKEN_HEADER = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const MARKER = '<!-- agent-review-approval -->';
const BODY = `Auto-approved: the agent-review report for this head passes with no open blockers, and no repo rule or recorded check needs a person.\n\n${MARKER}`;
const AI_REVIEW_BODY = `## AI Review Auto-Approval\n\n**Verdict:** Approved\n\n${MARKER}`;

const FAKE_GH = `#!/usr/bin/env bash
# Logs each call and serves fixtures from $FIX.
line=""
for a in "$@"; do line+="$a ¦ "; done
printf '%s\\n' "$line" >> "$GH_LOG"
has() { [ -e "$FIX/$1" ]; }
[ "$1" = api ] || { echo "fake gh: unexpected $*" >&2; exit 99; }
shift
METHOD=GET; JQ=""; URL=""; FIELDS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -X) METHOD=$2; shift 2 ;;
    --jq) JQ=$2; shift 2 ;;
    --paginate) shift ;;
    -f) FIELDS+=("$2"); shift 2 ;;
    *) URL=$1; shift ;;
  esac
done
emit() { if [ -n "$JQ" ]; then jq -r "$JQ" < "$1" || exit 1; else cat "$1"; fi; }
case "$METHOD $URL" in
  "GET repos/o/r/pulls/7")
    N=$(( $(cat "$FIX/../pr-reads" 2>/dev/null || echo 0) + 1 ))
    echo "$N" > "$FIX/../pr-reads"
    if has reads-count; then
      I=$N; [ "$I" -le "$(cat "$FIX/reads-count")" ] || I=$(cat "$FIX/reads-count")
      has "read-$I.fail" && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
      emit "$FIX/read-$I.json"; exit 0
    fi
    if [ "$N" -ge 2 ] && has fail-pr-later; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi
    if has stale-reads && [ "$N" -le "$(cat "$FIX/stale-reads")" ]; then emit "$FIX/pr-stale.json"
    elif [ "$N" -ge 2 ] && has pr-later.json; then emit "$FIX/pr-later.json"; else emit "$FIX/pr.json"; fi ;;
  "GET repos/o/r/pulls/7/reviews?per_page=100")
    has fail-reviews && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    if has fail-reviews-once && [ ! -e "$FIX/../reviews-failed" ]; then
      : > "$FIX/../reviews-failed"; echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1
    fi
    emit "$FIX/reviews.json" ;;
  "GET repos/o/r/pulls/7/reviews/"*)
    if has already-dismissed; then echo '{"state":"DISMISSED"}' > "$FIX/../review.json"; else echo '{"state":"APPROVED"}' > "$FIX/../review.json"; fi
    emit "$FIX/../review.json" ;;
  "GET repos/o/r/issues/7/timeline?per_page=100")
    has fail-timeline && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    emit "$FIX/timeline.json" ;;
  "GET repos/o/r/pulls/7/files?per_page=100")
    has fail-files && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    emit "$FIX/files.json" ;;
  "GET repos/o/r/contents/.github/workflows/agent-review.yml?ref="*)
    has "caller-\${URL##*ref=}.json" && { emit "$FIX/caller-\${URL##*ref=}.json"; exit 0; }
    has caller.json || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    emit "$FIX/caller.json" ;;
  "PUT repos/o/r/pulls/7/reviews/"*"/dismissals")
    has fail-dismiss-403 && { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }
    has fail-dismiss-rate && { echo "gh: API rate limit exceeded for installation (HTTP 403)" >&2; exit 1; }
    has already-dismissed && { echo "gh: Can not dismiss a dismissed pull request review (HTTP 422)" >&2; exit 1; }
    has fail-dismiss && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    for f in "\${FIELDS[@]}"; do
      case "$f" in message=*) printf '%s\\n' "\${f#message=}" >> "$FIX/../dismiss-messages.txt" ;; esac
    done
    echo '{}' ;;
  *) echo "fake gh: unhandled $METHOD $URL" >&2; exit 98 ;;
esac
`;

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let TMP;
let BIN;
let SCRIPT;
let SERVER;
const C = {};

function git(cwd, ...args) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0 && !(args[0] === 'merge' && args.includes('--no-commit'))) {
    throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

// One origin holds every history the scenarios need. main: F0 - M1 - M2.
// The PR's approved commit X edits line b of f.txt and adds pr.txt; main's
// commits edit line g and other.txt, so merging main into X is clean.
function buildOrigin() {
  const w = path.join(TMP, 'build');
  git(TMP, 'init', '-q', '-b', 'main', w);
  const write = (f, s) => fs.writeFileSync(path.join(w, f), s);
  const edit = (f, from, to) => write(f, fs.readFileSync(path.join(w, f), 'utf8').replace(from, to));
  const commit = (msg) => {
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', msg);
    return git(w, 'rev-parse', 'HEAD');
  };
  const at = (ref) => git(w, 'checkout', '-q', '--detach', ref);

  write('f.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  write('other.txt', 'base\n');
  C.F0 = commit('base');
  git(w, 'checkout', '-q', '-b', 'pr');
  edit('f.txt', 'b\n', 'B-pr\n');
  write('pr.txt', 'pr\n');
  C.X = commit('pr change');
  git(w, 'checkout', '-q', 'main');
  edit('f.txt', 'g\n', 'G-main\n');
  C.M1 = commit('main 1');
  write('other.txt', 'base\nmain 2\n');
  C.M2 = commit('main 2');

  at(C.X);
  git(w, 'merge', '-q', '--no-edit', C.M1);
  C.MERGE1 = git(w, 'rev-parse', 'HEAD');
  git(w, 'merge', '-q', '--no-edit', C.M2);
  C.MERGE2 = git(w, 'rev-parse', 'HEAD');

  at(C.MERGE1);
  write('pr.txt', 'pr\nafter the merge\n');
  C.MERGE_THEN_NEW = commit('new change after merging main');

  at(C.X);
  git(w, 'merge', '-q', '--no-commit', '--no-ff', C.M1);
  write('pr.txt', 'pr\nslipped into the merge\n');
  C.EVIL_MERGE = commit('merge main with an extra change');

  at(C.X);
  write('pr.txt', 'pr\nnew\n');
  C.NEW = commit('new change');

  at(C.X);
  write('pr.txt', 'pr\ntemporary\n');
  commit('temporary change');
  git(w, 'revert', '--no-edit', 'HEAD');
  C.CANCEL = git(w, 'rev-parse', 'HEAD');

  // A side branch that is not the base: merging it in brings changes main never had.
  at(C.F0);
  write('side.txt', 'side\n');
  C.SIDE = commit('side branch');
  at(C.X);
  git(w, 'merge', '-q', '--no-edit', C.SIDE);
  C.MERGE_SIDE = git(w, 'rev-parse', 'HEAD');

  // A branch the author pushed unreviewed code to, retargeted the PR onto, and merged in.
  at(C.F0);
  write('evil.txt', 'unreviewed\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'unreviewed code');
  git(w, 'branch', 'evil', 'HEAD');
  at(C.X);
  git(w, 'merge', '-q', '--no-edit', 'evil');
  C.MERGE_EVIL = git(w, 'rev-parse', 'HEAD');

  // A base that edits the PR's own line: the merge conflicts and is fixed by hand.
  at(C.F0);
  edit('f.txt', 'b\n', 'B-main\n');
  C.CONFLICT_BASE = commit('base edits the PR line');
  git(w, 'branch', 'conflict-main', C.CONFLICT_BASE);
  at(C.X);
  git(w, 'merge', '-q', '--no-commit', C.CONFLICT_BASE);
  edit('f.txt', /<<<<<<<[^]*?>>>>>>> [^\n]*\n/, 'B-both\n');
  C.CONFLICT_FIX = commit('merge base, conflict fixed by hand');

  // A rebase onto main. The approved commit is left on no branch, as after a force push.
  at(C.F0);
  edit('f.txt', 'd\n', 'D-pr\n');
  C.XR = commit('pr change to rebase');
  at(C.M2);
  git(w, 'cherry-pick', C.XR);
  C.REBASED = git(w, 'rev-parse', 'HEAD');
  write('pr.txt', 'slipped into the rebase\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '--amend', '--no-edit');
  C.REBASED_EDIT = git(w, 'rev-parse', 'HEAD');

  // Two merge bases: the base branch merged the PR's commit P1, and the PR merged the base.
  at(C.F0);
  edit('f.txt', 'h\n', 'H-pr\n');
  C.P1 = commit('pr commit the base merges');
  at(C.F0);
  edit('f.txt', 'e\n', 'E-base\n');
  C.A = commit('base commit');
  git(w, 'merge', '-q', '--no-edit', C.P1);
  git(w, 'branch', 'cc-main', 'HEAD');
  at(C.P1);
  git(w, 'merge', '-q', '--no-edit', C.A);
  C.CRISS_CROSS = git(w, 'rev-parse', 'HEAD');

  // A default branch that adds vuln.txt and later removes it. The approved
  // commit forks after the addition; a head with the approved tree, forked
  // before the addition, would bring vuln.txt back when merged.
  at(C.F0);
  write('rw.txt', 'rw\n');
  C.RW1 = commit('rw base');
  write('vuln.txt', 'vulnerable\n');
  C.RW2 = commit('rw base adds vuln.txt');
  fs.unlinkSync(path.join(w, 'vuln.txt'));
  git(w, 'branch', 'rw-main', commit('rw base removes vuln.txt'));
  at(C.RW2);
  edit('f.txt', 'c\n', 'C-pr\n');
  C.RA = commit('pr change on the rw base');
  C.REWIND = git(w, 'commit-tree', `${C.RA}^{tree}`, '-p', C.RW1, '-m', 'approved tree on an older fork point');

  // The same, sideways: the head forks from a side commit the default branch merged.
  at(C.F0);
  write('vuln2.txt', 'vulnerable\n');
  C.SW1 = commit('sw base adds vuln2.txt');
  fs.unlinkSync(path.join(w, 'vuln2.txt'));
  const sw2 = commit('sw base removes vuln2.txt');
  at(C.F0);
  write('side2.txt', 'side\n');
  C.SWS = commit('side commit');
  at(sw2);
  git(w, 'merge', '-q', '--no-edit', C.SWS);
  git(w, 'branch', 'sw-main', 'HEAD');
  at(C.SW1);
  edit('f.txt', 'c\n', 'C-pr\n');
  C.SA = commit('pr change on the sw base');
  const sideways = git(w, 'merge-tree', '--write-tree', C.SA, C.SWS);
  C.SIDEWAYS = git(w, 'commit-tree', sideways, '-p', C.SWS, '-m', 'approved tree merged with a side commit');

  for (const [name, sha] of Object.entries(C)) git(w, 'update-ref', `refs/keep/${name}`, sha);
  const origin = path.join(SERVER, 'o/r.git');
  git(TMP, 'init', '-q', '--bare', origin);
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(w, 'push', '-q', origin, 'refs/heads/*:refs/heads/*', 'refs/keep/*:refs/keep/*');
  git(origin, 'update-ref', '-d', 'refs/keep/XR');
  git(origin, 'update-ref', '-d', 'refs/keep/REBASED_EDIT');
}

function setup() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-withdraw-action-'));
  SERVER = path.join(TMP, 'server');
  const action = parse(fs.readFileSync(path.join(ROOT, '.github/actions/withdraw/action.yml'), 'utf8'));
  SCRIPT = path.join(TMP, 'withdraw.sh');
  fs.writeFileSync(SCRIPT, action.runs.steps.find((s) => s.run).run);
  BIN = path.join(TMP, 'bin');
  fs.mkdirSync(BIN);
  fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });
  // Logs each git call's arguments, and whether its environment carried the
  // auth header, without logging the header.
  fs.writeFileSync(
    path.join(BIN, 'git'),
    `#!/bin/sh\ncase "\${GIT_CONFIG_VALUE_0:-}" in "AUTHORIZATION: basic $EXPECTED_AUTH") a=auth ;; *) a=noauth ;; esac\nprintf '%s %s\\n' "$a" "$*" >> "$GIT_LOG"\nexec "${GIT}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.symlinkSync(JQ, path.join(BIN, 'jq'));
  buildOrigin();
}

// The fixture's default branch is the PR's base unless a scenario says otherwise.
const pr = ({ head, base = 'main', state = 'open', defaultBranch = base, labels = [], headRepo = 'o/r', headBranch = 'pr-branch', updatedAt, author = 'alice', mergeable = null }) =>
  JSON.stringify({
    state,
    mergeable,
    user: { login: author },
    head: { sha: head, ref: headBranch, repo: { full_name: headRepo } },
    base: { ref: base, repo: { default_branch: defaultBranch } },
    labels: labels.map((name) => ({ name })),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  });
// The repo's CI caller, as the contents API returns it.
const STOCK_CALLER = fs.readFileSync(path.join(ROOT, 'templates/workflows/agent-review.yml'), 'utf8');
const callerJson = (text) => JSON.stringify({ content: Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') });
const APPROVED_AT = '2026-11-02T12:00:00Z';
const review = (id, commit, { login = BOT, state = 'APPROVED', body = BODY, submitted = APPROVED_AT } = {}) => ({
  id,
  user: login === null ? null : { login },
  state,
  commit_id: commit,
  body,
  submitted_at: submitted,
});
const baseChanged = (at) => ({ event: 'base_ref_changed', created_at: at, actor: { login: 'alice' } });
// GitHub's updated_at on the PR as the event saw it, and on reads before and after it.
const EVENT_AT = '2026-11-05T10:00:05Z';
const BEFORE_EVENT = '2026-11-05T10:00:00Z';
const AFTER_EVENT = '2026-11-05T10:00:30Z';
// A pull_request_target synchronize event: its before, its after, and its PR snapshot.
const sync = (before, after, { at = EVENT_AT, snapshotHead = after } = {}) => ({
  expectedHead: after,
  eventBefore: before,
  eventAfter: after,
  eventHead: snapshotHead,
  eventAt: at,
});

function run(
  name,
  {
    head,
    base,
    defaultBranch,
    state,
    labels,
    reviews = [],
    timeline = [],
    later,
    stale,
    files = {},
    prNumber = '7',
    expectedHead = '',
    event = 'pull_request_target',
    action = 'synchronize',
    headRepo,
    caller,
    // PR reads in order, the last one repeating: { head, updatedAt, state } or 'fail'.
    reads,
    previousHead = '',
    eventBefore = '',
    eventAfter = '',
    eventHead = '',
    eventAt = '',
    actor = 'alice',
    author,
    mergeable,
    // The files the PR changes, as the files API lists them.
    changed = [],
  },
) {
  const dir = path.join(TMP, 'runs', name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60));
  const fix = path.join(dir, 'fix');
  const runner = path.join(dir, 'tmp');
  for (const d of [fix, runner]) fs.mkdirSync(d, { recursive: true });
  const readFiles = {};
  for (const [i, r] of (reads || []).entries()) {
    if (r === 'fail') readFiles[`read-${i + 1}.fail`] = '';
    else if (typeof r === 'string') readFiles[`read-${i + 1}.json`] = r;
    else readFiles[`read-${i + 1}.json`] = pr({ base, defaultBranch, labels, headRepo, author, mergeable, ...r });
  }
  if (reads) readFiles['reads-count'] = String(reads.length);
  const all = {
    'pr.json': pr({ head, base, state, defaultBranch, labels, headRepo, author, mergeable }),
    'files.json': JSON.stringify(changed.map((filename) => ({ filename }))),
    ...readFiles,
    ...(caller !== undefined ? { 'caller.json': callerJson(caller) } : {}),
    // Two pages, as gh --paginate prints them.
    'reviews.json': JSON.stringify(reviews.slice(0, 1)) + JSON.stringify(reviews.slice(1)),
    'timeline.json': JSON.stringify([{ event: 'commented' }]) + JSON.stringify(timeline),
    ...(later ? { 'pr-later.json': pr({ head: later, base, defaultBranch, labels, headRepo }) } : {}),
    // The PR as GitHub shows it for the first `count` reads, before the head moves to the push.
    ...(stale ? { 'pr-stale.json': pr({ head: stale.head, base, defaultBranch, labels, headRepo }), 'stale-reads': String(stale.count) } : {}),
    ...files,
  };
  for (const [f, v] of Object.entries(all)) fs.writeFileSync(path.join(fix, f), v);
  const env = {
    PATH: `${BIN}:/usr/bin:/bin`,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_LOG: path.join(dir, 'gh.log'),
    GIT_LOG: path.join(dir, 'git.log'),
    FIX: fix,
    RUNNER_TEMP: runner,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GH_TOKEN: TOKEN,
    EXPECTED_AUTH: TOKEN_HEADER,
    AGENT_REVIEW_RETRY_DELAY: '0',
    AGENT_REVIEW_POLL_DELAY: '0',
    REPO: 'o/r',
    PR: prNumber,
    EXPECTED_HEAD: expectedHead,
    SERVER_URL: `file://${SERVER}`,
    EVENT_NAME: event,
    EVENT_ACTION: action,
    PREVIOUS_HEAD: previousHead,
    EVENT_BEFORE: eventBefore,
    EVENT_AFTER: eventAfter,
    EVENT_HEAD: eventHead,
    EVENT_UPDATED_AT: eventAt,
    ACTOR: actor,
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
  };
  for (const f of [env.GH_LOG, env.GIT_LOG, env.GITHUB_STEP_SUMMARY, env.GITHUB_OUTPUT]) fs.writeFileSync(f, '');
  return new Promise((resolve) => {
    // The runner's composite `shell: bash` runs `bash --noprofile --norc -eo pipefail {0}`.
    const child = spawn(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', SCRIPT], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
      const lines = read('gh.log').split('\n');
      const writes = lines.filter((l) => l.startsWith('api ¦ -X ¦ '));
      resolve({
        code,
        stdout,
        stderr,
        ghCalls: lines.filter(Boolean),
        writes,
        dismissed: writes.filter((w) => w.includes('/dismissals')).map((w) => Number(w.match(/reviews\/(\d+)\//)[1])),
        messages: read('dismiss-messages.txt').split('\n').filter(Boolean),
        gitLog: read('git.log').split('\n').filter(Boolean),
        gitCalls: read('git.log').split('\n').filter(Boolean).map((l) => l.replace(/^(no)?auth /, '')),
        summary: read('summary.md'),
        outputs: read('output.txt').split('\n').filter(Boolean),
        prReads: lines.filter((l) => l.startsWith('api ¦ repos/o/r/pulls/7 ¦ ')).length,
        pending: fs.existsSync(path.join(runner, 'agent-review-withdraw.pending')),
        leftovers: fs.readdirSync(runner).filter((f) => f !== 'agent-review-withdraw.pending'),
      });
    });
  });
}

function common(o) {
  assert.equal(o.code, 0, `the step never fails\n${o.stderr}`);
  const live = o.stdout.split('\n').filter((l) => l.startsWith('::'));
  assert.deepEqual(
    live.filter((l) => !l.startsWith('::warning::') && !l.startsWith('::add-mask::')),
    [],
    'only warnings and the token mask reach the runner as workflow commands',
  );
  assert.deepEqual(o.leftovers, [], 'the bare repository and the token-bearing work files are removed');
  assert.equal(o.outputs.length, 1, `one output, set on every exit\n${o.outputs.join('\n')}`);
  assert.match(o.outputs[0], /^complete=(true|false)$/);
  if (o.outputs[0] === 'complete=true') assert.equal(o.pending, false, 'a complete run leaves no pending mark');
  for (const call of o.gitCalls) {
    assert.ok(!/^(checkout|switch|worktree|clone|reset|restore|read-tree|archive)\b/.test(call), `git never builds a work tree: ${call}`);
  }
  for (const line of [...o.gitLog, ...o.ghCalls]) {
    assert.ok(!line.includes(TOKEN) && !line.includes(TOKEN_HEADER), `the token never reaches a command line: ${line}`);
  }
  for (const line of o.gitLog.filter((l) => / fetch /.test(l))) {
    assert.ok(line.startsWith('auth '), `every fetch gets the token through its environment: ${line}`);
  }
}
const kept = (o) => assert.deepEqual(o.dismissed, []);
const noGit = (o) => assert.deepEqual(o.gitCalls, [], 'no candidate means no fetch');
const complete = (o) => assert.deepEqual(o.outputs, ['complete=true'], 'nothing that had to go was left');
const incomplete = (o) => assert.deepEqual(o.outputs, ['complete=false'], 'an approval may still stand');
const warnings = (o) => o.stdout.split('\n').filter((l) => l.startsWith('::warning::'));
const RE_REVIEW = 'Run /agent-review:re-review (or /agent-review:review) and post the report. The bot approves again when the report passes for the new head.';
const CI_RERUNS = 'The CI review runs again on its own, and the bot approves again when it passes.';

const SCENARIOS = {
  'a clean merge of the base branch keeps the approval': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, new RegExp(`Kept the bot's approval of ${C.X} on PR #7 \\(review 21\\): since then the PR only merged in or rebased onto the default branch`));
      assert.ok(o.gitCalls.some((c) => c.startsWith('init --quiet --bare --template= ')), 'a bare repository with no hooks');
      assert.ok(o.gitCalls.some((c) => c.startsWith('--git-dir=') && c.includes(' merge-tree --write-tree --no-messages ')));
    },
  ],
  'two merges of the base branch in a row keep the approval': [
    () => ({ head: C.MERGE2, reviews: [review(21, C.X)] }),
    kept,
  ],
  'the approval of a merge is kept after the next merge too': [
    () => ({ head: C.MERGE2, reviews: [review(21, C.MERGE1)] }),
    kept,
  ],
  'a no-change rebase onto the base branch keeps the approval, though the approved commit is on no branch': [
    () => ({ head: C.REBASED, reviews: [review(21, C.XR)] }),
    kept,
  ],
  'commits that cancel out keep the approval': [
    () => ({ head: C.CANCEL, reviews: [review(21, C.X)] }),
    kept,
  ],
  'a new commit withdraws the approval and says what to do next': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.messages.length, 1);
      assert.deepEqual(o.messages, [
        `agent-review: the bot took back its approval of ${C.X.slice(0, 7)} because the PR changed beyond merging in the default branch. ` +
          'Run /agent-review:re-review (or /agent-review:review) and post the report. The bot approves again when the report passes for the new head.',
      ]);
      assert.match(o.summary, new RegExp(`Withdrew the bot's approval of ${C.X} on PR #7 \\(review 21\\): the PR changed beyond merging in the default branch\\.`));
      complete(o);
    },
  ],
  'on a push to a labelled PR in a repo with the stock CI caller, the message says the CI review runs again': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, reviews: [review(21, C.X)] }),
    (o) => {
      assert.equal(o.messages.length, 1);
      assert.ok(o.messages[0].endsWith(` ${CI_RERUNS}`), o.messages[0]);
      assert.ok(o.ghCalls.some((l) => l.includes('contents/.github/workflows/agent-review.yml?ref=main ')), 'the caller is read from the base branch');
      assert.ok(o.ghCalls.some((l) => l.includes('pulls/7/files?per_page=100')), 'and the PR\'s files, to see if it changes the caller');
      assert.ok(!o.ghCalls.some((l) => l.includes(`ref=${C.NEW} `)), 'a PR that does not change the caller runs the base\'s copy');
    },
  ],
  'a fork PR never gets a CI review, so the message asks for a re-review': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, headRepo: 'someone/r', reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].includes('Run /agent-review:re-review'), o.messages[0]),
  ],
  'a CI caller with its own label gate gets the re-review wording': [
    () => ({
      head: C.NEW,
      labels: ['agent-review'],
      caller: STOCK_CALLER.replace("contains(github.event.pull_request.labels.*.name, 'agent-review') &&", "contains(github.event.pull_request.labels.*.name, 'ai-review') &&"),
      reviews: [review(21, C.X)],
    }),
    (o) => assert.ok(o.messages[0].includes('Run /agent-review:re-review'), o.messages[0]),
  ],
  'a repo with no CI caller gets the re-review wording, though the PR has the label': [
    () => ({ head: C.NEW, labels: ['agent-review'], reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].includes('Run /agent-review:re-review'), o.messages[0]),
  ],
  'a base change on a labelled PR starts no CI review, so the message asks for a re-review': [
    () => ({ head: C.NEW, action: 'edited', labels: ['agent-review'], reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].includes('Run /agent-review:re-review'), o.messages[0]),
  ],
  'a fetch failure says so in the PR, not that the PR changed': [
    () => ({ head: C.MERGE1, reviews: [review(21, 'e'.repeat(40))] }),
    (o) => {
      assert.ok(o.messages[0].includes(' because it could not fetch the approved commit. '), o.messages[0]);
      assert.equal(o.gitCalls.filter((c) => c.includes(` fetch `) && c.endsWith('e'.repeat(40))).length, 3, 'the fetch is tried three times');
    },
  ],
  'an interact push: GitHub shows the old head at first, so the action waits for the pushed one': [
    () => ({ head: C.NEW, expectedHead: C.NEW, stale: { head: C.X, count: 2 }, event: 'issue_comment', action: 'created', labels: ['agent-review'], reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'the approval of the old head is a candidate and is withdrawn');
      assert.equal(o.ghCalls.filter((l) => l.startsWith('api ¦ repos/o/r/pulls/7 ¦ ')).length, 4, 'two stale reads, the matching read, then the read before dismissing');
      assert.ok(!o.stdout.includes('::warning::'));
      assert.ok(o.messages[0].includes('Run /agent-review:re-review'), 'a workflow-token push starts no CI review');
    },
  ],
  'a pushed head GitHub never shows: the old approval is withdrawn, though the API still shows its commit': [
    () => ({ head: C.NEW, expectedHead: C.NEW, previousHead: C.X, stale: { head: C.X, count: 1000 }, event: 'issue_comment', action: 'created', reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'a stale read cannot keep the old approval');
      assert.match(
        o.stdout,
        new RegExp(
          `^::warning::GitHub did not show ${C.NEW} as the head of PR #7 in time \\(it still shows ${C.X}, the commit before it\\), so every bot approval of another commit is taken back without checking it\\.$`,
          'm',
        ),
      );
      assert.ok(!o.stdout.includes('just pushed'), 'nothing claims a push it cannot see');
      assert.equal(o.prReads, 21, 'one read and twenty polls, and no read before dismissing');
      assert.ok(!o.ghCalls.some((l) => l.includes('/git/ref')), 'no PR or branch ref is read');
      assert.deepEqual(o.gitCalls, [], 'no commit check runs');
      assert.ok(!o.ghCalls.some((l) => l.includes('/timeline')), 'no keep rule, so no timeline');
      assert.ok(o.messages[0].includes(`because GitHub did not show ${C.NEW.slice(0, 7)} as the PR's head in time, so it could not check the approval. `), o.messages[0]);
      complete(o);
    },
  ],
  'a pushed head GitHub never shows: an approval of a newer commit built on it is withdrawn too': [
    () => ({ head: C.MERGE1, expectedHead: C.MERGE1, stale: { head: C.MERGE_THEN_NEW, count: 1000 }, event: 'issue_comment', action: 'created', reviews: [review(21, C.MERGE_THEN_NEW)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a pushed head GitHub never shows: an approval of the pushed commit itself is kept': [
    () => ({ head: C.NEW, expectedHead: C.NEW, stale: { head: C.X, count: 1000 }, event: 'issue_comment', action: 'created', reviews: [review(21, C.X), review(22, C.NEW)] }),
    (o) => assert.deepEqual(o.dismissed, [21], 'only the approval of another commit goes'),
  ],
  'a pushed head GitHub never shows: a force-push back to an older commit withdraws the approval of the newer one': [
    // The bot approved D, then the author force-pushed back to E, an ancestor of D.
    () => ({ head: C.MERGE1, expectedHead: C.MERGE1, stale: { head: C.MERGE_THEN_NEW, count: 1000 }, reviews: [review(21, C.MERGE_THEN_NEW)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a pushed head GitHub never shows: an approval the keep rule would keep is withdrawn too': [
    () => ({ head: C.MERGE1, expectedHead: C.MERGE1, stale: { head: C.X, count: 1000 }, reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'a clean merge of main, but the head could not be confirmed');
      assert.deepEqual(o.gitCalls, []);
    },
  ],
  'a fork PR whose pushed head GitHub never shows is judged the same way, and the fork is never read': [
    () => ({ head: C.NEW, expectedHead: C.NEW, stale: { head: C.X, count: 1000 }, headRepo: 'someone/r', reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.ghCalls.some((l) => l.includes('repos/someone/')), 'the fork is never read');
    },
  ],
  'with the head shown in time, a force-push back to an older commit withdraws the approval of the newer one': [
    () => ({ head: C.MERGE1, expectedHead: C.MERGE1, reviews: [review(21, C.MERGE_THEN_NEW)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.stdout.includes('::warning::'));
      assert.match(o.summary, /\(review 21\): the PR changed beyond merging in the default branch\./);
    },
  ],
  'with the head shown in time, the keep rule still keeps a clean merge of the default branch': [
    () => ({ head: C.MERGE1, expectedHead: C.MERGE1, stale: { head: C.X, count: 1 }, reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.ok(!o.stdout.includes('::warning::'));
    },
  ],
  'a pull_request_target run with the event\'s head waits for a lagging API': [
    () => ({ head: C.NEW, expectedHead: C.NEW, stale: { head: C.X, count: 1 }, reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.stdout.includes('::warning::'));
    },
  ],
  'a stale event: a later read shows a newer push, so waiting stops and only that head\'s approval from after the event stays': [
    () => ({
      head: C.NEW,
      ...sync(C.X, C.NEW),
      reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }],
      labels: ['agent-review'],
      caller: STOCK_CALLER,
      reviews: [review(21, C.X), review(22, C.MERGE1, { submitted: AFTER_EVENT }), review(23, C.NEW)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21, 23], 'one the keep rule would keep goes, and so does the event\'s own head\'s');
      assert.equal(o.prReads, 1, 'no waiting, and no read before dismissing');
      assert.deepEqual(o.gitCalls, [], 'no keep rule');
      assert.ok(!o.ghCalls.some((l) => l.includes('/timeline') || l.includes('/contents/')), 'no timeline or caller read');
      assert.deepEqual(warnings(o), [], 'a superseded event is normal');
      assert.match(o.summary, new RegExp(`PR #7 moved on from ${C.NEW} to ${C.MERGE1} after the event this run is for`));
      assert.deepEqual(o.messages, [
        `agent-review: the bot took back its approval of ${C.X.slice(0, 7)} because newer commits moved the PR's head on to ${C.MERGE1.slice(0, 7)}. ${RE_REVIEW}`,
        `agent-review: the bot took back its approval of ${C.NEW.slice(0, 7)} because newer commits moved the PR's head on to ${C.MERGE1.slice(0, 7)}. ${RE_REVIEW}`,
      ]);
      complete(o);
    },
  ],
  'a stale event: an approval of the newer head from before the event goes, since the head went away and back': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }], reviews: [review(22, C.MERGE1)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [22]);
      assert.ok(o.messages[0].includes(`because it was given before the PR's head moved away from ${C.MERGE1.slice(0, 7)} and back, so it could not check the approval. `), o.messages[0]);
    },
  ],
  'a stale event: an approval of the newer head given in the same second as the event goes': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }], reviews: [review(22, C.MERGE1, { submitted: EVENT_AT })] }),
    (o) => assert.deepEqual(o.dismissed, [22]),
  ],
  'out of order: the run for an older push that sees the PR rewound later takes back the newer commit\'s approval': [
    // The bot approved D after it was pushed, and then the author force-pushed back to E, an ancestor of D.
    () => ({
      head: C.MERGE_THEN_NEW,
      ...sync(C.X, C.MERGE_THEN_NEW),
      reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }],
      reviews: [review(21, C.MERGE_THEN_NEW, { submitted: AFTER_EVENT })],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'D is not the newer head, so its approval goes, whenever it was given');
      assert.deepEqual(o.gitCalls, [], 'no ancestry check');
    },
  ],
  'the rewind that broke the descendant rule: a read still showing the newer commit is the commit before the push': [
    // The bot approved D, then the author force-pushed back to E. The event's before is D.
    () => ({
      head: C.MERGE1,
      ...sync(C.MERGE_THEN_NEW, C.MERGE1),
      reads: [{ head: C.MERGE_THEN_NEW, updatedAt: BEFORE_EVENT }],
      reviews: [review(21, C.MERGE_THEN_NEW)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 21, 'it waits the full minute');
      assert.match(warnings(o)[0], new RegExp(`\\(it still shows ${C.MERGE_THEN_NEW}, the commit before it\\)`));
      assert.deepEqual(o.gitCalls, [], 'no ancestry check');
    },
  ],
  'a read of the commit before the push is never trusted, even with a later time': [
    () => ({
      head: C.MERGE1,
      ...sync(C.MERGE_THEN_NEW, C.MERGE1),
      reads: [{ head: C.MERGE_THEN_NEW, updatedAt: AFTER_EVENT }],
      reviews: [review(21, C.MERGE_THEN_NEW, { submitted: AFTER_EVENT })],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 21);
    },
  ],
  'a read of a third commit with no later time is not trusted: it can be older than the push': [
    // Two pushes GitHub has not caught up with: it still shows X, from before the event's before.
    () => ({
      head: C.MERGE2,
      ...sync(C.MERGE1, C.MERGE2),
      reads: [{ head: C.X, updatedAt: BEFORE_EVENT }],
      labels: ['agent-review'],
      caller: STOCK_CALLER,
      reviews: [review(21, C.X)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'the head GitHub shows is not trusted, so its approval goes');
      assert.equal(o.prReads, 21);
      assert.match(warnings(o)[0], new RegExp(`\\(it shows ${C.X}, and nothing shows that commit is newer\\)`));
      assert.ok(!o.ghCalls.some((l) => l.includes('/timeline')), 'no keep rule, so no timeline');
      assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), 'an unconfirmed head never promises a CI review');
      complete(o);
    },
  ],
  'a read of a third commit in the same second as the event is not trusted': [
    () => ({ head: C.MERGE2, ...sync(C.MERGE1, C.MERGE2), reads: [{ head: C.X, updatedAt: EVENT_AT }], reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 21);
    },
  ],
  'an event whose PR snapshot is at another head gives no time to trust': [
    () => ({
      head: C.NEW,
      ...sync(C.X, C.NEW, { snapshotHead: C.X }),
      reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }],
      reviews: [review(22, C.MERGE1, { submitted: AFTER_EVENT })],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [22]);
      assert.equal(o.prReads, 21);
    },
  ],
  'a base change that a push superseded moves on too, with no before to wait on': [
    () => ({
      head: C.NEW,
      action: 'edited',
      expectedHead: C.NEW,
      eventHead: C.NEW,
      eventAt: EVENT_AT,
      reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }],
      reviews: [review(21, C.NEW), review(22, C.MERGE1, { submitted: AFTER_EVENT })],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 1);
    },
  ],
  'interact: a read of another commit is never trusted, since the bot\'s own push has no event to time it': [
    () => ({
      head: C.NEW,
      expectedHead: C.NEW,
      previousHead: C.X,
      event: 'issue_comment',
      action: 'created',
      reads: [{ head: C.MERGE1, updatedAt: AFTER_EVENT }],
      reviews: [review(21, C.X), review(22, C.MERGE1, { submitted: AFTER_EVENT })],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21, 22]);
      assert.equal(o.prReads, 21);
      assert.match(warnings(o)[0], new RegExp(`\\(it shows ${C.MERGE1}, and nothing shows that commit is newer\\)`));
    },
  ],
  'a head GitHub shows in time keeps the CI wording': [
    () => ({
      head: C.NEW,
      ...sync(C.X, C.NEW),
      reads: [{ head: C.X, updatedAt: BEFORE_EVENT }, { head: C.NEW, updatedAt: EVENT_AT }],
      labels: ['agent-review'],
      caller: STOCK_CALLER,
      reviews: [review(21, C.X)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(o.messages[0].endsWith(` ${CI_RERUNS}`), o.messages[0]);
      complete(o);
    },
  ],
  'a failed read while waiting keeps the last good read and goes on waiting': [
    () => ({
      head: C.NEW,
      ...sync(C.X, C.NEW),
      reads: [{ head: C.X, updatedAt: BEFORE_EVENT }, 'fail', { head: C.NEW, updatedAt: EVENT_AT }],
      reviews: [review(21, C.X)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 4, 'one read, a failed poll tried once, the read that shows the head, and the read before dismissing');
      assert.deepEqual(warnings(o), []);
      assert.match(o.summary, /\(review 21\): the PR changed beyond merging in the default branch\./, 'the keep rule ran');
      complete(o);
    },
  ],
  'a PR that cannot be read at all falls to the fail-closed path': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: ['fail'], reviews: [review(21, C.X), review(22, C.NEW)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'only the expected head\'s approval stays');
      assert.equal(o.prReads, 21, 'each poll read is tried once, so an outage fails closed in about a minute');
      assert.match(warnings(o)[0], /\(the PR could not be read\)/);
      complete(o);
    },
  ],
  'an old read that shows the PR closed does not stop the fail-closed path': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.X, state: 'closed', updatedAt: BEFORE_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.summary.includes('is not open'));
    },
  ],
  'a read that is not a JSON object is not used': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: ['<html>busy</html>', { head: C.NEW, updatedAt: EVENT_AT }], reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.equal(o.prReads, 3, 'the bad read, the read that shows the head, and the read before dismissing');
      assert.deepEqual(warnings(o), []);
    },
  ],
  'a CI caller that does not auto-approve gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER.replace('auto_approve: true', 'auto_approve: false'), reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a CI caller with no auto_approve line never approves, so it gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER.replace(/^ *auto_approve: true\n/m, ''), reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a CI caller in shadow mode gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER.replace('rollout_mode: advisory', 'rollout_mode: shadow'), reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a CI caller with no rollout mode runs in shadow, so it gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER.replace(/^ *rollout_mode: advisory\n/m, ''), reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a label gate found only in a comment gets the re-review wording': [
    () => ({
      head: C.NEW,
      labels: ['agent-review'],
      caller: `# was: contains(github.event.pull_request.labels.*.name, 'agent-review') &&\n${STOCK_CALLER.replace(
        "contains(github.event.pull_request.labels.*.name, 'agent-review') &&",
        "contains(github.event.pull_request.labels.*.name, 'ai-review') &&",
      )}`,
      reviews: [review(21, C.X)],
    }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a PR that changes the CI caller needs its own copy to approve too': [
    () => ({
      head: C.NEW,
      labels: ['agent-review'],
      caller: STOCK_CALLER,
      changed: ['.github/workflows/agent-review.yml'],
      files: { [`caller-${C.NEW}.json`]: callerJson(STOCK_CALLER.replace('auto_approve: true', 'auto_approve: false')) },
      reviews: [review(21, C.X)],
    }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a push by Dependabot gets the re-review wording, since its CI runs get no secrets': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, actor: 'dependabot[bot]', reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a Dependabot PR gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, author: 'dependabot[bot]', reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a lagging re-read that still shows the approved commit does not keep it': [
    // The bot approved X, the author pushed NEW, and the read before dismissing lags.
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.NEW, updatedAt: EVENT_AT }, { head: C.X, updatedAt: BEFORE_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.summary.includes('again, so the bot\'s approval of it is kept'));
      complete(o);
    },
  ],
  'interact: a re-read of the approved commit in the same second as the trusted read does not keep it': [
    () => ({
      head: C.NEW,
      expectedHead: C.NEW,
      previousHead: C.X,
      event: 'issue_comment',
      action: 'created',
      reads: [{ head: C.NEW, updatedAt: EVENT_AT }, { head: C.X, updatedAt: EVENT_AT }],
      reviews: [review(21, C.X)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      complete(o);
    },
  ],
  'a force-push back to the approved commit during the run, with a later time, keeps the approval': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.NEW, updatedAt: EVENT_AT }, { head: C.X, updatedAt: AFTER_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, new RegExp(`The head of PR #7 is ${C.X} again, so the bot's approval of it is kept \\(review 21\\)`));
      complete(o);
    },
  ],
  'reopened: a lagging read that still shows the PR closed does not stop the run': [
    () => ({
      head: C.NEW,
      action: 'reopened',
      expectedHead: C.NEW,
      eventHead: C.NEW,
      eventAt: EVENT_AT,
      reads: [{ head: C.NEW, state: 'closed', updatedAt: BEFORE_EVENT }],
      reviews: [review(21, C.X)],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.ok(!o.summary.includes('is not open'));
    },
  ],
  'a closed read later than the event stops the run': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.NEW, state: 'closed', updatedAt: AFTER_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, /PR #7 is not open, so no approval was withdrawn\./);
      assert.ok(!o.ghCalls.some((l) => l.includes('/reviews')), 'the reviews are not read');
      complete(o);
    },
  ],
  'a stale event on a PR merged since then stops the run instead of dismissing': [
    () => ({ head: C.NEW, ...sync(C.X, C.NEW), reads: [{ head: C.MERGE1, state: 'closed', updatedAt: AFTER_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, /PR #7 is not open, so no approval was withdrawn\./);
      complete(o);
    },
  ],
  'interact: with no event time, a closed read of the pushed commit still stops the run': [
    () => ({
      head: C.NEW,
      expectedHead: C.NEW,
      previousHead: C.X,
      event: 'issue_comment',
      action: 'created',
      reads: [{ head: C.NEW, state: 'closed', updatedAt: AFTER_EVENT }],
      reviews: [review(21, C.X)],
    }),
    (o) => {
      kept(o);
      complete(o);
    },
  ],
  'a PR that cannot be read with no expected head stops before the reviews, so nothing is pending': [
    () => ({ head: C.NEW, reads: ['fail'], reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      incomplete(o);
      assert.equal(o.pending, false, 'an outage before the reviews never tells the PR');
      assert.ok(!o.ghCalls.some((l) => l.includes('/reviews')));
    },
  ],
  'a PR with a merge conflict gets the re-review wording, since it gets no pull_request run': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, mergeable: false, reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a PR whose files cannot be read gets the re-review wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, files: { 'fail-files': '' }, reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${RE_REVIEW}`), o.messages[0]),
  ],
  'a PR with no merge conflict keeps the CI wording': [
    () => ({ head: C.NEW, labels: ['agent-review'], caller: STOCK_CALLER, mergeable: true, reviews: [review(21, C.X)] }),
    (o) => assert.ok(o.messages[0].endsWith(` ${CI_RERUNS}`), o.messages[0]),
  ],
  'an expected head that is not a SHA is refused': [
    () => ({ head: C.NEW, expectedHead: 'main', reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      noGit(o);
      incomplete(o);
      assert.match(o.stdout, /^::warning::agent-review withdraw got an expected head that is not a commit SHA/m);
    },
  ],
  'a merge of the base branch with an extra change withdraws': [
    () => ({ head: C.EVIL_MERGE, reviews: [review(21, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a merge conflict fixed by hand withdraws': [
    () => ({ head: C.CONFLICT_FIX, base: 'conflict-main', reviews: [review(21, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a merge of the base branch followed by a new commit withdraws': [
    () => ({ head: C.MERGE_THEN_NEW, reviews: [review(21, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a rebase that changes the code withdraws': [
    () => ({ head: C.REBASED_EDIT, reviews: [review(21, C.XR)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a merge of a branch that is not the base withdraws': [
    () => ({ head: C.MERGE_SIDE, reviews: [review(21, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'two merge bases withdraw even when the merge itself is clean': [
    () => ({ head: C.CRISS_CROSS, base: 'cc-main', reviews: [review(21, C.P1)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR has more than one merge base with the default branch\./);
    },
  ],
  'a head forked from before the approved fork point withdraws, though its tree is the approved tree': [
    () => ({ head: C.REWIND, base: 'rw-main', reviews: [review(21, C.RA)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR's fork point moved back or sideways on the default branch\./);
    },
  ],
  'a head forked from a side commit the default branch merged withdraws': [
    () => ({ head: C.SIDEWAYS, base: 'sw-main', reviews: [review(21, C.SA)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR's fork point moved back or sideways on the default branch\./);
    },
  ],
  'an approved commit that cannot be fetched withdraws, and says so': [
    () => ({ head: C.MERGE1, reviews: [review(21, 'e'.repeat(40))] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): it could not fetch the approved commit\./);
    },
  ],
  'a base branch that cannot be fetched withdraws every candidate': [
    () => ({ head: C.MERGE1, base: 'gone', reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): it could not fetch the PR's base branch and head\./);
    },
  ],
  'a PR retargeted onto a branch the author pushed to, which it then merged in, withdraws': [
    () => ({ head: C.MERGE_EVIL, base: 'evil', defaultBranch: 'main', reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR's base branch is not the repo's default branch\./);
      noGit(o);
      assert.ok(!o.ghCalls.some((l) => l.includes('/timeline')), 'the timeline is not read for a base that cannot keep an approval');
    },
  ],
  'a clean merge of a base that is not the default branch withdraws': [
    () => ({ head: C.MERGE1, defaultBranch: 'trunk', reviews: [review(21, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a base change after the approval withdraws, even with a clean merge of the default branch': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)], timeline: [baseChanged('2026-11-03T08:00:00Z')] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR's base branch changed after the approval\./);
    },
  ],
  'a base change in the same second as the approval withdraws': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)], timeline: [baseChanged(APPROVED_AT)] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'a base change with no time withdraws': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)], timeline: [{ event: 'base_ref_changed' }] }),
    (o) => assert.deepEqual(o.dismissed, [21]),
  ],
  'GitHub\'s own retarget after a base branch is deleted counts as a base change': [
    () => ({
      head: C.MERGE1,
      reviews: [review(21, C.X)],
      timeline: [{ event: 'automatic_base_change_succeeded', created_at: '2026-11-03T08:00:00Z' }],
    }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): the PR's base branch changed after the approval\./);
    },
  ],
  'a base change before the approval keeps it': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)], timeline: [baseChanged('2026-11-01T08:00:00Z')] }),
    kept,
  ],
  'an unreadable timeline withdraws': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X)], files: { 'fail-timeline': '' } }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): it could not read when the PR's base branch last changed\./);
    },
  ],
  'an approval with no time withdraws': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X, { submitted: null })] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): it could not read when the approval was given\./);
    },
  ],
  'each approved commit is judged on its own': [
    () => ({ head: C.MERGE2, reviews: [review(21, C.X), review(22, C.NEW), review(23, C.X)] }),
    (o) => assert.deepEqual(o.dismissed, [22]),
  ],
  'only the bot\'s own approvals of an older commit are candidates': [
    () => ({
      head: C.NEW,
      reviews: [
        review(31, C.X, { login: 'alice' }),
        review(32, C.X, { body: '' }),
        review(33, C.X, { body: AI_REVIEW_BODY }),
        review(34, C.X, { body: 'Approved by another workflow.' }),
        review(35, C.X, { state: 'COMMENTED' }),
        review(36, C.X, { state: 'DISMISSED' }),
        review(37, C.X, { login: null }),
        review(38, C.X, { login: 'dependabot[bot]' }),
        review(39, C.NEW),
      ],
    }),
    (o) => {
      kept(o);
      noGit(o);
      assert.match(o.summary, /PR #7 has no agent-review approval of an older commit, so there is nothing to withdraw\./);
      complete(o);
    },
  ],
  'the bot\'s approvals from before the marker are withdrawn too': [
    () => ({
      head: C.NEW,
      reviews: [
        review(41, C.X, { body: 'Auto-approved: the agent-review report for this head passes with no open blockers.' }),
        review(42, C.X, { body: 'Auto-approved: the posted agent-review report covers the current head and passes.' }),
        review(43, C.X, { body: 'Auto-approved: every agent-review finding is fixed or dismissed with a reason.' }),
      ],
    }),
    (o) => assert.deepEqual(o.dismissed, [41, 42, 43]),
  ],
  'an approval of the head as it is when re-read later is never dismissed': [
    () => ({ head: C.NEW, reads: [{ head: C.NEW, updatedAt: BEFORE_EVENT }, { head: C.X, updatedAt: AFTER_EVENT }], reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, new RegExp(`The head of PR #7 is ${C.X} again, so the bot's approval of it is kept`));
      complete(o);
    },
  ],
  'a head that cannot be read again dismisses nothing and warns': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], files: { 'fail-pr-later': '' } }),
    (o) => {
      kept(o);
      assert.match(o.stdout, /^::warning::could not read the head of PR #7 again, so the bot's approval of [0-9a-f]{40} was not withdrawn \(review 21\)\. A person must dismiss it\.$/m);
      incomplete(o);
      assert.equal(o.pending, true);
    },
  ],
  'a token that may not dismiss skips cleanly with one warning, without retrying': [
    () => ({ head: C.NEW, reviews: [review(21, C.X), review(22, C.MERGE1)], files: { 'fail-dismiss-403': '' } }),
    (o) => {
      assert.equal(o.writes.length, 1, 'stops after the first refusal');
      incomplete(o);
      assert.equal(o.pending, true, 'an approval it could not take back is marked for the PR');
      assert.equal(warnings(o).length, 1);
      assert.match(
        warnings(o)[0],
        /GitHub refused to let this workflow dismiss reviews on PR #7 \(HTTP 403\), so the bot's approvals of older commits stay\. The token may lack pull-requests: write, a rule may limit who can dismiss reviews, or the API rate limit may be used up\./,
      );
    },
  ],
  'a rate limit is retried, then skips with the same warning': [
    () => ({ head: C.NEW, reviews: [review(21, C.X), review(22, C.MERGE1)], files: { 'fail-dismiss-rate': '' } }),
    (o) => {
      assert.deepEqual(o.dismissed, [21, 21, 21], 'three tries, then it stops');
      assert.equal(o.stdout.split('\n').filter((l) => l.startsWith('::warning::GitHub refused')).length, 1);
    },
  ],
  'any other dismissal failure is retried, then warns per approval': [
    () => ({ head: C.NEW, reviews: [review(21, C.X), review(22, C.MERGE1)], files: { 'fail-dismiss': '' } }),
    (o) => {
      assert.deepEqual(o.dismissed, [21, 21, 21, 22, 22, 22]);
      assert.equal(o.stdout.split('\n').filter((l) => l.startsWith('::warning::could not withdraw')).length, 2);
      incomplete(o);
    },
  ],
  'an approval that is already dismissed is noted, not warned about': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], files: { 'already-dismissed': '' } }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'a 422 is not retried');
      assert.ok(!o.stdout.includes('::warning::'));
      assert.match(o.summary, new RegExp(`The bot's approval of ${C.X} on PR #7 was already dismissed \\(review 21\\)\\.`));
      complete(o);
    },
  ],
  'a transient API error is retried': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], files: { 'fail-reviews-once': '' } }),
    (o) => {
      assert.equal(o.ghCalls.filter((l) => l.includes('/reviews?per_page=100')).length, 2);
      assert.deepEqual(o.dismissed, [21]);
    },
  ],
  'unreadable reviews withdraw nothing and warn': [
    () => ({ head: C.NEW, files: { 'fail-reviews': '' } }),
    (o) => {
      kept(o);
      noGit(o);
      assert.match(o.stdout, /^::warning::agent-review withdraw could not check PR #7 \(\S+ failed\), so no approval was withdrawn\.$/m);
      incomplete(o);
      assert.equal(o.pending, true, 'unreadable reviews are marked for the PR');
    },
  ],
  'a closed PR is left alone': [
    () => ({ head: C.NEW, state: 'closed', reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      noGit(o);
      assert.ok(!o.ghCalls.some((l) => l.includes('/reviews')), 'the reviews are not read');
      complete(o);
    },
  ],
  'a pull request number that is not a number is refused before any call': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], prNumber: '7/../../x' }),
    (o) => {
      kept(o);
      noGit(o);
      assert.match(o.stdout, /^::warning::agent-review withdraw needs a pull request number/m);
      incomplete(o);
      assert.equal(o.pending, false, 'a bad input never reads the reviews');
    },
  ],
};

test('withdraw action: keeps the approval only when the push merged in or rebased onto the default branch', { skip: SKIP }, async (t) => {
  setup();
  try {
    for (const [name, [scenario, check]] of Object.entries(SCENARIOS)) {
      await t.test(name, async () => {
        const o = await run(name, scenario());
        common(o);
        check(o);
      });
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});
