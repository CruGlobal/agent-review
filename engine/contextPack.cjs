'use strict';

const {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');
const { Minimatch } = require('minimatch');

function validateContextManifest(raw) {
  if (!raw || raw.version !== 1) throw new Error('context manifest version must be 1');
  if (!Array.isArray(raw.repositories)) throw new Error('context manifest requires repositories');
  const ids = new Set();
  for (const repo of raw.repositories) {
    if (!repo.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(repo.id)) {
      throw new Error(`invalid context repository id: ${repo.id || ''}`);
    }
    if (ids.has(repo.id)) throw new Error(`duplicate context repository id: ${repo.id}`);
    ids.add(repo.id);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.repository || '')) {
      throw new Error(`invalid GitHub repository for context ${repo.id}`);
    }
    if (!/^[0-9a-f]{40}$/.test(repo.ref || '')) {
      throw new Error(`context ${repo.id} ref must be a full 40-character commit SHA`);
    }
    if (!Array.isArray(repo.paths) || repo.paths.length === 0) {
      throw new Error(`context ${repo.id} requires at least one path glob`);
    }
    if (repo.max_files != null && (!Number.isInteger(repo.max_files) || repo.max_files < 1 || repo.max_files > 500)) {
      throw new Error(`context ${repo.id} max_files must be 1..500`);
    }
    if (repo.max_bytes != null && (!Number.isInteger(repo.max_bytes) || repo.max_bytes < 1 || repo.max_bytes > 5_000_000)) {
      throw new Error(`context ${repo.id} max_bytes must be 1..5000000`);
    }
  }
  return raw;
}

function safeFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push({ path, size: st.size });
    }
  };
  walk(root);
  return out;
}

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${resolve(root)}${sep}..`);
}

function contextInventory(manifestInput, contextDir) {
  const manifest = validateContextManifest(manifestInput);
  const repositories = [];
  for (const repo of manifest.repositories) {
    const root = join(resolve(contextDir), repo.id);
    if (!within(contextDir, root)) throw new Error(`context path escapes root: ${repo.id}`);
    if (!existsSync(root)) {
      if (repo.required) throw new Error(`required context repository was not fetched: ${repo.id}`);
      repositories.push({
        id: repo.id,
        repository: repo.repository,
        ref: repo.ref,
        available: false,
        required: Boolean(repo.required),
        files: [],
      });
      continue;
    }
    const include = repo.paths.map((p) => new Minimatch(p, { dot: true }));
    const exclude = (repo.excluded_paths || []).map((p) => new Minimatch(p, { dot: true }));
    const maxFiles = repo.max_files || 100;
    const maxBytes = repo.max_bytes || 1_000_000;
    let bytes = 0;
    let truncated = false;
    const files = [];
    for (const item of safeFiles(root)) {
      const rel = relative(root, item.path).split(sep).join('/');
      if (!include.some((m) => m.match(rel)) || exclude.some((m) => m.match(rel))) continue;
      if (files.length >= maxFiles || bytes + item.size > maxBytes) {
        truncated = true;
        continue;
      }
      files.push({ path: rel, size: item.size });
      bytes += item.size;
    }
    let source = null;
    const sourcePath = join(root, '.agent-review-source.json');
    if (existsSync(sourcePath)) {
      try { source = JSON.parse(readFileSync(sourcePath, 'utf8')); } catch { source = null; }
    }
    repositories.push({
      id: repo.id,
      repository: repo.repository,
      ref: repo.ref,
      description: repo.description || '',
      available: true,
      required: Boolean(repo.required),
      root,
      files,
      bytes,
      truncated,
      source,
    });
  }
  return { version: 1, repositories };
}

function packContext(manifestInput, sourceDir, outputDir) {
  const manifest = validateContextManifest(manifestInput);
  const output = resolve(outputDir);
  const packStats = new Map();
  if (existsSync(output) && readdirSync(output).length > 0) {
    throw new Error(`refusing to overwrite non-empty context pack: ${output}`);
  }
  mkdirSync(output, { recursive: true });
  for (const repo of manifest.repositories) {
    const sourceRoot = join(resolve(sourceDir), repo.id);
    if (!existsSync(sourceRoot)) {
      if (repo.required) throw new Error(`required context repository was not fetched: ${repo.id}`);
      continue;
    }
    const include = repo.paths.map((p) => new Minimatch(p, { dot: true }));
    const exclude = (repo.excluded_paths || []).map((p) => new Minimatch(p, { dot: true }));
    const maxFiles = repo.max_files || 100;
    const maxBytes = repo.max_bytes || 1_000_000;
    let count = 0;
    let bytes = 0;
    let matchedFiles = 0;
    let truncated = false;
    for (const item of safeFiles(sourceRoot)) {
      const rel = relative(sourceRoot, item.path).split(sep).join('/');
      if (!include.some((m) => m.match(rel)) || exclude.some((m) => m.match(rel))) continue;
      matchedFiles++;
      if (count >= maxFiles || bytes + item.size > maxBytes) {
        truncated = true;
        continue;
      }
      const target = join(output, repo.id, rel);
      if (!within(join(output, repo.id), target)) throw new Error(`context file escapes pack: ${rel}`);
      mkdirSync(require('node:path').dirname(target), { recursive: true });
      copyFileSync(item.path, target);
      count++;
      bytes += item.size;
    }
    const sourceMeta = join(sourceRoot, '.agent-review-source.json');
    if (existsSync(sourceMeta)) {
      mkdirSync(join(output, repo.id), { recursive: true });
      copyFileSync(sourceMeta, join(output, repo.id, '.agent-review-source.json'));
    }
    packStats.set(repo.id, { matchedFiles, truncated });
  }
  const inventory = contextInventory(manifest, output);
  for (const repo of inventory.repositories) {
    const stats = packStats.get(repo.id);
    if (!stats) continue;
    repo.sourceMatchedFiles = stats.matchedFiles;
    repo.truncated = repo.truncated || stats.truncated;
  }
  return inventory;
}

module.exports = { validateContextManifest, safeFiles, contextInventory, packContext };
