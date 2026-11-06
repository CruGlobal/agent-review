'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const {
  TEMPLATE_NAMES,
  readMarker,
  compareVersions,
  templateFileStatus,
  templateStatusReport,
} = require('./templateStatus.cjs');

const ROOT = join(__dirname, '..');
const CLI = join(__dirname, 'cli.cjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const stamp = (version, body) => `# agent-review-template-version: ${version}\n${body}`;

const BODY_A = 'name: agent-review\non: pull_request\njobs: {}\n';
const BODY_B = 'name: agent-review\non: [pull_request, push]\njobs: {}\n';

// 1.0.0 and 1.1.0 ship BODY_A, 1.2.0 changes it to BODY_B, and 1.3.0 changes only the marker.
function history() {
  const releases = { '1.0.0': BODY_A, '1.1.0': BODY_A, '1.2.0': BODY_B, '1.3.0': BODY_B };
  const manifest = {};
  for (const [version, body] of Object.entries(releases)) {
    manifest[version] = { 'agent-review.yml': sha(stamp(version, body)) };
  }
  return { manifest, templates: { 'agent-review.yml': stamp('1.3.0', BODY_B) } };
}

function status(fileText, over = {}) {
  return templateFileStatus({ name: 'agent-review.yml', fileText, pluginVersion: '1.3.0', ...history(), ...over });
}

test('a copy whose older marker names a release with the same template apart from the marker is current', () => {
  const r = status(stamp('1.2.0', 'name: agent-review\n  # the repo keeps its own settings\n'));
  assert.equal(r.status, 'current');
  assert.equal(r.marker, '1.2.0');
  assert.equal(r.reason, 'the template is unchanged since v1.2.0 apart from its marker');
});

test('a copy whose marker is older than a real template change is stale', () => {
  for (const marker of ['1.0.0', '1.1.0']) {
    const r = status(stamp(marker, BODY_A));
    assert.equal(r.status, 'stale', marker);
    assert.equal(r.reason, `the template changed after v${marker}`);
  }
});

test('a copy with no marker is stale', () => {
  const r = status(BODY_B);
  assert.equal(r.status, 'stale');
  assert.equal(r.marker, null);
  assert.equal(r.reason, 'no template marker');
});

test('the repo copy is never compared byte for byte', () => {
  assert.equal(status(stamp('1.3.0', 'anything at all\n')).status, 'current');
  assert.equal(status(stamp('1.2.0', BODY_A)).status, 'current', 'the history decides, not the copy');
});

test('a marker at or ahead of the plugin is current, as before', () => {
  assert.equal(status(stamp('1.3.0', BODY_B)).status, 'current');
  assert.equal(status(stamp('2.0.0', BODY_B)).status, 'current');
});

test('a marker with no manifest entry is stale', () => {
  const r = status(stamp('0.9.0', BODY_B));
  assert.equal(r.status, 'stale');
  assert.match(r.reason, /no v0\.9\.0 entry/);
});

test('history is not trusted when the manifest does not match the current template', () => {
  const { manifest, templates } = history();
  const edited = { 'agent-review.yml': `${templates['agent-review.yml']}# edited without a restamp\n` };
  const r = status(stamp('1.2.0', BODY_B), { manifest, templates: edited });
  assert.equal(r.status, 'stale');
  assert.match(r.reason, /history cannot be checked/);
});

test('a file that is not one of the templates keeps the older-than rule', () => {
  const r = templateFileStatus({ name: 'agent-review-extra.yml', fileText: stamp('1.2.0', BODY_B), pluginVersion: '1.3.0', ...history() });
  assert.equal(r.status, 'stale');
  assert.equal(r.template, null);
  assert.equal(templateFileStatus({ name: 'agent-review-extra.yml', fileText: stamp('1.3.0', ''), pluginVersion: '1.3.0', ...history() }).status, 'current');
});

test('the report names the oldest stale marker, and pre-0.3.0 for a missing one', () => {
  const files = (texts) => texts.map((text, i) => ({ file: `f${i}`, name: 'agent-review.yml', text }));
  const base = { pluginVersion: '1.3.0', ...history() };
  assert.deepEqual(
    (({ stale, oldest }) => ({ stale, oldest }))(templateStatusReport({ ...base, files: files([stamp('1.2.0', ''), stamp('1.3.0', '')]) })),
    { stale: false, oldest: null },
  );
  assert.equal(templateStatusReport({ ...base, files: files([stamp('1.1.0', ''), stamp('1.0.0', ''), stamp('1.2.0', '')]) }).oldest, '1.0.0');
  assert.equal(templateStatusReport({ ...base, files: files([stamp('1.1.0', ''), BODY_A]) }).oldest, 'pre-0.3.0');
  assert.equal(templateStatusReport({ ...base, files: files([null]) }).files[0].status, 'stale', 'an unreadable copy is stale');
});

test('readMarker and compareVersions', () => {
  assert.equal(readMarker(stamp('1.10.2', '')), '1.10.2');
  assert.equal(readMarker('#agent-review-template-version: 1.0.0\n'), null);
  assert.equal(readMarker(null), null);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.4', '1.1.4'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
});

function cliRepo(files) {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-template-status-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.github/workflows', name), text);
  return root;
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, '--root', root, 'template-status', ...args], { encoding: 'utf8' });
  return { code: r.status, json: r.status === 0 ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

test('template-status reads the repo copies against fetched templates and a fetched manifest', () => {
  const root = cliRepo({ 'agent-review.yml': stamp('1.2.0', 'repo settings\n'), 'agent-review-approve.yml': stamp('1.0.0', '') });
  const fetched = mkdtempSync(join(os.tmpdir(), 'ar-template-fetched-'));
  try {
    const { manifest, templates } = history();
    manifest['1.3.0']['agent-review-approve.yml'] = sha(stamp('1.3.0', BODY_A));
    manifest['1.0.0']['agent-review-approve.yml'] = sha(stamp('1.0.0', BODY_B));
    writeFileSync(join(fetched, 'template-manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(fetched, 'agent-review.yml'), templates['agent-review.yml']);
    writeFileSync(join(fetched, 'agent-review-approve.yml'), stamp('1.3.0', BODY_A));
    const r = cli(root, ['--templates', fetched, '--version', '1.3.0']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version, '1.3.0');
    assert.equal(r.json.stale, true);
    assert.equal(r.json.oldest, '1.0.0');
    assert.deepEqual(
      r.json.files.map(({ file, status }) => [file, status]),
      [
        ['.github/workflows/agent-review-approve.yml', 'stale'],
        ['.github/workflows/agent-review.yml', 'current'],
      ],
    );
    const one = cli(root, ['--templates', fetched, '--version', '1.3.0', '.github/workflows/agent-review.yml']);
    assert.deepEqual(one.json.files.map((f) => f.status), ['current'], 'named files replace the default scan');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fetched, { recursive: true, force: true });
  }
});

test('template-status with no workflow copies reports none, and refuses bad input', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'ar-template-none-'));
  try {
    const r = cli(root, []);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual({ stale: r.json.stale, oldest: r.json.oldest, files: r.json.files }, { stale: false, oldest: null, files: [] });
    for (const bad of [['--version'], ['--version', 'v1.2'], ['--templates'], ['--bogus']]) {
      const refused = cli(root, bad);
      assert.equal(refused.code, 1, bad.join(' '));
      assert.match(refused.stdout, /^usage: agent-review template-status/, bad.join(' '));
    }
    const unreadable = cli(root, ['--manifest', join(root, 'missing.json')]);
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stderr, /^template-status: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with the shipped manifest, a copy of every template stamped with the previous release is judged by that release hash', () => {
  const pluginVersion = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
  const manifest = JSON.parse(readFileSync(join(ROOT, 'templates/workflows/template-manifest.json'), 'utf8'));
  const previous = Object.keys(manifest)
    .filter((v) => compareVersions(v, pluginVersion) < 0)
    .sort(compareVersions)
    .at(-1);
  const copies = {};
  for (const name of TEMPLATE_NAMES) {
    copies[name] = readFileSync(join(ROOT, 'templates/workflows', name), 'utf8').replace(
      /^# agent-review-template-version: .*$/m,
      `# agent-review-template-version: ${previous}`,
    );
  }
  const root = cliRepo(copies);
  try {
    const r = cli(root, []);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version, pluginVersion);
    for (const f of r.json.files) {
      const unchanged = manifest[previous][f.template] === sha(copies[f.template]);
      assert.equal(f.status, unchanged ? 'current' : 'stale', `${f.template} at v${previous}: ${f.reason}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
