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
does not use the archetype. Read the plugin's `templates/code-review-lane.md`
(`../../templates/code-review-lane.md` from this file) and
fill its twelve placeholders:

| Placeholder               | Fill with                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{RUN_ID}}`              | `$REVIEW_ID` |
| `{{ATTEMPT}}`             | `$REVIEW_ID-1`, or `$REVIEW_ID-2` on a relaunch |
| `{{EFFORT}}`              | `plan.engine.effort`, the same value as `EFFORT` in `/tmp/review_env.sh`.                                                                                                                        |
| `{{SKILL_ARGS}}`          | The args printed by `agent-review capture arm`, composed as `"$EFFORT $CODE_REVIEW_TARGET$MAX_FINDINGS_FLAG"`. `MAX_FINDINGS_FLAG` is ` --max-findings <n>` when `plan.engine.maxFindings` is set, else ` --max-findings default`. |
| `{{RETRY_NOTE}}`          | Empty on the first launch |
| `{{PROFILE_INSTRUCTION}}` | For `chill`: "This repository uses the chill profile, so the report hides findings below 7. Score every finding honestly anyway; never drop or lower one for the profile." For `standard` and `assertive`: "Score every finding honestly." |
| `{{RISK_CONTEXT}}`        | The same bullet block as the archetype's `{{RISK_CONTEXT}}`, for this lane (`Selected because: engine`, `Model tier: <its tier>`).                                                               |
| `{{DIFF_PATH}}`           | `/tmp/code_review_diff.txt` (`git diff "$BASE_SHA...$HEAD_SHA"`, the merge base) for a full PR review; `/tmp/pr_diff.txt` for incremental and range reviews |
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
and that it scored or dropped every raw finding. Each scored finding needs a numeric severity from 1 to 10 and one of the nine
category names, and an `excluded path: <glob>` drop needs a glob from `excluded_paths` that
matches its file. Run
`agent-review code-review-proof --raw /tmp/code_review_raw.txt --findings /tmp/agent_findings/code-review.json --dropped /tmp/code_review_dropped.json > /tmp/code_review_proof.json`.
A non-zero exit fails the lane's cross-check even when its findings file passes, and so does a
reply of `/code-review did not run` in place of the `done` line. When the lane fails twice and
the proof failed, print the proof's `reason` (from `/tmp/code_review_proof.json`) right after
the loud line in `SKILL.md`'s Stage 2; it names the fix or the mismatch.

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
  `findings.length` in `/tmp/agent_findings/code-review.json`, and `[K]` is the length of
  `/tmp/code_review_dropped.json`; list one line per entry in that file (`file`, `line`,
  `summary`, `proof`) and omit the list when `K` is 0. A missing `/tmp/code_review_dropped.json`
  also means `K` is 0. Do not add a recipe tag.
