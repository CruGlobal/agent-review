# Review isolation extras (1.1.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the per-run isolation that 1.1.5 (#47) started: one run per PR across checkouts, old run folders cleaned up, the init skill on the run folder, no em dashes in text agent-review posts, and three small follow-ups from the #47 review.

**Architecture:** 1.1.5 gives each checkout a run folder `<captureDir>/runs/<name>-<hash>` with a generation lock (`run.lock.N`, created by link(2), see `engine/runDir.cjs`). This plan adds a second lock of the same kind per PR under `<captureDir>/locks/`, owned by whichever skill holds the checkout, plus a prune pass, and moves the init skill's fixed `/tmp/agent_review_init*` files into the run folder.

**Tech Stack:** Node 20 CommonJS (`engine/*.cjs`), `node:test` + `node:assert/strict` (`npm test` runs every `engine/*.test.cjs` in one process), esbuild bundle `dist/agent-review.cjs` (`npm run build`, checked by `npm run check-dist`), bash blocks inside skill Markdown, GitHub Actions YAML.

**Spec:** the per-run temp folder design Justin approved on 2026-11-06 (`docs/specs/2026-11-06-per-run-temp-dirs-design.md` on the dropped branch `fix/per-run-temp-dirs`). 1.1.5 built most of it with its own lock design; Justin picked 1.1.5 plus these extras on 2026-11-09. The parts this plan builds are restated in Global Constraints, and they are binding.

## Global Constraints

- Worktree `/Users/justinsabelko/Work/non-rails/agent-review-wt/review-isolation-extras`, branch `fix/review-isolation-extras`, based on main `0128208` (v1.1.5). The shell does not keep `cd`; start every command with `cd <worktree> || exit 1 && `.
- Never run `herdr` commands. Never push, open PRs, or touch other worktrees. Never dispatch subagents.
- No em dashes in new or changed user-facing text, test names, commit messages or messages printed by code. Code comments state constraints only (no rationale, no history); default to none.
- Build on 1.1.5's lock primitives in `engine/runDir.cjs` (`takeLock`, `currentLock`, `lockIsLive`, `sameHolder`, `holderFrom`, `removeLocks`, `makeDir`, `heldMessage`). Do not add a second lock format.
- PR lock folder: `<captureDir(env)>/locks/<owner>_<repo>_<n>`, owner and repo lowercased. `pr` must match `^([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)#([1-9][0-9]*)$`; anything else is a `RunDirError`. Root, `locks/` and the PR folder are each made with `makeDir` (mode 700, owner and no-symlink checks).
- A PR lock belongs to the skill that holds this session's checkout lock at the time it is taken (so `yolo-review`'s outer hold owns it through the review and address runs inside it).
- Sources other than `checkout` (`--run-dir`, `AGENT_REVIEW_RUN_DIR`, `AGENT_REVIEW_CI`) take no PR lock and prune nothing, same as 1.1.5's `--lock`.
- Prune: a folder under `runs/` whose newest mtime (the folder and its direct entries) is older than 604800 seconds (7 days) and whose lock is not live is removed; a folder under `locks/` whose lock is not live is removed. Never follow a symlink, never remove an entry that is not a real directory owned by this uid, never remove the caller's own run folder. Errors on one entry skip that entry.
- Exit codes stay 1.1.5's: 0 ok, 1 error, 4 held by another live session.
- Do not change `FINAL_LINE_CONTRACT` (in `engine/templates.test.cjs`, `templates/archetype.md`, `templates/code-review-lane.md`, review Stage 2) or the regexes in `engine/codeReviewProof.cjs`. Any parser of posted text keeps accepting the old ` — ` form, since reports posted by 1.1.5 and earlier stay on open PRs.
- No caller-template content change under `templates/workflows/`, except the version markers `npm run stamp-templates` writes.
- After any `engine/` change: `npm run build` and commit `dist/agent-review.cjs` in the same commit. `npm test` and `npm run check-dist` pass at every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same PR from two worktrees of one repo** (the case the PR lock exists for): the second run stops with exit 4 and a message naming the PR, the holder's checkout, and the `--release --force --pr` way out, and its own checkout is freed. Tests in Tasks 1 and 3.
2. **`yolo-review` on a PR**: the PR stays locked from the review inside it through address, and is freed when yolo-review releases. Test in Task 1.
3. **A dead or 6-hour-old holder of a PR lock** never blocks: the next run takes it over. Test in Task 1.
4. **Junk under `runs/` or `locks/`** (a file, a symlink to a real folder, a folder owned by another uid, corrupt lock JSON): prune skips it or removes only what it owns, and follows no symlink. Tests in Task 2.
5. **A 1.1.5 report already posted with ` — ` separators**: address still finds and rewrites its finding lines after the em dash change. Test in Task 5.

