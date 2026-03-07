import fs from 'node:fs/promises';
import path from 'node:path';
import { buildArtifactId, ensureDir, hashFile, PROJECT_ROOT, ARTIFACTS_ROOT } from './hash.js';

const RUNTIME_DIR = path.join(ARTIFACTS_ROOT, 'runtime');
const RUNS_DIR = path.join(RUNTIME_DIR, 'runs');
let runsDirInitPromise = null;

function sanitizeId(raw, fallback = '') {
  const cleaned = String(raw || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || fallback;
}

function toAbsPathUnderProject(rawPath) {
  if (!rawPath) return null;
  const input = String(rawPath).trim();
  if (!input) return null;
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(PROJECT_ROOT, input);
  return abs;
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeMetadata(v, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'relPath' || k === 'rel_path') continue;
    out[k] = sanitizeMetadata(v, depth + 1);
  }
  return out;
}

function runDir(runId) {
  return path.join(RUNS_DIR, sanitizeId(runId, 'unknown'));
}

function runRegistryPath(runId) {
  return path.join(runDir(runId), 'registry.json');
}

async function ensureRunsDirReady() {
  if (!runsDirInitPromise) {
    runsDirInitPromise = (async () => {
      await ensureDir(RUNS_DIR);
    })().catch((err) => {
      runsDirInitPromise = null;
      throw err;
    });
  }
  await runsDirInitPromise;
}

async function readRunRegistry(runId) {
  await ensureRunsDirReady();
  const file = runRegistryPath(runId);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.artifacts)) {
      return {
        runId: sanitizeId(parsed?.runId, sanitizeId(runId, 'unknown')),
        updatedAt: Number(parsed?.updatedAt || Date.now()),
        artifacts: parsed.artifacts.map((a) => toPublicArtifactRecord(a)).filter(Boolean)
      };
    }
  } catch {
    // Ignore and use empty registry.
  }
  return { runId: sanitizeId(runId, 'unknown'), updatedAt: Date.now(), artifacts: [] };
}

async function writeRunRegistry(runId, payload) {
  await ensureRunsDirReady();
  await ensureDir(runDir(runId));
  const file = runRegistryPath(runId);
  const body = {
    runId: sanitizeId(runId, 'unknown'),
    updatedAt: Date.now(),
    artifacts: Array.isArray(payload?.artifacts)
      ? payload.artifacts.map((a) => toPublicArtifactRecord(a)).filter(Boolean)
      : [],
  };
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
  return body;
}

function toPublicArtifactRecord(raw = {}) {
  const item = (raw && typeof raw === 'object') ? raw : {};
  const absPathRaw = item.absPath || item.path || item.filePath || item.workspacePath;
  const absPath = absPathRaw ? path.resolve(String(absPathRaw)) : null;
  return {
    artifactId: sanitizeId(item.artifactId, 'art_unknown'),
    runId: sanitizeId(item.runId, 'unknown'),
    stepId: sanitizeId(item.stepId, ''),
    branchId: sanitizeId(item.branchId, ''),
    type: String(item.type || 'file'),
    role: String(item.role || ''),
    source: String(item.source || 'runtime'),
    absPath,
    hash: String(item.hash || ''),
    hashMode: String(item.hashMode || ''),
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
    dependsOn: Array.from(new Set((Array.isArray(item.dependsOn) ? item.dependsOn : []).map((x) => String(x || '').trim()).filter(Boolean))),
    summary: String(item.summary || ''),
    metadata: sanitizeMetadata((item.metadata && typeof item.metadata === 'object') ? item.metadata : {}),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
  };
}

async function maybeMaterializeContent(runId, artifactId, record) {
  if (record == null || (!('content' in record) && !('text' in record) && !('json' in record))) {
    return null;
  }

  const objectsDir = path.join(runDir(runId), 'objects');
  await ensureDir(objectsDir);

  let ext = '.txt';
  let data = '';

  if ('json' in record) {
    ext = '.json';
    data = JSON.stringify(record.json, null, 2);
  } else if ('content' in record) {
    if (typeof record.content === 'string') {
      ext = '.txt';
      data = record.content;
    } else {
      ext = '.json';
      data = JSON.stringify(record.content, null, 2);
    }
  } else if ('text' in record) {
    ext = '.txt';
    data = String(record.text || '');
  }

  const filePath = path.join(objectsDir, `${artifactId}${ext}`);
  await fs.writeFile(filePath, data, 'utf8');
  return filePath;
}

