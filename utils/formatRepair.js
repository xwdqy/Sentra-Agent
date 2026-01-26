import { createLogger } from './logger.js';
import { escapeXml } from './xmlUtils.js';
import { Agent } from '../agent.js';
import { getEnv, getEnvInt, getEnvTimeoutMs } from './envHotReloader.js';
import { loadPrompt } from '../prompts/loader.js';

const logger = createLogger('FormatRepair');

const REPAIR_RESPONSE_PROMPT_NAME = 'repair_response';
const REPAIR_DECISION_PROMPT_NAME = 'repair_decision';
const REPAIR_PERSONA_PROMPT_NAME = 'repair_persona';

let cachedRepairResponseSystemPrompt = null;
let cachedRepairDecisionSystemPrompt = null;
let cachedRepairPersonaSystemPrompt = null;

async function getRepairResponseSystemPrompt() {
  try {
    if (cachedRepairResponseSystemPrompt) {
      return cachedRepairResponseSystemPrompt;
    }
    const data = await loadPrompt(REPAIR_RESPONSE_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedRepairResponseSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 加载 repair_response prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '# Sentra XML Format Repair Assistant';
}

async function getRepairDecisionSystemPrompt() {
  try {
    if (cachedRepairDecisionSystemPrompt) {
      return cachedRepairDecisionSystemPrompt;
    }
    const data = await loadPrompt(REPAIR_DECISION_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedRepairDecisionSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 加载 repair_decision prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '# Sentra Decision Repair';
}

async function getRepairPersonaSystemPrompt() {
  try {
    if (cachedRepairPersonaSystemPrompt) {
      return cachedRepairPersonaSystemPrompt;
    }
    const data = await loadPrompt(REPAIR_PERSONA_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
    if (system) {
      cachedRepairPersonaSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 加载 repair_persona prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '# Sentra Persona Repair';
}

/**
 * 使用工具调用将模型输出修复为合规的 <sentra-response> XML
 * - 分段 text 为必须（1-5 段，每段 1-3 句）
 * - resources 可选（仅当原始文本中包含可解析的 URL/路径时）
 * - 不改变原始语义，不添加凭空内容
 * - 不输出任何只读系统标签（sentra-user-question/sentra-result 等）
 *
 * @param {string} rawText - API 原始文本（不合规的输出，但有人类可读内容）
 * @param {{ agent?: Agent, model?: string, temperature?: number }} opts
 * @returns {Promise<string>} 合规 XML 字符串
 */
export async function repairSentraResponse(rawText, opts = {}) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('repairSentraResponse: rawText 为空或非字符串');
  }

  const repairTimeout = getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const agent = opts.agent || new Agent({
    apiKey: getEnv('REPAIR_API_KEY', getEnv('API_KEY')),
    apiBaseUrl: getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
    defaultModel: getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')),
    temperature: parseFloat(getEnv('TEMPERATURE', '0.7')),
    maxTokens: getEnvInt('MAX_TOKENS', 4096),
    maxRetries: getEnvInt('MAX_RETRIES', 3),
    timeout: repairTimeout
  });

  const model = opts.model || getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.2;

  const systemPrompt = await getRepairResponseSystemPrompt();

  const userPrompt = [
    'Repair the following assistant output into structured fields. Keep meaning intact. If no resources are detectable, return an empty resources array.',
    '',
    '<raw>',
    rawText,
    '</raw>'
  ].join('\n');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'return_structured_sentra_response',
        description: 'Return structured fields for a Sentra XML response. Do not invent content.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            texts: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              description: 'Text segments, each 1-3 sentences, natural and friendly.',
              items: { type: 'string' }
            },
            resources: {
              type: 'array',
              description: 'Optional resources extracted from the raw text (URLs/paths only).',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['image', 'video', 'audio', 'file', 'link'] },
                  source: { type: 'string' },
                  caption: { type: 'string' }
                },
                required: ['type', 'source']
              }
            }
          },
          required: ['texts']
        }
      }
    }
  ];

  const tool_choice = { type: 'function', function: { name: 'return_structured_sentra_response' } };

  let result;
  try {
    result = await agent.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      model,
      temperature,
      tools,
      tool_choice,
      timeout: repairTimeout
    });
  } catch (e) {
    logger.error('调用修复模型失败', e);
    throw e;
  }

  // 当使用 tools 时，agent.chat 会返回解析后的 JSON 对象
  if (!result || typeof result !== 'object' || !Array.isArray(result.texts)) {
    throw new Error('修复工具返回无效结果');
  }

  const texts = Array.isArray(result.texts) ? result.texts : [];
  const resources = Array.isArray(result.resources) ? result.resources : [];

  // 组装为 <sentra-response>
  const xmlParts = [];
  xmlParts.push('<sentra-response>');

  const maxTexts = Math.min(5, Math.max(1, texts.length));
  for (let i = 0; i < maxTexts; i++) {
    const seg = String(texts[i] ?? '').trim();
    if (!seg) continue;
    xmlParts.push(`  <text${i + 1}>${escapeXml(seg)}</text${i + 1}>`);
  }

  if (resources.length === 0) {
    xmlParts.push('  <resources></resources>');
  } else {
    xmlParts.push('  <resources>');
    for (const r of resources) {
      // 仅当字段完整时添加
      if (!r || !r.type || !r.source) continue;
      const caption = r.caption ? String(r.caption) : '';
      xmlParts.push('    <resource>');
      xmlParts.push(`      <type>${escapeXml(r.type)}</type>`);
      xmlParts.push(`      <source>${escapeXml(r.source)}</source>`);
      if (caption) xmlParts.push(`      <caption>${escapeXml(caption)}</caption>`);
      xmlParts.push('    </resource>');
    }
    xmlParts.push('  </resources>');
  }

  xmlParts.push('</sentra-response>');

  const fixed = xmlParts.join('\n');
  logger.success('格式修复完成');
  return fixed;
}

