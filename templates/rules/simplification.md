# Simplification & Reuse — Focus Areas

Generic baseline. `/agent-review:init` appends the repo-specific concerns; keep both.

This is an advisory lane. Its job is to make this diff smaller and simpler — not to restyle the
codebase, and not to propose generalizations. Report only cleanups the author can act on inside
this PR.

**Lane boundary** — neighboring lanes own the adjacent ground:

- Layering, placement, and pattern-consistency judgments belong to `architecture`
- Lint-level hygiene (unused imports, debug output, commented-out code) belongs to `standards`
- This lane owns code that need not exist: additions duplicating something the repo already has,
  abstractions with no second caller, computation the data path doesn't need, and code the PR
  adds but never exercises

**Severity cap — cleanups never block**

- Rate pure reuse/simplification/efficiency findings 1–4
- Use 5–6 only for substantial reimplementation of an existing, tested helper, or a demonstrable
  algorithmic problem on a data path that grows with users or records
- Never rate a pure cleanup ≥ 7 — the blocker machinery is for defects. The cross-cutting duty
  still applies: a real bug noticed while reading is reported at its honest severity

**Proof requirements** — every finding cites evidence the author can check, using your discovery
grep budget:

- A reuse claim names the existing helper at file:line, after you have read it and confirmed its
  semantics actually match this call site (arguments, edge cases, error behavior). A name-alike
  with different behavior is not a finding
- A duplication claim points at duplication this diff introduces; pre-existing duplication the
  change does not worsen is out of scope
- An efficiency claim names where the data comes from and why it can be large; no
  micro-optimizations, no complexity pedantry on collections that are bounded in practice
- A dependency-reuse claim cites the manifest entry for a library the repo already ships that
  does what the new code hand-rolls

**Reuse**

- Look for: a new helper, validator, formatter, or client wrapper that reimplements one that
  already exists in the repo's shared locations; a sibling file copy-pasted and lightly edited
  instead of extended; utility code hand-rolled despite an already-carried dependency that
  provides it

**Simplification**

- Look for: an abstraction with exactly one caller or one implementation (interface, base class,
  factory, registry) introduced by this diff; boolean parameters or config options no current
  caller sets; indirection added for cases that do not exist; a hand-rolled mechanism where the
  language or framework has a direct construct

**Efficiency**

- Look for: invariant work recomputed inside a loop; a query or fetch issued per item where the
  surrounding code already batches; a full-collection load used to read one row; repeated linear
  scans that a single keyed lookup structure would remove — on data that actually grows

**Dead weight**

- Look for: exports nothing imports, parameters no caller passes, branches no current input can
  reach — when this PR introduces them. Confirm with a repo-wide grep before flagging; absence
  from the diff is not absence from the codebase

**Finding budget.** Report at most 5 findings — the ones with the largest net line savings or
clearest wins. Suggestion density is what gets an advisory lane dismissed; if you found more than
5, keep the best and drop the rest silently.

<!-- init: extend this file with the repo's shared-helper locations (where utilities, validators, and formatters live — the directories to grep before accepting new ones) -->
