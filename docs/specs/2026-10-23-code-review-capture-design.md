# Capturing `/code-review`'s result with hooks: design update

This updates `docs/specs/2026-10-21-code-review-engine-design.md` (the "engine spec"). It replaces how the `code-review` lane gets `/code-review`'s findings and how the engine proves they are real: engine spec section 5, steps 1, 2 and 4, and the proof check. Everything else in the engine spec still stands unless this document says otherwise.

Justin chose this direction (option B) on 2026-10-23, after the final `/code-review max` run and an interactive spike.

## Why

**The final review found a showstopper.** The `/code-review max --max-findings all` run on PR #33 reported 49 findings: 36 CONFIRMED, 13 PLAUSIBLE. In a normal interactive Claude Code session, the Skill tool runs `/code-review` in the background. The lane gets `Skill "code-review" launched (forked execution, running in the background)` instead of findings. The proof fails, and the review ends with no report. Every earlier test ran headless (`claude -p`), where the Skill call waits, so none of them saw this.

**The spike** (`scratchpad/hook-spike/REPORT.md`, Claude Code 2.1.309, interactive, driven through Herdr) showed:
- **Background behavior.** In interactive sessions, `/code-review` forks into the background for both main-thread and subagent callers. Its final text goes only to the caller, as a task notification. If a subagent caller has already finished, the findings never reach the main thread.
- **Hook visibility.** A plugin hook sees enough to capture the result:
  - `PostToolUse` on `Skill` returns `tool_response = {status: "forked", background: true, agentId: <fork id>}`.
  - `SubagentStop` for that fork carries `last_assistant_message`, which matched the notification's result text exactly in 4 of 4 runs, and `agent_transcript_path`.
  - The fork's `agent_type` is `general-purpose`, so link it by agent id.
- **Typed findings are main-thread only.** `CLAUDE_CODE_REPORT_FINDINGS=1` makes the main thread run the skill inline and call a typed `ReportFindings` tool. A subagent caller still gets a background fork, and that fork returns prose. A plugin cannot set the variable.
- **The prose varies in format.** Seen so far:
  - `(none)` followed by an explanation
  - lead-in sentences
  - `**path:line**:`
  - `` `path:line`: ``
  - line ranges

  Line-format parsers kept breaking on this through three review rounds.

## Goals

1. **The plugin captures the result, not the lane model.** The lane works in interactive sessions (background fork) and headless ones (inline result). The captured text is written by a plugin hook, not by the lane model.
2. **Grounding check replaces line-format parsing.** The lane lists the raw findings it read. The engine checks that every listed finding is grounded in the captured text, and that every location mentioned in the text is covered by a listed finding. This works whatever Markdown `/code-review` uses.
3. **Every scored and dropped entry traces to one raw finding.** Nothing can be silently swapped out or invented.
4. **Caps and drop reasons come from structured fields, not evidence wording.** This covers out-of-range, doubted, and excluded path.
5. **Fix the confirmed findings from the final review** that this redesign does not already remove. See "Fixes from the final review".

## Non-goals

- **CI does not get the engine.** It stays local-only, per engine spec section 8.
- **No typed ReportFindings path** (option C). It is main-thread only, depends on an env var the plugin cannot set, and would run the whole review inside the orchestrator's context.
- **The default engine's merge averaging is unchanged here** (final review #2). It is a pre-existing bug on main that changes behavior for every repo. It goes in a separate PR (see Follow-ups).

## Anti-goals

- A review that approves when `/code-review` did not finish, or whose findings never reached the lane.
- A hook that changes, slows, or writes files during sessions that are not running an agent-review code-review lane. For example, a developer's own `/code-review` use must be untouched.
- Any of the engine spec's anti-goals coming back.

## Design

### 1. Capture hooks (new `hooks/hooks.json` in the plugin)

Both hooks run `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-review" hook <name>`, which reads the hook payload from stdin. They must:
- always exit 0;
- print nothing;
- finish fast;
- do nothing at all unless capture is armed.

