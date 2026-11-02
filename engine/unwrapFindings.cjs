'use strict';

function unwrapFindings(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object' && Array.isArray(value.findings)) return value.findings;
  return null;
}

module.exports = { unwrapFindings };
