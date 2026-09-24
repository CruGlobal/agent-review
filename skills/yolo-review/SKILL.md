---
name: yolo-review
description: Review, fix every blocker, re-review, and wait for the bot's approval — one command, no questions, never dismisses
---

# Yolo review

One command from "PR open" to "approved", within the rules every other skill keeps: fixes are
real code changes committed to the PR branch, nothing is dismissed on the AI's judgment,
suggestions below severity 7 are left for a human, and the approval itself is the bot's.

**Usage**: `/agent-review:yolo-review` (optionally `quick`, `standard`, or `deep` for the first
review; re-reviews always run `auto incremental`).

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
   agent-review config validate >/dev/null || { echo "❌ No review config — run /agent-review:init first."; exit 1; }
   START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   echo "export PR_NUMBER=\"$PR_NUMBER\" START_TS=\"$START_TS\"" > /tmp/yolo_env.sh
   ```

2. **Review** — invoke `agent-review:review` with the argument `auto` (or the user's
   mode). It posts the report and prints the findings.

3. **Fix blockers** — read the posted ledger:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' | tr -d '\r' \
     | sed -n 's/^<!-- agent-review-ledger: \(.*\) -->$/\1/p' | head -1 > /tmp/yolo_ledger.json
   OPEN=$(node -e 'const l=require("/tmp/yolo_ledger.json"); console.log(l.filter(e=>e.status==="open"&&e.severity>=7).length)' 2>/dev/null || echo 0)
   echo "open blockers: $OPEN"
   ```

   If `OPEN` is greater than 0, invoke the
   `agent-review:address` with the argument `fix blockers`.
   Never dismiss — not with any code, not for any reason; a finding that cannot
   be fixed stays open and is reported at the end. If `OPEN` is 0, skip to step 6.

4. **Re-review** — invoke `agent-review:review` with the arguments `auto incremental`.

5. **Bounded loop** — recompute `OPEN` as in step 3. If it is greater than 0 and any open
   blocker is one this run has not yet tried to fix, repeat steps 3-4, at most two more times
   (three address passes in total). After that, stop looping regardless of what is open.

6. **Approval** — this session cannot approve: GitHub rejects self-approval, and the plugin's
   approval is the bot's, triggered by the posted comment through the consumer's
   `agent-review-approve.yml` (0.7.0+). Read the posted status:

   ```bash
   . /tmp/yolo_env.sh
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   STATUS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
     --jq '[.[] | select(.body | startswith("<!-- agent-review -->"))][0].body // empty' | tr -d '\r' \
     | sed -n 's/^<!-- agent-review-status: \(.*\) -->$/\1/p' | head -1)
   PASS=$(printf '%s' "$STATUS" | jq -r '.pass // false'); IRREVERSIBLE=$(printf '%s' "$STATUS" | jq -r '.irreversible // false')
   echo "pass=$PASS irreversible=$IRREVERSIBLE"
   if [ "$PASS" = "true" ] && [ "$IRREVERSIBLE" != "true" ]; then
     for i in $(seq 1 9); do
       APPROVED=$(gh pr view "$PR_NUMBER" --json reviews \
         --jq --arg since "$START_TS" '[.reviews[] | select(.author.login == "github-actions[bot]") | select(.state == "APPROVED") | select(.submittedAt > $since)] | length')
       [ "${APPROVED:-0}" -gt 0 ] && { echo "✅ Approved by github-actions[bot]"; break; }
       [ "$i" -lt 9 ] && sleep 20
     done
     [ "${APPROVED:-0}" -gt 0 ] || echo "⏳ Ledger passes but no bot approval arrived within 3 minutes — this repo may not run agent-review-approve.yml with auto_approve on, or the workflow is still queued. The PR is ready for a human."
   fi
   ```

7. **Report** — one of: approved by the bot; ledger passes, no approval (say which of the two
   causes above applies if you can tell from `gh run list --workflow "agent-review approve"`);
   `N` blockers remain that could not be fixed (list each with its number, file:line, and the
   reason the fix was not applied); or the change is irreversible and a human must approve.
   End with the open suggestions (severity < 7) as a plain list. Do not run anything under
   `/tmp/automated_fixes`.
