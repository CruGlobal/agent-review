'use strict';
const { join, isAbsolute, resolve } = require('node:path');

function repoRoot(opts = {}) {
  return resolve(opts.root || process.env.AGENT_REVIEW_ROOT || process.cwd());
}

// Where the consuming repo keeps review data (config, rules, learnings, index).
function reviewDir(opts = {}) {
  const dir = opts.reviewDir || process.env.AGENT_REVIEW_DIR || '.claude/review';
  return isAbsolute(dir) ? dir : join(repoRoot(opts), dir);
}

module.exports = { repoRoot, reviewDir };
