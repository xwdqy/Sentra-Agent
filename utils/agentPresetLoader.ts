import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';

const logger = createLogger('AgentPresetLoader');

type PresetJsonValue =
  | Record<string, unknown>
  | Array<Record<string, unknown> | string | number | boolean | null>;

function resolveFallbackPresetPath(presetDir: string): { fileName: string; fullPath: string } | null {
  const candidates = ['default.txt', 'default.md', 'default.json'];
  for (const fileName of candidates) {
    const fullPath = path.join(presetDir, fileName);
    if (!fs.existsSync(fullPath)) continue;
    return { fileName, fullPath };
  }
  return null;
}

export function loadAgentPresetSync() {
  const presetDir = './agent-presets';
  const presetFileName = getEnv('AGENT_PRESET_FILE', 'default.txt') || 'default.txt';
  const presetPath = path.join(presetDir, presetFileName);

  let usedPath = presetPath;
  let usedFileName = presetFileName;
  let isDefaultFallback = false;

  try {
    if (!fs.existsSync(presetPath)) {
      logger.warn(`preset file not found: ${presetPath}`);
      const fallback = resolveFallbackPresetPath(presetDir);
      if (!fallback) {
        throw new Error('preset fallback not found: default.txt/default.md/default.json');
      }
      usedPath = fallback.fullPath;
      usedFileName = fallback.fileName;
      isDefaultFallback = true;
      logger.warn(`fallback preset selected: ${usedPath}`);
    }

    const content = fs.readFileSync(usedPath, 'utf8');
    logger.success(`preset loaded: ${usedFileName}${isDefaultFallback ? ' (fallback)' : ''}`);

    const parsedJson = tryParsePresetJson(content, usedFileName);

    return {
      fileName: usedFileName,
      path: usedPath,
      isDefaultFallback,
      text: content,
      parsedJson
    };
  } catch (error) {
    logger.error('load preset failed', error);
    throw error;
  }
}

export function tryParsePresetJson(text: string, fileName: string = ''): PresetJsonValue | null {
  if (!text || typeof text !== 'string') return null;
  const ext = String(fileName || '').toLowerCase();
  if (!ext.endsWith('.json')) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;
  const firstChar = trimmed[0];
  if (firstChar !== '{' && firstChar !== '[') return null;

  try {
    const obj = JSON.parse(trimmed);
    if (obj && (typeof obj === 'object' || Array.isArray(obj))) {
      return obj;
    }
    return null;
  } catch (e) {
    logger.warn('preset json parse failed, fallback to plain text', { err: String(e) });
    return null;
  }
}

export function loadAgentPresetText() {
  const { text } = loadAgentPresetSync();
  return text || '';
}