---

### Task 1: One run per PR across checkouts

**Files:**
- Modify: `engine/runDir.cjs`, `engine/cli.cjs` (`case 'run-dir'`, `RUN_DIR_USAGE`, the help line), `engine/runDir.test.cjs`, `engine/cli.test.cjs`, `dist/agent-review.cjs`

**Interfaces:**
- Produces: `LOCKS_DIR = 'locks'`; `prLockDir(env, pr) -> string`; `takePrLock({ runDir, pr, env, nowSeconds, isAlive }) -> { ok: true, lock } | { ok: false, reason: 'not-held' } | { ok: false, lock }`; `releasePrLocks({ env, skill, nowSeconds, isAlive }) -> void` (frees every PR lock this session holds for `skill`); `forceReleasePr(env, pr) -> void`; `prHeldMessage(lock, { pr, nowSeconds }) -> string`. `takeLock` gains an optional `pr` that it writes into the lock JSON when given.
- CLI:
  - `agent-review run-dir --lock-pr <owner/repo#n>`: needs this session to hold the checkout (else stderr `error: this session does not hold the checkout: take it first with agent-review run-dir --lock <skill>`, exit 1). Takes the PR lock for the checkout lock's skill and prints the run folder. Held by another live session: exit 4, stderr `error: ` + `prHeldMessage`, which says `another agent-review <skill> run holds PR <pr>: session <id or "an unknown session">, checkout <path>, started <N> minutes ago. Wait for it to finish. If that run is gone, free the PR with: agent-review run-dir --release --force --pr <pr>`. Unidentified holder: the same warning style as `--lock`, no lock, prints the folder.
  - `agent-review run-dir --release <skill>`: unchanged, plus `releasePrLocks` for `skill` whenever it cleans. When it prints `kept`, PR locks stay.
  - `agent-review run-dir --release --force --pr <owner/repo#n>`: deletes that PR's lock whoever holds it, prints `released the lock on PR <pr>`. `--release --force` without `--pr` is unchanged.

