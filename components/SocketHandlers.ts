import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';
import { shouldAnalyzeEmotion } from '../utils/emotionGate.js';
import { collectXmlTagTextValues } from '../utils/xmlUtils.js';
import { applyScheduledReplyAction, scheduleReplyAction } from '../utils/replyActionScheduler.js';
import { appendContextMemoryEvent } from '../utils/contextMemoryManager.js';
import { buildGroupScopeId, buildPrivateScopeId } from '../utils/conversationId.js';

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
  summary_text?: string;
  summary_xml?: string;
  text?: string;
  objective?: string;
  objective_text?: string;
  objective_xml?: string;
  event_type?: string;
  at_users?: Array<string | number>;
  time_str?: string;
  _forceReply?: boolean;
  _forcePendingHold?: boolean;
  _forceNoReply?: boolean;
  _overrideDecision?: string;
  [key: string]: unknown;
};

type DecisionContextMessage = { text?: string; time?: string; sender_id?: string; sender_name?: string };
type DecisionContext = {
  group_recent_messages?: DecisionContextMessage[];
  sender_recent_messages?: DecisionContextMessage[];
  bot_recent_messages?: DecisionContextMessage[];
};

type DelayPlan = {
  whenText?: string;
  fireAt?: number;
  delayMs?: number;
  targetISO?: string;
  timezone?: string;
  parserMethod?: string;
};

type ShouldReplyDecision = {
  needReply: boolean;
  taskId?: string | null;
  action?: 'silent' | 'action' | 'short' | 'delay' | string;
  delay?: DelayPlan | null;
  reason?: string;
  reason_code?: string;
};

type HistoryManagerLike = {
  addPendingMessage: (groupId: string, summary: string, msg: IncomingMessage) => Promise<void>;
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
  dispatchRuntimeSignalForActiveRuns: (
    senderId: string,
    groupId: string | null,
    options: {
      mode: string;
      action?: string;
      reason?: string;
      reasonCode?: string;
      source?: string;
      sourceEventId?: string;
      latestUserObjective?: string;
      latestUserObjectiveXml?: string;
    }
  ) => number | Promise<number>;
  markConversationRuntimeState?: (
    senderId: string,
    conversationId: string,
    state: 'IDLE' | 'BUNDLING' | 'RUNNING' | 'DRAINING' | 'FINALIZED',
    meta?: { reasonCode?: string; source?: string; runId?: string; note?: string }
  ) => void;
  collectBundleForSender: (conversationId: string) => Promise<IncomingMessage | null>;
  shouldReply: (msg: IncomingMessage, options: { decisionContext?: DecisionContext; forceReply?: boolean; source?: string }) => Promise<ShouldReplyDecision>;
  handleOneMessage: (msg: IncomingMessage, taskId?: string | null) => Promise<void>;
  triggerContextSummarizationIfNeeded?: (payload: { groupId?: string; chatType?: string; userId?: string }) => Promise<void> | void;
};

function extractSegmentText(msg: IncomingMessage | null | undefined): string {
  const m = msg && typeof msg === 'object' ? msg : null;
  if (!m) return '';
  const segs = Array.isArray((m as any).message)
    ? (m as any).message
    : (Array.isArray((m as any).segments) ? (m as any).segments : []);
  const lines: string[] = [];
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue;
    const type = typeof seg.type === 'string' ? seg.type.trim().toLowerCase() : '';
    if (type !== 'text') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    const text = typeof (data as any).text === 'string' ? (data as any).text.trim() : '';
    if (!text) continue;
    lines.push(text);
  }
  return lines.join('\n').trim();
}

function extractTextFromProtocolXml(raw: unknown): string {
  const xml = typeof raw === 'string' ? raw.trim() : '';
  if (!xml) return '';
  if (!xml.includes('<sentra-') && !xml.includes('<message>')) return '';
  const textMatches = collectXmlTagTextValues(xml, ['text']);
  if (textMatches.length > 0) {
    return textMatches.join('\n').trim();
  }
  const previewMatch = collectXmlTagTextValues(xml, ['preview_text']);
  if (previewMatch.length > 0) {
    return previewMatch[0] || '';
  }
  return '';
}

function extractStructuredObjectiveXml(msg: IncomingMessage | null | undefined): string {
  const m = msg && typeof msg === 'object' ? msg : null;
  if (!m) return '';
  const candidates = [
    m.objective_xml,
    m.objective,
    m.summary_xml,
    m.summary
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (!text) continue;
    if (
      text.startsWith('<sentra-input') ||
      text.startsWith('<sentra-objective') ||
      text.startsWith('<sentra-summary') ||
      text.startsWith('<sentra-message')
    ) {
      return text;
    }
  }
  return '';
}

