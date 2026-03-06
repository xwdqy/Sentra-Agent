import { getEnvBool, getEnvInt, getEnv } from '../utils/envHotReloader.js';
import { shouldAnalyzeEmotion } from '../utils/emotionGate.js';

type ClientEvent = 'open' | 'message' | 'error' | 'close' | 'reconnect_exhausted' | 'warn';
type ClientEventHandler = (payload?: unknown) => void;
type SocketLike = {
  on: (event: ClientEvent, handler: ClientEventHandler) => void;
};

type LoggerLike = {
  success: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

type IncomingMessage = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  sender_name?: string;
  message_id?: string | number | null;
  self_id?: string | number;
  target_id?: string | number;
  target_name?: string;
  summary?: string;
  text?: string;
  objective?: string;
  event_type?: string;
  at_users?: Array<string | number>;
  time_str?: string;
  _forceReply?: boolean;
  _forcePendingHold?: boolean;
  _forceNoReply?: boolean;
  _overrideDecision?: string;
  [key: string]: unknown;
};

type PendingMessage = {
  text?: string;
  summary?: string;
  time_str?: string;
  sender_id?: string | number | null;
  sender_name?: string;
  [key: string]: unknown;
};

type DecisionContextMessage = { text?: string; time?: string; sender_id?: string; sender_name?: string };
type DecisionContext = {
  group_recent_messages?: DecisionContextMessage[];
  sender_recent_messages?: DecisionContextMessage[];
  bot_recent_messages?: DecisionContextMessage[];
};

type OverrideDecision = {
  decision?: 'reply' | 'pending' | 'cancel_only' | 'cancel_and_restart' | string;
  confidence?: number;
  reason?: string;
};

type ShouldReplyDecision = { needReply: boolean; taskId?: string | null };

type OverrideIntentPayload = {
  scene: string;
  senderId: string;
  groupId: string | null;
  taskGroupId: string;
  prevMessages: Array<{ text: string; time: string }>;
  newMessage: { text: string; time: string };
  signals: { mentioned_by_at: boolean; mentioned_by_name: boolean };
};

type HistoryManagerLike = {
  addPendingMessage: (groupId: string, summary: string, msg: IncomingMessage) => Promise<void>;
  getPendingMessagesBySender: (groupId: string, senderId: string) => PendingMessage[];
  getRecentMessagesForDecision: (groupId: string, senderId: string) => DecisionContext;
};

type PersonaManagerLike = {
  recordMessage: (userId: string, payload: { text: string; timestamp: string; senderName: string; groupId: string | null }) => Promise<void>;
};

type EmoAnalyzerLike = {
  analyze: (text: string | { text: string }, opts?: Record<string, unknown>) => Promise<unknown>;
};

type SocketHandlerContext = {
  socket: SocketLike;
  logger: LoggerLike;
  emo?: EmoAnalyzerLike;
  historyManager: HistoryManagerLike;
  personaManager?: PersonaManagerLike;
  getActiveTaskCount: (conversationId: string) => number;
  handleIncomingMessage: (conversationId: string, msg: IncomingMessage, options: { activeCount: number }) => Promise<{ action: string }>;
  decideOverrideIntent?: (payload: OverrideIntentPayload) => Promise<OverrideDecision | null>;
  markTasksCancelledForSender: (conversationId: string) => void | Promise<void>;
  cancelRunsForSender: (senderId: string, groupId: string | null, options: { mode: string }) => void | Promise<void>;
  triggerTaskCompletionAnalysis?: (payload: Record<string, unknown>) => Promise<unknown>;
  agent?: unknown;
  sdk?: unknown;
  collectBundleForSender: (conversationId: string) => Promise<IncomingMessage | null>;
  drainPendingMessagesForSender?: (conversationId: string) => IncomingMessage | null;
  requeuePendingMessageForSender?: (conversationId: string, msg: IncomingMessage) => void | Promise<void>;
  shouldReply: (msg: IncomingMessage, options: { decisionContext?: DecisionContext; forceReply?: boolean; source?: string }) => Promise<ShouldReplyDecision>;
  handleOneMessage: (msg: IncomingMessage, taskId?: string | null) => Promise<void>;
  handleGroupReplyCandidate?: (
    payload: { groupId?: string | number; senderId: string; bundledMsg: IncomingMessage; taskId?: string | null },
    helpers: { handleOneMessage: (msg: IncomingMessage, taskId?: string | null) => Promise<void>; completeTask: (conversationId: string, taskId: string) => Promise<unknown> }
  ) => Promise<void>;
  completeTask: (conversationId: string, taskId: string) => Promise<unknown>;
};

