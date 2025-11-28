import { extractJsonSync } from '@axync/extract-json';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('PresetTextToJson');

function hashText(text) {
  try {
    return createHash('sha1').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function getPresetCachePath(fileName) {
  const baseDir = './agent-presets';
  const cacheDir = path.join(baseDir, '.cache');
  const safeName = (fileName || 'default.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheFile = path.join(cacheDir, `${safeName}.json`);
  return { cacheDir, cacheFile };
}

function tryLoadPresetCache(rawText, fileName) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text) return null;

  const hash = hashText(text);
  if (!hash) return null;

  const { cacheFile } = getPresetCachePath(fileName);
  if (!fs.existsSync(cacheFile)) return null;

  try {
    const content = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return null;
    if (data.textHash !== hash) return null;
    if (!data.presetJson || typeof data.presetJson !== 'object') return null;
    logger.info('convertPresetTextToJson: 命中本地缓存，跳过 LLM 转换', { fileName });
    return data.presetJson;
  } catch (e) {
    logger.warn('convertPresetTextToJson: 读取缓存失败，将忽略缓存', { err: String(e) });
    return null;
  }
}

function savePresetCache(presetJson, rawText, fileName) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text || !presetJson || typeof presetJson !== 'object') return;

  const hash = hashText(text);
  if (!hash) return;

  const { cacheDir, cacheFile } = getPresetCachePath(fileName);
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const payload = {
      textHash: hash,
      presetJson
    };
    fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf8');
    logger.info('convertPresetTextToJson: 已写入本地缓存', { fileName, cacheFile });
  } catch (e) {
    logger.warn('convertPresetTextToJson: 写入缓存失败', { err: String(e) });
  }
}

export function savePresetCacheForTeaching(presetJson, rawText, fileName) {
  try {
    savePresetCache(presetJson, rawText, fileName);
  } catch (e) {
    logger.warn('savePresetCacheForTeaching: 写入缓存失败', { err: String(e) });
  }
}

