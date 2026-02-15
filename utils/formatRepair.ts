import { createLogger } from './logger.js';
import { escapeXml, extractAllFullXMLTags } from './xmlUtils.js';
import { Agent } from '../src/agentRuntime.js';
import { getEnv, getEnvInt, getEnvTimeoutMs } from './envHotReloader.js';
import path from 'node:path';
import SentraPromptsSDK from 'sentra-prompts';
import type { ChatMessage, ExpectedOutput } from '../src/types.js';

const logger = createLogger('FormatRepair');

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');

type AgentLike = {
  chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<string | null>;
};

type RepairOptions = {
  agent?: Agent | AgentLike;
  model?: string;
  temperature?: number;
  timeout?: number;
};

type RepairProfile = 'response' | 'decision' | 'persona';

let cachedRepairResponseSystemPrompt: string | null = null;
let cachedRepairDecisionSystemPrompt: string | null = null;
let cachedRepairPersonaSystemPrompt: string | null = null;

async function getRepairResponseSystemPrompt(): Promise<string> {
  try {
    if (cachedRepairResponseSystemPrompt) {
      return cachedRepairResponseSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_repair_response_prompt_system}}",
      PROMPTS_CONFIG_PATH
    ) as string | null;
    if (typeof system === 'string' && system.trim()) {
      cachedRepairResponseSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 鍔犺浇 repair_response prompt 澶辫触锛屽皢浣跨敤绠€鍖栧洖閫€鏂囨', {
      err: String(e)
    });
  }
  return '# Sentra XML Format Repair Assistant';
}

async function getRepairDecisionSystemPrompt(): Promise<string> {
  try {
    if (cachedRepairDecisionSystemPrompt) {
      return cachedRepairDecisionSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_repair_decision_prompt_system}}",
      PROMPTS_CONFIG_PATH
    ) as string | null;
    if (typeof system === 'string' && system.trim()) {
      cachedRepairDecisionSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 鍔犺浇 repair_decision prompt 澶辫触锛屽皢浣跨敤绠€鍖栧洖閫€鏂囨', {
      err: String(e)
    });
  }
  return '# Sentra Decision Repair';
}

async function getRepairPersonaSystemPrompt(): Promise<string> {
  try {
    if (cachedRepairPersonaSystemPrompt) {
      return cachedRepairPersonaSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_repair_persona_prompt_system}}",
      PROMPTS_CONFIG_PATH
    ) as string | null;
    if (typeof system === 'string' && system.trim()) {
      cachedRepairPersonaSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('FormatRepair: 鍔犺浇 repair_persona prompt 澶辫触锛屽皢浣跨敤绠€鍖栧洖閫€鏂囨', {
      err: String(e)
    });
  }
  return '# Sentra Persona Repair';
}

/**
 * 浣跨敤宸ュ叿璋冪敤灏嗘ā鍨嬭緭鍑轰慨澶嶄负鍚堣鐨?<sentra-response> XML
 * - 鍒嗘 text 涓哄繀椤伙紙1-5 娈碉紝姣忔 1-3 鍙ワ級
 * - resources 鍙€夛紙浠呭綋鍘熷鏂囨湰涓寘鍚彲瑙ｆ瀽鐨?URL/璺緞鏃讹級
 * - 涓嶆敼鍙樺師濮嬭涔夛紝涓嶆坊鍔犲嚟绌哄唴瀹?
 * - 涓嶈緭鍑轰换浣曞彧璇荤郴缁熸爣绛撅紙sentra-user-question/sentra-result 绛夛級
 *
 * @param {string} rawText - API 鍘熷鏂囨湰锛堜笉鍚堣鐨勮緭鍑猴紝浣嗘湁浜虹被鍙鍐呭锛?
 * @param {{ agent?: Agent, model?: string, temperature?: number }} opts
 * @returns {Promise<string>} 鍚堣 XML 瀛楃涓?
 */
