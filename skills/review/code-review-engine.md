# The code-review engine

Read this file only when `$ENGINE` is `code-review`. `SKILL.md` points here, by section name, at each
place where the engine changes what a stage does. Under the `agent-review` engine none of this
applies, and a repo's own lane that happens to have the id `code-review` is an ordinary lane.

Paths are relative to this file's directory, which is also `SKILL.md`'s.

## Stage 0

**The plan.** Under the `code-review` engine the plan also has an `engine` block (`name`, `effort`,
`model`, `maxFindings`, `replaces`, `always`), and `agents[0]` is the `code-review` lane: `always: true`,
`matchedBy: "engine"`, `tier` set to the engine's model, and `rules` listing the rule docs of the
lanes it replaces. The lanes in `engine.replaces` are not in `agents[]`.

**The launch list.** Under the `code-review` engine, with `ENGINE` read from `/tmp/review_env.sh`, the
launch list is the plan's `agents[]`, exactly, in every mode. Do not add, drop, or reorder. Quick does
not apply its 3-agent cap and deep does not add config-only lanes: the plan already holds the
`code-review` lane, every `engine.always` lane, and every other triggered lane outside
`engine.replaces`. A plan agent's `matchedBy` can also be `engine` (the `code-review` lane) or
`engine-always` (a lane forced on by `engine.always`).

**The agent list.** Under the `code-review` engine the displayed list starts with the `code-review`
lane, whose reason is `engine`.

**The start-up line.** Under the `code-review` engine the `reviewers:` line is exactly who will
review, so never restate it from memory.

**The smoke test.** Under the `code-review` engine, launch a second Task in the same message as the
first, identical except for **subagent_type** `"agent-review:reviewer-code-review"` and **model**
`"haiku"`, to confirm the code-review lane's agent type resolves too. The model override keeps the
probe cheap: resolving a type needs no Opus. Both must pass.

## Stage 1: the code-review lane

Only when `ENGINE` is `code-review`. The `code-review` lane (`agents[0]`, `matchedBy: "engine"`)
does not use the archetype.

First arm the capture. The review's hooks save /code-review's result only while capture is armed,
and only for a Skill call whose args match the armed args exactly. The same block writes the
lane's diff:

```bash
. /tmp/review_env.sh 2>/dev/null || true
set -e
if [ -z "$CODE_REVIEW_TARGET" ]; then
  echo "❌ No /code-review target. Run the learnings and impact block in SKILL.md's Stage 1 first."
  exit 1
fi
MAX_FINDINGS=$(node -e 'const e = require("/tmp/review_plan.json").engine || {}; console.log(e.maxFindings == null ? "" : String(e.maxFindings))')
MAX_FINDINGS_FLAG=" --max-findings ${MAX_FINDINGS:-default}"
CODE_REVIEW_ARGS="$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"
if [ -z "$INCREMENTAL" ] && [ -n "$PR_NUMBER" ] && [ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ]; then
  git diff "$BASE_REF...$HEAD_REF" > /tmp/code_review_diff.txt
  CODE_REVIEW_DIFF=/tmp/code_review_diff.txt
else
  CODE_REVIEW_DIFF=/tmp/pr_diff.txt
fi
agent-review capture arm --run "$REVIEW_ID" --args "$CODE_REVIEW_ARGS"
cat >> /tmp/review_env.sh <<EOF
export CODE_REVIEW_ARGS="$CODE_REVIEW_ARGS" CODE_REVIEW_DIFF="$CODE_REVIEW_DIFF"
EOF
echo "code-review diff: $CODE_REVIEW_DIFF"
```

If this block fails, stop the review and show its error. Without an armed capture, the lane's
result cannot be checked, so the review cannot finish.

From here until Stage 2 judges this lane, capture stays armed. If the run stops before then for
any reason, run `agent-review capture disarm` before you stop (Stage 2, step 5).

Then read the plugin's `templates/code-review-lane.md` (`../../templates/code-review-lane.md` from
this file) and fill its twelve placeholders:

