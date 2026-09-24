# One-command review flow: auto-post, argument-driven address, re-review, yolo — design

## Problem

Getting a PR from "reviewed" to "approved" takes five manual steps today: run the review, pick
"Post review to GitHub" from a menu, open a conversation to fix and dismiss findings, re-run a
full-cost review to confirm, and then wait to see whether anything approves it. The findings
themselves are only readable on the PR; the terminal shows counts. There is no local
incremental re-review (that exists only in CI), so every local confirmation pays for a full
review. And every template ships in `shadow` mode with `auto_approve: false`, so approval never
happens unless three settings are flipped by hand.

## Goal

- `/agent-review:review` posts its report to the PR on its own and prints the findings, with
  reasons, in the terminal exactly as the PR comment shows them.
- `/agent-review:address fix 1,2,3,4 dismiss 5,6,7,8` works from arguments, with one prompt
  for dismissal reasons when they were not given inline.
- `/agent-review:re-review` runs a local incremental review: only the commits since the last
  reviewed head, merged into the same PR comment so fixed and dismissed items keep their
  numbers and statuses and new findings are appended, and printed in the terminal.
- `/agent-review:yolo-review` chains review, fix-all-blockers, re-review, and waits for the
  bot's approval, never dismissing anything.
- Shipped defaults let every repo approve out of the box: `rollout_mode: advisory` and
  `auto_approve: true` on every caller template, label gate kept.

Build order: branch from `main` once PR #29 (0.7.0, the approval paths) has merged. Release as
0.8.0.

## Design principles

- One implementation per stage. The review and address skills gain modes; `re-review` and
  `yolo-review` are thin drivers that invoke them with arguments. No stage text is copied.
- The engine owns anything that can be unit-tested: command grammar, ledger merging, the
  incremental range decision. Skills orchestrate.
- The address skill's rule stands: nothing dismisses on the AI's judgment. Yolo fixes; it does
  not dismiss.
- The canonical report comment stays "the oldest comment starting with the marker", as the
  address skill and the CI incremental path already define it.

## Components

### 1. Review skill: auto-post and terminal printout

Stage 7's interactive menu is replaced.

- **Post.** When `PR_NUMBER` resolves, the report is posted with the existing create-or-update
  block (marker, head, rollout, ledger and status lines prepended; update only a comment the
  posting user authored, else create). No question is asked first. When no PR resolves, the
  report is saved to `/tmp/agent_review_report.md` and the summary says so.
- **Print.** After posting (or saving), print the report's visible body to the terminal: from
  the first line after the hidden marker block through the end of the `## OTHER FINDINGS`
  section, i.e. everything a reader sees on the PR before the collapsed `<details>` blocks.
  Implemented as one bash block in Stage 7:

  ```bash
  awk '/^<details>/{exit} {print}' /tmp/agent_review_report.md
  ```

  The BLOCKERS and OTHER FINDINGS sections already carry each finding's number, severity,
  file:line, message, evidence, and recommendation, so no second rendering is needed.
- **What remains of the menu.** Metrics dashboard, fix dry-run, and dependency impact are
  listed in Stage 8's summary as optional commands (`cat` paths and
  `bash /tmp/automated_fixes/apply_all.sh`) instead of a blocking prompt. Fix scripts are still
  never executed by the skill.
- **Metrics commit.** Unchanged: written locally, committed only when asked.

### 2. Review skill: local `incremental` mode

The Stage 0 incremental block is gated today on `[ -n "$CI_MODE" ]`. The gate becomes
`[ -n "$CI_MODE" ] || [ -n "$INCREMENTAL_REQUESTED" ]`, where `INCREMENTAL_REQUESTED` is set by
the literal argument `incremental` (any position, like `ci`). Everything after the gate is the
existing logic:

- Read the canonical comment; take its `<!-- agent-review-head: … -->` SHA as `LAST_REVIEWED`.
- If `LAST_REVIEWED` is an ancestor of `HEAD_REF`: `RANGE=$LAST_REVIEWED..$HEAD_REF`; the full
  PR range still drives the gate plan and reversibility. If it equals `HEAD_REF`, print "nothing
  new since the last review" and stop without launching agents. If it is not an ancestor (force
  push) or there is no canonical comment, fall back to a full review and say why.
- `HEAD_REF` is the PR's head on GitHub, as today. If local `HEAD` is ahead of it (unpushed
  commits) the skill stops with "push first: the review records the PR head, and the approval
  workflow compares against it". If the working tree is dirty, warn that only committed changes
  are reviewed and continue.
- Stage 6 already fetches the previous ledger when `INCREMENTAL` is set and merges it with
  `agent-review ledger --previous`, preserving numbers and statuses. The report skeleton's
  incremental header line ("Scope: Incremental — commits since …") applies.
