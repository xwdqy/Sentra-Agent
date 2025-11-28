/**
 * 智能回复策略模块（精简版）
 * 功能：
 * - Per-sender 并发控制和队列机制
 * - UUID 跟踪和超时淘汰
 * - 是否进入一次对话任务由本模块决定，具体“回不回话”交给主模型和 Sentra 协议（<sentra-response>）
 */

import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { planGroupReplyDecision } from './replyIntervention.js';
import { assessReplyWorth } from '../components/ReplyGate.js';

const logger = createLogger('ReplyPolicy');

const senderQueues = new Map();
const activeTasks = new Map();
const groupAttention = new Map();
const senderReplyStats = new Map(); // senderId -> { timestamps: number[] }
const groupReplyStats = new Map();  // groupKey -> { timestamps: number[] }
const cancelledTasks = new Set();   // 记录被标记为取消的任务ID（taskId）

/**
 * 任务状态
 */
class Task {
  constructor(msg, conversationId) {
    this.id = randomUUID();
    this.msg = msg;
    this.conversationId = conversationId;
    this.createdAt = Date.now();
    this.senderId = String(msg.sender_id);
  }
}

// 规范化 senderId，确保作为 Map key 一致
function normalizeSenderId(senderId) {
  return String(senderId ?? '');
}

function getGroupKey(groupId) {
  return `G:${groupId ?? ''}`;
}

function getOrInitSenderStats(senderId) {
  const key = normalizeSenderId(senderId);
  if (!senderReplyStats.has(key)) {
    senderReplyStats.set(key, { timestamps: [] });
  }
  return senderReplyStats.get(key);
}

function getOrInitGroupStats(groupId) {
  const key = getGroupKey(groupId);
  if (!groupReplyStats.has(key)) {
    groupReplyStats.set(key, { timestamps: [] });
  }
  return groupReplyStats.get(key);
}

function pruneTimestamps(timestamps, now, windowMs) {
  if (!Array.isArray(timestamps) || !windowMs || windowMs <= 0) {
    return { list: [], count: 0, last: null };
  }
  const list = [];
  let last = null;
  for (const t of timestamps) {
    if (now - t <= windowMs) {
      list.push(t);
      last = t;
    }
  }
  return { list, count: list.length, last };
}

function shouldPassAttentionWindow(msg, senderId, config, options = {}) {
  if (!config.attentionEnabled) return true;
  if (!msg || !msg.group_id) return true;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return true;
  if (!windowMs || windowMs <= 0) return true;

  const groupKey = getGroupKey(msg.group_id);
  const now = Date.now();
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }

  for (const [sid, ts] of map.entries()) {
    if (now - ts > windowMs) {
      map.delete(sid);
    }
  }

  if (map.size < maxSenders) {
    return true;
  }

  if (map.has(senderId)) {
    return true;
  }

  if (options.isExplicitMention) {
    return true;
  }

  return false;
}

function markAttentionWindow(msg, senderId, config) {
  if (!config.attentionEnabled) return;
  if (!msg || !msg.group_id) return;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return;
  if (!windowMs || windowMs <= 0) return;

  const groupKey = getGroupKey(msg.group_id);
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }
  map.set(senderId, Date.now());
}

function evaluateGroupFatigue(msg, config, options = {}) {
  const result = { pass: true, reason: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.groupFatigueEnabled) return result;
  if (!msg || msg.type !== 'group' || !msg.group_id) return result;

  const windowMs = config.groupReplyWindowMs;
  const baseLimit = config.groupReplyBaseLimit;
  const minInterval = config.groupReplyMinIntervalMs;
  let factor = Number.isFinite(config.groupReplyBackoffFactor) ? config.groupReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.groupReplyMaxBackoffMultiplier) ? config.groupReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitGroupStats(msg.group_id);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reason = '群疲劳：短期内机器人在该群回复过多，进入退避窗口';
    return result;
  }

  return result;
}