**Arming.** Stage 1 of the review skill arms capture before it launches the `code-review` lane:
- It writes `/tmp/agent_review_capture.json` = `{ "armed": true, "run_id": <REVIEW_ID>, "args": "<the exact Skill args the lane will pass>", "created": <epoch seconds> }`.
- It deletes any older `/tmp/code_review_capture.json`, `/tmp/code_review_capture.pending.json`, and `/tmp/code_review_capture.stops.jsonl`.
- Stage 2 disarms capture by deleting the arming file once the lane's cross-check finishes, whether it passed or failed.
- An arming file older than 3 hours counts as not armed.

**`hook post-skill`** (`PostToolUse`, matcher `Skill`). It acts only when all of these hold:
- capture is armed;
- `tool_input.skill === "code-review"`;
- `tool_input.args` equals the armed `args`.

Then it branches on `tool_response.background`, not on `status`. A headless run is a *foreground* fork: `status` is still `"forked"`, but `background` is false, and the fork's `SubagentStop` fires *before* this hook.
- **`background === true`.** Write `/tmp/code_review_capture.pending.json` = `{ fork_id: tool_response.agentId, args, caller: agent_id || "main", tool_use_id, session_id, ts }`. If the stop buffer (below) already holds a stop for that `fork_id`, also write the capture from the latest one, so the order of the two hooks never matters.
- **Otherwise.** The fork already finished. Write the capture right away with `mode: "foreground"`. Its `result` is the first of these that exists:
  1. `tool_response.result`, if it is a string;
  2. the text after `Result:` in the tool result;
  3. the latest stop-buffer entry for `tool_response.agentId`.

**`hook subagent-stop`** (`SubagentStop`, no matcher). While capture is armed, it appends `{agent_id, last_assistant_message, agent_transcript_path, ts}` to a stop buffer, `/tmp/code_review_capture.stops.jsonl`, keeping the last 50 lines. When a pending file exists and `agent_id === pending.fork_id`, it also (re)writes `/tmp/code_review_capture.json`.

**A fork can stop more than once.** At `max` it may stop while its helpers still run, then resume. A failed or interrupted fork stops with whatever text it had. Every matching stop overwrites the capture, so the last stop wins, and `stop_count` goes up by one each time. Whether a capture is finished is decided by `capture-wait` (section 2), not by the hook.

The capture file:

```json
{
  "source": "agent-review-capture-hook",
  "mode": "forked",
  "run_id": "<from the arming file>",
  "args": "<pending.args>",
  "fork_id": "<pending.fork_id>",
  "result": "<last_assistant_message>",
  "transcript": "<agent_transcript_path>",
  "stop_count": 1,
  "ts": "<epoch seconds>"
}
```

`mode` is `"forked"` or `"foreground"`.

If `last_assistant_message` is missing or empty, `result` is the last assistant text block in `agent_transcript_path`.

Both writes are atomic: write a temp file, then rename it.

**Amendment, 2026-10-23 (headless check, plan Task 1).** A headless run on Claude Code 2.1.309 omits `background` from `tool_response` entirely. Its keys are `success`, `commandName`, `status: "forked"`, `agentId`, and `result`. The rule `background === true` sends it down the foreground path, as intended.
- `result` is the fork's full final text, with no `Result:` header. It equals the fork's `last_assistant_message`.
- In both runs (`low` and `xhigh`), the fork's `SubagentStop` fired before `PostToolUse(Skill)`.
- The payload's `agent_id` is the caller's id. The fork is identified only by `tool_response.agentId`.
- The Bash sandbox shares `/tmp` with the hooks.

**Amendment, 2026-10-23 (security review, plan Task 3).** The capture files live in a private per-user directory, `/tmp/agent-review-<uid>`, where `<uid>` is the user's numeric id. The root stays `/tmp`, so the hooks and the sandboxed Bash tool agree on the path. The file names inside the directory are the ones this spec gives. Read each `/tmp/<capture file>` above as `/tmp/agent-review-<uid>/<capture file>`.
- Only `agent-review capture arm` creates the directory, with mode 0700.
- Every reader and writer first checks the directory with `lstat`. It must be a real directory, not a symlink, owned by the current user, with no group or other permission bits. If the check fails or the directory is missing, the hooks do nothing (they still exit 0 and print nothing), and the CLI commands exit 1 with the reason.
- Writes go through a temp file created with exclusive create (`wx`), then a rename. The stop buffer is appended with `O_APPEND | O_CREAT | O_NOFOLLOW`, and its trim also goes through an exclusive temp file and a rename.
- The hooks read a subagent transcript only from an absolute path that ends in `.jsonl`.
- The lane reads the result with `agent-review capture show --run <id>`. It prints the captured `result` exactly, with no added newline, or exits 1 when no capture for that run exists. No template names a capture path.

