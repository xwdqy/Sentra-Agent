import { getRedis } from './redisClient.js';
import { createLogger } from './logger.js';

const logger = createLogger('ConversationUtils');

/**
 * 对话历史管理模块
 * 包含对话历史的存储、更新和查询
 */

// 存储对话历史
const conversationHistory = new Map();

// Redis key 前缀配置（私聊 / 群聊分别使用独立前缀，不再兼容旧字段）
const REDIS_CONV_PRIVATE_PREFIX = process.env.REDIS_CONV_PRIVATE_PREFIX || 'sentra:conv:private:';
const REDIS_CONV_GROUP_PREFIX = process.env.REDIS_CONV_GROUP_PREFIX || 'sentra:conv:group:';

// TTL 与最大条数配置
const REDIS_CONV_TTL_SECONDS = parseInt(process.env.REDIS_CONV_TTL_SECONDS || '86400', 10);
const parsedConvMaxMessages = parseInt(process.env.REDIS_CONV_MAX_MESSAGES ?? '0', 10);
const REDIS_CONV_MAX_MESSAGES = Number.isNaN(parsedConvMaxMessages) ? 0 : parsedConvMaxMessages; // <=0 表示不限制，仅由 TTL 控制

function buildConversationKey(msg) {
  return msg.type === 'private'
    ? String(msg.sender_id)
    : `group_${msg.group_id}_${msg.sender_id}`;
}

function getLocalHistory(conversationKey) {
  return conversationHistory.get(conversationKey) || { userMessages: [], botMessages: [] };
}

function saveLocalHistory(conversationKey, history) {
  conversationHistory.set(conversationKey, history);
}

