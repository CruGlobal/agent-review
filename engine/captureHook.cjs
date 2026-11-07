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
const RUNS_DIR = 'runs';
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

// /code-review's args are "<effort> <target> ...": the target is the PR number or commit range.
function argsTarget(args) {
  const words = typeof args === 'string' ? args.trim().split(/\s+/) : [];
  return words.length > 1 ? words[1] : null;
}

function skillCall(payload) {
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  return {
    skill: typeof input.skill === 'string' ? input.skill.replace(/^\//, '') : '',
    args: typeof input.args === 'string' ? input.args : '',
  };
}

// A hook's session_id is the main session's id for subagents at any depth and equals the Bash
// CLAUDE_CODE_SESSION_ID, so a call reaches only arms its own session made. Within a session only
// the args tell runs apart.
function chooseArms({ arms, payload } = {}) {
  const candidates = sessionArms({ arms, payload });
  if (candidates.length === 0) return { kind: 'none', entries: [] };
  const { skill, args } = skillCall(payload);
  const builtIn = skill === CODE_REVIEW_SKILL;
  if (!builtIn && !skill.endsWith(`:${CODE_REVIEW_SKILL}`)) return { kind: 'none', entries: [] };
  if (builtIn) {
    const exact = candidates.filter((e) => e.arm.args === args);
    if (exact.length === 1) return { kind: 'match', entries: exact };
    if (exact.length > 1) return { kind: 'ambiguous', entries: exact };
  }
  const target = argsTarget(args);
  const same = target === null ? [] : candidates.filter((e) => argsTarget(e.arm.args) === target);
  return same.length === 1 ? { kind: 'mismatch', entries: same } : { kind: 'none', entries: [] };
}

function sessionOf(v) {
  return nonEmpty(v) ? v : null;
}

// The arms a subagent call or stop may belong to: those its own session made. A missing session id
// matches only another missing one.
function sessionArms({ arms, payload } = {}) {
  if (!Array.isArray(arms) || !isObject(payload) || !nonEmpty(payload.agent_id)) return [];
  const session = sessionOf(payload.session_id);
  return arms.filter((e) => isObject(e) && isObject(e.arm) && sessionOf(e.arm.session_id) === session);
}

function ambiguousMismatch({ arm, payload, now }) {
  const { args } = skillCall(payload);
  return { mismatch: { run_id: arm.run_id, expected: arm.args, got: args, reason: 'ambiguous', ts: now } };
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
  const { skill, args } = skillCall(payload);
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
  RUNS_DIR,
  STOP_BUFFER_LINES,
  CAPTURE_SOURCE,
  captureDir,
  captureDirProblem,
  armedState,
  argsTarget,
  chooseArms,
  sessionArms,
  ambiguousMismatch,
  stripSkillHeader,
  lastAssistantText,
  postSkillWrites,
  subagentStopWrites,
};
