'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPTURE_FILES,
  ARM_MAX_AGE_SECONDS,
  STOP_BUFFER_LINES,
  CAPTURE_SOURCE,
  captureDir,
  captureDirProblem,
  armedState,
  stripSkillHeader,
  lastAssistantText,
  postSkillWrites,
  subagentStopWrites,
} = require('./captureHook.cjs');

const NOW = 1_800_000_000;
const ARM = { armed: true, run_id: 'r1', args: 'xhigh 12', created: NOW - 60 };

function skillPayload({ tool_input, tool_response, ...rest } = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Skill',
    session_id: 's1',
    tool_use_id: 'tu1',
    agent_id: 'lane1',
    tool_input: { skill: 'code-review', args: 'xhigh 12', ...tool_input },
    tool_response: tool_response === undefined
      ? {
        success: true,
        commandName: 'code-review',
        status: 'forked',
        background: true,
        agentId: 'f1',
        result: 'Running in the background as @code-review',
      }
      : tool_response,
    ...rest,
  };
}

// The headless shape: no `background` key, and `result` is the fork's full final text.
function foregroundResponse(extra = {}) {
  return { success: true, commandName: 'code-review', status: 'forked', agentId: 'f1', ...extra };
}

function stopPayload(extra = {}) {
  return {
    hook_event_name: 'SubagentStop',
    agent_id: 'f1',
    agent_type: 'general-purpose',
    last_assistant_message: '- lib/cart.rb:50: total uses the wrong discount',
    agent_transcript_path: '/t/f1.jsonl',
    ...extra,
  };
}

function stopEntry(agent_id, last_assistant_message, ts = NOW - 5) {
  return { agent_id, last_assistant_message, agent_transcript_path: `/t/${agent_id}.jsonl`, ts };
}

const PENDING = { fork_id: 'f1', args: 'xhigh 12', caller: 'lane1', tool_use_id: 'tu1', session_id: 's1', ts: NOW - 30 };

function noTranscript() {
  throw new Error('readTranscript must not be called');
}

test('capture constants match the documented names', () => {
  assert.deepEqual(CAPTURE_FILES, {
    arm: 'agent_review_capture.json',
    pending: 'code_review_capture.pending.json',
    capture: 'code_review_capture.json',
    stops: 'code_review_capture.stops.jsonl',
    mismatch: 'code_review_capture.mismatch.json',
  });
  assert.equal(ARM_MAX_AGE_SECONDS, 21600);
  assert.equal(STOP_BUFFER_LINES, 50);
  assert.equal(CAPTURE_SOURCE, 'agent-review-capture-hook');
  assert.equal(captureDir({}), `/tmp/agent-review-${process.getuid()}`);
  assert.equal(captureDir({ AGENT_REVIEW_CAPTURE_DIR: '/x/y' }), '/x/y');
});

function fakeStat({ symlink = false, directory = true, uid = process.getuid(), mode = 0o40700 } = {}) {
  return { isSymbolicLink: () => symlink, isDirectory: () => directory, uid, mode };
}

test('captureDirProblem accepts only a private real directory', () => {
  assert.equal(captureDirProblem(fakeStat(), process.getuid()), null);
  assert.match(captureDirProblem(null, process.getuid()), /does not exist/);
  assert.match(captureDirProblem(fakeStat({ symlink: true, directory: false }), process.getuid()), /symlink/);
  assert.match(captureDirProblem(fakeStat({ directory: false, mode: 0o100600 }), process.getuid()), /not a directory/);
  for (const mode of [0o40770, 0o40702, 0o40750, 0o40701, 0o40710]) {
    assert.match(
      captureDirProblem(fakeStat({ mode }), process.getuid()),
      /group or other permission bits/,
      mode.toString(8),
    );
  }
});

