# Human Approval Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the bot approve irreversible PRs with a caution, and make PCI work and staff_accounting_app PRs always need a person, shown by a report line and a `needs-human-approval` label.

**Architecture:**
- **Engine.** Three pure functions decide everything: `humanRules` (repo rules from the base commit's config plus the changed files), `buildStatus` (new `humanRequired` and `humanReasons` fields), and `decideApproval` (approve or not, plus label and dismissal actions).
- **Callers.** The review skill feeds the first two. It adds a model-judged card-data scan next to the reversibility check. The shared approve action feeds the third and carries out its actions through `gh`.
- **Reports and docs.** Report text, address, yolo-review, init and the README follow.

**Tech Stack:** Node 20 CommonJS (`engine/*.cjs`, `node:test`), esbuild bundle in `dist/`, minimatch, Ajv JSON Schema, Markdown skills, and GitHub Actions composite and reusable workflows with bash and `gh`.

**Spec:** `docs/specs/2026-10-27-human-approval-design.md`. Read it first. Section numbers below refer to it.

## Global Constraints

- **Token permissions.** No shared workflow or action may need a token permission beyond what the caller templates grant today:
  - approve path: `contents: read`, `pull-requests: write`;
  - CI review approve job: `contents: read`, `pull-requests: write`;
  - interact publish job: `actions: write`, `contents: write`, `pull-requests: write`.

  Never add `issues:` or any other permission key. A reusable workflow that asks for more than its caller grants fails to start in every repo.
- **Label name:** exactly `needs-human-approval`. The bot's login is `github-actions[bot]`.
- **Config block:** `human_approval: { always: boolean, paths: string[] }`, both optional, defaulting to false and `[]`. Write it only when a repo sets it.
- **Globs:** minimatch with `{ dot: true }`, as `excluded_paths` uses.
- **Status schema stays `v: 1`.** A missing `humanRequired` reads as false. `true` with an empty reasons list is an error.
- **Caution text** (exact; `<reasons>` is the reasons joined with `; `): `Caution: this change is irreversible (<reasons>). A revert will not undo it. Check backups and the deploy plan before you merge.`
- **Report line** (exact prefix): `👤 **Needs a person's approval**: <reasons>. The bot will not approve this PR.` The header tag is ` · 👤 needs a person`.
- **Engine changes:** run `npm run build`, commit `dist/`, and have `npm test` and `npm run check-dist` pass.
- **Comments** state constraints only, with no history. Prose has no em dashes and uses plain words.
- **Git:**
  - never change git config;
  - if a plain `git` call is refused, use `/usr/bin/git`;
  - end commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - do not push.
- **Repo guidance.** Check for `CLAUDE.md` and `AGENTS.md` before changing files. None existed on 2026-10-27.

## Review Focus

1. **A rename out of a PCI path still needs a person.** The old path matches and the new one does not. Pinned in Task 1.
2. **A base commit with no config, or with no `human_approval` block, has no rules.** So the onboarding PR that adds the rules can be approved. Pinned in Task 1.
3. **An unreadable rule check never approves.** That covers an API error and a PR over 3,000 files (`{ "error": ... }` rules). If the report itself says a person is needed, the label is still added. Pinned in Task 3.
4. **A report for an older head changes nothing.** It keeps the label as is and dismisses nothing, even when the label is the bot's. Pinned in Task 3.
5. **An old 1.0.0 report approves, with the caution.** Such a report has `irreversible: true` and no `humanRequired` field. With no repo rules, it approves and carries the caution. Pinned in Task 3.

---

### Task 1: Repo rules (`humanRules`) and the `human-check` command

**Files:**
- Create: `engine/humanApproval.cjs`, `engine/humanApproval.test.cjs`
- Modify: `schema/config.schema.json` (add `human_approval` beside `reviews_run`), `engine/cli.cjs` (new case and usage line), `engine/cli.test.cjs`, `dist/agent-review.cjs`

**Interfaces:**
- Produces:
  - `humanRules(configText: string | null, files: string[]) -> { required: boolean, reasons: string[] }`
  - CLI `agent-review human-check --config <file> --files <file>`. It prints that object as JSON and exits 0. On a bad config it prints `human-check: <reason>` and exits 1.
  - `LABEL = 'needs-human-approval'`, exported from `engine/humanApproval.cjs`.

**Rules for `humanRules`:**
- `configText` is the base commit's `.claude/review/config.yml`. `null` or `''` means no config, so there are no rules.
- Parse it with `yaml`, read only `human_approval`, and validate it alone: `always` must be a boolean, `paths` an array of strings, and nothing else may appear. A parse or shape error throws. Unrelated keys from newer or older schemas are ignored.
- `files` holds every changed path, old and new. Callers list both sides of a rename.
- **Reasons, in this order:**
  - `"every PR in this repo needs a person (human_approval.always)"` when `always` is true;
  - one `"PCI path: <file>"` per matching file, sorted, with each file listed once;
  - `"changes the human_approval config"` when `.claude/review/config.yml` is in `files` and the base sets `always: true` or a non-empty `paths`.

**Steps:**
- [ ] **Step 1: Write the failing tests** in `engine/humanApproval.test.cjs`:
  - `null` config, `''`, and a config with no `human_approval` each give `{ required: false, reasons: [] }`.
  - `always: true` with `files: ['README.md']` gives the always reason.
  - `paths: ['app/payments/**']` with `files: ['app/payments/charge.rb', 'lib/x.rb']` gives `['PCI path: app/payments/charge.rb']`.
  - A rename out of a PCI path, `files: ['app/payments/old.rb', 'app/billing/new.rb']`, is required (Review Focus 1).
  - A dotfile under a PCI glob matches (`dot: true`).
  - `paths: ['app/payments/**']` with `files: ['.claude/review/config.yml']` gives `['changes the human_approval config']`.
  - With no `human_approval` block, a changed config is not required (Review Focus 2).
  - Each of these throws: `always: 'yes'`, `paths: 'app/**'`, an extra key `reviewers: []`, and invalid YAML.
- [ ] **Step 2:** Run `node --test engine/humanApproval.test.cjs`. Expect it to fail, with the module not found.
- [ ] **Step 3:** Implement `humanRules` and the schema entry. The schema entry is an object with `additionalProperties: false`, `always` boolean, and `paths` array of strings with `uniqueItems`. `loadConfig` already rejects bad shapes for the repo's own config.
- [ ] **Step 4: CLI tests** in `engine/cli.test.cjs`:
  - `human-check` with a config file and a newline file list prints the JSON.
  - A missing `--config` or `--files` prints the usage line and exits 1.
  - An empty config file means no rules.
  - Bad YAML exits 1, with `human-check:` on the output.

  Then implement the `human-check` case in `engine/cli.cjs`.
- [ ] **Step 5:** Run `npm run build && npm test && npm run check-dist`. Expect all to pass.
- [ ] **Step 6:** Commit with the message `feat: human-check reads a repo's human approval rules`.

### Task 2: Status fields (`humanRequired`, `humanReasons`)

**Files:**
- Modify: `engine/reportState.cjs` (`buildStatus`), `engine/cli.cjs` (`status` case and usage), `engine/reportState.test.cjs`, `engine/cli.test.cjs`, `dist/agent-review.cjs`

**Interfaces:**
- Consumes: the `human-check` output from Task 1.
- Produces:
  - `buildStatus({ ledger, head, plan, safety, evidence, human, cardScan })`. `human` is `{ required, reasons }`, the `human-check` output. `cardScan` is `{ cardData: boolean, reasons: string[] }`. Both are required.
  - The status gains `humanRequired: boolean` and `humanReasons: string[]`, after `irreversibleReasons`. The reasons are the human reasons, then the card reasons, without repeats.
  - CLI `status` requires `--human <f> --card-scan <f>`. If either is missing it prints the usage line and exits 1.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - Both inputs false give `humanRequired: false, humanReasons: []`.
  - `human.required` alone, `cardScan.cardData` alone, and both each give true. With both, the reasons keep their order and drop repeats.
  - These throw: `cardData: true` with no reasons; `required: true` with no reasons; a missing `human`; a missing `cardScan`.
  - The `irreversible` fields are unchanged.
- [ ] **Step 2:** Run the tests. Expect them to fail.
- [ ] **Step 3:** Implement the change and update the CLI `status` case. Update every existing test that calls `status` or `buildStatus`.
- [ ] **Step 4:** Run `npm run build && npm test && npm run check-dist`. Expect all to pass.
- [ ] **Step 5:** Commit with the message `feat: status carries humanRequired and humanReasons`.

### Task 3: The approval decision (`decideApproval`)

**Files:**
- Modify: `engine/approval.cjs`, `engine/approval.test.cjs`, `engine/cli.cjs` (`approval` case and usage), `engine/cli.test.cjs`, `dist/agent-review.cjs`

**Interfaces:**
- Consumes: `LABEL` from Task 1, and the status fields from Task 2.
- Produces:
  - `evaluateApproval(body, { head })`. It stays, with three changes:
    - it no longer refuses `irreversible: true`;
    - it refuses `status.humanRequired === true` with `a person must approve: <humanReasons joined '; '>`;
    - its approve reason drops "and the change is reversible".
  - On every return that parsed a status, it adds `irreversible`, `irreversibleReasons`, `humanRequired` and `humanReasons`. Missing fields become false and `[]`.
  - `decideApproval({ report, head, rules, labels, labelOwner }) -> { approve, reason, label, dismissBotApprovals, caution }`.
    - `rules` is the `human-check` output, or `{ error: string }`.
    - `labels` is the PR's label names.
    - `labelOwner` is `'bot' | 'person' | 'none'`, meaning who added `LABEL` most recently.
    - `label` is `'add' | 'remove' | 'keep'`.
    - `caution` is the Global Constraints caution text, or `null`.
  - CLI `approval --report <f> --head <sha> [--rules <f>] [--labels <f>] [--label-owner bot|person|none]`.
    - With only `--report` and `--head`, it prints `evaluateApproval`'s object, as today.
    - With `--rules`, it prints `decideApproval`'s object. `--labels` defaults to `[]` and `--label-owner` to `none`.

**Decision table for `decideApproval`.** "Judged" means `evaluateApproval` got past the marker, rollout and head checks; anything else is not judged.

| Case | approve | label | dismissBotApprovals |
|---|---|---|---|
| Not judged (no report, wrong head, shadow, bad status) | false | keep | false |
| Judged, and `status.humanRequired` or `rules.required` | false | add (keep if already present) | true |
| Judged, `rules.error`, and the status does not need a person | false | keep | false |
| Judged, `LABEL` present, and `labelOwner` is not `bot` | false | keep | false |
| Judged, no person needed, `LABEL` present, `labelOwner` is `bot` | as `evaluateApproval` | remove | false |
| Judged, no person needed, no `LABEL` | as `evaluateApproval` | keep | false |

- **Reasons** name the rule that decided: `a person must approve: ...`, `could not check the human approval rules: <error>`, or `a person added the needs-human-approval label`.
- **Caution** is set whenever the parsed status has `irreversible: true`, whatever `approve` is.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - **`evaluateApproval`:**
    - an irreversible passing report approves, and returns its irreversible fields;
    - a `humanRequired` report refuses with the reasons;
    - an old report with no human fields approves.
  - **`decideApproval`:** one test per table row, plus:
    - a rules error while the status says a person is needed gives approve false and label add (Review Focus 3);
    - a wrong-head report with a bot-owned label gives keep and no dismissal (Review Focus 4);
    - an old 1.0.0-style report (`irreversible: true`, no human fields) with `rules: { required: false, reasons: [] }` gives approve true and a caution that names the reasons (Review Focus 5);
    - a person-owned label beats a passing report.
  - **CLI:** both output modes, and the usage line on a bad `--label-owner`.
- [ ] **Step 2:** Run `node --test engine/approval.test.cjs engine/cli.test.cjs`. Expect them to fail.
- [ ] **Step 3:** Implement `decideApproval` on top of `evaluateApproval` and the table.
- [ ] **Step 4:** Run `npm run build && npm test && npm run check-dist`. Expect all to pass.
- [ ] **Step 5:** Commit with the message `feat: approval decides the label, dismissals, and the irreversible caution`.

### Task 4: The approve action and the approval texts

**Files:**
- Modify:
  - `.github/actions/approve/action.yml`;
  - the `approval_body` texts in `.github/workflows/approve.yml`, `.github/workflows/review.yml` (the approve job) and `.github/workflows/interact.yml` (the approve step name and body);
  - the template pins in `engine/templates.test.cjs`.
- Do not change: any `permissions:` block (Global Constraints).

**Interfaces:**
- Consumes: CLI `human-check` (Task 1) and CLI `approval` with `--rules` (Task 3), both run from the runtime checkout's `dist/agent-review.cjs`.

**What the action's script does after it fetches the report, in order:**
1. **Base and file count.** It reads `base.sha` and `changed_files` from `gh api repos/$REPO/pulls/$PR`.
2. **Base config.** It reads the base config with `gh api "repos/$REPO/contents/.claude/review/config.yml?ref=$BASE_SHA" --jq .content | base64 -d`.
   - A 404 means an empty config.
   - Any other failure writes `{"error":"could not read the base config"}` as the rules.
3. **Changed files.** It lists them with `gh api repos/$REPO/pulls/$PR/files --paginate --jq '.[] | .filename, (.previous_filename // empty)'`. If the number of entries with a `filename` is below `changed_files`, the rules are `{"error":"the PR's file list is incomplete"}`.
4. **Rules.** It runs `human-check`. Exit 1 becomes `{"error":"<its message>"}`.
5. **Labels and owner.**
   - It reads the labels with `gh api repos/$REPO/issues/$PR/labels --jq '[.[].name]'`.
   - It finds the owner from `gh api repos/$REPO/issues/$PR/timeline --paginate`: the last `labeled` event whose label name is `LABEL`. The owner is `bot` when its `actor.login` is `github-actions[bot]`, `person` for any other login, and `none` when there is no such event.
   - If the labels cannot be read, the action does not approve.
6. **Decision.** It runs `approval --rules ... --labels ... --label-owner ...`.
7. **Carrying out the decision:**
   - **`label: add`:**
     - `gh label create needs-human-approval --repo "$REPO" --color B60205 --description "agent-review: a person must approve this PR" 2>/dev/null || true`;
     - `gh pr edit "$PR" --repo "$REPO" --add-label needs-human-approval`.
   - **`label: remove`:** `gh pr edit ... --remove-label needs-human-approval`.
   - **`dismissBotApprovals`:** for each review by `github-actions[bot]` with state `APPROVED`, run `gh api -X PUT repos/$REPO/pulls/$PR/reviews/$ID/dismissals -f message="agent-review: <reason>" -f event=DISMISS`.
   - **`approve`:** post the review with body `$APPROVAL_BODY`, plus a blank line and `caution` when `caution` is set.

   Each label or dismiss call that fails becomes a `::warning::` line and never fails the job, because the existing ERR trap is not allowed to fire for these calls. Every decision and action is written to `$GITHUB_STEP_SUMMARY`.

**The new approval texts** drop "and the change is reversible":
- action default and `approve.yml`: `Auto-approved: the agent-review report for this head passes with no open blockers, and no repo rule or card-data check needs a person.`
- `review.yml`: the same text.
- `interact.yml`: `Auto-approved: every agent-review finding is fixed or dismissed with a reason, and no repo rule or card-data check needs a person.`
- Rename the interact step to `Approve when the ledger is fully addressed and no person is needed`.

**Steps:**
- [ ] **Step 1: Write the failing pins** in `engine/templates.test.cjs`:
  - the action script calls `human-check` and `approval` with `--rules`, `--labels` and `--label-owner`;
  - it uses the exact label name, and the dismissal endpoint with `event=DISMISS`;
  - no workflow or action file under `.github/` gains an `issues:` permission, and every approve job's `permissions` block matches the Global Constraints;
  - the old "and the change is reversible" text is gone from every approval body.
- [ ] **Step 2:** Run `node --test engine/templates.test.cjs`. Expect it to fail.
- [ ] **Step 3:** Implement the script changes and the texts.
- [ ] **Step 4: Lint the shell.** Extract the action's `run:` script to a temp file, then run `bash -n` and, if installed, `shellcheck -S warning`. Expect no errors.
- [ ] **Step 5:** Run `npm test`. Expect it to pass.
- [ ] **Step 6:** Commit with the message `feat: approve action enforces human approval rules, labels, and dismissals`.

### Task 5: The review skill (card-data scan, rule check, status inputs) and the report template

**Files:**
- Modify: `skills/review/SKILL.md`, `templates/report.md`, `engine/templates.test.cjs`

**Interfaces:**
- Consumes: CLI `human-check` (Task 1), and CLI `status --human --card-scan` (Task 2).
- Produces:
  - `/tmp/agent_review_human_rules.json`, the `human-check` output;
  - `/tmp/agent_review_card_scan.json`, as `{ "cardData": false, "reasons": [] }`.

**What changes:**
- **"Assess reversibility & build the status marker"** (around SKILL.md:1669).
  - Change "the only cost is a human look" to "the only cost is a caution line".
  - Add **"Card data"**, which judges the full PR diff (`/tmp/pr_full_diff.txt`). It uses spec section 3's "What it flags" and "What it does not flag" lists, verbatim in substance, and its rule "when unsure, flag it". Reasons are traceable to a hunk.
  - Add a block that writes the rules file:
    - `git show "${BASE_REF}:.claude/review/config.yml" > /tmp/agent_review_base_config.yml 2>/dev/null || : > /tmp/agent_review_base_config.yml`. Read the config at the base branch tip, which is the same commit the approve action reads as `base.sha`.
    - `git diff --name-only --no-renames "$BASE_REF...$HEAD_REF" > /tmp/agent_review_changed_files.txt`. These are the whole PR's files, even on an incremental run.
    - With no PR (a local range review), use the range's start in place of `BASE_REF` for both commands.
    - `agent-review human-check --config ... --files ... > /tmp/agent_review_human_rules.json`. On exit 1, write `{"required":true,"reasons":["could not read the human approval rules: <message>"]}`.
  - Pass `--human /tmp/agent_review_human_rules.json --card-scan /tmp/agent_review_card_scan.json` to the `agent-review status` call.
  - Add the two fields to the status JSON example.
- **The two zero-risk paths** (around SKILL.md:641-662 and :681-693):
  - write the rules file with the same block;
  - carry the previous status's `humanRequired` and `humanReasons` into the card-scan file as `{ cardData, reasons }`, or false and `[]` when there is none;
  - pass both flags to `status`.
- **`templates/report.md`:**
  - **Header line:** add `[ · 👤 needs a person]` after the irreversible tag.
  - **Irreversible line:** replace it with `⚠️ **Irreversible**: [semicolon-joined irreversibleReasons]. A revert will not undo this. Check backups and the deploy plan before you merge.`
  - **Human line:** add `[IF status.humanRequired:]` and the Global Constraints report line, with `[semicolon-joined humanReasons]`.

**Steps:**
- [ ] **Step 1: Write the failing pins** in `engine/templates.test.cjs`:
  - the card-data section exists, with each "what it flags" item and the "when unsure" rule;
  - every `agent-review status` call in SKILL.md passes `--human` and `--card-scan`;
  - both zero-risk paths write both files;
  - the report template has the new lines;
  - the old "auto-approval stays off; a human must approve" and "the only cost is a human look" are gone.
- [ ] **Step 2: Run the shell blocks for real.** Use the harness the existing tests use to run skill blocks under bash and zsh. Run the new rules block against a temp git repo with a base config that sets `paths`. Assert on the rules file.
- [ ] **Step 3:** Run `node --test engine/templates.test.cjs`. Expect it to fail, then implement until it passes.
- [ ] **Step 4:** Run `npm test`. Expect it to pass.
- [ ] **Step 5:** Commit with the message `feat: review runs the human approval rules and a card-data scan`.

### Task 6: Address and yolo-review

**Files:**
- Modify: `engine/addressState.cjs` (the header text around :478 and the notes around :505-512), `engine/addressState.test.cjs`, `skills/address/SKILL.md` (around :250 and :302), `skills/yolo-review/SKILL.md` (around :103-120), `engine/templates.test.cjs`, `dist/agent-review.cjs`

**What changes:**
- **Header.** The address header adds ` · 👤 needs a person` when `humanRequired`.
- **Irreversible note.** It becomes: `⚠️ This change is marked irreversible (<reasons>). A revert will not undo it. Check backups and the deploy plan before you merge.`
- **Human note.** Add `👤 A person must approve this PR (<humanReasons>). The bot will not approve it.`
- **Address never edits** `humanRequired` or `humanReasons`. Its existing `...status` carry-over keeps them, so pin that.
- **Address SKILL.md:**
  - lists `humanRequired` and `humanReasons` beside `irreversible` as fields address never touches;
  - reminds the user about a person's approval when `humanRequired` is true;
  - drops the irreversible "human approval is required" reminder.
- **yolo-review:**
  - reads `HUMAN=$(... jq -r '.humanRequired // false')`;
  - succeeds when `PASS` is true and `HUMAN` is not true;
  - prints the irreversible caution when `irreversible` is true;
  - stops with "a person must approve: <reasons>" when `HUMAN` is true.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - **addressState:**
    - the header tag;
    - both notes;
    - a carried-over `humanRequired: true` survives finalize unchanged.
  - **Pins:**
    - yolo's new checks and texts;
    - address SKILL.md's new lines;
    - the old irreversible stop texts are gone.
- [ ] **Step 2:** Run the tests. Expect them to fail.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4:** Run `npm run build && npm test && npm run check-dist`. Expect all to pass.
- [ ] **Step 5:** Commit with the message `feat: address and yolo-review treat irreversible as a caution and stop for a person`.

### Task 7: Init, config template, README

**Files:**
- Modify: `skills/init/SKILL.md` (the setup questions around :601-630, the summary gate around :678-690, and the write steps around :740), `templates/config.yml`, `README.md`, `engine/templates.test.cjs`

**What changes:**
- **Init question 3 (approval).** Drop the "recommend no for ... payment or financial code" advice. Say instead that such repos keep the bot on and use question 4.
- **New init question 4.** "Does every PR in this repo need a person's approval?" Recommend yes for staff_accounting_app and any repo the team says always needs a person. A yes writes `human_approval.always: true`.
- **Suggested PCI paths.**
  - Init scans the repo for card-handling code with `git grep -P -l -i`, using these patterns: `\b(cvv2?|cvc|card_?number|pan|expir(y|ation)_?(date|month|year)|card_?token|tsys|cru[-_]payments|stripe|braintree)\b`.
  - It groups the hits by folder and offers them as `human_approval.paths` globs for the user to confirm or edit. It writes them only on a yes.
  - The summary gate lists both answers.
- **Init creates the label once** with the user's own token: `gh label create needs-human-approval --color B60205 --description "agent-review: a person must approve this PR" --force`. This runs whenever the bot may approve. The approve action can then label PRs even if its token cannot create labels.
- **`templates/config.yml`.** Add a commented `human_approval:` example under `reviews_run`, with one plain comment line per key.
- **README:**
  - "It will NOT approve if" drops irreversible. It adds "a person must approve: the repo's `human_approval` rules or the card-data check say so, or someone added the `needs-human-approval` label".
  - A new short section, "PCI and repos that always need a person", covers:
    - the config block;
    - the card-data check;
    - the label: who adds it, who removes it, and that a hand-added label holds the bot off;
    - the bot taking back its own earlier approval;
    - the irreversible caution;
    - the advice that `always: true` repos also turn off "Allow GitHub Actions to create and approve pull requests";
    - the rollout note from spec "Rollout".
- **The init pin at templates.test.cjs:~3484** changes to the new wording.

**Steps:**
- [ ] **Step 1: Write the failing pins:**
  - init asks question 4 and offers paths, and writes them only on a yes;
  - the config template has the commented block;
  - the README has the new list item and section;
  - the old init advice is gone.
- [ ] **Step 2:** Run `node --test engine/templates.test.cjs`. Expect it to fail, then implement until it passes.
- [ ] **Step 3:** Load-test the config. Uncommenting the template's example must pass `loadConfig` with the schema from Task 1. Add that as a test in `engine/fixtureConfig.test.cjs` or next to it.
- [ ] **Step 4:** Run `npm test && npm run check-dist`. Expect both to pass.
- [ ] **Step 5:** Commit with the message `docs: init, config template, and README for human approval`.

### Task 8: Card-data scan dry run (controller-run; no repo changes unless the scan is tightened)

- [ ] **Step 1: Pick the PRs.** List the CruGlobal repos that have `.claude/review/config.yml` (`gh search code --owner CruGlobal --filename config.yml ".claude/review"`, or check known repos). Take the 3 with the most PRs merged in the last 30 days, and the 10 most recently merged PRs from each.
- [ ] **Step 2: Run the scan.** A read-only subagent applies the SKILL.md "Card data" section from Task 5 to each PR's full diff (`gh pr diff`). It records flagged or not, with reasons. It posts nothing and edits nothing.
- [ ] **Step 3: Check the flags.** Record the counts in the SDD ledger. For each flag, judge by hand whether the code really handles card data.
- [ ] **Step 4: Tighten if needed.** If any flag is wrong, tighten "What it flags" and "What it does not flag" in SKILL.md and the spec (with a dated amendment), and re-run on the flagged PRs. Commit with the message `fix: narrow the card-data check after the dry run`.

### Task 9: Sandbox hands-on (controller-run)

The sandbox's workflows call agent-review at `@main`, so the branch's approve action is tested through a sandbox-only copy. Nothing in agent-review changes for the test.

- [ ] **Step 1: Set up the copy.** In `jbirdjavi/agent-review-sandbox`, add `.github/actions/approve-under-test/action.yml`, copied from this branch's action. Change only the runtime checkout to `ref: feat/human-approval`. Add a workflow that mirrors `templates/workflows/agent-review-approve.yml`, with the same trigger and the same `permissions` block, but calls the local action. Disable the sandbox's normal approve caller for the test, and restore it afterward.
- [ ] **Step 2: Run the scenarios.** For each one, post a report with a local review (headless `claude -p --plugin-dir <this worktree>`, using the clean-PATH method from the earlier hands-on runbook, with `HERDR_ENV` and `HERDR_PANE_ID` unset). Record the job summary and the PR state.
  - **(a) Irreversible.** A PR that only adds a migration dropping a column is approved, and the approval body has the caution.
  - **(b) PCI path.** With `human_approval.paths: ['lib/payments/**']` on the sandbox's main, a PR that changes `lib/payments/x.rb` gets the label and no approval.
  - **(c) Clean head.** After a new head that reverts the PCI change, the bot's label is removed and the PR is approved.
  - **(d) Hand-added label.** A label added by hand on a clean PR holds the bot off, and stays.
  - **(e) Taking back an approval.** Turn on branch protection on the sandbox's main, requiring 1 approval. If the plan does not allow it on a private repo, record "not testable" and skip. On a PR the bot approved, push a head that touches a PCI path, re-post. The bot's earlier approval is dismissed, or a warning shows the reason.
  - **(f) Permissions.** No run fails at startup because of permissions.
  - **(g) Creating the label.** Delete the label from the sandbox first, and run (b) again. Record whether the action's token could create it. If it could not, the README must say to run init or create the label once.
- [ ] **Step 3: Clean up.** Restore the sandbox's approve caller, remove the test workflow and action, and turn off any branch protection you turned on. Close the test PRs, and leave PR #2 alone.
- [ ] **Step 4: Report.** Write the results to the SDD ledger, with job URLs.