export async function repairSentraResponse(rawText: string, opts: RepairOptions = {}): Promise<string> {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('repairSentraResponse: rawText is empty or invalid');
  }

  const repairTimeout = opts.timeout ?? getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const apiKey = String(getEnv('REPAIR_API_KEY', getEnv('API_KEY')) || '');
  const apiBaseUrl = String(getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')) || 'https://yuanplus.chat/v1');
  const defaultModel = String(getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')) || '');
  const envTempRaw = getEnv('TEMPERATURE', '0.7');
  const envTemp = Number.parseFloat(String(envTempRaw ?? '0.7'));
  const temperatureValue = Number.isFinite(envTemp) ? envTemp : 0.7;
  const maxTokens = Number(getEnvInt('MAX_TOKENS', 4096) ?? 4096);

  const agent = opts.agent || new Agent({
    apiKey,
    apiBaseUrl,
    defaultModel,
    temperature: temperatureValue,
    maxTokens,
    timeout: repairTimeout
  });

  const model = opts.model ?? getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.2;

  const systemPrompt = await getRepairResponseSystemPrompt();

  const rootDirective = buildRootDirectiveRepair('sentra_response', 'format_repair');
  const userPrompt = [
    rootDirective,
    '',
    '<raw>',
    rawText,
    '</raw>'
  ].join('\n');

  const repairExamples: ChatMessage[] = [
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'Okay, here is the answer: <sentra-response><text1>Hi!</text1></sentra-response> extra text.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-response>',
        '  <user_id>{{user_id}}</user_id>',
        '  <text1>Hi!</text1>',
        '  <resources></resources>',
        '</sentra-response>'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'It is broken. Reply: Hello there. Also call tool local__weather.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-response>',
        '  <group_id>{{group_id}}</group_id>',
        '  <text1>Hello there.</text1>',
        '  <resources></resources>',
        '</sentra-response>'
      ].join('\n')
    }
  ];

  let result: string | null;
  try {
    result = await agent.chat([
      { role: 'system', content: systemPrompt },
      ...repairExamples,
      { role: 'user', content: userPrompt }
    ], {
      ...(model ? { model } : {}),
      temperature,
      timeout: repairTimeout
    });
  } catch (e) {
    logger.error('FormatRepair: model call failed', e);
    throw e;
  }

  if (!result || typeof result !== 'string') {
    throw new Error('FormatRepair: invalid model response');
  }

  const blocks = extractAllFullXMLTags(result, 'sentra-response') || [];
  const fixed = blocks.length > 0 ? blocks[0] : '';
  if (!fixed) {
    throw new Error('FormatRepair: missing <sentra-response>');
  }

  logger.success('FormatRepair: response repaired');
  return fixed;
}

export function shouldRepair(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  if (!text.trim()) return false;
  return !text.includes('<sentra-response>');
}

export function shouldRepairTools(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  if (!text.trim()) return false;
  return !text.includes('<sentra-tools>');
}

export function buildRootDirectiveRepair(expectedOutput: ExpectedOutput, lastErrorReason: string = ''): string {
  const escapeXmlValue = (v: unknown): string => {
    try {
      return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    } catch {
      return '';
    }
  };

  const reason = lastErrorReason ? escapeXmlValue(lastErrorReason) : '';
  const expected = escapeXmlValue(expectedOutput || 'sentra_response');

  const isToolsOnly = expectedOutput === 'sentra_tools' || expectedOutput === 'reply_gate_decision_tools' || expectedOutput === 'override_intent_decision_tools';
  const isToolsOrResponse = expectedOutput === 'sentra_tools_or_response';

  return [
    '<sentra-root-directive>',
    '  <id>format_retry_v1</id>',
    '  <type>format_repair</type>',
    '  <scope>single_turn</scope>',
    '  <objective>Fix the previous output format and return the final user-facing content.</objective>',
    `  <expected_output>${expected}</expected_output>`,
    ...(reason ? [`  <last_error>${reason}</last_error>`] : []),
    '  <constraints>',
    '    <item>You must output exactly one top-level block and nothing else.</item>',
    ...(isToolsOnly
      ? ['    <item>Only output <sentra-tools>...</sentra-tools>; no other tags or text.</item>']
      : isToolsOrResponse
        ? ['    <item>Output exactly one of: <sentra-tools>...</sentra-tools> OR <sentra-response>...</sentra-response>.</item>']
        : ['    <item>Only output <sentra-response>...</sentra-response>; no other sentra-xxx tags.</item>']),
    '    <item><sentra-response> may contain: <group_id> or <user_id> (only one), <textN>, <resources>, optional <emoji>, optional <send>.</item>',
    '    <item>Target tag must be explicit: <group_id> for group chats or <user_id> for private chats.</item>',
    '    <item>Do not mention internal tools, fields, or execution steps.</item>',
    '  </constraints>',
    '  <output_template>',
    '    <sentra-response>',
    '      <group_id_or_user_id>...</group_id_or_user_id>',
    '      <text1>...</text1>',
    '      <resources></resources>',
    '    </sentra-response>',
    '  </output_template>',
    '</sentra-root-directive>'
  ].join('\n');
}