// The CLI cannot hand a real directory to another owner without root, so ownership is checked here.
test('capture dir owned by another uid is refused', () => {
  const me = process.getuid();
  assert.match(captureDirProblem(fakeStat({ uid: me + 1 }), me), new RegExp(`owned by uid ${me + 1}, not ${me}`));
  assert.match(captureDirProblem(fakeStat({ uid: 0 }), 501), /owned by uid 0, not 501/);
});

test('armedState accepts a fresh arm and rejects missing, malformed, disarmed, or stale ones', () => {
  assert.equal(armedState(ARM, NOW), ARM);
  assert.equal(armedState({ ...ARM, created: NOW - ARM_MAX_AGE_SECONDS }, NOW).run_id, 'r1');
  assert.equal(armedState({ ...ARM, created: NOW - 5 * 3600 }, NOW).run_id, 'r1', 'a max relaunch 5 hours after arming is still armed');
  for (const arm of [
    null,
    undefined,
    'armed',
    [],
    {},
    { ...ARM, armed: false },
    { ...ARM, armed: 'true' },
    { ...ARM, created: NOW - 21601 },
    { ...ARM, created: 'yesterday' },
    { ...ARM, run_id: '' },
    { ...ARM, args: undefined },
  ]) {
    assert.equal(armedState(arm, NOW), null, JSON.stringify(arm));
  }
});

test('not armed: neither hook writes anything', () => {
  for (const arm of [null, { ...ARM, armed: false }, { ...ARM, created: NOW - 21601 }]) {
    const label = JSON.stringify(arm);
    for (const payload of [
      skillPayload(),
      skillPayload({ tool_input: { args: 'xhigh  12' } }),
      skillPayload({ tool_response: foregroundResponse({ result: 'findings' }) }),
    ]) {
      assert.deepEqual(
        postSkillWrites({ payload, arm, stops: [stopEntry('f1', 'done')], now: NOW, readTranscript: noTranscript }),
        {},
        label,
      );
    }
    assert.deepEqual(
      subagentStopWrites({ payload: stopPayload(), arm, pending: PENDING, capture: null, now: NOW, readTranscript: noTranscript }),
      { stop: null },
      label,
    );
  }
});

test('post-skill ignores other skills and main-thread callers', () => {
  const base = { arm: ARM, stops: [stopEntry('f1', 'done')], now: NOW, readTranscript: noTranscript };
  assert.deepEqual(postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill: 'simplify' } }) }), {});

  const mainThread = skillPayload();
  delete mainThread.agent_id;
  assert.deepEqual(postSkillWrites({ ...base, payload: mainThread }), {});

  const mainThreadOtherArgs = skillPayload({ tool_input: { args: 'low' } });
  delete mainThreadOtherArgs.agent_id;
  assert.deepEqual(postSkillWrites({ ...base, payload: mainThreadOtherArgs }), {}, 'no mismatch for a main-thread call');

  const mainThreadForeground = skillPayload({ tool_response: foregroundResponse({ result: 'findings' }) });
  delete mainThreadForeground.agent_id;
  assert.deepEqual(postSkillWrites({ ...base, payload: mainThreadForeground }), {});

  for (const payload of [null, 'text', [], {}]) {
    assert.deepEqual(postSkillWrites({ ...base, payload }), {}, JSON.stringify(payload));
  }
});

