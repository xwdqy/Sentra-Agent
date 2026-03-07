import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('PresetTextToJson');

type PresetMeta = {
  node_name?: string;
  category?: string;
  description?: string;
  version?: string;
  author?: string;
  [key: string]: unknown;
};

type PresetRuleCondition = { type: 'text'; value: string };
type PresetRule = {
  id?: string;
  enabled?: boolean;
  event?: string;
  conditions?: PresetRuleCondition[];
  behavior?: Record<string, string | string[]>;
  [key: string]: unknown;
};

type PresetJson = Record<string, unknown> & {
  meta?: PresetMeta;
  parameters?: Record<string, unknown>;
  rules?: PresetRule[];
};

function takePrefix(text: string, count: number): string {
  if (!text || count <= 0) return '';
  let out = '';
  const max = Math.min(text.length, count);
  for (let i = 0; i < max; i++) {
    out += text[i] || '';
  }
  return out;
}

function hashText(text: string): string | null {
  try {
    return createHash('sha1').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function getPresetCachePath(fileName: string | undefined): { cacheDir: string; cacheFile: string } {
  const baseDir = './agent-presets';
  const cacheDir = path.join(baseDir, '.cache');
  const safeName = (fileName || 'default.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheFile = path.join(cacheDir, `${safeName}.${takePrefix(hashText(safeName) || '', 12)}.json`);
  return { cacheDir, cacheFile };
}

function savePresetCache(presetJson: PresetJson, rawText: string | undefined, fileName?: string): void {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text || !presetJson || typeof presetJson !== 'object') return;

  const hash = hashText(text);
  if (!hash) return;

  const { cacheDir, cacheFile } = getPresetCachePath(fileName);
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const payload: { textHash: string; presetJson: PresetJson } = {
      textHash: hash,
      presetJson
    };
    fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    logger.warn('savePresetCacheForTeaching: write cache failed', { err: String(e) });
  }
}

export function savePresetCacheForTeaching(presetJson: Record<string, unknown>, rawText: string | undefined, fileName?: string): void {
  try {
    savePresetCache(presetJson, rawText, fileName);
  } catch (e) {
    logger.warn('savePresetCacheForTeaching: write cache failed', { err: String(e) });
  }
}

function normalizePresetJson(
  obj: PresetJson | null | undefined,
  { rawText, fileName }: { rawText?: string | undefined; fileName?: string | undefined } = {}
) {
  const safeFileName = fileName || 'AgentPreset';

  const base: PresetJson = obj && typeof obj === 'object' ? { ...obj } : {};
  const baseRecord = base as Record<string, unknown>;

  if (!base.meta || typeof base.meta !== 'object' || Array.isArray(base.meta)) {
    base.meta = {};
  }

  const meta = base.meta as PresetMeta;

  const nodeName = baseRecord['node_name'];
  const category = baseRecord['category'];
  const description = baseRecord['description'];
  const version = baseRecord['version'];
  const author = baseRecord['author'];

  if (!meta.node_name && typeof nodeName === 'string') meta.node_name = nodeName;
  if (!meta.category && typeof category === 'string') meta.category = category;
  if (!meta.description && typeof description === 'string') meta.description = description;
  if (!meta.version && typeof version === 'string') meta.version = version;
  if (!meta.author && typeof author === 'string') meta.author = author;

  if (!meta.node_name) meta.node_name = safeFileName;
  if (!meta.category) meta.category = 'agent_preset';
  if (!meta.description) {
    meta.description = rawText && String(rawText).trim()
      ? 'Agent preset loaded from json'
      : 'Agent preset';
  }

  if (!base.parameters || typeof base.parameters !== 'object' || Array.isArray(base.parameters)) {
    base.parameters = {};
  }

  if (!Array.isArray(base.rules)) {
    if (base.rules && typeof base.rules === 'object') {
      base.rules = [base.rules];
    } else {
      base.rules = [];
    }
  }
  return base;
}

export function normalizePresetJsonForRuntime(
  obj: unknown,
  options: { rawText?: string | undefined; fileName?: string | undefined } = {}
) {
  let inner: PresetJson | null | undefined = null;
  if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const presetJson = record['presetJson'];
    if (presetJson && typeof presetJson === 'object') {
      inner = presetJson as PresetJson;
    } else {
      inner = record as PresetJson;
    }
  }
  return normalizePresetJson(inner, options);
}