function takeLast<T>(list: T[], count: number): T[] {
  if (!Array.isArray(list) || count <= 0) return [];
  const start = Math.max(0, list.length - count);
  const out: T[] = [];
  for (let i = start; i < list.length; i++) {
    const item = list[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function setupSocketHandlers(ctx: SocketHandlerContext) {
  const {
    socket,
    logger,
    emo,
    historyManager,
    personaManager,
    getActiveTaskCount,
    handleIncomingMessage,
    decideOverrideIntent,
    markTasksCancelledForSender,
    cancelRunsForSender,
    triggerTaskCompletionAnalysis,
    agent,
    sdk,
    collectBundleForSender,
    drainPendingMessagesForSender,
    requeuePendingMessageForSender,
    shouldReply,
    handleOneMessage,
    handleGroupReplyCandidate,
    completeTask
  } = ctx;

  const incomingDedupTtlMsRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_TTL_MS', 60000) ?? 60000;
  const incomingDedupTtlMs =
    Number.isFinite(incomingDedupTtlMsRaw) && incomingDedupTtlMsRaw > 0 ? incomingDedupTtlMsRaw : 60000;
  const incomingDedupMaxRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_MAX', 5000) ?? 5000;
  const incomingDedupMax =
    Number.isFinite(incomingDedupMaxRaw) && incomingDedupMaxRaw > 0 ? incomingDedupMaxRaw : 5000;
  const recentIncomingByConv = new Map<string, Map<string, number>>();
  const botNames = String(getEnv('BOT_NAMES', '') ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  const shouldDropDuplicateIncoming = (conversationKey: unknown, messageId: unknown): boolean => {
    const convKey = String(conversationKey || '');
    const mid = messageId != null ? String(messageId) : '';
    if (!convKey || !mid) return false;

    const now = Date.now();
    let bucket = recentIncomingByConv.get(convKey);
    if (!bucket) {
      bucket = new Map();
      recentIncomingByConv.set(convKey, bucket);
    }

    const prev = bucket.get(mid);
    if (typeof prev === 'number' && now - prev <= incomingDedupTtlMs) {
      return true;
    }

    bucket.set(mid, now);

    if (bucket.size > incomingDedupMax) {
      const cutoff = now - incomingDedupTtlMs;
      for (const [k, ts] of bucket.entries()) {
        if (typeof ts !== 'number' || ts < cutoff) {
          bucket.delete(k);
        }
        if (bucket.size <= incomingDedupMax) break;
      }
      if (bucket.size > incomingDedupMax) {
        const extra = bucket.size - incomingDedupMax;
        let removed = 0;
        for (const k of bucket.keys()) {
          bucket.delete(k);
          removed += 1;
          if (removed >= extra) break;
        }
      }
    }

    return false;
  };

  socket.on('message', async (data) => {
    try {
      const text = (data && typeof (data as { toString?: () => string }).toString === 'function')
        ? (data as { toString: () => string }).toString()
        : '';
      if (!text) return;
      const payload = JSON.parse(text) as {
        type?: string;
        message?: string;
        requestId?: string | number;
        ok?: boolean;
        data?: IncomingMessage;
      };

      if (payload.type === 'welcome') {
        logger.success(`连接成功: ${payload.message}`);
        return;
      }

      if (payload.type === 'pong') {
        return;
      }

      if (payload.type === 'shutdown') {
        logger.warn(`服务器关闭: ${payload.message}`);
        return;
      }

      if (payload.type === 'result') {
        logger.debug(`<< result ${payload.requestId} ${payload.ok ? 'OK' : 'ERR'}`);
        return;
      }

      if (payload.type === 'message') {
        const msg = (payload.data || {}) as IncomingMessage;
        const isPoke = msg && msg.event_type === 'poke';

        if (isPoke) {
          const scene = msg.type || 'unknown';
          let convId = msg.group_id ? `G:${msg.group_id}` : `U:${msg.sender_id || ''}`;
          if (!msg.group_id) {
            const selfId = msg.self_id;
            if (selfId && msg.sender_id === selfId) {
              convId = `U:${msg.target_id || ''}`;
            }
          }
          logger.info('<< poke', {
            scene,
            group_id: msg.group_id || null,
            sender_id: msg.sender_id || null,
            sender_name: msg.sender_name || '',
            target_id: msg.target_id || null,
            target_name: msg.target_name || '',
            summary: msg.summary || msg.text || '',
            conv_id: convId,
          });
        } else {
          logger.debug('<< message', msg.type, msg.group_id || msg.sender_id);
        }
        let userid = String(msg?.sender_id ?? '');
        if (isPoke && !msg.group_id) {
          const selfId = msg.self_id;
          if (selfId && msg.sender_id === selfId) {
            userid = String(msg?.target_id ?? '');
          }
        }

        const conversationKey = msg?.group_id ? `G:${msg.group_id}` : `U:${userid}`;
        if (shouldDropDuplicateIncoming(conversationKey, msg?.message_id)) {
          logger.info('重复消息去重: 已丢弃重复投递的 incoming message', {
            conversationKey,
            sender_id: userid,
            group_id: msg?.group_id || null,
            message_id: msg?.message_id != null ? String(msg.message_id) : null
          });
          return;
        }

        const username = (isPoke && !msg.group_id && msg.self_id && msg.sender_id === msg.self_id)
          ? (msg?.target_name || '')
          : (msg?.sender_name || '');

        const emoText =
          (typeof msg?.text === 'string' && msg.text.trim())
            ? msg.text
            : ((typeof msg?.objective === 'string' && msg.objective.trim())
                ? msg.objective
                : (msg?.summary || ''));
        const emoEnabled = getEnvBool('SENTRA_EMO_ENABLED', false);
        if (emoEnabled && userid && emoText && emo && shouldAnalyzeEmotion(emoText, userid)) {
          emo.analyze(emoText, { userid, username }).catch(() => {});
        }
        const groupId = conversationKey;
        const summary =
          (typeof msg?.objective === 'string' && msg.objective.trim())
            ? msg.objective
            : (msg?.summary || msg?.text || '');
        await historyManager.addPendingMessage(groupId, summary, msg);

        if (personaManager && userid && summary) {
          await personaManager.recordMessage(userid, {
            text: summary,
            timestamp: new Date().toISOString(),
            senderName: username,
            groupId: msg?.group_id != null ? String(msg.group_id) : null
          });
        }

        const taskConversationId = msg?.group_id
          ? `group_${msg.group_id}_sender_${userid}`
          : `private_${userid}`;

        // 检查是否有活跃任务（针对该会话），交给聚合模块决定如何处理
        const activeCount = getActiveTaskCount(taskConversationId);

        const incomingDecision = await handleIncomingMessage(taskConversationId, msg, { activeCount });
                if (incomingDecision.action === 'pending_collect') {
          // ??????:????????,???? override ??
          if (activeCount > 0 && typeof decideOverrideIntent === 'function') {
            try {
              const bundledMsg = await collectBundleForSender(taskConversationId);
              if (!bundledMsg) {
                logger.debug('override pending_collect: ??????,????');
                return;
              }

              const senderMessagesAll = historyManager.getPendingMessagesBySender(groupId, userid);
              const maxHistory = 5;
              const prevSlice = Array.isArray(senderMessagesAll)
                ? takeLast(senderMessagesAll, maxHistory)
                : [];

              const prevMessagesPayload = prevSlice
                .map((m) => ({
                  text: m.text || m.summary || '',
                  time: m.time_str || ''
                }))
                .filter((m) => m.text);

              const newMessagePayload = {
                text: bundledMsg.text || bundledMsg.summary || '',
                time: bundledMsg.time_str || ''
              };

              if (newMessagePayload.text && prevMessagesPayload.length > 0) {
                const textLower = (newMessagePayload.text || '').toLowerCase();
                const summaryLower = (bundledMsg.summary || '').toLowerCase();
                const mentionedByName = botNames.length > 0
                  ? botNames.some((n) => {
                      const ln = n.toLowerCase();
                      return (textLower && textLower.includes(ln)) || (summaryLower && summaryLower.includes(ln));
                    })
                  : false;
                const atUsers = bundledMsg.at_users || msg.at_users || [];
                const mentionedByAt = Array.isArray(atUsers) && atUsers.some(
                  (at) => String(at) === String(msg.self_id || '')
                );

                const overrideDecision = await decideOverrideIntent({
                  scene: bundledMsg.type || msg.type || 'unknown',
                  senderId: userid,
                  groupId: msg.group_id != null ? String(msg.group_id) : null,
                  taskGroupId: taskConversationId.startsWith('group_')
                    ? `G:${msg.group_id || ''}`
                    : `U:${userid}`,
                  prevMessages: prevMessagesPayload,
                  newMessage: newMessagePayload,
                  signals: {
                    mentioned_by_at: mentionedByAt,
                    mentioned_by_name: mentionedByName
                  }
                });

                if (overrideDecision && overrideDecision.decision) {
                  const decision = overrideDecision.decision;
                  if (decision === 'cancel_and_restart' || decision === 'cancel_only') {
                    markTasksCancelledForSender(taskConversationId);
                    cancelRunsForSender(userid, groupId, { mode: 'conversation' });
                  }

                  if (decision === 'reply') {
                    bundledMsg._forceReply = true;
                    bundledMsg._overrideDecision = 'reply';
                    if (typeof requeuePendingMessageForSender === 'function') {
                      requeuePendingMessageForSender(taskConversationId, bundledMsg);
                    }
                  } else if (decision === 'pending') {
                    bundledMsg._forcePendingHold = true;
                    bundledMsg._overrideDecision = 'pending';
                    if (typeof requeuePendingMessageForSender === 'function') {
                      requeuePendingMessageForSender(taskConversationId, bundledMsg);
                    }
                  } else if (decision === 'cancel_only') {
                    bundledMsg._forceNoReply = true;
                    bundledMsg._overrideDecision = 'cancel_only';
                    if (typeof triggerTaskCompletionAnalysis === 'function') {
                      const analysisAgent = agent || sdk;
                      const userObjective =
                        (newMessagePayload && newMessagePayload.text) ||
                        bundledMsg.summary ||
                        summary ||
                        '';
                      triggerTaskCompletionAnalysis({
                        agent: analysisAgent,
                        groupId,
                        conversationId: taskConversationId,
                        userId: userid,
                        userObjective,
                        toolInvocations: [],
                        toolResultEvents: [],
                        finalResponse: '',
                        hasToolCalled: false,
                        forceSaveOutput: true
                      }).catch((e: unknown) => {
                        logger.debug('cancel_only: task completion analysis failed', { err: String(e) });
                      });
                    }
                  } else if (decision === 'cancel_and_restart') {
                    bundledMsg._forceReply = true;
                    bundledMsg._overrideDecision = 'cancel_and_restart';
                    const replyDecision = await shouldReply(
                      bundledMsg,
                      { forceReply: true, source: 'override_restart' }
                    );
                    if (replyDecision.needReply) {
                      const safeTaskId = replyDecision.taskId ?? null;
                      if (bundledMsg.type === 'group' && typeof handleGroupReplyCandidate === 'function') {
                        const groupPayload: { groupId?: string | number; senderId: string; bundledMsg: IncomingMessage; taskId?: string | null } = {
                          senderId: userid,
                          bundledMsg,
                          taskId: safeTaskId
                        };
                        if (msg.group_id !== undefined && msg.group_id !== null) {
                          groupPayload.groupId = msg.group_id;
                        }
                        await handleGroupReplyCandidate(
                          groupPayload,
                          {
                            handleOneMessage,
                            completeTask
                          }
                        );
                      } else {
                        await handleOneMessage(bundledMsg, replyDecision.taskId);
                      }
                    }
                  }

                  const conf = (overrideDecision.confidence != null && Number.isFinite(overrideDecision.confidence))
                    ? (overrideDecision.confidence * 100).toFixed(1)
                    : 'n/a';
                  logger.info(
                    `Override decision: sender=${userid} decision=${decision}, confidence=${conf}%, reason=${overrideDecision.reason}`
                  );
                }
              }
            } catch (e) {
              logger.debug(`Override decision failed: ${groupId} sender ${userid}`, { err: String(e) });
            }
          }
          return;
        }

        if (incomingDecision.action === 'pending_queued') {
          return;
        }

        if (incomingDecision.action === 'buffered' || incomingDecision.action === 'ignore') {
          // 仍在聚合窗口或无需触发回复
          return;
        }

        // start_bundle: 作为一轮新会话的起点，先等待聚合窗口结束拿到合并后的消息，再做智能回复决策
        const bundledMsg = await collectBundleForSender(taskConversationId);
        if (!bundledMsg) {
          logger.debug('聚合结果为空，跳过本次消息');
          return;
        }
        let decisionContext = null;
        if (bundledMsg.type === 'group') {
          try {
            decisionContext = historyManager.getRecentMessagesForDecision(groupId, userid);
          } catch (e) {
            logger.debug(`构建轻量决策上下文失败: ${groupId} sender ${userid}`, {
              err: String(e)
            });
          }
        }

        const replyDecision = await shouldReply(
          bundledMsg,
          decisionContext ? { decisionContext } : {}
        );
        const taskId = replyDecision.taskId;

        if (!replyDecision.needReply) {
          logger.debug('跳过回复: 根据智能策略，本次不回复（已完成本轮聚合）');
          return;
        }

        logger.debug(`进入回复流程: taskId=${taskId || 'null'}`);

        if (bundledMsg.type === 'group' && typeof handleGroupReplyCandidate === 'function') {
          const safeTaskId = taskId ?? null;
          const groupPayload: { groupId?: string | number; senderId: string; bundledMsg: IncomingMessage; taskId?: string | null } = {
            senderId: userid,
            bundledMsg,
            taskId: safeTaskId
          };
          if (msg.group_id !== undefined && msg.group_id !== null) {
            groupPayload.groupId = msg.group_id;
          }
          await handleGroupReplyCandidate(
            groupPayload,
            {
              handleOneMessage,
              completeTask
            }
          );
        } else {
          await handleOneMessage(bundledMsg, taskId);
        }
        return;
      }
    } catch (e) {
      logger.error('处理消息失败', { err: String(e) });
    }
  });

  socket.on('open', () => {
    logger.success('WebSocket 连接已建立');
  });

  socket.on('error', (error) => {
    logger.error('WebSocket 错误', { err: String(error) });
  });

  socket.on('close', () => {
    logger.warn('WebSocket 连接已关闭');
  });

  socket.on('reconnect_exhausted', () => {
    logger.error(
      `WebSocket 重连耗尽（尝试 ${getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60)} 次，每次间隔 ${getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000)}ms）`
    );
  });
}