function buildDecisionRepairRootDirective(lastErrorReason: string = ''): string {
  const reason = lastErrorReason ? escapeXml(String(lastErrorReason ?? '')) : '';
  return [
    '<sentra-root-directive>',
    '  <id>decision_repair_v1</id>',
    '  <type>format_repair</type>',
    '  <scope>single_turn</scope>',
    '  <objective>Repair raw output into a valid <sentra-decision>.</objective>',
    '  <expected_output>sentra_decision</expected_output>',
    ...(reason ? [`  <last_error>${reason}</last_error>`] : []),
    '  <constraints>',
    '    <item>Output exactly one <sentra-decision> block and nothing else.</item>',
    '    <item><sentra-decision> must contain only <need>, <reason>, <confidence>.</item>',
    '    <item>Do not output any sentra-response/sentra-tools/sentra-result/sentra-user-question tags.</item>',
    '    <item>Keep original meaning; do not invent facts.</item>',
    '  </constraints>',
    '  <output_template>',
    '    <sentra-decision>',
    '      <need>true|false</need>',
    '      <reason>...</reason>',
    '      <confidence>0.00</confidence>',
    '    </sentra-decision>',
    '  </output_template>',
    '</sentra-root-directive>'
  ].join('\n');
}

function buildPersonaRepairRootDirective(lastErrorReason: string = ''): string {
  const reason = lastErrorReason ? escapeXml(String(lastErrorReason ?? '')) : '';
  return [
    '<sentra-root-directive>',
    '  <id>persona_repair_v1</id>',
    '  <type>format_repair</type>',
    '  <scope>single_turn</scope>',
    '  <objective>Repair raw output into a valid <sentra-persona>.</objective>',
    '  <expected_output>sentra_persona</expected_output>',
    ...(reason ? [`  <last_error>${reason}</last_error>`] : []),
    '  <constraints>',
    '    <item>Output exactly one <sentra-persona> block and nothing else.</item>',
    '    <item><sentra-persona> must include <summary>; other fields are optional if supported by raw content.</item>',
    '    <item>Do not output any sentra-response/sentra-tools/sentra-result/sentra-user-question tags.</item>',
    '    <item>Keep original meaning; do not invent facts.</item>',
    '  </constraints>',
    '  <output_template>',
    '    <sentra-persona>',
    '      <summary>...</summary>',
    '    </sentra-persona>',
    '  </output_template>',
    '</sentra-root-directive>'
  ].join('\n');
}

export async function repairSentraDecision(rawText: string, opts: RepairOptions = {}): Promise<string> {
  if (!rawText || typeof rawText !== 'string') throw new Error('repairSentraDecision: rawText is invalid');

  const repairTimeout = opts.timeout ?? getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const apiKey = String(getEnv('REPAIR_API_KEY', getEnv('API_KEY')) || '');
  const apiBaseUrl = String(getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')) || 'https://yuanplus.chat/v1');
  const defaultModel = String(getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')) || '');
  const maxTokens = Number(getEnvInt('MAX_TOKENS', 4096) ?? 4096);

  const agent = opts.agent || new Agent({
    apiKey,
    apiBaseUrl,
    defaultModel,
    temperature: 0.2,
    maxTokens,
    timeout: repairTimeout
  });

  const model = opts.model ?? getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.2;

  const systemPrompt = await getRepairDecisionSystemPrompt();

  const rootDirective = buildDecisionRepairRootDirective();
  const userPrompt = [rootDirective, '', '<raw>', rawText, '</raw>'].join('\n');

  const repairExamples: ChatMessage[] = [
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'Need reply: yes. Reason: user asked a direct question. Confidence: 0.8.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-decision>',
        '  <need>true</need>',
        '  <reason>user asked a direct question</reason>',
        '  <confidence>0.80</confidence>',
        '</sentra-decision>'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'No reply needed. Low confidence.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-decision>',
        '  <need>false</need>',
        '  <reason>not necessary to reply</reason>',
        '  <confidence>0.40</confidence>',
        '</sentra-decision>'
      ].join('\n')
    }
  ];

  const result = await agent.chat(
    [
      { role: 'system', content: systemPrompt },
      ...repairExamples,
      { role: 'user', content: userPrompt }
    ],
    { ...(model ? { model } : {}), temperature, timeout: repairTimeout }
  );

  if (!result || typeof result !== 'string') throw new Error('FormatRepair: invalid model response');
  const blocks = extractAllFullXMLTags(result, 'sentra-decision') || [];
  const xml = blocks.length > 0 ? blocks[0] : '';
  if (!xml) throw new Error('FormatRepair: missing <sentra-decision>');
  return xml;
}

