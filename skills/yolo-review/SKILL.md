---
name: yolo-review
description: Review, fix every blocker, re-review, and wait for the bot's approval — one command, no questions, never dismisses
---

# Yolo review

One command from "PR open" to "approved", within the rules every other skill keeps: fixes are
real code changes committed to the PR branch, nothing is dismissed on the AI's judgment,
suggestions below severity 7 are left for a human, and the approval itself is the bot's.

**Usage**: `/agent-review:yolo-review` (optionally `quick`, `standard`, or `deep` for the first
review; re-reviews always run `auto incremental`). `engine=agent-review|code-review` and
`effort=low|medium|high|xhigh|max` pass through to every review.

**Cost**: up to four reviews and three address passes on a bad branch; `auto` keeps the
re-reviews cheap.

## Steps

1. **Preconditions** — run this block; stop on any ❌.

   ```bash
   PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null)
   [ -n "$PR_NUMBER" ] || { echo "❌ No PR for this branch — open one first (gh pr create)."; exit 1; }
   [ -z "$(git status --porcelain)" ] || { echo "❌ Working tree is dirty — commit or stash first; yolo reviews and fixes committed code only."; exit 1; }
   HEAD_REF=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid)
   if [ "$(git rev-parse HEAD)" != "$HEAD_REF" ]; then
     git push || { echo "❌ Could not push local commits — the review must record the PR head."; exit 1; }
   fi
   agent-review config show >/dev/null || { echo "❌ No review config — run /agent-review:init first."; exit 1; }
   START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   echo "export PR_NUMBER=\"$PR_NUMBER\" START_TS=\"$START_TS\"" > /tmp/yolo_env.sh
   ```

2. **Review**. Invoke `agent-review:review` with the argument `auto` (or the user's
   mode), plus the user's `engine=` and `effort=` tokens, if any. It posts the report and prints
   the findings. If the review fails before posting (a config error, an invalid `engine=` or
   `effort=` token), stop and show its error; never run address against an older report.

