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
    if [ "$N" -ge 2 ] && has fail-pr-later; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi
    if [ "$N" -ge 2 ] && has pr-later.json; then emit "$FIX/pr-later.json"; else emit "$FIX/pr.json"; fi ;;
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
const pr = ({ head, base = 'main', state = 'open', defaultBranch = base }) =>
  JSON.stringify({ state, head: { sha: head }, base: { ref: base, repo: { default_branch: defaultBranch } } });
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

function run(name, { head, base, defaultBranch, state, reviews = [], timeline = [], later, files = {}, prNumber = '7' }) {
  const dir = path.join(TMP, 'runs', name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60));
  const fix = path.join(dir, 'fix');
  const runner = path.join(dir, 'tmp');
  for (const d of [fix, runner]) fs.mkdirSync(d, { recursive: true });
  const all = {
    'pr.json': pr({ head, base, state, defaultBranch }),
    // Two pages, as gh --paginate prints them.
    'reviews.json': JSON.stringify(reviews.slice(0, 1)) + JSON.stringify(reviews.slice(1)),
    'timeline.json': JSON.stringify([{ event: 'commented' }]) + JSON.stringify(timeline),
    ...(later ? { 'pr-later.json': pr({ head: later, base, defaultBranch }) } : {}),
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
    REPO: 'o/r',
    PR: prNumber,
    SERVER_URL: `file://${SERVER}`,
  };
  for (const f of [env.GH_LOG, env.GIT_LOG, env.GITHUB_STEP_SUMMARY]) fs.writeFileSync(f, '');
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
        leftovers: fs.readdirSync(runner),
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
      const [m] = o.messages;
      assert.ok(
        m.startsWith(`agent-review: this PR changed after the bot approved ${C.X.slice(0, 7)} (new commits, or a new base branch), so the bot took back its approval.`),
        m,
      );
      assert.ok(m.includes('Run /agent-review:re-review (or /agent-review:review) and post the report.'), m);
      assert.ok(m.includes('The bot approves again when the report passes for the new head.'), m);
      assert.match(o.summary, new RegExp(`Withdrew the bot's approval of ${C.X} on PR #7 \\(review 21\\): the PR changed beyond merging in the default branch\\.`));
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
      assert.match(o.summary, /\(review 21\): could not fetch the approved commit\./);
    },
  ],
  'a base branch that cannot be fetched withdraws every candidate': [
    () => ({ head: C.MERGE1, base: 'gone', reviews: [review(21, C.X)] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): could not fetch the PR's base branch and head\./);
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
      assert.match(o.summary, /\(review 21\): the PR's base branch changed after it was approved\./);
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
      assert.match(o.summary, /\(review 21\): the PR's base branch changed after it was approved\./);
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
      assert.match(o.summary, /\(review 21\): could not read when the PR's base branch last changed\./);
    },
  ],
  'an approval with no time withdraws': [
    () => ({ head: C.MERGE1, reviews: [review(21, C.X, { submitted: null })] }),
    (o) => {
      assert.deepEqual(o.dismissed, [21]);
      assert.match(o.summary, /\(review 21\): could not read when it was approved\./);
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
  'an approval of the head as it is when re-read is never dismissed': [
    () => ({ head: C.NEW, later: C.X, reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      assert.match(o.summary, new RegExp(`The head of PR #7 is ${C.X} again, so the bot's approval of it is kept`));
    },
  ],
  'a head that cannot be read again dismisses nothing and warns': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], files: { 'fail-pr-later': '' } }),
    (o) => {
      kept(o);
      assert.match(o.stdout, /^::warning::could not read the head of PR #7 again, so the bot's approval of [0-9a-f]{40} was not withdrawn \(review 21\)\. A person must dismiss it\.$/m);
    },
  ],
  'a token that may not dismiss skips cleanly with one warning, without retrying': [
    () => ({ head: C.NEW, reviews: [review(21, C.X), review(22, C.MERGE1)], files: { 'fail-dismiss-403': '' } }),
    (o) => {
      assert.equal(o.writes.length, 1, 'stops after the first refusal');
      const warnings = o.stdout.split('\n').filter((l) => l.startsWith('::warning::'));
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
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
    },
  ],
  'an approval that is already dismissed is noted, not warned about': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], files: { 'already-dismissed': '' } }),
    (o) => {
      assert.deepEqual(o.dismissed, [21], 'a 422 is not retried');
      assert.ok(!o.stdout.includes('::warning::'));
      assert.match(o.summary, new RegExp(`The bot's approval of ${C.X} on PR #7 was already dismissed \\(review 21\\)\\.`));
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
    },
  ],
  'a closed PR is left alone': [
    () => ({ head: C.NEW, state: 'closed', reviews: [review(21, C.X)] }),
    (o) => {
      kept(o);
      noGit(o);
      assert.ok(!o.ghCalls.some((l) => l.includes('/reviews')), 'the reviews are not read');
    },
  ],
  'a pull request number that is not a number is refused before any call': [
    () => ({ head: C.NEW, reviews: [review(21, C.X)], prNumber: '7/../../x' }),
    (o) => {
      kept(o);
      noGit(o);
      assert.match(o.stdout, /^::warning::agent-review withdraw needs a pull request number/m);
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