/**
 * 简单判断是否需要修复：有文本但不包含 <sentra-response>
 * @param {string} text
 */
export function shouldRepair(text) {
  if (!text || typeof text !== 'string') return false;
  if (!text.trim()) return false;
  return !text.includes('<sentra-response>');
}

export async function repairSentraDecision(rawText, opts = {}) {
  if (!rawText || typeof rawText !== 'string') throw new Error('repairSentraDecision: rawText 无效');

  const repairTimeout = getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const agent = opts.agent || new Agent({
    apiKey: getEnv('REPAIR_API_KEY', getEnv('API_KEY')),
    apiBaseUrl: getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
    defaultModel: getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')),
    temperature: 0.2,
    maxTokens: getEnvInt('MAX_TOKENS', 4096),
    maxRetries: getEnvInt('MAX_RETRIES', 3),
    timeout: repairTimeout
  });

  const model = opts.model || getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.2;

  const systemPrompt = await getRepairDecisionSystemPrompt();

  const userPrompt = ['Fix assistant output into sentra-decision fields:', '<raw>', rawText, '</raw>'].join('\n');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'return_structured_sentra_decision',
        description: 'Return decision fields without inventing content.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            need: { type: 'boolean' },
            reason: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['need', 'reason', 'confidence']
        }
      }
    }
  ];
  const tool_choice = { type: 'function', function: { name: 'return_structured_sentra_decision' } };

  const result = await agent.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { model, temperature, tools, tool_choice, timeout: repairTimeout }
  );

  if (!result || typeof result !== 'object') throw new Error('修复工具返回无效结果');
  const need = Boolean(result.need);
  const reason = String(result.reason || '').trim();
  const confidence = Math.min(1, Math.max(0, Number(result.confidence || 0.5)));

  const xml = [
    '<sentra-decision>',
    `  <need>${need}</need>`,
    `  <reason>${reason}</reason>`,
    `  <confidence>${confidence.toFixed(2)}</confidence>`,
    '</sentra-decision>'
  ].join('\n');
  return xml;
}

