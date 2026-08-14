# Seeded-bug evaluation suite

Keep the real suite on a protected branch or in a private evaluation repository so prompt and
rule changes cannot overfit to every expected answer. Each seeded case is a small patch that
introduces one realistic defect; clean controls measure false blockers.

```bash
agent-review eval validate --suite .claude/review/evals/suite.yml
agent-review eval prepare --suite .claude/review/evals/suite.yml \
  --case missing-policy --repo . --out ../eval-missing-policy --base <known-good-sha>
# `prepare` creates one local commit in the detached disposable worktree so the
# reviewer sees the seed in its normal commit range. Run the reviewer there and
# save its findings JSON; remove the worktree when the run is complete.
agent-review eval score --suite .claude/review/evals/suite.yml \
  --results .claude/review/evals/results --fail-on-gate
```

Result files contain `case_id`, a unique `run_id`, and the reviewer `findings` array. Run each
case multiple times to expose model instability. An unmatched blocker counts as a false positive
unless a human adjudicator marks it `verdict: duplicate`; do not silently whitelist surprising
findings. A human adjudicator may set `verdict` to `true_positive`, `false_positive`, or
`duplicate`; every finding needs a numeric severity from 1–10. Save the JSON summary as the
baseline for the next engine version and pass it through `--baseline` to see metric deltas.

Dismissed findings must carry one of: `false-positive`, `intentional`, `pre-existing`,
`deferred`, `duplicate`, `insufficient-evidence`, or `other`.