- Posting updates the canonical comment in place. In local mode the comment must be authored
  by the posting user; if the canonical comment is the bot's, the skill creates the user's own
  comment instead (0.7.0 rule) and says that the bot's comment remains the CI ledger.
- The `auto` mode's score-0 branch, which today posts a skip note in CI, does the same locally:
  it rewrites the head marker on the canonical comment via the existing sed block, prints
  "no reviewable risk in the delta", and exits. No agents run.

### 3. `/agent-review:re-review` (new skill file)

`skills/re-review/SKILL.md`, about twenty lines: describes the intent, then instructs the model
to invoke the `agent-review:review` skill with arguments `auto incremental` (plus any argument
the user passed, e.g. `quick incremental`, `deep incremental`). No stage text of its own.

### 4. Address skill: argument mode

`/agent-review:address <command>` where `<command>` is anything other than `check` or `ci`.

- **Grammar.** `engine/addressState.cjs#parseCommand(body, { lenient })`. Strict (default,
  used by CI) is unchanged. Lenient accepts, in addition: an optional `:` after `fix` or
  `dismiss`; clauses separated by `;`, newline, or whitespace before the next keyword;
  `fix all` meaning every open finding; `fix blockers` meaning every open finding with
  severity ≥ 7; and a bare `dismiss N, M` with no `[code]: reason`, which yields operations with
  `reasonCode: null, reason: null`. The user's own spelling `fix: 1,2,3,4, dimiss 5,6,7,8`
  parses: the trailing comma before a keyword is whitespace, and `dimiss` is a documented
  alias of `dismiss` (typo tolerance is limited to that one word). Exposed as
  `agent-review address parse --command <file> [--lenient] [--ledger <file>]`, printing the
  operations as JSON; `all` and `blockers` require `--ledger` to expand.
- **Flow.** Stage 0 loads the ledger as today. Stage 1 becomes: if an argument was given, parse
  it leniently; unknown numbers and already-resolved numbers are reported and dropped; the
  rest proceed. Stage 2 applies the fixes, commits, and pushes, exactly as today. Then, before
  Stage 3, any dismissal with `reasonCode: null` triggers **one** prompt: "Dismissing #5, #6,
  #7, #8 — give `[code]: reason` (one for the batch, or one line per number)". The prompt
  accepts `[code]: reason` for all, or `N [code]: reason` lines. Inline reasons never prompt.
  Stages 3–5 are unchanged: the ledger and status lines are rewritten, the comment is patched
  in place, outcomes go to the learning layer, and the session gets a summary.
- **No-argument invocation** keeps today's conversation.

### 5. `/agent-review:yolo-review` (new skill file)

`skills/yolo-review/SKILL.md`, a driver with explicit steps and stop conditions:

