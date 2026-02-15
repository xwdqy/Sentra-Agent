import { DateTime } from 'luxon';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('ContextCompressor');

const BOT_PRIMARY_NAME = (() => {
  try {
    const raw = String(getEnv('BOT_NAMES', '') ?? '');
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list[0] || 'you';
  } catch {

    return 'you';
  }
})();

/**
 * Build system prompt for conversation summarization.
 * Follows industry best practices (Semantic Kernel / LangChain style):
 * - Keep only information that is useful for future reasoning
 * - Drop small talk and formatting noise
 * - Focus on user intent, facts, decisions, plans, and preferences
 *
 * IMPORTANT: Although instructions are in English, the FINAL SUMMARY
 * MUST be written in fluent Chinese.
 */
function buildSummarySystemPrompt({ chatType, botName }: { chatType?: string; botName?: string }) {
  const scene = chatType === 'group'
    ? 'a multi-user QQ group chat'
    : 'a one-to-one QQ private chat';

  return [
    `You are "${botName}", the primary AI agent in ${scene}.`,
    'Your role is to compress long chat histories into short, information-dense summaries while keeping the same persona and speaking style that you normally use in the chat.',
    '',
    'Your goal is to preserve all important meaning while aggressively removing redundancy and noise.',
    '',
    'Summarization rules:',
    '- Focus on: user goals, questions, requests, preferences, emotions, important facts, decisions, plans, and TODO items.',
    '- Ignore: greetings, thanks, emojis, idle chatter, short acknowledgements, and unimportant digressions.',
    '- Tools / searches / external systems: keep only the key conclusions that matter to the users; do NOT describe the execution process.',
    '- Code / logs / XML / JSON: only describe them briefly in natural language when they are essential to the user\'s intent.',
    '- Do NOT invent facts that are not clearly supported by the conversation.',
    `- History lines are formatted like "[角色] 内容": lines starting with "[${botName}]" are your own previous replies in the chat, lines starting with "[用户]" are user messages, other labels are system or meta information. Treat them all as parts of one coherent dialogue.`,
    `- When you summarize, keep the tone, style and identity of "${botName}". Do not say you are a helper or a tool; just speak as yourself in the chat.`,
    '- Even though these instructions are in English, the SUMMARY ITSELF MUST be written in fluent Chinese, in natural, concise style.',
    '- When the caller asks for a "one-sentence" summary, you MUST output at most one complete Chinese sentence.'
  ].join('\n');
}

function formatTimeRange({ timeStart, timeEnd, timezone = 'Asia/Shanghai' }: {
  timeStart?: number;
  timeEnd?: number;
  timezone?: string;
} = {}) {
  if (!timeStart && !timeEnd) {
    return '时间范围：未指定';
  }

  try {
    const fmt = (ms: number) => DateTime.fromMillis(ms).setZone(timezone).toFormat('yyyy-LL-dd HH:mm:ss');
    const startStr = timeStart ? fmt(timeStart) : '未知起点';
    const endStr = timeEnd ? fmt(timeEnd) : '当前/未知终点';
    return `时间范围：${startStr} ~ ${endStr}`;
  } catch {
    const startStr = timeStart ? new Date(timeStart).toISOString() : '未知起点';
    const endStr = timeEnd ? new Date(timeEnd).toISOString() : '当前/未知终点';
    return `时间范围：${startStr} ~ ${endStr}`;
  }
}

function buildLinearHistoryText(historyConversations: ChatMessage[] | undefined, maxChars = 8000) {
  if (!Array.isArray(historyConversations) || historyConversations.length === 0) {
    return '';
  }

  let out = '';

  for (const msg of historyConversations) {
    if (!msg || typeof msg.content !== 'string') continue;
    let role;
    if (msg.role === 'assistant') {
      role = BOT_PRIMARY_NAME;
    } else if (msg.role === 'user') {
      role = '用户';
    } else {
      role = String(msg.role || '系统');
    }

    const line = `[${role}] ${msg.content}\n\n`;

    if (out.length + line.length > maxChars) {
      const remain = Math.max(0, maxChars - out.length);
      out += line.substring(0, remain);
      break;
    }

    out += line;
  }

  return out.trim();
}

/**
 * 构建一次上下文压缩任务的消息列表（用于传给 Agent.chat）
 *
 * @param {Object} options
 * @param {Array<{role: string, content: string}>} options.historyConversations - 按时间排序的历史对话
 * @param {'group'|'private'} options.chatType - 对话类型：群聊 / 私聊
 * @param {string} [options.groupId] - 群ID（群聊时可选）
 * @param {string} [options.userId] - 用户ID（可选，仅用于日志）
 * @param {number} [options.timeStart] - 时间范围起点（毫秒）
 * @param {number} [options.timeEnd] - 时间范围终点（毫秒）
 * @param {number} [options.maxSummarySentences=1] - 摘要最多句数
 * @param {string} [options.presetText] - Agent 预设提示词（可选，会拼接到 system 提示词末尾）
 *
 * @returns {Array<{role: string, content: string}>}
 */
interface ContextSummaryOptions {
  historyConversations?: ChatMessage[];
  chatType?: 'group' | 'private';
  groupId?: string;
  userId?: string;
  timeStart?: number;
  timeEnd?: number;
  maxSummarySentences?: number;
  presetText?: string;
}

