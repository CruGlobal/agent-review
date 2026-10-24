'use strict';

const { minimatch } = require('minimatch');
const { unwrapFindings } = require('./unwrapFindings.cjs');
const { ENGINE_CODE_REVIEW, CATEGORIES } = require('./vocabulary.cjs');
const { CAPTURE_SOURCE } = require('./captureHook.cjs');

const SKILL_NAME = ENGINE_CODE_REVIEW;

const FIX =
  'update Claude Code to a version that ships /code-review, or set engine=agent-review to use the built-in lanes';

// Minutes from the arm file's `created` until capture-wait gives up, per effort.
const CAPTURE_LIMIT_MINUTES = Object.freeze({ low: 10, medium: 15, high: 20, xhigh: 40, max: 120 });

function fail(reason) {
  return { ok: false, reason, findings: [] };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// CommonMark fences: a block closes only at a bare fence of the same character, at least as long
// as its opener, and a backtick opener's info string holds no backtick.
function scanFences(text) {
  const blocks = [];
  const outside = [];
  const outsideAt = [];
  let open = null;
  for (const [index, line] of text.split('\n').map((l) => l.replace(/\r$/, '')).entries()) {
    if (open) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
        blocks.push({ info: open.info, body: open.body.join('\n'), closed: true });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const start = FENCE_OPEN.exec(line);
    if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
      open = { fence: start[1], info: start[2].trim().split(/\s+/)[0].toLowerCase(), body: [] };
    } else {
      outside.push(line);
      outsideAt.push(index);
    }
  }
  if (open) blocks.push({ info: open.info, body: open.body.join('\n'), closed: false });
  return { blocks, outside, outsideAt };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasFile(value) {
  return isPlainObject(value) && typeof value.file === 'string' && value.file.trim() !== '';
}

// Returns null for a block that is not list-like, else { list } with list null when the block is
// unusable. A block that fails to parse is still list-like when it starts like a list, so a cut-off
// or malformed list can never pass as quoted config.
function listOf(block) {
  if (block.info !== 'json' && block.info !== '') return null;
  const body = block.body.trim();
  const parsed = parseJson(body);
  if (!parsed) {
    return body.startsWith('[') || (body.startsWith('{') && body.includes('"findings"')) ? { list: null } : null;
  }
  const { value } = parsed;
  if (!Array.isArray(value) && !(isPlainObject(value) && Object.hasOwn(value, 'findings'))) return null;
  const list = unwrapFindings(value);
  return { list: list && list.every(hasFile) ? list : null };
}

// A quoted `[]`, such as one in a suggested fix, must never replace a real list, so the list is
// `[]` only when every qualifying list is empty.
function jsonFindings(text) {
  const lists = [];
  let problem = null;
  for (const [i, block] of scanFences(String(text)).blocks.entries()) {
    if (!block.closed) {
      problem ??= `fenced block ${i + 1} is never closed, so the result was cut short`;
      continue;
    }
    const found = listOf(block);
    if (!found) continue;
    if (found.list) lists.push(found.list);
    else problem ??= `fenced block ${i + 1} looks like a findings list, but not every item is an object with a non-empty string file`;
  }
  const nonEmpty = lists.filter((list) => list.length > 0);
  const list = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : lists.length > 0 ? [] : null;
  return { list, problem };
}

const MARKER = String.raw`^\s*(?:[-*]|\d+\.(?=\s))?\s*`;
const TEXT = String.raw`\s*(\S.*?)\s*$`;
const DASH = String.raw`(?:[\u2014\u2013]|\s-\s)`;
const BACKTICKED_LINE = new RegExp(`${MARKER}\`([^\\s\`:]+):(\\d+)[^\`]*\`\\s*(?:${DASH}|:)${TEXT}`);
// A range such as 12-15 right after the line number belongs to the location.
const BARE_LINE = new RegExp(
  `${MARKER}([^\\s\`:]+):(\\d+)(?:[-\u2013\u2014]\\d+)?(?![-\u2013\u2014]?\\d)\\S*?\\s*${DASH}${TEXT}`,
);
const SCENARIO_LINE = /^\s+Failure scenario:\s*(\S.*?)\s*$/;
const NO_FINDINGS_LINE = /^\s*(?:No findings\.|\(none\))\s*$/;

// A bare location must name a path (a letter, and a / or a .), or a file that exists, so
// "localhost:3000" and "127.0.0.1:3000" are not findings.
function namesFile(file, fileExists) {
  if (/[./]/.test(file) && /\p{L}/u.test(file)) return true;
  return Boolean(fileExists && fileExists(file));
}

function textFindings(lines, fileExists) {
  const findings = [];
  for (const line of lines) {
    const scenario = SCENARIO_LINE.exec(line);
    if (scenario && findings.length > 0) {
      findings[findings.length - 1].failure_scenario = scenario[1];
      continue;
    }
    const bare = BARE_LINE.exec(line);
    const m = BACKTICKED_LINE.exec(line) || (bare && namesFile(bare[1], fileExists) ? bare : null);
    if (m) findings.push({ file: m[1], line: Number(m[2]), summary: m[3] });
  }
  return findings;
}

function checkCodeReviewProof({ rawText, fileExists }) {
  if (rawText === null || rawText === undefined || String(rawText).trim() === '') {
    return fail(`/code-review did not run: its raw output is missing. Fix: ${FIX}.`);
  }
  const text = String(rawText);
  const head = text.split('\n').slice(0, 3).join('\n');
  if (!new RegExp(`^Skill "${SKILL_NAME}" completed`, 'm').test(head)) {
    return fail(
      `/code-review did not run: the output lacks the Skill "${SKILL_NAME}" completed header. Fix: ${FIX}.`,
    );
  }
  const noList = fail(
    '/code-review ran but returned no findings list the engine can read; rerun with effort=xhigh or engine=agent-review',
  );
  const { list, problem } = jsonFindings(text);
  if (problem) return noList;
  if (list && list.length > 0) return { ok: true, reason: 'ok', findings: list };
  const { outside } = scanFences(text);
  const resultAt = outside.findIndex((line) => /^Result:/.test(line));
  const afterResult = resultAt < 0 ? [] : outside.slice(resultAt + 1);
  const lines = textFindings(afterResult, fileExists);
  // An empty list must never erase finding lines.
  if (list) return { ok: true, reason: 'ok', findings: lines };
  if (resultAt < 0) return noList;
  if (lines.length > 0) return { ok: true, reason: 'ok', findings: lines };
  if (afterResult.some((line) => NO_FINDINGS_LINE.test(line))) return { ok: true, reason: 'ok', findings: [] };
  return noList;
}

function explicitEmpty(text) {
  return scanFences(String(text)).outside.some((line) => {
    const trimmed = line.trim();
    return trimmed === '(none)' || trimmed === 'No findings.';
  });
}

// Underscores are never removed: they belong to paths such as pkg/__init__.py and _form.html.erb.
function normalizeLine(line) {
  return line.replace(/[`*]/g, '');
}

// Paths are cut at whitespace and at ":", never by a regex that backtracks over a long run, so a
// line of any length is read in linear time. Brackets stay inside a path, as in app/[id]/page.tsx.
const PATH_LEAD = /^[(\[{<"'\u201c\u2018|]+/;
const LINE_PART = /^(\d+)(?:[-\u2013\u2014]\d+)?(?![\p{L}\p{N}])/u;

function mentionPath(path, fileExists) {
  if (!/\p{L}/u.test(path) || path.startsWith('//')) return false;
  if (path.includes('/') || path.includes('.')) return true;
  return Boolean(fileExists && fileExists(path));
}

function mentionsIn(line, fileExists) {
  const mentions = [];
  for (const token of line.split(/\s+/)) {
    if (!token.includes(':')) continue;
    const parts = token.split(':');
    for (let i = 0; i + 1 < parts.length; i++) {
      const at = LINE_PART.exec(parts[i + 1]);
      if (!at) continue;
      const file = parts[i].replace(PATH_LEAD, '');
      if (mentionPath(file, fileExists)) mentions.push({ file, line: Number(at[1]) });
    }
  }
  return mentions;
}

function textLines(text, fileExists) {
  const { outside, outsideAt } = scanFences(String(text));
  return outside.map((raw, k) => {
    const line = normalizeLine(raw);
    return { index: outsideAt[k], text: line, mentions: mentionsIn(line, fileExists) };
  });
}

function findingLines(text, fileExists) {
  return textLines(text, fileExists).filter((line) => line.mentions.length > 0);
}

function jsonLine(value) {
  const m = /^\s*(\d+)/.exec(typeof value === 'string' ? value : '');
  const line = Number.isInteger(value) ? value : m ? Number(m[1]) : null;
  return line > 0 ? line : null;
}

function repoRelative(file, root) {
  let path = String(file);
  if (typeof root === 'string' && root !== '') {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
  }
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

// Only max starts helpers, so only there can a stop arrive before the findings do.
function looksFinished(result, effort) {
  if (typeof result !== 'string') return false;
  if (effort !== 'max') return true;
  return jsonFindings(result).list !== null || explicitEmpty(result);
}

// The path must stand alone: lib/cart.rb names cart.rb only when the raw entry says lib/cart.rb.
function namesPathIn(text, path) {
  if (path === '') return false;
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = text.slice(at + path.length, at + path.length + 2);
    if (/[\p{L}\p{N}_./-]/u.test(before)) continue;
    if (/^(?:[\p{L}\p{N}_/-]|\.[\p{L}\p{N}_])/u.test(after)) continue;
    return true;
  }
  return false;
}

function captureProblem(capture, runId) {
  if (!isPlainObject(capture)) return 'no /code-review capture was found for this run';
  if (capture.source !== CAPTURE_SOURCE) {
    return `the capture's source is ${shown(capture.source)}, not ${JSON.stringify(CAPTURE_SOURCE)}, so the capture hook did not write it`;
  }
  if (!isText(capture.run_id)) return 'the capture names no run';
  if (capture.run_id !== runId) return `the capture is for run ${capture.run_id}, not run ${runId}`;
  if (typeof capture.result !== 'string') return 'the capture holds no result text';
  if (capture.result.trim() === '') return "/code-review's captured result is empty";
  return null;
}

function rawShapeProblem(rawEntries) {
  if (!Array.isArray(rawEntries)) return 'the raw findings list is missing or is not a JSON array';
  for (const [i, entry] of rawEntries.entries()) {
    const label = `raw entry ${i + 1}`;
    if (!isPlainObject(entry)) return `${label} is not an object`;
    if (entry.n !== i + 1) return `${label} has n ${shown(entry.n)}; n must count 1, 2, 3, ... in order`;
    if (!isText(entry.file)) return `${label} needs a non-empty string file`;
    if (entry.line !== null && !(Number.isInteger(entry.line) && entry.line > 0)) {
      return `${label} (${entry.file}) needs a positive integer line, or null when the result gives no line, not ${shown(entry.line)}`;
    }
    if (!isText(entry.summary)) return `${label} (${spot(entry.file, entry.line)}) needs a non-empty summary`;
  }
  return null;
}

function jsonMismatch(rawEntries, list, root) {
  if (rawEntries.length !== list.length) {
    return `/code-review's JSON list has ${list.length} findings, but the raw list has ${rawEntries.length}; copy the list one to one`;
  }
  for (const [i, item] of list.entries()) {
    const raw = rawEntries[i];
    const want = { file: repoRelative(item.file, root), line: jsonLine(item.line) };
    if (repoRelative(raw.file, root) !== want.file || raw.line !== want.line) {
      return `raw entry ${i + 1} is ${spot(raw.file, raw.line)}, but JSON finding ${i + 1} is ${spot(want.file, want.line)}; copy the list in order`;
    }
  }
  return null;
}

// Maximum bipartite matching by augmenting paths: an entry may take a line already held by another
// entry when that entry can move to a different line. A greedy pass would fail valid lists.
function matchLines(candidates) {
  const owner = new Map();
  const claim = (entry, seen) => {
    const free = candidates[entry].find((line) => !owner.has(line));
    if (free !== undefined) {
      owner.set(free, entry);
      return true;
    }
    for (const line of candidates[entry]) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (claim(owner.get(line), seen)) {
        owner.set(line, entry);
        return true;
      }
    }
    return false;
  };
  for (let entry = 0; entry < candidates.length; entry++) claim(entry, new Set());
  return owner;
}

function textMismatch(rawEntries, lines, root) {
  const candidates = rawEntries.map((entry) => {
    const path = repoRelative(entry.file, root);
    const fits =
      entry.line === null
        ? (l) => l.mentions.length === 0 && namesPathIn(l.text, path)
        : (l) => l.mentions.some((m) => m.line === entry.line && repoRelative(m.file, root) === path);
    return lines.filter(fits).map((l) => l.index);
  });
  const owner = matchLines(candidates);
  const claimed = new Set(owner.values());
  const problems = [];
  const lost = rawEntries.findIndex((_, i) => !claimed.has(i));
  if (lost >= 0) {
    const entry = rawEntries[lost];
    const wanted = entry.line === null ? 'names that file with no line number and no other location' : 'mentions that file and line';
    problems.push(`raw entry ${lost + 1} (${spot(entry.file, entry.line)}) has no line of its own in /code-review's result that ${wanted}`);
  }
  const unclaimed = lines.find((l) => l.mentions.length > 0 && !owner.has(l.index));
  if (unclaimed) {
    const where = unclaimed.mentions.map((m) => `${m.file}:${m.line}`).join(', ');
    const quoted = JSON.stringify(unclaimed.text.trim().slice(0, 200));
    problems.push(`line ${unclaimed.index + 1} of /code-review's result (${where}) is a finding line that no raw entry claims: ${quoted}`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

function checkGrounding({ capture, runId, rawEntries, fileExists, root }) {
  const failAt = (stage, reason, mode = null) => ({ ok: false, stage, reason, mode });
  const unusable = captureProblem(capture, runId);
  if (unusable) return failAt('capture', unusable);
  const { result } = capture;
  const { list, problem } = jsonFindings(result);
  if (problem) return failAt('capture', `/code-review's result cannot be read: ${problem}`);
  let mode;
  let lines = [];
  if (list && list.length > 0) {
    mode = 'json';
  } else {
    lines = textLines(result, fileExists);
    if (lines.some((l) => l.mentions.length > 0)) mode = 'text';
    else if (list || explicitEmpty(result)) mode = 'empty';
    else return failAt('capture', "/code-review's result has no findings list and no explicit (none)");
  }
  const shape = rawShapeProblem(rawEntries);
  if (shape) return failAt('lane', shape, mode);
  let mismatch = null;
  if (mode === 'json') mismatch = jsonMismatch(rawEntries, list, root);
  else if (mode === 'text') mismatch = textMismatch(rawEntries, lines, root);
  else if (rawEntries.length > 0) {
    mismatch = `/code-review reported no findings, but the raw list has ${rawEntries.length}`;
  }
  if (mismatch) return failAt('lane', mismatch, mode);
  return { ok: true, stage: null, reason: 'ok', mode };
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Spelling variants of the prefix are checked too, so none can pass as an ordinary proof.
const EXCLUDED_PROOF = /^\s*excluded[\s_-]*paths?\s*[:-](.*)$/is;

function spot(file, line) {
  return line == null ? `${file}, no line` : `${file}:${line}`;
}

function shown(value) {
  return value === undefined ? 'none' : JSON.stringify(value);
}

function scoredEntryProblem(entry, index) {
  if (!isPlainObject(entry)) return `the code-review scored finding ${index + 1} is not an object`;
  const { file, line, severity, category } = entry;
  const label = `the code-review scored finding ${index + 1} (${spot(file, line)})`;
  if (typeof severity !== 'number' || !Number.isFinite(severity) || severity < 1 || severity > 10) {
    return `${label} needs a numeric severity from 1 to 10, not ${shown(severity)}`;
  }
  if (!CATEGORIES.includes(category)) {
    return `${label} has category ${shown(category)}, which is not one of the nine names: ${CATEGORIES.join(', ')}`;
  }
  return null;
}

// Globs match as selectAgents matches excluded_paths.
function excludedDropProblem(entry, excludedPaths) {
  const m = EXCLUDED_PROOF.exec(entry.proof);
  if (!m) return null;
  const glob = m[1].trim();
  if (!excludedPaths.includes(glob)) {
    return `cites excluded path ${JSON.stringify(glob)}, which is not in the config's excluded_paths`;
  }
  if (!minimatch(entry.file, glob, { dot: true })) {
    return `cites excluded path ${JSON.stringify(glob)}, which ${entry.file} does not match`;
  }
  return null;
}

function droppedEntryProblem(entry) {
  if (!hasFile(entry)) return 'needs a non-empty string file';
  if (entry.line !== null && !Number.isInteger(entry.line)) {
    return 'needs an integer line, or null when the raw finding has no line';
  }
  if (!isText(entry.summary)) return 'needs a non-empty summary';
  if (!isText(entry.proof)) return 'needs a non-empty proof';
  return null;
}

function unmatchedDrop(rawFindings, dropped, excludedPaths) {
  const claimed = new Set();
  for (const [i, entry] of dropped.entries()) {
    const label = `the code-review dropped entry ${i + 1}`;
    const problem = droppedEntryProblem(entry);
    if (problem) return `${label} ${problem}`;
    const where = spot(entry.file, entry.line);
    const excluded = excludedDropProblem(entry, excludedPaths);
    if (excluded) return `${label} (${where}) ${excluded}`;
    const spots = rawFindings
      .map((raw, index) => ({ raw, index }))
      .filter(({ raw }) => raw.file === entry.file && jsonLine(raw.line) === entry.line);
    if (spots.length === 0) return `${label} (${where}) matches no raw /code-review finding at that file and line`;
    const free = spots.find(({ index }) => !claimed.has(index));
    if (!free) return `${label} (${where}) matches a raw finding that another dropped entry already accounts for`;
    claimed.add(free.index);
  }
  return null;
}

// A null droppedText is a missing dropped file, which counts as zero drops.
function checkFindingAccounting({ rawFindings, findingsText, droppedText, excludedPaths = [] }) {
  const count = rawFindings.length;
  const lane = findingsText == null ? null : parseJson(findingsText);
  const scored = lane && unwrapFindings(lane.value);
  if (!scored) {
    return { ok: false, reason: 'the code-review lane findings file is missing or has no findings list' };
  }
  let dropped = [];
  if (droppedText != null) {
    const parsed = parseJson(droppedText);
    if (!parsed || !Array.isArray(parsed.value)) {
      return { ok: false, reason: 'the code-review dropped file is not a JSON array' };
    }
    dropped = parsed.value;
  }
  if (count !== scored.length + dropped.length) {
    return {
      ok: false,
      reason:
        `/code-review found ${count}, but the lane scored ${scored.length} and dropped ${dropped.length}; ` +
        'every raw finding must be scored or dropped exactly once',
    };
  }
  for (const [i, entry] of scored.entries()) {
    const problem = scoredEntryProblem(entry, i);
    if (problem) return { ok: false, reason: problem };
  }
  const problem = unmatchedDrop(rawFindings, dropped, excludedPaths);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, reason: 'ok' };
}

module.exports = {
  CAPTURE_LIMIT_MINUTES,
  checkCodeReviewProof,
  checkFindingAccounting,
  jsonFindings,
  explicitEmpty,
  findingLines,
  jsonLine,
  repoRelative,
  looksFinished,
  checkGrounding,
};
