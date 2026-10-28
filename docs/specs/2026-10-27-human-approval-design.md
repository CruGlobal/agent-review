# Human approval for PCI work and staff_accounting_app, and approval of irreversible changes

Date: 2026-10-27. Status: design, for Justin's review (questions answered 10-27). Branch `feat/human-approval`, stacked on PR #33.

## Why

On 2026-10-20 the team decided that a fresh-agent Claude review is enough to merge a PR. There are two exceptions: PCI work, and anything in staff_accounting_app (SAA). Those still need a person.

agent-review does not match that rule today:
- **It refuses too much.** The bot never approves a PR marked irreversible, such as one that drops a column or sends email. Under the new rule, a person does not need to approve those. They only need a clear warning.
- **It refuses too little.** It has no idea what PCI code or SAA is, so it would approve either one.

The team also admin-merges PRs that have no approval for now. So when a PR needs a person, "the bot just doesn't approve" is not enough. People must be able to see it.

## Goals

1. **Irreversible PRs can be approved.** The bot approves a passing irreversible PR. The report and the bot's approval message both carry a caution that names the reasons.
2. **A repo can require a person for every PR.** This is for SAA.
3. **A repo can list its PCI files.** A PR that changes any of them needs a person.
4. **The review spots card-handling code in every repo,** including repos that never listed any PCI files. A repo with no PCI code today may get some later (Justin).
5. **When a PR needs a person, the team can see it.** The report shows the reasons, and the PR gets a `needs-human-approval` label. A later review removes the label when the PR no longer needs a person (Justin chose these two signals).

## Non-goals

- No reviewer requests, Slack messages, or required checks (Justin chose the note and the label only).
- No change to how blockers, the ledger, scoring or engines work.
- Branch protection settings are not changed. That is GitHub config, owned by the team.
- No onboarding of the PCI repos. summer_missions, moa, cap, staff_accounting_app and give-web have no agent-review setup today (checked 2026-10-27). Setting them up is separate work.

## Anti-goals (what would make this a failure even if it works)

- **The bot approves PCI or SAA work.** Every path that approves must refuse a PR that needs a person: the CI review, the fix/dismiss interaction, and a locally posted report.
- **The PR can switch off its own rule.** The rules must be read from the PR's base commit, never from the PR's own changes.
- **A broken check approves.** Anything that cannot be judged counts as "needs a person", or as "could not judge, not approving".
- **A noisy scan.** If the card-data scan flags ordinary code, people learn to ignore the label. It must stay narrow (see the scan rules below).

## What exists today (facts the design builds on)

- **Where approval is decided.** `engine/approval.cjs` (`evaluateApproval`) makes one decision for all three approval paths. It reads the hidden markers at the top of the report comment. It refuses on shadow mode, a head mismatch, a status that does not pass, and `irreversible: true`.
- **The status marker** is built by `buildStatus` in `engine/reportState.cjs`. Its inputs are the ledger, the gate plan, and the review's safety file (`/tmp/agent_review_safety.json`: `{ irreversible, reasons }`). The review skill writes that file in "Assess reversibility & build the status marker", judging the full PR diff.
- **Repos use thin callers.** Each repo's workflow files call shared workflows with `uses: CruGlobal/agent-review/.github/workflows/<name>.yml@main`. The shared approve action (`.github/actions/approve`) checks out the agent-review runtime at `ref: main`.
  - **So any change to approval goes live in every repo the moment it merges to main,** whatever plugin version people run.
  - **CI runs get the new review too.** CI reviews install the plugin fresh from this repo's `main` on every run (`review.yml:275-277`, `interact.yml:181-182`), so the review skill and report text change at merge for CI runs too.
  - **Only local runs wait.** A run from someone's terminal changes only when that person updates the plugin.
- **Where the approve action runs.**
  - In the CI review (`review.yml:439`) and the fix/dismiss path (`interact.yml:494`), it runs only when `auto_approve` is on and the base commit's engine is `agent-review`.
  - In the local-report path (`approve.yml`), it runs whenever `auto_approve` is on.
