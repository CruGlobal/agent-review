'use strict';

const { unwrapFindings } = require('./unwrapFindings.cjs');

const FIX =
  'update Claude Code to a version that ships /code-review, or set engine=agent-review to use the built-in lanes';

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
  let open = null;
  for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
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
    }
  }
  if (open) blocks.push({ info: open.info, body: open.body.join('\n'), closed: false });
  return { blocks, outside };
}

// A json block is always a list candidate; an unlabeled one only when its content opens like
// JSON, so an unlabeled code snippet is an ordinary code example.
function isListBlock(block) {
  if (block.info === 'json') return true;
  return block.info === '' && /^[[{]/.test(block.body.trim());
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasFile(value) {
  return isPlainObject(value) && typeof value.file === 'string' && value.file.trim() !== '';
}

function qualifyingList(block) {
  let parsed;
  try {
    parsed = JSON.parse(block.body);
  } catch {
    return null;
  }
  const list = unwrapFindings(parsed);
  return list && list.every(hasFile) ? list : null;
}

const MARKER = String.raw`^\s*(?:[-*]|\d+\.)?\s*`;
const TEXT = String.raw`\s*(\S.*?)\s*$`;
const DASH = String.raw`(?:[\u2014\u2013]|\s-\s)`;
const BACKTICKED_LINE = new RegExp(`${MARKER}\`([^\\s\`:]+):(\\d+)[^\`]*\`\\s*(?:${DASH}|:)${TEXT}`);
const BARE_LINE = new RegExp(`${MARKER}([^\\s\`:]+):(\\d+)\\S*?\\s*${DASH}${TEXT}`);
const SCENARIO_LINE = /^\s+Failure scenario:\s*(\S.*?)\s*$/;
const NO_FINDINGS_LINE = /^\s*(?:No findings\.|\(none\))\s*$/;

function textFindings(lines) {
  const findings = [];
  for (const line of lines) {
    const scenario = SCENARIO_LINE.exec(line);
    if (scenario && findings.length > 0) {
      findings[findings.length - 1].failure_scenario = scenario[1];
      continue;
    }
    const m = BACKTICKED_LINE.exec(line) || BARE_LINE.exec(line);
    if (m) findings.push({ file: m[1], line: Number(m[2]), summary: m[3] });
  }
  return findings;
}

function checkCodeReviewProof({ rawText }) {
  if (rawText === null || rawText === undefined || String(rawText).trim() === '') {
    return fail(`/code-review did not run: its raw output is missing. Fix: ${FIX}.`);
  }
  const text = String(rawText);
  const head = text.split('\n').slice(0, 3).join('\n');
  if (!/^Skill "code-review" completed/m.test(head)) {
    return fail(
      `/code-review did not run: the output lacks the Skill "code-review" completed header. Fix: ${FIX}.`,
    );
  }
  const noList = fail(
    '/code-review ran but returned no findings list the engine can read; rerun with effort=xhigh or engine=agent-review',
  );
  const { blocks, outside } = scanFences(text);
  // An unclosed fence of any label means the output was cut short.
  if (blocks.some((b) => !b.closed)) return noList;
  const listBlocks = blocks.filter(isListBlock);
  const lists = listBlocks.map(qualifyingList).filter(Boolean);
  // A quoted `[]`, such as one in a suggested fix, must never replace a real list.
  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length > 0) return { ok: true, reason: 'ok', findings: nonEmpty[nonEmpty.length - 1] };
  if (lists.length > 0) return { ok: true, reason: 'ok', findings: [] };
  const resultAt = outside.findIndex((line) => /^Result:/.test(line));
  if (listBlocks.length > 0 || resultAt < 0) return noList;
  const afterResult = outside.slice(resultAt + 1);
  const lines = textFindings(afterResult);
  if (lines.length > 0) return { ok: true, reason: 'ok', findings: lines };
  if (afterResult.some((line) => NO_FINDINGS_LINE.test(line))) return { ok: true, reason: 'ok', findings: [] };
  return noList;
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

// Only a number at the start counts ("42-45" is 42, "L42" is no line), as the lane template's
// dropped-list rule tells the scorer.
function rawLine(finding) {
  if (Number.isInteger(finding.line)) return finding.line;
  const m = /^\s*(\d+)/.exec(typeof finding.line === 'string' ? finding.line : '');
  return m ? Number(m[1]) : null;
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
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

function unmatchedDrop(rawFindings, dropped) {
  const claimed = new Set();
  for (const [i, entry] of dropped.entries()) {
    const label = `the code-review dropped entry ${i + 1}`;
    const problem = droppedEntryProblem(entry);
    if (problem) return `${label} ${problem}`;
    const where = entry.line === null ? `${entry.file}, no line` : `${entry.file}:${entry.line}`;
    const spots = rawFindings
      .map((raw, index) => ({ raw, index }))
      .filter(({ raw }) => raw.file === entry.file && rawLine(raw) === entry.line);
    if (spots.length === 0) return `${label} (${where}) matches no raw /code-review finding at that file and line`;
    const free = spots.find(({ index }) => !claimed.has(index));
    if (!free) return `${label} (${where}) matches a raw finding that another dropped entry already accounts for`;
    claimed.add(free.index);
  }
  return null;
}

// A null droppedText is a missing dropped file, which counts as zero drops.
function checkFindingAccounting({ rawFindings, findingsText, droppedText }) {
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
  const problem = unmatchedDrop(rawFindings, dropped);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, reason: 'ok' };
}

module.exports = { checkCodeReviewProof, checkFindingAccounting };
