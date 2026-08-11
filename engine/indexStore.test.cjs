'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { loadOrBuildIndex, listRepoFiles, csv } = require('./indexStore.cjs');

function tmpRepo() {
  const root = mkdtempSync(join(os.tmpdir(), 'idxtest-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), "import { b } from './b';");
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;');
  return root;
}

// A git repo whose default-indexed src/*.ts files would NOT be selected by a custom
// --roots/--exts filter, so a passing test proves the opts actually threaded through.
function tmpGitRepoForCsvOpts() {
  const root = mkdtempSync(join(os.tmpdir(), 'idxtest-git-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'customroot'), { recursive: true });
  writeFileSync(join(root, 'customroot/a.mjs'), 'export const a = 1;\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('builds graph and writes graph.json', () => {
  const root = tmpRepo();
  const indexPath = join(root, '.claude/review/index');
  const graph = loadOrBuildIndex({
    repoRoot: root,
    indexPath,
    head: 'h1',
    files: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(graph.head, 'h1');
  assert.equal(graph.fileCount, 2);
  assert.deepEqual(graph.importedBy['src/b.ts'], ['src/a.ts']);
  rmSync(root, { recursive: true, force: true });
});

test('reuses cache when head matches (no rebuild)', () => {
  const root = tmpRepo();
  const indexPath = join(root, '.claude/review/index');
  loadOrBuildIndex({
    repoRoot: root,
    indexPath,
    head: 'h1',
    files: ['src/a.ts', 'src/b.ts'],
  });
  // tamper the cache with a sentinel; a reuse returns it unchanged, a rebuild drops it
  const gf = join(indexPath, 'graph.json');
  const cached = JSON.parse(readFileSync(gf, 'utf8'));
  cached.sentinel = 'KEEP';
  writeFileSync(gf, JSON.stringify(cached));
  const again = loadOrBuildIndex({
    repoRoot: root,
    indexPath,
    head: 'h1',
    files: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(again.sentinel, 'KEEP');
  rmSync(root, { recursive: true, force: true });
});

test('rebuilds when head differs', () => {
  const root = tmpRepo();
  const indexPath = join(root, '.claude/review/index');
  loadOrBuildIndex({
    repoRoot: root,
    indexPath,
    head: 'h1',
    files: ['src/a.ts', 'src/b.ts'],
  });
  const gf = join(indexPath, 'graph.json');
  const cached = JSON.parse(readFileSync(gf, 'utf8'));
  cached.sentinel = 'KEEP';
  writeFileSync(gf, JSON.stringify(cached));
  const rebuilt = loadOrBuildIndex({
    repoRoot: root,
    indexPath,
    head: 'h2',
    files: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(rebuilt.sentinel, undefined);
  assert.equal(rebuilt.head, 'h2');
  rmSync(root, { recursive: true, force: true });
});

test('csv splits/trims comma-separated flag values; non-string passthrough as undefined', () => {
  assert.deepEqual(csv('a, b ,c'), ['a', 'b', 'c']);
  assert.equal(csv(undefined), undefined);
  assert.equal(csv(true), undefined); // boolean flag (no value) parses to `true`, not a string
});

test('--roots/--exts CSV flags (as parsed by csv) propagate through listRepoFiles', () => {
  const root = tmpGitRepoForCsvOpts();
  const opts = { roots: csv('customroot'), exts: csv('mjs') };
  const files = listRepoFiles(root, opts);
  assert.deepEqual(files, ['customroot/a.mjs']);
  rmSync(root, { recursive: true, force: true });
});
