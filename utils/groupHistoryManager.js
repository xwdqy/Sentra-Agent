import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';
import { escapeXml, escapeXmlAttr } from './xmlUtils.js';
import { getRedis } from './redisClient.js';
import { getEnv, getEnvInt } from './envHotReloader.js';
import { TokenCounter } from '../src/token-counter.js';

const logger = createLogger('GroupHistory');

let tokenCounterSingleton = null;
function getTokenCounterSingleton() {
  if (tokenCounterSingleton) return tokenCounterSingleton;
  tokenCounterSingleton = new TokenCounter();
  return tokenCounterSingleton;
}

function getGroupHistoryKeyPrefix() {
  return getEnv('REDIS_GROUP_HISTORY_PREFIX', 'sentra:group:');
}

function getGroupHistoryTtlSeconds() {
  return getEnvInt('REDIS_GROUP_HISTORY_TTL_SECONDS', 0) || 0;
}

function getDecisionGroupRecentMessagesDefault() {
  return getEnvInt('REPLY_DECISION_GROUP_RECENT_MESSAGES', 15);
}

function getDecisionSenderRecentMessagesDefault() {
  return getEnvInt('REPLY_DECISION_SENDER_RECENT_MESSAGES', 5);
}

function getDecisionBotRecentMessagesDefault() {
  return getEnvInt('REPLY_DECISION_BOT_RECENT_MESSAGES', 4);
}

function getDecisionContextMaxCharsDefault() {
  return getEnvInt('REPLY_DECISION_CONTEXT_MAX_CHARS', 120);
}

/**
 * Per-Group
 * 确保同一个群内的操作串行执行，避免并发写入冲突
 */
class GroupTaskQueue extends EventEmitter {
  constructor() {
    super();
    this.running = 0;
    this.queue = [];
  }

  /**
   * 添加任务到队列
   * @param {Function} task - 异步任务函数，返回 Promise
   * @returns {Promise} 任务执行结果
   */
  async pushTask(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      process.nextTick(() => this.next());
    });
  }

  /**
   * 执行队列中的下一个任务
   */
  async next() {
    // 如果正在执行任务或队列为空，退出
    if (this.running > 0 || this.queue.length === 0) {
      if (this.running === 0 && this.queue.length === 0) {
        this.emit('empty');
      }
      return;
    }

    // 取出下一个任务
    const item = this.queue.shift();
    this.running++;

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      this.emit('error', error);
      item.reject(error);
    } finally {
      this.running--;
      process.nextTick(() => this.next());
    }
  }
}

/**
 * 将内存中的群历史结构序列化为可写入 Redis 的纯 JSON 对象
 */
function serializeHistory(history) {
  const senderLastMessageTimeObj = {};
  if (history.senderLastMessageTime && history.senderLastMessageTime instanceof Map) {
    for (const [senderId, ts] of history.senderLastMessageTime.entries()) {
      senderLastMessageTimeObj[String(senderId)] = ts;
    }
  }

  const scopedConversationsBySenderObj = {};
  if (history.scopedConversationsBySender && history.scopedConversationsBySender instanceof Map) {
    for (const [senderId, arr] of history.scopedConversationsBySender.entries()) {
      if (!senderId) continue;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      scopedConversationsBySenderObj[String(senderId)] = arr;
    }
  }

  const activePairsObj = {};
  if (history.activePairs && history.activePairs instanceof Map) {
    for (const [pairId, ctx] of history.activePairs.entries()) {
      if (!ctx || typeof ctx !== 'object') continue;

      const assistant = typeof ctx.assistant === 'string' ? ctx.assistant : '';
      const userContent = typeof ctx.userContent === 'string' ? ctx.userContent : null;
      const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
      const createdAt = typeof ctx.createdAt === 'number' ? ctx.createdAt : 0;
      const lastUpdatedAt = typeof ctx.lastUpdatedAt === 'number'
        ? ctx.lastUpdatedAt
        : createdAt;
      const status = typeof ctx.status === 'string' ? ctx.status : 'building';
      const scopeSenderId = typeof ctx.scopeSenderId === 'string' ? ctx.scopeSenderId : null;
      const commitMode = typeof ctx.commitMode === 'string' ? ctx.commitMode : 'shared';

      activePairsObj[String(pairId)] = {
        assistant,
        userContent,
        messages,
        createdAt,
        lastUpdatedAt,
        status,
        scopeSenderId,
        commitMode
      };
    }
  }

  return {
    conversations: Array.isArray(history.conversations) ? history.conversations : [],
    scopedConversationsBySender: scopedConversationsBySenderObj,
    pendingMessages: Array.isArray(history.pendingMessages) ? history.pendingMessages : [],
    processingMessages: Array.isArray(history.processingMessages) ? history.processingMessages : [],
    activePairs: activePairsObj,
    senderLastMessageTime: senderLastMessageTimeObj
  };
}

/**
 * 将 Redis 中读取的 JSON 对象反序列化为内存结构（包含 Map）
 */
function deserializeHistory(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const senderLastMessageTime = new Map();
  if (data.senderLastMessageTime && typeof data.senderLastMessageTime === 'object') {
    for (const [senderId, ts] of Object.entries(data.senderLastMessageTime)) {
      senderLastMessageTime.set(String(senderId), ts);
    }
  }

  const activePairs = new Map();
  if (data.activePairs && typeof data.activePairs === 'object') {
    for (const [pairId, ctx] of Object.entries(data.activePairs)) {
      if (!ctx || typeof ctx !== 'object') continue;

      const createdAt = typeof ctx.createdAt === 'number' ? ctx.createdAt : 0;
      const lastUpdatedAt = typeof ctx.lastUpdatedAt === 'number'
        ? ctx.lastUpdatedAt
        : createdAt;
      const assistant = typeof ctx.assistant === 'string' ? ctx.assistant : '';
      const userContent = typeof ctx.userContent === 'string' ? ctx.userContent : null;
      const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
      let status = typeof ctx.status === 'string' ? ctx.status : 'building';
      if (status !== 'building' && status !== 'finished' && status !== 'cancelled') {
        status = 'building';
      }

      activePairs.set(String(pairId), {
        assistant,
        userContent,
        messages,
        createdAt,
        lastUpdatedAt,
        status,
        scopeSenderId: typeof ctx.scopeSenderId === 'string' ? ctx.scopeSenderId : null,
        commitMode: typeof ctx.commitMode === 'string' ? ctx.commitMode : 'shared'
      });
    }
  }

  const scopedConversationsBySender = new Map();
  if (data.scopedConversationsBySender && typeof data.scopedConversationsBySender === 'object') {
    for (const [senderId, arr] of Object.entries(data.scopedConversationsBySender)) {
      if (!senderId) continue;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      scopedConversationsBySender.set(String(senderId), arr);
    }
  }

  return {
    conversations: Array.isArray(data.conversations) ? data.conversations : [],
    scopedConversationsBySender,
    pendingMessages: Array.isArray(data.pendingMessages) ? data.pendingMessages : [],
    processingMessages: Array.isArray(data.processingMessages) ? data.processingMessages : [],
    activePairs,
    senderLastMessageTime
  };
}

async function loadHistoryFromRedis(groupId) {
  const redis = getRedis();
  if (!redis) return null;

  const key = `${getGroupHistoryKeyPrefix()}${groupId}`;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return deserializeHistory(parsed);
  } catch (e) {
    logger.warn('加载 Redis 群历史失败，回退本地缓存', { err: String(e), groupId });
    return null;
  }
}

