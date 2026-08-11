'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveImport } = require('./resolveImport.cjs');

const fileSet = new Set([
  'src/b.ts',
  'src/a/c.ts',
  'src/lib/index.ts',
  'src/d.tsx',
  'pages/x.page.tsx',
]);

test('resolves relative import with extension inference', () => {
  assert.equal(resolveImport('src/a/c.ts', '../b', fileSet), 'src/b.ts');
});

test('resolves alias import (src/*)', () => {
  assert.equal(resolveImport('src/a/c.ts', 'src/d', fileSet), 'src/d.tsx');
});

test('resolves directory import to index file', () => {
  assert.equal(
    resolveImport('src/a/c.ts', 'src/lib', fileSet),
    'src/lib/index.ts',
  );
});

test('returns null for bare/external specifiers', () => {
  assert.equal(resolveImport('src/a/c.ts', 'react', fileSet), null);
  assert.equal(resolveImport('src/a/c.ts', '@mui/material', fileSet), null);
});

test('returns null for unresolvable relative import', () => {
  assert.equal(resolveImport('src/a/c.ts', './nope', fileSet), null);
});

test('object alias maps prefix to target dir', () => {
  const files = new Set(['src/lib/money.ts']);
  const r = resolveImport('src/app/page.tsx', '@/lib/money', files, {
    aliases: [{ prefix: '@/', target: 'src/' }],
  });
  assert.strictEqual(r, 'src/lib/money.ts');
});

test('string alias still resolves (no regression)', () => {
  const files = new Set(['src/b.ts']);
  const r = resolveImport('src/a/c.ts', 'src/b', files, {
    aliases: ['src/'],
  });
  assert.strictEqual(r, 'src/b.ts');
});

test('string alias equality-branch: spec equals alias root (defaults)', () => {
  const files = new Set(['src/index.ts', 'src.ts']);
  const r = resolveImport('other/file.ts', 'src', files);
  assert.strictEqual(r, 'src.ts');
});

test('object alias equality-branch: spec equals target root', () => {
  const files = new Set(['src/index.ts']);
  const r = resolveImport('other/file.ts', '@', files, {
    aliases: [{ prefix: '@/', target: 'src/' }],
  });
  assert.strictEqual(r, 'src/index.ts');
});
