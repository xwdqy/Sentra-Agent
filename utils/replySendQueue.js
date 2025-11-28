/**
 * 回复发送队列管理器
 * 确保回复按顺序发送，避免多个任务同时完成时消息交错
 */

import { createLogger } from './logger.js';
import { computeSemanticSimilarity } from './messageBundler.js';
import { decideSendDedupPair } from './replyIntervention.js';

const logger = createLogger('ReplySendQueue');
const SEND_DEDUP_MIN_SIMILARITY = parseFloat(process.env.SEND_DEDUP_MIN_SIMILARITY || '0.8');
const PURE_REPLY_SKIP_THRESHOLD = parseInt(process.env.PURE_REPLY_SKIP_THRESHOLD || '3', 10);
const PURE_REPLY_SKIP_COOLDOWN_MS = parseInt(process.env.PURE_REPLY_SKIP_COOLDOWN_MS || '300000', 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ReplySendQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.sendDelayMs = parseInt(process.env.REPLY_SEND_DELAY_MS || '2000'); // 默认2秒
    this.pureReplyCooldown = new Map();
    logger.info(`回复发送队列初始化 - 发送间隔: ${this.sendDelayMs}ms`);
  }

  /**
   * 添加发送任务到队列
   * @param {Function} sendTask - 发送任务函数（返回 Promise）
   * @param {string} taskId - 任务标识（用于日志）
   * @param {Object} meta - 可选的元信息（例如 { groupId, response }），用于查重
   * @returns {Promise} 发送结果
   */
  async enqueue(sendTask, taskId = 'unknown', meta = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({ sendTask, taskId, meta, resolve, reject });
      logger.debug(`任务入队: ${taskId} (队列长度: ${this.queue.length})`);
      
      // 如果当前没有在处理，立即开始处理
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * 处理队列中的任务
   */
  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const first = this.queue.shift();
      const batch = [first];
      const groupId = first?.meta?.groupId ? String(first.meta.groupId) : null;

      // 在发送前等待一个窗口，收集同一会话的其他待发送任务，用于语义去重
      if (groupId) {
        logger.debug(`等待 ${this.sendDelayMs}ms 收集同一会话的待发送回复用于去重 (groupId=${groupId})...`);
        await sleep(this.sendDelayMs);

        const remaining = [];
        for (const item of this.queue) {
          const gid = item?.meta?.groupId ? String(item.meta.groupId) : null;
          if (gid && gid === groupId) {
            batch.push(item);
          } else {
            remaining.push(item);
          }
        }
        this.queue = remaining;
        logger.debug(`发送阶段语义去重批次组装完成: groupId=${groupId}, 批次大小=${batch.length}, 队列剩余=${this.queue.length}`);
      }

      let selectedIndices = null;

      // 纯文本连续回复（无工具调用）优化：在同一批次内，如果全部都是 hasTool=false 且数量达到阈值，
      // 并且未处于冷却期，则直接仅保留最新一条，跳过语义去重（embedding + 轻量 LLM）。
      if (
        groupId &&
        PURE_REPLY_SKIP_THRESHOLD > 0 &&
        batch.length >= PURE_REPLY_SKIP_THRESHOLD
      ) {
        const now = Date.now();
        const cooldownUntil = this.pureReplyCooldown.get(groupId) || 0;
        const allNoTool = batch.every((item) => item?.meta && item.meta.hasTool === false);

        if (allNoTool && now >= cooldownUntil) {
          selectedIndices = [batch.length - 1];
          this.pureReplyCooldown.set(groupId, now + PURE_REPLY_SKIP_COOLDOWN_MS);
          logger.info(
            `纯文本连续回复优化触发: groupId=${groupId}, 批次大小=${batch.length}, 阈值=${PURE_REPLY_SKIP_THRESHOLD}, 冷却=${PURE_REPLY_SKIP_COOLDOWN_MS}ms`
          );
        }
      }

      if (!selectedIndices) {
        selectedIndices = await this._dedupBatch(batch);
      }
      const selectedSet = new Set(selectedIndices);

      for (let i = 0; i < batch.length; i++) {
        const { sendTask, taskId, resolve, reject } = batch[i];

        if (!selectedSet.has(i)) {
          logger.info(`发送阶段去重: 跳过任务 ${taskId}`);
          resolve(null);
          continue;
        }

        logger.info(`开始发送: ${taskId} (剩余队列: ${this.queue.length})`);

        try {
          const startTime = Date.now();
          const result = await sendTask();
          const duration = Date.now() - startTime;
          
          logger.success(`发送完成: ${taskId} (耗时: ${duration}ms)`);
          resolve(result);
        } catch (error) {
          logger.error(`发送失败: ${taskId}`, error);
          reject(error);
        }

        // 如果后续还有需要发送的任务（当前批次或后续队列），按照配置的间隔等待
        const hasMoreInBatch = (() => {
          for (let j = i + 1; j < batch.length; j++) {
            if (selectedSet.has(j)) return true;
          }
          return false;
        })();

        if (hasMoreInBatch || this.queue.length > 0) {
          logger.debug(`等待 ${this.sendDelayMs}ms 后发送下一条...`);
          await sleep(this.sendDelayMs);
        }
      }
    }

    this.isProcessing = false;
    logger.debug('队列处理完毕');
  }

  /**
   * 对同一批次的待发送任务执行语义去重，返回需要真正发送的任务下标列表
   * @param {Array} batch
   * @returns {Promise<number[]>}
   */
  async _dedupBatch(batch) {
    const n = Array.isArray(batch) ? batch.length : 0;
    if (n <= 1) {
      logger.debug(`发送阶段去重: 批次大小=${n}，无需去重`);
      return n === 1 ? [0] : [];
    }

    logger.debug(`发送阶段去重开始: 批次大小=${n}`);

    const keep = new Array(n).fill(true);

    for (let j = 0; j < n; j++) {
      const metaJ = batch[j]?.meta || {};
      const textJ = (metaJ.textForDedup || '').trim();
      if (!textJ) continue;

      for (let i = 0; i < j; i++) {
        if (!keep[i]) continue;
        const metaI = batch[i]?.meta || {};
        const textI = (metaI.textForDedup || '').trim();
        if (!textI) continue;

        const { areSimilar } = await this._judgePairSimilarity(textI, textJ);
        if (areSimilar) {
          // 倾向保留时间更晚的那条：丢弃较早的 i，保留 j
          keep[i] = false;
        }
      }
    }

    const indices = [];
    for (let idx = 0; idx < n; idx++) {
      if (keep[idx]) indices.push(idx);
    }
    logger.debug(`发送阶段去重完成: 保留=${indices.length}, 丢弃=${n - indices.length}`);
    return indices;
  }

  /**
   * 使用向量相似度 + 轻量 LLM 工具共同判断两个文本是否语义重复
   * @param {string} textA
   * @param {string} textB
   * @returns {Promise<{areSimilar: boolean, embeddingSim: number|null}>}
   */
  async _judgePairSimilarity(textA, textB) {
    const a = (textA || '').trim();
    const b = (textB || '').trim();
    if (!a || !b) {
      return { areSimilar: false, embeddingSim: null };
    }

    let embeddingSim = null;
    let llmResult = null;

    await Promise.all([
      (async () => {
        try {
          embeddingSim = await computeSemanticSimilarity(a, b);
        } catch {
          embeddingSim = null;
        }
      })(),
      (async () => {
        try {
          llmResult = await decideSendDedupPair(a, b);
        } catch {
          llmResult = null;
        }
      })()
    ]);

    let areSimilar = false;

    // 优先使用 LLM 的结构化判断
    if (llmResult && typeof llmResult.areSimilar === 'boolean') {
      areSimilar = llmResult.areSimilar;
    } else if (embeddingSim != null && embeddingSim >= SEND_DEDUP_MIN_SIMILARITY) {
      // LLM 不可用时，回退为仅基于向量相似度
      areSimilar = true;
    }

    return { areSimilar, embeddingSim };
  }

  /**
   * 获取队列长度
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * 清空队列
   */
  clear() {
    const count = this.queue.length;
    this.queue = [];
    logger.warn(`清空队列: ${count} 个任务被取消`);
    return count;
  }
}

// 导出单例
export const replySendQueue = new ReplySendQueue();
