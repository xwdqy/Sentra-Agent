import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createLogger } from './logger.js';
import { getEnv, getEnvTimeoutMs, onEnvReload } from './envHotReloader.js';
import { loadPrompt } from '../prompts/loader.js';

const logger = createLogger('PresetTextToJson');

const PRESET_CONVERTER_PROMPT_NAME = 'preset_converter';
let cachedPresetConverterSystemPrompt = null;

onEnvReload(() => {
  cachedPresetConverterSystemPrompt = null;
});

async function getPresetConverterSystemPrompt() {
  try {
    if (cachedPresetConverterSystemPrompt) {
      return cachedPresetConverterSystemPrompt;
    }
    const data = await loadPrompt(PRESET_CONVERTER_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedPresetConverterSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('PresetTextToJson: 加载 preset_converter prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return 'You are an internal Sentra XML sub-agent that converts Chinese agent persona presets into a structured <sentra-agent-preset> XML block.';
}

function hashText(text) {
  try {
    return createHash('sha1').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function getPresetCachePath(fileName, signatureText) {
  const baseDir = './agent-presets';
  const cacheDir = path.join(baseDir, '.cache');
  const safeName = (fileName || 'default.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  const sigHash = signatureText ? hashText(signatureText) : null;
  const suffix = sigHash ? `.${sigHash.slice(0, 12)}` : '';
  const cacheFile = path.join(cacheDir, `${safeName}${suffix}.json`);
  return { cacheDir, cacheFile };
}

function tryLoadPresetCache(rawText, fileName, signatureText) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text) return null;

  const hash = hashText(text);
  if (!hash) return null;

  const { cacheFile } = getPresetCachePath(fileName, signatureText);
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

function savePresetCache(presetJson, rawText, fileName, signatureText) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text || !presetJson || typeof presetJson !== 'object') return;

  const hash = hashText(text);
  if (!hash) return;

  const { cacheDir, cacheFile } = getPresetCachePath(fileName, signatureText);
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

function extractFirstTagBlock(text, tagName) {
  if (!text || !tagName) return null;
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\/${tagName}\\s*>`, 'i');
  const m = String(text).match(re);
  return m ? m[0] : null;
}

function extractTagText(xml, tagName) {
  if (!xml || !tagName) return '';
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}\\s*>`, 'i');
  const m = String(xml).match(re);
  return m ? m[1].trim() : '';
}

function parseSimpleChildrenBlock(inner) {
  const result = {};
  if (!inner) return result;
  const re = /<([A-Za-z0-9_:-]+)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
  let m;
  const src = String(inner);
  while ((m = re.exec(src)) !== null) {
    const tag = m[1];
    const text = (m[2] || '').trim();
    if (!tag) continue;
    if (Object.prototype.hasOwnProperty.call(result, tag)) {
      const prev = result[tag];
      if (Array.isArray(prev)) {
        prev.push(text);
      } else {
        result[tag] = [prev, text];
      }
    } else {
      result[tag] = text;
    }
  }
  return result;
}

function parseSentraAgentPresetXml(xml) {
  if (!xml) return null;
  const metaXml = extractFirstTagBlock(xml, 'meta');
  const meta = {};
  const metaKeys = ['node_name', 'category', 'description', 'version', 'author'];
  for (const key of metaKeys) {
    const v = extractTagText(metaXml, key);
    if (v) {
      meta[key] = v;
    }
  }

  const parametersInner = extractTagText(xml, 'parameters');
  const parameters = parseSimpleChildrenBlock(parametersInner);

  const rulesInner = extractTagText(xml, 'rules');
  const rules = [];
  if (rulesInner) {
    const reRule = /<rule\b[^>]*>([\s\S]*?)<\/rule\s*>/gi;
    let m;
    const src = String(rulesInner);
    while ((m = reRule.exec(src)) !== null) {
      const block = m[0];
      const id = extractTagText(block, 'id');
      const enabledRaw = extractTagText(block, 'enabled');
      let enabled;
      if (enabledRaw) {
        const t = enabledRaw.trim().toLowerCase();
        if (t === 'true' || t === '1') enabled = true;
        else if (t === 'false' || t === '0') enabled = false;
      }
      const event = extractTagText(block, 'event');
      const conditionsInner = extractTagText(block, 'conditions');
      const conditions = [];
      if (conditionsInner) {
        const reCond = /<condition\b[^>]*>([\s\S]*?)<\/condition\s*>/gi;
        let mc;
        const srcCond = String(conditionsInner);
        while ((mc = reCond.exec(srcCond)) !== null) {
          const text = (mc[1] || '').trim();
          if (!text) continue;
          conditions.push({ type: 'text', value: text });
        }
      }
      const behaviorInner = extractTagText(block, 'behavior');
      const behavior = behaviorInner ? parseSimpleChildrenBlock(behaviorInner) : {};
      const rule = { id: id || undefined, enabled, event: event || undefined };
      if (conditions.length > 0) {
        rule.conditions = conditions;
      }
      if (behavior && Object.keys(behavior).length > 0) {
        rule.behavior = behavior;
      }
      rules.push(rule);
    }
  }

  const result = {};
  if (Object.keys(meta).length > 0) {
    result.meta = meta;
  }
  result.parameters = parameters && typeof parameters === 'object' ? parameters : {};
  if (rules.length > 0) {
    result.rules = rules;
  }
  return result;
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

  const timeout = getEnvTimeoutMs(
    'AGENT_PRESET_CONVERTER_TIMEOUT_MS',
    getEnvTimeoutMs('TIMEOUT', 180000, 900000),
    900000
  );

  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) {
    logger.warn('convertPresetTextToJson: 预设文本为空，返回空 JSON');
    return {
      presetJson: normalizePresetJson({}, { rawText: '', fileName }),
      rawText: ''
    };
  }

  const userContent = [
    '下面是 Agent 的完整中文预设文本（可能是 Markdown 或自然语言，描述外貌、人设、身份、兴趣、性格、说话风格、行为规则等）：',
    '---',
    text,
    '---',
    '',
    '请你只输出一个结构完整、可机读的 <sentra-agent-preset> XML 块，不要输出任何额外解释或 JSON。'
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  const chosenModel = model || getEnv('AGENT_PRESET_CONVERTER_MODEL', getEnv('MAIN_AI_MODEL'));
  const converterBaseUrl = getEnv('AGENT_PRESET_CONVERTER_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
  const converterApiKey = getEnv('AGENT_PRESET_CONVERTER_API_KEY', getEnv('API_KEY'));

  const cacheSignature = JSON.stringify({
    prompt: PRESET_CONVERTER_PROMPT_NAME,
    model: chosenModel || '',
    baseUrl: converterBaseUrl || ''
  });

  const cacheJson = tryLoadPresetCache(text, fileName, cacheSignature);
  if (cacheJson) {
    const normalizedFromCache = normalizePresetJson(cacheJson, { rawText: text, fileName });
    return {
      presetJson: normalizedFromCache,
      rawText: text
    };
  }

  const systemPrompt = await getPresetConverterSystemPrompt();

  logger.info(`convertPresetTextToJson: 开始转换预设(XML 工作流)，file=${fileName || ''}, model=${chosenModel || ''}`);

  let reply;
  try {
    reply = await agent.chat(messages, {
      model: chosenModel,
      temperature: 0,
      apiBaseUrl: converterBaseUrl,
      apiKey: converterApiKey,
      timeout
    });
  } catch (e) {
    logger.error('convertPresetTextToJson: 调用 LLM 失败，将回退到最小 JSON', e);
    return {
      presetJson: normalizePresetJson({}, { rawText: text, fileName }),
      rawText: text
    };
  }

  const replyText = typeof reply === 'string' ? reply : String(reply ?? '');
  const presetXml = extractFirstTagBlock(replyText, 'sentra-agent-preset');

  if (!presetXml) {
    logger.warn('convertPresetTextToJson: 未找到 <sentra-agent-preset> 块，使用最小 JSON 回退');
    return {
      presetJson: normalizePresetJson({}, { rawText: text, fileName }),
      rawText: text
    };
  }

  let extracted = null;
  try {
    extracted = parseSentraAgentPresetXml(presetXml);
  } catch (e) {
    logger.warn('convertPresetTextToJson: 解析 <sentra-agent-preset> 失败，将使用最小 JSON 回退', {
      err: String(e)
    });
  }

  if (!extracted || typeof extracted !== 'object') {
    logger.warn('convertPresetTextToJson: 未能从 XML 中提取有效预设，使用最小 JSON 回退');
    return {
      presetJson: normalizePresetJson({}, { rawText: text, fileName }),
      rawText: text
    };
  }

  const normalized = normalizePresetJson(extracted, { rawText: text, fileName });
  savePresetCache(normalized, text, fileName, cacheSignature);
  logger.success('convertPresetTextToJson: 预设文本已通过 Sentra XML 成功结构化为 JSON');

  return {
    presetJson: normalized,
    rawText: text
  };
}
