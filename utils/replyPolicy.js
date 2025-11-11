/**
 * 智能回复策略模块 v2.0
 * 功能：
 * - 基于最佳实践的动态回复概率计算
 * - Per-sender并发控制和队列机制
 * - 非线性欲望值算法（对数增长 + Sigmoid激活）
 * - UUID跟踪和超时淘汰
 */

import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('ReplyPolicy');

// 会话状态存储
const conversationStates = new Map();

// 用户任务队列管理
const senderQueues = new Map();

// 活跃任务跟踪（per-sender）
const activeTasks = new Map();

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

/**
 * 获取或创建会话状态
 */
function getConversationState(conversationId) {
  if (!conversationStates.has(conversationId)) {
    conversationStates.set(conversationId, {
      lastReplyTime: 0,
      replyDesire: 0.0, // 回复欲望值 [0-1]
      messageCount: 0,
      lastMentionTime: 0,
      consecutiveIgnored: 0, // 连续忽略次数
      messageTimestamps: [], // 消息时间戳数组（用于时间衰减）
      lastMessageTime: 0, // 最后一条消息时间
      avgMessageInterval: 0 // 平均消息间隔（用于对话节奏）
    });
  }
  return conversationStates.get(conversationId);
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
  return {
    // bot名称列表（支持多个昵称）
    botNames: parseBotNames(),
    // 最小回复间隔（秒）
    minReplyInterval: parseInt(process.env.MIN_REPLY_INTERVAL) || 5,
    // 欲望值增长速率（改进的对数曲线斜率）
    desireGrowthRate: parseFloat(process.env.DESIRE_GROWTH_RATE) || 0.4,
    // 提及bot名称时的额外欲望值（降低，避免过于激进）
    mentionBonus: parseFloat(process.env.MENTION_BONUS) || 0.25,
    // 基础回复概率阈值
    baseReplyThreshold: parseFloat(process.env.BASE_REPLY_THRESHOLD) || 0.65,
    // 时间衰减半衰期（秒）：消息的"新鲜度"衰减速度
    timeDecayHalfLife: parseFloat(process.env.TIME_DECAY_HALFLIFE) || 300, // 5分钟
    // 上下文感知窗口（消息数）
    contextWindow: parseInt(process.env.CONTEXT_WINDOW) || 10,
    // 对话节奏配置
    paceFastThreshold: parseFloat(process.env.PACE_FAST_THRESHOLD) || 15,
    paceFastAdjustment: parseFloat(process.env.PACE_FAST_ADJUSTMENT) || -0.1,
    paceSlowThreshold: parseFloat(process.env.PACE_SLOW_THRESHOLD) || 180,
    paceSlowAdjustment: parseFloat(process.env.PACE_SLOW_ADJUSTMENT) || 0.08,
    // 启用智能回复（false则总是回复）
    enableSmartReply: process.env.ENABLE_SMART_REPLY !== 'false',
    // Per-sender最大并发数
    maxConcurrentPerSender: parseInt(process.env.MAX_CONCURRENT_PER_SENDER || '1'),
    // 队列任务最大等待时间（毫秒）
    queueTimeout: parseInt(process.env.QUEUE_TIMEOUT) || 30000,
    // Sigmoid激活函数的陡峭度
    sigmoidSteepness: parseFloat(process.env.SIGMOID_STEEPNESS) || 8.0
  };
}

/**
 * 检查消息是否提及bot名称
 */
function checkBotNameMention(text, botNames) {
  if (!text || !Array.isArray(botNames) || botNames.length === 0) {
    return false;
  }
  const lowerText = text.toLowerCase();
  return botNames.some(name => lowerText.includes(name.toLowerCase()));
}

/**
 * 改进的对数增长欲望值算法（基于研究最佳实践）
 * 结合时间衰减和上下文感知
 * 模型：desire = [log(1 + k*w) / log(1 + k*N)] * temporalWeight
 * - w: 加权消息数（考虑时间衰减）
 * - k: 增长速率
 * - N: 饱和参数（动态调整）
 * - temporalWeight: 时间衰减权重
 */
