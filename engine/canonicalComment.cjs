'use strict';
// The user's own marked comment, else the bot's; never anyone else's, which could be forged.
const { MARKER } = require('./approval.cjs');

const BOT = 'github-actions[bot]';

// `gh api --paginate` prints each page's JSON array one after another, with nothing between.
function readPages(text) {
  const comments = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(ch)) continue;
      if (ch !== '[') throw new Error('each page must be a JSON array of comments');
      start = i;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const page = JSON.parse(text.slice(start, i + 1));
        if (!Array.isArray(page)) throw new Error('each page must be a JSON array of comments');
        comments.push(...page);
      }
    }
  }
  if (depth !== 0 || inString) throw new Error('the comment list is cut off');
  return comments;
}

function canonicalComment(comments, me) {
  const reports = comments.filter(
    (c) => c && typeof c.body === 'string' && c.body.startsWith(MARKER) && c.user && typeof c.user.login === 'string',
  );
  const by = (login) => (login ? reports.find((c) => c.user.login === login) : undefined);
  return by(me) || by(BOT) || null;
}

module.exports = { readPages, canonicalComment, BOT };