async function saveHistoryToRedis(groupId, history) {
  const redis = getRedis();
  if (!redis) return;

  const key = `${getGroupHistoryKeyPrefix()}${groupId}`;
  try {
    const payload = JSON.stringify(serializeHistory(history));
    const ttlSeconds = getGroupHistoryTtlSeconds();
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await redis.set(key, payload, 'EX', ttlSeconds);
    } else {
      await redis.set(key, payload);
    }
  } catch (e) {
    logger.warn('保存 Redis 群历史失败（忽略并继续使用本地缓存）', { err: String(e), groupId });
  }
}

async function deleteHistoryFromRedis(groupId) {
  const redis = getRedis();
  if (!redis) return;

  const key = `${getGroupHistoryKeyPrefix()}${groupId}`;
  try {
    await redis.del(key);
  } catch (e) {
    logger.warn('删除 Redis 群历史失败（忽略）', { err: String(e), groupId });
  }
}

/**
 * 群聊历史记录管理器
 * 
 * 核心特性：
 * 1. 按 group_id 分隔存储历史记录
 * 2. 每个群有独立的任务队列，确保串行执行
 * 3. 不同群之间可以并发处理
 * 4. 使用 UUID 标记每一对对话，支持精确撤销
 * 
 * 数据结构：
 * - conversations: [{ role: 'user'|'assistant', content: string, pairId: string }]
 * - pendingMessages: [{ summary: string, msgObj: Object }]
 * - processingMessages: [{ summary: string, msgObj: Object }]
 * - activePairs: Map<pairId, { assistant, userContent, createdAt, lastUpdatedAt, status }>
 */
class GroupHistoryManager {
  constructor(options = {}) {
    // 配置
    this.maxConversationPairs = options.maxConversationPairs || 20;
    
    // 每个群的历史数据
    // Map<groupId, { conversations, pendingMessages, processingMessages, activePairs, senderLastMessageTime }>
    this.histories = new Map();
    
    // 每个群的任务队列（确保串行执行）
    // Map<groupId, GroupTaskQueue>
    this.queues = new Map();
  }

  /**
   * 为指定群执行任务（自动加入该群的队列）
   * @param {string} groupId - 群ID
   * @param {Function} task - 异步任务函数
   * @returns {Promise} 任务执行结果
   */
  async _executeForGroup(groupId, task) {
    // 确保该群有队列
    if (!this.queues.has(groupId)) {
      const queue = new GroupTaskQueue();
      queue.on('error', (error) => {
        logger.error(`队列错误: ${groupId}`, error);
      });
      this.queues.set(groupId, queue);
    }

    // 将任务加入队列（串行执行）
    const queue = this.queues.get(groupId);
    return queue.pushTask(task);
  }

  /**
   * 获取或初始化群组历史记录
   * @param {string} groupId - 群ID
   * @returns {Object} 群组历史对象
   */
  async _getOrInitHistory(groupId) {
    if (this.histories.has(groupId)) {
      return this.histories.get(groupId);
    }

    // 优先尝试从 Redis 加载历史
    const loaded = await loadHistoryFromRedis(groupId);
    if (loaded) {
      this.histories.set(groupId, loaded);
      return loaded;
    }

    // Redis 中也没有，则创建新的空历史
    const initial = {
      conversations: [],              // 完整的对话历史（user/assistant对）
      scopedConversationsBySender: new Map(),
      pendingMessages: [],             // 待处理的消息列表（还未开始处理）
      processingMessages: [],          // 正在处理的消息列表（已开始处理，但未完成）
      senderLastMessageTime: new Map(), // 记录每个sender的最后消息时间（用于超时清理）
      activePairs: new Map()           // 按 pairId 管理的活动对话上下文
    };
    this.histories.set(groupId, initial);
    return initial;
  }

  /**
   * 添加待回复消息（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} summary - 消息摘要
   * @param {Object} msgObj - 原始消息对象
   * @returns {Promise<void>}
   */
  async addPendingMessage(groupId, summary, msgObj) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      const senderId = String(msgObj.sender_id);
      const now = Date.now();
      const messageId = msgObj && msgObj.message_id != null ? String(msgObj.message_id) : '';
      
      // 清理超时的sender消息（超过2分钟没有新消息）
      const cleanupResult = this._cleanupTimeoutMessages(history, now);
      if (cleanupResult.cleaned > 0) {
        logger.debug(`超时清理: ${groupId} 清理了${cleanupResult.cleaned}个sender的消息`);
      }
      
      // 记录当前sender的最后消息时间
      history.senderLastMessageTime.set(senderId, now);
      
      // 添加消息到待回复队列
      if (messageId) {
        const existsInPending = (history.pendingMessages || []).some(
          (pm) => pm && pm.msgObj && pm.msgObj.message_id != null && String(pm.msgObj.message_id) === messageId
        );
        const existsInProcessing = (history.processingMessages || []).some(
          (pm) => pm && pm.msgObj && pm.msgObj.message_id != null && String(pm.msgObj.message_id) === messageId
        );

        if (existsInPending || existsInProcessing) {
          logger.info(`待回复ADD去重: ${groupId} sender ${msgObj.sender_id}, msg ${messageId} 已存在，跳过重复入队`);
          await saveHistoryToRedis(groupId, history);
          return;
        }
      }

      history.pendingMessages.push({ summary, msgObj, timestamp: now });
      
      logger.debug(`待回复ADD: ${groupId} sender ${msgObj.sender_id}, msg ${messageId || msgObj.message_id}, 当前${history.pendingMessages.length}条待回复`);

