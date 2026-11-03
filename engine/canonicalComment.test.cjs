'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { readPages, canonicalComment } = require('./canonicalComment.cjs');

const BOT = 'github-actions[bot]';
const CLI = join(__dirname, 'cli.cjs');
const c = (id, login, text, marked = true) => ({
  id,
  user: { login },
  body: `${marked ? '<!-- agent-review -->\n' : ''}${text}`,
});
// gh api --paginate prints one JSON array per page with nothing between them.
const pages = (...ps) => ps.map((p) => JSON.stringify(p)).join('');

test('readPages joins every page gh prints', () => {
  const tricky = c(3, 'me', 'a body with ][ and "quotes" and \\ and {braces}');
  assert.deepEqual(readPages(pages([c(1, BOT, 'bot')], [], [tricky])).map((x) => x.id), [1, 3]);
  assert.deepEqual(readPages(`${JSON.stringify([c(1, BOT, 'x')])}\n${JSON.stringify([c(2, 'me', 'y')])}\n`).map((x) => x.id), [1, 2]);
  assert.deepEqual(readPages(''), []);
});

test('readPages refuses input that is not whole pages of comments', () => {
  for (const bad of ['{"message":"Not Found"}', '[{"id":1}', '[1] x', '"str"', '[{"id":1}]]']) {
    assert.throws(() => readPages(bad), undefined, bad);
  }
});

test('the own report wins even when the bot report is on an earlier page', () => {
  const filler = Array.from({ length: 30 }, (_, i) => c(100 + i, 'someone', 'chat', false));
  const all = readPages(pages([c(1, BOT, 'bot'), ...filler.slice(0, 29)], [filler[29], c(2, 'me', 'mine')]));
  assert.equal(canonicalComment(all, 'me').id, 2);
});

test('the pick falls back only to the bot, never to anyone else', () => {
  const forged = c(9, 'mallory', 'forged');
  assert.equal(canonicalComment([forged, c(1, BOT, 'bot')], 'me').id, 1);
  assert.equal(canonicalComment([forged, c(2, 'member', 'member')], 'me'), null);
  assert.equal(canonicalComment([forged], 'me'), null);
  assert.equal(canonicalComment([c(1, BOT, 'bot'), forged, c(2, 'me', 'mine')], 'me').id, 2);
  assert.equal(canonicalComment([c(1, BOT, 'bot'), c(2, 'me', 'mine')], '').id, 1, 'an unknown user gets the bot report');
  assert.equal(canonicalComment([c(2, 'me', 'no marker', false), c(1, BOT, 'bot')], 'me').id, 1, 'only marked comments count');
  assert.equal(canonicalComment([c(1, BOT, 'first'), c(4, BOT, 'second')], 'me').id, 1, 'the oldest of a login wins');
});

test('agent-review report-comment prints the canonical body or id from stdin', () => {
  const cli = (args, input) => spawnSync(process.execPath, [CLI, 'report-comment', ...args], { input, encoding: 'utf8' });
  const input = pages([c(1, BOT, 'bot')], [c(2, 'me', 'mine')]);
  assert.deepEqual([cli(['--me', 'me'], input).stdout, cli(['--me', 'me', '--field', 'id'], input).stdout], ['<!-- agent-review -->\nmine\n', '2\n']);
  assert.equal(cli(['--me', ''], input).stdout, '<!-- agent-review -->\nbot\n');
  const none = cli(['--me', 'me'], pages([c(9, 'mallory', 'forged')]));
  assert.deepEqual([none.status, none.stdout], [0, '']);
  const bad = cli(['--me', 'me'], '{"message":"Bad credentials"}');
  assert.deepEqual([bad.status, bad.stdout], [1, '']);
  assert.match(bad.stderr, /^report-comment: /);
  for (const args of [[], ['--me', 'me', '--field', 'login']]) {
    const usage = cli(args, input);
    assert.deepEqual([usage.status, usage.stdout], [1, 'usage: agent-review report-comment --me <login> [--field body|id]\n']);
  }
});