- **Config precedent.** `.github/actions/read-engine` already reads a config key from the PR's base commit.
- **Irreversible is treated as a stop in several places:**
  - `templates/report.md` (lines 12 and 37-38);
  - `engine/addressState.cjs` (around lines 478 and 505-512);
  - `skills/address/SKILL.md` (around line 302);
  - `skills/yolo-review/SKILL.md` (around lines 103-120);
  - the approval body texts in `.github/workflows/approve.yml`, `review.yml` and `interact.yml`, and in the approve action's default;
  - the approval reason in `engine/approval.cjs:71` ("and the change is reversible");
  - `skills/review/SKILL.md:~1689`, which defends "when unsure, classify irreversible" with "the only cost is a human look";
  - the README's "It will NOT approve if" list.
- **The bot never dismisses a review today,** and `dismiss_stale_reviews` is off or mixed across the fleet. So a bot approval of an earlier head still counts on a later head.

## The design

### 1. Irreversible PRs (decided by Justin)
- `evaluateApproval` no longer refuses `irreversible: true`.
- **The reversibility check stays exactly as it is.** Same rules, same reasons, and still judged on the full PR diff. Only the result changes, from a stop to a caution. "When unsure, classify irreversible" stays. Its stated reason changes to "the only cost is a caution line".
- **The report's irreversible line becomes a caution.** For example: "⚠️ **Irreversible**: <reasons>. A revert will not undo this. Check backups and the deploy plan before you merge." The header keeps its `· ⚠️ irreversible` tag.
- **The approval message carries it too.** When the approve action approves an irreversible PR, its message adds the same caution and reasons. The person merging sees it even without opening the report.
- **Everywhere else stops treating irreversible as a stop:**
  - address's notes stop saying a human approval is required for it;
  - `yolo-review` no longer halts on it, and prints the caution instead;
  - the README and the approval texts change to match.

### 2. Repo rules in config (decided by Justin; key names are Claude's call)
There is a new optional block in `.claude/review/config.yml`:

```yaml
human_approval:
  always: false   # true: every PR here needs a person's approval (staff_accounting_app)
  paths: []       # globs for PCI code; a PR that changes a matching file needs a person
```

- **Defaults.** Both are off. The block is written only when a repo sets it, like other new keys, so default repos still load on plugin 1.0.0.
- **Globs** use the same matcher as `excluded_paths`. A file counts as changed if it was added, changed, deleted or renamed, judged on either its old or its new path.
- **The rules guard themselves.** A PR that changes `.claude/review/config.yml` needs a person whenever the base commit's config sets `always: true` or a non-empty `paths`.
- **New engine command.** `agent-review human-check` takes the config (from the base commit) and the list of changed files, and prints `{ required, reasons }`. Example reasons:
  - "every PR in this repo needs a person (human_approval.always)";
  - "PCI path: app/services/payments/charge.rb";
  - "changes the human_approval config".

### 3. The card-data scan (decided by Justin)
The review skill judges a second question about the full PR diff, next to reversibility, in the same step.

**What it flags.** A PR is flagged when the diff adds or changes code that does any of these:
- reads, stores, logs, sends or displays payment card data: card number (PAN), CVV/CVC, card expiry date (MM/YY), or cardholder name together with card data;
- handles a processor-issued card token or vault id (for example a TSYS or Stripe payment-method token);
- calls a payment processor or gateway to charge, authorize, refund or store a card (TSYS, cru-payments, Stripe and similar);
- changes a payment form's card fields, or how card data moves to or from the browser;
- changes logging or error reporting in code that handles card data.

**What it does not flag.** Code that only shows amounts, totals, invoices, donations or receipts, with no card data and no processor call. Card data in tests and fixtures does not count, unless the test helper ships to production.

**When unsure.** It flags the PR. The only cost is a person's look, but the narrow list above keeps false alarms rare.

