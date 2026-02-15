import { createLogger } from '../utils/logger.js';
import { compressContext } from '../utils/contextCompressor.js';
import { getEnv, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import {
  saveContextMemoryItem,
  getLastSummarizedPairCount,
  setLastSummarizedPairCount
} from '../utils/contextMemoryManager.js';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('ContextSummarizer');

interface ContextSummarizerOptions {
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  historyManager?: {
    getConversationPairCount: (groupId: string) => number;
    maxConversationPairs?: number;
    getConversationPairSlice: (
      groupId: string,
      sliceStart: number,
      sliceEnd: number
    ) => { conversations: ChatMessage[]; timeStart: number | null; timeEnd: number | null };
  };
  groupId?: string;
  chatType?: string;
  userId?: string;
  MCP_MAX_CONTEXT_PAIRS?: number;
  CONTEXT_MEMORY_ENABLED?: boolean;
  CONTEXT_MEMORY_MODEL?: string;
  CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS?: number;
  MAIN_AI_MODEL?: string;
  presetPlainText?: string;
  presetRawText?: string;
}

export async function triggerContextSummarizationIfNeededCore(options: ContextSummarizerOptions = {}) {
  const {
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    MCP_MAX_CONTEXT_PAIRS,
    CONTEXT_MEMORY_ENABLED,
    CONTEXT_MEMORY_MODEL,
    CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS,
    MAIN_AI_MODEL,
    presetPlainText,
    presetRawText
  } = options;

  if (!CONTEXT_MEMORY_ENABLED) {
    return;
  }

  if (!agent || !historyManager || !groupId) {
    return;
  }

  try {
    const totalPairs = historyManager.getConversationPairCount(groupId);
    if (!totalPairs || totalPairs <= 0) {
      return;
    }

    const mcpLimit = Number(MCP_MAX_CONTEXT_PAIRS);
    const defaultPairs =
      typeof historyManager.maxConversationPairs === 'number' && historyManager.maxConversationPairs > 0
        ? historyManager.maxConversationPairs
        : 20;
    const contextPairsLimit =
      Number.isFinite(mcpLimit) && mcpLimit > 0
        ? mcpLimit
        : defaultPairs;

    const discardedEnd = Math.max(0, totalPairs - contextPairsLimit);
    if (discardedEnd <= 0) {
      return;
    }

    const lastSummarized = await getLastSummarizedPairCount(groupId);
    const unsummarizedCount = discardedEnd - lastSummarized;
    if (unsummarizedCount <= 0) {
      return;
    }

    const basePairs = contextPairsLimit;
    const defaultThreshold = Math.max(1, Math.floor(basePairs / 2));
    const triggerRaw = Number(CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS);
    const threshold =
      Number.isFinite(triggerRaw) && triggerRaw > 0
        ? triggerRaw
        : defaultThreshold;

    if (unsummarizedCount < threshold) {
      logger.debug(
        `[${groupId}] ContextMemory: 未达到触发阈值 unsummarized=${unsummarizedCount}, threshold=${threshold}`
      );
      return;
    }

    const sliceStart = lastSummarized;
    const sliceEnd = discardedEnd;
    const { conversations, timeStart, timeEnd } = historyManager.getConversationPairSlice(
      groupId,
      sliceStart,
      sliceEnd
    );
    if (!Array.isArray(conversations) || conversations.length === 0) {
      await setLastSummarizedPairCount(groupId, discardedEnd);
      return;
    }

    const model = CONTEXT_MEMORY_MODEL || MAIN_AI_MODEL;

    const timeout = getEnvTimeoutMs(
      'CONTEXT_MEMORY_TIMEOUT_MS',
      getEnvTimeoutMs('TIMEOUT', 180000, 900000),
      900000
    );

    const contextMemoryBaseUrl = getEnv('CONTEXT_MEMORY_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
    const contextMemoryApiKey = getEnv('CONTEXT_MEMORY_API_KEY', getEnv('API_KEY'));

    logger.info(
      `[${groupId}] ContextMemory: 开始摘要 discarded pairs ${sliceStart}-${sliceEnd} (count=${unsummarizedCount}, model=${model})`
    );

    const presetText = presetPlainText || presetRawText || '';

    const safeTimeStart = typeof timeStart === 'number' ? timeStart : undefined;
    const safeTimeEnd = typeof timeEnd === 'number' ? timeEnd : undefined;

    const compressParams: {
      agent: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
      historyConversations: ChatMessage[];
      chatType: 'group' | 'private';
      maxSummarySentences: number;
      groupId?: string;
      userId?: string;
      timeStart?: number;
      timeEnd?: number;
      model?: string;
      presetText?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      timeout?: number;
    } = {
      agent,
      historyConversations: conversations,
      chatType: chatType === 'group' ? 'group' : 'private',
      maxSummarySentences: 3
    };

    if (groupId !== undefined) compressParams.groupId = groupId;
    if (userId !== undefined) compressParams.userId = userId;
    if (safeTimeStart !== undefined) compressParams.timeStart = safeTimeStart;
    if (safeTimeEnd !== undefined) compressParams.timeEnd = safeTimeEnd;
    if (model) compressParams.model = model;
    if (presetText) compressParams.presetText = presetText;
    if (contextMemoryBaseUrl) compressParams.apiBaseUrl = contextMemoryBaseUrl;
    if (contextMemoryApiKey) compressParams.apiKey = contextMemoryApiKey;
    if (Number.isFinite(timeout) && timeout > 0) compressParams.timeout = timeout;

    const { summary } = await compressContext(compressParams);

    if (!summary || !summary.trim()) {
      logger.warn(
        `[${groupId}] ContextMemory: 摘要结果为空，仍然推进游标到 ${discardedEnd}`
      );
      await setLastSummarizedPairCount(groupId, discardedEnd);
      return;
    }

    const memoryPayload = {
      summary: summary.trim(),
      timeStart,
      timeEnd,
      ...(model ? { model } : {}),
      ...(chatType ? { chatType } : {}),
      ...(userId ? { userId } : {})
    };
    await saveContextMemoryItem(groupId, memoryPayload);

    await setLastSummarizedPairCount(groupId, discardedEnd);
    logger.info(
      `[${groupId}] ContextMemory: 摘要完成并已保存，更新游标到 ${discardedEnd}`
    );
  } catch (e) {
    logger.warn(`ContextMemory: 摘要过程失败 ${groupId}`, { err: String(e) });
  }
}