export async function repairSentraPersona(rawText: string, opts: RepairOptions = {}): Promise<string> {
  if (!rawText || typeof rawText !== 'string') throw new Error('repairSentraPersona: rawText is invalid');

  const repairTimeout = opts.timeout ?? getEnvTimeoutMs('REPAIR_TIMEOUT_MS', getEnvTimeoutMs('TIMEOUT', 180000, 900000), 900000);

  const apiKey = String(getEnv('REPAIR_API_KEY', getEnv('API_KEY')) || '');
  const apiBaseUrl = String(getEnv('REPAIR_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')) || 'https://yuanplus.chat/v1');
  const defaultModel = String(getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL')) || '');
  const maxTokens = Number(getEnvInt('MAX_TOKENS', 4096) ?? 4096);

  const agent = opts.agent || new Agent({
    apiKey,
    apiBaseUrl,
    defaultModel,
    temperature: 0.2,
    maxTokens,
    timeout: repairTimeout
  });

  const model = opts.model ?? getEnv('REPAIR_AI_MODEL', getEnv('MAIN_AI_MODEL'));
  const temperature = opts.temperature ?? 0.3;

  const systemPrompt = await getRepairPersonaSystemPrompt();

  const rootDirective = buildPersonaRepairRootDirective();
  const userPrompt = [rootDirective, '', '<raw>', rawText, '</raw>'].join('\n');

  const repairExamples: ChatMessage[] = [
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'Summary: user prefers concise replies. Interests: databases, backend.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-persona>',
        '  <summary>User prefers concise replies.</summary>',
        '  <traits>',
        '    <interests>',
        '      <interest>databases</interest>',
        '      <interest>backend</interest>',
        '    </interests>',
        '  </traits>',
        '</sentra-persona>'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        rootDirective,
        '',
        '<raw>',
        'Just a short summary about tone: friendly and direct.',
        '</raw>'
      ].join('\n')
    },
    {
      role: 'assistant',
      content: [
        '<sentra-persona>',
        '  <summary>Friendly and direct tone preference.</summary>',
        '</sentra-persona>'
      ].join('\n')
    }
  ];

  const result = await agent.chat(
    [
      { role: 'system', content: systemPrompt },
      ...repairExamples,
      { role: 'user', content: userPrompt }
    ],
    { ...(model ? { model } : {}), temperature, timeout: repairTimeout }
  );

  if (!result || typeof result !== 'string') throw new Error('FormatRepair: invalid model response');
  const blocks = extractAllFullXMLTags(result, 'sentra-persona') || [];
  const xml = blocks.length > 0 ? blocks[0] : '';
  if (!xml) throw new Error('FormatRepair: missing <sentra-persona>');
  return xml;
}

export async function repairWithProfile(profile: RepairProfile, rawText: string, opts: RepairOptions = {}): Promise<string> {
  if (profile === 'response') return repairSentraResponse(rawText, opts);
  if (profile === 'decision') return repairSentraDecision(rawText, opts);
  if (profile === 'persona') return repairSentraPersona(rawText, opts);
  throw new Error(`Unknown repair profile: ${profile}`);
}
