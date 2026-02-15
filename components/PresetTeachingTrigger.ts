import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from '../utils/jsonToSentraXmlConverter.js';
import { savePresetCacheForTeaching } from '../utils/presetTextToJsonConverter.js';
import { maybeTeachPreset } from './PresetTeachingManager.js';
import type { ChatMessage } from '../src/types.js';

type BatchConfig = { batchSize: number; maxChars: number; maxItems: number; ttlMs: number };
type BatchBuffer = { items: string[]; chars: number; firstAt: number; lastAt: number };
type PresetSnapshot = {
  json?: Record<string, unknown>;
  sourcePath?: string;
  sourceFileName?: string;
  rawText?: string;
};
type HistoryManagerLike = {
  getConversationHistoryForContext?: (
    groupId: string,
    options?: { recentPairs?: number }
  ) => Array<ChatMessage | { role?: string; content?: unknown }>;
};
type TriggerOptions = {
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  historyManager?: HistoryManagerLike;
  groupId?: string;
  chatType?: string;
  userId?: string;
  userContent?: unknown;
  assistantContent?: unknown;
  getPresetSnapshot?: () => PresetSnapshot | null;
  applyPresetUpdate?: (updated: Record<string, unknown>, state: PresetSnapshot | null) => Promise<void>;
};

const logger = createLogger('PresetTeachingTrigger');

// 预设教导更新队列：串行执行，避免并发覆盖同一份预设
let presetTeachingQueue: Promise<unknown> = Promise.resolve();

// 预设教导批处理缓冲：按会话累计若干轮，再触发一次 LLM 教导检查
// key -> { items: string[], chars: number, firstAt: number, lastAt: number }
const teachingBatchBuffer = new Map<string, BatchBuffer>();

function sanitizePositiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  if (intVal <= 0) return fallback;
  return intVal;
}

function sanitizeNonNegativeInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  if (intVal < 0) return fallback;
  return intVal;
}

function getTeachingBatchConfig(): BatchConfig {
  // 默认 8；非法值（<=0/NaN）回退 1
  const batchSize = sanitizePositiveInt(getEnvInt('AGENT_PRESET_TEACHING_BATCH_SIZE', 8), 1);
  const maxChars = sanitizeNonNegativeInt(getEnvInt('AGENT_PRESET_TEACHING_BATCH_MAX_CHARS', 0), 0);
  const maxItems = sanitizePositiveInt(getEnvInt('AGENT_PRESET_TEACHING_BATCH_MAX_ITEMS', 50), 1);
  const ttlMs = sanitizeNonNegativeInt(getEnvInt('AGENT_PRESET_TEACHING_BATCH_TTL_MS', 0), 0);
  return { batchSize, maxChars, maxItems, ttlMs };
}

function buildBatchKey({
  groupId,
  chatType,
  userId,
  presetSourceFileName
}: {
  groupId?: string;
  chatType?: string;
  userId?: string;
  presetSourceFileName?: string;
}): string {
  const gid = groupId ? String(groupId) : '';
  const uid = userId ? String(userId) : '';
  const ct = chatType ? String(chatType) : '';
  const preset = presetSourceFileName ? String(presetSourceFileName) : '';
  return `${ct}|${gid}|${uid}|${preset}`;
}