**Reasons** name the hunk, the way reversibility reasons do, for example "adds cvv2 to the TSYS sale request in app/models/charge.rb".

**Enforced from day one, with no off switch (Justin).** A repo cannot turn the scan off, because a repo with no PCI code today may get some later.
- **The noise guard is a dry run before merge.** Run the scan's rules over about 30 recently merged PRs in the busiest agent-review repos, and count the flags.
- **If any flag looks wrong,** tighten the "what it flags" list and run it again, before this merges.

### 4. The status marker
- **Inputs.** `buildStatus` takes the human-check result and the card-data result. The review writes both, next to the safety file.
- **New fields.** The status gains `humanRequired` (true or false) and `humanReasons` (a list of strings). It is true when the config rules or the scan say so.
- **Reasons are required.** A `true` with no reasons is an error, like `irreversible` today.
- **The schema stays `v: 1`.** A missing `humanRequired` reads as false. Old reports from plugin 1.0.0 have no such field (see Rollout).
- **These are properties of the diff,** like `irreversible`. `address` never changes them. Only a review can.
- **Incremental runs carry them forward.** Where a zero-risk incremental run carries the previous `irreversible` forward today, it carries the previous `humanRequired` and `humanReasons` forward too.

### 5. Approval, in every path
`evaluateApproval` refuses when `status.humanRequired === true`, with the reason "a person must approve: <reasons>".

**Re-checking the repo rules at approval time.** The approve action does not trust the report alone for the repo rules:
- it reads `human_approval` from the PR's base commit through the API;
- it lists the PR's changed files through the API;
- it runs `agent-review human-check` itself.

