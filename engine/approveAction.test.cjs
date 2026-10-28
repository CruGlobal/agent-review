'use strict';
// Runs the shared approve action's shell script against a fake gh, so its
// fail-closed paths are pinned by behavior and not only by text. Uses the
// system bash (3.2 on macOS, 5.x on the runners) and jq; skips without them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('yaml');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist/agent-review.cjs');

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BASH = which('bash');
const JQ = which('jq');
const SKIP = !BASH ? 'bash is not installed' : !JQ ? 'jq is not installed' : false;

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OLD = 'd'.repeat(40);
const LABEL = 'needs-human-approval';
const BOT = 'github-actions[bot]';
const BODY =
  'Auto-approved: the agent-review report for this head passes with no open blockers, and no repo rule or recorded check needs a person.';
const PCI = 'human_approval:\n  paths:\n    - "app/pci/**"\n';

const FAKE_GH = `#!/usr/bin/env bash
# Logs each call and serves fixtures from $FIX.
line=""
for a in "$@"; do line+="$a ¦ "; done
printf '%s\\n' "$line" >> "$GH_LOG"
has() { [ -e "$FIX/$1" ]; }
case "$1" in
  label) has fail-label-create && exit 1; exit 0 ;;
  api) shift ;;
  *) echo "fake gh: unexpected $*" >&2; exit 99 ;;
esac
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
serve() { has "fail-$1" && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }; emit "$FIX/$2"; }
case "$METHOD $URL" in
  "GET repos/o/r/issues/7/comments") serve comments comments.json ;;
  "GET repos/o/r/pulls/7")
    N=$(( $(cat "$FIX/../pr-reads" 2>/dev/null || echo 0) + 1 ))
    echo "$N" > "$FIX/../pr-reads"
    if [ "$N" -ge 2 ] && has pr-later.json; then serve pr pr-later.json; else serve pr pr.json; fi ;;
  "GET repos/o/r/contents/.claude/review/config.yml?ref="*)
    case "$(cat "$FIX/config-status")" in
      404) echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      noref) echo '{"message":"No commit found for the ref x"}'; echo "gh: No commit found for the ref x (HTTP 404)" >&2; exit 1 ;;
      500) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;
      file) emit "$FIX/config.json" ;;
    esac ;;
  "GET repos/o/r/pulls/7/files?per_page=100") serve files files.json ;;
  "GET repos/o/r/issues/7/labels?per_page=100") serve labels labels.json ;;
  "GET repos/o/r/issues/7/timeline?per_page=100") serve timeline timeline.json ;;
  "GET repos/o/r/pulls/7/reviews?per_page=100") serve reviews reviews.json ;;
  "POST repos/o/r/issues/7/labels") has fail-label-add && exit 1; echo '[]' ;;
  "DELETE repos/o/r/issues/7/labels/needs-human-approval") has fail-label-remove && exit 1; echo '[]' ;;
  "PUT repos/o/r/pulls/7/reviews/"*"/dismissals") has fail-dismiss && exit 1; echo '{}' ;;
  "POST repos/o/r/pulls/7/reviews")
    has fail-approve && { echo "gh: not permitted to approve (HTTP 422)" >&2; exit 1; }
    for f in "\${FIELDS[@]}"; do
      case "$f" in
        body=*) printf '%s' "\${f#body=}" > "$FIX/../approved-body.txt" ;;
        commit_id=*) printf '%s' "\${f#commit_id=}" > "$FIX/../approved-commit.txt" ;;
        event=*) printf '%s' "\${f#event=}" > "$FIX/../approved-event.txt" ;;
      esac
    done
    echo '{}' ;;
  *) echo "fake gh: unhandled $METHOD $URL" >&2; exit 98 ;;
esac
`;

function report({ head = HEAD, status = {} } = {}) {
  const s = { v: 1, head, pass: true, openBlockers: 0, irreversible: false, ...status };
  return [
    '<!-- agent-review -->',
    '<!-- agent-review-rollout: advisory -->',
    `<!-- agent-review-head: ${head} -->`,
    `<!-- agent-review-status: ${JSON.stringify(s)} -->`,
    '',
    '# report',
  ].join('\n');
}
const comments = (status) => JSON.stringify([{ user: { login: BOT }, body: report({ status }) }]);
const prJson = (extra = {}) => JSON.stringify({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 2, ...extra });
const labeled = (login, name = LABEL) => ({ event: 'labeled', label: { name }, actor: { login } });
const REVIEWS =
  JSON.stringify([
    { id: 11, user: { login: BOT }, state: 'APPROVED', commit_id: OLD },
    { id: 12, user: { login: 'alice' }, state: 'APPROVED', commit_id: OLD },
  ]) +
  JSON.stringify([
    { id: 13, user: { login: BOT }, state: 'COMMENTED', commit_id: OLD },
    { id: 14, user: { login: BOT }, state: 'APPROVED', commit_id: HEAD },
    { id: 15, user: null, state: 'APPROVED', commit_id: OLD },
  ]);

