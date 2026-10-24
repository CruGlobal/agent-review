'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unwrapFindings } = require('./unwrapFindings.cjs');
const { parseLane } = require('./consensus.cjs');
const { findingList } = require('./reportState.cjs');

test('unwrapFindings returns a bare array or a findings array, else null', () => {
  const list = [{ file: 'a.js' }];
  assert.equal(unwrapFindings(list), list);
  assert.equal(unwrapFindings({ findings: list, level: 'high' }), list);
  for (const value of [null, undefined, 'x', 3, {}, { findings: 'x' }, { kept: list }]) {
    assert.equal(unwrapFindings(value), null, JSON.stringify(value));
  }
});

test('parseLane and findingList keep their own rules on top of the shared unwrap', () => {
  const list = [{ file: 'a.js' }];
  assert.equal(parseLane(list, 'x'), list);
  assert.equal(parseLane({ findings: list }, 'x'), list);
  assert.throws(() => parseLane({ kept: list }, 'x'), /must be an array or \{findings:\[\.\.\.\]\}/);
  assert.throws(() => parseLane('{', 'x'), /unparseable findings JSON for lane "x"/);
  assert.throws(() => parseLane(undefined, 'x'), /missing findings for lane "x"/);

  assert.equal(findingList(list), list);
  assert.equal(findingList({ kept: list, findings: [] }), list, 'kept wins over findings');
  assert.equal(findingList({ findings: list }), list);
  assert.throws(() => findingList({}), /findings must be an array or an object with kept\/findings/);
});
