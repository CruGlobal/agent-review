'use strict';

const ENGINE_DEFAULT = 'agent-review';
const ENGINE_CODE_REVIEW = 'code-review';
const CODE_REVIEW_LANE = 'code-review';
const ENGINES = [ENGINE_DEFAULT, ENGINE_CODE_REVIEW];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['auto', 'quick', 'standard', 'deep'];
const FINAL_MODES = ['skip', 'quick', 'standard', 'deep'];
const CATEGORIES = [
  'correctness',
  'security',
  'data-integrity',
  'testing',
  'simplification',
  'efficiency',
  'reuse',
  'altitude',
  'conventions',
];
const CLEANUP_CATEGORIES = ['simplification', 'efficiency', 'reuse', 'altitude', 'conventions'];

module.exports = {
  ENGINE_DEFAULT,
  ENGINE_CODE_REVIEW,
  CODE_REVIEW_LANE,
  ENGINES,
  EFFORTS,
  MODES,
  FINAL_MODES,
  CATEGORIES,
  CLEANUP_CATEGORIES,
};
