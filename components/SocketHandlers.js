import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';
import { shouldAnalyzeEmotion } from '../utils/emotionGate.js';

export function setupSocketHandlers(ctx) {
  const {
    socket,
    logger,
    emo,
    historyManager,
    personaManager,
    desireManager,
    getActiveTaskCount,
    handleIncomingMessage,
    decideOverrideIntent,
    markTasksCancelledForSender,
    cancelRunsForSender,
    collectBundleForSender,
    shouldReply,
    handleOneMessage,
    handleGroupReplyCandidate,
    completeTask
  } = ctx;

  const incomingDedupTtlMsRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_TTL_MS', 60000);
  const incomingDedupTtlMs =
    Number.isFinite(incomingDedupTtlMsRaw) && incomingDedupTtlMsRaw > 0 ? incomingDedupTtlMsRaw : 60000;
  const incomingDedupMaxRaw = getEnvInt('INCOMING_MESSAGE_DEDUP_MAX', 5000);
  const incomingDedupMax =
    Number.isFinite(incomingDedupMaxRaw) && incomingDedupMaxRaw > 0 ? incomingDedupMaxRaw : 5000;
  const recentIncomingByConv = new Map();

  const shouldDropDuplicateIncoming = (conversationKey, messageId) => {
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
      const payload = JSON.parse(data.toString());

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
        const msg = payload.data || {};
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

        if (desireManager) {
          try {
            await desireManager.onUserMessage(msg);
          } catch (e) {
            logger.debug('DesireManager onUserMessage failed', { err: String(e) });
          }
        }

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
            groupId: msg?.group_id || null
          });
        }

        const taskConversationId = msg?.group_id
          ? `group_${msg.group_id}_sender_${userid}`
          : `private_${userid}`;

        // 检查是否有活跃任务（针对该会话），交给聚合模块决定如何处理
        const activeCount = getActiveTaskCount(taskConversationId);

        const incomingDecision = await handleIncomingMessage(taskConversationId, msg, { activeCount });
        if (incomingDecision.action === 'pending_queued') {
          // 已有活跃任务，新消息进入延迟聚合队列：由轻量 LLM 判断是否“改主意”，决定是否取消当前任务
          if (activeCount > 0 && typeof decideOverrideIntent === 'function') {
            try {
              const senderMessagesAll = historyManager.getPendingMessagesBySender(groupId, userid);
              if (Array.isArray(senderMessagesAll) && senderMessagesAll.length >= 2) {
                const maxHistory = 5;
                const lastIndex = senderMessagesAll.length - 1;
                const lastMsgObj = senderMessagesAll[lastIndex];
                const prevSlice = senderMessagesAll.slice(
                  Math.max(0, lastIndex - maxHistory),
                  lastIndex
                );

                const prevMessagesPayload = prevSlice
                  .map((m) => ({
                    text: m.text || m.summary || '',
                    time: m.time_str || ''
                  }))
                  .filter((m) => m.text);

                const newMessagePayload = {
                  text: lastMsgObj.text || lastMsgObj.summary || '',
                  time: lastMsgObj.time_str || ''
                };

                if (newMessagePayload.text && prevMessagesPayload.length > 0) {
                  const overrideDecision = await decideOverrideIntent({
                    scene: msg.type || 'unknown',
                    senderId: userid,
                    groupId: msg.group_id || null,
                    prevMessages: prevMessagesPayload,
                    newMessage: newMessagePayload
                  });

                  if (overrideDecision && overrideDecision.shouldCancel) {
                    markTasksCancelledForSender(taskConversationId);
                    // 仅取消当前会话（群/私聊）下、在当前消息之前启动的运行
                    cancelRunsForSender(userid, groupId, { cutoffTs: Date.now() });
                    logger.info(
                      `改意愿检测: sender=${userid} 取消当前任务, relation=${overrideDecision.relation}, confidence=${(overrideDecision.confidence * 100).toFixed(1)}%, reason=${overrideDecision.reason}`
                    );
                  }
                }
              }
            } catch (e) {
              logger.debug(`改意愿检测失败: ${groupId} sender ${userid}`, { err: String(e) });
            }
          }
          // 仍由延迟聚合 + drainPendingMessagesForSender 触发新的任务
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

        const replyDecision = await shouldReply(bundledMsg, { decisionContext });
        const taskId = replyDecision.taskId;

        if (!replyDecision.needReply) {
          logger.debug('跳过回复: 根据智能策略，本次不回复（已完成本轮聚合）');
          return;
        }

        logger.debug(`进入回复流程: taskId=${taskId || 'null'}`);

        if (bundledMsg.type === 'group' && typeof handleGroupReplyCandidate === 'function') {
          await handleGroupReplyCandidate(
            {
              groupId: msg.group_id,
              senderId: userid,
              bundledMsg,
              taskId
            },
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
      logger.error('处理消息失败', e);
    }
  });

  socket.on('open', () => {
    logger.success('WebSocket 连接已建立');
  });

  socket.on('error', (error) => {
    logger.error('WebSocket 错误', error);
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