function normalizePresetJson(obj, { rawText, fileName } = {}) {
  const safeFileName = fileName || 'AgentPreset';

  let base = obj && typeof obj === 'object' ? { ...obj } : {};

  if (!base.meta || typeof base.meta !== 'object') {
    base.meta = {};
  }

  const meta = base.meta;

  if (!meta.node_name && typeof base.node_name === 'string') meta.node_name = base.node_name;
  if (!meta.category && typeof base.category === 'string') meta.category = base.category;
  if (!meta.description && typeof base.description === 'string') meta.description = base.description;
  if (!meta.version && typeof base.version === 'string') meta.version = base.version;
  if (!meta.author && typeof base.author === 'string') meta.author = base.author;

  if (!meta.node_name) meta.node_name = safeFileName;
  if (!meta.category) meta.category = 'agent_preset';
  if (!meta.description) meta.description = 'Agent 角色预设（由文本自动转换为 JSON）';

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

export function normalizePresetJsonForRuntime(obj, options = {}) {
  let inner = obj;
  if (inner && typeof inner === 'object') {
    if (inner.presetJson && typeof inner.presetJson === 'object') {
      inner = inner.presetJson;
    }
  }
  return normalizePresetJson(inner, options);
}

/**
 * 使用专门的轻量模型，将 .txt/.md 形式的角色预设转换为结构化 JSON 角色卡
 *
 * @param {Object} params
 * @param {import('../agent.js').Agent} params.agent - 已初始化的 Agent 实例
 * @param {string} params.rawText - 原始预设文本（中文/Markdown）
 * @param {string} [params.fileName] - 预设文件名（用于 meta.node_name 标记）
 * @param {string} [params.model] - 可选：覆盖使用的模型名称
 * @returns {Promise<{ presetJson: any, rawText: string }>}
 */
export async function convertPresetTextToJson({ agent, rawText, fileName, model } = {}) {
  if (!agent || typeof agent.chat !== 'function') {
    throw new Error('convertPresetTextToJson: 需要传入带 chat(messages, options) 方法的 agent 实例');
  }

  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) {
    logger.warn('convertPresetTextToJson: 预设文本为空，返回空 JSON');
    return {
      presetJson: normalizePresetJson({}, { rawText: '', fileName }),
      rawText: ''
    };
  }

  const cacheJson = tryLoadPresetCache(text, fileName);
  if (cacheJson) {
    const normalizedFromCache = normalizePresetJson(cacheJson, { rawText: text, fileName });
    return {
      presetJson: normalizedFromCache,
      rawText: text
    };
  }

  const systemPrompt = [
    'You are an AI specialized in converting Chinese agent persona presets into a structured JSON role card.',
    'The preset describes the BOT itself (name, appearance, identity, interests, personality, behavior rules, etc.).',
    '',
    'You MUST use the provided function tool to output the JSON object. Do NOT answer with natural language.',
    '',
    'Key requirements:',
    '- The top-level JSON MUST be an object, not an array.',
    '- All natural language content must be in fluent Chinese.',
    '- If some sections are missing in the original preset, fill them with reasonable placeholders based on the text, but do NOT invent unrelated facts.',
    '- Do NOT mention that you are using tools or functions.'
  ].join('\n');

  const userContent = [
    '下面是 Agent 的完整中文预设文本（可能是 Markdown 或自然语言，描述外貌、人设、身份、兴趣、性格、说话风格、行为规则等）：',
    '---',
    text,
    '---',
    '',
    '请你只输出一个符合上面说明的 JSON 对象，不要输出任何额外解释。'
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  const chosenModel = model || process.env.AGENT_PRESET_CONVERTER_MODEL || process.env.MAIN_AI_MODEL;

  logger.info(`convertPresetTextToJson: 开始转换预设，file=${fileName || ''}, model=${chosenModel || ''}`);

  let reply;
  try {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'build_agent_preset',
          description: 'Convert the Chinese/Markdown agent preset text into a structured JSON role card for the BOT itself.',
          parameters: {
            type: 'object',
            properties: {
              meta: {
                type: 'object',
                description: 'High-level metadata of this agent persona node.',
                properties: {
                  node_name: { type: 'string', description: 'Node identifier, e.g. 失语_Aphasia_Character_Core' },
                  category: { type: 'string', description: 'Category, e.g. 角色生成/Character_Loader' },
                  description: { type: 'string', description: 'High level Chinese description of this persona' },
                  version: { type: 'string' },
                  author: { type: 'string' }
                },
                required: ['node_name', 'description']
              },
              parameters: {
                type: 'object',
                description: 'Structured persona sections such as Appearance, Identity, Interests, Personality, Other.',
                additionalProperties: true
              },
              rules: {
                type: 'array',
                description: 'Optional behavior rules with event/condition/behavior.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    enabled: { type: 'boolean' },
                    event: { type: 'string' },
                    conditions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          value: {}
                        },
                        required: ['type']
                      }
                    },
                    behavior: {
                      type: 'object',
                      additionalProperties: true
                    }
                  }
                }
              }
            },
            required: ['meta', 'parameters']
          }
        }
      }
    ];

    reply = await agent.chat(messages, {
      model: chosenModel,
      tools,
      tool_choice: { type: 'function', function: { name: 'build_agent_preset' } },
      temperature: 0
    });
  } catch (e) {
    logger.error('convertPresetTextToJson: 调用 LLM 失败，将回退到最小 JSON', e);
    return {
      presetJson: normalizePresetJson({}, { rawText: text, fileName }),
      rawText: text
    };
  }

  let extracted = null;
  if (reply && typeof reply === 'object') {
    extracted = Array.isArray(reply) && reply.length > 0 ? reply[0] : reply;
  } else {
    const replyText = typeof reply === 'string' ? reply : String(reply ?? '');
    try {
      const arr = extractJsonSync(replyText, 1) || [];
      if (Array.isArray(arr) && arr.length > 0) {
        const candidate = arr[0];
        if (candidate && (typeof candidate === 'object' || Array.isArray(candidate))) {
          extracted = candidate;
        }
      }
    } catch (e) {
      logger.warn('convertPresetTextToJson: 使用 extractJsonSync 解析失败，将使用最小 JSON 回退', { err: String(e) });
    }
  }

  if (!extracted) {
    logger.warn('convertPresetTextToJson: 未能从 LLM 输出中提取有效 JSON，使用最小 JSON 回退');
    return {
      presetJson: normalizePresetJson({}, { rawText: text, fileName }),
      rawText: text
    };
  }

  const normalized = normalizePresetJson(extracted, { rawText: text, fileName });
  savePresetCache(normalized, text, fileName);
  logger.success('convertPresetTextToJson: 预设文本已成功结构化为 JSON');

  return {
    presetJson: normalized,
    rawText: text
  };
}
