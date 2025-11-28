import { createLogger } from './logger.js';
import { OpenAIEmbeddings } from '@langchain/openai';

const logger = createLogger('MessageBundler');

const BUNDLE_WINDOW_MS = parseInt(process.env.BUNDLE_WINDOW_MS || '5000', 10);
const BUNDLE_MAX_MS = parseInt(process.env.BUNDLE_MAX_MS || '15000', 10);
const BUNDLE_MIN_SIMILARITY = parseFloat(process.env.BUNDLE_MIN_SIMILARITY || '0.6');
const BUNDLE_MAX_LOW_SIM_COUNT = parseInt(process.env.BUNDLE_MAX_LOW_SIM_COUNT || '2', 10);

// senderId -> { collecting: true, messages: [], lastUpdate: number }
const senderBundles = new Map();
// senderId -> messages[] （等待活跃任务完成后处理）
const pendingMessagesByUser = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeSenderId(senderId) {
  return String(senderId ?? '');
}

let embeddingClient = null;
let embeddingInitFailed = false;

function getEmbeddingClient() {
  if (embeddingClient || embeddingInitFailed) return embeddingClient;

  const apiKey = process.env.EMBEDDING_API_KEY || process.env.API_KEY;
  const baseURL = process.env.EMBEDDING_API_BASE_URL || process.env.API_BASE_URL;
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

  if (!apiKey) {
    embeddingInitFailed = true;
    logger.warn('Embedding 未启用: 缺少 EMBEDDING_API_KEY 或 API_KEY');
    return null;
  }

  try {
    embeddingClient = new OpenAIEmbeddings({
      apiKey,
      model,
      configuration: baseURL ? { baseURL } : undefined
    });
    logger.info(`Embedding 已启用: model=${model}, baseURL=${baseURL || 'default'}`);
  } catch (e) {
    embeddingInitFailed = true;
    embeddingClient = null;
    logger.error('初始化 Embedding 客户端失败', e);
  }

  return embeddingClient;
}

function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s) || 1;
}

export async function computeSemanticSimilarity(textA, textB) {
  const client = getEmbeddingClient();
  if (!client) return null;

  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!a || !b) return null;

  try {
    const vectors = await client.embedDocuments([a, b]);
    if (!Array.isArray(vectors) || vectors.length < 2) return null;
    const vA = vectors[0];
    const vB = vectors[1];
    const similarity = dot(vA, vB) / (norm(vA) * norm(vB));
    return similarity;
  } catch (e) {
    logger.warn('Embedding 相似度计算失败，回退为纯时间聚合', { err: String(e) });
    return null;
  }
}

function extractText(m) {
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
export async function handleIncomingMessage(senderId, msg, { activeCount }) {
  const key = normalizeSenderId(senderId);
  if (!key) {
    return { action: 'ignore' };
  }

  const now = Date.now();
  const bucket = senderBundles.get(key);

  // 若已有聚合窗口，优先考虑追加（即使当前有活跃任务）
  if (bucket && bucket.collecting) {
    const textNew = extractText(msg);

    // 若新消息没有有效文本，直接按时间聚合处理
    if (!textNew) {
      bucket.messages.push(msg);
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
      if (similarity < BUNDLE_MIN_SIMILARITY) {
        const vioAfter = vioBefore + 1;
        bucket.lowSimCount = vioAfter;
        logger.info(
          `聚合: 语义相似度偏低 (sender=${key}, sim=${simPercent}, violations=${vioAfter}/${BUNDLE_MAX_LOW_SIM_COUNT})`
        );

        // 连续低相似超过阈值：认为用户已切换到新话题
        if (vioAfter >= BUNDLE_MAX_LOW_SIM_COUNT) {
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
        bucket.lastUpdate = now;
        logger.info(
          `聚合: 相似度略低但未达分裂阈值，继续归入当前会话 (sender=${key}, sim=${simPercent}, count=${bucket.messages.length})`
        );
        return { action: 'buffered' };
      }

      // 相似度足够高：重置违例计数，继续聚合
      bucket.lowSimCount = 0;
      bucket.messages.push(msg);
      bucket.lastUpdate = now;
      logger.info(
        `聚合: 语义相似度良好，追加到当前窗口 (sender=${key}, sim=${simPercent}, count=${bucket.messages.length})`
      );
      return { action: 'buffered' };
    }

    // 若相似度无法计算（Embedding 未启用或出错），回退为纯时间聚合
    bucket.messages.push(msg);
    bucket.lastUpdate = now;
    logger.debug(`聚合: 相似度不可用，回退为时间聚合 (sender=${key}, count=${bucket.messages.length})`);
    return { action: 'buffered' };
  }

  // 无聚合窗口但存在活跃任务：进入延迟聚合队列
  if (activeCount > 0) {
    let arr = pendingMessagesByUser.get(key);
    if (!arr) {
      arr = [];
      pendingMessagesByUser.set(key, arr);
    }
    arr.push(msg);
    logger.debug(`延迟聚合: 用户${key} 有 ${activeCount} 个活跃任务，消息已加入待处理队列 (当前 ${arr.length} 条)`);
    return { action: 'pending_queued' };
  }

  // 没有活跃任务也没有聚合窗口 -> 新建窗口
  const newBucket = {
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
export function startBundleForQueuedMessage(senderId, msg) {
  const key = normalizeSenderId(senderId);
  const now = Date.now();
  const existing = senderBundles.get(key);
  if (existing && existing.collecting) {
    existing.messages.push(msg);
    existing.lastUpdate = now;
    existing.lowSimCount = 0;
    logger.debug(`队列聚合: 复用现有窗口 (sender=${key}, count=${existing.messages.length})`);
  } else {
    const bucket = { collecting: true, messages: [msg], lastUpdate: now, lowSimCount: 0 };
    senderBundles.set(key, bucket);
    logger.debug(`队列聚合: 启动新的聚合窗口 (sender=${key})`);
  }
}

/**
 * 等待聚合窗口结束并返回合并后的消息
 */
export async function collectBundleForSender(senderId) {
  const key = normalizeSenderId(senderId);
  const bucket = senderBundles.get(key);
  if (!bucket) {
    return null;
  }

  const start = Date.now();
  while (true) {
    const snap = bucket.lastUpdate;
    await sleep(BUNDLE_WINDOW_MS);
    const elapsed = Date.now() - start;
    // 若窗口期间有新消息，且未超过最大等待，则继续等待一个窗口
    if (bucket.lastUpdate > snap && elapsed < BUNDLE_MAX_MS) {
      continue;
    }
    break;
  }

  bucket.collecting = false;
  senderBundles.delete(key);

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
export function drainPendingMessagesForSender(senderId) {
  const key = normalizeSenderId(senderId);
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

  logger.info(`延迟聚合触发: 用户${key} 活跃任务完成，合并 ${pendingMsgs.length} 条待处理消息`);
  return mergedMsg;
}