function evaluateSenderFatigue(msg, senderId, config, options = {}) {
  const result = { pass: true, reason: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.userFatigueEnabled) return result;
  if (!msg || msg.type !== 'group') return result;

  const windowMs = config.userReplyWindowMs;
  const baseLimit = config.userReplyBaseLimit;
  const minInterval = config.userReplyMinIntervalMs;
  let factor = Number.isFinite(config.userReplyBackoffFactor) ? config.userReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.userReplyMaxBackoffMultiplier) ? config.userReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitSenderStats(senderId);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reason = '用户疲劳：短期内机器人对该用户回复过多，进入退避窗口';
    return result;
  }

  return result;
}

function recordReplyForFatigue(msg, senderId, config) {
  if (!msg || msg.type !== 'group') return;
  const now = Date.now();

  if (config.userFatigueEnabled) {
    const windowMs = config.userReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitSenderStats(senderId);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }

  if (config.groupFatigueEnabled && msg.group_id) {
    const windowMs = config.groupReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitGroupStats(msg.group_id);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }
}

/**
 * 获取或创建用户队列
 */
function getSenderQueue(senderId) {
  const key = normalizeSenderId(senderId);
  if (!senderQueues.has(key)) {
    senderQueues.set(key, []);
  }
  return senderQueues.get(key);
}

/**
 * 获取用户当前活跃任务数
 */
export function getActiveTaskCount(senderId) {
  const key = normalizeSenderId(senderId);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  return activeTasks.get(key).size;
}

function getActiveTaskSet(senderId) {
  const key = normalizeSenderId(senderId);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  return activeTasks.get(key);
}

export function markTasksCancelledForSender(senderId) {
  const set = getActiveTaskSet(senderId);
  if (!set || set.size === 0) {
    return;
  }
  for (const taskId of set) {
    if (taskId) {
      cancelledTasks.add(taskId);
    }
  }
  const shortIds = Array.from(set).map((id) => (id ? String(id).substring(0, 8) : 'null'));
  logger.info(`标记取消任务: sender=${normalizeSenderId(senderId)}, tasks=[${shortIds.join(',')}]`);
}

export function isTaskCancelled(taskId) {
  if (!taskId) return false;
  return cancelledTasks.has(taskId);
}

export function clearCancelledTask(taskId) {
  if (!taskId) return;
  cancelledTasks.delete(taskId);
}

/**
 * 添加活跃任务
 */
function addActiveTask(senderId, taskId) {
  const key = normalizeSenderId(senderId);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  activeTasks.get(key).add(taskId);
  logger.debug(`活跃任务+: ${key} 添加任务 ${taskId?.substring(0,8)}, 当前活跃数: ${activeTasks.get(key).size}`);
}

/**
 * 移除活跃任务并尝试处理队列
 */
function removeActiveTask(senderId, taskId) {
  const key = normalizeSenderId(senderId);
  if (activeTasks.has(key)) {
    activeTasks.get(key).delete(taskId);
    logger.debug(`活跃任务-: ${key} 移除任务 ${taskId?.substring(0,8)}, 剩余活跃数: ${activeTasks.get(key).size}`);
  }
}

/**
 * 解析环境变量中的bot名称列表
 */
function parseBotNames() {
  const names = process.env.BOT_NAMES || '';
  if (!names.trim()) return [];
  return names.split(',').map(n => n.trim()).filter(Boolean);
}

/**
 * 解析配置参数
 */
