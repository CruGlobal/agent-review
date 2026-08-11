'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, csv } = require('./impact.cjs');

test('parseArgs reads --flag value pairs', () => {
  const a = parseArgs([
    '--root',
    '/r',
    '--changed',
    '/c.txt',
    '--max-depth',
    '2',
  ]);
  assert.equal(a.root, '/r');
  assert.equal(a.changed, '/c.txt');
  assert.equal(a['max-depth'], '2');
});

test('parseArgs ignores non-flag tokens', () => {
  const a = parseArgs(['junk', '--root', '/r']);
  assert.equal(a.root, '/r');
  assert.equal(a.junk, undefined);
});

test('csv splits/trims comma-separated flag values; non-string passthrough as undefined', () => {
  assert.deepEqual(csv('a, b ,c'), ['a', 'b', 'c']);
  assert.equal(csv(undefined), undefined);
  assert.equal(csv(true), undefined); // boolean flag (no value) parses to `true`, not a string
});
