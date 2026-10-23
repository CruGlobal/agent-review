'use strict';

const { unwrapFindings } = require('./unwrapFindings.cjs');

const FIX =
  'update Claude Code to a version that ships /code-review, or set engine=agent-review to use the built-in lanes';

function fail(reason) {
  return { ok: false, reason, findings: [] };
}

// A fence closes only at a bare fence line at least as long as its opener; one left open runs
// to the end of the text and never qualifies as the findings list.
function scanFences(text) {
  const blocks = [];
  const outside = [];
  let open = null;
  for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (open) {
      const close = /^(`{3,})[ \t]*$/.exec(line);
      if (close && close[1].length >= open.fence.length) {
        blocks.push({ info: open.info, body: open.body.join('\n'), closed: true });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const start = /^(`{3,})[ \t]*([^`]*)$/.exec(line);
    if (start) open = { fence: start[1], info: start[2].trim().split(/\s+/)[0].toLowerCase(), body: [] };
    else outside.push(line);
  }
  if (open) blocks.push({ info: open.info, body: open.body.join('\n'), closed: false });
  return { blocks, outside };
}

const LIST_INFO = new Set(['json', '']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasFile(value) {
  return isPlainObject(value) && typeof value.file === 'string' && value.file.trim() !== '';
}

function qualifyingList(block) {
  if (!block.closed) return null;
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
  const resultAt = lines.findIndex((line) => /^Result:/.test(line));
  if (resultAt < 0) return [];
  const findings = [];
  for (const line of lines.slice(resultAt + 1)) {
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
  const { blocks, outside } = scanFences(text);
  const listBlocks = blocks.filter((b) => LIST_INFO.has(b.info));
  for (let i = listBlocks.length - 1; i >= 0; i--) {
    const findings = qualifyingList(listBlocks[i]);
    if (findings) return { ok: true, reason: 'ok', findings };
  }
  if (listBlocks.length === 0) {
    const lines = textFindings(outside);
    if (lines.length > 0) return { ok: true, reason: 'ok', findings: lines };
    if (outside.some((line) => NO_FINDINGS_LINE.test(line))) return { ok: true, reason: 'ok', findings: [] };
  }
  return fail(
    '/code-review ran but returned no findings list the engine can read; rerun with effort=xhigh or engine=agent-review',
  );
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

// A null droppedText is a missing dropped file, which counts as zero drops.
function checkFindingAccounting({ count, findingsText, droppedText }) {
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
  return { ok: true, reason: 'ok' };
}

module.exports = { checkCodeReviewProof, checkFindingAccounting };
