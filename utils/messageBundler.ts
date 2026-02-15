import { createLogger } from './logger.js';
import { OpenAIEmbeddings } from '@langchain/openai';
import { getEnv, getEnvInt, onEnvReload } from './envHotReloader.js';

const logger = createLogger('MessageBundler');

type MessageLike = {
  sender_id?: string | number | null;
  group_id?: string | number | null;
  message_id?: string | number | null;
  text?: string;
  summary?: string;
  time_str?: string;
  [key: string]: unknown;
};

type BundleState = {
  collecting: boolean;
  messages: MessageLike[];
  lastUpdate: number;
  lowSimCount: number;
};

type BundleTimingConfig = {
  windowMs: number;
  maxMs: number;
  minSimilarity: number;
  maxLowSimCount: number;
  maxMessagesPerWindow: number;
  pendingMaxMessages: number;
};

type EmbeddingConfig = {
  timeoutMs: number;
  maxRetries: number;
};

function getBundleTimingConfig(): BundleTimingConfig {
  const windowMs = getEnvInt('BUNDLE_WINDOW_MS', 5000) ?? 5000;
  const maxMs = getEnvInt('BUNDLE_MAX_MS', 15000) ?? 15000;
  const rawSim = Number.parseFloat(String(getEnv('BUNDLE_MIN_SIMILARITY', '0.6') ?? '0.6'));
  const minSimilarity = Number.isFinite(rawSim) ? rawSim : 0.6;
  const maxLowSimCount = getEnvInt('BUNDLE_MAX_LOW_SIM_COUNT', 2) ?? 2;
  const maxMessagesPerWindow = getEnvInt('BUNDLE_MAX_MESSAGES_PER_WINDOW', 30) ?? 30;
  const pendingMaxMessages = getEnvInt('BUNDLE_PENDING_MAX_MESSAGES', 20) ?? 20;
  return { windowMs, maxMs, minSimilarity, maxLowSimCount, maxMessagesPerWindow, pendingMaxMessages };
}

// 向量相似度计算的保护参数：防止 Embedding 请求过慢拖垮整体消息处理
function getEmbeddingConfig(): EmbeddingConfig {
  const timeoutMs = getEnvInt('BUNDLE_EMBEDDING_TIMEOUT_MS', 8000) ?? 8000;
  const maxRetries = getEnvInt('BUNDLE_EMBEDDING_MAX_RETRIES', 0) ?? 0;
  return { timeoutMs, maxRetries };
}