export async function repairSentraPersona(rawText, opts = {}) {
  if (!rawText || typeof rawText !== 'string') throw new Error('repairSentraPersona: rawText 无效');

  const repairTimeout = getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const agent = opts.agent || new Agent({
    apiKey: getEnv('REPAIR_API_KEY', getEnv('API_KEY')),
    apiBaseUrl: getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
    defaultModel: getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')),
    temperature: 0.2,
    maxTokens: getEnvInt('MAX_TOKENS', 4096),
    maxRetries: getEnvInt('MAX_RETRIES', 3),
    timeout: repairTimeout
  });

  const model = opts.model || getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.3;

  const systemPrompt = await getRepairPersonaSystemPrompt();

  const userPrompt = ['Fix assistant output into persona fields:', '<raw>', rawText, '</raw>'].join('\n');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'return_structured_sentra_persona',
        description: 'Return persona fields without inventing content.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            personality: { type: 'array', items: { type: 'string' } },
            communication_style: { type: 'string' },
            interests: { type: 'array', items: { type: 'string' } },
            behavioral_patterns: { type: 'array', items: { type: 'string' } },
            emotional_profile: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dominant_emotions: { type: 'string' },
                sensitivity_areas: { type: 'string' },
                expression_tendency: { type: 'string' }
              }
            },
            insights: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  content: { type: 'string' },
                  evidence: { type: 'string' }
                },
                required: ['content']
              }
            },
            metadata: {
              type: 'object',
              additionalProperties: false,
              properties: {
                confidence: { type: 'string' },
                data_quality: { type: 'string' },
                update_priority: { type: 'string' }
              }
            }
          },
          required: ['summary']
        }
      }
    }
  ];
  const tool_choice = { type: 'function', function: { name: 'return_structured_sentra_persona' } };

  const result = await agent.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { model, temperature, tools, tool_choice }
  );

  if (!result || typeof result !== 'object') throw new Error('修复工具返回无效结果');

  const lines = [];
  lines.push('<sentra-persona>');
  if (result.summary) lines.push(`  <summary>${escapeXml(String(result.summary).trim())}</summary>`);

  const hasTraits =
    (Array.isArray(result.personality) && result.personality.length) ||
    result.communication_style ||
    (Array.isArray(result.interests) && result.interests.length) ||
    (Array.isArray(result.behavioral_patterns) && result.behavioral_patterns.length) ||
    (result.emotional_profile && (result.emotional_profile.dominant_emotions || result.emotional_profile.sensitivity_areas || result.emotional_profile.expression_tendency));

  if (hasTraits) {
    lines.push('  <traits>');
    if (Array.isArray(result.personality) && result.personality.length) {
      lines.push('    <personality>');
      for (const t of result.personality) lines.push(`      <trait>${escapeXml(String(t).trim())}</trait>`);
      lines.push('    </personality>');
    }
    if (result.communication_style) {
      lines.push('    <communication_style>' + escapeXml(String(result.communication_style).trim()) + '</communication_style>');
    }
    if (Array.isArray(result.interests) && result.interests.length) {
      lines.push('    <interests>');
      for (const it of result.interests) lines.push(`      <interest>${escapeXml(String(it).trim())}</interest>`);
      lines.push('    </interests>');
    }
    if (Array.isArray(result.behavioral_patterns) && result.behavioral_patterns.length) {
      lines.push('    <behavioral_patterns>');
      for (const p of result.behavioral_patterns) lines.push(`      <pattern>${escapeXml(String(p).trim())}</pattern>`);
      lines.push('    </behavioral_patterns>');
    }
    if (result.emotional_profile && (result.emotional_profile.dominant_emotions || result.emotional_profile.sensitivity_areas || result.emotional_profile.expression_tendency)) {
      lines.push('    <emotional_profile>');
      if (result.emotional_profile.dominant_emotions) lines.push('      <dominant_emotions>' + escapeXml(String(result.emotional_profile.dominant_emotions).trim()) + '</dominant_emotions>');
      if (result.emotional_profile.sensitivity_areas) lines.push('      <sensitivity_areas>' + escapeXml(String(result.emotional_profile.sensitivity_areas).trim()) + '</sensitivity_areas>');
      if (result.emotional_profile.expression_tendency) lines.push('      <expression_tendency>' + escapeXml(String(result.emotional_profile.expression_tendency).trim()) + '</expression_tendency>');
      lines.push('    </emotional_profile>');
    }
    lines.push('  </traits>');
  }

  if (Array.isArray(result.insights) && result.insights.length) {
    lines.push('  <insights>');
    for (const ins of result.insights) {
      lines.push('    <insight>');
      lines.push('      ' + escapeXml(String(ins.content || '').trim()));
      lines.push('    </insight>');
    }
    lines.push('  </insights>');
  }

  if (result.metadata && (result.metadata.confidence || result.metadata.data_quality || result.metadata.update_priority)) {
    lines.push('  <metadata>');
    if (result.metadata.confidence) lines.push('    <confidence>' + escapeXml(String(result.metadata.confidence).trim()) + '</confidence>');
    if (result.metadata.data_quality) lines.push('    <data_quality>' + escapeXml(String(result.metadata.data_quality).trim()) + '</data_quality>');
    if (result.metadata.update_priority) lines.push('    <update_priority>' + escapeXml(String(result.metadata.update_priority).trim()) + '</update_priority>');
    lines.push('  </metadata>');
  }

  lines.push('</sentra-persona>');
  return lines.join('\n');
}

export async function repairWithProfile(profile, rawText, opts = {}) {
  if (profile === 'response') return repairSentraResponse(rawText, opts);
  if (profile === 'decision') return repairSentraDecision(rawText, opts);
  if (profile === 'persona') return repairSentraPersona(rawText, opts);
  throw new Error(`Unknown repair profile: ${profile}`);
}