export function getArtifactProjectRoot() {
  return PROJECT_ROOT;
}

export function getArtifactRootDir() {
  return ARTIFACTS_ROOT;
}

export async function upsertArtifact(record = {}) {
  const runId = sanitizeId(record.runId, '');
  if (!runId) {
    throw new Error('upsertArtifact requires runId');
  }

  const registry = await readRunRegistry(runId);
  const now = Date.now();
  const artifactId = sanitizeId(record.artifactId, buildArtifactId('art'));

  let absPath = toAbsPathUnderProject(record.path || record.filePath || record.workspacePath);
  if (!absPath) {
    absPath = await maybeMaterializeContent(runId, artifactId, record);
  }

  let hash = null;
  let size = null;
  let hashMode = null;
  if (absPath) {
    try {
      const info = await hashFile(absPath, { preferTextNormalization: true });
      hash = info.hash;
      size = info.size;
      hashMode = info.hashMode;
    } catch {
      // Keep best-effort fallback without failing insertion.
    }
  }

  const next = {
    artifactId,
    runId,
    stepId: sanitizeId(record.stepId, ''),
    branchId: sanitizeId(record.branchId, ''),
    type: String(record.type || 'file'),
    role: String(record.role || ''),
    source: String(record.source || 'runtime'),
    absPath: absPath ? path.resolve(absPath) : null,
    hash: hash || String(record.hash || ''),
    hashMode: hashMode || String(record.hashMode || ''),
    size: Number.isFinite(Number(size)) ? Number(size) : (Number.isFinite(Number(record.size)) ? Number(record.size) : null),
    dependsOn: Array.from(new Set((Array.isArray(record.dependsOn) ? record.dependsOn : []).map((x) => String(x || '').trim()).filter(Boolean))),
    summary: String(record.summary || ''),
    metadata: sanitizeMetadata((record.metadata && typeof record.metadata === 'object') ? record.metadata : {}),
    createdAt: now,
    updatedAt: now,
  };

  const idx = registry.artifacts.findIndex((x) => String(x?.artifactId || '') === artifactId);
  if (idx >= 0) {
    next.createdAt = Number(registry.artifacts[idx]?.createdAt || now);
    registry.artifacts[idx] = { ...registry.artifacts[idx], ...next, updatedAt: now };
  } else {
    registry.artifacts.push(next);
  }

  await writeRunRegistry(runId, registry);
  return toPublicArtifactRecord(next);
}

export async function listArtifacts(runId, stepId = null) {
  const rid = sanitizeId(runId, '');
  if (!rid) return [];
  const registry = await readRunRegistry(rid);
  const all = Array.isArray(registry.artifacts) ? registry.artifacts : [];
  if (!stepId) return all.map((x) => toPublicArtifactRecord(x));
  const sid = sanitizeId(stepId, '');
  return all.filter((x) => String(x?.stepId || '') === sid).map((x) => toPublicArtifactRecord(x));
}

export async function queryByDeps(options = {}) {
  const runId = sanitizeId(options.runId, '');
  if (!runId) return [];
  const deps = Array.from(new Set((Array.isArray(options.deps) ? options.deps : []).map((x) => String(x || '').trim()).filter(Boolean)));
  const stepId = sanitizeId(options.stepId, '');
  const type = String(options.type || '').trim();
  const source = String(options.source || '').trim();
  const branchId = sanitizeId(options.branchId, '');
  const limit = Math.max(1, Number(options.limit || 200));

  const all = await listArtifacts(runId);
  let filtered = all;

  if (stepId) filtered = filtered.filter((x) => String(x?.stepId || '') === stepId);
  if (type) filtered = filtered.filter((x) => String(x?.type || '') === type);
  if (source) filtered = filtered.filter((x) => String(x?.source || '') === source);
  if (branchId) filtered = filtered.filter((x) => String(x?.branchId || '') === branchId);
  if (deps.length > 0) {
    filtered = filtered.filter((x) => {
      const d = Array.isArray(x?.dependsOn) ? x.dependsOn : [];
      return d.some((v) => deps.includes(String(v)));
    });
  }

  filtered.sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  return filtered.slice(0, limit).map((x) => toPublicArtifactRecord(x));
}
