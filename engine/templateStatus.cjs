'use strict';
const { createHash } = require('node:crypto');

const TEMPLATE_NAMES = Object.freeze([
  'agent-review.yml',
  'agent-review-interact.yml',
  'agent-review-readiness.yml',
  'agent-review-approve.yml',
]);
const MARKER_LINE = /^# agent-review-template-version: (\d+\.\d+\.\d+)$/m;
const NO_MARKER = 'pre-0.3.0';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readMarker(text) {
  const m = typeof text === 'string' ? text.match(MARKER_LINE) : null;
  return m ? m[1] : null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// The manifest pins every released template's sha256 under its version, marker line included.
// Putting an older marker on today's template rebuilds that release byte for byte exactly when
// nothing but the marker changed since, so its hash is the released one.
function unchangedSince({ manifest, name, version, templateText }) {
  const released = manifest?.[version]?.[name];
  if (typeof released !== 'string') return false;
  const rebuilt = templateText.replace(MARKER_LINE, `# agent-review-template-version: ${version}`);
  return sha256(rebuilt) === released;
}

// A copied workflow file counts as current when its marker is at or ahead of the plugin, or when
// the template it was copied from has not changed apart from the marker since that version. The
// repo's own copy is never compared: it carries its own settings.
function templateFileStatus({ name, fileText, pluginVersion, manifest, templates }) {
  const marker = readMarker(fileText);
  const result = (status, reason) => ({ template: TEMPLATE_NAMES.includes(name) ? name : null, marker, status, reason });
  if (!marker) return result('stale', 'no template marker');
  if (compareVersions(marker, pluginVersion) >= 0) return result('current', `marker v${marker} is not older than v${pluginVersion}`);
  if (!TEMPLATE_NAMES.includes(name)) {
    return result('stale', `marker v${marker} is older than v${pluginVersion}, and ${name} is not one of the template files`);
  }
  const templateText = templates?.[name];
  if (typeof templateText !== 'string') {
    return result('stale', `marker v${marker} is older than v${pluginVersion}, and the ${name} template could not be read`);
  }
  if (manifest?.[pluginVersion]?.[name] !== sha256(templateText)) {
    return result('stale', `marker v${marker} is older than v${pluginVersion}, and the manifest does not match the v${pluginVersion} template, so its history cannot be checked`);
  }
  if (unchangedSince({ manifest, name, version: marker, templateText })) {
    return result('current', `the template is unchanged since v${marker} apart from its marker`);
  }
  if (!manifest?.[marker]?.[name]) {
    return result('stale', `marker v${marker} is older than v${pluginVersion}, and the manifest has no v${marker} entry for ${name}`);
  }
  return result('stale', `the template changed after v${marker}`);
}

function templateStatusReport({ files, pluginVersion, manifest, templates }) {
  const checked = files.map(({ file, name, text }) => ({
    file,
    ...templateFileStatus({ name, fileText: text, pluginVersion, manifest, templates }),
  }));
  const stale = checked.filter((f) => f.status === 'stale');
  let oldest = null;
  for (const f of stale) {
    if (!f.marker) {
      oldest = NO_MARKER;
      break;
    }
    if (oldest === null || compareVersions(f.marker, oldest) < 0) oldest = f.marker;
  }
  return { version: pluginVersion, stale: stale.length > 0, oldest, files: checked };
}

module.exports = {
  TEMPLATE_NAMES,
  NO_MARKER,
  readMarker,
  compareVersions,
  unchangedSince,
  templateFileStatus,
  templateStatusReport,
};
