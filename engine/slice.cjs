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
const { pathMatches, contentMatches } = require('./selectAgents.cjs');

// Splits diffText into `diff --git` file sections, each further split into
// a header (everything before the first hunk: the `diff --git`/`index`/
// `---`/`+++` lines) and a list of complete `@@ ... @@` hunks. Reassembling
// header + hunks.join('') reproduces the original block byte-for-byte — this
// is what makes whole-file inclusion trivially a valid unified diff.
function parseDiff(diffText) {
  if (!diffText) return [];
  return diffText
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((block) => {
      const fileMatch = block.match(/^diff --git a\/\S+ b\/(\S+)/m);
      const hunkStart = block.search(/^@@ /m);
      const header = hunkStart === -1 ? block : block.slice(0, hunkStart);
      const hunkText = hunkStart === -1 ? '' : block.slice(hunkStart);
      const hunks = hunkText
        ? hunkText.split(/(?=^@@ )/m).filter(Boolean)
        : [];
      return { file: fileMatch ? fileMatch[1] : null, header, hunks };
    });
}

// Added/context lines only ('+' and ' ' prefixes) — removed lines ('-') and
// the "@@ ... @@" hunk marker itself are excluded, matching the brief's
// "added/context lines" wording.
function hunkContentText(hunk) {
  return hunk
    .split('\n')
    .filter((l) => l.startsWith('+') || l.startsWith(' '))
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
    agent.always === true
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
    const wholeFile = block.file != null && pathMatches(block.file, paths);
    const keptHunks = wholeFile
      ? block.hunks
      : block.hunks.filter((h) =>
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