function defaults() {
  return {
    'comments.json': comments(),
    'pr.json': prJson(),
    'config-status': '404',
    // Two pages, as gh --paginate prints them; the rename names both sides.
    'files.json':
      JSON.stringify([{ filename: 'a.rb' }]) +
      JSON.stringify([{ filename: 'lib/x.rb', previous_filename: 'app/pci/x.rb', status: 'renamed' }]),
    'labels.json': '[]',
    'timeline.json': '[]',
    'reviews.json': '[]',
  };
}

// A runtime from another version: the real engine, with dismissBotApprovals replaced.
function fakeRuntime(dismiss) {
  return `const { spawnSync } = require('node:child_process');
const r = spawnSync(process.execPath, [${JSON.stringify(DIST)}, ...process.argv.slice(2)], { encoding: 'utf8' });
let out = r.stdout;
if (process.argv[2] === 'approval' && r.status === 0) {
  const d = JSON.parse(out);
  d.dismissBotApprovals = ${JSON.stringify(dismiss)};
  out = JSON.stringify(d);
}
process.stdout.write(out);
process.exit(r.status);
`;
}

// Workflow-command lines the runner would act on: those outside a
// ::stop-commands::<token> ... ::<token>:: block.
function liveCommands(stdout) {
  const live = [];
  let token = null;
  for (const line of stdout.split('\n')) {
    if (token) {
      if (line === `::${token}::`) token = null;
      continue;
    }
    const stop = line.match(/^::stop-commands::(.+)$/);
    if (stop) token = stop[1];
    else if (line.startsWith('::')) live.push(line);
  }
  return live;
}

let SCRIPT;
let BIN;
let TMP;

function setup() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-approve-action-'));
  const action = parse(fs.readFileSync(path.join(ROOT, '.github/actions/approve/action.yml'), 'utf8'));
  SCRIPT = path.join(TMP, 'approve.sh');
  fs.writeFileSync(SCRIPT, action.runs.steps.find((s) => s.run).run);
  BIN = path.join(TMP, 'bin');
  fs.mkdirSync(BIN);
  fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.symlinkSync(JQ, path.join(BIN, 'jq'));
  fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
}