function getConfig() {
  const botNames = parseBotNames();
  const attentionWindowMsEnv = parseInt(process.env.ATTENTION_WINDOW_MS || '120000', 10);
  const attentionMaxSendersEnv = parseInt(process.env.ATTENTION_MAX_SENDERS || '3', 10);
  const attentionWindowMs = Number.isFinite(attentionWindowMsEnv) ? attentionWindowMsEnv : 120000;
  const attentionMaxSenders = Number.isFinite(attentionMaxSendersEnv) ? attentionMaxSendersEnv : 3;
  const followupWindowSecEnv = parseInt(process.env.REPLY_DECISION_FOLLOWUP_WINDOW_SEC || '180', 10);
  const replyFollowupWindowSec = Number.isFinite(followupWindowSecEnv) && followupWindowSecEnv > 0
    ? followupWindowSecEnv
    : 0;
  return {
    // bot 名称列表（支持多个昵称，仅用于简单“是否被提及”的判断）
    botNames,
    // Per-sender 最大并发数
    maxConcurrentPerSender: parseInt(process.env.MAX_CONCURRENT_PER_SENDER || '1'),
    // 队列任务最大等待时间（毫秒）
    queueTimeout: parseInt(process.env.QUEUE_TIMEOUT) || 30000,
    // 显式 @ 是否必须回复（true=显式 @ 一律回复；false=交给模型和人设决定）
    mentionMustReply: process.env.MENTION_MUST_REPLY === 'true',
    replyFollowupWindowSec,
    attentionEnabled: (process.env.ATTENTION_WINDOW_ENABLED || 'true') === 'true',
    attentionWindowMs,
    attentionMaxSenders,
    // 群/用户疲劳控制（短期窗口 + 指数退避）
    userFatigueEnabled: (process.env.USER_FATIGUE_ENABLED || 'true') === 'true',
    userReplyWindowMs: parseInt(process.env.USER_REPLY_WINDOW_MS || '300000', 10),
    userReplyBaseLimit: parseInt(process.env.USER_REPLY_BASE_LIMIT || '5', 10),
    userReplyMinIntervalMs: parseInt(process.env.USER_REPLY_MIN_INTERVAL_MS || '10000', 10),
    userReplyBackoffFactor: parseFloat(process.env.USER_REPLY_BACKOFF_FACTOR || '2'),
    userReplyMaxBackoffMultiplier: parseFloat(process.env.USER_REPLY_MAX_BACKOFF_MULTIPLIER || '8'),
    groupFatigueEnabled: (process.env.GROUP_FATIGUE_ENABLED || 'true') === 'true',
    groupReplyWindowMs: parseInt(process.env.GROUP_REPLY_WINDOW_MS || '300000', 10),
    groupReplyBaseLimit: parseInt(process.env.GROUP_REPLY_BASE_LIMIT || '30', 10),
    groupReplyMinIntervalMs: parseInt(process.env.GROUP_REPLY_MIN_INTERVAL_MS || '2000', 10),
    groupReplyBackoffFactor: parseFloat(process.env.GROUP_REPLY_BACKOFF_FACTOR || '2'),
    groupReplyMaxBackoffMultiplier: parseFloat(process.env.GROUP_REPLY_MAX_BACKOFF_MULTIPLIER || '8')
  };
}

/**
 * 处理队列中的待定任务
 */
async function processQueue(senderId) {
  const config = getConfig();
  const queue = getSenderQueue(senderId);
  
  // 只补充一个任务，由上层驱动继续触发
  if (getActiveTaskCount(senderId) < config.maxConcurrentPerSender && queue.length > 0) {
    const task = queue.shift();
    
    // 检查是否超时
    const age = Date.now() - task.createdAt;
    if (age > config.queueTimeout) {
      logger.warn(`队列超时: 任务 ${task.id} 等待${age}ms，已放弃`);
      return null;
    }
    
    // 执行任务
    logger.debug(`队列补充: 任务 ${task.id} 开始处理`);
    addActiveTask(senderId, task.id);
    // 返回给上层处理
    return task;
  }
  return null;
}

/**
 * 完成任务（供外部调用）
 */
export async function completeTask(senderId, taskId) {
  removeActiveTask(senderId, taskId);
  logger.debug(`任务完成: sender=${normalizeSenderId(senderId)}, task=${taskId}`);
  const next = await processQueue(senderId);
  return next;
}

/**
 * 智能回复决策 v2.0
 * @param {Object} msg - 消息对象
 * @returns {Promise<{needReply: boolean, reason: string, mandatory: boolean, probability: number, taskId: string|null}>}
 */