1. **Preconditions.** A PR must resolve (`gh pr view`). The working tree must be clean; if not,
   stop and say what to commit. Local `HEAD` must equal the PR head; if not, push first (yolo
   pushes it: it is the user's own branch and the review must record the PR head).
2. **Review.** Invoke `agent-review:review` with `auto` (or the mode the user passed). It posts
   and prints.
3. **Fix blockers.** Read the posted ledger. If any entry with severity ≥ 7 is `open`, invoke
   `agent-review:address` with `fix blockers`. Never dismiss. Suggestions (< 7) are left open.
4. **Re-review.** Invoke `agent-review:review` with `auto incremental`.
5. **Bounded loop.** If the re-review added new open severity ≥ 7 findings, repeat steps 3–4,
   at most two more times (three address passes total). Then stop looping regardless.
6. **Approval.** The session cannot approve: GitHub rejects self-approval and the plugin's
   approval is the bot's, triggered by the posted comment through the consumer's
   `agent-review-approve.yml`. If the status marker says `pass: true`, poll
   `gh pr view --json reviews` every 20 seconds for up to three minutes for a review with
   `state == APPROVED` from `github-actions[bot]` newer than the run's start.
7. **Report.** One of: "approved by the bot"; "ledger passes; this repo has not enabled
   auto_approve on agent-review-approve.yml (or the approval workflow has not run yet) — the
   PR is ready for a human"; "N blockers remain that could not be fixed" with the list; or
   "the change is irreversible; a human must approve". Open suggestions are listed at the end.

Cost note in the skill: yolo can run up to three address passes and up to four reviews; the
`auto` depth keeps re-reviews cheap.

### 6. Defaults: advisory and approving out of the box

- `templates/workflows/agent-review.yml`: `rollout_mode: advisory`, `auto_approve: true`. The
  label gate and its comment stay. The rollout-gate comment ("Keep this gate until
  `agent-review rollout --fail-on-gate` passes…") is rewritten: the label gate controls review
  cost, not trust; drop it when the team wants every PR reviewed.
- `templates/workflows/agent-review-interact.yml` and `agent-review-approve.yml`:
  `auto_approve: true`.
- `templates/config.yml`: `rollout.mode: advisory`, with the comment explaining that `shadow`
  is an explicit opt-in for a repo that wants reports but no approvals, and that the review
  workflow refuses a caller whose `rollout_mode` disagrees with this value.
- `skills/init/SKILL.md`: generate `advisory`; the summary says approval is on and how to turn
  it off (`auto_approve: false` on the callers, or `rollout.mode: shadow` in config).
- `skills/update-files/SKILL.md`: when the repo's config still says `rollout.mode: shadow` and
  the fresh caller says `advisory`, say so and offer to change the config in the same PR
  (the caller alone would fail the trusted-policy step). `rollout_mode` and `auto_approve`
  remain carried-over knobs: a repo that deliberately stays on `shadow` keeps it.
- `.github/workflows/interact.yml`: the `auto_approve` input description becomes "Approve the
  PR when the ledger passes for the current head; shadow reports never approve" (fixing the
  stale "Disabled during shadow/advisory rollout" wording).
- README: the rollout section presents advisory-with-approval as the default and shadow plus
  the readiness workflow as the cautious path. The "Updating" section adds the config note.
- The engine's `rollout` readiness command and the readiness workflow are unchanged and
  optional.

### 7. Terminal output contract (shared by review, re-review, yolo)

After every post, the terminal shows, in this order: the one-line post result
("✅ Updated your review comment (id)" / "✅ Review posted" / "💾 Saved locally, no PR"), the
report's visible body (section 1), and the Stage 8 summary. Address prints the ledger lines it
changed (`#N ✅ fixed in <sha>` / `#N 🚫 dismissed [code]: reason`) and the resulting
status (`pass` and open blockers).

## Trust and safety

- Yolo never dismisses, never edits `.github/` or `.claude/` unless a finding's own file is
  there (the address skill's existing rule), and never approves by itself.
- Argument-mode address is the same trust as conversational address: the operator is the
  user in the session, so the CI-side collaborator checks do not apply.
- Auto-post posts under the user's own account, so the 0.7.0 approval rule (poster must hold
  write permission) governs whether it can lead to an approval.
- Defaults to `advisory` mean a repo that installs the templates without reading them will get
  bot approvals on label-gated PRs. The README states this in the CI setup section, in the
  first paragraph.

## Release

0.8.0: version files, four template markers, manifest restamp, dist rebuild. Branch
`feat/review-flow` from `main` after #29 merges.

## Documentation

- README: new "The flow" section near the top: review → address → re-review → yolo, with the
  exact commands and what each prints and posts.
- Skill files for `re-review` and `yolo-review` carry their own usage headers.
- The address skill's usage block gains the argument form and the lenient grammar.
- The review skill's usage block gains `incremental` and a note that posting is automatic on
  a PR.

## Testing

- `engine/addressState.test.cjs`: lenient grammar cases — optional colons, whitespace-separated
  clauses, the user's exact `fix: 1,2,3,4, dimiss 5,6,7,8`, bare dismissals yielding null
  codes, `fix all` / `fix blockers` expansion against a ledger, strict mode still rejecting all
  of these.
- `engine/cli.test.cjs`: `address parse` prints operations JSON; `--lenient` off rejects a bare
  dismissal.
- `engine/templates.test.cjs`: every caller template says `rollout_mode: advisory` (review) and
  `auto_approve: true`; label gate still present; config template `rollout.mode: advisory`;
  `skills/re-review/SKILL.md` and `skills/yolo-review/SKILL.md` exist, name the arguments they
  pass (`auto incremental`, `fix blockers`), and yolo states "never dismiss" and the loop bound;
  the review skill's incremental gate accepts the `incremental` argument and no longer says
  "CI only"; the review skill contains the `awk '/^<details>/{exit}` printout and no
  "Please respond: 1, 2, 3" prompt; the address skill documents argument mode and the single
  dismissal prompt; update-files mentions the config `rollout.mode` note.
- Manual: one `/agent-review:yolo-review` run on a real mpdx_api PR after mpdx_api adopts the
  0.8.0 templates and config.

## Follow-up (out of scope)

mpdx_api: `/agent-review:update-files` to adopt the 0.8.0 templates, flip `rollout.mode` to
`advisory` in `.claude/review/config.yml`, and delete its hand-rolled `approve` job and
`agent-review-approve.yml` in favour of the templates.
