/**
 * 回复发送队列管理器
 * 确保回复按顺序发送，避免多个任务同时完成时消息交错
 */

import { createLogger } from './logger.js';
import { getEnvInt, getEnvBool, onEnvReload } from './envHotReloader.js';
import { judgeReplySimilarity } from './replySimilarityJudge.js';
import { decideSendFusionBatch } from './replyIntervention.js';
import { parseSentraResponse } from './protocolUtils.js';
import { escapeXml } from './xmlUtils.js';

const logger = createLogger('ReplySendQueue');

type SendQueueRuntimeConfig = {
  sendDelayMs: number;
  pureReplySkipThreshold: number;
  pureReplySkipCooldownMs: number;
  sendFusionEnabled: boolean;
  sendFusionMinBatch: number;
  recentDedupEnabled: boolean;
  recentDedupTtlMs: number;
  recentDedupMaxPerGroup: number;
  recentDedupStrictForPrivate: boolean;
  groupReplyMinIntervalMs: number;
  userReplyMinIntervalMs: number;
};

type SendMeta = {
  groupId?: string | number;
  meta?: { groupId?: string | number; [key: string]: unknown };
  response?: string;
  immediate?: boolean;
  hasTool?: boolean;
  allowReply?: boolean;
  textForDedup?: string;
  resourceKeys?: string[];
  _dedupInfo?: { byTaskId?: string; similarity?: number | null };
  [key: string]: unknown;
};

