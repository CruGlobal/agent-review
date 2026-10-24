'use strict';

const { unwrapFindings } = require('./unwrapFindings.cjs');
const { CATEGORIES, CLEANUP_CATEGORIES } = require('./vocabulary.cjs');
const { pathMatches } = require('./selectAgents.cjs');
const { CAPTURE_SOURCE } = require('./captureHook.cjs');

// Minutes from the arm file's `created` until capture-wait gives up, per effort.
const CAPTURE_LIMIT_MINUTES = Object.freeze({ low: 10, medium: 15, high: 20, xhigh: 40, max: 120 });

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
        blocks.push({ info: open.info, body: open.body.join('\n'), lines: open.body, start: open.start, closed: true });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const start = FENCE_OPEN.exec(line);
    if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
      open = { fence: start[1], info: start[2].trim().split(/\s+/)[0].toLowerCase(), body: [], start: index };
    } else {
      outside.push(line);
      outsideAt.push(index);
    }
  }
  if (open) blocks.push({ info: open.info, body: open.body.join('\n'), lines: open.body, start: open.start, closed: false });
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

// A fence with no language label holds prose, so a finding there must be claimed like one outside.
const PROSE_FENCES = new Set(['', 'text', 'txt', 'md', 'markdown', 'plain']);

function textLines(text, fileExists) {
  const { blocks, outside, outsideAt } = scanFences(String(text));
  const raw = outside.map((line, k) => ({ index: outsideAt[k], line }));
  for (const block of blocks) {
    if (!PROSE_FENCES.has(block.info) || listOf(block)) continue;
    block.lines.forEach((line, j) => raw.push({ index: block.start + 1 + j, line }));
  }
  raw.sort((a, b) => a.index - b.index);
  return raw.map(({ index, line }) => {
    const normalized = normalizeLine(line);
    return { index, text: normalized, mentions: mentionsIn(normalized, fileExists) };
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

const PATH_CHAR = /[\p{L}\p{N}_./-]/u;

function pathStartsAt(text, at, root) {
  const prefixes = ['', './'];
  if (typeof root === 'string' && root !== '') prefixes.push(root.endsWith('/') ? root : `${root}/`);
  return prefixes.some((prefix) => {
    const from = at - prefix.length;
    if (from < 0 || text.slice(from, at) !== prefix) return false;
    return from === 0 || !PATH_CHAR.test(text[from - 1]);
  });
}

// A raw path matches only a whole path in the text, so cart.rb does not match lib/cart.rb.
function namesPathIn(text, path, root) {
  if (path === '') return false;
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    if (!pathStartsAt(text, at, root)) continue;
    const after = text.slice(at + path.length, at + path.length + 2);
    if (/^(?:[\p{L}\p{N}_/-]|\.[\p{L}\p{N}_])/u.test(after)) continue;
    return true;
  }
  return false;
}

const WRAPPERS = new Set(['_', '"', "'", ')', ']', '}', '>']);

// A loop, not a regex: a trailing-run regex backtracks quadratically on a long run of wrappers.
function trimWrappers(path) {
  let start = 0;
  let end = path.length;
  while (start < end && WRAPPERS.has(path[start])) start++;
  while (end > start && WRAPPERS.has(path[end - 1])) end--;
  return path.slice(start, end);
}

function mentionNames(mentionFile, path, root) {
  return repoRelative(mentionFile, root) === path || repoRelative(trimWrappers(mentionFile), root) === path;
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
        ? (l) => l.mentions.length === 0 && namesPathIn(l.text, path, root)
        : (l) => l.mentions.some((m) => m.line === entry.line && mentionNames(m.file, path, root));
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

function spot(file, line) {
  return line == null ? `${file}, no line` : `${file}:${line}`;
}

function shown(value) {
  return value === undefined ? 'none' : JSON.stringify(value);
}

const CONFIDENCES = ['High', 'Medium', 'Low'];

function isLine(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

function scoredEntryProblem(entry, i, rawByN, root) {
  const label = `scored entry ${i + 1}`;
  if (!isPlainObject(entry)) return `${label} is not an object`;
  const raw = rawByN.get(entry.raw);
  if (!raw) return `${label} has raw ${shown(entry.raw)}, which is not the n of any raw entry`;
  const where = `${label} (raw ${entry.raw}, ${spot(raw.file, raw.line)})`;
  const want = repoRelative(raw.file, root);
  if (!isText(entry.file) || entry.file !== want) return `${where} has file ${shown(entry.file)}, but its raw entry's repo-relative file is ${JSON.stringify(want)}`;
  if (!isLine(entry.line)) return `${where} needs a positive integer line, or null, not ${shown(entry.line)}`;
  if (!isText(entry.message)) return `${where} needs a non-empty string message`;
  if (!Number.isInteger(entry.severity) || entry.severity < 1 || entry.severity > 10) {
    return `${where} needs an integer severity from 1 to 10, not ${shown(entry.severity)}`;
  }
  if (!CATEGORIES.includes(entry.category)) {
    return `${where} has category ${shown(entry.category)}, which is not one of the nine names: ${CATEGORIES.join(', ')}`;
  }
  if (!CONFIDENCES.includes(entry.confidence)) {
    return `${where} needs confidence High, Medium, or Low, not ${shown(entry.confidence)}`;
  }
  if (typeof entry.evidence !== 'string') return `${where} needs a string evidence`;
  for (const key of ['outside_range', 'doubted']) {
    if (typeof entry[key] !== 'boolean') return `${where} needs ${key} to be true or false, not ${shown(entry[key])}`;
  }
  if (entry.recategorized_from !== null && !CLEANUP_CATEGORIES.includes(entry.recategorized_from)) {
    return `${where} needs recategorized_from to be null or one of ${CLEANUP_CATEGORIES.join(', ')}, not ${shown(entry.recategorized_from)}`;
  }
  return null;
}

function droppedEntryProblem(entry, i, rawByN, excludedPaths, root) {
  const label = `dropped entry ${i + 1}`;
  if (!isPlainObject(entry)) return { problem: `${label} is not an object` };
  const raw = rawByN.get(entry.raw);
  if (!raw) return { problem: `${label} has raw ${shown(entry.raw)}, which is not the n of any raw entry` };
  const where = `${label} (raw ${entry.raw}, ${spot(raw.file, raw.line)})`;
  if (entry.reason === 'excluded') {
    if (!excludedPaths.includes(entry.glob)) {
      return { problem: `${where} cites glob ${shown(entry.glob)}, which is not in the config's excluded_paths` };
    }
    if (!pathMatches(repoRelative(raw.file, root), [entry.glob])) {
      return { problem: `${where} cites glob ${JSON.stringify(entry.glob)}, which ${repoRelative(raw.file, root)} does not match` };
    }
    return { why: `excluded path: ${entry.glob}` };
  }
  if (entry.reason === 'disproved') {
    if (!isText(entry.proof) || mentionsIn(normalizeLine(entry.proof), null).length === 0) {
      return { problem: `${where} needs a proof that names a file:line` };
    }
    return { why: entry.proof };
  }
  return { problem: `${where} has reason ${shown(entry.reason)}; it must be "excluded" or "disproved"` };
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function laneFail(reason) {
  return { ok: false, reason, dropped: [] };
}

function checkLaneOutput({ rawEntries, scoredText, droppedText, excludedPaths = [], root }) {
  const shape = rawShapeProblem(rawEntries);
  if (shape) return laneFail(shape);
  const scoredParsed = scoredText == null ? null : parseJson(scoredText);
  const scored = scoredParsed && unwrapFindings(scoredParsed.value);
  if (!scored) return laneFail('the scored findings file is missing or has no findings list');
  const droppedParsed = droppedText == null ? null : parseJson(droppedText);
  if (!droppedParsed || !Array.isArray(droppedParsed.value)) {
    return laneFail('the dropped file is missing or is not a JSON array');
  }
  const droppedEntries = droppedParsed.value;
  const rawByN = new Map(rawEntries.map((entry) => [entry.n, entry]));
  const used = new Map();
  const use = (n, what) => {
    if (used.has(n)) return `raw entry ${n} is accounted for twice: by ${used.get(n)} and by ${what}`;
    used.set(n, what);
    return null;
  };
  for (const [i, entry] of scored.entries()) {
    const problem = scoredEntryProblem(entry, i, rawByN, root);
    if (problem) return laneFail(problem);
    const twice = use(entry.raw, `scored entry ${i + 1}`);
    if (twice) return laneFail(twice);
  }
  const dropped = [];
  for (const [i, entry] of droppedEntries.entries()) {
    const result = droppedEntryProblem(entry, i, rawByN, excludedPaths, root);
    if (result.problem) return laneFail(result.problem);
    const twice = use(entry.raw, `dropped entry ${i + 1}`);
    if (twice) return laneFail(twice);
    const raw = rawByN.get(entry.raw);
    dropped.push({ file: repoRelative(raw.file, root), line: raw.line, summary: oneLine(raw.summary), why: oneLine(result.why) });
  }
  const lost = rawEntries.find((entry) => !used.has(entry.n));
  if (lost) {
    return laneFail(
      `raw entry ${lost.n} (${spot(lost.file, lost.line)}) is neither scored nor dropped; every raw finding must be scored or dropped exactly once`,
    );
  }
  return { ok: true, reason: 'ok', dropped };
}

function checkCodeReviewRun({ captureText, runId, rawText, scoredText, droppedText, excludedPaths = [], fileExists, root }) {
  const parsedCapture = captureText == null ? null : parseJson(captureText);
  const parsedRaw = rawText == null ? null : parseJson(rawText);
  const rawEntries = parsedRaw ? parsedRaw.value : null;
  const grounded = checkGrounding({
    capture: parsedCapture ? parsedCapture.value : null,
    runId,
    rawEntries,
    fileExists,
    root,
  });
  const count = Array.isArray(rawEntries) ? rawEntries.length : 0;
  if (!grounded.ok) return { ...grounded, count, dropped: [] };
  const lane = checkLaneOutput({ rawEntries, scoredText, droppedText, excludedPaths, root });
  if (!lane.ok) return { ok: false, stage: 'lane', reason: lane.reason, count, mode: grounded.mode, dropped: [] };
  return { ok: true, stage: null, reason: 'ok', count, mode: grounded.mode, dropped: lane.dropped };
}

module.exports = {
  CAPTURE_LIMIT_MINUTES,
  jsonFindings,
  explicitEmpty,
  findingLines,
  jsonLine,
  repoRelative,
  looksFinished,
  checkGrounding,
  checkLaneOutput,
  checkCodeReviewRun,
};
