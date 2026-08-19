---
name: update-files
description: Refresh this repo's copied agent-review workflow files to the latest templates, preserving the repo's own settings
---

# Update agent-review workflow files

Consumer repos carry copies of the `templates/workflows/` files (`agent-review.yml`,
`agent-review-interact.yml`, `agent-review-readiness.yml`). Those copies go stale when the
templates change upstream. This skill replaces them with the latest templates while carrying
over the repo's own choices, shows the diff, and offers to open a PR.

Run it inside the consumer repo (e.g. `mpdx_api`), never inside agent-review itself or a fork of
it. Refuse and stop if either check trips: any `git remote -v` entry points at an
`agent-review` repo, or the working tree contains `.claude-plugin/plugin.json` declaring
`"name": "agent-review"` alongside a `templates/workflows/` directory — that's the plugin
source, and overwriting its templates with themselves (or a consumer caller) would be wrong
either way.

## Stage 1 — Fetch the latest templates from GitHub

Always fetch from the source repo, never from the locally installed plugin — the local plugin
may itself be the stale thing. `gh` auth is already required by the rest of the plugin:

```bash
set -e
UPDATE_DIR=/tmp/agent_review_templates
rm -rf "$UPDATE_DIR" && mkdir -p "$UPDATE_DIR"
for f in agent-review.yml agent-review-interact.yml agent-review-readiness.yml; do
  gh api "repos/CruGlobal/agent-review/contents/templates/workflows/$f" --jq .content \
    | base64 -d > "$UPDATE_DIR/$f"
done
LATEST=$(gh api repos/CruGlobal/agent-review/contents/.claude-plugin/plugin.json --jq .content \
  | base64 -d | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
echo "Latest agent-review version: $LATEST"
grep -h '^# agent-review-template-version:' "$UPDATE_DIR"/*.yml | sort -u
```

## Stage 2 — Compare against the repo's copies

For each fetched template, look for the matching file in `.github/workflows/`:

- **File exists**: read its `# agent-review-template-version:` marker (missing marker =
  pre-0.3.0). If the marker already equals the latest version, report "up to date" and skip it.
- **File missing**: the repo never installed that piece. Offer it, don't force it — ask the
  user whether to add it, and default to skipping `agent-review-readiness.yml` unless they want
  the rollout gate.

If every file is current, say so and stop here.

## Stage 3 — Carry over the repo's own settings

The fresh template is the base; the repo's existing file is the source of truth for these knobs
only. Read each from the existing file and apply it into the fresh copy:

- **`auto_approve`** (interact): keep the repo's value (e.g. `mpdx_api` runs `false`).
- **Secret mappings**: keep the repo's right-hand sides for `anthropic_api_key:` and
  `context_token:` (some repos use a different secret name than `ANTHROPIC_API_KEY`).
- **The review trigger gate** (review): if the repo customized the `if:` label gate or the
  `rollout_mode`, keep the repo's version of those lines.
- **Pinned refs**: if the repo pinned `uses: CruGlobal/agent-review/...@<ref>` to something
  other than `@main`, keep their ref and mention it — pinning is a deliberate consumer choice.

Everything else — job structure, permissions blocks, inputs like `comment_id`, and the
`# agent-review-template-version:` marker — comes from the fresh template unchanged. Never
invent values: if an existing file has a customization outside this list, show it to the user
and ask whether to keep it before writing.

Write the merged results over `.github/workflows/agent-review*.yml`.

## Stage 4 — Show the diff and hand over

```bash
git diff -- .github/workflows/
```

Walk the user through what changed and why (new inputs, permissions, version marker). Then ask
before touching git history: offer to create a branch, commit with
`chore: update agent-review workflows to v<LATEST>`, push, and open a PR. Never commit to the
default branch directly, and never push without the user's go-ahead.

If nothing changed after the merge, leave the working tree clean and say the repo was already
current.