// senderId -> { collecting: true, messages: [], lastUpdate: number }
const senderBundles = new Map<string, BundleState>();
// senderId -> messages[] （等待活跃任务完成后处理）
const pendingMessagesByUser = new Map<string, MessageLike[]>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promiseFactory: () => Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promiseFactory();
  }

  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label || 'Operation'} timed out after ${timeoutMs}ms`) as Error & { code?: string };
          err.code = 'EMBED_TIMEOUT';
          reject(err);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeSenderId(conversationId: unknown): string {
  return String(conversationId ?? '');
}

let embeddingClient: OpenAIEmbeddings | null = null;
let embeddingInitFailed = false;

function resetEmbeddingClient(reason: string, changedKeys: string[] = []) {
  embeddingClient = null;
  embeddingInitFailed = false;
  try {
    logger.info('Embedding 客户端已重置（等待下次调用时重新初始化）', {
      reason: reason || 'env_reload',
      changedKeys
    });
  } catch { }
}

function shouldResetEmbeddingClientByEnvDiff(payload: { added?: string[]; updated?: string[]; removed?: string[] } | null | undefined): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const keys = new Set([
    ...(Array.isArray(payload.added) ? payload.added : []),
    ...(Array.isArray(payload.updated) ? payload.updated : []),
    ...(Array.isArray(payload.removed) ? payload.removed : [])
  ]);
  if (!keys.size) return true;
  const watchKeys = new Set([
    'EMBEDDING_API_KEY',
    'EMBEDDING_API_BASE_URL',
    'EMBEDDING_MODEL',
    'API_KEY',
    'API_BASE_URL'
  ]);
  for (const k of keys) {
    if (watchKeys.has(k)) return true;
  }
  return false;
}

onEnvReload((payload) => {
  try {
    if (!embeddingClient && !embeddingInitFailed) return;
    if (!shouldResetEmbeddingClientByEnvDiff(payload)) return;
    const changedKeys: string[] = Array.from(
      new Set<string>([
        ...(Array.isArray(payload?.added) ? payload.added : []),
        ...(Array.isArray(payload?.updated) ? payload.updated : []),
        ...(Array.isArray(payload?.removed) ? payload.removed : [])
      ])
    );
    resetEmbeddingClient('env_reload', changedKeys);
  } catch { }
});

function getEmbeddingClient() {
  if (embeddingClient || embeddingInitFailed) return embeddingClient;

  const apiKey = String(getEnv('EMBEDDING_API_KEY', getEnv('API_KEY')) || '');
  const baseURL = String(getEnv('EMBEDDING_API_BASE_URL', getEnv('API_BASE_URL')) || '');
  const model = String(getEnv('EMBEDDING_MODEL', 'text-embedding-3-small') || 'text-embedding-3-small');

  if (!apiKey) {
    embeddingInitFailed = true;
    logger.warn('Embedding 未启用: 缺少 EMBEDDING_API_KEY 或 API_KEY');
    return null;
  }

  try {
    const clientConfig: { apiKey: string; model: string; configuration?: { baseURL: string } } = { apiKey, model };
    if (baseURL) {
      clientConfig.configuration = { baseURL };
    }
    embeddingClient = new OpenAIEmbeddings(clientConfig);
    logger.info(`Embedding 已启用: model=${model}, baseURL=${baseURL || 'default'}`);
  } catch (e) {
    embeddingInitFailed = true;
    embeddingClient = null;
    logger.error('初始化 Embedding 客户端失败', e);
  }

  return embeddingClient;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      s += aVal * bVal;
    }
  }
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (typeof v === 'number') {
      s += v * v;
    }
  }
  return Math.sqrt(s) || 1;
}

export async function computeSemanticSimilarity(textA: string, textB: string): Promise<number | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!a || !b) return null;

  const { timeoutMs, maxRetries } = getEmbeddingConfig();
  const maxAttempts = Math.max(0, maxRetries) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const vectors = await withTimeout(
        () => client.embedDocuments([a, b]),
        timeoutMs,
        'Embedding 相似度计算'
      );

      if (!Array.isArray(vectors) || vectors.length < 2) {
        logger.warn('Embedding 相似度计算返回结果不完整，回退为纯时间聚合');
        return null;
      }

      const vA = vectors[0];
      const vB = vectors[1];
      if (!Array.isArray(vA) || !Array.isArray(vB)) {
        logger.warn('Embedding 相似度计算返回结果不完整，回退为纯时间聚合');
        return null;
      }
      if (vA.length === 0 || vB.length === 0) {
        logger.warn('Embedding 相似度计算返回结果不完整，回退为纯时间聚合');
        return null;
      }
      const aVals: number[] = [];
      for (const value of vA) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          aVals.push(value);
        }
      }
      const bVals: number[] = [];
      for (const value of vB) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          bVals.push(value);
        }
      }
      if (aVals.length === 0 || bVals.length === 0) {
        logger.warn('Embedding 相似度计算返回结果不完整，回退为纯时间聚合');
        return null;
      }
      const similarity = dot(aVals, bVals) / (norm(aVals) * norm(bVals));
      return similarity;
    } catch (e) {
      const err = e as Error & { code?: string };
      const isTimeout = err && err.code === 'EMBED_TIMEOUT';
      const reason = isTimeout ? '超时' : '失败';
      logger.warn(
        `Embedding 相似度计算${reason}，回退为纯时间聚合 (attempt=${attempt + 1}/${maxAttempts}, timeoutMs=${timeoutMs})`,
        { err: String(e) }
      );

      // 默认不重试：BUNDLE_EMBEDDING_MAX_RETRIES=0；即使配置了重试，也不会影响最终回复，只影响是否使用语义聚合
      if (attempt >= maxAttempts - 1) {
        return null;
      }
    }
  }

  return null;
}

function extractText(m: MessageLike | null | undefined): string {
  const t = (typeof m?.text === 'string' && m.text.trim()) ? m.text.trim() : '';
  const s = (typeof m?.summary === 'string' && m.summary.trim()) ? m.summary.trim() : '';
  return t || s || '';
}

/**
 * 处理新收到的消息：
 * - 若 sender 有打开的聚合窗口：
 *   - 使用 Embedding 计算 [已拼接文本] vs [新消息] 的语义相似度
 *   - 若相似度持续过低（超过阈值次数），视为新话题，转入 pending 队列
 *   - 否则追加到当前窗口
 * - 若无窗口但有活跃任务：加入延迟聚合队列并返回 { action: 'pending_queued' }
 * - 若既无窗口也无活跃任务：启动新的聚合窗口并返回 { action: 'start_bundle' }
 */
export async function handleIncomingMessage(
  conversationId: string,
  msg: MessageLike,
  { activeCount }: { activeCount: number }
): Promise<{ action: string }> {
  const key = normalizeSenderId(conversationId);
  if (!key) {
    return { action: 'ignore' };
  }

  const now = Date.now();
  const bucket = senderBundles.get(key);

  // 若已有聚合窗口，优先考虑追加（即使当前有活跃任务）
  if (bucket && bucket.collecting) {
    const { minSimilarity, maxLowSimCount, maxMessagesPerWindow } = getBundleTimingConfig();
    const textNew = extractText(msg);

    // 若新消息没有有效文本，直接按时间聚合处理
    if (!textNew) {
      bucket.messages.push(msg);
      if (Number.isFinite(maxMessagesPerWindow) && maxMessagesPerWindow > 0) {
        while (bucket.messages.length > maxMessagesPerWindow) {
          bucket.messages.shift();
        }
      }
      bucket.lastUpdate = now;
      bucket.lowSimCount = 0;
      logger.debug(`聚合: 文本为空，直接追加 (sender=${key}, count=${bucket.messages.length})`);
      return { action: 'buffered' };
    }

    // 构建已聚合文本（只用当前 bucket 内消息），用于与新消息计算相似度
    const aggText = bucket.messages.map(extractText).filter(Boolean).join('\n');

    let similarity = null;
    if (aggText) {
      similarity = await computeSemanticSimilarity(aggText, textNew);
    }

    if (similarity != null) {
      const simPercent = `${(similarity * 100).toFixed(1)}%`;
      const vioBefore = bucket.lowSimCount || 0;
      if (similarity < minSimilarity) {
        const vioAfter = vioBefore + 1;
        bucket.lowSimCount = vioAfter;
        logger.info(
          `聚合: 语义相似度偏低 (sender=${key}, sim=${simPercent}, violations=${vioAfter}/${maxLowSimCount})`
        );

        // 连续低相似超过阈值：认为用户已切换到新话题
        if (vioAfter >= maxLowSimCount) {
          let arr = pendingMessagesByUser.get(key);
          if (!arr) {
            arr = [];
            pendingMessagesByUser.set(key, arr);
          }
          arr.push(msg);
          logger.info(`聚合: 检测到连续低相似度消息，当前会话将尽快收束，新消息转入延迟队列 (sender=${key}, pending=${arr.length})`);
          // 注意：不更新 lastUpdate，让当前 bucket 按原有时间窗口完成
          return { action: 'pending_queued' };
        }

        // 尚未达到阈值：仍然允许加入当前窗口
        bucket.messages.push(msg);
        if (Number.isFinite(maxMessagesPerWindow) && maxMessagesPerWindow > 0) {
          while (bucket.messages.length > maxMessagesPerWindow) {
            bucket.messages.shift();
          }
        }
        bucket.lastUpdate = now;
        logger.info(
          `聚合: 相似度略低但未达分裂阈值，继续归入当前会话 (sender=${key}, sim=${simPercent}, count=${bucket.messages.length})`
        );
        return { action: 'buffered' };
      }

      // 相似度足够高：重置违例计数，继续聚合
      bucket.lowSimCount = 0;
      bucket.messages.push(msg);
      if (Number.isFinite(maxMessagesPerWindow) && maxMessagesPerWindow > 0) {
        while (bucket.messages.length > maxMessagesPerWindow) {
          bucket.messages.shift();
        }
      }
      bucket.lastUpdate = now;
      logger.info(
        `聚合: 语义相似度良好，追加到当前窗口 (sender=${key}, sim=${simPercent}, count=${bucket.messages.length})`
      );
      return { action: 'buffered' };
    }

    // 若相似度无法计算（Embedding 未启用或出错），回退为纯时间聚合
    bucket.messages.push(msg);
    if (Number.isFinite(maxMessagesPerWindow) && maxMessagesPerWindow > 0) {
      while (bucket.messages.length > maxMessagesPerWindow) {
        bucket.messages.shift();
      }
    }
    bucket.lastUpdate = now;
    logger.debug(`聚合: 相似度不可用，回退为时间聚合 (sender=${key}, count=${bucket.messages.length})`);
    return { action: 'buffered' };
  }

  // 无聚合窗口但存在活跃任务：进入延迟聚合队列
  if (activeCount > 0) {
    const bucket: BundleState = {
      collecting: true,
      messages: [msg],
      lastUpdate: now,
      lowSimCount: 0
    };
    senderBundles.set(key, bucket);
    logger.debug(`延迟聚合(override): 进入聚合队列等待 (sender=${key})`);
    return { action: 'pending_collect' };
  }

  // 没有活跃任务也没有聚合窗口 -> 新建窗口
  const newBucket: BundleState = {
    collecting: true,
    messages: [msg],
    lastUpdate: now,
    lowSimCount: 0
  };
  senderBundles.set(key, newBucket);
  logger.debug(`聚合: 启动新的聚合窗口 (sender=${key})`);
  return { action: 'start_bundle' };
}

/**
 * 队列任务启动时的聚合入口：
 * - 不考虑 activeCount，由上层的并发控制保证顺序
 */
export function startBundleForQueuedMessage(conversationId: string, msg: MessageLike): void {
  const key = normalizeSenderId(conversationId);
  const now = Date.now();
  const existing = senderBundles.get(key);
  if (existing && existing.collecting) {
    const { maxMessagesPerWindow } = getBundleTimingConfig();
    existing.messages.push(msg);
    if (Number.isFinite(maxMessagesPerWindow) && maxMessagesPerWindow > 0) {
      while (existing.messages.length > maxMessagesPerWindow) {
        existing.messages.shift();
      }
    }
    existing.lastUpdate = now;
    existing.lowSimCount = 0;
    logger.debug(`队列聚合: 复用现有窗口 (sender=${key}, count=${existing.messages.length})`);
  } else {
    const bucket: BundleState = { collecting: true, messages: [msg], lastUpdate: now, lowSimCount: 0 };
    senderBundles.set(key, bucket);
    logger.debug(`队列聚合: 启动新的聚合窗口 (sender=${key})`);
  }
}

export function getMessageBundlerStats(): { senderBundles: number; pendingUsers: number; pendingMessages: number; maxPendingPerUser: number } {
  const senderCount = senderBundles.size;
  const pendingUsers = pendingMessagesByUser.size;
  let pendingMessages = 0;
  let maxPendingPerUser = 0;
  for (const arr of pendingMessagesByUser.values()) {
    const n = Array.isArray(arr) ? arr.length : 0;
    pendingMessages += n;
    if (n > maxPendingPerUser) maxPendingPerUser = n;
  }
  return {
    senderBundles: senderCount,
    pendingUsers,
    pendingMessages,
    maxPendingPerUser,
  };
}

/**
 * 等待聚合窗口结束并返回合并后的消息
 */
export async function collectBundleForSender(conversationId: string): Promise<MessageLike | null> {
  const key = normalizeSenderId(conversationId);
  const bucket = senderBundles.get(key);
  if (!bucket) {
    return null;
  }

  const start = Date.now();
  const { windowMs, maxMs } = getBundleTimingConfig();
  const hasWindow = Number.isFinite(windowMs) && windowMs > 0;
  const hasMax = Number.isFinite(maxMs) && maxMs > 0;

  let endReason = 'idle';

  while (true) {
    const now = Date.now();
    const elapsed = now - start;
    const lastUpdate = bucket.lastUpdate || start;
    const sinceLast = now - lastUpdate;

    // 若整体等待时间已超过最大上限，则立即结束（防止长时间不收束）
    if (hasMax && elapsed >= maxMs) {
      endReason = 'max_wait';
      break;
    }

    // 若距离最后一条消息已静默至少一个窗口，则结束聚合
    if (hasWindow && sinceLast >= windowMs) {
      endReason = 'idle';
      break;
    }

    // 计算下一次睡眠时间：尽量睡到最近的一个阈值
    let waitMs = Infinity;

    if (hasWindow) {
      const remainIdle = windowMs - sinceLast;
      if (remainIdle > 0 && Number.isFinite(remainIdle)) {
        waitMs = Math.min(waitMs, remainIdle);
      }
    }

    if (hasMax) {
      const remainTotal = maxMs - elapsed;
      if (remainTotal > 0 && Number.isFinite(remainTotal)) {
        waitMs = Math.min(waitMs, remainTotal);
      }
    }

    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      // 回退为一个小的睡眠间隔，避免忙等
      waitMs = hasWindow ? windowMs : 50;
      if (!Number.isFinite(waitMs) || waitMs <= 0) {
        waitMs = 50;
      }
    }

    await sleep(waitMs);
  }

  bucket.collecting = false;
  senderBundles.delete(key);

  try {
    const now = Date.now();
    const durationMs = now - start;
    const idleMs = now - (bucket.lastUpdate || start);
    logger.debug(
      `聚合: 结束窗口 (sender=${key}, messages=${bucket.messages.length}, reason=${endReason}, durationMs=${durationMs}, idleMs=${idleMs})`
    );
  } catch { }

  // 组合文本
  const texts = bucket.messages.map((m) => {
    const t = (typeof m?.text === 'string' && m.text.trim()) ? m.text.trim() : '';
    const s = (typeof m?.summary === 'string' && m.summary.trim()) ? m.summary.trim() : '';
    return t || s || '';
  }).filter(Boolean);

  const combined = texts.join('\n');
  const firstMsg = bucket.messages[0] || {};
  const bundled = { ...firstMsg };
  if (combined) {
    bundled.text = combined;
    bundled.summary = combined;
  }
  return bundled;
}

/**
 * 任务完成后处理延迟聚合队列，将多条待处理消息合并为一条
 */
export function drainPendingMessagesForSender(conversationId: string): MessageLike | null {
  const key = normalizeSenderId(conversationId);
  const pendingMsgs = pendingMessagesByUser.get(key);
  if (!pendingMsgs || pendingMsgs.length === 0) {
    return null;
  }
  pendingMessagesByUser.delete(key);

  const texts = pendingMsgs.map((m) => {
    const t = (typeof m?.text === 'string' && m.text.trim()) ? m.text.trim() : '';
    const s = (typeof m?.summary === 'string' && m.summary.trim()) ? m.summary.trim() : '';
    return t || s || '';
  }).filter(Boolean);

  const combined = texts.join('\n');
  const mergedMsg = { ...pendingMsgs[0] };
  if (combined) {
    mergedMsg.text = combined;
    mergedMsg.summary = combined;
  }

  const reversed: MessageLike[] = [];
  for (let i = pendingMsgs.length - 1; i >= 0; i--) {
    const item = pendingMsgs[i];
    if (item) reversed.push(item);
  }
  const flagSource = reversed.find(
    (m) => m && (m._forceReply || m._forcePendingHold || m._forceNoReply || m._overrideDecision)
  );
  if (flagSource) {
    if (flagSource._forceReply) mergedMsg._forceReply = true;
    if (flagSource._forcePendingHold) mergedMsg._forcePendingHold = true;
    if (flagSource._forceNoReply) mergedMsg._forceNoReply = true;
    if (flagSource._overrideDecision) mergedMsg._overrideDecision = flagSource._overrideDecision;
  }

  logger.info(`Delayed bundle drain: sender=${key}, merged=${pendingMsgs.length}`);
  return mergedMsg;
}

export function requeuePendingMessageForSender(conversationId: string, msg: MessageLike): void {
  const key = normalizeSenderId(conversationId);
  if (!key || !msg) return;
  let arr = pendingMessagesByUser.get(key);
  if (!arr) {
    arr = [];
    pendingMessagesByUser.set(key, arr);
  }
  arr.push(msg);
  logger.debug(`Delayed bundle: requeued pending message (sender=${key}, pending=${arr.length})`);
}