test('post-skill with different args writes only a mismatch', () => {
  const written = postSkillWrites({
    payload: skillPayload({ tool_input: { args: 'xhigh  12' } }),
    arm: ARM,
    stops: [stopEntry('f1', 'done')],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.deepEqual(written, { mismatch: { run_id: 'r1', expected: 'xhigh 12', got: 'xhigh  12', ts: NOW } });

  const noArgs = skillPayload();
  delete noArgs.tool_input.args;
  assert.deepEqual(
    postSkillWrites({ payload: noArgs, arm: ARM, stops: [], now: NOW, readTranscript: noTranscript }).mismatch,
    { run_id: 'r1', expected: 'xhigh 12', got: '', ts: NOW },
  );
});

test('background fork writes pending with the fork id', () => {
  const written = postSkillWrites({
    payload: skillPayload(),
    arm: ARM,
    stops: [stopEntry('other', 'not the fork'), stopEntry('lane1', null)],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(written.pending.fork_id, 'f1');
  assert.deepEqual(written.pending, {
    run_id: 'r1',
    fork_id: 'f1',
    args: 'xhigh 12',
    caller: 'lane1',
    tool_use_id: 'tu1',
    session_id: 's1',
    ts: NOW,
  });
  assert.equal(written.capture, undefined);
  assert.equal(written.mismatch, undefined);
});

test('a background reply with no fork id writes only a mismatch', () => {
  for (const agentId of [undefined, '', '  ', 7]) {
    const response = { success: true, status: 'forked', background: true, result: 'Running in the background' };
    if (agentId !== undefined) response.agentId = agentId;
    const written = postSkillWrites({
      payload: skillPayload({ tool_response: response }),
      arm: ARM,
      stops: [stopEntry('f1', 'done')],
      now: NOW,
      readTranscript: noTranscript,
    });
    assert.deepEqual(
      written,
      { mismatch: { run_id: 'r1', expected: 'xhigh 12', got: 'xhigh 12', reason: 'no fork id', ts: NOW } },
      JSON.stringify(agentId),
    );
  }
});

test('a subagent calling a plugin skill named *:code-review writes a mismatch naming the skill and args', () => {
  const base = { arm: ARM, stops: [], now: NOW, readTranscript: noTranscript };
  for (const skill of ['code-review:code-review', 'other-plugin:code-review']) {
    const written = postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill } }) });
    assert.deepEqual(
      written,
      { mismatch: { run_id: 'r1', expected: 'xhigh 12', got: `skill "${skill}" with args "xhigh 12"`, reason: 'wrong skill', ts: NOW } },
      skill,
    );
  }
  const mainThread = skillPayload({ tool_input: { skill: 'code-review:code-review' } });
  delete mainThread.agent_id;
  assert.deepEqual(postSkillWrites({ ...base, payload: mainThread }), {}, 'a main-thread call never fails a review');
  for (const skill of ['code-reviewer', 'my-code-review', 'code-review:review', ':code-review-x']) {
    assert.deepEqual(postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill } }) }), {}, skill);
  }
  assert.deepEqual(postSkillWrites({ ...base, arm: null, payload: skillPayload({ tool_input: { skill: 'code-review:code-review' } }) }), {}, 'not armed');
});

test('post-skill strips one leading / from the skill name before matching', () => {
  const base = { arm: ARM, stops: [], now: NOW, readTranscript: noTranscript };
  const slashed = postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill: '/code-review' } }) });
  assert.deepEqual(slashed, postSkillWrites({ ...base, payload: skillPayload() }), '/code-review is the built-in skill');
  assert.equal(slashed.pending.fork_id, 'f1');

  assert.deepEqual(
    postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill: '/code-review', args: 'low' } }) }),
    { mismatch: { run_id: 'r1', expected: 'xhigh 12', got: 'low', ts: NOW } },
  );
  assert.deepEqual(
    postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill: '/x:code-review' } }) }),
    { mismatch: { run_id: 'r1', expected: 'xhigh 12', got: 'skill "x:code-review" with args "xhigh 12"', reason: 'wrong skill', ts: NOW } },
  );
  for (const skill of ['//code-review', '/simplify', '/']) {
    assert.deepEqual(postSkillWrites({ ...base, payload: skillPayload({ tool_input: { skill } }) }), {}, skill);
  }
});

