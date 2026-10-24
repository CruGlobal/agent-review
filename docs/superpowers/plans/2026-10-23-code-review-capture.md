# Hook Capture for the /code-review Engine: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `code-review` lane gets `/code-review`'s result from a plugin hook instead of from the Skill tool's reply. The engine then proves that every raw finding is grounded in that captured text and is scored or dropped exactly once. The plan also fixes the confirmed findings from the final review.

**Architecture:**
- **Capture.** Two plugin hooks (`PostToolUse` on `Skill`, and `SubagentStop`) write `/tmp/code_review_capture.json`, but only while the review skill has armed capture. The logic lives in a pure module (`engine/captureHook.cjs`), and a CLI wrapper does the file I/O.
- **Waiting.** The lane waits with `agent-review capture-wait`, lists the raw findings, scores them, and writes per-attempt files.
- **Proof.** `agent-review code-review-proof` checks capture, grounding, accounting, and entry fields.
- **Consensus.** It caps code-review findings from structured fields, not from evidence wording.

**Tech Stack:** Node 20 CommonJS (`.cjs`), `node:test`, esbuild bundle in `dist/`, Markdown skills and templates, GitHub Actions YAML.

**Spec:** `docs/specs/2026-10-23-code-review-capture-design.md` (approved 2026-10-23). It amends `docs/specs/2026-10-21-code-review-engine-design.md`. Executors read both. The final review's findings are numbered in `/private/tmp/claude-502/-Users-justinsabelko-Work-rails/9b54ead0-8b00-4792-b25a-024db73347e0/scratchpad/final-ordered.json` (a JSON list; item `#N` is index N-1). Read an item there when a task cites it.

## Global Constraints

