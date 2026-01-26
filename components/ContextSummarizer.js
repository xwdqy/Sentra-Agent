import { createLogger } from '../utils/logger.js';
import { compressContext } from '../utils/contextCompressor.js';
import { getEnv, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import {
  saveContextMemoryItem,
  getLastSummarizedPairCount,
  setLastSummarizedPairCount
} from '../utils/contextMemoryManager.js';

const logger = createLogger('ContextSummarizer');

export async function triggerContextSummarizationIfNeededCore(options = {}) {
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

    const contextPairsLimit =
      Number.isFinite(MCP_MAX_CONTEXT_PAIRS) && MCP_MAX_CONTEXT_PAIRS > 0
        ? MCP_MAX_CONTEXT_PAIRS
        : historyManager.maxConversationPairs || 20;

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
    const threshold =
      Number.isFinite(CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS) &&
      CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS > 0
        ? CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS
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

    const { summary } = await compressContext({
      agent,
      historyConversations: conversations,
      chatType: chatType === 'group' ? 'group' : 'private',
      groupId,
      userId,
      timeStart,
      timeEnd,
      maxSummarySentences: 3,
      model,
      presetText,
      apiBaseUrl: contextMemoryBaseUrl,
      apiKey: contextMemoryApiKey,
      timeout
    });

    if (!summary || !summary.trim()) {
      logger.warn(
        `[${groupId}] ContextMemory: 摘要结果为空，仍然推进游标到 ${discardedEnd}`
      );
      await setLastSummarizedPairCount(groupId, discardedEnd);
      return;
    }

    await saveContextMemoryItem(groupId, {
      summary: summary.trim(),
      timeStart,
      timeEnd,
      model,
      chatType,
      userId
    });

    await setLastSummarizedPairCount(groupId, discardedEnd);
    logger.info(
      `[${groupId}] ContextMemory: 摘要完成并已保存，更新游标到 ${discardedEnd}`
    );
  } catch (e) {
    logger.warn(`ContextMemory: 摘要过程失败 ${groupId}`, { err: String(e) });
  }
}
