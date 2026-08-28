'use strict';
// Per-agent diff slicing: hands each lane only the hunks its triggers care
// about, so a specialist agent isn't shown (and billed for) the whole diff.
//
// Pure: sliceForAgent does no filesystem I/O — the CLI (engine/cli.cjs's
// `slice` case) reads the plan/diff files and writes the per-agent .diff
// files plus the manifest. `agent.triggers` is the SAME object reference the
// plan carried straight from config (see engine/selectAgents.cjs) — treated
// strictly read-only here, never mutated or sorted in place.
//
// Reuses selectAgents' own matcher semantics rather than re-deriving them:
// `pathMatches` for triggers.paths globs, `contentMatches` for triggers.content
// token semantics (identifier-like vs punctuation-bearing markers).
//
// M6 (final review): slicing does NOT re-apply selectAgents' excluded_paths/
// `.md`-and-reviewer-config content-scan filtering — a path-matched or
// unparseable block may include files selection's `codeDiff` would have
// dropped from content scanning. Slices are therefore a strict SUPERSET of
// what selection considered, never a narrower view than the lane was
// selected against — the safe direction for a specialist that was already
// selected to review this diff.
const { pathMatches, contentMatches } = require('./selectAgents.cjs');

// Splits diffText into `diff --git` file sections, each further split into
// a header (everything before the first hunk: the `diff --git`/`index`/
// `---`/`+++` lines — or the WHOLE section for a binary/mode-only/pure-rename
// change that carries no `@@` hunks at all) and a list of complete
// `@@ ... @@` hunks. Reassembling header + hunks.join('') reproduces the
// original block byte-for-byte — this is what makes whole-file inclusion
// trivially a valid unified diff.
function parseDiff(diffText) {
  if (!diffText) return [];
  return diffText
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((block) => {
      // M3: capture BOTH the old (a/) and new (b/) path so rename blocks can
      // be matched by either — an operator's path trigger naming the old
      // path must still find a renamed file.
      const fileMatch = block.match(/^diff --git a\/(\S+) b\/(\S+)/m);
      const hunkStart = block.search(/^@@ /m);
      const header = hunkStart === -1 ? block : block.slice(0, hunkStart);
      const hunkText = hunkStart === -1 ? '' : block.slice(hunkStart);
      const hunks = hunkText
        ? hunkText.split(/(?=^@@ )/m).filter(Boolean)
        : [];
      // M2: a `diff --git` line whose paths could not be parsed (git-quoted
      // paths — spaces/special characters) means we cannot tell which
      // lane's globs it belongs to. Mark it unparseable so sliceForAgent
      // fails OPEN: it's included in every sliced lane's output rather than
      // risk silently starving one (selection/slice divergence must never
      // go in the starve direction). A true preamble (no `diff --git` line
      // at all) is NOT this case — it keeps its existing behavior.
      const isGitDiffBlock = /^diff --git /.test(block);
      return {
        file: fileMatch ? fileMatch[2] : null,
        oldFile: fileMatch ? fileMatch[1] : null,
        header,
        hunks,
        unparseable: isGitDiffBlock && !fileMatch,
      };
    });
}

// Controller ruling: content-trigger slicing must see what selection saw.
// selectAgents' contentMatches scans the whole code block, deletions
// included — a lane selected because a dangerous call was REMOVED must
// receive that hunk. So every body line except the "@@ ... @@" marker line
// itself is in play: '+' added, '-' removed, ' ' context.
function hunkContentText(hunk) {
  return hunk
    .split('\n')
    .filter((l) => !l.startsWith('@@'))
    .join('\n');
}

function countAll(diffText) {
  const files = (diffText.match(/^diff --git /gm) || []).length;
  const hunks = (diffText.match(/^@@ /gm) || []).length;
  return { files, hunks };
}

function isFullDiff(agent) {
  return (
    agent.escalates === true ||
    agent.id === 'architecture' ||
    agent.always === true ||
    // I4b (final review, belt-and-suspenders): a lane the coverage guarantee
    // force-included is ALWAYS full-diff, regardless of its own `escalates`
    // value. Without this, an operator's `escalates: false` override on the
    // forced lane (see selectAgents.cjs's forced-pick fallback) would let
    // this rule slice it down — likely to an empty slice — which would
    // silently cancel the coverage guarantee it exists to provide.
    agent.matchedBy === 'unmatched-coverage'
  );
}

function sliceForAgent({ agent, diffText }) {
  const text = diffText || '';
  if (isFullDiff(agent)) {
    const { files, hunks } = countAll(text);
    return { mode: 'full', diff: text, files, hunks };
  }

  const triggers = agent.triggers || {};
  const paths = triggers.paths || [];
  const content = triggers.content || [];
  const blocks = parseDiff(text);

  const parts = [];
  let files = 0;
  let hunks = 0;
  for (const block of blocks) {
    if (block.unparseable) {
      // M2: can't tell whose glob this belongs to — fail OPEN into every
      // sliced lane rather than risk a silent starve.
      parts.push(block.header + block.hunks.join(''));
      files += 1;
      hunks += block.hunks.length;
      continue;
    }
    // M3: a rename's path trigger may name either the old (a/) or new (b/)
    // path — match against both, not only the new path `block.file`.
    const wholeFile =
      (block.file != null && pathMatches(block.file, paths)) ||
      (block.oldFile != null &&
        block.oldFile !== block.file &&
        pathMatches(block.oldFile, paths));
    if (wholeFile) {
      // Controller ruling: a path-matched file with zero hunks (binary,
      // mode-only, pure rename) still belongs in the slice — the lane must
      // learn the file changed, even with nothing to review line-by-line.
      parts.push(block.header + block.hunks.join(''));
      files += 1;
      hunks += block.hunks.length;
      continue;
    }
    const keptHunks = block.hunks.filter((h) =>
      content.some((c) => contentMatches(hunkContentText(h), c)),
    );
    if (keptHunks.length === 0) continue;
    parts.push(block.header + keptHunks.join(''));
    files += 1;
    hunks += keptHunks.length;
  }

  const diff = parts.join('');
  return { mode: diff ? 'sliced' : 'empty', diff, files, hunks };
}

module.exports = { sliceForAgent, parseDiff };
