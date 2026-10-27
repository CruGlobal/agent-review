'use strict';
const { ENGINE_CODE_REVIEW } = require('./vocabulary.cjs');

// /code-review's skill name is the same string as the engine name.
const CODE_REVIEW_SKILL = ENGINE_CODE_REVIEW;

const CAPTURE_FILES = {
  arm: 'agent_review_capture.json',
  pending: 'code_review_capture.pending.json',
  capture: 'code_review_capture.json',
  stops: 'code_review_capture.stops.jsonl',
  mismatch: 'code_review_capture.mismatch.json',
};
const ARM_MAX_AGE_SECONDS = 21600;
const STOP_BUFFER_LINES = 50;
const CAPTURE_SOURCE = 'agent-review-capture-hook';

const SKILL_HEADER = new RegExp(`^\\s*Skill "${CODE_REVIEW_SKILL}" completed`);
const RESULT_LINE_WITHIN = 3;
const RESULT_LABEL = 'Result:';

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// The root stays /tmp so the hooks and the sandboxed Bash tool agree on the path.
function captureDir(env = process.env) {
  return env.AGENT_REVIEW_CAPTURE_DIR || `/tmp/agent-review-${process.getuid()}`;
}

// Capture files decide approvals, so the dir must be one no other local user can plant files in.
function captureDirProblem(stat, uid) {
  if (!stat) return 'does not exist';
  if (stat.isSymbolicLink()) return 'is a symlink';
  if (!stat.isDirectory()) return 'is not a directory';
  if (stat.uid !== uid) return `is owned by uid ${stat.uid}, not ${uid}`;
  if (stat.mode & 0o077) {
    return `has group or other permission bits (mode ${(stat.mode & 0o777).toString(8)}; it must be 700)`;
  }
  return null;
}

function armedState(arm, nowSeconds) {
  if (!isObject(arm) || arm.armed !== true) return null;
  if (!nonEmpty(arm.run_id) || typeof arm.args !== 'string') return null;
  if (!Number.isFinite(arm.created) || nowSeconds - arm.created > ARM_MAX_AGE_SECONDS) return null;
  return arm;
}

// The Skill tool's header is stripped only when its Result: line follows it with nothing but blank
// lines between; any other Result: line is part of /code-review's text, and so is everything above
// it. Text after the label on that line is the start of the result.
function stripSkillHeader(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => line.trim() !== '');
  if (header < 0 || !SKILL_HEADER.test(lines[header])) return text;
  const last = Math.min(header + RESULT_LINE_WITHIN, lines.length - 1);
  for (let i = header + 1; i <= last; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!line.startsWith(RESULT_LABEL)) return text;
    const first = line.slice(RESULT_LABEL.length).trim();
    const rest = lines.slice(i + 1);
    return (first === '' ? rest : [first, ...rest]).join('\n');
  }
  return text;
}

function lastAssistantText(jsonl) {
  const lines = String(jsonl).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.type !== 'assistant' || !isObject(entry.message)) continue;
    const { content } = entry.message;
    if (nonEmpty(content)) return content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (isObject(block) && block.type === 'text' && nonEmpty(block.text)) return block.text;
    }
  }
  return null;
}

function stopResult(stop, readTranscript) {
  if (nonEmpty(stop.last_assistant_message)) return stop.last_assistant_message;
  if (!nonEmpty(stop.agent_transcript_path) || typeof readTranscript !== 'function') return '';
  try {
    const text = readTranscript(stop.agent_transcript_path);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function captureRecord({ mode, armed, args, forkId, result, transcript, stopCount, now }) {
  return {
    source: CAPTURE_SOURCE,
    mode,
    run_id: armed.run_id,
    args,
    fork_id: forkId,
    result,
    transcript: nonEmpty(transcript) ? transcript : null,
    stop_count: stopCount,
    ts: now,
  };
}

// A plugin command such as code-review:code-review is never the built-in skill, so an armed
// lane that calls one has missed the capture and must fail fast instead of waiting it out.
function postSkillWrites({ payload, arm, stops, now, readTranscript } = {}) {
  const armed = armedState(arm, now);
  if (!armed || !isObject(payload) || !nonEmpty(payload.agent_id)) return {};
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const skill = typeof input.skill === 'string' ? input.skill.replace(/^\//, '') : '';
  const args = typeof input.args === 'string' ? input.args : '';
  const mismatch = (got, reason) => ({
    mismatch: { run_id: armed.run_id, expected: armed.args, got, ...(reason ? { reason } : {}), ts: now },
  });
  if (skill !== CODE_REVIEW_SKILL) {
    if (!skill.endsWith(`:${CODE_REVIEW_SKILL}`)) return {};
    return mismatch(`skill ${JSON.stringify(skill)} with args ${JSON.stringify(args)}`, 'wrong skill');
  }
  if (args !== armed.args) return mismatch(args);

  const response = payload.tool_response;
  const tr = isObject(response) ? response : {};
  const forkId = nonEmpty(tr.agentId) ? tr.agentId : null;
  if (tr.background === true && !forkId) return mismatch(args, 'no fork id');
  const forkStops = forkId && Array.isArray(stops)
    ? stops.filter((s) => isObject(s) && s.agent_id === forkId)
    : [];
  const latest = forkStops.at(-1);
  const record = (mode, result) =>
    captureRecord({
      mode,
      armed,
      args,
      forkId,
      result,
      transcript: latest && latest.agent_transcript_path,
      stopCount: forkStops.length,
      now,
    });

  if (tr.background === true) {
    const written = {
      pending: {
        run_id: armed.run_id,
        fork_id: forkId,
        args,
        caller: payload.agent_id,
        tool_use_id: payload.tool_use_id ?? null,
        session_id: payload.session_id ?? null,
        ts: now,
      },
    };
    if (latest) written.capture = record('forked', stopResult(latest, readTranscript));
    return written;
  }

  const fromResponse = [tr.result, response]
    .filter((v) => typeof v === 'string')
    .map(stripSkillHeader)
    .find(nonEmpty);
  let result = '';
  if (fromResponse !== undefined) result = fromResponse;
  else if (latest) result = stopResult(latest, readTranscript);
  return { capture: record('foreground', result) };
}

function subagentStopWrites({ payload, arm, pending, capture, now, readTranscript } = {}) {
  const armed = armedState(arm, now);
  if (!armed || !isObject(payload) || !nonEmpty(payload.agent_id)) return { stop: null };
  const stop = {
    agent_id: payload.agent_id,
    last_assistant_message:
      typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null,
    agent_transcript_path:
      typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : null,
    ts: now,
  };
  if (!isObject(pending) || !nonEmpty(pending.fork_id) || pending.fork_id !== stop.agent_id) {
    return { stop };
  }
  const previous =
    isObject(capture) &&
    capture.run_id === armed.run_id &&
    capture.fork_id === pending.fork_id &&
    Number.isInteger(capture.stop_count)
      ? capture.stop_count
      : 0;
  return {
    stop,
    capture: captureRecord({
      mode: 'forked',
      armed,
      args: typeof pending.args === 'string' ? pending.args : armed.args,
      forkId: pending.fork_id,
      result: stopResult(stop, readTranscript),
      transcript: stop.agent_transcript_path,
      stopCount: previous + 1,
      now,
    }),
  };
}

module.exports = {
  CODE_REVIEW_SKILL,
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
};
