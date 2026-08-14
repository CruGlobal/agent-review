# Deterministic structural checks

agent-review can run [ast-grep](https://ast-grep.github.io/) rules before the model and convert
matches on added lines into ordinary review findings. This gives high-value invariants a stable,
testable implementation instead of asking a model to remember them.

1. Copy `sgconfig.yml` and `rules/` into `.claude/review/static/`.
2. Add repo-specific rules and tests. Prefer narrow, high-confidence rules; an `error` becomes an
   8/10 blocker by default.
3. Run `ast-grep test --config .claude/review/static/sgconfig.yml` and
   `ast-grep scan --config .claude/review/static/sgconfig.yml` locally.
4. Set `static_analysis.ast_grep.enabled: true` in `config.yml`.

The reusable workflow reads these rules from the PR base commit, pins the configured ast-grep
version, and scans the proposed tree. A PR cannot add a rule and have that unreviewed rule judge
itself; new rules begin running after merge.
