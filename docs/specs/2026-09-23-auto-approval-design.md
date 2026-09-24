# Auto-approval for CI and locally posted reports — design

## Problem

The plugin approves a PR in exactly one place: the last step of the interact publish job,
after an `@claude fix` / `@claude dismiss` run, gated by the `auto_approve` input. Nothing
approves a PR whose CI review produced a clean report, and nothing approves when a developer
runs the review locally and posts the report with the "Post review to GitHub" menu option.

mpdx_api closed both gaps itself with two copies of the interact step: an `approve` job spliced
into its copy of `agent-review.yml` (bot-authored CI report) and a repo-only
`agent-review-approve.yml` (collaborator-posted local report). The spliced job is lost on every
`/agent-review:update-files` run unless re-added by hand, and the pass rule now exists as three
divergent shell blocks (`first` vs `last` comment selection, different approval messages).

## Goal

One pass rule, owned and unit-tested by the engine, applied by one composite action, reachable
from three callers: the interact publish job, the reusable review workflow, and a new reusable
approval workflow for locally posted reports. Every path stays opt-in via an `auto_approve`
input that defaults to false, so enabling approval remains a visible PR in the consumer repo.

## Components

### 1. Engine command: `agent-review approval --report <file> --head <sha>`

New module `engine/approval.cjs` exporting `evaluateApproval(body, { head })`, which returns
`{ approve: boolean, reason: string }`. Rules apply in order; the first failure returns
`approve: false` with that reason. Nothing else about the report is consulted.

1. The body starts with `<!-- agent-review -->`.
2. A `<!-- agent-review-rollout: <mode> -->` line is present and the mode is not `shadow`.
3. A `<!-- agent-review-head: <sha> -->` line is present and equals `--head`.
4. A `<!-- agent-review-status: {...} -->` line is present, parses as JSON, has `pass === true`,
   `irreversible !== true`, and its `head` field (when present) equals `--head`.

The legacy `- [ ]` checkbox fallback used by the current shell steps is dropped: every report
the plugin has published since the status marker existed carries one, and a report without it
is precisely the case to fail closed on.

The CLI prints the result as JSON on stdout and exits 0 whether or not it approves; a non-zero
exit is reserved for usage errors (missing flags, unreadable file). Callers branch on `.approve`.

### 2. Composite action: `.github/actions/approve/action.yml`

Referenced by callers as `CruGlobal/agent-review/.github/actions/approve@main`, matching the
runtime checkout pinning already used by the reusable workflows. The repo is public, so
consumer workflows can fetch it.

Inputs:

- `pr_number` (required)
- `report_comment_id` (optional). When given, the report is that comment, fetched by id. When
  empty, the report is the first PR comment authored by `github-actions[bot]` whose body starts
  with the marker, which is the convention interact already uses; publish updates the report in
  place, so there is one.
- `approval_body` (optional). The review body posted on approval. Default: "Auto-approved:
  the agent-review report for this head passes with no open blockers and the change is
  reversible."

Steps, all using `${{ github.token }}`:

1. Check out `CruGlobal/agent-review@main` into a workspace path and move it to
   `${{ runner.temp }}/agent-review-approve-runtime`, as the reusable workflows do.
2. Fetch the report body to a file. If none is found, write "No agent-review report found —
   not approving." to the step summary and stop successfully.
3. Read the PR's current head SHA from the API.
4. Run `node <runtime>/dist/agent-review.cjs approval --report <file> --head <sha>`.
5. Write the reason to `$GITHUB_STEP_SUMMARY`. If `approve` is true, run
   `gh pr review <pr> --approve --body "<approval_body>"`. A failure there (typically 422 when
   "Allow GitHub Actions to create and approve pull requests" is off) is reported with
   `::warning::` and does not fail the step.

The action never requests changes and never fails the job on a non-approval.

### 3. Callers

**Interact publish job** (`.github/workflows/interact.yml`): the inline "Approve when the ledger
is fully addressed" step is replaced by a `uses:` of the action with `pr_number: ${{
inputs.pr_number }}` and the existing `if: inputs.auto_approve`. The existing approval message
("every agent-review finding is fixed or dismissed with a reason, and the change is
reversible") is passed as `approval_body`.

**Reusable review workflow** (`.github/workflows/review.yml`): gains a `workflow_call` input
`auto_approve` (boolean, default false, description "Approve the PR when the published report
passes; shadow reports never approve") and a job:

```yaml
approve:
  needs: review
  if: inputs.auto_approve
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write
  steps:
    - uses: CruGlobal/agent-review/.github/actions/approve@main
      with:
        pr_number: ${{ github.event.pull_request.number }}
```

`needs: review` with a plain `if:` means the job runs only when the review job succeeded, so a
failed or skipped review never reaches the approver. The existing `report-failure` job is
unchanged.

**New reusable approval workflow** (`.github/workflows/approve.yml`):

```yaml
on:
  workflow_call:
    inputs:
      pr_number:    { type: string, required: true }
      comment_id:   { type: string, required: true }
      auto_approve: { type: boolean, default: false }
