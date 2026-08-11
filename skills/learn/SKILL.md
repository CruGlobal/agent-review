---
name: learn
description: Ratify review-feedback learnings into repo-specific rules
---

# Learn

Turns marked review outcomes into approved, repo-specific learnings: a `rule` learning gets
injected into future review prompts; a `suppress` learning filters matching findings out of
future runs. Nothing is applied automatically — every proposal is approved or rejected by the
user.

**Engine access**: all commands below go through the `agent-review` binary shipped with this
plugin. Run `agent-review help` if you need the subcommand list.

## Step 1 — Collect pending outcomes

List the pending outcome files. Each one was written by the review skill's `emit` step for a
past review.

```bash
ls .claude/review/learnings/pending/*.yml
```

For each file, show the user its findings (`agent`, `category`, `severity`, `file`, `message`)
and have them set `outcome: accepted` or `outcome: dismissed` on each finding — editing the file
directly is fine. Skip findings left blank; they won't be ingested.

## Step 2 — Ingest feedback

Once a pending file has outcomes marked, ingest it:

```bash
agent-review feedback .claude/review/learnings/pending/<reviewId>.yml
```

Repeat for every pending file with marked outcomes.

## Step 3 — Mine proposals

```bash
agent-review learn
```

Optionally raise the support threshold (default 3) if proposals feel premature:

```bash
agent-review learn --min-support 5
```

## Step 4 — Review proposals with the user

```bash
agent-review learnings --status proposed
```

For each proposal, present `ruleText` (or `example`, for `suppress` kind), `rationale`, and
`support`, and ask the user to approve or reject it:

```bash
agent-review approve <id>
agent-review reject <id>
```

Remind the user: approved `rule` learnings are injected into future reviews; approved `suppress`
learnings filter matching findings out of future runs. Rejected proposals are inert.