**Amendment, 2026-10-24 (fresh review).** An arming file older than 6 hours counts as not armed, in place of the 3 hours above. At `max`, `/code-review` can take up to 120 minutes, the lane can then take an hour to score, and a relaunch with the same capture runs `capture-wait` again, so 3 hours could expire the arm while a valid capture was still in place. `post-skill` strips one leading `/` from `tool_input.skill` before it matches, so `/code-review` counts as `code-review` and `/x:code-review` writes a mismatch like `x:code-review`. The "text after `Result:`" source applies only when the result's first non-empty line is the Skill header (`Skill "code-review" completed ...`) and a line that is exactly `Result:` follows within the next 3 lines; any other text is kept whole, so a `Result:` line inside /code-review's own text never cuts off the findings above it. Both hooks run `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-review-hook" <name>`, a plain-Node entry that works out the capture dir the same way the CLI does and exits 0 at once when the arm file is missing. It loads the bundled CLI only when the arm file exists, and then runs the same code as `agent-review hook <name>`, so a session with nothing armed never pays for loading the bundle.

**Amendment, 2026-10-27 (PR #33 review).** The light hook entry parses the arm file and loads the bundled CLI only when `armed` is `true` and `created` is within the 6-hour limit, so an arm left behind by an interrupted review no longer loads the bundle on every hook event. Any read or parse error exits 0 with no output. The entry keeps its own copy of the limit, and a test checks it equals `ARM_MAX_AGE_SECONDS`. A `Result:` line within 3 lines of the Skill header may carry text after the label; that text starts the result, so `Result: (none)` is captured as `(none)`. The header is stripped only when every line between it and that `Result:` line is blank; otherwise the text is kept whole, findings above it included.

**Wiring and tests.** The hook logic lives in a pure, unit-tested engine module (`engine/captureHook.cjs`). It takes the payload and the arming and pending state, and returns the file writes to make. The CLI wrapper does the I/O. Engine tests cover:
- not armed;
- args mismatch;
- a background fork followed by a matching stop;
- a matching stop that arrives before the background `PostToolUse` (read from the buffer);
- a foreground fork whose stop came first, with each of the three `result` sources;
- two matching stops, where the second wins and `stop_count` is 2;
- a non-matching stop, such as other subagents or internal helpers with an empty `agent_type`;
- a missing `last_assistant_message` with a transcript fallback.

### 2. The lane waits for the capture

The lane template (`templates/code-review-lane.md`) STEP 1 becomes:
1. Call the Skill tool exactly as the template says, with the same args the skill armed.
2. Do not read findings from the Skill tool's reply. The reply may say "launched" or may contain the result. Either way, wait with the engine's command: `agent-review capture-wait --run <run_id> --effort <effort> --timeout <seconds>`.
   - It polls every 5 seconds. It exits 0 once the capture for that `run_id` *looks finished*:
     - At `max`, the only effort whose recipe starts helpers, the capture must hold a non-empty qualifying JSON findings list (section 4) or an explicit empty marker (`(none)` or `No findings.`). A fenced `[]` alone does not count at `max`, and any other text means the fork stopped while its helpers still run, so polling continues.
     - At every other effort, the first capture counts as finished. Unusable text then fails the check in section 4 right away, instead of waiting out the limit.
   - Each call stays under the Bash tool's 10-minute limit. The lane re-runs it until the overall time limit for the effort level runs out:

     | Effort | Overall limit |
     | --- | --- |
     | low | 10 min |
     | medium | 15 min |
     | high | 20 min |
     | xhigh | 40 min |
     | max | 120 min |

   - If the time limit runs out, the lane writes no findings files. It replies with the one line `/code-review did not finish`.
3. Read the captured `result`. That text is the only source of raw findings. The lane never writes or edits the capture file.

**Stage 2 must not treat a lane's early handback as done.**
- The cross-check runs only after the lane's final line arrives and `capture-wait` succeeds.
- If a lane hands back before the capture looks finished, the harness resumes that same lane once the fork finishes (the spike saw this). Stage 2 waits for that lane's next final line, up to 10 minutes after the capture looks finished, before it judges or relaunches the lane.

**Each lane launch writes its own files.**
- Each launch gets an attempt id, `<run_id>-<k>`, in its prompt, and writes the three files in section 3 under that id.
- The check reads only the current attempt's files.
- After a passing check, the skill copies that attempt's scored file to `/tmp/agent_findings/code-review.json` for consensus.
- A late or resumed earlier attempt can then never mix its files with a relaunch.

### 3. Lane output: raw list, scored list, dropped list

The lane writes three files with a quoted heredoc and `node`, so no shell or JS-string escaping can change the text. This applies to every write recipe in the template. Use the pattern `node - <<'EOF' ... EOF`, with `JSON.stringify` inside.

**`/tmp/code_review_raw.<attempt>.json`.** The raw findings the lane read from the captured text, in order: `[{ "n": 1, "file": "lib/cart.rb", "line": 51, "summary": "<short paraphrase>" }]`.
- `line` is the first line number for a range, or `null` when the source gives no line.
- `[]` when `/code-review` reported nothing.
- When the capture holds a qualifying JSON findings list (section 4), the raw list copies it one to one: same order, same `file` and `line`.

**`/tmp/code_review_findings.<attempt>.json`.** Today's lane format, plus four fields on every scored entry:
- `raw`: the `n` it came from.
- `outside_range`: `true` or `false`.
- `doubted`: `true` or `false`.
- `recategorized_from`: a cleanup category name, or `null`.

**`/tmp/code_review_dropped.<attempt>.json`.** One of two shapes:
- `[{ "raw": n, "reason": "excluded", "glob": "<glob from excluded_paths>" }]`
- `[{ "raw": n, "reason": "disproved", "proof": "<file:line> <quoted code>" }]`

The `REFUTED` drop rule is removed. `/code-review` already leaves REFUTED findings out of its output (final review #5).

### 4. The check (`agent-review code-review-proof`, rewritten)

**Inputs:**
- `--capture /tmp/code_review_capture.json`
- `--raw /tmp/code_review_raw.<attempt>.json`
- `--findings /tmp/code_review_findings.<attempt>.json`
- `--dropped /tmp/code_review_dropped.<attempt>.json`
- `--run <run_id>`

It reads `excluded_paths` from the config, and checks file existence under `--root`. Output: `{ok, reason, count}`. It fails closed with a clear reason when any of these does not hold.

**Amendment, 2026-10-24 (final review).** `--capture` is removed: the proof always reads the capture from the private capture directory, `/tmp/agent-review-<uid>`, so no caller can point it at a hand-written file. `--promote <f>` writes the exact findings bytes the proof checked to `<f>`, atomically, when `ok` is true, and removes `<f>` when it is false; Stage 2 promotes to `/tmp/agent_findings/code-review.json`, so consensus reads exactly the proved file. A `disproved` proof must cite a file that exists under `--root`, a line from 1 to the file's line count, and quoted code right after that `path:line`, at least 3 non-space characters, that appears within 2 lines of it when whitespace is ignored. In text mode an `excluded` drop needs every mention on its claimed finding line to match an excluded glob, so a second location cannot carry a finding out. `capture-wait` fails within 60 seconds when no pending, capture, or mismatch file for the run exists, because then the hooks did not run. Two different non-empty qualifying JSON lists fail closed with `stage: capture`; this replaces "the last" qualifying list below.

**Amendment, 2026-10-24 (fresh review).** A `json` or unlabeled fenced block is list-like only when it parses to an object with a `findings` key, parses to an array that is empty or holds at least one plain object, or does not parse and contains `"file"`. So a quoted `["dist/**"]`, a Ruby `[1, 2].each { ... }`, or a TOML `[package]` is ordinary text, while a cut-off list still fails closed. A mention path with no `/` counts only when the reviewed commit has a file with that exact path or with that file name (`git ls-tree -r --name-only -z` of the same commit the disproof checks read, `--head` or `HEAD`, once per run), so the local index never decides. If that listing fails, the proof fails with `stage: config`. So `api.stripe.com:443` and `ruby:3.3` in prose are not mentions, while `Gemfile:12` and `cart.rb:12` (for a tracked `lib/cart.rb`) are. A path with a `/` keeps the text-mode rule below. A `path:0` mention names its file with no line, and a raw entry with `line: null` claims it. A `disproved` proof must quote the whole cited line: the cited line, with whitespace removed, has at least 6 characters and appears in the quote with whitespace removed. This replaces "at least 3 non-space characters, that appears within 2 lines of it" above. So a cited `end`, `}`, or `nil` line can never support a disproof, and neither can a fragment of a longer line. The quote may run on into the lines around the cited one. `code-review-proof` takes an optional `--head <sha>`. The disproof checks read the file at that commit, with `git cat-file` (the path must be a blob there) and `git show`, run in `--root`; without `--head` they read the commit `HEAD` names in `--root`. They never read the working tree. Stage 2 passes the reviewed head, `HEAD_REF`, or the local `HEAD` when `HEAD_REF` is empty. A `--head` that is not a commit fails with `stage: config`. The lane's own check in STEP 5 keeps the default.

**Amendment, 2026-10-27 (PR #33 review).** A `json` or unlabeled fenced block that does not parse is list-like only when its trimmed body starts with `[` or `{` and contains `"file"`. So quoted code such as `request.files["file"]` or `upload.single("file")` is ordinary text, while a cut-off list still fails closed. A mention path with no `/` that has a `.` or a capital letter counts when a tracked file has that file name at any depth; an all-lowercase one with no `.` counts only when that exact root-level path is tracked. Image tags are always lowercase, so `node:20` is not a mention when only `bin/node` is tracked, while `Dockerfile:3` (a tracked `docker/Dockerfile`) and `cart.rb:12` (a tracked `lib/cart.rb`) are. `code-review-proof` takes an optional `--base <sha>`, and the tracked files are those at `--head` plus those at `--base`, so a finding on a root-level file the change deletes still needs a claim. A `--base` that is not a commit, or whose files cannot be listed, fails with `stage: config`. Disproof reads stay at `--head`. The text after `path:line:` inside the same token is part of the quote, so a `grep -n` style proof of an unindented line (`Makefile:3:test: build lint`) passes. The disproof checks read each file with one `git cat-file blob <commit>:./<path>`, which fails for a missing path or a non-blob. Stage 1 saves the reviewed head and base as `REVIEWED_HEAD` and `REVIEWED_BASE`: `HEAD_REF` or the local `HEAD`, and the commit the lane's diff starts from (the merge base for a full PR review, else the start of `RANGE`). The lane's own check in STEP 5 passes the same `--head` and `--base` as Stage 2, so both read the same commits, and the lane reads the code it quotes and the code it scores with `git show <head>:./<path>`. This replaces "keeps the default" above.

**Capture**
- The capture file exists, parses, has `source === "agent-review-capture-hook"`, and has a `run_id` matching `--run`. Its `result` is a string.

**JSON mode.** The `xhigh` and `max` recipes tell `/code-review` to "return findings as a JSON array" of `{file, line, summary, failure_scenario}`. The 10-21 spike's `xhigh` result put summary bullets in prose above that array.
- A *qualifying JSON findings list* is the last fenced block, labeled `json` or unlabeled, that parses to an array (or to `{findings: [...]}`) whose items are all plain objects with a non-empty string `file`. `[]` qualifies.
- When one exists, it is the only source of raw findings, and the prose around it is ignored.
- The raw list must match it one to one: same count, and for each `n` the same `file` and the same `line` (`null` when the object has none).
- If no list qualifies but a `json` or unlabeled fenced block fails to parse or is never closed, the check fails. That is a cut-off result.

**Text mode.** With no qualifying JSON list, the text is the source. This is the `low`, `medium`, and `high` path, where the recipe asks for one line per finding. The text is normalized by removing `*`, `_`, and backticks.
- A *mention* is a `path:line` or `path:A-B` token. Its `path` contains a letter, and either contains `/` or `.` or names an existing file under `--root`. A range may use `-`, an en dash, or an em dash.
- A *finding line* is any line with at least one mention, nested bullets included.
- Each raw entry claims exactly one finding line. That line must have a mention with the entry's `file` whose line (or range start) equals the entry's `line`. An entry with a `null` line claims a line that names its file with no line number.
- Each finding line is claimed by exactly one raw entry. So two findings at one location need two raw entries, and an entry at line 51 cannot claim a `49-59` line.
- An unclaimed finding line fails the check, naming it.
- **There is no "context" exception.** A line that cites a location only as context still counts as a finding line and fails if unclaimed. That includes an explanation under `(none)`. This is on purpose: an exception is a hole the lane could use to hide a finding.

**Empty results.** The raw list may be empty only when:
- the qualifying JSON list is `[]`; or
- the text has no finding lines and has a line that is exactly `(none)` or `No findings.`

Any other text that yields no findings fails closed.

**Accounting**
- Every raw `n` is used exactly once across scored and dropped entries (by their `raw` field). No other `raw` values may appear.
- `count` is the number of raw entries.

**Scored entries.** Every scored entry has:
- a non-empty `file`;
- `line`: a positive integer or `null`;
- a non-empty `message`;
- `severity`: an integer from 1 to 10;
- `category`: one of the nine names;
- `confidence`: `High`, `Medium`, or `Low`;
- `evidence`: a string;
- the four structured fields from section 3.

Its `file` equals its raw entry's `file`. The line may differ, because a scorer may anchor to the changed line that makes the bug reachable.

**Dropped entries**
- `excluded`: the glob is in `excluded_paths`, and the raw entry's file matches it (the same `pathMatches` that `selectAgents` uses).
- `disproved`: `proof` is non-empty and names a `file:line`.

### 5. Consensus reads structured fields

Under the code-review engine, `capCodeReviewFinding` uses these fields instead of evidence prefixes:

| Field | Rule |
| --- | --- |
| `outside_range: true` | caps at 6 |
| `doubted: true` | caps at 4 |
| cleanup category | caps at 6 |
| `recategorized_from` set | allowed only when it is a cleanup name and the new category is `correctness` or `security`; otherwise the cleanup cap still applies |

The evidence-prefix matching and the floor/clamp code are removed. The check guarantees whole-number severities, so consensus no longer needs either (final review #10 and #35). The blocker bar (`blockerBarFailure`) and the proven-blocker rule stay as they are, simplified to `max(mean, strongest proven severity)` (final review #36).

### 6. Fixes from the final review

These are the final review's numbers, from `scratchpad/final-ordered.json`. Each line names the decided fix. Items fully removed by sections 1 to 5 are listed under "Removed by the redesign".

**Correctness**
- **#8 init.** 3C and 3E decide CI copying from the answer kept in a shell variable that 3A sets, not from `config get` (the config may point at files not written yet). Read it once and reuse it.
- **#11 update-files.** A 404 from classic protection counts as "could not verify", not "none", unless `gh api repos/{o}/{r} --jq .permissions.admin` is `true`. In that case, warn and require an explicit yes.
- **#12 update-files.** In a local-only repo, a missing approve workflow is offered by default with a plain "this is the only path that approves" note. Never offer to remove CI files while the approve workflow is missing.
- **#13 init.**
  - Keep the approval answer in a shell variable set in 3A.
  - Guard the approval-off edit with `if [ "$BOT_APPROVES" = "no" ]`.
  - Edit with `sed` writing to a temp file and moving it back. No `-i.bak`, and no `rm -f *.bak`.
- **#14 Stage 6.** Fill the engine block whenever `$ENGINE` is `code-review`, from an argument or from config.
- **#15 address.** In a local-only repo (`reviews_run: local`), after pushing fixes, tell the author to run `/agent-review:re-review`. Do not promise a CI re-review.
- **#17 options.** Pass the raw arguments to `agent-review options` as `--args=<value>`, or read them from stdin, so a leading `--` token is not lost. Only a `ci` token or the CI environment sets `ci`.
- **#19 review skill.** Gate every "code-review lane" instruction on `$ENGINE` being `code-review` (lines ~914, ~1137, ~1769).
- **#20 README.** Label the sample config as an example of a local-only, code-review repo, not "the defaults".
- **#21 yolo-review.** If the review fails before posting, stop and show its error. Do not run address against an older report.
- **#22 CI auto-skip.** The skip report includes the options notes (CI_NOTE), and an incremental skip keeps the earlier report's notes.
- **#23 start-up line.** The deep-mode note does not cover lanes skipped for no matching hunks.
- **#24 out-of-range diff.** For the code-review lane's out-of-range judgment, use the merge-base diff (`BASE...HEAD`), the same view `/code-review` gets from a PR number. Other lanes are unchanged.
- **#25 profile.** Give the code-review lane `{{PROFILE_INSTRUCTION}}`. Under `chill`, the scorer drops nothing. It scores honestly, and the existing consensus cutoff hides low-severity findings as it does for every lane.
- **#27 consensus.** Trim evidence when choosing the longest, and never let a merged 7+ carry blank evidence. Prefer the strongest member's evidence when it qualifies.
- **#28 options.** `resolveOptions` reports every problem from `codeReviewEngineProblems`, with the same wording as `config validate`.
- **#29 `--max-findings` notes.** Remove the reset and change notes from the start-up line, along with their tests and the README sentence. The Skill path never stores the limit, so the notes were false. Keep passing `--max-findings default` when the limit is unset.
- **#30 REVIEW_ARGS.** Set it with a quoted heredoc, so quotes, `$(...)`, and backticks in the user's arguments are inert.
- **#31 mode words.** The message for two mode words says exactly that, naming both words. It does not mention `mode=`.
- **#33 init.** Replace the named-repo advice with generic wording: "recommend no for repos your team requires human review on, such as payment or financial code".
- **#34 lane retry.**
  - When the capture exists and grounding passed, but the lane's accounting or entries failed, the relaunch reuses the existing capture. It does not call `/code-review` again, and it is told the exact failure reason.
  - Only a missing or unusable capture re-runs `/code-review`.

**Cleanup**
- **#37:** one exported constant for the engine name and one for the lane id. Use them everywhere, and compare engine names to the engine constant.
- **#38:** the nine category names and the five cleanup names come from one module. The lane template's list is pinned to it by a test.
- **#39, #40:** effort levels, engine names, and mode words come from one place each. The schema is checked against them by a test.
- **#41:** excluded-path matching uses `selectAgents`' `pathMatches`.
- **#43:** `review.yml` reuses the engine value from the step that already read the trusted config. Run the read-engine action only under `if: inputs.auto_approve`.
- **#44:** the routing smoke test for `reviewer-code-review` passes `model: haiku`.
- **#45:** move the code-review-engine-only text of the review skill into `skills/review/code-review-engine.md`. The skill reads it only when `$ENGINE` is `code-review`. The always-loaded skill keeps one-line pointers.
- **#46:** the scorer reads only the diff hunks for files named in raw findings, not the whole diff.
- **#49:** test comments state constraints only, with no review history.

**Removed by the redesign:** #1, #3, #4, #5, #6, #7, #10, #16, #32, #35, #36, #42.

**Kept as they are:**
- **#9 and #26 (ledger location matching).** Raise the wording threshold from 0.3 to 0.5, to match consensus `sameGroup`. Blockers still never merge by location. A reworded blocker can repeat, which fails safe.
- **#47 and #48:** small efficiency costs, left alone.

### 7. README and the engine spec

- The README describes the hook capture in plain words, including that the review waits for `/code-review` to finish.
- It drops the "known limitation" about the self-written proof. That limitation narrows to "a lane could still overwrite the capture file deliberately". Say so plainly.
- Add one amendment line to the engine spec that points to this document.

## Build order note

The first plan task is a short local check of the hooks' payload order in a headless run (`claude -p` with a `--plugin-dir` logging plugin, like the interactive spike) at `low` and at `xhigh`. It confirms three things before anything is built on them:
- `tool_response.background === false`;
- the fork's `SubagentStop` fires before `PostToolUse(Skill)`;
- where the result text sits in `tool_response`.

If any of these differs from section 1, adjust section 1 before building.

## Verification

- **Engine tests** cover:
  - the capture hook (every case in section 1);
  - `capture-wait`;
  - JSON mode, using the 10-21 spike's `xhigh` result (prose bullets above a JSON array) as a fixture;
  - text mode with every prose shape the spike saw, plus the final review's reproductions (#3, #4, #5, #6, #7);
  - same-location findings, a range line, a nested bullet, and an unclaimed context line;
  - accounting and entry checks;
  - consensus with the structured fields;
  - every fix in section 6.
- **Hands-on check, interactive, through Herdr,** in the private test repo:
  - one `engine=code-review` review at `xhigh` on a seeded bug, and one `re-review`, each reaching a posted report;
  - one run where the lane hands back early;
  - one run where capture is not armed, to confirm a plain `/code-review` writes nothing.

  Then repeat one review headless (`claude -p`) to confirm the inline path.
- Then a fresh `/code-review xhigh --max-findings all` on the updated PR, and a `max` run only if it turns up anything structural.

## Follow-ups (separate PRs, proposed to Justin)

- **Default-engine blocker averaging** (final review #2). A proven 7+ is averaged below the bar on every engine. This is a real approval hole on main, and the fix changes default behavior.
- **archetype.md write recipe** (final review #18's note). Other lanes have the same backslash-escaping bug in their `node -e` example.
- The four pre-existing main bugs already listed in PR #33's description.

**Amendment, 2026-10-27 (PR #35).** PR #35 does the default-engine blocker averaging follow-up, so the Non-goals line that keeps the averaging unchanged and the Follow-ups entry for it are done. On every engine, a 7+ that survives its lane's caps and the blocker bar keeps its score when it groups with lower findings, and two 7+ findings group at the higher score. A 7+ group takes the primary's trimmed evidence, else the longest trimmed; a group below 7 takes the longest trimmed evidence; the recommendation is the longest trimmed. When a later review brings back an open ledger entry's signature at a higher severity, the entry becomes the new finding, cleaned like any new finding, and keeps only its number and its open status. Nothing else of the old averaged entry survives. Dismissed and fixed entries never change.

**Amendment, 2026-10-27 (ledger matching).** Under the `code-review` engine, a blind matcher now catches reworded suggestions, so the limit that re-reviews add near-duplicate suggestions is addressed. The location match stays, but it misses most rewordings: the hands-on check measured them at a Jaccard of 0.06 to 0.44. Scoring stays blind: nothing changes in the code-review lane, its template, or the proof, and scores are final once the proof promotes the findings file. At ledger time, `agent-review ledger-candidates` runs the same steps as the ledger merge and pairs each finding the merge would still add (below 7, not static) with every earlier entry that is not fixed, from the same lane and file, within 10 lines. Each pair holds only the two findings' line, category, message, evidence, and recommendation, never a severity, status, lane, or confidence. A fresh sonnet agent reads only those pairs and writes only pair ids and `true` or `false`, so it cannot change a score. `agent-review ledger --matches` computes the pairs again and refuses any answer that is not one of them. A new finding with a `same: true` pair is not added, and the earlier entry never changes, so a wrong match hides only the new wording, never the old issue. If the matcher fails or its answers are refused, the ledger is built without them and the run goes on.

## Calls made after the builder check (Claude's, for Justin to check)

1. **JSON comes back for `xhigh` and `max`.** Their recipes ask for a JSON array, so the check reads that array and ignores the prose around it. The text rules apply only to `low`, `medium`, and `high`.
2. **The hooks don't depend on firing order.** Headless runs fire the fork's stop before `PostToolUse`. A small stop buffer covers both orders.
3. **The last stop wins.** `capture-wait` decides when a capture is finished: at `max`, a non-empty JSON list or an explicit empty marker; at other efforts, the first capture.
4. **Strict text mode.** One raw finding per finding line, and no context exception. The cost: a `low`, `medium`, or `high` result that cites a line only as context fails the run, and the review must be rerun. `xhigh`, the default, is not affected, because its prose is ignored.
5. **One set of files per lane attempt.** A resumed earlier lane can't overwrite a relaunch's files.

## Left to the builder

- Exact file names for new modules, beyond those named here.
- Poll interval details, and the exact `capture-wait` output text.
- Test fixture wording.

**Amendment, 2026-10-24 (probe P5).** At `max`, a non-foreground capture looks finished only when it holds a non-empty qualifying JSON list or an explicit empty marker (`(none)` or `No findings.`). A fenced `[]` alone no longer counts, because an early stop that quotes `[]` would otherwise let the review approve before `/code-review` finishes. Foreground captures and the other efforts are unchanged.