If that says a person is needed, it refuses, whatever the report says. If it cannot read the config or the full file list (an API error, or a PR over the API's 3,000-file limit), it does not approve. This is Claude's call. It covers reports from older plugin versions and from a run that skipped the check. Since the action runs from `@main`, it protects every repo as soon as this merges.

**Taking back an earlier bot approval (Claude's call).** Say the bot approved head A, and head B now needs a person. The bot's approval of A would still count on B, because stale approvals are not dismissed across the fleet. So when the action judges a report for the current head and finds a person is needed, it also dismisses any approval review the bot itself posted earlier on this PR, with the reason "a person must approve: <reasons>".
- It never touches a person's review.
- A dismiss error, for example from branch protection that limits who may dismiss, becomes a warning and never fails the job. The label is still added.
- This needs a real test on a protected branch during the build.

### 6. The label (decided by Justin)
The approve action owns the `needs-human-approval` label, because it runs in every approval path:
- **Adding it.** When it judges a report for the PR's current head and finds that a person is needed (from the report, the re-check, or both), it adds the label. It creates the label in the repo first if it does not exist.
- **Removing it.** When a report for the current head does not need a person, the action removes the label only if the bot added it. It finds out who added it from the PR's timeline: the most recent "labeled" event for this label.
- **People can add it too (Claude's call).** A person who spots card code the scan missed can add the label by hand. While the label is on the PR, the action does not approve, whatever the report says. The bot never removes a label a person added. A person removes it when they are satisfied.
- **When it can't judge,** for example the report covers an older head, it leaves the label alone.
- **A label error never fails the job.** It becomes a warning, like an approval API error today. If the action cannot read the PR's labels, it does not approve.
- **Where it works.** The label works only where the approve action runs (see "Where the approve action runs" above). In repos set to the code-review engine, that means locally posted reports, through `approve.yml`. Where the action never runs, the bot never approves, so no signal is needed.

### 7. The report
- **New line.** The report gains "👤 **Needs a person's approval**: <reasons>. The bot will not approve this PR." It shows whenever `humanRequired` is true.
- **Header.** The header gets ` · 👤 needs a person` after the risk.
- **Address and yolo.** `address` reminds the user about it, in the same place it reminds about irreversible today. `yolo-review` stops when `humanRequired` is true and says a person must approve, as it does for irreversible today.

### 8. Init and docs
- **Init asks one new question:** does every PR in this repo need a person's approval?
- **Suggested PCI paths.** When init's scan finds card-handling code (the same signals as the scan), it lists those paths and offers them as `human_approval.paths`. The user confirms or edits the list. This is Claude's call.
- **README.**
  - The "It will NOT approve if" list drops irreversible and adds the two human-approval rules and the scan.
  - A short section explains `human_approval`, the label, and the caution.
- **Spec.** A dated amendment in this spec records anything that changes during the build.

## Rollout

**Live in every repo at merge:**
- the approve action's changes: irreversible approval, the repo-rule re-check, the label, and taking back bot approvals;
- every CI review and fix/dismiss run: the card-data scan and the new report text. CI pulls the plugin from `main` on each run.

**Waits for a plugin update:** reviews run from a terminal get the scan and the new report text only when the person updates the plugin.

So, for local runs between merge and plugin updates:
- **Old reports with `irreversible: true` become approvable.** Their visible text still says a person must approve, until the author updates the plugin. This is a text mismatch only, and it is accepted.
- **Repos with `human_approval` set are protected at once,** because the approve action re-checks the rules itself.
- **Card code in a repo without `human_approval` is caught on a local run only after the author updates the plugin.** No PCI repo uses agent-review today, so nothing is exposed now.

## Accepted risks (Claude's calls)

- **A zero-risk CI run skips the whole review, and so the scan.** That includes a first run, which has nothing to carry forward. Only 0-point and excluded paths score 0, so card code is unlikely there. Running the scan anyway would cost a model call on runs that are meant to be free.
  - The repo rules are still re-checked at approval.
- **Writers can edit workflow files.** On `pull_request` runs, GitHub uses the workflow files from the PR's own branch. So a person with write access could edit them to skip the approve action. Reading rules from the base commit does not stop that. Team members are not treated as hostile, in line with the 2026-10-24 ruling that local multi-user threats are out of scope.
  - The README advises repos with `always: true`, like SAA, to also turn off "Allow GitHub Actions to create and approve pull requests". It costs them nothing, since the bot never approves there.

Merge order: this PR is stacked on #33, so it merges after #33. Retarget it to `main` before #33 merges, as for #34 and #35.

## Checks before merge

- `npm test` and `npm run check-dist` pass, and every rule above has a test.
- **The card-data scan dry run** (section 3).
- **A sandbox run** in `jbirdjavi/agent-review-sandbox`:
  - an irreversible PR is approved, and the approval message carries the caution;
  - a PR that changes a listed PCI path gets the label and no approval;
  - a later clean head loses the bot's label and is approved;
  - a hand-added label holds the bot off;
  - on a protected branch, the bot takes back its earlier approval when a later head needs a person.

## Left to the builder

- exact function names, file layout, and test layout, following the repo's patterns;
- the exact report wording, kept plain;
- the label's color and description;
- how the approve action passes the base config to `human-check`;
- whether the scan's reasons share code with the reversibility reasons.

## Calls Claude made (for Justin to check)

1. **The config key names,** `human_approval.always` and `human_approval.paths`.
2. **A PR that edits a protective config needs a person.** That keeps a PR from switching the rules off for the next PR.
3. **The approve action re-checks the repo rules itself, and does not approve when it can't.** Cost: one more API call per approval. A PR over 3,000 files can never be bot-approved in a repo that has rules.
4. **"When unsure, flag it" for the card-data scan,** with a narrow list of what counts.
5. **The approve action owns the label.** Repos with no approve workflow get no label, but those repos are never bot-approved anyway.
6. **Init offers PCI paths it finds.** It never writes them without the user's OK.
7. **The bot takes back its own earlier approval when a later head needs a person.** Best effort: a failure is a warning.
8. **A hand-added label holds the bot off, and only a person removes it.** The bot removes only a label it added.
9. **Accepted risks:** zero-risk CI runs skip the scan, and writers could edit workflow files (see "Accepted risks").
