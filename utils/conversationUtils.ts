import { getRedis } from './redisClient.js';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt } from './envHotReloader.js';

const logger = createLogger('ConversationUtils');

/**
 * 对话历史管理模块
 * 包含对话历史的存储、更新和查询
 */

type ConversationMessage = {
  message_id?: string | number | null;
  timestamp?: number;
};

type ConversationHistory = {
  userMessages: ConversationMessage[];
  botMessages: ConversationMessage[];
};

type ConversationMessageInput = {
  type?: string;
  sender_id?: string | number | null;
  group_id?: string | number | null;
  message_id?: string | number | null;
};

type ConversationHistoryRecentOptions = {
  userLimit?: number;
  botLimit?: number;
};

// 存储对话历史
const conversationHistory = new Map<string, ConversationHistory>();

function getConversationRedisRuntimeConfig() {
  const convMaxMessagesRaw = getEnv('REDIS_CONV_MAX_MESSAGES', '0') || '0';
  const convMaxMessagesParsed = parseInt(convMaxMessagesRaw, 10);
  const maxMessages = Number.isNaN(convMaxMessagesParsed) ? 0 : convMaxMessagesParsed;

  const ttlRaw = getEnvInt('REDIS_CONV_TTL_SECONDS', 86400);
  const ttlSeconds = typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) ? ttlRaw : 86400;
  return {
    privatePrefix: getEnv('REDIS_CONV_PRIVATE_PREFIX', 'sentra:conv:private:') || 'sentra:conv:private:',
    groupPrefix: getEnv('REDIS_CONV_GROUP_PREFIX', 'sentra:conv:group:') || 'sentra:conv:group:',
    ttlSeconds,
    maxMessages
  };
}

function buildConversationKey(msg: ConversationMessageInput): string {
  const senderId = msg.sender_id != null ? String(msg.sender_id) : '';
  const groupId = msg.group_id != null ? String(msg.group_id) : '';
  return msg.type === 'private'
    ? senderId
    : `group_${groupId}_${senderId}`;
}

function getLocalHistory(conversationKey: string): ConversationHistory {
  return conversationHistory.get(conversationKey) || { userMessages: [], botMessages: [] };
}

function saveLocalHistory(conversationKey: string, history: ConversationHistory) {
  conversationHistory.set(conversationKey, history);
}

function normalizeMessage(item: unknown, fallbackTimestamp: number): ConversationMessage {
  if (!item || typeof item !== 'object') {
    return { timestamp: fallbackTimestamp };
  }
  const obj = item as Record<string, unknown>;
  const messageIdRaw = obj.message_id;
  const timestampRaw = obj.timestamp;
  return {
    message_id: typeof messageIdRaw === 'string' || typeof messageIdRaw === 'number' ? messageIdRaw : null,
    timestamp: typeof timestampRaw === 'number' ? timestampRaw : fallbackTimestamp
  };
}

function normalizeHistory(raw: unknown): ConversationHistory {
  const now = Date.now();
  if (!raw || typeof raw !== 'object') {
    return { userMessages: [], botMessages: [] };
  }
  const obj = raw as Record<string, unknown>;
  const userRaw = Array.isArray(obj.userMessages) ? obj.userMessages : [];
  const botRaw = Array.isArray(obj.botMessages) ? obj.botMessages : [];
  return {
    userMessages: userRaw.map((item) => normalizeMessage(item, now)),
    botMessages: botRaw.map((item) => normalizeMessage(item, now))
  };
}