3. **Fix blockers** — read the posted ledger:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   # Local canonical comment: this user's own marked comment when one exists, else the bot's.
   # Anyone else's could be a forged report.
   ME=$(gh api user --jq .login 2>/dev/null || echo "")
   gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq "(map(select(.body | startswith(\"<!-- agent-review -->\"))) | (map(select(.user.login == \"$ME\")) | first) // (map(select(.user.login == \"github-actions[bot]\")) | first)) | .body // empty" \
     | tr -d '\r' > /tmp/yolo_report.md
   sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' /tmp/yolo_report.md | head -1 > /tmp/yolo_ledger.json
   REPORTED_HEAD=$(sed -n 's/^<!-- agent-review-head: \([0-9a-f]\{7,40\}\) -->$/\1/p' /tmp/yolo_report.md | head -1)
   if [ -z "$REPORTED_HEAD" ] || [ "$REPORTED_HEAD" != "$(git rev-parse HEAD)" ]; then
     echo "❌ No report for the current head: the latest review or re-review failed before posting. Show its error and stop."; exit 1
   fi
   OPEN=$(node -e 'const l=require("/tmp/yolo_ledger.json"); console.log(l.filter(e=>e.status==="open"&&e.severity>=7).length)' 2>/dev/null || echo 0)
   echo "open blockers: $OPEN"
   echo "export FIX_FROM=\"$(git rev-parse HEAD)\"" >> /tmp/yolo_env.sh
   ```

   The guard in that block uses the report only if its `<!-- agent-review-head: <sha> -->` marker
   names the current `HEAD`, the commit the latest review or re-review covered. Address edits the
   comment but never that marker, so a re-review that failed before posting leaves an older head
   there, and no clock is compared. Otherwise stop and show the review's error; never run address
   against an older report.

   If `OPEN` is greater than 0, invoke the
   `agent-review:address` with the argument `fix blockers`.
   Never dismiss — not with any code, not for any reason; a finding that cannot
   be fixed stays open and is reported at the end. If `OPEN` is 0, skip to step 6.

4. **Re-review**. First check that address committed something:

   ```bash
   . /tmp/yolo_env.sh
   if [ "$(git rev-parse HEAD)" = "$FIX_FROM" ]; then
     echo "no new commit: address changed nothing, so there is nothing to re-review"
   fi
   ```

   If it prints `no new commit`, do not re-review: go to step 7 and report the open blockers as
   blockers that remain. Otherwise invoke `agent-review:review` with the arguments `auto incremental`, plus the
   user's `engine=` and `effort=` tokens, if any. If that re-review stops with `already reviewed`
   or `No net changes`, it found nothing new to review: once it has posted any report it says it
   moved, go to step 7 the same way. Only a re-review that ran goes on to step 5, whose guard then
   checks its report.

5. **Bounded loop** — recompute `OPEN` as in step 3. If it is greater than 0 and any open
   blocker is one this run has not yet tried to fix, repeat steps 3-4, at most two more times
   (three address passes in total). After that, stop looping regardless of what is open.

6. **Approval** — this session cannot approve: GitHub rejects self-approval, and the plugin's
   approval is the bot's, triggered by the posted comment through the consumer's
   `agent-review-approve.yml` (0.7.0+). Read the posted status:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   # Local canonical comment: this user's own marked comment when one exists, else the bot's.
   # Anyone else's could be a forged report.
   ME=$(gh api user --jq .login 2>/dev/null || echo "")
   STATUS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq "(map(select(.body | startswith(\"<!-- agent-review -->\"))) | (map(select(.user.login == \"$ME\")) | first) // (map(select(.user.login == \"github-actions[bot]\")) | first)) | .body // empty" | tr -d '\r' \
     | sed -n 's/^<!-- agent-review-status: \(.*\) -->$/\1/p' | head -1)
   PASS=$(printf '%s' "$STATUS" | jq -r '.pass // false'); IRREVERSIBLE=$(printf '%s' "$STATUS" | jq -r '.irreversible // false')
   HUMAN=$(printf '%s' "$STATUS" | jq -r '.humanRequired // false')
   echo "pass=$PASS irreversible=$IRREVERSIBLE humanRequired=$HUMAN"
   if [ "$IRREVERSIBLE" = "true" ]; then
     echo "Caution: this change is irreversible ($(printf '%s' "$STATUS" | jq -r '(.irreversibleReasons // []) | join("; ")')). A revert will not undo it. Check backups and the deploy plan before you merge."
   fi
   if [ "$HUMAN" = "true" ]; then
     echo "Stopping: a person must approve: $(printf '%s' "$STATUS" | jq -r '(.humanReasons // []) | join("; ")'). The bot will not approve this PR."
   fi
   if [ "$PASS" = "true" ] && [ "$HUMAN" != "true" ]; then
     for i in $(seq 1 9); do
       # gh's --jq takes one expression (no --arg); GraphQL reports the bot as github-actions.
       APPROVED=$(gh pr view "$PR_NUMBER" --json reviews \
         --jq "[.reviews[] | select(.author.login == \"github-actions\" or .author.login == \"github-actions[bot]\") | select(.state == \"APPROVED\") | select(.submittedAt > \"$START_TS\")] | length")
       [ "${APPROVED:-0}" -gt 0 ] && { echo "✅ Approved by the github-actions bot"; break; }
       [ "$i" -lt 9 ] && sleep 20
     done
     [ "${APPROVED:-0}" -gt 0 ] || echo "⏳ Ledger passes but no bot approval arrived within 3 minutes — this repo may not run agent-review-approve.yml with auto_approve on, or the workflow is still queued. The PR is ready for a human."
   fi
   ```

7. **Report** — one of: approved by the bot; ledger passes, no approval (say which of the two
   causes above applies if you can tell from `gh run list --workflow "agent-review approve"`);
   `N` blockers remain that could not be fixed (list each with its number, file:line, and the
   reason the fix was not applied); or a person must approve (`humanRequired` is true; give the reasons).
   If the change is irreversible, add the caution: a revert will not undo it, so check backups and the deploy plan before merging.
   End with the open suggestions (severity < 7) as a plain list. Do not run anything under
   `/tmp/automated_fixes`.
