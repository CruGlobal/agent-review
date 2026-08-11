'use strict';
// Contract tests between the shipped templates/skills and the CLI surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const ARCHETYPE = join(ROOT, 'templates/archetype.md');
const SKILL = join(ROOT, 'skills/review/SKILL.md');

const PLACEHOLDERS = [
  'TITLE',
  'EXPERTISE',
  'RISK_CONTEXT',
  'PROFILE_INSTRUCTION',
  'RULES',
  'LEARNINGS',
  'IMPACT',
];

test('archetype.md uses exactly the seven documented placeholders', () => {
  const text = readFileSync(ARCHETYPE, 'utf8');
  const found = new Set(
    [...text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]),
  );
  assert.deepStrictEqual(
    [...found].sort(),
    [...PLACEHOLDERS].sort(),
    'archetype placeholder vocabulary drifted from the documented set',
  );
});

test('review SKILL.md references the CLI, never legacy engine paths', () => {
  const text = readFileSync(SKILL, 'utf8');
  for (const legacy of ['.claude/review/engine', 'cli.cjs']) {
    assert.ok(
      !text.includes(legacy),
      `SKILL.md must not reference "${legacy}" — call the agent-review binary instead`,
    );
  }
});

// Lines of every ```bash fenced block in the skill.
function bashBlocks(text) {
  const out = [];
  let inBash = false;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (inFence) {
        inFence = false;
        inBash = false;
      } else {
        inFence = true;
        inBash = line.slice(3).trim().toLowerCase() === 'bash';
      }
      continue;
    }
    if (inFence && inBash) out.push(line);
  }
  return out.join('\n');
}

test('every agent-review subcommand used in SKILL.md bash blocks exists in the CLI', () => {
  const usage = execFileSync(
    process.execPath,
    [join(ROOT, 'bin/agent-review'), 'help'],
    { encoding: 'utf8' },
  );
  const known = new Set(
    usage
      .split('\n')
      .slice(1) // drop the "usage:" line
      .map((l) => l.trim().split(/[\s|]+/)[0])
      .filter((w) => /^[a-z][a-z-]*$/.test(w)),
  );
  assert.ok(known.size > 5, 'could not parse subcommands out of the CLI usage text');

  const used = new Set(
    [...bashBlocks(readFileSync(SKILL, 'utf8')).matchAll(
      /\bagent-review\s+([a-z][a-z-]*)/g,
    )].map((m) => m[1]),
  );
  assert.ok(used.size > 0, 'no agent-review invocations found in SKILL.md bash blocks');
  for (const sub of used) {
    assert.ok(known.has(sub), `SKILL.md calls "agent-review ${sub}" but the CLI has no such command`);
  }
});
