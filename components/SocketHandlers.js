import { getEnvInt } from '../utils/envHotReloader.js';
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
        const msg = payload.data;
        logger.debug('<< message', msg.type, msg.group_id || msg.sender_id);
        const userid = String(msg?.sender_id ?? '');
        const username = msg?.sender_name || '';

        if (desireManager) {
          try {
            await desireManager.onUserMessage(msg);
          } catch (e) {
            logger.debug('DesireManager onUserMessage failed', { err: String(e) });
          }
        }

        const emoText =
          typeof msg?.text === 'string' && msg.text.trim() ? msg.text : msg?.summary || '';
        if (userid && emoText && emo && shouldAnalyzeEmotion(emoText, userid)) {
          emo.analyze(emoText, { userid, username }).catch(() => {});
        }
        const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${userid}`;
        const summary = msg?.summary || msg?.text || '';
        await historyManager.addPendingMessage(groupId, summary, msg);

        if (personaManager && userid && summary) {
          await personaManager.recordMessage(userid, {
            text: summary,
            timestamp: new Date().toISOString(),
            senderName: username,
            groupId: msg?.group_id || null
          });
        }

        // 检查是否有活跃任务（针对该用户），交给聚合模块决定如何处理
        const activeCount = getActiveTaskCount(userid);

        const incomingDecision = await handleIncomingMessage(userid, msg, { activeCount });
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
                    markTasksCancelledForSender(userid);
                    cancelRunsForSender(userid);
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
        const bundledMsg = await collectBundleForSender(userid);
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
        logger.info(
          `回复决策: ${replyDecision.reason} (mandatory=${replyDecision.mandatory}, probability=${(replyDecision.probability * 100).toFixed(1)}%, taskId=${
            taskId || 'null'
          })`
        );

        if (!replyDecision.needReply) {
          logger.debug('跳过回复: 根据智能策略，本次不回复（已完成本轮聚合）');
          return;
        }

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
