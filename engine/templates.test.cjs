'use strict';
// Contract tests between the shipped templates/skills and the CLI surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const ARCHETYPE = join(ROOT, 'templates/archetype.md');
// Every shipped skill is held to the same CLI/legacy-path contract.
const SKILLS = ['review', 'init', 'learn'].map((name) => ({
  name,
  path: join(ROOT, `skills/${name}/SKILL.md`),
}));

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

test('skills reference the CLI, never legacy engine paths', () => {
  for (const { name, path } of SKILLS) {
    const text = readFileSync(path, 'utf8');
    for (const legacy of ['.claude/review/engine', 'cli.cjs']) {
      assert.ok(
        !text.includes(legacy),
        `skills/${name}/SKILL.md must not reference "${legacy}" — call the agent-review binary instead`,
      );
    }
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

test('every agent-review subcommand used in skill bash blocks exists in the CLI', () => {
  const usage = execFileSync(
    process.execPath,
    [join(ROOT, 'bin/agent-review'), 'help'],
    { encoding: 'utf8' },
  );
  // Each usage line is "<command column>  <description>". Within the command column the first
  // word is a subcommand, as is any word after a spaced ` | ` alternation ("approve <id> | reject
  // <id>"). Unspaced pipes ("show|validate|get") separate a subcommand's own arguments, not
  // subcommands, so they are deliberately not collected.
  const known = new Set();
  for (const line of usage.split('\n').slice(1)) {
    // drop the "usage:" line
    const head = line.trim().split(/\s{2,}/)[0];
    for (const m of head.matchAll(/(?:^|\s\|\s)([a-z][a-z-]*)/g)) known.add(m[1]);
  }
  assert.ok(known.size > 5, 'could not parse subcommands out of the CLI usage text');
  // "show" only ever appears as an argument alternation ("show|validate|get"). If it leaks into
  // the known set the unspaced-pipe convention has broken and this test stops catching typos.
  assert.ok(
    !known.has('show'),
    'usage-line parse picked up an argument alternation as a subcommand — keep argument alternations unspaced ("show|validate|get")',
  );

  for (const { name, path } of SKILLS) {
    const used = new Set(
      [...bashBlocks(readFileSync(path, 'utf8')).matchAll(
        /\bagent-review\s+([a-z][a-z-]*)/g,
      )].map((m) => m[1]),
    );
    assert.ok(
      used.size > 0,
      `no agent-review invocations found in skills/${name}/SKILL.md bash blocks`,
    );
    for (const sub of used) {
      assert.ok(
        known.has(sub),
        `skills/${name}/SKILL.md calls "agent-review ${sub}" but the CLI has no such command`,
      );
    }
  }
});