function extractMessagePlainText(msg: IncomingMessage | null | undefined): string {
  const m = msg && typeof msg === 'object' ? msg : null;
  if (!m) return '';
  const plainCandidates = [
    m.objective_text,
    m.summary_text,
    m.objective,
    m.summary,
    m.text
  ];
  for (const candidate of plainCandidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (!text) continue;
    if (text.startsWith('<')) {
      const fromXml = extractTextFromProtocolXml(text);
      if (fromXml) return fromXml;
      continue;
    }
    return text;
  }
  return extractSegmentText(m);
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
    dispatchRuntimeSignalForActiveRuns,
    markConversationRuntimeState,
    collectBundleForSender,
    shouldReply,
    handleOneMessage,
    triggerContextSummarizationIfNeeded
  } = ctx;

  const processBundledAsNewTask = async (
    bundledMsg: IncomingMessage,
    taskConversationId: string,
    groupId: string,
    userid: string
  ) => {
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
    const actionSchedule = scheduleReplyAction(replyDecision);
    const action = actionSchedule.action;
    logger.info(
      `ReplyDecision: conversation=${taskConversationId} action=${action} needReply=${actionSchedule.needReply ? 'true' : 'false'} taskId=${taskId || 'null'}${action === 'delay' ? ` delayWhen=${actionSchedule.delayWhen || ''}` : ''}${replyDecision.reason_code ? ` reason_code=${replyDecision.reason_code}` : ''}${actionSchedule.reason ? ` reason=${actionSchedule.reason}` : ''}`
    );

    if (!actionSchedule.needReply) {
      logger.debug('跳过回复: 根据智能策略，本次不回复（已完成本轮聚合）');
      return;
    }

    logger.debug(`进入回复流程: taskId=${taskId || 'null'}`);
    applyScheduledReplyAction(bundledMsg, actionSchedule);
    await handleOneMessage(bundledMsg, taskId);
  };

  const incomingDedupTtlMsRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_TTL_MS', 60000) ?? 60000;
  const incomingDedupTtlMs =
    Number.isFinite(incomingDedupTtlMsRaw) && incomingDedupTtlMsRaw > 0 ? incomingDedupTtlMsRaw : 60000;
  const incomingDedupMaxRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_MAX', 5000) ?? 5000;
  const incomingDedupMax =
    Number.isFinite(incomingDedupMaxRaw) && incomingDedupMaxRaw > 0 ? incomingDedupMaxRaw : 5000;
  const recentIncomingByConv = new Map<string, Map<string, number>>();

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
          let convId = msg.group_id ? buildGroupScopeId(msg.group_id) : buildPrivateScopeId(msg.sender_id || '');
          if (!msg.group_id) {
            const selfId = msg.self_id;
            if (selfId && msg.sender_id === selfId) {
              convId = buildPrivateScopeId(msg.target_id || '');
            }
          }
          logger.info('<< poke', {
            scene,
            group_id: msg.group_id || null,
            sender_id: msg.sender_id || null,
            sender_name: msg.sender_name || '',
            target_id: msg.target_id || null,
            target_name: msg.target_name || '',
            summary: extractMessagePlainText(msg) || '',
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

        const conversationKey = msg?.group_id ? buildGroupScopeId(msg.group_id) : buildPrivateScopeId(userid);
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

        const msgSegmentText = extractSegmentText(msg);
        const msgPlainText = extractMessagePlainText(msg);
        const emoText = msgPlainText || msgSegmentText;
        const emoEnabled = getEnvBool('SENTRA_EMO_ENABLED', false);
        if (emoEnabled && userid && emoText && emo && shouldAnalyzeEmotion(emoText, userid)) {
          emo.analyze(emoText, { userid, username }).catch(() => {});
        }
        const groupId = conversationKey;
        const summary = msgPlainText || msgSegmentText;
        await historyManager.addPendingMessage(groupId, summary, msg);
        try {
          const objectiveXml = extractStructuredObjectiveXml(msg);
          const rawMsgTs = Number((msg as Record<string, unknown>)?.time);
          const eventTs = Number.isFinite(rawMsgTs) && rawMsgTs > 0
            ? (rawMsgTs < 1000000000000 ? rawMsgTs * 1000 : rawMsgTs)
            : Date.now();
          await appendContextMemoryEvent(groupId, {
            kind: 'incoming_message',
            timestamp: eventTs,
            chatType: msg?.group_id ? 'group' : 'private',
            userId: userid || '',
            objective: summary || '',
            objectiveXml: objectiveXml || '',
            contentText: summary || '',
            ...(objectiveXml ? { contentXml: objectiveXml } : {}),
            metadata: {
              senderName: username || '',
              conversationKey,
              messageId: msg?.message_id != null ? String(msg.message_id) : '',
              groupId: msg?.group_id != null ? String(msg.group_id) : ''
            }
          });
        } catch { }
        if (triggerContextSummarizationIfNeeded && groupId) {
          Promise.resolve(
            triggerContextSummarizationIfNeeded({
              groupId,
              chatType: msg?.group_id ? 'group' : 'private',
              userId: userid || ''
            })
          ).catch(() => { });
        }

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
          if (typeof markConversationRuntimeState === 'function') {
            markConversationRuntimeState(userid, taskConversationId, 'BUNDLING', {
              reasonCode: 'pending_collect',
              source: 'socket_handlers'
            });
          }
          if (activeCount > 0) {
            try {
              const bundledMsg = await collectBundleForSender(taskConversationId);
              if (!bundledMsg) {
                logger.debug('runtime signal: pending_collect but bundle is empty');
                if (typeof markConversationRuntimeState === 'function') {
                  markConversationRuntimeState(userid, taskConversationId, 'RUNNING', {
                    reasonCode: 'pending_collect_bundle_empty',
                    source: 'socket_handlers'
                  });
                }
                return;
              }
              const activeCountNow = getActiveTaskCount(taskConversationId);
              if (activeCountNow <= 0) {
                logger.debug('runtime signal: active task finished after bundling; fallback to new task dispatch', {
                  reason_code: 'bundle_after_run_finished',
                  conversation: taskConversationId,
                  sender: userid
                });
                if (typeof markConversationRuntimeState === 'function') {
                  markConversationRuntimeState(userid, taskConversationId, 'FINALIZED', {
                    reasonCode: 'bundle_after_run_finished',
                    source: 'socket_handlers'
                  });
                }
                await processBundledAsNewTask(bundledMsg, taskConversationId, groupId, userid);
                return;
              }
              const runtimeObjective = String(
                extractMessagePlainText(bundledMsg) ||
                extractMessagePlainText(msg) ||
                summary ||
                ''
              ).trim();
              const runtimeObjectiveXml = String(
                extractStructuredObjectiveXml(bundledMsg) ||
                extractStructuredObjectiveXml(msg) ||
                ''
              ).trim();
              if (!runtimeObjective) {
                logger.debug('runtime signal: skip empty follow-up objective');
                return;
              }
              const dispatchedCount = await Promise.resolve(
                dispatchRuntimeSignalForActiveRuns(userid, taskConversationId, {
                  mode: 'conversation',
                  source: 'runtime_followup_message',
                  reason: 'active_task_followup',
                  reasonCode: 'active_task_followup',
                  sourceEventId: msg?.message_id != null ? String(msg.message_id) : '',
                  latestUserObjective: runtimeObjective,
                  latestUserObjectiveXml: runtimeObjectiveXml
                })
              );
              if (dispatchedCount > 0) {
                if (typeof markConversationRuntimeState === 'function') {
                  markConversationRuntimeState(userid, taskConversationId, 'DRAINING', {
                    reasonCode: 'runtime_signal_forwarded',
                    source: 'socket_handlers'
                  });
                }
                logger.info(
                  `Runtime signal forwarded: sender=${userid} conversation=${taskConversationId} dispatchedRuns=${dispatchedCount} objectiveLen=${runtimeObjective.length}`
                );
              } else {
                logger.debug(
                  `runtime signal: no active MCP run matched after bundling (sender=${userid}, conversation=${taskConversationId})`,
                  { reason_code: 'no_active_run_matched_after_bundle' }
                );
                if (typeof markConversationRuntimeState === 'function') {
                  markConversationRuntimeState(userid, taskConversationId, 'FINALIZED', {
                    reasonCode: 'no_active_run_matched_after_bundle',
                    source: 'socket_handlers'
                  });
                }
              }
            } catch (e) {
              logger.debug(`Runtime signal dispatch failed: ${groupId} sender ${userid}`, { err: String(e) });
              if (typeof markConversationRuntimeState === 'function') {
                markConversationRuntimeState(userid, taskConversationId, 'RUNNING', {
                  reasonCode: 'runtime_signal_dispatch_failed',
                  source: 'socket_handlers',
                  note: String(e)
                });
              }
            }
          }
          return;
        }

        if (incomingDecision.action === 'pending_queued') {
          return;
        }

        if (incomingDecision.action === 'buffered' || incomingDecision.action === 'ignore') {
          // 仍在聚合窗口或无需触发回复
          if (incomingDecision.action === 'buffered' && typeof markConversationRuntimeState === 'function') {
            markConversationRuntimeState(userid, taskConversationId, 'BUNDLING', {
              reasonCode: 'buffered_window',
              source: 'socket_handlers'
            });
          }
          return;
        }

        // start_bundle: 作为一轮新会话的起点，先等待聚合窗口结束拿到合并后的消息，再做智能回复决策
        if (typeof markConversationRuntimeState === 'function') {
          markConversationRuntimeState(userid, taskConversationId, 'BUNDLING', {
            reasonCode: 'start_bundle',
            source: 'socket_handlers'
          });
        }
        const bundledMsg = await collectBundleForSender(taskConversationId);
        if (!bundledMsg) {
          logger.debug('聚合结果为空，跳过本次消息');
          if (typeof markConversationRuntimeState === 'function') {
            markConversationRuntimeState(userid, taskConversationId, 'IDLE', {
              reasonCode: 'bundle_empty_skip',
              source: 'socket_handlers'
            });
          }
          return;
        }
        await processBundledAsNewTask(bundledMsg, taskConversationId, groupId, userid);
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