      await saveHistoryToRedis(groupId, history);
    });
  }

  async appendToConversationPairMessages(groupId, pairId, role, content) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      if (!pairId) {
        logger.warn(`追加pair消息跳过: ${groupId} 未传入pairId (调用方状态异常)`);
        return;
      }

      const ctx = history.activePairs.get(pairId);
      const shortId = String(pairId).substring(0, 8);
      if (!ctx) {
        logger.debug(`追加pair消息跳过: ${groupId} pairId ${shortId} 不在活动列表中 (可能已完成/取消)`);
        return;
      }

      if (ctx.status !== 'building') {
        logger.debug(`追加pair消息跳过: ${groupId} pairId ${shortId} 状态为${ctx.status}`);
        return;
      }

      if (!ctx.messages || !Array.isArray(ctx.messages)) {
        ctx.messages = [];
      }

      const safeRole = role === 'assistant' ? 'assistant' : 'user';
      const safeContent = typeof content === 'string' ? content : String(content ?? '');
      ctx.messages.push({ role: safeRole, content: safeContent });
      ctx.lastUpdatedAt = Date.now();

      await saveHistoryToRedis(groupId, history);
    });
  }

  async promoteScopedConversationsToShared(groupId, senderId) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history) return false;
      if (!history.scopedConversationsBySender || !(history.scopedConversationsBySender instanceof Map)) {
        history.scopedConversationsBySender = new Map();
      }
      const sid = String(senderId || '').trim();
      if (!sid) return false;
      const scoped = history.scopedConversationsBySender.get(sid);
      if (!Array.isArray(scoped) || scoped.length === 0) return false;

      history.conversations.push(...scoped);
      history.scopedConversationsBySender.delete(sid);

      try {
        const limit = this.maxConversationPairs;
        if (Number.isFinite(limit) && limit > 0) {
          const orderedPairIds = [];
          const seen = new Set();
          for (const m of history.conversations) {
            const pid = m && m.pairId != null ? String(m.pairId) : '';
            if (!pid) continue;
            if (seen.has(pid)) continue;
            seen.add(pid);
            orderedPairIds.push(pid);
          }
          if (orderedPairIds.length > limit) {
            const drop = new Set(orderedPairIds.slice(0, orderedPairIds.length - limit));
            history.conversations = history.conversations.filter((m) => {
              const pid = m && m.pairId != null ? String(m.pairId) : '';
              return pid && !drop.has(pid);
            });
          }
        }
      } catch {}

      await saveHistoryToRedis(groupId, history);
      return true;
    });
  }

  async clearScopedConversationsForSender(groupId, senderId) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history) return false;
      if (!history.scopedConversationsBySender || !(history.scopedConversationsBySender instanceof Map)) {
        history.scopedConversationsBySender = new Map();
      }
      const sid = String(senderId || '').trim();
      if (!sid) return false;
      const existed = history.scopedConversationsBySender.has(sid);
      if (existed) {
        history.scopedConversationsBySender.delete(sid);
        await saveHistoryToRedis(groupId, history);
      }
      return existed;
    });
  }

  /**
   * 清理超时的sender消息（内部方法，不加锁）
   * @param {Object} history - 群组历史对象
   * @param {number} now - 当前时间戳
   * @param {number} timeoutMs - 超时时间（毫秒），默认2分钟
   * @returns {Object} 清理结果 {cleaned: number, details: string[]}
   * @private
   */
  _cleanupTimeoutMessages(history, now, timeoutMs = 2 * 60 * 1000) {
    const timeoutSenders = [];
    const cleaned = { cleaned: 0, details: [] };
    
    // 检查每个sender是否超时
    for (const [senderId, lastTime] of history.senderLastMessageTime.entries()) {
      if (now - lastTime > timeoutMs) {
        timeoutSenders.push(senderId);
      }
    }
    
    if (timeoutSenders.length === 0) {
      return cleaned;
    }
    
    // 清理超时sender的消息
    for (const senderId of timeoutSenders) {
      const beforeCount = history.pendingMessages.length;
      
      // 从 pendingMessages 中移除该sender的消息
      const removed = history.pendingMessages.filter(pm => String(pm.msgObj.sender_id) === senderId);
      history.pendingMessages = history.pendingMessages.filter(pm => String(pm.msgObj.sender_id) !== senderId);
      
      // 从 processingMessages 中移除该sender的消息
      const removedProcessing = history.processingMessages.filter(pm => String(pm.msgObj.sender_id) === senderId);
      history.processingMessages = history.processingMessages.filter(pm => String(pm.msgObj.sender_id) !== senderId);
      
      const totalRemoved = removed.length + removedProcessing.length;

      let removedScoped = false;
      if (history.scopedConversationsBySender && history.scopedConversationsBySender instanceof Map) {
        if (history.scopedConversationsBySender.has(senderId)) {
          history.scopedConversationsBySender.delete(senderId);
          removedScoped = true;
        }
      }
      
      if (totalRemoved > 0 || removedScoped) {
        // 计算超时时间（在删除前获取）
        const lastTime = history.senderLastMessageTime.get(senderId);
        const timeoutSeconds = Math.floor((now - (lastTime || now)) / 1000);
        
        // 从时间记录中删除
        history.senderLastMessageTime.delete(senderId);
        
        cleaned.cleaned++;
        cleaned.details.push(
          `sender:${senderId}, 清理${totalRemoved}条消息${removedScoped ? '+scoped' : ''}, 超时${timeoutSeconds}秒`
        );
      }
    }
    
    return cleaned;
  }

  /**
   * 获取所有待回复消息的内容（Sentra XML 格式）
   * @param {string} groupId - 群ID
   * @returns {string} Sentra XML 格式的待回复消息
   */
  getPendingMessagesXML(groupId) {
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return '';
    }

    // 构建 <sentra-pending-messages> XML 结构
    let xml = '<sentra-pending-messages>\n';
    xml += `  <total_count>${history.pendingMessages.length}</total_count>\n`;
    xml += '  <messages>\n';
    
    history.pendingMessages.forEach((pm, index) => {
      const msg = pm.msgObj;
      xml += `    <message index="${escapeXmlAttr(String(index + 1))}">\n`;
      xml += `      <sender_id>${escapeXml(String(msg.sender_id || ''))}</sender_id>\n`;
      xml += `      <sender_name>${escapeXml(msg.sender_name || 'Unknown')}</sender_name>\n`;
      xml += `      <text>${escapeXml(msg.text || msg.summary || '')}</text>\n`;
      xml += `      <time>${escapeXml(msg.time_str || '')}</time>\n`;
      
      // 添加消息 ID（用于引用回复）
      if (msg.message_id) {
        xml += `      <message_id>${escapeXml(String(msg.message_id))}</message_id>\n`;
      }
      
      // 添加 at 信息
      if (msg.at_bot) {
        xml += `      <at_bot>true</at_bot>\n`;
      }
      if (msg.at_me) {
        xml += `      <at_me>true</at_me>\n`;
      }
      
      xml += `    </message>\n`;
    });
    
    xml += '  </messages>\n';
    xml += '</sentra-pending-messages>';
    
    return xml;
  }

  _escapeXmlText(str) {
    return escapeXml(str);
  }

  _truncateForDecisionContext(text, maxChars) {
    const str = String(text || '');
    if (!maxChars || maxChars <= 0 || str.length <= maxChars) {
      return str;
    }
    return str.slice(0, maxChars) + '...';
  }

  /**
   * 获取所有待回复消息的内容（简单字符串格式，已废弃）
   * @deprecated 使用 getPendingMessagesXML() 代替
   * @param {string} groupId - 群ID
   * @returns {string} 组合后的消息内容
   */
  getPendingMessagesContent(groupId) {
    logger.warn('getPendingMessagesContent() 已废弃，请使用 getPendingMessagesXML()');
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return '';
    }
    return history.pendingMessages.map(pm => pm.summary).join('\n\n');
  }

  /**
   * 获取历史上下文消息（Sentra XML 格式）
   * 注意：这只是参考信息，真正需要回复的消息通过 <sentra-user-question> 提供
   * @param {string} groupId - 群ID
   * @param {string} [senderId] - 可选，发送者ID，如果提供则只返回该发送者的历史消息
   * @returns {string} Sentra XML 格式的历史上下文消息（如果没有则返回空字符串）
   */
  getPendingMessagesContext(groupId, senderId = null) {
    const history = this.histories.get(groupId);
    if (!history) {
      return '';
    }

    // 合并待处理和正在处理的消息
    const allMessages = [
      ...(history.pendingMessages || []),
      ...(history.processingMessages || [])
    ];

    // 如果指定了 senderId：
    // - 私聊：保持原语义，仅返回该 sender 的历史消息（不包含最新一条）
    // - 群聊：返回“全群上下文累计 + 该 sender 自身累计”两段，其他人的在上，该 sender 的在下
    if (senderId) {
      const sid = String(senderId);
      const isGroup = String(groupId || '').startsWith('G:');

      const senderMsgs = allMessages.filter((pm) => String(pm?.msgObj?.sender_id) === sid);
      const senderContext = senderMsgs.length <= 1 ? [] : senderMsgs.slice(0, -1);

      if (!isGroup) {
        if (senderContext.length === 0) return '';

        let xml = '<sentra-pending-messages>\n';
        xml += `  <total_count>${senderContext.length}</total_count>\n`;
        xml += `  <note>以下是该用户的历史消息，仅供参考。当前需要回复的消息见 &lt;sentra-user-question&gt;</note>\n`;
        xml += '  <context_messages>\n';

        senderContext.forEach((pm, index) => {
          const msg = pm.msgObj;
          xml += `    <message index="${escapeXmlAttr(String(index + 1))}">\n`;
          xml += `      <sender_name>${this._escapeXmlText(msg.sender_name || 'Unknown')}</sender_name>\n`;
          xml += `      <text>${this._escapeXmlText(msg.text || msg.summary || '')}</text>\n`;
          xml += `      <time>${this._escapeXmlText(msg.time_str || '')}</time>\n`;
          xml += `    </message>\n`;
        });

        xml += '  </context_messages>\n';
        xml += '</sentra-pending-messages>';
        return xml;
      }

      const othersPending = Array.isArray(history.pendingMessages) ? history.pendingMessages : [];
      const othersContext = othersPending.filter((pm) => String(pm?.msgObj?.sender_id) !== sid);
      const total = othersContext.length + senderContext.length;
      if (total === 0) return '';

      let xml = '<sentra-pending-messages>\n';
      xml += `  <total_count>${total}</total_count>\n`;
      xml += '  <note>以下是群聊近期上下文累计（仅供参考）。为帮助你理解群聊氛围：上半部分是“其他成员的未回复消息”，下半部分是“该用户自己的累计消息（不含当前最新一条）”。当前需要回复的消息见 &lt;sentra-user-question&gt;</note>\n';

      xml += '  <group_context_messages>\n';
      othersContext.forEach((pm, index) => {
        const msg = pm.msgObj;
        xml += `    <message index="${escapeXmlAttr(String(index + 1))}">\n`;
        xml += `      <sender_id>${this._escapeXmlText(String(msg.sender_id || ''))}</sender_id>\n`;
        xml += `      <sender_name>${this._escapeXmlText(msg.sender_name || 'Unknown')}</sender_name>\n`;
        xml += `      <text>${this._escapeXmlText(msg.text || msg.summary || '')}</text>\n`;
        xml += `      <time>${this._escapeXmlText(msg.time_str || '')}</time>\n`;
        xml += '    </message>\n';
      });
      xml += '  </group_context_messages>\n';

      xml += '  <sender_context_messages>\n';
      senderContext.forEach((pm, index) => {
        const msg = pm.msgObj;
        xml += `    <message index="${escapeXmlAttr(String(index + 1))}">\n`;
        xml += `      <sender_name>${this._escapeXmlText(msg.sender_name || 'Unknown')}</sender_name>\n`;
        xml += `      <text>${this._escapeXmlText(msg.text || msg.summary || '')}</text>\n`;
        xml += `      <time>${this._escapeXmlText(msg.time_str || '')}</time>\n`;
        xml += '    </message>\n';
      });
      xml += '  </sender_context_messages>\n';

      xml += '</sentra-pending-messages>';
      return xml;
    }

    // 如果没有指定 senderId，返回所有消息的历史（除了最后一条）
    if (allMessages.length <= 1) {
      return '';
    }
    const contextMessages = allMessages.slice(0, -1);
    if (contextMessages.length === 0) {
      return '';
    }

    // 构建 Sentra XML 格式（只包含历史上下文）
    let xml = '<sentra-pending-messages>\n';
    xml += `  <total_count>${contextMessages.length}</total_count>\n`;
    xml += `  <note>以下是近期对话上下文，仅供参考。当前需要回复的消息见 &lt;sentra-user-question&gt;</note>\n`;
    xml += '  <context_messages>\n';

    contextMessages.forEach((pm, index) => {
      const msg = pm.msgObj;
      xml += `    <message index="${escapeXmlAttr(String(index + 1))}">\n`;
      xml += `      <sender_name>${this._escapeXmlText(msg.sender_name || 'Unknown')}</sender_name>\n`;
      xml += `      <text>${this._escapeXmlText(msg.text || msg.summary || '')}</text>\n`;
      xml += `      <time>${this._escapeXmlText(msg.time_str || '')}</time>\n`;
      xml += `    </message>\n`;
    });

    xml += '  </context_messages>\n';
    xml += '</sentra-pending-messages>';

    return xml;
  }

  /**
   * 格式化待回复消息（已废弃，使用 getPendingMessagesContext 代替）
   * @deprecated 使用 getPendingMessagesContext() + buildSentraUserQuestionBlock() 代替
   */
  formatPendingMessagesForAI(groupId, targetSenderId = null) {
    logger.warn('formatPendingMessagesForAI() 已废弃，请使用 getPendingMessagesContext()');
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return { xml: '', objective: '完成用户请求', hasContext: false, targetMsg: null };
    }

    const lastMsg = history.pendingMessages[history.pendingMessages.length - 1];
    const contextXml = this.getPendingMessagesContext(groupId);
    
    return {
      xml: contextXml,
      objective: lastMsg.msgObj.text || lastMsg.msgObj.summary || '完成用户请求',
      hasContext: contextXml.length > 0,
      targetMsg: lastMsg.msgObj
    };
  }

  /**
   * 获取最后一条待回复消息（用于构建 sentra-user-question）
   * @param {string} groupId - 群ID
   * @returns {Object|null} 消息对象或null
   */
  getLastPendingMessage(groupId) {
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return null;
    }
    return history.pendingMessages[history.pendingMessages.length - 1].msgObj;
  }

  /**
   * 查找指定sender的最后一条消息（用于引用回复）
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Object|null} 消息对象或null
   */
  findLastMessageBySender(groupId, senderId) {
    const history = this.histories.get(groupId);
    if (!history) {
      return null;
    }

    // 从后往前查找该sender的消息
    for (let i = history.pendingMessages.length - 1; i >= 0; i--) {
      const pm = history.pendingMessages[i];
      if (pm.msgObj.sender_id === senderId) {
        logger.debug(`引用查找: ${groupId} 找到sender ${senderId} 消息 ${pm.msgObj.message_id}`);
        return pm.msgObj;
      }
    }

    logger.warn(`引用查找: ${groupId} 未找到sender ${senderId}`);
    return null;
  }

  /**
   * 开始处理指定sender_id的消息：将其从待处理队列移到正在处理队列（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Promise<Array<Object>>} 被移动的消息对象数组
   */
  async startProcessingMessages(groupId, senderId) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      
      // 筛选该sender的所有待处理消息
      const senderPending = history.pendingMessages.filter(pm => 
        String(pm.msgObj.sender_id) === String(senderId)
      );
      
      // 从待处理队列中移除
      history.pendingMessages = history.pendingMessages.filter(pm => 
        String(pm.msgObj.sender_id) !== String(senderId)
      );
      
      // 添加到正在处理队列
      history.processingMessages.push(...senderPending);
      
      logger.debug(`开始处理: ${groupId} sender ${senderId} 移动${senderPending.length}条消息 pending(${history.pendingMessages.length}) -> processing(${history.processingMessages.length})`);
      
      await saveHistoryToRedis(groupId, history);

      return senderPending.map(pm => pm.msgObj);
    });
  }

  /**
   * 获取指定sender_id在待回复队列中的所有消息（按时间顺序）
   * 包括待处理和正在处理的消息
   * 用于动态感知用户的连续输入和修正
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Array<Object>} 消息对象数组
   */
  getPendingMessagesBySender(groupId, senderId) {
    const history = this.histories.get(groupId);
    const pendingCount = history?.pendingMessages?.length || 0;
    const processingCount = history?.processingMessages?.length || 0;
    logger.debug(`动态感知GET: ${groupId} pending ${pendingCount}, processing ${processingCount}`);
    
    if (!history || (pendingCount === 0 && processingCount === 0)) {
      logger.debug(`动态感知GET: ${groupId} sender ${senderId} 队列为空`);
      return [];
    }

    // 合并待处理和正在处理的消息
    const allMessages = [
      ...(history.pendingMessages || []),
      ...(history.processingMessages || [])
    ];
    
    // logger.debug(`动态感知GET: 查询senderId ${senderId}`);
    
    // 筛选该sender的所有消息（待处理 + 正在处理）
    const senderMessages = allMessages
      .filter(pm => {
        const match = String(pm.msgObj.sender_id) === String(senderId);
        // logger.debug(`比较: ${pm.msgObj.sender_id} === ${senderId} ? ${match}`);
        return match;
      })
      .map(pm => pm.msgObj);

    //logger.debug(`动态感知GET: ${groupId} sender ${senderId} 有${senderMessages.length}条消息`);
    return senderMessages;
  }

  getRecentMessagesForDecision(groupId, senderId, options = {}) {
    const history = this.histories.get(groupId);
    if (!history) {
      return {
        group_recent_messages: [],
        sender_recent_messages: [],
        bot_recent_messages: []
      };
    }

    let groupLimit = typeof options.groupLimit === 'number' && options.groupLimit > 0
      ? options.groupLimit
      : getDecisionGroupRecentMessagesDefault();
    let senderLimit = typeof options.senderLimit === 'number' && options.senderLimit > 0
      ? options.senderLimit
      : getDecisionSenderRecentMessagesDefault();
    let botLimit = typeof options.botLimit === 'number' && options.botLimit > 0
      ? options.botLimit
      : getDecisionBotRecentMessagesDefault();
    let maxChars = typeof options.maxChars === 'number' && options.maxChars > 0
      ? options.maxChars
      : getDecisionContextMaxCharsDefault();

    if (!Number.isFinite(groupLimit) || groupLimit <= 0) {
      groupLimit = 0;
    }
    if (!Number.isFinite(senderLimit) || senderLimit <= 0) {
      senderLimit = 0;
    }
    if (!Number.isFinite(botLimit) || botLimit <= 0) {
      botLimit = 0;
    }
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
      maxChars = 0;
    }

    const allMessages = [
      ...(history.pendingMessages || []),
      ...(history.processingMessages || [])
    ];

    if (allMessages.length === 0) {
      return {
        group_recent_messages: [],
        sender_recent_messages: [],
        bot_recent_messages: []
      };
    }

    const sorted = allMessages.slice().sort((a, b) => {
      const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
      const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
      return ta - tb;
    });

    const result = {
      group_recent_messages: [],
      sender_recent_messages: [],
      bot_recent_messages: []
    };

    if (groupLimit > 0) {
      const groupSlice = sorted.slice(-groupLimit);
      result.group_recent_messages = groupSlice.map((pm) => {
        const msg = pm.msgObj || {};
        const rawText = msg.text || pm.summary || '';
        return {
          sender_id: String(msg.sender_id || ''),
          sender_name: msg.sender_name || 'Unknown',
          text: this._truncateForDecisionContext(rawText, maxChars),
          time: msg.time_str || ''
        };
      });
    }

    if (senderLimit > 0 && senderId != null) {
      const senderStr = String(senderId);
      const senderMessages = sorted.filter((pm) => String(pm.msgObj?.sender_id) === senderStr);
      if (senderMessages.length > 0) {
        const senderSlice = senderMessages.slice(-senderLimit);
        result.sender_recent_messages = senderSlice.map((pm) => {
          const msg = pm.msgObj || {};
          const rawText = msg.text || pm.summary || '';
          return {
            sender_id: String(msg.sender_id || ''),
            sender_name: msg.sender_name || 'Unknown',
            text: this._truncateForDecisionContext(rawText, maxChars),
            time: msg.time_str || ''
          };
        });
      }
    }

    if (botLimit > 0) {
      const botCandidates = [];

      const conv = Array.isArray(history.conversations) ? history.conversations : [];
      if (conv.length > 0) {
        for (const m of conv) {
          if (!m || m.role !== 'assistant') continue;
          const content = typeof m.content === 'string' ? m.content : '';
          if (!content.trim()) continue;
          const ts = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : 0;
          const pairId = m.pairId != null ? String(m.pairId) : '';
          botCandidates.push({
            text: this._truncateForDecisionContext(content, maxChars),
            time: ts > 0 ? new Date(ts).toISOString() : '',
            timestamp: ts,
            source: 'history',
            pair_id: pairId
          });
        }
      }

      const activePairs = history.activePairs && history.activePairs instanceof Map ? history.activePairs : null;
      if (activePairs) {
        for (const [pairId, ctx] of activePairs.entries()) {
          if (!ctx || ctx.status !== 'building') continue;
          const content = typeof ctx.assistant === 'string' ? ctx.assistant : '';
          if (!content.trim()) continue;
          const ts =
            typeof ctx.lastUpdatedAt === 'number' && Number.isFinite(ctx.lastUpdatedAt)
              ? ctx.lastUpdatedAt
              : (typeof ctx.createdAt === 'number' && Number.isFinite(ctx.createdAt) ? ctx.createdAt : 0);
          botCandidates.push({
            text: this._truncateForDecisionContext(content, maxChars),
            time: ts > 0 ? new Date(ts).toISOString() : '',
            timestamp: ts,
            source: 'active_pair',
            pair_id: pairId != null ? String(pairId) : ''
          });
        }
      }

      if (botCandidates.length > 0) {
        botCandidates.sort((a, b) => {
          const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
          const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
          return ta - tb;
        });
        result.bot_recent_messages = botCandidates.slice(-botLimit);
      }
    }

    return result;
  }

  /**
   * 开始构建助手回复（生成UUID标记本次对话对）（线程安全）
   * @param {string} groupId - 群ID
   * @param {{ scopeSenderId?: string, commitMode?: 'shared'|'scoped' }=} options
   * @returns {Promise<string>} 本次对话对的UUID
   */
  async startAssistantMessage(groupId, options = null) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      const scopeSenderIdRaw = options && options.scopeSenderId != null ? String(options.scopeSenderId) : '';
      const scopeSenderId = scopeSenderIdRaw ? scopeSenderIdRaw : null;
      const commitModeRaw = options && typeof options.commitMode === 'string' ? options.commitMode : 'shared';
      const commitMode = commitModeRaw === 'scoped' ? 'scoped' : 'shared';

      const pairId = randomUUID();
      const now = Date.now();

      history.activePairs.set(pairId, {
        assistant: '',
        userContent: null,
        messages: [],
        createdAt: now,
        lastUpdatedAt: now,
        status: 'building',
        scopeSenderId,
        commitMode
      });

      logger.debug(`生成对话对UUID: ${groupId} ID ${pairId}`);
      await saveHistoryToRedis(groupId, history);
      return pairId;
    });
  }

  /**
   * 追加内容到当前助手消息（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} content - 要追加的内容
   * @returns {Promise<void>}
   */
  async appendToAssistantMessage(groupId, content, pairId = null) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      if (!pairId) {
        logger.warn(`追加跳过: ${groupId} 未传入pairId (调用方状态异常)`);
        return;
      }

      const ctx = history.activePairs.get(pairId);
      const shortId = String(pairId).substring(0, 8);

      if (!ctx) {
        logger.debug(`追加跳过: ${groupId} pairId ${shortId} 不在活动列表中 (可能已完成/取消)`);
        return;
      }

      if (ctx.status !== 'building') {
        logger.debug(`追加跳过: ${groupId} pairId ${shortId} 状态为${ctx.status}`);
        return;
      }

      if (ctx.assistant) {
        ctx.assistant += '\n' + content;
      } else {
        ctx.assistant = content;
      }
      ctx.lastUpdatedAt = Date.now();

      await saveHistoryToRedis(groupId, history);
    });
  }

  /**
   * 取消当前助手消息（放弃发送）（线程安全）
   * 用于当检测到新消息时，放弃当前生成的回复
   * @param {string} groupId - 群ID
   * @returns {Promise<void>}
   */
  async cancelCurrentAssistantMessage(groupId) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      let totalChars = 0;
      let cancelledCount = 0;

      for (const [pairId, ctx] of history.activePairs.entries()) {
        if (!ctx || ctx.status !== 'building') {
          continue;
        }

        const len = typeof ctx.assistant === 'string' ? ctx.assistant.length : 0;
        totalChars += len;
        cancelledCount++;

        ctx.assistant = '';
        ctx.userContent = null;
        ctx.messages = [];
        ctx.status = 'cancelled';
        history.activePairs.delete(pairId);
      }

      logger.debug(`取消消息: ${groupId} 取消${cancelledCount}个活动对话对, 共放弃${totalChars}字符`);

      await saveHistoryToRedis(groupId, history);
    });
  }

  /**
   * 完成当前对话对，保存到历史（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} userContent - 用户消息内容（完整的 XML 格式，可选）
   * @returns {Promise<boolean>} 是否保存成功
   */
  async finishConversationPair(groupId, pairId, userContent = null) {
    return this._executeForGroup(groupId, async () => {
      const history = await this._getOrInitHistory(groupId);
      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      if (!history.scopedConversationsBySender || !(history.scopedConversationsBySender instanceof Map)) {
        history.scopedConversationsBySender = new Map();
      }

      if (!pairId) {
        logger.warn(`保存跳过: ${groupId} 未传入pairId (调用方状态异常)`);
        return false;
      }

      const ctx = history.activePairs.get(pairId);
      const shortId = String(pairId).substring(0, 8);

      if (!ctx) {
        logger.debug(`保存跳过: ${groupId} pairId ${shortId} 不在活动列表中 (可能已被取消/完成或重启后丢失)`);
        return false;
      }

      if (ctx.status === 'cancelled') {
        logger.debug(`保存跳过: ${groupId} pairId ${shortId} 已取消`);
        return false;
      }

      if (ctx.status === 'finished') {
        logger.debug(`保存跳过: ${groupId} pairId ${shortId} 已完成`);
        return false;
      }

      // 如果没有传入 userContent，使用旧的逻辑（简单拼接，已废弃）
      if (!userContent && (!ctx.messages || !Array.isArray(ctx.messages) || ctx.messages.length === 0)) {
        logger.warn(`保存检查: ${groupId} 未传入userContent，使用旧逻辑`);
        userContent = history.processingMessages.map(pm => pm.summary).join('\n\n');
      }

      const assistantMsg = ctx.assistant;

      const buffered = Array.isArray(ctx.messages) ? ctx.messages : [];
      const willUseBuffered = buffered.length > 0;

      if (!willUseBuffered && (!userContent || userContent.trim().length === 0)) {
        logger.warn(`保存跳过: ${groupId} pairId ${shortId} userContent为空`);
        ctx.status = 'cancelled';
        ctx.assistant = '';
        ctx.userContent = null;
        ctx.messages = [];
        history.activePairs.delete(pairId);
        return false;
      }

      if (!assistantMsg || assistantMsg.trim().length === 0) {
        logger.warn(`保存跳过: ${groupId} pairId ${shortId} assistantMsg为空`);
        ctx.status = 'cancelled';
        ctx.assistant = '';
        ctx.userContent = null;
        ctx.messages = [];
        history.activePairs.delete(pairId);
        return false;
      }

      // 所有检查通过，按对话开始时间保存对话对，保证顺序
      const nowTs = typeof ctx.createdAt === 'number' && ctx.createdAt > 0
        ? ctx.createdAt
        : Date.now();

      const toSave = [];
      if (willUseBuffered) {
        for (const m of buffered) {
          if (!m || typeof m !== 'object') continue;
          const r = m.role === 'assistant' ? 'assistant' : 'user';
          const c = typeof m.content === 'string' ? m.content : String(m.content ?? '');
          if (!c.trim()) continue;
          toSave.push({ role: r, content: c, pairId, timestamp: nowTs });
        }
      } else {
        toSave.push({ role: 'user', content: userContent, pairId, timestamp: nowTs });
      }
      toSave.push({ role: 'assistant', content: assistantMsg, pairId, timestamp: nowTs });

      const commitMode = ctx && typeof ctx.commitMode === 'string' ? ctx.commitMode : 'shared';
      const scopeSenderId = ctx && typeof ctx.scopeSenderId === 'string' ? ctx.scopeSenderId : '';
      const shouldCommitScoped = commitMode === 'scoped' && scopeSenderId;

      if (shouldCommitScoped) {
        const arr = history.scopedConversationsBySender.get(scopeSenderId) || [];
        history.scopedConversationsBySender.set(scopeSenderId, [...arr, ...toSave]);
      } else {
        history.conversations.push(...toSave);
      }

      if (!shouldCommitScoped) {
        const seenPairIds = new Set();
        for (const m of history.conversations) {
          if (!m || !m.pairId) continue;
          seenPairIds.add(String(m.pairId));
        }
        const pairCount = seenPairIds.size;
        const processingCount = history.processingMessages.length;
        const pendingCount = history.pendingMessages.length;

        logger.info(
          `保存成功: ${groupId} pairId ${shortId} 包含${processingCount}条processing, 当前历史${pairCount}组 (上下文限制=${this.maxConversationPairs}), ${pendingCount}条pending`
        );

        history.processingMessages = [];
      }
      ctx.status = 'finished';
      ctx.userContent = typeof userContent === 'string' ? userContent : ctx.userContent;
      ctx.messages = [];
      history.activePairs.delete(pairId);

      if (!shouldCommitScoped) {
        try {
          const limit = this.maxConversationPairs;
          if (Number.isFinite(limit) && limit > 0) {
            const orderedPairIds = [];
            const seen = new Set();
            for (const m of history.conversations) {
              const pid = m && m.pairId != null ? String(m.pairId) : '';
              if (!pid) continue;
              if (seen.has(pid)) continue;
              seen.add(pid);
              orderedPairIds.push(pid);
            }
            if (orderedPairIds.length > limit) {
              const drop = new Set(orderedPairIds.slice(0, orderedPairIds.length - limit));
              history.conversations = history.conversations.filter((m) => {
                const pid = m && m.pairId != null ? String(m.pairId) : '';
                return pid && !drop.has(pid);
              });
            }
          }
        } catch {}
      }
      
      await saveHistoryToRedis(groupId, history);

      return true;
    });
  }

  /**
   * 撤销指定的对话对（线程安全，通过pairId精确删除）
   * @param {string} groupId - 群ID
   * @param {string} pairId - 要删除的对话对UUID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async cancelConversationPairById(groupId, pairId) {
    return this._executeForGroup(groupId, async () => {
      let history = this.histories.get(groupId);
      if (!history) {
        history = await this._getOrInitHistory(groupId);
      }
      if (!history) {
        return false;
      }

      if (!history.scopedConversationsBySender || !(history.scopedConversationsBySender instanceof Map)) {
        history.scopedConversationsBySender = new Map();
      }

      if (!history.activePairs || !(history.activePairs instanceof Map)) {
        history.activePairs = new Map();
      }

      const shortId = String(pairId || '').substring(0, 8);
      let touched = false;

      const ctx = history.activePairs.get(pairId);
      if (ctx) {
        ctx.status = 'cancelled';
        ctx.assistant = '';
        ctx.userContent = null;
        ctx.messages = [];
        history.activePairs.delete(pairId);
        logger.debug(`撤销: ${groupId} 清空活动对话对 pairId ${shortId}`);
        touched = true;
      }

      // 找到并删除所有带有此pairId的历史消息
      const initialLength = history.conversations.length;
      history.conversations = history.conversations.filter(msg => msg.pairId !== pairId);
      const deletedCount = initialLength - history.conversations.length;

      if (deletedCount > 0) {
        logger.debug(`撤销对话对: ${groupId} pairId ${shortId} 删除${deletedCount}条`);
        touched = true;
      }

      if (history.scopedConversationsBySender && history.scopedConversationsBySender instanceof Map) {
        let scopedDeleted = 0;
        for (const [sid, arr] of history.scopedConversationsBySender.entries()) {
          if (!Array.isArray(arr) || arr.length === 0) continue;
          const before = arr.length;
          const next = arr.filter((m) => m && m.pairId !== pairId);
          const diff = before - next.length;
          if (diff > 0) {
            scopedDeleted += diff;
            if (next.length > 0) {
              history.scopedConversationsBySender.set(sid, next);
            } else {
              history.scopedConversationsBySender.delete(sid);
            }
          }
        }
        if (scopedDeleted > 0) {
          logger.debug(`撤销对话对(scoped): ${groupId} pairId ${shortId} 删除${scopedDeleted}条`);
          touched = true;
        }
      }

      if (touched) {
        await saveHistoryToRedis(groupId, history);
        return true;
      }

      logger.warn(`撤销失败: ${groupId} 未找到pairId ${shortId}`);
      return false;
    });
  }

  /**
   * 获取完整的对话历史数组（用于API请求）（只读操作）
   * @param {string} groupId - 群ID
   * @returns {Array} 对话历史数组 [{ role, content }, ...]（不包含pairId）
   */
  getConversationHistory(groupId) {
    const history = this.histories.get(groupId);
    if (!history) {
      return [];
    }

    // 返回副本，去除pairId字段（API不需要）
    return history.conversations.map(({ role, content }) => ({ role, content }));
  }

  /**
   * 为上下文构建对话历史，支持按时间窗口筛选
   * - 提供 timeStart 时：只返回该时间段内命中的对话对（真实数量），按时间升序
   * - 未提供 timeStart 时：返回最近若干对话对（默认 maxConversationPairs）
   * @param {string} groupId - 群ID
   * @param {Object} options
   * @param {number} [options.timeStart] - 起始时间戳（毫秒）
   * @param {number} [options.timeEnd] - 结束时间戳（毫秒，<=0 表示不限上界）
   * @param {number} [options.recentPairs] - 最近保留的对话对数量（默认 maxConversationPairs）
   * @returns {Array} 对话历史数组 [{ role, content }, ...]
   */
  getConversationHistoryForContext(groupId, options = {}) {
    const history = this.histories.get(groupId);
    if (!history) {
      return [];
    }

    const { timeStart, timeEnd = 0, recentPairs, maxTokens, senderId } = options;

    const shared = Array.isArray(history.conversations) ? history.conversations : [];
    const sid = senderId != null ? String(senderId) : '';
    const scopedArr =
      sid && history.scopedConversationsBySender && history.scopedConversationsBySender instanceof Map
        ? (history.scopedConversationsBySender.get(sid) || [])
        : [];

    const raw = shared.length > 0 || (Array.isArray(scopedArr) && scopedArr.length > 0)
      ? [...shared, ...(Array.isArray(scopedArr) ? scopedArr : [])]
      : [];

    if (raw.length === 0) {
      return [];
    }

    // 将扁平数组按 pairId 聚合为对话对
    const pairMap = new Map();

    for (let idx = 0; idx < raw.length; idx++) {
      const msg = raw[idx];
      const pid = msg.pairId || `__noid_${idx}`;
      let pair = pairMap.get(pid);
      if (!pair) {
        pair = {
          pairId: pid,
          messages: [],
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
          order: idx
        };
        pairMap.set(pid, pair);
      }

      pair.messages.push(msg);

      if (!pair.timestamp && typeof msg.timestamp === 'number') {
        pair.timestamp = msg.timestamp;
      }
    }

    let pairs = Array.from(pairMap.values());

    const totalPairs = pairs.length;
    let minTs = null;
    let maxTs = null;
    if (totalPairs > 0) {
      for (const p of pairs) {
        const ts = typeof p.timestamp === 'number' ? p.timestamp : 0;
        if (!ts) continue;
        if (minTs === null || ts < minTs) minTs = ts;
        if (maxTs === null || ts > maxTs) maxTs = ts;
      }
    }

    const sortPairs = (arr) => arr.sort((a, b) => {
      const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
      const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
      if (ta !== tb) return ta - tb;
      return a.order - b.order;
    });

    // 1) 如果提供时间窗口：优先选取窗口内对话对，再按需要补充最近对话
    let targetPairs = [];
    if (typeof timeStart === 'number' && !Number.isNaN(timeStart)) {
      const windowPairs = pairs.filter(p => {
        const ts = typeof p.timestamp === 'number' ? p.timestamp : 0;
        if (!ts) return false;
        if (ts < timeStart) return false;
        if (typeof timeEnd === 'number' && timeEnd > 0 && ts >= timeEnd) return false;
        return true;
      });
      sortPairs(windowPairs);

      const startStr = new Date(timeStart).toISOString();
      const endStr = (typeof timeEnd === 'number' && timeEnd > 0)
        ? new Date(timeEnd).toISOString()
        : '∞';

      if (windowPairs.length > 0) {
        const hitMinTs = typeof windowPairs[0].timestamp === 'number' ? windowPairs[0].timestamp : 0;
        const hitMaxTs = typeof windowPairs[windowPairs.length - 1].timestamp === 'number'
          ? windowPairs[windowPairs.length - 1].timestamp
          : 0;
        const hitMinStr = hitMinTs ? new Date(hitMinTs).toISOString() : 'none';
        const hitMaxStr = hitMaxTs ? new Date(hitMaxTs).toISOString() : 'none';
        logger.info(`时间窗口命中对话对: ${groupId} window [${startStr} - ${endStr}], 命中${windowPairs.length}组, 总数${totalPairs}, 命中区间[${hitMinStr} - ${hitMaxStr}]`);
      } else {
        const globalMinStr = minTs ? new Date(minTs).toISOString() : 'none';
        const globalMaxStr = maxTs ? new Date(maxTs).toISOString() : 'none';
        logger.info(`时间窗口内未命中对话对: ${groupId} window [${startStr} - ${endStr}], 现有对话对=${totalPairs}, 全局区间[${globalMinStr} - ${globalMaxStr}]`);
      }

      // 在窗口命中的基础上，按时间顺序补充最近的对话对，直到达到 recentPairs/maxConversationPairs 上限
      let recentLimit = typeof recentPairs === 'number' && recentPairs > 0
        ? recentPairs
        : this.maxConversationPairs;
      if (!recentLimit || recentLimit <= 0) {
        recentLimit = pairs.length;
      }

      const resultPairs = [...windowPairs];

      if (resultPairs.length < recentLimit) {
        const needed = recentLimit - resultPairs.length;
        const windowSet = new Set(windowPairs.map(p => p.pairId));
        const nonWindowPairs = pairs.filter(p => !windowSet.has(p.pairId));
        sortPairs(nonWindowPairs);

        if (nonWindowPairs.length > 0 && needed > 0) {
          const extra = nonWindowPairs.slice(Math.max(0, nonWindowPairs.length - needed));
          resultPairs.push(...extra);
          sortPairs(resultPairs);
        }
      }

      targetPairs = resultPairs;
    } else {
      // 2) 未提供时间窗口：按原逻辑返回最近若干对话对
      let recentLimit = typeof recentPairs === 'number' && recentPairs > 0
        ? recentPairs
        : this.maxConversationPairs;
      if (!recentLimit || recentLimit <= 0) {
        recentLimit = pairs.length;
      }

      sortPairs(pairs);
      if (pairs.length > recentLimit) {
        targetPairs = pairs.slice(pairs.length - recentLimit);
      } else {
        targetPairs = pairs;
      }
    }

    // 展平为 [{ role, content }, ...]
    const conversationsForContext = [];
    for (const p of targetPairs) {
      const msgs = Array.isArray(p.messages) ? p.messages : [];
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        conversationsForContext.push({ role: m.role, content: m.content });
      }
    }

    try {
      const tokenLimit = Number(maxTokens);
      if (Number.isFinite(tokenLimit) && tokenLimit > 0 && targetPairs.length > 0) {
        const counter = getTokenCounterSingleton();
        const pairTokenCache = new Map();

        const countPairTokens = (pair) => {
          const pid = pair && pair.pairId != null ? String(pair.pairId) : '';
          if (pid && pairTokenCache.has(pid)) return pairTokenCache.get(pid);

          const msgs = Array.isArray(pair?.messages) ? pair.messages : [];
          const text = msgs
            .map((m, idx) => {
              if (!m || typeof m !== 'object') return '';
              const role = m.role || (idx % 2 === 0 ? 'user' : 'assistant');
              const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
              if (!content.trim()) return '';
              return `[${role}] ${content}`;
            })
            .filter(Boolean)
            .join('\n\n');

          const tokens = text ? counter.countTokens(text) : 0;
          if (pid) pairTokenCache.set(pid, tokens);
          return tokens;
        };

        let totalTokens = 0;
        for (const p of targetPairs) {
          totalTokens += countPairTokens(p);
        }

        if (totalTokens > tokenLimit) {
          const beforePairs = targetPairs.length;
          const beforeTokens = totalTokens;

          while (targetPairs.length > 0 && totalTokens > tokenLimit) {
            const removed = targetPairs.shift();
            totalTokens -= countPairTokens(removed);
          }

          if (targetPairs.length !== beforePairs) {
            logger.info(
              `上下文裁剪: ${groupId} tokenLimit=${tokenLimit}, ${beforePairs}组/${beforeTokens}tokens -> ${targetPairs.length}组/${totalTokens}tokens`
            );

            conversationsForContext.length = 0;
            for (const p of targetPairs) {
              const msgs = Array.isArray(p.messages) ? p.messages : [];
              for (const m of msgs) {
                if (!m || typeof m !== 'object') continue;
                conversationsForContext.push({ role: m.role, content: m.content });
              }
            }
          }
        }
      }
    } catch {}

    return conversationsForContext;
  }

  getLastAssistantMessageContent(groupId) {
    const history = this.histories.get(groupId);
    if (
      !history ||
      !Array.isArray(history.conversations) ||
      history.conversations.length === 0
    ) {
      return null;
    }

    for (let i = history.conversations.length - 1; i >= 0; i--) {
      const msg = history.conversations[i];
      if (msg && msg.role === 'assistant' && typeof msg.content === 'string') {
        const trimmed = msg.content.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    return null;
  }

  /**
   * 获取待回复消息数量
   * @param {string} groupId - 群ID
   * @returns {number} 待回复消息数量
   */
  getPendingMessageCount(groupId) {
    const history = this.histories.get(groupId);
    return history ? history.pendingMessages.length : 0;
  }

  /**
   * 获取历史对话对数量
   * @param {string} groupId - 群ID
   * @returns {number} 历史对话对数量
   */
  getConversationPairCount(groupId) {
    const history = this.histories.get(groupId);
    if (!history || !Array.isArray(history.conversations) || history.conversations.length === 0) {
      return 0;
    }
    const seen = new Set();
    for (const m of history.conversations) {
      const pid = m && m.pairId != null ? String(m.pairId) : '';
      if (!pid) continue;
      seen.add(pid);
    }
    return seen.size;
  }

  /**
   * 获取对话对的片段
   * @param {string} groupId - 群ID
   * @param {number} start - 开始索引（基于按时间排序后的对话对）
   * @param {number} end - 结束索引（不包含，类似 Array.slice）
   * @returns {{ conversations: Array<{role: string, content: string}>, timeStart: number|null, timeEnd: number|null }}
   */
  getConversationPairSlice(groupId, start, end) {
    const history = this.histories.get(groupId);
    if (!history || !Array.isArray(history.conversations) || history.conversations.length === 0) {
      return { conversations: [], timeStart: null, timeEnd: null };
    }

    // 将扁平数组按 pairId 聚合为对话对
    const pairMap = new Map();
    const raw = history.conversations;

    for (let idx = 0; idx < raw.length; idx++) {
      const msg = raw[idx];
      const pid = msg.pairId || `__noid_${idx}`;
      let pair = pairMap.get(pid);
      if (!pair) {
        pair = {
          pairId: pid,
          messages: [],
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
          order: idx
        };
        pairMap.set(pid, pair);
      }

      pair.messages.push(msg);

      if (!pair.timestamp && typeof msg.timestamp === 'number') {
        pair.timestamp = msg.timestamp;
      }
    }

    let pairs = Array.from(pairMap.values());
    const sortPairs = (arr) => arr.sort((a, b) => {
      const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
      const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
      if (ta !== tb) return ta - tb;
      return a.order - b.order;
    });
    sortPairs(pairs);

    const totalPairs = pairs.length;
    const s = Math.max(0, Number.isFinite(start) ? start : 0);
    const e = Number.isFinite(end) && end > 0 ? Math.min(end, totalPairs) : totalPairs;
    if (s >= e) {
      return { conversations: [], timeStart: null, timeEnd: null };
    }

    const slicedPairs = pairs.slice(s, e);

    let timeStart = null;
    let timeEnd = null;
    for (const p of slicedPairs) {
      const ts = typeof p.timestamp === 'number' ? p.timestamp : 0;
      if (!ts) continue;
      if (timeStart === null || ts < timeStart) timeStart = ts;
      if (timeEnd === null || ts > timeEnd) timeEnd = ts;
    }

    const conversationsForContext = [];
    for (const p of slicedPairs) {
      const msgs = Array.isArray(p.messages) ? p.messages : [];
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        conversationsForContext.push({ role: m.role, content: m.content });
      }
    }

    return { conversations: conversationsForContext, timeStart, timeEnd };
  }

  /**
   * 清空指定群的所有数据（线程安全）
   * @param {string} groupId - 群ID
   * @returns {Promise<void>}
   */
  async clearGroup(groupId) {
    return this._executeForGroup(groupId, async () => {
      this.histories.delete(groupId);
      logger.info(`清空群历史: ${groupId}`);

      await deleteHistoryFromRedis(groupId);
    });
  }

  /**
   * 获取所有群ID列表
   * @returns {Array<string>} 群ID列表
   */
  getAllGroupIds() {
    return Array.from(this.histories.keys());
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    const stats = {
      totalGroups: this.histories.size,
      groups: {}
    };

    for (const [groupId, history] of this.histories) {
      let isReplying = false;
      if (history.activePairs && history.activePairs instanceof Map) {
        for (const ctx of history.activePairs.values()) {
          if (ctx && ctx.status === 'building') {
            isReplying = true;
            break;
          }
        }
      }

      stats.groups[groupId] = {
        conversationPairs: (() => {
          const seen = new Set();
          const arr = Array.isArray(history.conversations) ? history.conversations : [];
          for (const m of arr) {
            const pid = m && m.pairId != null ? String(m.pairId) : '';
            if (!pid) continue;
            seen.add(pid);
          }
          return seen.size;
        })(),
        pendingMessages: history.pendingMessages.length,
        isReplying
      };
    }

    return stats;
  }
}

// 导出
export default GroupHistoryManager;
export { GroupHistoryManager, GroupTaskQueue };
