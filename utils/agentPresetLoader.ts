import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';

const logger = createLogger('AgentPresetLoader');

/**
 * 同步加载 Agent 预设原始文本（从 agent-presets 目录）
 * - 兼容 AGENT_PRESET_FILE 未配置时默认使用 default.txt
 * - 若指定文件不存在，则回退到 default.txt
 *
 * @returns {{ fileName: string, path: string, isDefaultFallback: boolean, text: string, parsedJson: PresetJsonValue | null }}
 */
export function loadAgentPresetSync() {
  const presetFileName = getEnv('AGENT_PRESET_FILE', 'default.txt') || 'default.txt';
  const presetPath = path.join('./agent-presets', presetFileName);

  let usedPath = presetPath;
  let usedFileName = presetFileName;
  let isDefaultFallback = false;

  try {
    if (!fs.existsSync(presetPath)) {
      logger.warn(`预设文件不存在: ${presetPath}`);
      logger.warn('尝试使用默认预设: ./agent-presets/default.txt');

      const defaultPath = './agent-presets/default.txt';
      if (!fs.existsSync(defaultPath)) {
        throw new Error('默认预设文件 default.txt 也不存在，请检查 agent-presets 文件夹');
      }

      usedPath = defaultPath;
      usedFileName = 'default.txt';
      isDefaultFallback = true;
    }

    const content = fs.readFileSync(usedPath, 'utf8');
    logger.success(`成功加载 Agent 预设: ${usedFileName}${isDefaultFallback ? ' (fallback)' : ''}`);

    const parsedJson = tryParsePresetJson(content, usedFileName);

    return {
      fileName: usedFileName,
      path: usedPath,
      isDefaultFallback,
      text: content,
      parsedJson
    };
  } catch (error) {
    logger.error('加载 Agent 预设失败', error);
    throw error;
  }
}

/**
 * 尝试从原始文本中解析 JSON 角色卡
 * - 仅当首个非空字符为 { 或 [ 时才尝试 JSON.parse
 *
 * @param {string} text
 * @returns {PresetJsonValue | null}
 */
type PresetJsonValue = Record<string, unknown> | Array<Record<string, unknown> | string | number | boolean | null>;

export function tryParsePresetJson(text: string, fileName: string = ''): PresetJsonValue | null {
  if (!text || typeof text !== 'string') return null;

  const ext = String(fileName || '').toLowerCase();
  if (!ext.endsWith('.json')) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;

  const firstChar = trimmed[0];
  if (firstChar !== '{' && firstChar !== '[') {
    return null;
  }

  try {
    const obj = JSON.parse(trimmed);
    if (obj && (typeof obj === 'object' || Array.isArray(obj))) {
      return obj;
    }
    return null;
  } catch (e) {
    logger.warn('AgentPresetLoader: JSON.parse 失败，按纯文本处理', { err: String(e) });
    return null;
  }
}

/**
 * 仅返回原始预设文本（向后兼容旧逻辑）
 *
 * @returns {string}
 */
export function loadAgentPresetText() {
  const { text } = loadAgentPresetSync();
  return text || '';
}