| Placeholder               | Fill with                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{RUN_ID}}`              | `$REVIEW_ID`, the `<id>` in the `armed <id>: <args>` line |
| `{{ATTEMPT}}`             | `$REVIEW_ID-1`, or `$REVIEW_ID-2` on a relaunch |
| `{{EFFORT}}`              | `plan.engine.effort`, the same value as `EFFORT` in `/tmp/review_env.sh`.                                                                                                                        |
| `{{SKILL_ARGS}}`          | The args printed by `agent-review capture arm`, composed as `"$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"`. `MAX_FINDINGS_FLAG` is ` --max-findings <n>` when `plan.engine.maxFindings` is set, else ` --max-findings default`. Copy them exactly from the `armed <id>: <args>` line the block prints. |
| `{{RETRY_NOTE}}`          | Empty on the first launch and on a relaunch with a new capture; the note from Stage 2 on a relaunch with the same capture |
| `{{PROFILE_INSTRUCTION}}` | For `chill`: "This repository uses the chill profile, so the report hides findings below 4 that no other lane backs up. Score every finding honestly anyway; never drop or lower one for the profile." For `standard` and `assertive`: "Score every finding honestly." |
| `{{RISK_CONTEXT}}`        | The same bullet block as the archetype's `{{RISK_CONTEXT}}`, for this lane (`Selected because: engine`, `Model tier: <its tier>`).                                                               |
| `{{DIFF_PATH}}`           | The path the block above prints as `code-review diff:`. That is `/tmp/code_review_diff.txt` (`git diff "$BASE_REF...$HEAD_REF"`, the merge base) for a full PR review, and `/tmp/pr_diff.txt` for incremental and range reviews |
| `{{SCORING_RULES}}`       | The lane's `rules[]` (the `path_rules` this diff matches, then each enabled replaced lane's rule docs), rendered exactly like the archetype's `{{RULES}}`. `none` when `rules[]` is empty.       |
| `{{LEARNINGS}}`           | Entries from `/tmp/review_rules.json` whose `agent` is in `plan.engine.replaces` or is `code-review`, rendered like the archetype's `{{LEARNINGS}}`. Empty string when there are none.              |
| `{{IMPACT}}`              | The block the `architecture` lane would have received (see **`{{IMPACT}}` content** in `SKILL.md`'s Stage 1), under the same conditions. Empty string when impact was not computed or `blastRadius` is 0.        |
| `{{EXCLUDED_PATHS}}`      | The globs `agent-review config get excluded_paths` prints (a JSON array), one per line. `none` when the list is empty.                                                                          |

Launch the lane with the Task tool, in the same message as every other launch:

- **description**: `"Code review lane"`
- **subagent_type**: `"agent-review:reviewer-code-review"`, or `"general-purpose"` if `$ROUTING`
  is `degraded`
- **model**: the lane's `tier` from the plan (the engine's model)
- **prompt**: the filled `code-review-lane.md` text

Every effort level, `max` included, runs inside this lane. At `max`, `/code-review` starts its own
subagents and can run for 15 minutes or more; keep collecting the lane in Stage 2 like any other.

## Stage 2: checking the code-review lane

Under the `code-review` engine, the `code-review` lane must also prove `/code-review` ran,
and that it scored or dropped every raw finding. Judge it with the steps below, in place of the
findings-file cross-check and the unchanged-prompt retry in `SKILL.md`'s Stage 2. The rest of that
stage still holds: a lane that fails twice fails the run. Below, `<attempt>` is the attempt id the
lane was launched with: `$REVIEW_ID-1`, or `$REVIEW_ID-2` after a relaunch.

**1. Wait for the final line.** The lane's final line is one of three:
`done — <N> findings, max severity <X>` (the `done` line), `/code-review did not finish`, or
`/code-review returned no usable result`. A Task tool error, or a reply that shows the lane ended
before it called the Skill tool, counts as `/code-review did not finish`: no /code-review is
running, so there is nothing to wait for. Any other reply is an early handback: the lane called
the Skill tool and stopped while /code-review was still running in the background, and the
harness resumes the same lane when /code-review finishes. After an early handback, run this with
a Bash timeout of 600000 (10 minutes), and run it again each time it exits 3:

```bash
. /tmp/review_env.sh 2>/dev/null || true
agent-review capture-wait --run "$REVIEW_ID" --effort "$EFFORT"
```

Once it exits 0 or 1, keep collecting the same lane (TaskOutput) for up to 10 more minutes, and
judge its next final line. If none arrives by then, judge the lane on what it has written.

**2. Judge the reply.**

- `/code-review did not finish` or `/code-review returned no usable result`: /code-review's result
  is missing or unusable. Relaunch with a new capture (step 3).
- Anything else, including no final line after the wait in step 1: cross-check the lane, then run
  the proof below. The cross-check passes when the reply is the `done` line, and
  `/tmp/code_review_findings.<attempt>.json` parses and its `findings.length` equals `<N>`.

The proof checks the lane's three files against the saved /code-review result:

```bash
. /tmp/review_env.sh 2>/dev/null || true
ATTEMPT="$REVIEW_ID-1"   # ← "$REVIEW_ID-2" when judging the relaunch
agent-review code-review-proof --raw "/tmp/code_review_raw.$ATTEMPT.json" --findings "/tmp/code_review_findings.$ATTEMPT.json" --dropped "/tmp/code_review_dropped.$ATTEMPT.json" --run "$REVIEW_ID" > /tmp/code_review_proof.json
cat /tmp/code_review_proof.json
```

It prints one JSON line, `{ ok, stage, reason, count, mode, dropped }`, and exits 1 when `ok` is
`false`. Act on it:

- `ok` is `true` and the cross-check passed: the lane passed (step 4).
- `stage` is `"config"`: the review's config cannot be read, and a relaunch cannot fix that. Fail
  the run now, with no relaunch (step 5).
- `stage` is `"capture"`: relaunch with a new capture (step 3).
- `stage` is `"lane"`: relaunch with the same capture (step 3), with the proof's `reason`.
- `ok` is `true` but the cross-check failed: relaunch with the same capture (step 3), with one
  sentence that says what the cross-check found, such as `the final line reported 3 findings, but
  the findings file has 2`.

**3. Relaunch once.** Only attempt 1 is relaunched. When attempt 2 fails any check in step 2, the
lane has failed twice (step 5). For the relaunch, `{{ATTEMPT}}` is `$REVIEW_ID-2`,
`{{RETRY_NOTE}}` is set as below, and every other placeholder and Task input is the same as in
Stage 1. Then judge it with steps 1 and 2.

- **With the same capture.** Do not re-arm: /code-review's saved result stays in place, and the
  relaunch reuses it instead of running /code-review again. Set `{{RETRY_NOTE}}` to this, with the
  reason copied exactly:

  `In STEP 1, skip the Skill call: /code-review already finished for this run, and its saved result is still in place. Run STEP 1's capture-wait command, then do every later step. The earlier attempt failed the review's check with this reason: "<reason>"`

- **With a new capture.** Re-arm with this block first, which clears the old result, then
  relaunch with an empty `{{RETRY_NOTE}}`. If the block fails, do not relaunch: the run fails
  (step 5).

```bash
. /tmp/review_env.sh 2>/dev/null || true
agent-review capture arm --run "$REVIEW_ID" --args "$CODE_REVIEW_ARGS" || {
  echo "❌ review incomplete: the /code-review capture could not be re-armed, so no report was posted"
  exit 1
}
```

**4. Pass.** Copy the passing attempt's findings to the file consensus reads, then disarm the
capture:

```bash
. /tmp/review_env.sh 2>/dev/null || true
ATTEMPT="$REVIEW_ID-1"   # ← "$REVIEW_ID-2" when the relaunch passed
cp "/tmp/code_review_findings.$ATTEMPT.json" /tmp/agent_findings/code-review.json
agent-review capture disarm
```

**5. Fail.** When the lane fails twice, fails once at `stage: "config"`, or cannot be re-armed,
first disarm the capture:

```bash
agent-review capture disarm
```

Then stop the way `SKILL.md`'s Stage 2 says to for a lane that fails twice. At `stage: "config"`,
the loud line is instead
`❌ review incomplete: the code-review lane could not be checked, so no report was posted`, and
when the re-arm failed, it is the line the re-arm block printed. Right after the loud line, print
the proof's `reason` from `/tmp/code_review_proof.json`, or the lane's reply when no proof ran for
the last attempt; it names the fix or the mismatch.

Run the same disarm block whenever the run stops after Stage 1 armed the capture and before this
lane is judged: another lane fails twice, a later block fails, or the run ends for any other
reason.

Under the `code-review` engine the progress line, like every other place a lane title is shown, titles
the lane `Code Review (/code-review <effort>)`, since the plan gives it no `title`. Take `<effort>`
from `/tmp/review_options.json`.

## Stage 6: the engine block

- Under the `code-review` engine, the `code-review` lane has no `title` in the plan. Wherever a lane
  title is shown (the header's agents list, the summary table, the Stage 2 progress line), title it
  `Code Review (/code-review <effort>)`, with `<effort>` from `/tmp/review_options.json`.
- Fill the `[IF engine is code-review]` block whenever `$ENGINE` is `code-review`, whether the engine
  came from the config or from an `engine=code-review` argument in a repo with no `engine` key. Engine,
  effort and model, each with its `source`, come from `/tmp/review_options.json` (`engine`,
  `effort`, `model`). `[engine source]` is `engine.source`, and the effort and model sources are
  `effort.source` and `model.source`. `[N]` is `count` from `/tmp/code_review_proof.json`, `[M]` is
  `findings.length` in `/tmp/agent_findings/code-review.json` (the passing attempt's findings,
  copied there in Stage 2), and `[K]` is the length of the proof's `dropped` list. List one line
  per entry in that list, as `<file>:<line> <summary>: <why>` (just `<file>` before the summary
  when `line` is `null`), and omit the list when `K` is 0. Do not add a recipe tag.