export async function shouldReply(msg, options = {}) {
  const config = getConfig();
  const senderId = normalizeSenderId(msg.sender_id);
  const decisionContext = options.decisionContext || null;
  // 私聊：保持必回策略
  if (msg.type === 'private') {
    const taskId = randomUUID();
    addActiveTask(senderId, taskId);
    logger.info(`私聊消息，必须回复 (task=${taskId})`);
    return {
      needReply: true,
      reason: '私聊消息',
      mandatory: true,
      probability: 1.0,
      taskId
    };
  }

  // 群聊：并发和队列控制 + 轻量 LLM 决策是否回复
  const activeCount = getActiveTaskCount(senderId);
  const conversationId = msg.group_id
    ? `group_${msg.group_id}_sender_${senderId}`
    : `private_${senderId}`;

  if (activeCount >= config.maxConcurrentPerSender) {
    const task = new Task(msg, conversationId);
    const queue = getSenderQueue(senderId);
    queue.push(task);
    logger.debug(`并发限制: sender=${senderId} 活跃=${activeCount}/${config.maxConcurrentPerSender}, 队列长度=${queue.length}`);
    return {
      needReply: false,
      reason: '并发限制，已加入队列',
      mandatory: false,
      probability: 0.0,
      taskId: null
    };
  }

  const isGroup = msg.type === 'group';
  const selfId = msg.self_id;
  const isExplicitMention = Array.isArray(msg.at_users) && msg.at_users.some(at => String(at) === String(selfId));
  const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';

  // 基于 BOT_NAMES 的名称提及检测（仅作为信号，不做硬编码规则）
  let mentionedByName = false;
  const mentionedNames = [];
  if (isGroup && Array.isArray(config.botNames) && config.botNames.length > 0) {
    const textForMatch = ((msg.text || msg.summary || '') + '').toLowerCase();
    if (textForMatch) {
      for (const name of config.botNames) {
        const n = (name || '').toLowerCase();
        if (!n) continue;
        if (textForMatch.includes(n)) {
          mentionedByName = true;
          mentionedNames.push(name);
        }
      }
    }
  }

  if (isGroup) {
    const pass = shouldPassAttentionWindow(msg, senderId, config, {
      isExplicitMention: isExplicitMention || mentionedByName
    });
    if (!pass) {
      const reason = '注意力窗口已满，跳过本轮群聊消息';
      logger.info(`[${groupInfo}] 用户${senderId} 决策为不回复: ${reason}`);
      return {
        needReply: false,
        reason,
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }
  let senderFatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };
  let groupFatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };

  if (isGroup) {
    const gf = evaluateGroupFatigue(msg, config, {
      isExplicitMention,
      mentionedByName
    });
    groupFatigueInfo = { count: gf.count, fatigue: gf.fatigue, lastAgeSec: gf.lastAgeSec };

    const uf = evaluateSenderFatigue(msg, senderId, config, {
      isExplicitMention,
      mentionedByName
    });
    senderFatigueInfo = { count: uf.count, fatigue: uf.fatigue, lastAgeSec: uf.lastAgeSec };
    logger.debug(
      `[${groupInfo}] 疲劳统计: groupCount=${groupFatigueInfo.count}, groupFatigue=${groupFatigueInfo.fatigue.toFixed(2)}, senderCount=${senderFatigueInfo.count}, senderFatigue=${senderFatigueInfo.fatigue.toFixed(2)}, senderLastReplyAgeSec=${senderFatigueInfo.lastAgeSec ?? 'null'}`
    );
  }

  let isFollowupAfterBotReply = false;
  if (
    typeof senderFatigueInfo.lastAgeSec === 'number' &&
    senderFatigueInfo.lastAgeSec >= 0 &&
    Number.isFinite(config.replyFollowupWindowSec) &&
    config.replyFollowupWindowSec > 0
  ) {
    isFollowupAfterBotReply = senderFatigueInfo.lastAgeSec <= config.replyFollowupWindowSec;
  }

  const policyConfig = {
    mentionMustReply: !!config.mentionMustReply,
    followupWindowSec: Number.isFinite(config.replyFollowupWindowSec)
      ? config.replyFollowupWindowSec
      : 0,
    attention: {
      enabled: !!config.attentionEnabled,
      windowMs: config.attentionWindowMs,
      maxSenders: config.attentionMaxSenders
    },
    userFatigue: {
      enabled: !!config.userFatigueEnabled,
      windowMs: config.userReplyWindowMs,
      baseLimit: config.userReplyBaseLimit,
      minIntervalMs: config.userReplyMinIntervalMs,
      backoffFactor: config.userReplyBackoffFactor,
      maxBackoffMultiplier: config.userReplyMaxBackoffMultiplier
    },
    groupFatigue: {
      enabled: !!config.groupFatigueEnabled,
      windowMs: config.groupReplyWindowMs,
      baseLimit: config.groupReplyBaseLimit,
      minIntervalMs: config.groupReplyMinIntervalMs,
      backoffFactor: config.groupReplyBackoffFactor,
      maxBackoffMultiplier: config.groupReplyMaxBackoffMultiplier
    }
  };

  let probability = 1.0;
  let reason = isGroup ? '群聊消息' : '消息';
  let mandatory = false;
  let shouldReplyFlag = true;

  // 群聊 + 非显式 @ 的消息先通过 ReplyGate 进行价值预判：
  //  - decision = 'ignore'  => 直接不回
  //  - decision = 'llm'     => 继续交给 XML 决策 LLM
  if (isGroup && !isExplicitMention) {
    try {
      const gateResult = assessReplyWorth(
        msg,
        {
          mentionedByAt: isExplicitMention,
          mentionedByName,
          senderReplyCountWindow: senderFatigueInfo.count,
          groupReplyCountWindow: groupFatigueInfo.count,
          senderFatigue: senderFatigueInfo.fatigue,
          groupFatigue: groupFatigueInfo.fatigue,
          isFollowupAfterBotReply
        },
        {
          decisionContext
        }
      );

      if (gateResult && gateResult.decision === 'ignore') {
        const gateReason = `ReplyGate: ${gateResult.reason || 'low_interest_score'}`;
        logger.info(`[${groupInfo}] 用户${senderId} 预判为不回复: ${gateReason}`);
        return {
          needReply: false,
          reason: gateReason,
          mandatory: false,
          probability: gateResult.normalizedScore ?? 0,
          conversationId,
          taskId: null
        };
      }
      // 其余情况（包括 gateResult.decision === 'llm' 或 gateResult 为空）
      // 继续走后面的 planGroupReplyDecision XML 决策
    } catch (e) {
      logger.debug(`ReplyGate 预判失败，回退为正常 LLM 决策: ${groupInfo} sender ${senderId}`, {
        err: String(e)
      });
    }
  }

  if (isGroup) {
    const intervention = await planGroupReplyDecision(msg, {
      signals: {
        mentionedByAt: isExplicitMention,
        mentionedByName,
        mentionedNames,
        senderReplyCountWindow: senderFatigueInfo.count,
        groupReplyCountWindow: groupFatigueInfo.count,
        senderFatigue: senderFatigueInfo.fatigue,
        groupFatigue: groupFatigueInfo.fatigue,
        senderLastReplyAgeSec: senderFatigueInfo.lastAgeSec,
        groupLastReplyAgeSec: groupFatigueInfo.lastAgeSec,
        isFollowupAfterBotReply,
        activeTaskCount: activeCount
      },
      context: decisionContext || undefined,
      policy: policyConfig
    });

    if (intervention && typeof intervention.shouldReply === 'boolean') {
      shouldReplyFlag = intervention.shouldReply;
      if (typeof intervention.confidence === 'number') {
        probability = intervention.confidence;
      }
      reason = `ReplyIntervention: ${intervention.reason || (shouldReplyFlag ? '需要回复' : '无需回复')}`;
    }

    // 配置强制：显式 @ 且 mentionMustReply=true 时，覆盖为必须回复
    if (isExplicitMention && config.mentionMustReply) {
      if (!shouldReplyFlag) {
        logger.info('ReplyIntervention 判定无需回复，但配置要求对显式@必须回复，强制覆盖为需要回复');
      }
      shouldReplyFlag = true;
      mandatory = true;
      reason = '显式@（配置必须回复）';
      probability = 1.0;
    }
  }

  if (!shouldReplyFlag) {
    logger.info(`[${groupInfo}] 用户${senderId} 决策为不回复: ${reason}`);
    return {
      needReply: false,
      reason,
      mandatory: false,
      probability,
      conversationId,
      taskId: null
    };
  }

  const taskId = randomUUID();
  addActiveTask(senderId, taskId);
  if (isGroup) {
    markAttentionWindow(msg, senderId, config);
    recordReplyForFatigue(msg, senderId, config);
  }
  logger.info(`[${groupInfo}] 用户${senderId} 启动对话: ${reason}, task=${taskId}`);

  return {
    needReply: true,
    reason,
    mandatory,
    probability,
    conversationId,
    taskId
  };
}