function pushTeachingBatchItem(
  key: string,
  text: unknown,
  cfg: BatchConfig
): { shouldFlush: boolean; batchText: string } {
  if (!key) return { shouldFlush: false, batchText: '' };
  const now = Date.now();
  const safeText = typeof text === 'string' ? text : '';
  const itemChars = safeText.length;

  let buf = teachingBatchBuffer.get(key);
  if (!buf) {
    buf = { items: [], chars: 0, firstAt: now, lastAt: now };
    teachingBatchBuffer.set(key, buf);
  }

  buf.items.push(safeText);
  buf.chars += itemChars;
  buf.lastAt = now;

  const sizeReached = buf.items.length >= cfg.batchSize;
  const maxCharsReached = cfg.maxChars > 0 && buf.chars >= cfg.maxChars;
  const maxItemsReached = buf.items.length >= cfg.maxItems;
  const ttlReached = cfg.ttlMs > 0 && now - buf.firstAt >= cfg.ttlMs;

  const shouldFlush = sizeReached || maxCharsReached || maxItemsReached || ttlReached;
  if (!shouldFlush) {
    return { shouldFlush: false, batchText: '' };
  }

  // 取出并清空缓冲，避免后续并发触发重复 flush
  teachingBatchBuffer.delete(key);

  const parts: string[] = [];
  const total = buf.items.length;
  for (let i = 0; i < total; i++) {
    parts.push(`--- BATCH_ITEM ${i + 1}/${total} ---`);
    parts.push(buf.items[i] || '(empty)');
  }
  return { shouldFlush: true, batchText: parts.join('\n') };
}

function enqueuePresetTeachingTask(taskFn: () => Promise<unknown>): Promise<unknown> {
  const nextTask = presetTeachingQueue.then(() => taskFn());
  // 确保队列链本身不会因为单个任务失败而中断
  presetTeachingQueue = nextTask.catch((err) => {
    logger.debug('PresetTeachingTrigger: 队列任务执行失败', { err: String(err) });
  });
  return nextTask;
}

