---
name: update-files
description: Refresh this repo's copied agent-review workflow files to the latest templates, preserving the repo's own settings
---

# Update agent-review workflow files

Consumer repos carry copies of the `templates/workflows/` files (`agent-review.yml`,
`agent-review-interact.yml`, `agent-review-readiness.yml`, `agent-review-approve.yml`). Those copies go
stale when the
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
for f in agent-review.yml agent-review-interact.yml agent-review-readiness.yml agent-review-approve.yml; do
  gh api "repos/CruGlobal/agent-review/contents/templates/workflows/$f" --jq .content \
    | base64 -d > "$UPDATE_DIR/$f"
done
LATEST=$(gh api repos/CruGlobal/agent-review/contents/.claude-plugin/plugin.json --jq .content \
  | base64 -d | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
echo "Latest agent-review version: $LATEST"
grep -h '^# agent-review-template-version:' "$UPDATE_DIR"/*.yml | sort -u
```

## Stage 2 — Compare against the repo's copies

First read where reviews run:

```bash
REVIEWS_RUN=$(agent-review config get reviews_run) || REVIEWS_RUN=unknown
```

`local` means a local-only repo. `local-and-ci`, or `undefined` printed by a command that
succeeded (a missing key), means CI reviews are on, which is the behavior described in the rest
of this stage. If the command itself failed (`unknown`), the value is unknown: say so and ask the
user whether the repo is local-only before comparing or offering any CI files.

**Local-only repo (`reviews_run` is `local`):** compare only `agent-review-approve.yml`. If it is
missing, offer it by default (not skip) and say "this is the only path that approves": without
it no locally posted report is ever approved. Never offer the CI-file removal in Stage 4 while
the approve workflow is missing. Do not
compare or offer `agent-review.yml`, `agent-review-interact.yml`, or `agent-review-readiness.yml`,
and say they were skipped because the repo is local-only. Then see Stage 4 for CI files that are
still installed. Stage 3 applies to the approve file only.

For each fetched template, look for the matching file in `.github/workflows/`:

- **File exists**: read its `# agent-review-template-version:` marker (missing marker =
  pre-0.3.0). If the marker already equals the latest version, report "up to date" and skip it.
- **File missing**: the repo never installed that piece. Offer it, don't force it — ask the
  user whether to add it, and default to skipping `agent-review-readiness.yml` (the rollout
  gate) and, in a CI repo, `agent-review-approve.yml` (approval of locally posted reports; a
  stronger trust grant than the CI path) unless they want them. In a local-only repo the approve
  file is the default yes, as above.

If every file is current, say so and stop here. In a local-only repo, do not stop before the
removal check in Stage 4 if any CI file is still installed.

## Stage 3 — Carry over the repo's own settings

The fresh template is the base; the repo's existing file is the source of truth for these knobs
only. Read each from the existing file and apply it into the fresh copy:

- **`auto_approve`** (review, interact, and approve): keep the repo's value on each caller
  (e.g. `mpdx_api` runs `false` everywhere). A repo that expresses it as
  `${{ vars.SOMETHING == 'true' }}` keeps that expression verbatim.
- **`rollout_mode` vs config**: the fresh `agent-review.yml` says `advisory`. If the repo's
  `.claude/review/config.yml` still says `rollout.mode: shadow`, say so and offer to change it in
  the same PR — the reusable workflow refuses a caller whose mode disagrees with the trusted
  config, so updating the caller alone breaks CI. A repo that deliberately keeps `shadow` keeps
  it on both sides.
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

### Local-only repo with CI files still installed

Skip this part unless `reviews_run` is `local` and at least one of
`.github/workflows/agent-review.yml`, `agent-review-interact.yml`, or `agent-review-readiness.yml`
exists. Those files still run on labeled PRs and cost money, so offer to remove them in the same
PR as any other changes.

First check that removal will not block merges. Get the repo and its default branch, then read
both places a required check can live:

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
DEFAULT=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
gh api "repos/$REPO/branches/$DEFAULT/protection/required_status_checks" --jq '.contexts, [.checks[].context]'
gh api "repos/$REPO/rules/branches/$DEFAULT" --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

The first call is classic branch protection. GitHub also returns a 404 to anyone without admin
rights on a protected branch, so a 404 counts as "could not verify", not as "none". It counts as
"none" only when `gh api repos/{o}/{r} --jq .permissions.admin` is `true`. If it is not `true`,
warn that classic protection could not be checked and require an explicit yes before removal.
The second lists
rulesets that apply to the branch and may include a `required_status_checks` rule. These
workflows produce checks named like the job or workflow: `review`, `agent-review`, `interact`,
`readiness`. Also treat any required context that contains `agent-review` as produced by these
workflows, since caller job contexts usually look like `<caller job> / <reusable job>`. If any
required context matches, warn the user which check it is and where it is
required, and say that removing the workflow would leave that check pending forever and block
merges until it is removed from the protection or ruleset. If a lookup fails for any other
reason, say the check could not be verified rather than assuming it is safe.

Then ask the user whether to remove the files, naming each one. Never remove a file without a
yes. On a yes, run `git rm` on those files; the diff below uses `git diff HEAD` so the staged
removals show. On a no,
leave them and say they will keep running CI reviews on labeled PRs.

### Diff and PR

```bash
git diff HEAD -- .github/workflows/
```

Walk the user through what changed and why (new inputs, permissions, version marker), and name
any removed CI files. Then ask
before touching git history: offer to create a branch, commit with
`chore: update agent-review workflows to v<LATEST>`, push, and open a PR. If the PR only removes
CI files from a local-only repo, with no template updates, commit with
`chore: remove agent-review CI workflows from a local-only repo` instead. If it does both, keep
the update message and mention the removal in the PR body. Never commit to the
default branch directly, and never push without the user's go-ahead.

If nothing changed after the merge, leave the working tree clean and say the repo was already
current.
