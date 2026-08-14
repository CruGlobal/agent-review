'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { validateContextManifest, contextInventory, packContext } = require('./contextPack.cjs');

const SHA = 'a'.repeat(40);
function manifest() {
  return { version: 1, repositories: [{ id: 'client', repository: 'Org/client', ref: SHA, paths: ['src/**'], excluded_paths: ['**/*.snap'] }] };
}

test('context manifests require immutable full commit SHAs', () => {
  const raw = manifest(); raw.repositories[0].ref = 'main';
  assert.throws(() => validateContextManifest(raw), /40-character commit SHA/);
});

test('context inventory is allowlisted, bounded, and ignores symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ar-context-'));
  mkdirSync(join(root, 'client/src'), { recursive: true });
  writeFileSync(join(root, 'client/src/api.ts'), 'api');
  writeFileSync(join(root, 'client/src/api.snap'), 'snap');
  writeFileSync(join(root, 'client/README.md'), 'readme');
  symlinkSync('/etc/passwd', join(root, 'client/src/passwd'));
  const out = contextInventory(manifest(), root);
  assert.equal(out.repositories[0].available, true);
  assert.deepEqual(out.repositories[0].files.map((f) => f.path), ['src/api.ts']);
});

test('context pack copies only allowlisted regular files', () => {
  const source = mkdtempSync(join(tmpdir(), 'ar-context-source-'));
  const output = mkdtempSync(join(tmpdir(), 'ar-context-output-'));
  mkdirSync(join(source, 'client/src'), { recursive: true });
  writeFileSync(join(source, 'client/src/api.ts'), 'api');
  writeFileSync(join(source, 'client/secret.txt'), 'secret');
  const out = packContext(manifest(), source, output);
  assert.deepEqual(out.repositories[0].files.map((f) => f.path), ['src/api.ts']);
  assert.equal(require('node:fs').existsSync(join(output, 'client/secret.txt')), false);
});

test('context pack preserves source truncation in its audit inventory', () => {
  const source = mkdtempSync(join(tmpdir(), 'ar-context-source-'));
  const output = mkdtempSync(join(tmpdir(), 'ar-context-output-'));
  mkdirSync(join(source, 'client/src'), { recursive: true });
  writeFileSync(join(source, 'client/src/a.ts'), 'a');
  writeFileSync(join(source, 'client/src/b.ts'), 'b');
  const raw = manifest();
  raw.repositories[0].max_files = 1;
  const out = packContext(raw, source, output);
  assert.equal(out.repositories[0].files.length, 1);
  assert.equal(out.repositories[0].sourceMatchedFiles, 2);
  assert.equal(out.repositories[0].truncated, true);
});