type QueueItem = {
  sendTask: () => Promise<unknown>;
  taskId: string;
  meta: SendMeta | null;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type FusionCandidate = { taskId: string; text: string };
type ReplyResource = { type: string; source: string; caption?: string | undefined };
type ReplyEmoji = { source: string; caption?: string | undefined };

type RecentSentEntry = { text: string; resources: string[]; ts: number };

function readEnvInt(name: string, fallback: number): number {
  const raw = getEnvInt(name, fallback);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = getEnvBool(name, fallback);
  return raw === undefined ? fallback : raw;
}

function getSendQueueRuntimeConfig(): SendQueueRuntimeConfig {
  return {
    sendDelayMs: readEnvInt('REPLY_SEND_DELAY_MS', 20000),
    pureReplySkipThreshold: readEnvInt('PURE_REPLY_SKIP_THRESHOLD', 3),
    pureReplySkipCooldownMs: readEnvInt('PURE_REPLY_SKIP_COOLDOWN_MS', 300000),
    sendFusionEnabled: readEnvBool('SEND_FUSION_ENABLED', false),
    sendFusionMinBatch: readEnvInt('SEND_FUSION_MIN_BATCH', 2),
    recentDedupEnabled: readEnvBool('SEND_RECENT_FUSION_ENABLED', true),
    recentDedupTtlMs: readEnvInt('SEND_RECENT_FUSION_TTL_MS', 600000),
    recentDedupMaxPerGroup: readEnvInt('SEND_RECENT_FUSION_MAX_PER_GROUP', 20),
    recentDedupStrictForPrivate: readEnvBool('SEND_RECENT_FUSION_STRICT_FOR_PRIVATE', true),
    groupReplyMinIntervalMs: readEnvInt('GROUP_REPLY_MIN_INTERVAL_MS', 2000),
    userReplyMinIntervalMs: readEnvInt('USER_REPLY_MIN_INTERVAL_MS', 10000)
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function takeLast<T>(arr: T[], count: number): T[] {
  if (!Array.isArray(arr) || count <= 0) return [];
  const start = arr.length - count;
  const out: T[] = [];
  for (let i = start < 0 ? 0 : start; i < arr.length; i++) {
    const item = arr[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

class ReplySendQueue {
  queue: QueueItem[];
  isProcessing: boolean;
  sendDelayMs: number;
  pureReplyCooldown: Map<string, number>;
  recentSentByGroup: Map<string, RecentSentEntry[]>;

  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.sendDelayMs = readEnvInt('REPLY_SEND_DELAY_MS', 20000); // 默认20秒
    this.pureReplyCooldown = new Map();
    this.recentSentByGroup = new Map(); // Map<groupId, Array<{ text, resources, ts }>>
    logger.info(`回复发送队列初始化 - 发送间隔: ${this.sendDelayMs}ms`);

    onEnvReload(() => {
      const nextDelay = readEnvInt('REPLY_SEND_DELAY_MS', 20000);
      if (Number.isFinite(nextDelay) && nextDelay > 0 && nextDelay !== this.sendDelayMs) {
        this.sendDelayMs = nextDelay;
        logger.info(`发送队列配置热更新: REPLY_SEND_DELAY_MS=${this.sendDelayMs}ms`);
      }
    });
  }

  _getPostSendDelayMs(meta: SendMeta | null | undefined, runtimeCfg: SendQueueRuntimeConfig): number {
    const immediate = !!meta?.immediate;
    if (!immediate) return this.sendDelayMs;

    const gid = meta?.groupId ? String(meta.groupId) : '';
    const isGroup = gid.startsWith('G:');
    const base = isGroup
      ? Number(runtimeCfg?.groupReplyMinIntervalMs)
      : Number(runtimeCfg?.userReplyMinIntervalMs);
    if (!Number.isFinite(base) || base < 0) return 0;
    return base;
  }

  /**
   * 添加发送任务到队列
   * @param {Function} sendTask - 发送任务函数（返回 Promise）
   * @param {string} taskId - 任务标识（用于日志）
   * @param {Object} meta - 可选的元信息（例如 { groupId, response }），用于查重
   * @returns {Promise} 发送结果
   */
  async enqueue(sendTask: () => Promise<unknown>, taskId = 'unknown', meta: SendMeta | null = null): Promise<unknown> {
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
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      this._prunePureReplyCooldown();
    } catch { }

    try {
      this._pruneAllRecentLists();
    } catch { }

    while (this.queue.length > 0) {
      const first = this.queue.shift();
      if (!first) continue;
      const batch: QueueItem[] = [first];
      const groupId = first.meta?.groupId ? String(first.meta.groupId) : null;
      const immediate = !!first.meta?.immediate;

      const runtimeCfg = getSendQueueRuntimeConfig();

      // 在发送前等待一个窗口，收集同一会话的其他待发送任务，用于语义去重
      if (groupId && !immediate) {
        logger.debug(`等待 ${this.sendDelayMs}ms 收集同一会话的待发送回复用于去重 (groupId=${groupId})...`);
        await sleep(this.sendDelayMs);

        const remaining: QueueItem[] = [];
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
      } else if (groupId && immediate) {
        logger.debug(`immediate send: 跳过收集窗口等待 (groupId=${groupId})`);
      }

      let selectedIndices: number[] | null = null;

      if (
        groupId &&
        runtimeCfg.sendFusionEnabled &&
        runtimeCfg.sendFusionMinBatch > 1 &&
        batch.length >= runtimeCfg.sendFusionMinBatch
      ) {
        try {
          const candidates: FusionCandidate[] = [];
          const resources: ReplyResource[] = [];
          let emoji: ReplyEmoji | null = null;
          let hasTool = false;
          const routingKeys = new Set();

          for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            const meta: SendMeta = item?.meta || {};
            const raw = typeof meta.response === 'string' ? meta.response : '';
            let parsed = null;
            try {
              parsed = parseSentraResponse(raw);
            } catch {
              parsed = null;
            }

            const segments = parsed && Array.isArray(parsed.textSegments)
              ? parsed.textSegments.map((t) => (t || '').trim()).filter(Boolean)
              : [];

            if (segments.length > 0) {
              candidates.push({ taskId: item?.taskId || '', text: segments.join('\n') });
            }

            const rs = parsed && Array.isArray(parsed.resources) ? parsed.resources : [];
            for (const r of rs) {
              if (!r || !r.type || !r.source) continue;
              resources.push(r);
            }

            if (groupId) {
              let rk = null;
              if (parsed && parsed.group_id != null && String(parsed.group_id).trim() !== '') {
                rk = `G:${String(parsed.group_id).trim()}`;
              } else if (parsed && parsed.user_id != null && String(parsed.user_id).trim() !== '') {
                rk = `U:${String(parsed.user_id).trim()}`;
              }
              // 未显式指定目标时，视为当前批次目标
              routingKeys.add(rk || groupId);
            }

            if (parsed && parsed.emoji && parsed.emoji.source) {
              emoji = parsed.emoji;
            }

            if (meta && meta.hasTool === true) {
              hasTool = true;
            }
          }

          if (routingKeys.size > 0) {
            // 允许融合的前提：全部都发往当前 batch 的同一目标（同一群或同一私聊）
            // 例如：批次 groupId=G:123，所有 routed 也必须是 G:123
            const keys = Array.from(routingKeys);
            const allSameTarget = keys.every((k) => k === groupId);
            if (!allSameTarget) {
              throw new Error(`skip_send_fusion_due_to_target_routing:${keys.join(',')}`);
            }
          }

          const fusion = await decideSendFusionBatch({ groupId, userQuestion: '', candidates });
          if (fusion && Array.isArray(fusion.textSegments) && fusion.textSegments.length > 0) {
            const uniqRes: ReplyResource[] = [];
            const seenRes = new Set<string>();
            for (const r of resources) {
              const k = `${r.type}|${r.source}`;
              if (seenRes.has(k)) continue;
              seenRes.add(k);
              uniqRes.push(r);
            }

            const lines: string[] = [];
            lines.push('<sentra-response>');
            for (let i = 0; i < fusion.textSegments.length; i++) {
              const idx = i + 1;
              lines.push(`  <text${idx}>${escapeXml(fusion.textSegments[i])}</text${idx}>`);
            }

            if (uniqRes.length > 0) {
              lines.push('  <resources>');
              for (const r of uniqRes) {
                lines.push('    <resource>');
                lines.push(`      <type>${escapeXml(r.type)}</type>`);
                lines.push(`      <source>${escapeXml(r.source)}</source>`);
                if (r.caption) {
                  lines.push(`      <caption>${escapeXml(r.caption)}</caption>`);
                }
                lines.push('    </resource>');
              }
              lines.push('  </resources>');
            } else {
              lines.push('  <resources></resources>');
            }

            if (emoji && emoji.source) {
              lines.push('  <emoji>');
              lines.push(`    <source>${escapeXml(emoji.source)}</source>`);
              if (emoji.caption) {
                lines.push(`    <caption>${escapeXml(emoji.caption)}</caption>`);
              }
              lines.push('  </emoji>');
            }

            lines.push('</sentra-response>');
            const fusedResponse = lines.join('\n');

            const selectedIndex = batch.length - 1;
            const selected = batch[selectedIndex];
            if (selected && selected.meta) {
              selected.meta.response = fusedResponse;
              selected.meta.textForDedup = fusion.textSegments.join('\n');
              const baseKeys = uniqRes.map((r) => `${r.type}|${r.source}`);
              if (emoji && emoji.source) {
                baseKeys.push(`emoji|${emoji.source}`);
              }
              selected.meta.resourceKeys = Array.from(new Set(baseKeys));
              selected.meta.hasTool = hasTool;
              selected.meta.allowReply = true;
            }

            for (let i = 0; i < batch.length; i++) {
              if (i === selectedIndex) continue;
              const item = batch[i];
              if (item && item.meta) {
                item.meta.allowReply = false;
              }
            }

            selectedIndices = [selectedIndex];
            logger.info(`发送阶段融合触发: groupId=${groupId}, 批次大小=${batch.length}, 仅发送=1`);
          }
        } catch (e) {
          logger.warn('发送阶段融合失败，将回退为去重/逐条发送', { err: String(e) });
        }
      }

      // 纯文本连续回复（无工具调用）优化：在同一批次内，如果全部都是 hasTool=false 且数量达到阈值，
      // 并且未处于冷却期，则直接仅保留最新一条，跳过语义去重（embedding + 轻量 LLM）。
      if (groupId && runtimeCfg.pureReplySkipThreshold > 0 && batch.length >= runtimeCfg.pureReplySkipThreshold) {
        const now = Date.now();
        const cooldownUntil = this.pureReplyCooldown.get(groupId) || 0;
        const allNoTool = batch.every((item) => item?.meta && item.meta.hasTool === false);

        if (allNoTool && now >= cooldownUntil) {
          selectedIndices = [batch.length - 1];
          this.pureReplyCooldown.set(groupId, now + runtimeCfg.pureReplySkipCooldownMs);
          logger.info(
            `纯文本连续回复优化触发: groupId=${groupId}, 批次大小=${batch.length}, 阈值=${runtimeCfg.pureReplySkipThreshold}, 冷却=${runtimeCfg.pureReplySkipCooldownMs}ms`
          );
        }
      }

      if (!selectedIndices) {
        selectedIndices = await this._dedupBatch(batch);
      }
      const selectedSet = new Set(selectedIndices);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        if (!item) continue;
        const { sendTask, taskId, meta, resolve, reject } = item;

        if (!selectedSet.has(i)) {
          const dedupInfo = meta && meta._dedupInfo;
          if (dedupInfo && dedupInfo.similarity != null) {
            const simVal =
              typeof dedupInfo.similarity === 'number' && !Number.isNaN(dedupInfo.similarity)
                ? dedupInfo.similarity.toFixed(3)
                : String(dedupInfo.similarity);
            logger.info(
              `发送阶段去重: 跳过任务 ${taskId}, by=${dedupInfo.byTaskId || 'unknown'}, sim=${simVal}`
            );
          } else {
            logger.info(`发送阶段去重: 跳过任务 ${taskId}`);
          }
          resolve(null);
          continue;
        }

        const groupIdForRecent = meta?.meta && meta.meta.groupId
          ? String(meta.meta.groupId)
          : (meta?.groupId ? String(meta.groupId) : null);
        const textForRecent = (meta?.textForDedup || '').trim();
        const resourcesForRecent = Array.isArray(meta?.resourceKeys) ? meta.resourceKeys : [];
        const hasTextOrResourceForRecent = !!textForRecent || resourcesForRecent.length > 0;

        // 跨批次/跨轮的最近已发送去重：仅在资源集合完全一致的前提下，避免在同一会话里前后两轮说几乎一样的话
        if (groupIdForRecent && hasTextOrResourceForRecent && meta && !meta.immediate) {
          try {
            const recentAction = await this._applyRecentDedupAndMaybeRewrite(groupIdForRecent, meta);
            if (recentAction) {
              logger.info(
                `最近发送去重: 跳过任务 ${taskId} (groupId=${groupIdForRecent})`
              );
              resolve(null);
              continue;
            }
          } catch (e) {
            logger.warn('最近发送去重判断失败（已忽略）', { err: String(e) });
          }
        }

        logger.info(`开始发送: ${taskId} (剩余队列: ${this.queue.length})`);

        try {
          const startTime = Date.now();
          const result = await sendTask();
          const duration = Date.now() - startTime;

          logger.success(`发送完成: ${taskId} (耗时: ${duration}ms)`);
          if (groupIdForRecent && hasTextOrResourceForRecent) {
            this._rememberRecentSent(
              groupIdForRecent,
              (meta?.textForDedup || '').trim(),
              Array.isArray(meta?.resourceKeys) ? meta.resourceKeys : []
            );
          }
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
          const postDelayMs = this._getPostSendDelayMs(meta, runtimeCfg);
          if (postDelayMs > 0) {
            logger.debug(`等待 ${postDelayMs}ms 后发送下一条...`);
            await sleep(postDelayMs);
          }
        }
      }
    }

    this.isProcessing = false;
    this._prunePureReplyCooldown();
    try {
      this._pruneAllRecentLists();
    } catch { }
    logger.debug('队列处理完毕');
  }

  _prunePureReplyCooldown(now: number = Date.now()) {
    const max = readEnvInt('PURE_REPLY_COOLDOWN_MAX_KEYS', 500);
    for (const [k, until] of this.pureReplyCooldown.entries()) {
      const u = Number(until);
      if (!Number.isFinite(u) || u <= now) {
        this.pureReplyCooldown.delete(k);
      }
    }

    if (Number.isFinite(max) && max > 0) {
      while (this.pureReplyCooldown.size > max) {
        const firstKey = this.pureReplyCooldown.keys().next().value;
        if (!firstKey) break;
        this.pureReplyCooldown.delete(firstKey);
      }
    }
  }

  getStats() {
    const recentGroups = this.recentSentByGroup.size;
    let recentItems = 0;
    for (const list of this.recentSentByGroup.values()) {
      if (Array.isArray(list)) recentItems += list.length;
    }
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      pureReplyCooldownKeys: this.pureReplyCooldown.size,
      recentGroups,
      recentItems,
    };
  }

  /**
   * 对同一批次的待发送任务执行语义去重，返回需要真正发送的任务下标列表
   * @param {Array} batch
   * @returns {Promise<number[]>}
   */
  async _dedupBatch(batch: QueueItem[]): Promise<number[]> {
    const n = Array.isArray(batch) ? batch.length : 0;
    if (n <= 1) {
      logger.debug(`发送阶段去重: 批次大小=${n}，无需去重`);
      return n === 1 ? [0] : [];
    }

    logger.debug(`发送阶段去重开始: 批次大小=${n}`);

    const keep: boolean[] = new Array(n).fill(true);

    for (let j = 0; j < n; j++) {
      const metaJ: SendMeta = batch[j]?.meta || {};
      const textJ = (metaJ.textForDedup || '').trim();
      const resourcesJ = Array.isArray(metaJ.resourceKeys) ? metaJ.resourceKeys : [];
      const hasTextJ = !!textJ;
      const hasResJ = resourcesJ.length > 0;

      if (!hasTextJ && !hasResJ) continue;

      if (!hasTextJ) {
        const prevResources = new Set<string>();
        for (let i = 0; i < j; i++) {
          if (!keep[i]) continue;
          const metaI: SendMeta = batch[i]?.meta || {};
          const resourcesI = Array.isArray(metaI.resourceKeys) ? metaI.resourceKeys : [];
          for (const k of resourcesI) prevResources.add(k);
        }
        const diffKeys = resourcesJ.filter((k) => !prevResources.has(k));
        if (diffKeys.length === 0) {
          keep[j] = false;
        } else {
          metaJ.resourceKeys = diffKeys;
          metaJ.response = this._buildResourcesOnlyResponse(metaJ.response, diffKeys);
        }
        continue;
      }

      let foundSimilar = false;
      let bestSim: number | null = null;
      let bestTaskId = '';
      const prevUnionAll = new Set<string>();

      for (let i = 0; i < j; i++) {
        if (!keep[i]) continue;
        const metaI: SendMeta = batch[i]?.meta || {};
        const resourcesI = Array.isArray(metaI.resourceKeys) ? metaI.resourceKeys : [];
        for (const k of resourcesI) prevUnionAll.add(k);
      }

      for (let i = 0; i < j; i++) {
        if (!keep[i]) continue;
        const metaI: SendMeta = batch[i]?.meta || {};
        const textI = (metaI.textForDedup || '').trim();
        if (!textI) continue;

        const r = await this._judgePairSimilarity(textI, textJ);
        if (!r.areSimilar) continue;

        foundSimilar = true;
        if (typeof r.embeddingSim === 'number' && !Number.isNaN(r.embeddingSim)) {
          if (bestSim == null || r.embeddingSim > bestSim) {
            bestSim = r.embeddingSim;
            bestTaskId = batch[i]?.taskId || '';
          }
        }

        // prevUnionAll 已在上方统计，不需要重复收集
      }

      if (!foundSimilar) {
        continue;
      }

      const diffKeys = resourcesJ.filter((k) => !prevUnionAll.has(k));
      if (diffKeys.length === 0) {
        keep[j] = false;
        metaJ._dedupInfo = {
          byTaskId: bestTaskId,
          similarity: bestSim,
        };
        continue;
      }

      metaJ.textForDedup = '';
      metaJ.resourceKeys = diffKeys;
      metaJ.response = this._buildResourcesOnlyResponse(metaJ.response, diffKeys);
    }

    const indices: number[] = [];
    for (let idx = 0; idx < n; idx++) {
      if (keep[idx]) indices.push(idx);
    }
    logger.debug(`发送阶段去重完成: 保留=${indices.length}, 丢弃=${n - indices.length}`);
    return indices;
  }

  _normalizeRecentText(text: string): string {
    return (text || '')
      .replace(/[\s\u00A0]+/g, ' ')
      .trim();
  }

  _normalizeResourceKeys(keys: string[] | null | undefined): string[] {
    if (!Array.isArray(keys) || keys.length === 0) {
      return [];
    }

    const cleaned = keys
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean);

    if (cleaned.length === 0) {
      return [];
    }

    const uniq = Array.from(new Set(cleaned));
    uniq.sort();
    return uniq;
  }

  _areResourceSetsEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
    const aa = this._normalizeResourceKeys(a);
    const bb = this._normalizeResourceKeys(b);
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return false;
    }
    return true;
  }

  _pruneRecentList(groupId: string | number, now: number = Date.now()) {
    const g = String(groupId || '');
    if (!g) return;

    const ttl = readEnvInt('SEND_RECENT_FUSION_TTL_MS', 600000);
    const max = readEnvInt('SEND_RECENT_FUSION_MAX_PER_GROUP', 20);

    const list = this.recentSentByGroup.get(g) || [];
    if (list.length === 0) return;

    const cutoff = now - ttl;
    const filtered = list.filter(
      (item) =>
        item &&
        item.ts >= cutoff &&
        (item.text || (Array.isArray(item.resources) && item.resources.length > 0))
    );
    while (filtered.length > max) {
      filtered.shift();
    }

    if (filtered.length > 0) {
      this.recentSentByGroup.set(g, filtered);
    } else {
      this.recentSentByGroup.delete(g);
    }
  }

  _pruneAllRecentLists(now: number = Date.now()) {
    if (!readEnvBool('SEND_RECENT_FUSION_ENABLED', true)) return;
    const keys = Array.from(this.recentSentByGroup.keys());
    for (const k of keys) {
      this._pruneRecentList(k, now);
    }
  }

  _rememberRecentSent(groupId: string | number, text: string, resourceKeys: string[] | null | undefined, now: number = Date.now()) {
    if (!readEnvBool('SEND_RECENT_FUSION_ENABLED', true)) return;
    const g = String(groupId || '');
    const t = this._normalizeRecentText(text || '');
    const r = this._normalizeResourceKeys(resourceKeys);
    if (!g || (!t && r.length === 0)) return;

    const list = this.recentSentByGroup.get(g) || [];
    list.push({ text: t, resources: r, ts: now });
    this.recentSentByGroup.set(g, list);
    this._pruneRecentList(g, now);
  }

  async _applyRecentDedupAndMaybeRewrite(groupId: string | number, meta: SendMeta): Promise<boolean> {
    if (!readEnvBool('SEND_RECENT_FUSION_ENABLED', true)) return false;
    const g = String(groupId || '');
    const t = this._normalizeRecentText((meta?.textForDedup || '').trim());
    const r = this._normalizeResourceKeys(Array.isArray(meta?.resourceKeys) ? meta.resourceKeys : []);
    if (!g || (!t && r.length === 0)) return false;

    const isPrivate = g.startsWith('U:');
    if (isPrivate && !readEnvBool('SEND_RECENT_FUSION_STRICT_FOR_PRIVATE', true)) {
      // 私聊未启用严格去重时，只做简单 exact 匹配，但仍需资源集合一致
      const list = this.recentSentByGroup.get(g) || [];
      let unionSeen = new Set();
      let hasExact = false;
      for (const item of takeLast(list, 3)) {
        if (!item) continue;
        const baseText = this._normalizeRecentText(item.text || '');
        if (!baseText || baseText !== t) continue;
        hasExact = true;
        const baseResources = Array.isArray(item.resources) ? item.resources : [];
        for (const k of baseResources) unionSeen.add(k);
      }

      if (!hasExact) {
        return false;
      }

      const diffKeys = r.filter((k) => !unionSeen.has(k));
      if (diffKeys.length === 0) {
        return true;
      }

      meta.textForDedup = '';
      meta.resourceKeys = diffKeys;
      meta.response = this._buildResourcesOnlyResponse(meta.response, diffKeys);
      return false;
    }

    const list = this.recentSentByGroup.get(g) || [];
    if (list.length === 0) return false;

    const now = Date.now();
    this._pruneRecentList(g, now);

    const recent = this.recentSentByGroup.get(g) || [];
    if (recent.length === 0) return false;

    // 只与最近几条对比即可，减少计算量
    const candidates = takeLast(recent, 3);

    const unionRecentResourcesAll = new Set();
    for (const item of candidates) {
      const baseResources = Array.isArray(item?.resources) ? item.resources : [];
      for (const k of baseResources) unionRecentResourcesAll.add(k);
    }

    if (!t) {
      const diffKeys = r.filter((k) => !unionRecentResourcesAll.has(k));
      if (diffKeys.length === 0) {
        return true;
      }
      meta.resourceKeys = diffKeys;
      meta.response = this._buildResourcesOnlyResponse(meta.response, diffKeys);
      return false;
    }

    const unionSeenForSimilarText = new Set();

    for (const item of candidates) {
      if (!item) continue;
      const baseText = this._normalizeRecentText(item.text || '');

      if (!baseText) continue;

      let replySimilar = false;
      if (baseText === t) {
        replySimilar = true;
      } else {
        try {
          const { areSimilar } = await this._judgePairSimilarity(baseText, t);
          replySimilar = !!areSimilar;
        } catch {
          replySimilar = false;
        }
      }

      if (!replySimilar) continue;

      const baseResources = Array.isArray(item.resources) ? item.resources : [];
      for (const k of baseResources) unionSeenForSimilarText.add(k);
    }

    if (unionSeenForSimilarText.size === 0) {
      return false;
    }

    const diffKeys = r.filter((k) => !unionRecentResourcesAll.has(k));
    if (diffKeys.length === 0) {
      return true;
    }

    meta.textForDedup = '';
    meta.resourceKeys = diffKeys;
    meta.response = this._buildResourcesOnlyResponse(meta.response, diffKeys);
    return false;
  }

  _buildResourcesOnlyResponse(originalResponse: unknown, allowedResourceKeys: string[] | null | undefined): string {
    const allowed = new Set(Array.isArray(allowedResourceKeys) ? allowedResourceKeys : []);
    if (allowed.size === 0) {
      return '<sentra-response>\n  <resources></resources>\n</sentra-response>';
    }

    let parsed = null;
    try {
      parsed = parseSentraResponse(typeof originalResponse === 'string' ? originalResponse : String(originalResponse ?? ''));
    } catch {
      parsed = null;
    }

    let resources = parsed && Array.isArray(parsed.resources) ? parsed.resources : [];
    let emoji = parsed && parsed.emoji && parsed.emoji.source ? parsed.emoji : null;

    let targetGroupId = null;
    let targetUserId = null;
    for (const k of allowed) {
      const key = String(k || '').trim();
      if (!key) continue;
      if (key.startsWith('target|group:')) {
        const v = key.substring('target|group:'.length).trim();
        if (v && /^\d+$/.test(v)) targetGroupId = v;
      } else if (key.startsWith('target|private:')) {
        const v = key.substring('target|private:'.length).trim();
        if (v && /^\d+$/.test(v)) targetUserId = v;
      }
    }

    // 容错：如果原始 response 无法解析，则仅根据 resourceKeys 反构建 resources/emoji
    if ((!parsed || (!Array.isArray(parsed.resources) && !(parsed && parsed.emoji))) && allowed.size > 0) {
      resources = [];
      emoji = null;
      for (const k of allowed) {
        const key = String(k || '');
        if (!key) continue;
        if (key.startsWith('target|')) {
          continue;
        }
        if (key.startsWith('emoji|')) {
          const src = key.substring('emoji|'.length);
          if (src) {
            emoji = { source: src };
          }
          continue;
        }
        const idx = key.indexOf('|');
        if (idx <= 0) continue;
        const type = key.substring(0, idx);
        const source = key.substring(idx + 1);
        if (type && source) {
          resources.push({ type, source });
        }
      }
    }

    const filtered = [];
    for (const r of resources) {
      if (!r || !r.type || !r.source) continue;
      const k = `${r.type}|${r.source}`;
      if (allowed.has(k)) {
        filtered.push(r);
      }
    }

    const emojiSource = emoji?.source;
    const emojiCaption = emoji?.caption;
    const keepEmoji = !!(emojiSource && allowed.has(`emoji|${emojiSource}`));

    const lines = [];
    lines.push('<sentra-response>');

    if (targetGroupId && !targetUserId) {
      lines.push(`  <group_id>${escapeXml(targetGroupId)}</group_id>`);
    } else if (targetUserId && !targetGroupId) {
      lines.push(`  <user_id>${escapeXml(targetUserId)}</user_id>`);
    }

    if (filtered.length > 0) {
      lines.push('  <resources>');
      for (const r of filtered) {
        lines.push('    <resource>');
        lines.push(`      <type>${escapeXml(r.type)}</type>`);
        lines.push(`      <source>${escapeXml(r.source)}</source>`);
        if (r.caption) {
          lines.push(`      <caption>${escapeXml(r.caption)}</caption>`);
        }
        lines.push('    </resource>');
      }
      lines.push('  </resources>');
    } else {
      lines.push('  <resources></resources>');
    }

    if (keepEmoji && emojiSource) {
      lines.push('  <emoji>');
      lines.push(`    <source>${escapeXml(emojiSource)}</source>`);
      if (emojiCaption) {
        lines.push(`    <caption>${escapeXml(emojiCaption)}</caption>`);
      }
      lines.push('  </emoji>');
    }

    lines.push('</sentra-response>');
    return lines.join('\n');
  }

  /**
   * 使用向量相似度 + 轻量 LLM 工具共同判断两个文本是否语义重复
   * @param {string} textA
   * @param {string} textB
   * @returns {Promise<{areSimilar: boolean, embeddingSim: number|null}>}
   */
  async _judgePairSimilarity(textA: string, textB: string): Promise<{ areSimilar: boolean; embeddingSim: number | null }> {
    const a = (textA || '').trim();
    const b = (textB || '').trim();
    if (!a || !b) {
      return { areSimilar: false, embeddingSim: null };
    }

    try {
      const { areSimilar, similarity } = await judgeReplySimilarity(a, b);
      return { areSimilar: !!areSimilar, embeddingSim: similarity ?? null };
    } catch (e) {
      logger.warn('发送去重: 相似度判定失败（已忽略）', { err: String(e) });
      return { areSimilar: false, embeddingSim: null };
    }
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