- [ ] **Step 1: Write failing tests** (runDir.test.cjs unless noted):
  - `prLockDir names owner_repo_n in lower case and rejects anything else`: `CruGlobal/agent-review#48` gives `<captureDir>/locks/cruglobal_agent-review_48`; each of `a/b`, `a/b#0`, `a b/c#1`, `../x#1`, `a/b#1 `, `a_b/c#1`, `a/b/c#1` throws `RunDirError`.
  - `a session holding the checkout takes the PR, and another session's live PR lock refuses with its holder` (two checkouts, two sessions, same PR).
  - `the PR lock belongs to the skill that holds the checkout`: session takes `--outer` yolo-review, then review (kept), then `takePrLock` gives skill `yolo-review`; `releaseLock` for review leaves the PR lock; `releaseLock` + `releasePrLocks` for yolo-review remove it.
  - `a PR lock whose holder died or is over 21600 seconds old is taken over`.
  - `takePrLock without holding the checkout returns not-held and writes nothing`.
  - `a symlinked or group-writable locks folder is refused`.
  - cli.test.cjs: `run-dir --lock-pr refuses a second checkout of the same PR with exit 4, and --release --force --pr frees it` (stderr contains the PR, the first checkout's path and `--release --force --pr`); `run-dir --lock-pr in CI mode prints /tmp and writes no lock`; `run-dir --release cleans the PR lock the skill took`.
- [ ] **Step 2:** `npm test` fails on the new tests only.
- [ ] **Step 3:** Implement in `runDir.cjs` and `cli.cjs`. Argument parsing must keep rejecting stray tokens the way `case 'run-dir'` does today.
- [ ] **Step 4:** `npm test` passes; `npm run build`; `npm run check-dist`.
- [ ] **Step 5:** Commit `feat: one agent-review run per PR, across checkouts`.

### Task 2: Prune old run folders and dead PR locks

**Files:**
- Modify: `engine/runDir.cjs`, `engine/cli.cjs`, `engine/runDir.test.cjs`, `engine/cli.test.cjs`, `dist/agent-review.cjs`

**Interfaces:**
- Consumes: `LOCKS_DIR`, `currentLock`, `lockIsLive` (Task 1 and 1.1.5).
- Produces: `PRUNE_AGE_SECONDS = 604800`; `pruneRuns({ env, nowSeconds, keep, isAlive, uid = process.getuid() }) -> { removed: string[] }`. `run-dir --lock <skill>` calls it after taking the lock, with `keep` = its own run folder, and prints nothing extra.

- [ ] **Step 1: Write failing tests:** `prune removes a run folder untouched for 7 days with no live lock`; `prune keeps an old run folder that holds a recent file`; `prune keeps an old run folder with a live lock`; `prune keeps the caller's own run folder`; `prune follows no symlink under runs/ or locks/` (the link's target and its file survive; the link itself may be left); `prune skips a plain file under runs/`; `prune removes a PR lock folder whose lock is stale, dead or unreadable, and keeps a live one`; cli: `run-dir --lock prunes an old run folder of another checkout`. Use `utimesSync` to age folders.
- [ ] **Step 2:** `npm test` fails on the new tests only.
- [ ] **Step 3:** Implement. Use `lstatSync` for every entry; `rmSync(path, { recursive: true, force: true })` only on a real directory owned by `uid`.
- [ ] **Step 4:** `npm test` passes; `npm run build`; `npm run check-dist`.
- [ ] **Step 5:** Commit `feat: prune run folders untouched for a week and dead PR locks`.

### Task 3: The review and address skills take the PR

**Files:**
- Modify: `skills/review/SKILL.md` (Gather PR Context block and the prose before it), `skills/address/SKILL.md` (Stage 0 block and the run-folder paragraph above it), `skills/yolo-review/SKILL.md` (one sentence: its hold covers the PR too), `engine/runFolderSkills.test.cjs`

**Interfaces:**
- Consumes: `agent-review run-dir --lock-pr <owner/repo#n>` (Task 1).

- [ ] **Step 1: Write failing test** `the review and address take the PR after the checkout, and free the checkout when another run holds it`: review's block that sets `PR_NUMBER=` runs `agent-review run-dir --lock-pr "<repo var>#$PR_NUMBER"` only when `$PR_NUMBER` is set, after the block with `--lock review`, and exits non-zero when it fails; address Stage 0 does the same after `REPO=` is set; each skill's prose says that on exit 4 the model shows the message, runs `agent-review run-dir --release review` (or `address`) and stops. The existing bash/zsh parse test must still cover both blocks.
- [ ] **Step 2:** `npm test` fails on the new test only.
- [ ] **Step 3:** Edit the skills. In review, the repo is `${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}` (CI is a no-op inside `run-dir`, so no CI branch is needed). Keep 1.1.5's "never fall back to /tmp" rule.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit `feat: review and address hold the PR while they run`.

### Task 4: The init skill on the run folder

**Files:**
- Modify: `skills/init/SKILL.md`, `engine/runFolderSkills.test.cjs`

**Interfaces:**
- Consumes: `run-dir --lock init`, `run-dir --release init` (1.1.5).

- [ ] **Step 1: Write failing tests:** extend `no review skill, lane prompt or report names a fixed /tmp file` and `every block that uses the run folder finds it first, and stops when it cannot` (and the bash/zsh parse test) to cover `skills/init/SKILL.md`; add `init takes the checkout first and frees it at the end or on any early stop`, modeled on the review's lock test.
- [ ] **Step 2:** `npm test` fails on the new or extended tests only.
- [ ] **Step 3:** Rewrite init: its first block takes `RUN_DIR=$(agent-review run-dir --lock init) || exit 1; export RUN_DIR`; every other block that touches its state starts with `RUN_DIR=$(agent-review run-dir) || exit 1; export RUN_DIR`; each `/tmp/agent_review_init<x>` becomes `"$RUN_DIR"/init<x>`; prose says to run `agent-review run-dir --release init` at the end and whenever it stops early. Subagent prompts that name a state file get the literal run folder path, the way review's lane prompts do. The read-only guard keeps working.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit `fix: init keeps its state in the run folder, so two inits never collide`.

### Task 5: No em dashes in posted text

**Files:**
- Modify: `templates/report.md`; `engine/addressState.cjs` (posted strings near lines 270, 410, 414, 416, 497, 501 at `0128208`); `.github/workflows/review.yml` (near 393, 431); `.github/workflows/interact.yml` (near 586, 593); `.github/actions/approve/action.yml` (near 107); every `echo`/`printf`/`BODY=`/`--body` line in `skills/**/*.md` that has one; one instruction line each in review Stage 6, `templates/archetype.md`, `templates/code-review-lane.md`; `engine/addressState.test.cjs`; `engine/templates.test.cjs`; `dist/agent-review.cjs`.

- [ ] **Step 1: Write failing tests:**
  - `posted text carries no em dash`: `templates/report.md` has none; no line in `review.yml`, `interact.yml`, `.github/actions/approve/action.yml` or `skills/**/*.md` that starts (after whitespace) with `echo` or `printf`, or contains `BODY=` or `--body`, has one; no string literal in `engine/addressState.cjs` has one.
  - addressState.test.cjs: `finding lines put a middle dot between location and message` (open, fixed and dismissed lines contain `<location> · <message>` and no `—`); `address still finds and rewrites a finding line posted with an em dash` (a 1.1.5 line with ` — ` is matched and replaced by the new form).
  - `model prompts ask for no em dashes in posted text`: Stage 6 and both lane templates contain `Do not use em dashes`, and `FINAL_LINE_CONTRACT` still matches.
- [ ] **Step 2:** `npm test` fails on the new tests only.
- [ ] **Step 3:** Replace: field separators become ` · `; prose takes a colon or a new sentence. Instruction line: `Do not use em dashes in finding messages, summaries or headings that get posted.` Grep every parser of posted text (`addressState.cjs`, `ledger*.cjs`, `review.yml`, `interact.yml`, `.github/actions/**`) and keep each accepting the old form.
- [ ] **Step 4:** `npm test` passes; `npm run build`; `npm run check-dist`.
- [ ] **Step 5:** Commit `fix: no em dashes in text agent-review posts`.

### Task 6: Fix-script follow-ups and the interact CI pin

**Files:**
- Modify: `skills/review/SKILL.md` (Stage 2B `FIX_COUNT`, the `apply_all.sh` heredoc), `.github/workflows/interact.yml` (model step env), `engine/runFolderSkills.test.cjs`

- [ ] **Step 1: Write failing tests:** `Stage 2B counts only fix scripts directly in automated_fixes` (a `fix_1_x.sh` in a subfolder is not counted); `apply_all.sh skips a fix script whose name is not fix_<number>_<category>.sh` (run the heredoc's script in a temp folder with one good and one bad name: only the good one is printed, the bad one gets a skip note); extend `CI keeps its run folder at /tmp: the model steps set AGENT_REVIEW_CI` to `interact.yml`'s model step.
- [ ] **Step 2:** `npm test` fails on these only.
- [ ] **Step 3:** `FIX_COUNT` uses `find "$RUN_DIR"/automated_fixes -maxdepth 1 -type f -name 'fix_*.sh'`; `apply_all.sh` checks each name against the same pattern Stage 2B uses; `interact.yml` sets `AGENT_REVIEW_CI: '1'` beside its other model step env.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit `fix: count and apply only well-named fix scripts, and pin interact to CI mode`.

### Task 7: Docs and release 1.1.6

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json`, `package.json`, `package-lock.json`, `templates/workflows/*.yml` (markers only, via `npm run stamp-templates`), `templates/workflows/template-manifest.json`, `dist/agent-review.cjs`

- [ ] **Step 1:** README: the PR lock (`--lock-pr`, the exit 4 message, `--release --force --pr`), pruning, and init on the run folder, next to 1.1.5's run-folder section.
- [ ] **Step 2:** Bump to 1.1.6 the way `ffa3ccd` bumped 1.1.5: versions, `npm run stamp-templates`, `npm run build`. Confirm with the template-status tests that a 1.1.5 copy is still current after a marker-only bump.
- [ ] **Step 3:** `npm test`, `npm run check-dist` pass.
- [ ] **Step 4:** Commit `chore: release 1.1.6`. Do not tag.