- **Repo and branch.** Work in the clone `/Users/justinsabelko/Work/non-rails/agent-review` on branch `feat/code-review-engine`. The repo has no `CLAUDE.md` or `AGENTS.md` (checked 2026-10-23). Look again before starting, and follow one if it has appeared.
- **No change for other repos.** A repo with no `engine` key, or on the `agent-review` engine, behaves exactly as before. Pin this with a test whenever a change touches shared code.
- **Hook behavior.** Hooks always exit 0, print nothing, finish fast, and do nothing unless capture is armed. An arming file older than 3 hours (10800 seconds) counts as not armed.
- **The lane never writes or edits the capture file.**
- **CI does not get the engine.** CI stays local-only per engine spec section 8.
- **Effort limits** for `capture-wait`, measured from the arming time: low 10 min, medium 15, high 20, xhigh 40, max 120.
- **Comments** state only a constraint the code cannot express. No review history, ticket numbers, or incident narration in production code.
- **No em dashes in new prose.** Existing protocol strings, such as the `done — <N> findings, max severity <X>` lane reply, stay as they are.
- **Build.** Run `npm run build` after any `engine/` change and commit `dist/`. Every task ends with `npm test && npm run check-dist` passing.
- **Workflows.** Never write `${{ }}` inside a workflow `run:` block.
- **Usage text.** Every new CLI command gets a line in `USAGE` in `engine/cli.cjs`.
- **Versions and dependencies.** The version stays 1.1.0. No new npm dependencies.
- **Commits.** End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Rulings made while planning (the controller's, against the spec)

1. **JSON list selection.** The round-3 rules for choosing the JSON list stay:
   - an unusable list-like block fails even beside a usable one;
   - the last non-empty qualifying list wins;
   - `[]` counts only when no non-empty list exists;
   - an all-empty JSON result never erases text finding lines.

   The spec's "last qualifying block" is read through these rules. **Why:** a `[]` quoted in a suggested fix must never wipe out real findings. **Cost if wrong:** a rare result with both `[]` and prose finding lines needs its prose findings scored.
2. **Normalizing text.** Text-mode normalization removes backticks, `*`, and only those `_` characters that are not between two word characters. **Why:** the spec's "remove `_`" would turn `user_account.rb` into `useraccount.rb` and fail every snake_case path. **Cost if wrong:** nothing; emphasis markers are still stripped.
3. **Comparing paths.** Paths are compared repo-relative: the `--root` prefix and a leading `./` are stripped. This covers raw against JSON, scored against raw, and the dropped-glob match. **Why:** `/code-review` sometimes writes absolute paths, while the report and ledger need repo-relative ones. **Cost if wrong:** none known.
4. **Who can be captured.** The post-skill hook acts only when the Skill caller is a subagent (`agent_id` is present in the payload). **Why:** the lane is always a subagent, and this keeps a developer's own main-thread `/code-review` untouched even while a stale arm file exists (spec anti-goal). **Cost if wrong:** Task 1 shows whether headless subagent payloads carry `agent_id`. If not, rule again before Task 3.
5. **Args mismatch.** When capture is armed, the caller is a subagent, and the skill is `code-review` but the args differ, the hook writes a mismatch record, and `capture-wait` fails at once with the expected and actual args. **Why:** otherwise the lane waits out the full limit (40 min at `xhigh`) for nothing. **Cost if wrong:** one extra small `/tmp` file while armed.
6. **The overall limit lives in the engine.** `capture-wait` enforces the overall effort limit itself, from the arm file's `created`. The lane only loops while the exit code says "keep waiting". **Why:** this takes the arithmetic away from the model.
7. **Proof output.** `code-review-proof` reports a `stage` (`capture`, `lane`, or `config`) and the rendered `dropped` lines. The skill picks its relaunch path from `stage`, and Stage 6 renders drops from the proof's output instead of joining files by hand.
8. **Lane self-check.** The lane runs `code-review-proof` itself before its final line, and fixes `stage: lane` problems at most twice. **Why:** this saves a full relaunch for a mislisted raw finding.

## Review Focus

1. **Args mismatch.** When the lane passes args that differ from the armed args (an extra space, a dropped `--max-findings`), `capture-wait` fails within one poll and names both strings. It does not wait out the limit. (Task 3 and Task 4 tests.)
2. **A developer's own `/code-review` while armed.** A main-thread `/code-review` call (no `agent_id`), or one with other args, writes no capture and no pending file, and runs normally. (Task 3 test.)
3. **A JSON `line` given as a string range.** For `"line": "42-45"`, the raw entry's `line` is 42. For `"L42"` or `"n/a"`, it is `null`. (Task 4 test.)
4. **An empty result.** When `last_assistant_message` is empty and the transcript is missing, the capture's `result` is `""`, and the proof fails with `stage: capture` and a reason that says the result was empty. (Task 3 and Task 5 tests.)
5. **A capture left by another run.** A capture whose `run_id` differs from the current run is never accepted. `capture-wait` keeps waiting (and fails at the limit), and the proof fails with `stage: capture`. (Task 4 and Task 5 tests.)

---

### Task 1: Headless hook check (spike, no repo changes)

Confirm how the hooks behave in a headless run before anything is built on them (spec "Build order note").

**Files:**
- Create (scratch only): `/private/tmp/claude-502/-Users-justinsabelko-Work-rails/9b54ead0-8b00-4792-b25a-024db73347e0/scratchpad/headless-spike/`
- Report: the report file the controller names in the dispatch.

**Interfaces:**
- Produces: the observed facts listed under "Report", which Task 3 builds on.

- [ ] **Step 1: Build a logging plugin.** Copy `.../scratchpad/hook-spike/plugin` to `.../scratchpad/headless-spike/plugin`. Point its log at `.../headless-spike/events.jsonl`. Register only `PostToolUse` (matcher `*`) and `SubagentStop`. Also add a `SubagentStop` command that writes the payload to `/tmp/agent_review_hookcheck.json`. Each hook exits 0 and prints nothing.
- [ ] **Step 2: Find a range in the sandbox.** In `/Users/justinsabelko/Work/non-rails/agent-review-sandbox`, use `git log --stat` to find a range that changes code, not only `.claude/` files. Do not edit, commit, or push in that repo.
- [ ] **Step 3: Run at `low`.** From the sandbox:
  ```
  claude -p --plugin-dir <plugin> --model opus --allowedTools "Agent,Skill,Read,Grep,Glob,Bash(git:*),Bash(cat:*)" "<prompt>"
  ```
  The prompt tells Claude to start one `general-purpose` subagent with the Agent tool. That subagent:
  - calls the Skill tool with skill `code-review` and args `low <range>`;
  - then runs `cat /tmp/agent_review_hookcheck.json` with Bash;
  - replies with both results word for word.
- [ ] **Step 4: Run at `xhigh`.** Repeat Step 3 with args `xhigh <range>`. Save each run's events file under a distinct name.
- [ ] **Step 5: Write the report.** For each run, record:
  1. the `PostToolUse(Skill)` payload's `tool_response` keys and values: `status`, `background`, `agentId`, the type of `result`, and the first 300 characters of `result`;
  2. whether that payload has `agent_id` (the subagent caller);
  3. the line order of the fork's `SubagentStop` against `PostToolUse(Skill)`;
  4. whether `last_assistant_message` equals the result text after any `Result:` header;
  5. whether the subagent's `cat` read the hook-written file (the Bash sandbox shares `/tmp`);
  6. for `xhigh`, whether the result has a fenced JSON array.

  End with one line per spec assumption: confirmed, or different (and how). The assumptions:
  - `background === false` in headless runs;
  - the stop comes before `PostToolUse`;
  - the result is in `tool_response.result`;
  - `agent_id` is present;
  - `/tmp` is shared.
- [ ] **Step 6: Clean up.** Delete `/tmp/agent_review_hookcheck.json`. No commit: this task changes nothing in the repo.

**Controller gate:** if any assumption differs, rule on it, amend spec section 1 with a dated line, and carry the ruling into Task 3's dispatch.

---

### Task 2: One shared vocabulary (final review #37, #38, #39, #40)

**Files:**
- Create: `engine/vocabulary.cjs`, `engine/vocabulary.test.cjs`
- Modify: `engine/options.cjs`, `engine/plan.cjs`, `engine/selectAgents.cjs`, `engine/cliCommands.cjs`, `engine/consensus.cjs`, `engine/codeReviewProof.cjs`, `engine/cli.cjs` (`MODES`, `FINAL_MODES`)
- Test: `engine/vocabulary.test.cjs`, `engine/schema.test.cjs`, `engine/templates.test.cjs`

**Interfaces:**
- Produces (`engine/vocabulary.cjs`), used by every later task:
  ```js
  ENGINE_DEFAULT = 'agent-review'
  ENGINE_CODE_REVIEW = 'code-review'
  CODE_REVIEW_LANE = 'code-review'
  ENGINES = [ENGINE_DEFAULT, ENGINE_CODE_REVIEW]
  EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  MODES = ['auto', 'quick', 'standard', 'deep']
  FINAL_MODES = ['skip', 'quick', 'standard', 'deep']
  CATEGORIES = ['correctness', 'security', 'data-integrity', 'testing', 'simplification', 'efficiency', 'reuse', 'altitude', 'conventions']
  CLEANUP_CATEGORIES = ['simplification', 'efficiency', 'reuse', 'altitude', 'conventions']
  ```

- [ ] **Step 1: Write the failing tests.**
  - `vocabulary.test.cjs`:
    - `CLEANUP_CATEGORIES` is a subset of `CATEGORIES`, and `CATEGORIES.length === 9`.
    - Test `engine modules spell the engine name only in vocabulary.cjs`. It reads every non-test `engine/*.cjs` except `vocabulary.cjs` and asserts none matches `/['"]code-review['"]/` or `/['"]agent-review['"]/`.
  - `schema.test.cjs`: the schema's `engine.name` enum deep-equals `ENGINES`, and `engine.code_review.effort`'s enum deep-equals `EFFORTS`.
  - `templates.test.cjs`:
    - `templates/code-review-lane.md` names the nine categories in `CATEGORIES` order in its CATEGORY sentence;
    - it names the five cleanups in `CLEANUP_CATEGORIES` order.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL (module missing, literals present).
- [ ] **Step 3: Implement.** Create `vocabulary.cjs`. Replace every literal and local copy in the listed modules with imports.
  - Compare engine names to `ENGINE_CODE_REVIEW`, and lane ids to `CODE_REVIEW_LANE`. Today `consensus.cjs` compares `plan.engine.name` to the lane constant.
  - Build the `options.cjs` error messages from `ENGINES.join(' or ')` and `EFFORTS.join(', ')`.
  - `cli.cjs` imports `MODES` and `FINAL_MODES`.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor: one vocabulary module for engine names, efforts, modes, and categories`

---

### Task 3: Capture hooks and arming

**Files:**
- Create: `engine/captureHook.cjs`, `engine/captureHook.test.cjs`, `hooks/hooks.json`
- Modify: `engine/cli.cjs` (commands `hook`, `capture arm`, `capture disarm`, plus `USAGE`), `engine/cli.test.cjs`, `engine/templates.test.cjs` (the hooks.json shape)

**Interfaces:**
- Consumes: Task 1's report (for any ruling it forced).
- Produces (`engine/captureHook.cjs`):
  ```js
  CAPTURE_FILES = {
    arm: 'agent_review_capture.json',
    pending: 'code_review_capture.pending.json',
    capture: 'code_review_capture.json',
    stops: 'code_review_capture.stops.jsonl',
    mismatch: 'code_review_capture.mismatch.json',
  }
  ARM_MAX_AGE_SECONDS = 10800
  STOP_BUFFER_LINES = 50
  CAPTURE_SOURCE = 'agent-review-capture-hook'
  captureDir(env = process.env) -> string   // env.AGENT_REVIEW_CAPTURE_DIR || '/tmp'; the override exists for tests
  armedState(arm, nowSeconds) -> object | null
  stripSkillHeader(text) -> string           // drops a leading 'Skill "code-review" completed ...' block through its 'Result:' line
  postSkillWrites({ payload, arm, stops, now, readTranscript }) -> { pending?, capture?, mismatch? }
  subagentStopWrites({ payload, arm, pending, capture, now, readTranscript }) -> { stop: object | null, capture? }
  ```
  - `armedState` returns the arm object, or `null` when the arm is missing or malformed, `armed !== true`, or the arm is older than `ARM_MAX_AGE_SECONDS`.
  - `stops` is the parsed stop buffer, oldest first.
  - `readTranscript(path)` returns the last assistant text block in a subagent transcript JSONL, or `null`. The CLI injects it.
  - Capture objects have exactly these keys: `{ source: CAPTURE_SOURCE, mode: 'forked' | 'foreground', run_id, args, fork_id, result, transcript, stop_count, ts }`.
  - A stop buffer entry is `{ agent_id, last_assistant_message, agent_transcript_path, ts }`.
- CLI:
  - `agent-review hook post-skill|subagent-stop`: reads the payload from stdin.
  - `agent-review capture arm --run <id> --args <args>`: deletes the capture, pending, stops, and mismatch files, writes the arm file `{ armed: true, run_id, args, created }`, and prints `armed <id>: <args>`.
  - `agent-review capture disarm`: deletes the arm file.

- [ ] **Step 1: Write the failing tests** in `captureHook.test.cjs`, one `test()` each:
  - `not armed: neither hook writes anything`. Cover a null arm, `armed: false`, and an arm with `created` 10801 seconds ago. Both functions return no `pending`, `capture`, or `mismatch`, and `subagentStopWrites` returns `stop: null`.
  - `post-skill ignores other skills and main-thread callers`. Use `tool_input.skill: 'simplify'`, then a payload with no `agent_id`. Expect `{}`.
  - `post-skill with different args writes only a mismatch`. Assert `mismatch` deep-equals `{ run_id: 'r1', expected: 'xhigh 12', got: 'xhigh  12', ts: now }`.
  - `background fork writes pending with the fork id`. `pending.fork_id === 'f1'`, and there is no `capture`.
  - `background fork whose stop is already buffered also writes the capture`. `capture.mode === 'forked'`, `capture.stop_count === 1`, and `capture.result` is the buffered message.
  - `foreground fork captures tool_response.result without the Skill header`.
    - Input result: `'Skill "code-review" completed (forked execution).\n\nResult:\n(none)'`.
    - Expect `capture.result === '(none)'` and `capture.mode === 'foreground'`.
  - `foreground fork with no result string uses the latest buffered stop for its agentId`.
  - `matching stop writes the capture, and a second matching stop overwrites it with stop_count 2`.
  - `non-matching stops only buffer`. Use another `agent_id`, and an empty `agent_type`.
  - `an empty last_assistant_message falls back to readTranscript, and a null transcript gives result ""`.

  In `cli.test.cjs`, set `AGENT_REVIEW_CAPTURE_DIR` to a temp dir:
  - `hook exits 0 and prints nothing on malformed stdin`;
  - `capture arm clears old capture files and writes the arm file`;
  - `post-skill then subagent-stop write a capture end to end`.

  In `templates.test.cjs`, test `hooks.json registers both capture hooks`:
  - `PostToolUse` has matcher `Skill`, and `SubagentStop` has none;
  - both commands are `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-review" hook <name>`.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The pure module.** It follows spec section 1 and the Interfaces above. It branches on `tool_response.background === true`, not on `status`.
  - **The `hook` case in `cli.cjs`:**
    - It reads stdin with `readFileSync(0, 'utf8')`.
    - It returns 0 at once when the arm file is missing.
    - Otherwise it parses the files it needs, calls the module, and writes each result atomically (temp file plus `renameSync`).
    - It appends the stop line, then trims the buffer to `STOP_BUFFER_LINES`.
    - It catches every error and returns 0 without printing.
  - **`readTranscript`.** Scan the JSONL from the end for an `assistant` message with a `text` content block.
  - **`hooks/hooks.json`.** Register both hooks with `"timeout": 10`.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: capture /code-review results with plugin hooks while armed`

---

### Task 4: Grounding check and `capture-wait`

**Files:**
- Modify: `engine/codeReviewProof.cjs` (replace the text and JSON reader), `engine/cli.cjs` (`capture-wait` and `USAGE`)
- Create: `fixtures/code-review/xhigh-result.txt`. Copy `.../scratchpad/cr-spike/skill-result-xhigh.txt` without its first three lines (the Skill header and `Result:`).
- Test: rewrite `engine/codeReviewProof.test.cjs` (grounding part), and add `engine/cli.test.cjs` cases.

**Interfaces:**
- Consumes: `CAPTURE_FILES`, `captureDir`, `armedState`, and `CAPTURE_SOURCE` from Task 3; `EFFORTS` from Task 2.
- Produces (`engine/codeReviewProof.cjs`):
  ```js
  CAPTURE_LIMIT_MINUTES = { low: 10, medium: 15, high: 20, xhigh: 40, max: 120 }
  jsonFindings(text) -> { list: object[] | null, problem: string | null }
  explicitEmpty(text) -> boolean
  findingLines(text, fileExists) -> [{ index, text, mentions: [{ file, line }] }]
  jsonLine(value) -> number | null
  repoRelative(file, root) -> string
  looksFinished(result, effort) -> boolean
  checkGrounding({ capture, runId, rawEntries, fileExists, root }) -> { ok, stage: 'capture' | 'lane' | null, reason, mode: 'json' | 'text' | 'empty' | null }
  ```
  - **`jsonFindings`** keeps today's `scanFences` rules and merges `isListLike` and `qualifyingList` into one `listOf(block)` that parses once (#42).
    - An unclosed fence, or an unusable list-like block, sets `problem`.
    - `list` is the last non-empty qualifying list. It is `[]` only when every qualifying list is empty, and `null` when there is none.
  - **`explicitEmpty`:** a line outside fences that is exactly `(none)` or `No findings.` after trimming.
  - **`findingLines`** works on lines outside fences, normalized per Ruling 2.
    - A *mention* is `path:N` or `path:N-M`, with no spaces around the range dash (`-`, U+2013, or U+2014).
    - Its path contains a letter, does not start with `//`, and either contains `/` or `.`, or `fileExists(path)` is true.
  - **`jsonLine`:** an integer stays as is; a string's leading digits are used; anything else is `null`.
  - **`looksFinished`:** at `max`, true only when `jsonFindings(result).list` is non-null or `explicitEmpty(result)`. At every other effort, true when `result` is a string.
  - **`checkGrounding`** applies spec section 4 "Capture", then the mode order below. It also checks the raw list's shape: `n` runs 1..N in order, each `file` is a non-empty string, each `line` is a positive integer or `null`, and each `summary` is a non-empty string. A shape error fails with `stage: 'lane'`.

  Mode order:
  1. A `jsonFindings` problem: fail with `stage: 'capture'`.
  2. A non-empty list: `json` mode.
  3. Otherwise, any finding lines: `text` mode (Ruling 1).
  4. Otherwise, a `[]` list or `explicitEmpty`: `empty` mode, and the raw list must be `[]` (else `stage: 'lane'`).
  5. Otherwise: fail with `stage: 'capture'` (`no findings list and no explicit (none)`).
- **Matching:**
  - **JSON mode.** Same count. For each `i`, `repoRelative(raw.file) === repoRelative(list[i].file)` and `raw.line === jsonLine(list[i].line)`.
  - **Text mode.** Use a maximum bipartite matching (augmenting paths) between raw entries and finding lines.
    - An entry can take a line that has a mention whose file matches (repo-relative) and whose line, or range start, equals the entry's `line`.
    - An entry with a `null` line can take a line outside fences that contains its path and has no mention.
    - Fail with `stage: 'lane'` when any raw entry or finding line is left unmatched, and name the first.
- CLI: `agent-review capture-wait --run <id> --effort <effort> [--timeout <seconds>]`
  - **Output:** one JSON line, `{ status: 'finished' | 'waiting' | 'failed', reason, stop_count, mode }`.
  - **Exit codes:** 0 finished; 3 this call's timeout passed but the overall limit has not; 1 failed.
  - **Failures:** a mismatch record for this run, no arm for this run, or the overall limit (from `arm.created`) has passed.
  - **Defaults:** `--timeout` defaults to 540. It polls every 5000 ms (`AGENT_REVIEW_CAPTURE_POLL_MS` overrides this for tests), and sleeps with `Atomics.wait`, because `main()` is synchronous.
  - Only a capture whose `run_id` matches and which `looksFinished` counts.

- [ ] **Step 1: Write the failing tests.**

  JSON mode:
  - `xhigh spike result grounds a matching raw list` uses the fixture. Expect `ok`, with mode `json`.
  - `json raw list must match count, file, and line one to one`. Each of these fails with `stage: 'lane'`: count off by one, two entries swapped, a wrong line.
  - `json line "42-45" grounds raw line 42, and "L42" grounds null`.
  - `a quoted [] after a real list never replaces it`.
  - `an unusable list-like block fails with stage capture even beside a usable one`.
  - `a quoted JSON config object is ignored`.
  - `an unclosed fence fails with stage capture`.
  - `an all-empty JSON list never erases text finding lines`.

  Text mode (final review #3's shapes):
  - `**app/a.rb:12**: x`, ``1. `a.js:3`: x``, `a.rb:12 (pre-existing) - x`, `a.rb:12: x`, and an in-sentence `see lib/b.rb:40 where ...` each ground a matching entry.
  - `src/a.js:49-59 — x` grounds raw line 49, but not raw line 51.
  - `a nested bullet with a mention fails when no raw entry claims it`.
  - `two findings at one location need two raw entries`.
  - `localhost:3000 and https://example.com:443/x are not mentions`.
  - `snake_case paths survive normalization` (`app/user_account.rb:7`).
  - `matching is not greedy`: line A mentions `x.rb:1` and `y.rb:2`, line B mentions `x.rb:1`, and the raw list is `x.rb:1`, `y.rb:2`. Expect `ok`.
  - `a 50,000-character whitespace line is read in under 100 ms` (#32).

  Empty results:
  - `(none) plus an explanation with no mentions grounds an empty raw list`.
  - `text with no finding lines and no marker fails with stage capture`.
  - `a non-empty raw list against (none) fails with stage lane`.

  Capture (each `stage: 'capture'`):
  - missing capture;
  - wrong `source`;
  - `run_id` from another run;
  - empty `result` (the reason says "empty").

  Raw shape: `n` that skips a number fails with `stage: 'lane'`.

  `looksFinished`:
  - `max` with prose is false;
  - `max` with a JSON list is true;
  - `max` with `(none)` is true;
  - `xhigh` with prose is true.

  `cli.test.cjs`, with a 10 ms poll:
  - `capture-wait finishes on a matching capture`;
  - `keeps waiting on another run's capture and exits 3`;
  - `fails at once on a mismatch record and prints both args`;
  - `fails after the overall limit` (an arm `created` 41 minutes ago at `xhigh`).
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** to the Interfaces above. Add the new functions next to the old ones. Leave `checkCodeReviewProof`, `checkFindingAccounting`, their helpers, and their tests in place, so the `code-review-proof` command keeps working until Task 5 removes them.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: ground raw /code-review findings in the captured text, and wait for the capture`

---

### Task 5: Lane output check and the `code-review-proof` command

**Files:**
- Modify: `engine/codeReviewProof.cjs` (replace `checkFindingAccounting` and `checkCodeReviewProof`), `engine/cli.cjs` (the `code-review-proof` case and its `USAGE` line)
- Test: `engine/codeReviewProof.test.cjs`, `engine/cli.test.cjs`

**Interfaces:**
- Consumes: `checkGrounding` and `repoRelative` (Task 4); `CATEGORIES` and `CLEANUP_CATEGORIES` (Task 2); `pathMatches` from `engine/selectAgents.cjs` (#41).
- Produces:
  ```js
  checkLaneOutput({ rawEntries, scoredText, droppedText, excludedPaths, root }) -> { ok, reason, dropped: [{ file, line, summary, why }] }
  checkCodeReviewRun({ captureText, runId, rawText, scoredText, droppedText, excludedPaths, fileExists, root }) -> { ok, stage: 'capture' | 'lane' | 'config' | null, reason, count, mode, dropped }
  ```
  - **Scored file.** `scoredText` holds `{ findings: [...] }` or an array, read with `unwrapFindings`.
  - **Each scored entry** must have:
    - `raw`: a raw `n`;
    - `file`: equal to its raw entry's file, repo-relative;
    - `line`: a positive integer or `null`;
    - `message`: a non-empty string;
    - `severity`: an integer from 1 to 10;
    - `category`: in `CATEGORIES`;
    - `confidence`: `High`, `Medium`, or `Low`;
    - `evidence`: a string;
    - `outside_range` and `doubted`: booleans;
    - `recategorized_from`: `null` or a name in `CLEANUP_CATEGORIES`.
  - **Each dropped entry** is either:
    - `{ raw, reason: 'excluded', glob }`, where `glob` is in `excludedPaths` and `pathMatches(repoRelative(rawFile), [glob])` is true; or
    - `{ raw, reason: 'disproved', proof }`, where `proof` is a non-empty string matching `/\S+:\d+/`.

    Any other `reason`, including `refuted`, fails (#5, #7).
  - **Accounting.** Every raw `n` is used exactly once across scored and dropped entries, and no other `raw` value appears (#4).
  - **Missing files.** A missing or unparseable raw, scored, or dropped file fails with `stage: 'lane'`.
  - **`dropped` output.** One rendered line per drop. `why` is `excluded path: <glob>` or the proof.
- CLI:
  ```
  agent-review code-review-proof --capture <f> --raw <f> --findings <f> --dropped <f> --run <id>
  ```
  All flags are required. It prints the `checkCodeReviewRun` result as JSON and exits 1 when `ok` is false.
  - `excluded_paths` comes from the config. A config read error gives `stage: 'config'`.
  - The `--raw <txt>` form and the old exports are removed.

- [ ] **Step 1: Write the failing tests** (in `codeReviewProof.test.cjs` unless noted):
  - `a raw blocker left out and replaced by an invented entry fails` (#4);
  - `a raw finding both scored and dropped fails`;
  - `scored entry with severity "8/10", 7.5, or 0 fails` (#3 and B1);
  - `scored entry with category "bug" fails` (#4 and B2);
  - `scored entry with no message, empty file, or line "12" fails` (#6);
  - `scored file must equal its raw entry's file, and an absolute raw path matches a repo-relative scored path` (Ruling 3);
  - `recategorized_from "correctness" fails`;
  - `excluded drop passes only for a configured glob that matches the raw file`;
  - `a drop with reason "refuted" fails`;
  - `a disproved drop needs a file:line in its proof`;
  - `dropped output renders "excluded path: dist/**" and the proof text`;
  - `checkCodeReviewRun reports stage capture for an empty result, and stage lane for an accounting error`.

  In `cli.test.cjs`:
  - `code-review-proof exits 1 with a usage line when a flag is missing`;
  - `prints stage config when the config cannot be read`;
  - `a default-engine repo's other commands are unaffected` (pin `config get` and `options` on a config with no `engine` key).
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** to the Interfaces above. Remove the following, along with the tests that covered them:
  - `checkCodeReviewProof` and `checkFindingAccounting`;
  - `textFindings` and the old line regexes (`BARE_LINE`, `BACKTICKED_LINE`, `SCENARIO_LINE`);
  - `scoredEntryProblem`, `excludedDropProblem`, `droppedEntryProblem`, `unmatchedDrop`, and `EXCLUDED_PROOF`;
  - the direct `minimatch` import.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: check that every raw /code-review finding is scored or dropped once, by number`

---

### Task 6: Consensus and the ledger read structured fields (spec section 5; final review #9, #26, #27, #36)

**Files:**
- Modify: `engine/consensus.cjs`, `engine/reportState.cjs`
- Test: `engine/consensus.test.cjs`, `engine/reportState.test.cjs`

**Interfaces:**
- Consumes: `CLEANUP_CATEGORIES` and `ENGINE_CODE_REVIEW` (Task 2).
- Produces:
  - `capCodeReviewFinding(finding, raw) -> finding`, where `raw` is the lane's entry with `outside_range`, `doubted`, and `recategorized_from`. The cap is the first that applies:
    1. `doubted` caps at 4;
    2. `outside_range` caps at 6;
    3. a cleanup category caps at 6;
    4. a set `recategorized_from` caps at 6 unless it is a cleanup name and the category is `correctness` or `security`;
    5. severity 7+ that fails `blockerBarFailure` caps at 6.
  - **The rest of `consensus.cjs`:**
    - `combineMembers` under the engine takes `severity = maxSeverity >= 7 ? maxSeverity : meanSeverity`, and its lead is the highest-severity member.
    - Remove `provenBlockerOf`, `_provenBlocker`, the `raised` branch, `isNumericSeverity`, the floor and clamp code, `OUTSIDE_PREFIX`, and `DOUBTED_PREFIX`.
    - Keep `_meanSeverity` for re-merge weighting.
  - **Evidence:** the primary member's evidence when it is non-blank after trimming, else the longest trimmed evidence.
  - **`reportState.cjs`:** `LOCATION_WORDING = 0.5`.

- [ ] **Step 1: Write the failing tests.**
  - `outside_range caps a code-review 9 at 6`;
  - `doubted caps at 4`;
  - `a cleanup category caps at 6`;
  - `recategorized_from conventions to security keeps 8`;
  - `recategorized_from conventions to testing caps at 6`;
  - `evidence wording no longer caps`: evidence that starts `Outside the reviewed range: ` with `outside_range: false` keeps 8;
  - `under the engine a merged 8 and 3 keep 8; on the default engine they average to 6` (the default-engine half pins today's behavior);
  - `a merged 7+ never carries whitespace-only evidence`;
  - in `reportState.test.cjs`: `location matching needs wording Jaccard of 0.5`. A pair at about 0.4 is appended, and a pair at 0.6 is matched.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `consensusFrom`, pass the raw lane entry into `capCodeReviewFinding`. Delete tests that pinned the removed prefix and clamp behavior.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: cap code-review findings from structured fields`

---

### Task 7: Options, start-up line, and CI fixes (final review #17, #23, #28, #29, #31, #43)

**Files:**
- Modify: `engine/options.cjs`, `engine/cli.cjs` (`options`), `engine/cliCommands.cjs` (`formatStartup`), `README.md` (only the `--max-findings` reset sentence near line 152), `.github/actions/read-engine/action.yml`, `.github/workflows/review.yml`
- Test: `engine/options.test.cjs`, `engine/cli.test.cjs`, `engine/cliCommands.test.cjs`, `engine/templates.test.cjs` (YAML shape)

**Interfaces:**
- Produces:
  - `agent-review options --args-file <f>` reads the raw argument string from a file, trimming one trailing newline. `--args=<value>` is also accepted. `ci` is set only by the `--ci` flag or a `ci` token in the arguments.
  - `resolveOptions` throws one error listing every problem from `codeReviewEngineProblems`, joined by `; `, with the same wording `config validate` prints (#28).
  - Two mode words throw `two mode words given: "<a>" and "<b>"; pass only one` (#31).
  - `formatStartup` no longer prints either `--max-findings` note (#29). Its deep-mode note does not count lanes tagged `[skipped: no matching hunks]` (#23).
  - **read-engine** gains an optional input, `extracted_review_dir`. When it is set, the action still requires the base commit, and still outputs `agent-review` when the base commit has no `.claude/review/config.yml`. Otherwise it reads `config get engine.name` from that directory instead of archiving again.
  - **`review.yml`'s "Read the trusted review engine" step** runs only `if: inputs.auto_approve`, and passes `extracted_review_dir: ${{ runner.temp }}/agent-review-trusted/.claude/review` (#43).

- [ ] **Step 1: Write the failing tests.**
  - `options --args-file keeps a leading --flag token`. A file holding `--foo engine=code-review effort=high` resolves `engine: code-review` and `effort: high`.
  - `a --ci token inside the args file does not set ci`.
  - `resolveOptions lists every engine problem`. Use a config with a disabled `always` lane and a reserved id, and expect both messages.
  - `two mode words name both words`.
  - `start-up line has no --max-findings note`.
  - `deep-mode note skips lanes with no matching hunks`.
  - YAML:
    - `review.yml runs read-engine only under inputs.auto_approve and passes extracted_review_dir`;
    - `read-engine reads extracted_review_dir without git archive`.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the README sentence about the reset.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: options argument file, engine problem messages, start-up notes, and CI engine read`

---

### Task 8: The lane template and `diff-for` (spec sections 2 and 3; final review #18, #25, #34, #46)

**Files:**
- Modify: `templates/code-review-lane.md` (rewrite STEP 1 to STEP 4, and add STEP 5), `engine/cli.cjs` (`diff-for` and `USAGE`)
- Test: `engine/templates.test.cjs`, `engine/cli.test.cjs`

**Interfaces:**
- Consumes: `capture-wait` (Task 4), `code-review-proof` (Task 5), and `parseDiff` from `engine/slice.cjs`.
- Produces:
  - **Placeholders**, exactly: `{{RUN_ID}}`, `{{ATTEMPT}}`, `{{EFFORT}}`, `{{SKILL_ARGS}}`, `{{RETRY_NOTE}}`, `{{PROFILE_INSTRUCTION}}`, `{{RISK_CONTEXT}}`, `{{DIFF_PATH}}`, `{{SCORING_RULES}}`, `{{LEARNINGS}}`, `{{IMPACT}}`, `{{EXCLUDED_PATHS}}`. `{{TARGET}}` and `{{MAX_FINDINGS_FLAG}}` are removed.
  - **Lane files:** `/tmp/code_review_raw.{{ATTEMPT}}.json`, `/tmp/code_review_findings.{{ATTEMPT}}.json`, `/tmp/code_review_dropped.{{ATTEMPT}}.json`.
  - **Final line**, unchanged: `done — <N> findings, max severity <X>`. The other final lines are `/code-review did not finish` and `/code-review returned no usable result`.
  - **`diff-for`.** `agent-review diff-for --diff <f> --raw <f>` prints the diff blocks for the files named in the raw list, repo-relative, in diff order. It prints nothing for `[]`.
- **Template content:**
  - **BEFORE YOU START.** Remove only this attempt's three lane files. Never touch `/tmp/code_review_capture*`.
  - **RETRY NOTE.** When `{{RETRY_NOTE}}` is non-empty, follow it. It may say to skip the Skill call because the capture already exists, and it names the last attempt's failure.
  - **STEP 1.**
    - Call the Skill tool once, with skill `code-review` and args exactly `{{SKILL_ARGS}}`.
    - Ignore the Skill tool's reply.
    - Run `agent-review capture-wait --run {{RUN_ID}} --effort {{EFFORT}}` with a Bash timeout of 600000.
    - On exit 3, run it again. On exit 1, reply `/code-review did not finish` and write no files.
  - **STEP 2.**
    - Print the capture's `result` with `node -e 'process.stdout.write(require("/tmp/code_review_capture.json").result)'`.
    - List the raw findings in plain words that mirror Task 4's rules: a JSON list is copied one to one; otherwise, one entry per line that cites `path:line`; `[]` only with `[]` or an explicit `(none)` or `No findings.`.
    - Write the raw file.
  - **STEP 3.**
    - Run `agent-review diff-for --diff {{DIFF_PATH}} --raw <raw file>`, and read only that output plus the code around each finding (#46). Skip this when the raw list is empty.
    - Score as today, but set `outside_range`, `doubted`, and `recategorized_from` instead of writing evidence prefixes.
    - `{{PROFILE_INSTRUCTION}}` is shown, and the template says the profile never justifies dropping or lowering a finding (#25).
    - Drops are `excluded` (with its glob) or `disproved` (with a quoted `file:line`). The REFUTED drop is removed.
  - **STEP 4.**
    - Write the scored and dropped files with a `node - <<'EOF'` heredoc and `JSON.stringify`.
    - Every scored entry carries `raw` and the three structured fields.
    - The template says that inside JS strings a backslash is written `\\` and a double quote `\"` (#18).
    - No `node -e '` write recipe remains.
  - **STEP 5.** Run:
    ```
    agent-review code-review-proof --capture /tmp/code_review_capture.json --raw <raw> --findings <scored> --dropped <dropped> --run {{RUN_ID}}
    ```
    - On `stage: lane`, fix the named problem and rerun, at most twice.
    - On `stage: capture`, reply `/code-review returned no usable result`.
    - Then give the final line.

- [ ] **Step 1: Write the failing tests** (`templates.test.cjs` unless noted):
  - `lane template placeholders are exactly the twelve listed`;
  - `lane template never writes the capture file or /tmp/agent_findings/code-review.json`;
  - `lane template has no node -e write recipe and uses a quoted node heredoc`;
  - `lane template calls capture-wait with --run {{RUN_ID}} --effort {{EFFORT}}` and loops on exit 3;
  - `lane template has no REFUTED drop and names both drop reasons`;
  - `lane template runs code-review-proof before its final line`;
  - in `cli.test.cjs`: `diff-for prints only the raw files' blocks, and nothing for []`.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the template rewrite and `diff-for`. Keep the SCORING CONTEXT, CATEGORY, CONFIDENCE, and SEVERITY anchors, and the 7+ bar wording, except where the structured fields replace prefixes.
- [ ] **Step 4: Run.** `npm run build && npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: lane waits for the hook capture and writes numbered, per-attempt results`

---

### Task 9: Review skill: split out the engine text, and fix it (final review #14, #19, #22, #30, #44, #45)

**Files:**
- Create: `skills/review/code-review-engine.md`
- Modify: `skills/review/SKILL.md`
- Test: `engine/templates.test.cjs` (update the pins that move, and add the new ones)

**Interfaces:**
- Consumes: `options --args-file` (Task 7).
- Produces: `skills/review/code-review-engine.md`, with one `##` section per stage it covers:
  - `## Stage 0`
  - `## Stage 1: the code-review lane`
  - `## Stage 2: checking the code-review lane`
  - `## Stage 6: the engine block`

  `SKILL.md` keeps a one-line pointer at each place, in the form `When $ENGINE is code-review, read code-review-engine.md, section "<name>", and follow it.`

- [ ] **Step 1: Write the failing tests.**
  - `SKILL.md has no code-review-engine-only prose outside one-line pointers`. Assert that the moved phrases (the lane placeholder table, the second smoke-test Task, and the proof bullet) appear only in `code-review-engine.md`.
  - `every SKILL.md line that mentions the code-review lane is gated on $ENGINE` (#19).
  - `Stage 6 fills the engine block whenever $ENGINE is code-review`. The "no engine key" omission rule is gone (#14).
  - `CI auto-skip report carries the options notes, and an incremental skip keeps the earlier notes` (#22).
  - `REVIEW_ARGS is written with a quoted heredoc to /tmp/review_args.txt and read with options --args-file` (#30).
  - `the code-review smoke test passes model haiku` (#44).
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the text, then apply the fixes. Bash blocks that run on both engines with an `if [ "$ENGINE" = ... ]` branch may stay in `SKILL.md`.
- [ ] **Step 4: Run.** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor: move code-review engine text out of the always-loaded review skill`

---

### Task 10: Review skill: capture wiring (spec section 2, Stage 2 rules; final review #24, #25, #34)

**Files:**
- Modify: `skills/review/code-review-engine.md`, `skills/review/SKILL.md` (Stage 0 cleanup only), `templates/report.md` (only if the dropped-line shape changes)
- Test: `engine/templates.test.cjs`

**Interfaces:**
- Consumes:
  - from Task 3: `capture arm` and `capture disarm`;
  - from Task 4: `capture-wait`;
  - from Task 5: the `code-review-proof` flags and output;
  - from Task 8: the template placeholders and lane files.
- Produces:
  - **Stage 0.**
    - Remove `/tmp/code_review_raw.*.json`, `/tmp/code_review_findings.*.json`, `/tmp/code_review_dropped.*.json`, and `/tmp/code_review_proof.json`.
    - Run `agent-review capture disarm`.
    - Remove the old `/tmp/code_review_raw.txt` line.
  - **Stage 1.**
    - Compose `CODE_REVIEW_ARGS="$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"` in Bash. `MAX_FINDINGS_FLAG` is ` --max-findings <n>`, or ` --max-findings default` when unset.
    - Run `agent-review capture arm --run "$REVIEW_ID" --args "$CODE_REVIEW_ARGS"`.
    - Fill `{{SKILL_ARGS}}` from the printed args and `{{RUN_ID}}` with `$REVIEW_ID`. Fill `{{ATTEMPT}}` with `$REVIEW_ID-1`, or `-2` on a relaunch. `{{RETRY_NOTE}}` is empty on the first launch.
    - **`{{DIFF_PATH}}` (#24).** For a full PR review, `git diff "$BASE_SHA...$HEAD_SHA" > /tmp/code_review_diff.txt` (merge base). For incremental and range reviews, `/tmp/pr_diff.txt` as today.
    - **`{{PROFILE_INSTRUCTION}}` (#25).** `chill`: "This repository uses the chill profile, so the report hides findings below 7. Score every finding honestly anyway; never drop or lower one for the profile." `standard` and `assertive`: "Score every finding honestly."
  - **Stage 2, for the code-review lane:**
    - Cross-check `<N>` against `/tmp/code_review_findings.<attempt>.json`.
    - Then run `agent-review code-review-proof --capture /tmp/code_review_capture.json --raw /tmp/code_review_raw.<attempt>.json --findings /tmp/code_review_findings.<attempt>.json --dropped /tmp/code_review_dropped.<attempt>.json --run "$REVIEW_ID" > /tmp/code_review_proof.json`.
    - **On a pass:** `cp /tmp/code_review_findings.<attempt>.json /tmp/agent_findings/code-review.json`.
    - **On `stage: lane`:** relaunch attempt 2 with the same capture. Its `{{RETRY_NOTE}}` says to skip the Skill call, and quotes the proof's `reason` (#34).
    - **On `stage: capture`, a `/code-review did not finish` reply, or `/code-review returned no usable result`:** re-arm, then relaunch attempt 2 with an empty `{{RETRY_NOTE}}`.
    - **On `stage: config`:** fail the run without a relaunch.
    - **Early handback.** If the lane hands back before `agent-review capture-wait --run "$REVIEW_ID" --effort "$EFFORT"` succeeds, run that command in Stage 2. Then wait up to 10 minutes for the same lane's next final line before judging or relaunching.
    - **Always** run `agent-review capture disarm` once the lane is judged (pass or final fail).
  - **Stage 6.**
    - `[N]` is `count` from the proof.
    - `[M]` is `findings.length` of the copied file.
    - `[K]` is `dropped.length` from the proof. List one line per drop: `<file>:<line> <summary>: <why>`.

- [ ] **Step 1: Write the failing tests.**
  - `code-review-engine.md arms capture with the composed args and fills SKILL_ARGS from it`;
  - `Stage 2 relaunches with the existing capture on stage lane, and re-arms on stage capture`;
  - `Stage 2 disarms capture after judging the lane`;
  - `Stage 2 waits for the lane's next final line after an early handback`;
  - `full PR reviews give the lane a merge-base diff`;
  - `Stage 6 renders drops from the proof's dropped list`;
  - `Stage 0 no longer mentions /tmp/code_review_raw.txt`.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: review skill arms, waits on, checks, and disarms the /code-review capture`

---

### Task 11: Other skills and the README sample (final review #8, #11, #12, #13, #15, #20, #21, #33)

One batched dispatch: these are independent text fixes in skills and the README, each with its own pin.

**Files:**
- Modify: `skills/init/SKILL.md`, `skills/update-files/SKILL.md`, `skills/address/SKILL.md`, `skills/yolo-review/SKILL.md`, `README.md` (sample config label only)
- Test: `engine/templates.test.cjs`

- [ ] **Step 1: Write the failing tests**, one per item:
  - **#8 init:** 3C and 3E decide CI copying from a shell variable set in 3A, not from `config get reviews_run`.
  - **#13 init:**
    - the approval answer is kept in `BOT_APPROVES`, set in 3A;
    - the approval-off edit is wrapped in `if [ "$BOT_APPROVES" = "no" ]`;
    - it edits with `sed` to a temp file plus `mv`, with no `-i.bak` and no `rm -f *.bak`.
  - **#33 init:** no named repo appears. The advice reads `recommend no for repos your team requires human review on, such as payment or financial code`.
  - **#11 update-files:** a 404 from classic protection counts as "could not verify". It counts as "none" only when `gh api repos/{o}/{r} --jq .permissions.admin` is `true`; otherwise the skill warns and requires an explicit yes.
  - **#12 update-files:** in a local-only repo, a missing approve workflow is offered by default, with the note "this is the only path that approves". The CI-file removal is never offered while the approve workflow is missing.
  - **#15 address:** when `reviews_run` is `local`, the closing message tells the author to run `/agent-review:re-review`, and no CI re-review is promised.
  - **#21 yolo-review:** if the review fails before posting, stop and show its error; address never runs against an older report.
  - **#20 README:** the sample block is labeled as an example of a local-only, code-review repo, not as the defaults.
- [ ] **Step 2: Run them.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** each item exactly as worded above.
- [ ] **Step 4: Run.** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: init, update-files, address, and yolo-review gaps for local-only and code-review repos`

---

### Task 12: Docs (spec section 7; final review #49)

**Files:**
- Modify: `README.md`, `docs/specs/2026-10-21-code-review-engine-design.md`, `engine/templates.test.cjs` (the test comment near line 1158), plus any other test comment that logs review history

- [ ] **Step 1: README.** Describe the hook capture in plain words:
  - the review waits for `/code-review` to finish, up to the effort limit, and fails closed after that;
  - the proof checks the lane against text a hook wrote.

  Replace the "self-written proof" known limitation with: "a lane could still overwrite the capture file on purpose; the check cannot rule that out."
- [ ] **Step 2: Engine spec.** Add one dated amendment line pointing to `docs/specs/2026-10-23-code-review-capture-design.md`.
- [ ] **Step 3: Test comments (#49).** Make every test comment state a constraint only. Search with `grep -n "round\|ruling\|review #" engine/*.test.cjs`.
- [ ] **Step 4: Run.** `npm test && npm run check-dist`. Expected: PASS.
- [ ] **Step 5: Commit.** `docs: describe the hook capture and its remaining limit`

---

### Task 13: Hands-on check (controller-run, spec "Verification")

Not an implementer task. The controller runs it after the final whole-branch review, with one `opus` subagent driving Herdr. The setup is the same as the 10-23 spike: the branch plugin is loaded only with `--plugin-dir`, the sandbox repo is `agent-review-sandbox`, and only the folder-trust dialog may be answered.

- [ ] **Step 1: Interactive xhigh review.** Run `engine=code-review` at `xhigh` on the seeded-bug PR. It must reach a posted report. Record `count`, `mode`, and the time taken.
- [ ] **Step 2: Interactive re-review.** Run one `re-review`. It must reach a posted report.
- [ ] **Step 3: Early handback.** Note whether the lane handed back early in either run. If it never did, say so. Do not force it.
- [ ] **Step 4: Unarmed check.** Run a plain `/code-review low <range>` with capture not armed. Confirm that no `/tmp/code_review_capture*` file is created or changed.
- [ ] **Step 5: Headless check.** Repeat one review with `claude -p`, to confirm the foreground path.
- [ ] **Step 6: Fresh review.** Run a fresh `/code-review xhigh --max-findings all` on PR #33 in a fresh Opus agent. Bring its findings to Justin before fixing anything.