test('background fork whose stop is already buffered also writes the capture', () => {
  const written = postSkillWrites({
    payload: skillPayload(),
    arm: ARM,
    stops: [stopEntry('f1', '- a.rb:1: the buffered result'), stopEntry('other', 'not the fork')],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(written.pending.fork_id, 'f1');
  assert.equal(written.capture.mode, 'forked');
  assert.equal(written.capture.stop_count, 1);
  assert.equal(written.capture.result, '- a.rb:1: the buffered result');
  assert.deepEqual(written.capture, {
    source: CAPTURE_SOURCE,
    mode: 'forked',
    run_id: 'r1',
    args: 'xhigh 12',
    fork_id: 'f1',
    result: '- a.rb:1: the buffered result',
    transcript: '/t/f1.jsonl',
    stop_count: 1,
    ts: NOW,
  });
});

test('foreground fork captures tool_response.result without the Skill header', () => {
  const run = (tool_response, stops = []) =>
    postSkillWrites({ payload: skillPayload({ tool_response }), arm: ARM, stops, now: NOW, readTranscript: noTranscript });

  const headed = run(
    foregroundResponse({ result: 'Skill "code-review" completed (forked execution).\n\nResult:\n(none)' }),
    [stopEntry('f1', 'the stop text loses to tool_response.result')],
  );
  assert.equal(headed.capture.result, '(none)');
  assert.equal(headed.capture.mode, 'foreground');
  assert.equal(headed.pending, undefined);
  assert.deepEqual(headed.capture, {
    source: CAPTURE_SOURCE,
    mode: 'foreground',
    run_id: 'r1',
    args: 'xhigh 12',
    fork_id: 'f1',
    result: '(none)',
    transcript: '/t/f1.jsonl',
    stop_count: 1,
    ts: NOW,
  });

  const headless = run(foregroundResponse({ result: 'I reviewed it.\n\n```json\n[]\n```' }));
  assert.equal(headless.capture.result, 'I reviewed it.\n\n```json\n[]\n```');
  assert.equal(headless.capture.mode, 'foreground');
  assert.equal(headless.capture.stop_count, 0);
  assert.equal(headless.capture.transcript, null);

  const explicitFalse = run(foregroundResponse({ background: false, result: 'findings' }));
  assert.equal(explicitFalse.capture.mode, 'foreground');
  assert.equal(explicitFalse.capture.result, 'findings');

  const stringResponse = run('Skill "code-review" completed (forked execution).\n\nResult:\n- a.rb:3: off by one');
  assert.equal(stringResponse.capture.result, '- a.rb:3: off by one', 'the text after Result: in a string tool result');
  assert.equal(stringResponse.capture.fork_id, null);
});

test('foreground fork with no result string uses the latest buffered stop for its agentId', () => {
  const written = postSkillWrites({
    payload: skillPayload({ tool_response: foregroundResponse() }),
    arm: ARM,
    stops: [
      stopEntry('f1', 'older stop'),
      { ...stopEntry('other', 'not the fork'), agent_transcript_path: '/t/other.jsonl' },
      { ...stopEntry('f1', 'latest stop'), agent_transcript_path: '/t/f1-latest.jsonl' },
      stopEntry('lane1', null),
    ],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(written.capture.mode, 'foreground');
  assert.equal(written.capture.result, 'latest stop');
  assert.equal(written.capture.transcript, '/t/f1-latest.jsonl');
  assert.equal(written.capture.stop_count, 2);
  assert.equal(written.pending, undefined);

  const empty = postSkillWrites({
    payload: skillPayload({ tool_response: foregroundResponse({ result: '   ' }) }),
    arm: ARM,
    stops: [stopEntry('f1', 'the stop wins over an empty result')],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(empty.capture.result, 'the stop wins over an empty result');

  const nothing = postSkillWrites({
    payload: skillPayload({ tool_response: foregroundResponse() }),
    arm: ARM,
    stops: [stopEntry('other', 'not the fork')],
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(nothing.capture.result, '', 'no source gives an empty result, written at once');
  assert.equal(nothing.capture.stop_count, 0);
});

test('matching stop writes the capture, and a second matching stop overwrites it with stop_count 2', () => {
  const first = subagentStopWrites({
    payload: stopPayload({ last_assistant_message: 'first stop' }),
    arm: ARM,
    pending: PENDING,
    capture: null,
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.deepEqual(first.stop, { agent_id: 'f1', last_assistant_message: 'first stop', agent_transcript_path: '/t/f1.jsonl', ts: NOW });
  assert.deepEqual(first.capture, {
    source: CAPTURE_SOURCE,
    mode: 'forked',
    run_id: 'r1',
    args: 'xhigh 12',
    fork_id: 'f1',
    result: 'first stop',
    transcript: '/t/f1.jsonl',
    stop_count: 1,
    ts: NOW,
  });

  const second = subagentStopWrites({
    payload: stopPayload({ last_assistant_message: 'second stop' }),
    arm: ARM,
    pending: PENDING,
    capture: first.capture,
    now: NOW + 30,
    readTranscript: noTranscript,
  });
  assert.equal(second.capture.stop_count, 2);
  assert.equal(second.capture.result, 'second stop');
  assert.equal(second.capture.ts, NOW + 30);

  const otherRun = subagentStopWrites({
    payload: stopPayload(),
    arm: ARM,
    pending: PENDING,
    capture: { ...first.capture, run_id: 'r0', stop_count: 7 },
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.equal(otherRun.capture.stop_count, 1, 'a capture from another run does not carry its count');
});

test('non-matching stops only buffer', () => {
  const other = subagentStopWrites({
    payload: stopPayload({
      agent_id: 'helper9',
      agent_type: '',
      last_assistant_message: 'helper text',
      agent_transcript_path: '/t/helper9.jsonl',
    }),
    arm: ARM,
    pending: PENDING,
    capture: null,
    now: NOW,
    readTranscript: noTranscript,
  });
  assert.deepEqual(other, {
    stop: { agent_id: 'helper9', last_assistant_message: 'helper text', agent_transcript_path: '/t/helper9.jsonl', ts: NOW },
  });

  const callerOwnStop = stopPayload({ agent_id: 'lane1', agent_transcript_path: '/t/lane1.jsonl' });
  delete callerOwnStop.last_assistant_message;
  assert.deepEqual(
    subagentStopWrites({ payload: callerOwnStop, arm: ARM, pending: PENDING, capture: null, now: NOW, readTranscript: noTranscript }),
    { stop: { agent_id: 'lane1', last_assistant_message: null, agent_transcript_path: '/t/lane1.jsonl', ts: NOW } },
  );

  const noPending = subagentStopWrites({ payload: stopPayload(), arm: ARM, pending: null, capture: null, now: NOW, readTranscript: noTranscript });
  assert.equal(noPending.stop.agent_id, 'f1');
  assert.equal(noPending.capture, undefined, 'a fork stop before PostToolUse only buffers');

  assert.deepEqual(
    subagentStopWrites({ payload: { hook_event_name: 'SubagentStop' }, arm: ARM, pending: PENDING, capture: null, now: NOW }),
    { stop: null },
    'a payload with no agent_id is not buffered',
  );
});

test('an empty last_assistant_message falls back to readTranscript, and a null transcript gives result ""', () => {
  const seen = [];
  const fromTranscript = subagentStopWrites({
    payload: stopPayload({ last_assistant_message: '' }),
    arm: ARM,
    pending: PENDING,
    capture: null,
    now: NOW,
    readTranscript: (path) => (seen.push(path), 'text from the transcript'),
  });
  assert.deepEqual(seen, ['/t/f1.jsonl']);
  assert.equal(fromTranscript.capture.result, 'text from the transcript');
  assert.equal(fromTranscript.stop.last_assistant_message, '');

  const missingKey = stopPayload();
  delete missingKey.last_assistant_message;
  const nullTranscript = subagentStopWrites({
    payload: missingKey,
    arm: ARM,
    pending: PENDING,
    capture: null,
    now: NOW,
    readTranscript: () => null,
  });
  assert.equal(nullTranscript.capture.result, '');

  const throwing = subagentStopWrites({
    payload: stopPayload({ last_assistant_message: '' }),
    arm: ARM,
    pending: PENDING,
    capture: null,
    now: NOW,
    readTranscript: () => {
      throw new Error('unreadable');
    },
  });
  assert.equal(throwing.capture.result, '');

  const bufferedEmpty = postSkillWrites({
    payload: skillPayload({ tool_response: foregroundResponse() }),
    arm: ARM,
    stops: [stopEntry('f1', '')],
    now: NOW,
    readTranscript: (path) => `transcript of ${path}`,
  });
  assert.equal(bufferedEmpty.capture.result, 'transcript of /t/f1.jsonl', 'buffered stops use the same fallback');
});

test('stripSkillHeader leaves text without the header unchanged', () => {
  for (const text of [
    '',
    '(none)',
    '  - a.rb:1: bug\n',
    'Skill "code-review" completed, but there is no result line here',
    'Skill "simplify" completed (forked execution).\n\nResult:\nkept',
    'Intro.\nSkill "code-review" completed (forked execution).\nResult:\nkept',
    '- a.rb:1: x\nsummary\nResult:\n- b.rb:2: y',
    'Skill "code-review" completed (forked execution).\n\n\n\nResult:\n- a.rb:1: x',
    'Skill "code-review" completed (forked execution).\n\n\n\nResult: (none)',
    'Skill "code-review" completed (forked execution).\nResults: (none)',
    'Skill "code-review" completed (forked execution).\n- a.rb:1: bug\nResult: 1 finding',
    'Skill "code-review" completed (forked execution).\n- a.rb:1: bug\nResult:\n- b.rb:2: y',
    'Skill "code-review" completed\nsummary line\nResult: the cart is wrong\nmore',
    'Skill "code-review" completed (forked execution).\n\n- a.rb:1: bug\nResult: (none)',
  ]) {
    assert.equal(stripSkillHeader(text), text, `${JSON.stringify(text)}: a non-blank line above Result: keeps the text whole`);
  }
  assert.equal(stripSkillHeader('Skill "code-review" completed (forked execution).\nResult: (none)'), '(none)', 'text on the Result: line starts the result');
  assert.equal(stripSkillHeader('Skill "code-review" completed (forked execution).\n \t\n\nResult: 1 finding\n- a.rb:1: bug'), '1 finding\n- a.rb:1: bug', 'only blank lines between');
  assert.equal(stripSkillHeader('Skill "code-review" completed (forked execution).\r\n  Result:   - a.rb:1: x  \r\n- b.rb:2: y'), '- a.rb:1: x\n- b.rb:2: y');
  assert.equal(
    stripSkillHeader('Skill "code-review" completed (forked execution).\n\nResult:\n- a.rb:1: x\nResult: kept'),
    '- a.rb:1: x\nResult: kept',
  );
  assert.equal(stripSkillHeader('\n  Skill "code-review" completed (forked execution).\r\n\r\n  Result:  \r\n(none)'), '(none)');
  assert.equal(stripSkillHeader('Skill "code-review" completed (forked execution).\n\n\nResult:\n(none)'), '(none)', 'Result: on the third line after the header');
  assert.equal(stripSkillHeader('Skill "code-review" completed (forked execution).\nResult:'), '');
});

test('lastAssistantText returns the last assistant text block in a transcript', () => {
  const line = (o) => JSON.stringify(o);
  const jsonl = [
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first block' }, { type: 'text', text: 'final text' }, { type: 'tool_use', id: 't' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a user turn' }] } }),
    line({ type: 'api-request-blob', message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u' }] } }),
    'not json {',
    '',
  ].join('\n');
  assert.equal(lastAssistantText(jsonl), 'final text');
  assert.equal(lastAssistantText(''), null);
  assert.equal(lastAssistantText(line({ type: 'user', message: { content: 'hi' } })), null);
});
