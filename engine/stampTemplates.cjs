'use strict';
// Records the sha256 of each workflow template under the current plugin version
// in templates/workflows/template-manifest.json. The templates test asserts the
// manifest entry for the current version matches the template contents, so a
// template edit fails `npm test` until the version is bumped and this is re-run:
//   npm run stamp-templates
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const MANIFEST = join(ROOT, 'templates/workflows/template-manifest.json');
const TEMPLATES = ['agent-review.yml', 'agent-review-interact.yml', 'agent-review-readiness.yml'];

const version = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
manifest[version] = Object.fromEntries(TEMPLATES.map((name) => [
  name,
  createHash('sha256').update(readFileSync(join(ROOT, 'templates/workflows', name))).digest('hex'),
]));
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`stamped v${version} into templates/workflows/template-manifest.json`);