export async function triggerPresetTeachingIfNeededCore(options: TriggerOptions = {}): Promise<unknown | null> {
  const {
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    userContent,
    assistantContent,
    getPresetSnapshot,
    applyPresetUpdate
  } = options;

  const enabled = getEnvBool('AGENT_PRESET_TEACHING_ENABLED', false);
  if (!enabled) return null;
  if (!agent || typeof agent.chat !== 'function') return null;
  if (!historyManager || !groupId) return null;
  if (typeof getPresetSnapshot !== 'function') return null;

  const initialState = getPresetSnapshot();
  if (!initialState || !initialState.json || typeof initialState.json !== 'object') {
    return null;
  }

  const userPart =
    typeof userContent === 'string'
      ? userContent
      : userContent
      ? JSON.stringify(userContent)
      : '';
  const assistantPart =
    typeof assistantContent === 'string'
      ? assistantContent
      : assistantContent
      ? JSON.stringify(assistantContent)
      : '';

  let recentContextText = '';
  try {
    const ctxPairs = getEnvInt('AGENT_PRESET_TEACHING_CONTEXT_PAIRS', 0) || 0;
    if (
      ctxPairs > 0 &&
      historyManager &&
      typeof historyManager.getConversationHistoryForContext === 'function'
    ) {
      const recentHistory =
        historyManager.getConversationHistoryForContext(groupId, {
          recentPairs: ctxPairs
        }) || [];

      if (Array.isArray(recentHistory) && recentHistory.length > 0) {
        const lines = recentHistory.map((h, idx) => {
          const role = h.role || (idx % 2 === 0 ? 'user' : 'assistant');
          const content =
            typeof h.content === 'string' ? h.content : JSON.stringify(h.content ?? '');
          return `[${role}] ${content}`;
        });
        recentContextText = lines.join('\n\n');
      }
    }
  } catch (e) {
    logger.debug('PresetTeachingTrigger: 构造最近上下文失败，将仅使用本轮对话', {
      err: String(e)
    });
  }

  const conversationParts = [
    '本轮用户输入（含上下文 XML 等内部结构，仅供内部教导分析使用）：',
    userPart || '(empty)',
    '',
    '本轮助手输出：',
    assistantPart || '(empty)'
  ];

  if (recentContextText) {
    conversationParts.push('', '最近若干轮对话上下文（仅供教导判断使用）：', recentContextText);
  }

  const conversationText = conversationParts.join('\n');

  const cfg = getTeachingBatchConfig();
  const keyParams: {
    groupId?: string;
    chatType?: string;
    userId?: string;
    presetSourceFileName?: string;
  } = { presetSourceFileName: initialState?.sourceFileName || '' };
  if (groupId) keyParams.groupId = groupId;
  if (chatType) keyParams.chatType = chatType;
  if (userId) keyParams.userId = userId;
  const batchKey = buildBatchKey(keyParams);
  const pushed = pushTeachingBatchItem(batchKey, conversationText, cfg);
  if (!pushed.shouldFlush) {
    logger.debug('PresetTeachingTrigger: batched teaching context (skip this round)', {
      groupId,
      userId,
      batchSize: cfg.batchSize
    });
    return null;
  }

  // 将实际教导与预设写回逻辑排入串行队列中执行，避免高并发下互相覆盖
  const flushedConversationText = pushed.batchText;
  return enqueuePresetTeachingTask(async () => {
    const state = typeof getPresetSnapshot === 'function' ? getPresetSnapshot() : null;
    const presetSnapshot = state && state.json;
    if (!presetSnapshot || typeof presetSnapshot !== 'object') {
      logger.debug('PresetTeachingTrigger: 队列执行时预设为空，跳过教导', { groupId });
      return null;
    }

    try {
      const teachOptions: {
        agent: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
        presetJson: Record<string, unknown>;
        conversationText: string;
        userId?: string;
        groupId?: string;
        chatType?: string;
        presetSourceFileName?: string;
      } = {
        agent,
        presetJson: presetSnapshot,
        conversationText: flushedConversationText
      };
      if (userId) teachOptions.userId = userId;
      if (groupId) teachOptions.groupId = groupId;
      if (chatType) teachOptions.chatType = chatType;
      if (state?.sourceFileName) teachOptions.presetSourceFileName = state.sourceFileName;

      const updated = await maybeTeachPreset(teachOptions);

      if (!updated || typeof updated !== 'object') {
        return null;
      }

      // 默认的更新逻辑：若调用方未提供 applyPresetUpdate，则在此处直接写回文件和缓存
      if (typeof applyPresetUpdate === 'function') {
        try {
          await applyPresetUpdate(updated, state);
        } catch (e) {
          logger.debug('PresetTeachingTrigger: applyPresetUpdate 失败', {
            groupId,
            err: String(e)
          });
        }
      } else {
        const updatedJson = updated;
        const updatedXml = buildAgentPresetXml(updatedJson) || '';
        const updatedPlainText = formatPresetJsonAsPlainText(updatedJson) || '';

        const srcPath = state?.sourcePath || '';
        const srcFile = (state?.sourceFileName || '').toLowerCase();
        if (srcPath && srcFile.endsWith('.json')) {
          try {
            fs.writeFileSync(srcPath, JSON.stringify(updatedJson, null, 2), 'utf8');
            logger.info(`PresetTeachingTrigger: 已写回 JSON 预设文件 ${state?.sourceFileName}`);
          } catch (e) {
            logger.warn('PresetTeachingTrigger: 写回 JSON 预设文件失败', { err: String(e) });
          }
        }

        try {
          const raw = typeof state?.rawText === 'string' ? state.rawText : '';
          if (raw && raw.trim()) {
            savePresetCacheForTeaching(updatedJson, raw, state?.sourceFileName || '');
          }
        } catch (e) {
          logger.debug('PresetTeachingTrigger: 写入预设缓存失败', { err: String(e) });
        }

        // 返回也包含衍生字段，供调用方选择是否同步本地状态
        return {
          json: updatedJson,
          xml: updatedXml,
          plainText: updatedPlainText
        };
      }

      return { json: updated };
    } catch (e) {
      logger.debug('PresetTeachingTrigger: 异步教导流程失败(队列任务)', {
        groupId,
        err: String(e)
      });
      throw e;
    }
  });
}
