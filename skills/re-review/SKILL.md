---
name: re-review
description: Shallow local re-review — only the commits since the last posted review, merged into the same PR comment and printed in the terminal
---

# Re-review

Runs the review skill in local incremental mode. The canonical PR comment's reviewed-head SHA
sets the range, the previous ledger is merged (fixed and dismissed items keep their numbers and
statuses, new findings are appended), the comment is updated in place, and the findings are
printed exactly as the PR shows them. A zero-risk delta costs nothing and only advances the head
marker. If the recorded SHA is not an ancestor of the PR head (force-push) or there is no
posted review yet, this becomes a full review and says so.

**Usage**: `/agent-review:re-review` (optionally `quick`, `standard`, or `deep` in place of auto).

**Do this**: invoke `agent-review:review` with the arguments `auto incremental`
(substituting the user's mode for `auto` when they gave one) and follow it to the end. Nothing
else: this skill has no stages of its own.