function run(name, overrides = {}, { dismiss, approveAllowed = 'true' } = {}) {
  const dir = path.join(TMP, name);
  const fix = path.join(dir, 'fix');
  const ws = path.join(dir, 'ws');
  const runner = path.join(dir, 'tmp');
  const runtime = path.join(ws, '.agent-review-approve-runtime/dist');
  for (const d of [fix, runner, runtime]) fs.mkdirSync(d, { recursive: true });
  const target = path.join(runtime, 'agent-review.cjs');
  if (dismiss === undefined) fs.copyFileSync(DIST, target);
  else fs.writeFileSync(target, fakeRuntime(dismiss));
  const { config, ...rest } = overrides;
  const files = { ...defaults(), ...rest };
  if (config !== undefined) {
    files['config-status'] = 'file';
    const content = Buffer.from(config).toString('base64').replace(/(.{60})/g, '$1\n');
    files['config.json'] = JSON.stringify({ type: 'file', encoding: 'base64', content });
  }
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(fix, f), v);
  const env = {
    PATH: `${BIN}:/usr/bin:/bin`,
    HOME: dir,
    GH_LOG: path.join(dir, 'calls.log'),
    FIX: fix,
    RUNNER_TEMP: runner,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    REPO: 'o/r',
    PR: '7',
    REPORT_COMMENT_ID: '',
    APPROVAL_BODY: BODY,
    APPROVE_ALLOWED: approveAllowed,
  };
  fs.writeFileSync(env.GH_LOG, '');
  fs.writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  return new Promise((resolve) => {
    // The runner's composite `shell: bash` runs `bash --noprofile --norc -eo pipefail {0}`.
    const child = spawn(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', SCRIPT], { cwd: ws, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
      const lines = fs.readFileSync(env.GH_LOG, 'utf8').split('\n');
      const approvals = lines.filter((l) => l.startsWith('api ¦ -X ¦ POST ¦ repos/o/r/pulls/7/reviews ¦ '));
      const writes = lines.filter((l) => /^api ¦ -X ¦ |^label ¦ /.test(l) && !approvals.includes(l));
      resolve({
        code,
        stdout,
        stderr,
        lines,
        writes,
        approvals,
        dismissed: writes.filter((w) => w.includes('/dismissals')).map((w) => Number(w.match(/reviews\/(\d+)\//)[1])),
        summary: fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
        approved: read('approved-body.txt'),
        commit: read('approved-commit.txt'),
        event: read('approved-event.txt'),
      });
    });
  });
}

function common(o) {
  assert.equal(o.code, 0, `the step never fails\n${o.stderr}`);
  assert.deepEqual(
    liveCommands(o.stdout).filter((l) => !l.startsWith('::warning::')),
    [],
    'only the action\'s own warnings reach the runner as workflow commands',
  );
  if (o.approved !== null) {
    assert.equal(o.commit, HEAD, 'the approval is pinned to the judged head');
    assert.equal(o.event, 'APPROVE');
  }
}

const notApproved = (o) => {
  assert.equal(o.approved, null);
  assert.deepEqual(o.approvals, []);
};
const noLabelWrites = (o) => assert.ok(!o.writes.some((w) => w.includes('/labels') || w.startsWith('label ¦')));

const SCENARIOS = {
  'a repo with no config approves, pinned to the judged head': [
    {},
    (o) => {
      assert.equal(o.approved, BODY);
      assert.deepEqual(o.writes, []);
      assert.ok(o.lines.filter((l) => l.startsWith('api ¦ repos/o/r/pulls/7 ¦ ')).length === 2, 'the head is read again');
    },
  ],
  'an irreversible report approves with the caution after a blank line': [
    { 'comments.json': comments({ irreversible: true, irreversibleReasons: ['drops a column'] }) },
    (o) => {
      assert.equal(
        o.approved,
        `${BODY}\n\nCaution: this change is irreversible (drops a column). A revert will not undo it. Check backups and the deploy plan before you merge.`,
      );
    },
  ],
  'a base commit the API cannot find is a rules error, not "no config"': [
    { 'config-status': 'noref' },
    (o) => {
      notApproved(o);
      assert.match(o.summary, /Not approving PR #7: could not check the human approval rules: could not read the base config/);
    },
  ],
  'a bad config is a rules error named once': [
    { config: 'human_approval:\n  always: "yes"\n' },
    (o) => {
      notApproved(o);
      assert.match(o.summary, /could not check the human approval rules: human_approval\.always must be a boolean/);
      assert.ok(!o.summary.includes('human-check:'), 'the reason does not repeat the tool name');
    },
  ],
  'a short file list is refused where the base config sets paths': [
    { config: PCI, 'pr.json': prJson({ changed_files: 3001 }) },
    (o) => {
      notApproved(o);
      assert.match(o.summary, /could not check the human approval rules: the PR's file list is incomplete/);
    },
  ],
  'a short file list approves where the base config sets no rules, and says so': [
    { 'pr.json': prJson({ changed_files: 3001 }) },
    (o) => {
      assert.equal(o.approved, BODY);
      assert.match(o.summary, /file list .*incomplete.*no human approval rules/);
    },
  ],
  'unreadable labels never approve': [
    { 'fail-labels': '' },
    (o) => {
      notApproved(o);
      noLabelWrites(o);
      assert.match(o.summary, /Not approving PR #7: could not read the PR labels/);
    },
  ],
  'an unreadable label owner never approves': [
    { 'labels.json': JSON.stringify([{ name: LABEL }]), 'fail-timeline': '' },
    (o) => {
      notApproved(o);
      noLabelWrites(o);
    },
  ],
  'a label already on the PR is not added again when its owner is unreadable': [
    { config: PCI, 'labels.json': JSON.stringify([{ name: 'Needs-Human-Approval' }]), 'fail-timeline': '', 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      noLabelWrites(o);
      assert.match(o.summary, /label=add/);
      assert.match(o.summary, /The needs-human-approval label is already on PR #7/);
      assert.deepEqual(o.dismissed, [11, 14]);
    },
  ],
  'label add: a PCI path adds the label and dismisses every bot approval': [
    { config: PCI, 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      assert.deepEqual(o.writes, [
        `label ¦ create ¦ ${LABEL} ¦ --repo ¦ o/r ¦ --color ¦ B60205 ¦ --description ¦ agent-review: a person must approve this PR ¦ `,
        `api ¦ -X ¦ POST ¦ repos/o/r/issues/7/labels ¦ -f ¦ labels[]=${LABEL} ¦ `,
        'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/11/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
        'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/14/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
      ]);
    },
  ],
  'a report for an older head still adds the label and dismisses every bot approval when a PCI path needs a person': [
    { config: PCI, 'comments.json': JSON.stringify([{ user: { login: BOT }, body: report({ head: OLD }) }]), 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      assert.match(o.summary, /approve=false, label=add, dismiss bot approvals=all\. a person must approve: PCI path: app\/pci\/x\.rb/);
      assert.deepEqual(o.writes, [
        `label ¦ create ¦ ${LABEL} ¦ --repo ¦ o/r ¦ --color ¦ B60205 ¦ --description ¦ agent-review: a person must approve this PR ¦ `,
        `api ¦ -X ¦ POST ¦ repos/o/r/issues/7/labels ¦ -f ¦ labels[]=${LABEL} ¦ `,
        'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/11/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
        'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/14/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
      ]);
    },
  ],
  'a report for an older head changes nothing when the rules need no person': [
    { 'comments.json': JSON.stringify([{ user: { login: BOT }, body: report({ head: OLD }) }]), 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      assert.deepEqual(o.writes, []);
      assert.match(o.summary, /label=keep, dismiss bot approvals=none\./);
    },
  ],
  'a label a person added takes back every bot approval and stays': [
    { 'labels.json': JSON.stringify([{ name: LABEL }]), 'timeline.json': JSON.stringify([labeled('alice')]), 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      noLabelWrites(o);
      assert.deepEqual(o.dismissed, [11, 14]);
      assert.match(o.summary, /a person added the needs-human-approval label/);
    },
  ],
  'label remove: a bot-owned label comes off and the PR is approved': [
    {
      'labels.json': JSON.stringify([{ name: 'bug' }, { name: LABEL }]),
      'timeline.json':
        JSON.stringify([labeled('alice'), { event: 'unlabeled', label: { name: LABEL }, actor: { login: 'alice' } }]) +
        JSON.stringify([labeled(BOT, 'Needs-Human-Approval'), labeled('bob', 'bug')]),
    },
    (o) => {
      assert.deepEqual(o.writes, [`api ¦ -X ¦ DELETE ¦ repos/o/r/issues/7/labels/${LABEL} ¦ `]);
      assert.equal(o.approved, BODY);
    },
  ],
  'label keep: a label a person added holds the bot off': [
    { 'labels.json': JSON.stringify([{ name: LABEL }]), 'timeline.json': JSON.stringify([labeled(BOT), labeled('alice')]) },
    (o) => {
      notApproved(o);
      assert.deepEqual(o.writes, []);
      assert.match(o.summary, /a person added the needs-human-approval label/);
    },
  ],
  'dismiss stale: unreadable rules dismiss only bot approvals of other heads': [
    { 'config-status': '500', 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      noLabelWrites(o);
      assert.deepEqual(o.dismissed, [11]);
    },
  ],
  'dismiss none: open blockers leave every review alone': [
    { 'comments.json': comments({ pass: false, openBlockers: 2 }), 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      assert.deepEqual(o.writes, []);
      assert.ok(!o.lines.some((l) => l.includes('pulls/7/reviews?per_page=100')));
    },
  ],
  'a failed label or dismissal write is a warning, never a failed step': [
    { config: PCI, 'reviews.json': REVIEWS, 'fail-label-create': '', 'fail-label-add': '', 'fail-dismiss': '' },
    (o) => {
      notApproved(o);
      assert.match(o.stdout, /^::warning::could not add the needs-human-approval label to PR #7\.$/m);
      assert.match(o.stdout, /^::warning::could not dismiss the bot's earlier approval on PR #7 \(review 14\)/m);
      assert.ok(!o.summary.includes('could not judge'));
    },
  ],
  'a head that moves before approving is not approved': [
    { 'pr-later.json': JSON.stringify({ head: { sha: 'e'.repeat(40) } }) },
    (o) => {
      notApproved(o);
      assert.match(o.summary, /Not approving PR #7: the PR head moved while it was being judged\./);
    },
  ],
  'a failure inside a command substitution stops once at the trap': [
    { 'pr.json': 'not json' },
    (o) => {
      notApproved(o);
      assert.equal((o.summary.match(/could not judge PR #7/g) || []).length, 1);
      assert.ok(!o.summary.includes('Decision'), 'the script stops instead of running on a garbage head');
    },
  ],
  'an approval API failure is a warning with the settings hint': [
    { 'fail-approve': '' },
    (o) => {
      assert.match(o.stdout, /^::warning::Review passed but approval failed\. Enable 'Allow GitHub Actions to create and approve pull requests'/m);
    },
  ],
  'report text cannot issue workflow commands': [
    { 'comments.json': comments({ humanRequired: true, humanReasons: ['card data\n::error::injected'] }) },
    (o) => {
      notApproved(o);
      assert.ok(o.stdout.includes('::error::injected'), 'the text is still in the log');
      assert.ok(o.summary.includes('::error::injected'), 'and in the summary');
    },
  ],
};

const SKIPPED = /^Approval was skipped for PR #7 because the review did not finish\.$/m;
for (const value of ['false', '', 'TRUE']) {
  SCENARIOS[`approve_allowed ${JSON.stringify(value)} with a passing report never approves and says why`] = [
    {},
    (o) => {
      notApproved(o);
      assert.deepEqual(o.writes, []);
      assert.match(o.summary, SKIPPED);
      assert.match(o.summary, /Decision for PR #7: approve=true, label=keep, dismiss bot approvals=none\./);
    },
    { approveAllowed: value },
  ];
}
SCENARIOS['approve_allowed "false" where a PCI path needs a person still adds the label and dismisses every bot approval'] = [
  { config: PCI, 'reviews.json': REVIEWS },
  (o) => {
    notApproved(o);
    assert.deepEqual(o.writes, [
      `label ¦ create ¦ ${LABEL} ¦ --repo ¦ o/r ¦ --color ¦ B60205 ¦ --description ¦ agent-review: a person must approve this PR ¦ `,
      `api ¦ -X ¦ POST ¦ repos/o/r/issues/7/labels ¦ -f ¦ labels[]=${LABEL} ¦ `,
      'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/11/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
      'api ¦ -X ¦ PUT ¦ repos/o/r/pulls/7/reviews/14/dismissals ¦ -f ¦ message=agent-review: a person must approve: PCI path: app/pci/x.rb ¦ -f ¦ event=DISMISS ¦ ',
    ]);
    assert.match(o.summary, SKIPPED);
    assert.match(o.summary, /Not approving PR #7: a person must approve: PCI path: app\/pci\/x\.rb/);
  },
  { approveAllowed: 'false' },
];
SCENARIOS['approve_allowed "false" still removes a label the bot added, without approving'] = [
  { 'labels.json': JSON.stringify([{ name: LABEL }]), 'timeline.json': JSON.stringify([labeled(BOT)]) },
  (o) => {
    notApproved(o);
    assert.deepEqual(o.writes, [`api ¦ -X ¦ DELETE ¦ repos/o/r/issues/7/labels/${LABEL} ¦ `]);
    assert.match(o.summary, SKIPPED);
  },
  { approveAllowed: 'false' },
];

for (const value of [true, '', 'bogus']) {
  SCENARIOS[`dismiss ${JSON.stringify(value)} from another engine version dismisses every bot approval`] = [
    { 'config-status': '500', 'reviews.json': REVIEWS },
    (o) => {
      notApproved(o);
      assert.deepEqual(o.dismissed, [11, 14]);
    },
    { dismiss: value },
  ];
}

test('the approve action script, run against a fake gh', { skip: SKIP, concurrency: true }, async (t) => {
  setup();
  t.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
  const names = Object.keys(SCENARIOS);
  await Promise.all(
    names.map((name, i) =>
      t.test(name, async () => {
        const [overrides, check, opts] = SCENARIOS[name];
        const o = await run(`s${i}`, overrides, opts);
        try {
          common(o);
          check(o);
        } catch (e) {
          e.message += `\n--- summary\n${o.summary}--- stdout\n${o.stdout}--- stderr\n${o.stderr}`;
          throw e;
        }
      }),
    ),
  );
});
