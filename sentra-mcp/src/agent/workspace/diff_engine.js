import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, PROJECT_ROOT, ARTIFACTS_DIRNAME } from './hash.js';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'coverage',
  'logs',
]);

const DEFAULT_IGNORED_PREFIXES = [
  `${ARTIFACTS_DIRNAME}/`,
  `${ARTIFACTS_DIRNAME}/runs/`,
  `${ARTIFACTS_DIRNAME}/index/`,
  `${ARTIFACTS_DIRNAME}/runtime/`,
  'runs/',
  'index/',
  'runtime/',
];

const DEFAULT_IGNORED_FILE_PATTERNS = [
  /\.bak_\d{8}_\d+$/i,
  /\.tmp$/i,
  /\.temp$/i,
  /\.swp$/i,
  /\.swo$/i,
  /~$/,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function normalizePrefixVariants(prefix) {
  const p0 = String(prefix || '').replace(/^\/+/, '');
  if (!p0) return [];
  const out = new Set([p0]);
  const basePrefix = `${ARTIFACTS_DIRNAME}/`;
  if (p0.startsWith(basePrefix)) {
    const withoutBase = p0.slice(basePrefix.length);
    if (withoutBase) out.add(withoutBase);
  }
  return Array.from(out);
}

function shouldIgnore(relPath, options = {}) {
  const rel = toPosix(relPath);
  if (!rel || rel === '.' || rel === '/') return true;
  const cleanRel = rel.replace(/^\/+/, '');

  for (const prefix of DEFAULT_IGNORED_PREFIXES) {
    for (const p of normalizePrefixVariants(prefix)) {
      const noSlash = p.endsWith('/') ? p.slice(0, -1) : p;
      if (cleanRel === noSlash || cleanRel.startsWith(p)) return true;
    }
  }

  const parts = cleanRel.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    if (DEFAULT_IGNORED_DIRS.has(part)) return true;
  }

  const base = parts[parts.length - 1] || '';
  for (const re of DEFAULT_IGNORED_FILE_PATTERNS) {
    if (re.test(base)) return true;
  }

  const extraIgnoredGlobs = Array.isArray(options.ignoreGlobs) ? options.ignoreGlobs : [];
  if (extraIgnoredGlobs.some((g) => rel.includes(String(g).replace(/\*/g, '')))) return true;

  return false;
}

async function walkFiles(rootDir, options, out) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const ent of entries) {
    const absPath = path.join(rootDir, ent.name);
    const relPath = toPosix(path.relative(options.rootDir, absPath));
    if (shouldIgnore(relPath, options)) continue;
    if (ent.isDirectory()) {
      await walkFiles(absPath, options, out);
      continue;
    }
    if (!ent.isFile()) continue;
    out.push(absPath);
  }
}

function asMap(snapshot) {
  const map = new Map();
  for (const f of snapshot.files || []) {
    map.set(String(f.relPath || ''), f);
  }
  return map;
}

export async function createWorkspaceSnapshot(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || PROJECT_ROOT));
  const files = [];
  await walkFiles(rootDir, { ...options, rootDir }, files);

  const hashed = [];
  for (const absPath of files) {
    try {
      const info = await hashFile(absPath, { preferTextNormalization: true });
      const relPath = toPosix(path.relative(rootDir, absPath));
      hashed.push({
        relPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        hash: info.hash,
        hashMode: info.hashMode,
      });
    } catch {
      // Ignore files that disappear between read and hash.
    }
  }

  hashed.sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)));

  return {
    rootDir: toPosix(rootDir),
    createdAt: Date.now(),
    fileCount: hashed.length,
    files: hashed,
  };
}

export function diffWorkspaceSnapshots(previousSnapshot, nextSnapshot) {
  const prev = asMap(previousSnapshot || { files: [] });
  const next = asMap(nextSnapshot || { files: [] });

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [relPath, n] of next.entries()) {
    const p = prev.get(relPath);
    if (!p) {
      added.push({ relPath, next: n });
      continue;
    }
    if (p.hash !== n.hash || Number(p.size) !== Number(n.size)) {
      changed.push({ relPath, prev: p, next: n });
      continue;
    }
    unchanged.push({ relPath, current: n });
  }

  for (const [relPath, p] of prev.entries()) {
    if (!next.has(relPath)) {
      removed.push({ relPath, prev: p });
    }
  }

  const byPath = (a, b) => String(a.relPath || '').localeCompare(String(b.relPath || ''));
  added.sort(byPath);
  removed.sort(byPath);
  changed.sort(byPath);
  unchanged.sort(byPath);

  return {
    rootDir: String(nextSnapshot?.rootDir || previousSnapshot?.rootDir || ''),
    comparedAt: Date.now(),
    added,
    removed,
    changed,
    unchanged,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      totalDelta: added.length + removed.length + changed.length,
    }
  };
}

export async function snapshotAndDiff(options = {}) {
  const nextSnapshot = await createWorkspaceSnapshot(options);
  const previousSnapshot = options.previousSnapshot || null;
  const diff = diffWorkspaceSnapshots(previousSnapshot, nextSnapshot);
  return { previousSnapshot, nextSnapshot, diff };
}