jobs:
  approve:
    if: inputs.auto_approve
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: CruGlobal/agent-review/.github/actions/approve@main
        with:
          pr_number: ${{ inputs.pr_number }}
          report_comment_id: ${{ inputs.comment_id }}
```

### 4. Consumer templates

`templates/workflows/agent-review.yml` gains `auto_approve: false` under `with:` beside `mode`
and `rollout_mode`.

New `templates/workflows/agent-review-approve.yml`:

```yaml
# agent-review-template-version: 0.7.0
name: agent-review approve
on:
  issue_comment:
    types: [created]
jobs:
  approve:
    # A locally run review posted with "Post review to GitHub" starts with the
    # marker. Only trusted collaborators' posts count, and shadow reports never
    # approve. Enabling auto_approve here trusts the poster's report, a stronger
    # grant than the CI path, which reads only the bot's own report.
    if: >-
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '<!-- agent-review -->') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    permissions:
      pull-requests: write
    uses: CruGlobal/agent-review/.github/workflows/approve.yml@main
    with:
      pr_number: ${{ github.event.issue.number }}
      comment_id: ${{ github.event.comment.id }}
      auto_approve: false
```

Both `created` and `edited` are triggers (revised after the whole-branch review): the review
skill's "Post review to GitHub" creates-or-updates the poster's own earlier report comment, so a
re-post after fixing findings is an `edited` event. The head rule already stops an edited report
for an older push from approving the newer one, which was the original reason for omitting
`edited`. The skill must never edit the bot's CI report: that would put hand-posted text under
the login the CI and interact paths trust.

When the action is given a `report_comment_id`, it additionally requires the comment's author to
hold repository write permission (`admin`, `maintain`, or `write`, via
`repos/{repo}/collaborators/{user}/permission`), the same bar `interact.yml` applies to fix and
dismiss commands. `author_association` alone admits every org member and read-only
collaborators, which is too broad for an approval.

The action never fails the calling job: an unexpected error while judging ("could not judge") is
reported as a warning and the step exits successfully, so the interact publish job, which has
already posted its ledger by then, is never marked failed by the approval step.

## Trust boundaries

- **CI and interact paths** read only the bot's own report comment, which the publish step
  validated before posting. A hand-typed marker comment can never be the one judged.
- **Local-post path** reads the triggering comment, authored by a collaborator. The head,
  rollout, and status rules still apply, but a collaborator could compose a passing marker
  comment for the current head. The README and the template comment say so; enabling this
  template is a deliberate, stronger trust grant than the CI one.
- **Self-approval.** In every path the bot approves regardless of who authored the PR, so an
  author can obtain approval on their own PR. This is documented, not prevented: preventing
  it would break the ordinary "review my own PR locally, then post it" flow, and branch
  protection rules that require a non-author human approval remain the right control.
- All paths fail closed, never request changes, and downgrade an approval API failure to a
  warning.

## Release

This is a 0.7.0 minor release: new behavior and a new template.

1. Bump `.claude-plugin/plugin.json`, `package.json`, and the marker on all four templates;
   run `npm install --package-lock-only`.
2. Add `agent-review-approve.yml` to `TEMPLATES` in `engine/stampTemplates.cjs` and to the two
   template loops in `engine/templates.test.cjs`; run `npm run stamp-templates`.
3. `npm run build` so `dist/agent-review.cjs` carries the new command; `npm test`;
   `npm run check-dist`.

## Documentation

- README "CI setup": `auto_approve` on the review caller; the approve template and when to copy
  it; the trust note above; "Updating" lists the fourth file.
- `skills/update-files/SKILL.md`: fetch and offer `agent-review-approve.yml` (offered, not
  forced, like readiness); carry over `auto_approve` on all three callers, not only interact.
- `skills/init/SKILL.md`: list the approve template beside the other three and offer it as
  optional.
- `skills/review/SKILL.md`: one sentence in the "Post review to GitHub" menu handler noting
  that a posted report can trigger approval where the consumer enabled it.

## Testing

- `engine/approval.test.cjs`: no marker; rollout missing; rollout shadow; head missing; head
  mismatch; status missing; status unparseable; `pass: false`; `irreversible: true`; status
  head disagreeing with the marker head; happy path (advisory and enforce).
- `engine/templates.test.cjs`: review.yml declares the `auto_approve` input and an `approve`
  job that needs `review` and holds only `pull-requests: write`; interact.yml references the
  action and no longer contains `gh pr review`; `approve.yml` and `action.yml` parse as YAML;
  the new template carries the marker and a manifest entry; update-files and init mention the
  new file.
- Manual: one real Actions run in a consumer repo to confirm the composite action, as the
  README already requires for trusted workflow steps. The local e2e harness does not cover it.

## Follow-up (out of scope)

mpdx_api replaces its spliced `approve` job and repo-only `agent-review-approve.yml` with the
0.7.0 templates via `/agent-review:update-files`, passing `auto_approve: ${{
vars.AGENT_REVIEW_AUTO_APPROVE == 'true' }}` if it wants to keep its repo-variable toggle.
