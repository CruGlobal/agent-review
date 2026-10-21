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
  if (!/^```/m.test(text) && /^\s*No findings\.?\s*$/m.test(text)) {
    return { ok: true, reason: 'ok', findings: [] };
  }
  return fail(
    '/code-review returned no findings list: expected a fenced JSON array of finding objects, or "No findings." with no fenced block',
  );
}

module.exports = { checkCodeReviewProof };