async function loadHistoryFromRedis(conversationKey: string, isPrivate: boolean): Promise<ConversationHistory | null> {
  const redis = getRedis();
  if (!redis) return null;

  const { privatePrefix, groupPrefix } = getConversationRedisRuntimeConfig();
  const prefix = isPrivate ? privatePrefix : groupPrefix;
  const key = `${prefix}${conversationKey}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizeHistory(parsed);
  } catch (e) {
    logger.warn('加载 Redis 对话历史失败，回退本地缓存', { err: String(e), conversationKey });
    return null;
  }
}

async function saveHistoryToRedis(
  conversationKey: string,
  isPrivate: boolean,
  history: ConversationHistory
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const { privatePrefix, groupPrefix, ttlSeconds } = getConversationRedisRuntimeConfig();
  const prefix = isPrivate ? privatePrefix : groupPrefix;
  const key = `${prefix}${conversationKey}`;
  try {
    const data = JSON.stringify(history);
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await redis.set(key, data, 'EX', ttlSeconds);
    } else {
      await redis.set(key, data);
    }
  } catch (e) {
    logger.warn('保存 Redis 对话历史失败（忽略并继续使用本地缓存）', { err: String(e), conversationKey });
  }
}

async function loadConversationHistory(msg: ConversationMessageInput): Promise<{
  conversationKey: string;
  isPrivate: boolean;
  history: ConversationHistory;
}> {
  const conversationKey = buildConversationKey(msg);
  const isPrivate = msg.type === 'private';

  // 优先尝试从 Redis 读取，失败则回退本地 Map
  let history = await loadHistoryFromRedis(conversationKey, isPrivate);
  if (!history) {
    history = getLocalHistory(conversationKey);
  }

  const normalized = normalizeHistory(history);
  history = normalized;

  // 规范化后的结构写回本地缓存
  saveLocalHistory(conversationKey, history);

  return { conversationKey, isPrivate, history };
}

/**
 * 获取可引用的消息ID（优先从 Redis 读取，失败时回退本地 Map）
 */
export async function getReplyableMessageId(
  msg: ConversationMessageInput
): Promise<string | number | null | undefined> {
  const { history } = await loadConversationHistory(msg);

  // 始终引用用户的最新一条消息（确定性，无随机）
  if (Array.isArray(history.userMessages) && history.userMessages.length > 0) {
    const lastUserMsg = history.userMessages[history.userMessages.length - 1];
    if (lastUserMsg && lastUserMsg.message_id != null) {
      return lastUserMsg.message_id;
    }
    return msg.message_id;
  }

  // 兜底：引用当前用户消息
  return msg.message_id;
}

/**
 * 更新对话历史（写入本地 Map，并尝试同步到 Redis）
 */
export async function updateConversationHistory(
  msg: ConversationMessageInput,
  messageId: string | number | null = null,
  isBot: boolean = false
): Promise<void> {
  const { conversationKey, isPrivate, history } = await loadConversationHistory(msg);
  const { maxMessages } = getConversationRedisRuntimeConfig();

  const now = Date.now();

  if (isBot && messageId != null) {
    // 记录机器人消息
    history.botMessages.push({ message_id: messageId, timestamp: now });
    // 可选：按条数裁剪（0 表示不限制）
    if (maxMessages > 0 && history.botMessages.length > maxMessages) {
      history.botMessages.splice(0, history.botMessages.length - maxMessages);
    }
  } else {
    // 记录用户消息
    history.userMessages.push({ message_id: msg.message_id ?? null, timestamp: now });
    // 可选：按条数裁剪（0 表示不限制）
    if (maxMessages > 0 && history.userMessages.length > maxMessages) {
      history.userMessages.splice(0, history.userMessages.length - maxMessages);
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
function takeLast<T>(items: T[], limit: number): T[] {
  if (!Array.isArray(items) || limit <= 0 || items.length <= limit) return items;
  const out: T[] = [];
  for (let i = items.length - limit; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export async function getConversationHistoryRecent(
  msg: ConversationMessageInput,
  options: ConversationHistoryRecentOptions = {}
): Promise<{ userMessages: ConversationMessage[]; botMessages: ConversationMessage[] }> {
  const { history } = await loadConversationHistory(msg);
  const { userLimit = 0, botLimit = 0 } = options;

  const sortByTime = (arr: ConversationMessage[]) => [...arr].sort((a, b) => {
    const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
    const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
    return ta - tb;
  });

  let userMessages = sortByTime(history.userMessages || []);
  let botMessages = sortByTime(history.botMessages || []);

  if (userLimit > 0) {
    userMessages = takeLast(userMessages, userLimit);
  }
  if (botLimit > 0) {
    botMessages = takeLast(botMessages, botLimit);
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
export async function getConversationHistoryByTimeRange(
  msg: ConversationMessageInput,
  startTimestamp: number,
  endTimestamp: number = 0
): Promise<{ userMessages: ConversationMessage[]; botMessages: ConversationMessage[] }> {
  const { history } = await loadConversationHistory(msg);

  const inRange = (ts: number | undefined) => {
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