function calculateDesireByLog(state, growthRate, config) {
  if (state.messageCount <= 0) return 0;
  
  const now = Date.now() / 1000;
  const k = growthRate;
  
  // 1. 计算时间衰减权重（指数衰减）
  let weightedCount = 0;
  const halfLife = config.timeDecayHalfLife;
  
  for (let i = 0; i < state.messageTimestamps.length; i++) {
    const age = now - state.messageTimestamps[i];
    // 指数衰减：weight = e^(-λ * age), λ = ln(2) / halfLife
    const decayRate = Math.log(2) / halfLife;
    const weight = Math.exp(-decayRate * age);
    weightedCount += weight;
  }
  
  // 回退到简单计数（如果没有时间戳）
  if (weightedCount === 0) {
    weightedCount = state.messageCount;
  }
  
  // 2. 动态调整饱和参数（基于对话节奏）
  // 快速对话时提高饱和点，避免过于激进
  let N = 15; // 基础饱和点
  if (state.avgMessageInterval > 0 && state.avgMessageInterval < 30) {
    // 快速对话（<30秒间隔）：提高饱和点
    N = 25;
  } else if (state.avgMessageInterval > 120) {
    // 慢速对话（>2分钟间隔）：降低饱和点
    N = 10;
  }
  
  // 3. 改进的对数增长曲线
  const desire = Math.log(1 + k * weightedCount) / Math.log(1 + k * N);
  
  // 4. 添加时间新鲜度因子（最近的消息权重更高）
  const timeSinceLastMsg = now - state.lastMessageTime;
  let freshnessBoost = 0;
  if (timeSinceLastMsg < 60) {
    // 最近1分钟内的消息：额外增加0-0.15的欲望值
    freshnessBoost = 0.15 * (1 - timeSinceLastMsg / 60);
  }
  
  return Math.min(1.0, Math.max(0, desire + freshnessBoost));
}

/**
 * Sigmoid激活函数
 * 将欲望值映射为回复概率，产生"突然爆发"效应
 * sigmoid(x) = 1 / (1 + e^(-steepness * (x - 0.5)))
 */
function sigmoidActivation(desire, steepness) {
  const shifted = desire - 0.5; // 中心点在0.5
  const probability = 1 / (1 + Math.exp(-steepness * shifted));
  return probability;
}

/**
 * 改进的连续忽略惩罚机制（基于强化学习思路）
 * 使用平滑的指数增长 + 上限控制
 */
function calculateIgnorePenalty(state, config) {
  const consecutiveIgnored = state.consecutiveIgnored;
  if (consecutiveIgnored <= 1) return 0;
  
  // 平滑指数增长：避免突然爆发
  // penalty = base * (1 - e^(-α * (n-1)))
  const base = 0.35; // 最大惩罚值
  const alpha = 0.4; // 增长速率
  const penalty = base * (1 - Math.exp(-alpha * (consecutiveIgnored - 1)));
  
  // 如果用户持续发送消息（对话节奏快），额外增加惩罚
  let paceBonus = 0;
  if (state.avgMessageInterval > 0 && state.avgMessageInterval < 20) {
    paceBonus = 0.1; // 快速发送时额外+0.1
  }
  
  return Math.min(0.45, penalty + paceBonus);
}

/**
 * 检查是否满足回复间隔要求
 */
function canReplyByInterval(conversationId, minInterval) {
  const state = getConversationState(conversationId);
  const now = Date.now() / 1000;
  const elapsed = now - state.lastReplyTime;
  return elapsed >= minInterval;
}

/**
 * 更新会话状态（消息累积 + 时间追踪）
 */