export function buildContextSummaryMessages(options: ContextSummaryOptions = {}): ChatMessage[] {
  const {
    historyConversations,
    chatType = 'group',
    groupId,
    userId,
    timeStart,
    timeEnd,
    maxSummarySentences = 1,
    presetText
  } = options;

  const historyText = buildLinearHistoryText(historyConversations);

  const baseSystem = buildSummarySystemPrompt({ chatType, botName: BOT_PRIMARY_NAME });

  let systemContent = baseSystem;
  if (presetText && typeof presetText === 'string' && presetText.trim()) {
    systemContent = [
      baseSystem,
      '',
      '---',
      '',
      'Below is the long-term persona preset for you in Chinese. When summarizing, keep the same identity, tone and style as described here (do not mention this preset explicitly):',
      presetText.trim()
    ].join('\n');
  }

  const metaParts = [];
  metaParts.push(chatType === 'group' ? '对话类型：QQ 群聊' : '对话类型：QQ 私聊');
  if (groupId) metaParts.push(`群ID：${groupId}`);
  if (userId) metaParts.push(`用户ID：${userId}`);
  const timeRangeArgs: { timeStart?: number; timeEnd?: number } = {
    ...(timeStart !== undefined ? { timeStart } : {}),
    ...(timeEnd !== undefined ? { timeEnd } : {})
  };
  metaParts.push(formatTimeRange(timeRangeArgs));
  metaParts.push(`摘要要求：最多 ${maxSummarySentences} 句中文，总结出这段对话的核心内容和意图。`);
  metaParts.push('下面是按时间顺序排列的原始对话内容（包含 Sentra 内部 XML 标签，如 <sentra-user-question> / <sentra-tools> / <sentra-result> 等）：');
  metaParts.push('请你自动忽略这些技术标签本身，只关注它们所表达的真实语义（谁在做什么、提出了什么问题、工具返回了什么结论等）。');

  const userContent = [
    metaParts.join('\n'),
    '',
    '=== 对话开始 ===',
    historyText || '(当前时间范围内没有对话内容)',
    '=== 对话结束 ===',
    '',
    '现在请根据上述对话内容，生成精炼的中文摘要。'
  ].join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

/**
 * 使用给定的 Agent 实例，对一段历史对话进行压缩摘要。
 * 调用方需要传入已构建好的 Agent（必须提供 chat(messages, options?) 方法）。
 *
 * @param {Object} params
 * @param {Object} params.agent - 已初始化的 Agent 实例
 * @param {Array<{role: string, content: string}>} params.historyConversations - 历史对话
 * @param {'group'|'private'} params.chatType
 * @param {string} [params.groupId]
 * @param {string} [params.userId]
 * @param {number} [params.timeStart]
 * @param {number} [params.timeEnd]
 * @param {number} [params.maxSummarySentences=1]
 * @param {string} [params.model] - 可选，压缩用模型名称，未提供时由 Agent 默认模型决定
 * @param {string} [params.presetText] - 可选，Agent 预设提示词，用于保持概括时的人设一致
 * @param {string} [params.apiBaseUrl] - 可选，API 基础 URL
 * @param {string} [params.apiKey] - 可选，API 密钥
 * @param {number} [params.timeout] - 可选，超时时间（毫秒）
 *
 * @returns {Promise<{ summary: string, messages: Array, model?: string }>}
 */
interface CompressContextParams extends ContextSummaryOptions {
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  model?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export async function compressContext(params: CompressContextParams = {}) {
  const {
    agent,
    historyConversations,
    chatType = 'group',
    groupId,
    userId,
    timeStart,
    timeEnd,
    maxSummarySentences = 1,
    model,
    presetText,
    apiBaseUrl,
    apiKey,
    timeout
  } = params;

  if (!agent || typeof agent.chat !== 'function') {
    throw new Error('compressContext: 需要传入带有 chat(messages, options) 方法的 agent 实例');
  }

  if (!Array.isArray(historyConversations) || historyConversations.length === 0) {
    logger.debug('compressContext: 历史为空，返回空摘要');
    return { summary: '', messages: [], model };
  }

  const summaryOptions: ContextSummaryOptions = {
    historyConversations,
    chatType,
    maxSummarySentences,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(timeStart !== undefined ? { timeStart } : {}),
    ...(timeEnd !== undefined ? { timeEnd } : {}),
    ...(presetText !== undefined ? { presetText } : {})
  };

  const messages = buildContextSummaryMessages(summaryOptions);

  const options = {
    ...(model ? { model } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? { timeout: Number(timeout) } : {})
  };

  logger.debug(
    `compressContext: chatType=${chatType} groupId=${groupId || ''} userId=${userId || ''} ` +
      `历史条数=${historyConversations.length}, maxSummarySentences=${maxSummarySentences}`
  );

  const response = await agent.chat(messages, options);
  const summary = (response || '').toString().trim();

  logger.info(
    `compressContext: 完成摘要 chatType=${chatType} groupId=${groupId || ''} ` +
      `历史条数=${historyConversations.length}, 摘要长度=${summary.length}`
  );

  return { summary, messages, model };
}