async function loadHistoryFromRedis(conversationKey, isPrivate) {
  const redis = getRedis();
  if (!redis) return null;

  const prefix = isPrivate ? REDIS_CONV_PRIVATE_PREFIX : REDIS_CONV_GROUP_PREFIX;
  const key = `${prefix}${conversationKey}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    logger.warn('加载 Redis 对话历史失败，回退本地缓存', { err: String(e), conversationKey });
    return null;
  }
}

async function saveHistoryToRedis(conversationKey, isPrivate, history) {
  const redis = getRedis();
  if (!redis) return;

  const prefix = isPrivate ? REDIS_CONV_PRIVATE_PREFIX : REDIS_CONV_GROUP_PREFIX;
  const key = `${prefix}${conversationKey}`;
  try {
    const data = JSON.stringify(history);
    if (Number.isFinite(REDIS_CONV_TTL_SECONDS) && REDIS_CONV_TTL_SECONDS > 0) {
      await redis.set(key, data, 'EX', REDIS_CONV_TTL_SECONDS);
    } else {
      await redis.set(key, data);
    }
  } catch (e) {
    logger.warn('保存 Redis 对话历史失败（忽略并继续使用本地缓存）', { err: String(e), conversationKey });
  }
}

async function loadConversationHistory(msg) {
  const conversationKey = buildConversationKey(msg);
  const isPrivate = msg.type === 'private';

  // 优先尝试从 Redis 读取，失败则回退本地 Map
  let history = await loadHistoryFromRedis(conversationKey, isPrivate);
  if (!history) {
    history = getLocalHistory(conversationKey);
  }

  if (!Array.isArray(history.userMessages)) history.userMessages = [];
  if (!Array.isArray(history.botMessages)) history.botMessages = [];

  // 确保每条记录都有时间戳，兼容旧数据
  const now = Date.now();
  history.userMessages = history.userMessages.map((item) => ({
    ...item,
    timestamp: typeof item.timestamp === 'number' ? item.timestamp : now
  }));
  history.botMessages = history.botMessages.map((item) => ({
    ...item,
    timestamp: typeof item.timestamp === 'number' ? item.timestamp : now
  }));

  // 规范化后的结构写回本地缓存
  saveLocalHistory(conversationKey, history);

  return { conversationKey, isPrivate, history };
}

/**
 * 获取可引用的消息ID（优先从 Redis 读取，失败时回退本地 Map）
 */
export async function getReplyableMessageId(msg) {
  const { history } = await loadConversationHistory(msg);

  // 始终引用用户的最新一条消息（确定性，无随机）
  if (Array.isArray(history.userMessages) && history.userMessages.length > 0) {
    const lastUserMsg = history.userMessages[history.userMessages.length - 1];
    return lastUserMsg.message_id || msg.message_id;
  }

  // 兜底：引用当前用户消息
  return msg.message_id;
}

/**
 * 更新对话历史（写入本地 Map，并尝试同步到 Redis）
 */
export async function updateConversationHistory(msg, messageId = null, isBot = false) {
  const { conversationKey, isPrivate, history } = await loadConversationHistory(msg);

  const now = Date.now();

  if (isBot && messageId) {
    // 记录机器人消息
    history.botMessages.push({ message_id: messageId, timestamp: now });
    // 可选：按条数裁剪（0 表示不限制）
    if (REDIS_CONV_MAX_MESSAGES > 0 && history.botMessages.length > REDIS_CONV_MAX_MESSAGES) {
      history.botMessages.splice(0, history.botMessages.length - REDIS_CONV_MAX_MESSAGES);
    }
  } else {
    // 记录用户消息
    history.userMessages.push({ message_id: msg.message_id, timestamp: now });
    // 可选：按条数裁剪（0 表示不限制）
    if (REDIS_CONV_MAX_MESSAGES > 0 && history.userMessages.length > REDIS_CONV_MAX_MESSAGES) {
      history.userMessages.splice(0, history.userMessages.length - REDIS_CONV_MAX_MESSAGES);
    }
  }

  // 更新本地缓存
  saveLocalHistory(conversationKey, history);

  // 尝试同步到 Redis（失败不影响主流程）
  await saveHistoryToRedis(conversationKey, isPrivate, history);
}

/**
 * 获取最近的若干条对话历史（按时间升序排序）
 * @param {Object} msg - 原始消息对象
 * @param {Object} options
 * @param {number} options.userLimit - 返回的用户消息最大条数（<=0 表示不限制）
 * @param {number} options.botLimit - 返回的机器人消息最大条数（<=0 表示不限制）
 * @returns {Promise<{ userMessages: Array, botMessages: Array }>}
 */
export async function getConversationHistoryRecent(msg, options = {}) {
  const { history } = await loadConversationHistory(msg);
  const { userLimit = 0, botLimit = 0 } = options;

  const sortByTime = (arr) => [...arr].sort((a, b) => {
    const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
    const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
    return ta - tb;
  });

  let userMessages = sortByTime(history.userMessages || []);
  let botMessages = sortByTime(history.botMessages || []);

  if (userLimit > 0 && userMessages.length > userLimit) {
    userMessages = userMessages.slice(userMessages.length - userLimit);
  }
  if (botLimit > 0 && botMessages.length > botLimit) {
    botMessages = botMessages.slice(botMessages.length - botLimit);
  }

  return { userMessages, botMessages };
}

/**
 * 按时间范围获取会话历史（左闭右开区间 [start, end)）
 * @param {Object} msg - 原始消息对象
 * @param {number} startTimestamp - 起始时间戳（毫秒）
 * @param {number} endTimestamp - 结束时间戳（毫秒），<=0 表示不限上界
 * @returns {Promise<{ userMessages: Array, botMessages: Array }>}
 */
export async function getConversationHistoryByTimeRange(msg, startTimestamp, endTimestamp = 0) {
  const { history } = await loadConversationHistory(msg);

  const inRange = (ts) => {
    const t = typeof ts === 'number' ? ts : 0;
    if (t < startTimestamp) return false;
    if (endTimestamp > 0 && t >= endTimestamp) return false;
    return true;
  };

  const userMessages = (history.userMessages || [])
    .filter((item) => inRange(item.timestamp))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const botMessages = (history.botMessages || [])
    .filter((item) => inRange(item.timestamp))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  return { userMessages, botMessages };
}