function incrementMessageCount(conversationId) {
  const state = getConversationState(conversationId);
  const now = Date.now() / 1000;
  
  state.messageCount += 1;
  state.consecutiveIgnored += 1;
  
  // 添加时间戳
  state.messageTimestamps.push(now);
  
  // 只保留最近的消息时间戳（上下文窗口）
  const config = getConfig();
  if (state.messageTimestamps.length > config.contextWindow) {
    state.messageTimestamps.shift();
  }
  
  // 更新平均消息间隔（用于对话节奏感知）
  if (state.lastMessageTime > 0) {
    const interval = now - state.lastMessageTime;
    if (state.avgMessageInterval === 0) {
      state.avgMessageInterval = interval;
    } else {
      // 指数移动平均（EMA）
      const alpha = 0.3; // 平滑因子
      state.avgMessageInterval = alpha * interval + (1 - alpha) * state.avgMessageInterval;
    }
  } else {
    // 首次消息：初始化为一个合理的默认值（避免一直是0）
    state.avgMessageInterval = 60; // 默认60秒间隔
  }
  
  state.lastMessageTime = now;
}

/**
 * 重置会话状态（回复后）
 * 应该在实际回复发送成功后调用，而不是在判断需要回复时调用
 */
export function resetConversationState(conversationId) {
  const state = getConversationState(conversationId);
  const now = Date.now() / 1000;
  
  state.lastReplyTime = now;
  state.messageCount = 0;
  state.consecutiveIgnored = 0;
  state.messageTimestamps = []; // 清空时间戳
  // 保留 avgMessageInterval 和 lastMessageTime（用于后续对话节奏判断）
  
  logger.debug(`欲望值重置: conversationId=${conversationId}`);
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
export async function shouldReply(msg) {
  const config = getConfig();
  const senderId = normalizeSenderId(msg.sender_id);
  
  // 如果禁用智能回复，总是回复
  if (!config.enableSmartReply) {
    return { 
      needReply: true, 
      reason: '智能回复已禁用', 
      mandatory: false,
      probability: 1.0,
      taskId: randomUUID()
    };
  }
  
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
  
  const isExplicitMention = Array.isArray(msg.at_users) && msg.at_users.some(at => at === msg.self_id);
  
  if (isExplicitMention) {
    const taskId = randomUUID();
    addActiveTask(senderId, taskId);
    logger.info(`明确@机器人，必须回复 (task=${taskId})`);
    return { 
      needReply: true, 
      reason: '被明确@提及', 
      mandatory: true,
      probability: 1.0,
      taskId
    };
  }
  
  const activeCount = getActiveTaskCount(senderId);
  // 优化：群聊按 group_id + sender_id 维度追踪，每个用户在群里有独立的欲望值
  const conversationId = msg.group_id 
    ? `group_${msg.group_id}_sender_${senderId}` 
    : `private_${senderId}`;
  
  if (activeCount >= config.maxConcurrentPerSender) {
    // 加入队列
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
  
  // 获取会话状态并立即更新时间戳（确保时间追踪准确）
  const state = getConversationState(conversationId);
  const now = Date.now() / 1000;
  
  // 更新消息时间戳和平均间隔（在任何判断之前）
  state.messageTimestamps.push(now);
  if (state.messageTimestamps.length > config.contextWindow) {
    state.messageTimestamps.shift();
  }
  if (state.lastMessageTime > 0) {
    const interval = now - state.lastMessageTime;
    if (state.avgMessageInterval === 0 || state.avgMessageInterval === 60) {
      // 第一次计算实际间隔时，直接使用真实间隔
      state.avgMessageInterval = interval;
    } else {
      // 指数移动平均（EMA）
      const alpha = 0.3;
      state.avgMessageInterval = alpha * interval + (1 - alpha) * state.avgMessageInterval;
    }
  } else {
    // 首次消息：初始化为一个合理的默认值（避免一直是0）
    state.avgMessageInterval = 60; // 默认60秒间隔
  }
  state.lastMessageTime = now;
  
  // 检查回复间隔
  if (!canReplyByInterval(conversationId, config.minReplyInterval)) {
    const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';
    logger.debug(`[${groupInfo}] 用户${senderId}: 回复间隔不足，累积消息计数`);
    // 只累积消息计数和忽略次数
    state.messageCount += 1;
    state.consecutiveIgnored += 1;
    return { 
      needReply: false, 
      reason: '回复间隔不足', 
      mandatory: false,
      probability: 0.0,
      taskId: null
    };
  }
  
  // 1. 基础欲望值（改进的对数增长 + 时间衰减）
  const baseDesire = calculateDesireByLog(state, config.desireGrowthRate, config);
  
  // 2. 提及加成（注意力机制）
  const hasBotNameMention = checkBotNameMention(msg.text, config.botNames);
  const mentionBonus = hasBotNameMention ? config.mentionBonus : 0;
  
  // 3. 连续忽略惩罚（改进的指数增长）
  const ignorePenalty = calculateIgnorePenalty(state, config);
  
  // 4. 对话节奏调整因子
  let paceAdjustment = 0;
  if (state.avgMessageInterval > 0) {
    if (state.avgMessageInterval < config.paceFastThreshold) {
      // 非常快速的对话：降低欲望值，避免过于频繁回复
      paceAdjustment = config.paceFastAdjustment;
    } else if (state.avgMessageInterval > config.paceSlowThreshold) {
      // 非常慢速的对话：提高欲望值，避免冷场
      paceAdjustment = config.paceSlowAdjustment;
    }
  }
  
  // 5. 综合欲望值（多因子融合）
  let totalDesire = baseDesire + mentionBonus + ignorePenalty + paceAdjustment;
  totalDesire = Math.max(0, Math.min(1, totalDesire));
  
  // 6. Sigmoid激活转换为概率（平滑过渡）
  const probability = sigmoidActivation(totalDesire, config.sigmoidSteepness);
  
  // 详细日志输出
  const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';
  logger.debug(`[${groupInfo}] 用户${senderId} 欲望值: msgCount=${state.messageCount}, ignored=${state.consecutiveIgnored}, pace=${state.avgMessageInterval.toFixed(1)}s`);
  logger.debug(`[${groupInfo}] 用户${senderId} 详情: 基础=${baseDesire.toFixed(3)}(log+decay), 提及=${mentionBonus.toFixed(3)}, 惩罚=${ignorePenalty.toFixed(3)}, 节奏=${paceAdjustment.toFixed(3)}, 总计=${totalDesire.toFixed(3)}`);
  logger.debug(`[${groupInfo}] 用户${senderId} 概率: Sigmoid(${totalDesire.toFixed(3)}) = ${probability.toFixed(3)} (阈值=${config.baseReplyThreshold})`);
  logger.debug(`[${groupInfo}] 用户${senderId} 时间: 最后消息 ${(Date.now()/1000 - state.lastMessageTime).toFixed(1)}s前, 时间戳数 ${state.messageTimestamps.length}`);
  
  // 判断是否回复
  const needReply = probability >= config.baseReplyThreshold;
  
  if (needReply) {
    const taskId = randomUUID();
    addActiveTask(senderId, taskId);
    logger.info(`[${groupInfo}] 用户${senderId} 智能回复通过: 概率${(probability * 100).toFixed(1)}% >= 阈值${(config.baseReplyThreshold * 100).toFixed(1)}%, task=${taskId}`);
    // 注意：不在这里重置状态，而是在实际回复发送成功后再重置
    // 避免在处理期间用户继续发消息导致重复触发
    return { 
      needReply: true, 
      reason: '概率判断', 
      mandatory: false,  // 概率判断通过不是强制场景
      probability,
      conversationId,
      taskId,
      state,  // 添加 state，供干预判断使用
      threshold: config.baseReplyThreshold  // 添加阈值
    };
  } else {
    logger.debug(`[${groupInfo}] 用户${senderId} 智能回复未通过: 概率${(probability * 100).toFixed(1)}% < 阈值${(config.baseReplyThreshold * 100).toFixed(1)}%`);
    // 累积消息计数和忽略次数（时间戳已在开始时更新）
    state.messageCount += 1;
    state.consecutiveIgnored += 1;
    return { 
      needReply: false, 
      reason: '概率判断未通过', 
      mandatory: false,
      probability,
      taskId: null
    };
  }
}

/**
 * 降低欲望值并重新计算概率（用于干预判断）
 * @param {string} conversationId - 会话ID
 * @param {Object} msg - 消息对象
 * @param {number} reductionPercent - 降低的百分比（如 0.10 表示降低10%）
 * @returns {{probability: number, needReply: boolean, totalDesire: number, state: Object}}
 */
export function reduceDesireAndRecalculate(conversationId, msg, reductionPercent = 0.10) {
  const config = getConfig();
  const state = getConversationState(conversationId);
  const senderId = normalizeSenderId(msg.sender_id);
  
  // 1. 基础欲望值（改进的对数增长 + 时间衰减）
  const baseDesire = calculateDesireByLog(state, config.desireGrowthRate, config);
  
  // 2. 提及加成（注意力机制）
  const hasBotNameMention = checkBotNameMention(msg.text, config.botNames);
  const mentionBonus = hasBotNameMention ? config.mentionBonus : 0;
  
  // 3. 连续忽略惩罚（改进的指数增长）
  const ignorePenalty = calculateIgnorePenalty(state, config);
  
  // 4. 对话节奏调整因子
  let paceAdjustment = 0;
  if (state.avgMessageInterval > 0) {
    if (state.avgMessageInterval < config.paceFastThreshold) {
      paceAdjustment = config.paceFastAdjustment;
    } else if (state.avgMessageInterval > config.paceSlowThreshold) {
      paceAdjustment = config.paceSlowAdjustment;
    }
  }
  
  // 5. 综合欲望值（多因子融合）
  let totalDesire = baseDesire + mentionBonus + ignorePenalty + paceAdjustment;
  totalDesire = Math.max(0, Math.min(1, totalDesire));
  
  // 6. 降低欲望值（干预判断后的调整）
  const originalDesire = totalDesire;
  totalDesire = totalDesire * (1 - reductionPercent);
  totalDesire = Math.max(0, Math.min(1, totalDesire));
  
  // 7. Sigmoid激活转换为概率（平滑过渡）
  const newProbability = sigmoidActivation(totalDesire, config.sigmoidSteepness);
  
  // 8. 判断是否仍然通过阈值
  const needReply = newProbability >= config.baseReplyThreshold;
  
  const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';
  logger.debug(`[${groupInfo}] 用户${senderId} 欲望降低: ${originalDesire.toFixed(3)} → ${totalDesire.toFixed(3)} (-${(reductionPercent * 100).toFixed(0)}%)`);
  logger.debug(`[${groupInfo}] 用户${senderId} 概率重算: Sigmoid(${totalDesire.toFixed(3)}) = ${newProbability.toFixed(3)} (阈值=${config.baseReplyThreshold})`);
  logger.info(`[${groupInfo}] 用户${senderId} 干预后判断: needReply=${needReply}, prob=${(newProbability * 100).toFixed(1)}%`);
  
  return {
    probability: newProbability,
    needReply,
    totalDesire,
    state
  };
}

/**
 * 清理过期的会话状态（防止内存泄漏）
 */
export function cleanupExpiredStates() {
  const now = Date.now() / 1000;
  const maxAge = 3600 * 24; // 24小时
  
  for (const [id, state] of conversationStates.entries()) {
    if (now - state.lastReplyTime > maxAge) {
      conversationStates.delete(id);
    }
  }
}

// 定期清理（每小时）
setInterval(cleanupExpiredStates, 3600 * 1000);
