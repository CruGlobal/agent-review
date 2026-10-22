'use strict';

const FIX =
  'update Claude Code to a version that ships /code-review, or set engine=agent-review to use the built-in lanes';

function fail(reason) {
  return { ok: false, reason, findings: [] };
}

// A fence opens at the start of a line and closes at the next bare fence line.
function fencedBlocks(text) {
  const blocks = [];
  const re = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFindings(value) {
  let list = null;
  if (Array.isArray(value)) list = value;
  else if (isPlainObject(value) && Array.isArray(value.findings)) list = value.findings;
  return list && list.every(isPlainObject) ? list : null;
}

const FINDING_LINE =
  /^\s*(?:[-*]|\d+\.)?\s*`?([^\s`:]+):(\d+)\S*?`?\s*(?:[\u2014\u2013]|\s-\s|:)\s*(\S.*?)\s*$/;
const SCENARIO_LINE = /^\s+Failure scenario:\s*(\S.*?)\s*$/;

function textFindings(text) {
  const resultAt = text.search(/^Result:/m);
  const lines = (resultAt >= 0 ? text.slice(resultAt) : text).split('\n').slice(1);
  const findings = [];
  for (const line of lines) {
    const scenario = SCENARIO_LINE.exec(line);
    if (scenario && findings.length > 0) {
      findings[findings.length - 1].failure_scenario = scenario[1];
      continue;
    }
    const m = FINDING_LINE.exec(line);
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
  const blocks = fencedBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(blocks[i]);
    } catch {
      continue;
    }
    const findings = asFindings(parsed);
    if (findings) return { ok: true, reason: 'ok', findings };
  }
  if (!/^```/m.test(text) && /^\s*(?:No findings\.|\(none\))\s*$/m.test(text)) {
    return { ok: true, reason: 'ok', findings: [] };
  }
  const lines = textFindings(text);
  if (lines.length > 0) return { ok: true, reason: 'ok', findings: lines };
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
  const value = lane && lane.value;
  let scored = null;
  if (Array.isArray(value)) scored = value;
  else if (isPlainObject(value) && Array.isArray(value.findings)) scored = value.findings;
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
