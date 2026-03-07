import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
export const ARTIFACTS_DIRNAME = 'artifacts';
export const ARTIFACTS_ROOT = path.join(PROJECT_ROOT, ARTIFACTS_DIRNAME);

export function normalizeLineEndings(input) {
  return String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(',')}}`;
}

export function sha256FromBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256FromText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function decodeUtf8IfPossible(buffer) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(buffer);
    // NUL byte usually indicates binary payload.
    if (text.includes('\u0000')) return null;
    return text;
  } catch {
    return null;
  }
}

function normalizeJsonIfPossible(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return stableStringify(parsed);
  } catch {
    return null;
  }
}

function toRelativeProjectPath(filePath) {
  const absPath = path.resolve(String(filePath || ''));
  const rel = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, '/');
  return rel;
}

export function buildArtifactId(prefix = 'art') {
  return `${String(prefix || 'art').replace(/[^a-zA-Z0-9_-]/g, '') || 'art'}_${randomUUID().replace(/-/g, '')}`;
}

export async function hashFile(filePath, options = {}) {
  const absPath = path.resolve(String(filePath || ''));
  const preferTextNormalization = options.preferTextNormalization !== false;
  const raw = await fs.readFile(absPath);
  const stat = await fs.stat(absPath);

  let normalizedHash = null;
  let mode = 'binary';

  if (preferTextNormalization) {
    const utf8Text = decodeUtf8IfPossible(raw);
    if (utf8Text !== null) {
      const normalizedJson = normalizeJsonIfPossible(utf8Text);
      if (normalizedJson !== null) {
        normalizedHash = sha256FromText(normalizedJson);
        mode = 'json-stable';
      } else {
        normalizedHash = sha256FromText(normalizeLineEndings(utf8Text));
        mode = 'text-eol';
      }
    }
  }

  return {
    absPath,
    relPath: toRelativeProjectPath(absPath),
    size: Number(stat.size || 0),
    mtimeMs: Number(stat.mtimeMs || 0),
    hash: normalizedHash || sha256FromBuffer(raw),
    hashMode: mode,
  };
}

export async function ensureDir(dirPath) {
  await fs.mkdir(path.resolve(String(dirPath || '')), { recursive: true });
}
