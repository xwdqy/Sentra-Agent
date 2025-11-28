export async function handleOneMessageCore(ctx, msg, taskId) {
  const {
    logger,
    historyManager,
    timeParser,
    MCP_MAX_CONTEXT_PAIRS,
    CONTEXT_MEMORY_ENABLED,
    getDailyContextMemoryXml,
    personaManager,
    emo,
    buildSentraEmoSection,
    AGENT_PRESET_XML,
    AGENT_PRESET_PLAIN_TEXT,
    AGENT_PRESET_RAW_TEXT,
    baseSystem,
    convertHistoryToMCPFormat,
    buildSentraUserQuestionBlock,
    buildSentraResultBlock,
    smartSend,
    sdk,
    isTaskCancelled,
    trackRunForSender,
    untrackRunForSender,
    chatWithRetry,
    MAIN_AI_MODEL,
    triggerContextSummarizationIfNeeded,
    triggerPresetTeachingIfNeeded,
    clearCancelledTask,
    completeTask,
    startBundleForQueuedMessage,
    collectBundleForSender,
    drainPendingMessagesForSender,
    shouldReply,
    sendAndWaitResult,
    randomUUID
  } = ctx;

  const userid = String(msg?.sender_id ?? '');
  const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${userid}`;
  const currentTaskId = taskId;

  const conversationId = msg?.group_id
    ? `group_${msg.group_id}_sender_${userid}`
    : `private_${userid}`;

  let convId = null;
  let pairId = null;
  let currentUserContent = '';
  let isCancelled = false; // 任务取消标记：检测到新消息时设置为 true
  let hasReplied = false; // 引用控制标记：记录是否已经发送过第一次回复（只有第一次引用消息）

  try {
    /**
     * 动态感知用户的连续输入和修正
     * 步骤1：将该sender_id的消息从待处理队列移到正在处理队列
     * 这样可以避免任务完成后被误清空，同时能及时感知用户的补充和修正
     */
    await historyManager.startProcessingMessages(groupId, userid);

    /**
     * 步骤2：获取该sender_id在队列中的所有消息（包括待处理和正在处理）
     * 这样bot在处理任务过程中能及时看到用户的补充和修正
     */
    const getAllSenderMessages = () => {
      return historyManager.getPendingMessagesBySender(groupId, userid);
    };

    // 获取该sender_id的所有消息
    let senderMessages = getAllSenderMessages();

    /**
     * 构建拼接内容：将该sender_id的所有消息按时间顺序拼接
     * 让bot能看到完整的任务演变过程（原始请求 -> 修正 -> 补充）
     */
    const buildConcatenatedContent = (messages) => {
      if (messages.length === 0) {
        return msg?.summary || msg?.text || '';
      }
      // 拼接所有消息，用换行符分隔，保留时间戳以便bot理解顺序
      return messages
        .map((m) => {
          const timeStr = m.time_str || '';
          const content = m.summary || m.text || '';
          return timeStr ? `[${timeStr}] ${content}` : content;
        })
        .join('\n\n');
    };

    // objective 和 conversation 都使用相同的拼接内容
    // 确保bot在所有阶段都能看到完整的上下文
    const userObjective = buildConcatenatedContent(senderMessages);

    // conversation: 构建 MCP FC 协议格式的对话上下文
    // 包含：1. 历史工具调用上下文 2. 当前用户消息（使用 Sentra XML 块，而非 summary 文本）
    // 使用聚合后的最终用户输入（msg）进行时间解析：若文本包含时间表达式，则优先选取该时间段内的历史对话，再合并最近若干对话
    const timeText = (msg?.text || msg?.summary || '').trim();

    const contextPairsLimit =
      Number.isFinite(MCP_MAX_CONTEXT_PAIRS) && MCP_MAX_CONTEXT_PAIRS > 0
        ? MCP_MAX_CONTEXT_PAIRS
        : historyManager.maxConversationPairs || 20;

    let historyConversations = historyManager.getConversationHistoryForContext(groupId, {
      recentPairs: contextPairsLimit
    });
    try {
      if (timeText) {
        const hasTime = timeParser.containsTimeExpression(timeText, { language: 'zh-cn' });
        if (hasTime) {
          logger.info(`检测到时间表达式，尝试按时间窗口筛选历史: ${timeText}`);
          const parsedTime = timeParser.parseTimeExpression(timeText, {
            language: 'zh-cn',
            timezone: 'Asia/Shanghai'
          });
          if (parsedTime && parsedTime.success && parsedTime.windowTimestamps) {
            const { start, end } = parsedTime.windowTimestamps;
            const fmtStart = parsedTime.windowFormatted?.start || new Date(start).toISOString();
            const fmtEnd = parsedTime.windowFormatted?.end || new Date(end).toISOString();
            const enhancedHistory = historyManager.getConversationHistoryForContext(groupId, {
              timeStart: start,
              timeEnd: end,
              recentPairs: contextPairsLimit
            });
            if (Array.isArray(enhancedHistory)) {
              if (enhancedHistory.length > 0) {
                historyConversations = enhancedHistory;
                logger.info(
                  `时间窗口命中: ${groupId} window [${fmtStart} - ${fmtEnd}], 使用筛选后的历史${historyConversations.length}条 (limit=${contextPairsLimit})`
                );
              } else {
                logger.info(
                  `时间窗口内未找到历史对话: ${groupId} window [${fmtStart} - ${fmtEnd}], 保持原有历史${historyConversations.length}条 (limit=${contextPairsLimit})`
                );
              }
            }
          } else {
            logger.info(`时间解析未成功，保持原有历史: ${groupId}`);
          }
        } else {
          logger.debug(`未检测到时间表达式: ${groupId} text="${timeText}"`);
        }
      }
    } catch (e) {
      logger.warn(`时间解析或历史筛选失败: ${groupId}`, { err: String(e) });
    }

    const mcpHistory = convertHistoryToMCPFormat(historyConversations);

    // 复用构建逻辑：pending-messages（如果有） + sentra-user-question（当前消息）
    const latestMsg = senderMessages[senderMessages.length - 1] || msg;
    const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
    const userQuestionXml = buildSentraUserQuestionBlock(latestMsg);
    currentUserContent = pendingContextXml
      ? pendingContextXml + '\n\n' + userQuestionXml
      : userQuestionXml;

    const conversation = [
      ...mcpHistory, // 历史上下文（user 的 sentra-user-question + assistant 的 sentra-tools）
      { role: 'user', content: currentUserContent } // 当前任务（XML 块）
    ];

    //console.log(JSON.stringify(conversation, null, 2))
    logger.debug(
      `MCP上下文: ${groupId} 使用历史${historyConversations.length}条 (limit=${contextPairsLimit}) → 转换后${mcpHistory.length}条 + 当前1条 = 总计${conversation.length}条`
    );

    // 获取用户画像（如果启用）
    let personaContext = '';
    if (personaManager && userid) {
      personaContext = personaManager.formatPersonaForContext(userid);
      if (personaContext) {
        logger.debug(`用户画像: ${userid} 画像已加载`);
      }
    }

    // 获取近期情绪（用于 <sentra-emo>）
    let emoXml = '';
    try {
      if (userid) {
        const ua = await emo.userAnalytics(userid, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
      }
    } catch {}

    const agentPresetXml = AGENT_PRESET_XML || '';

    // 组合系统提示词：baseSystem + persona + emo + memory + agent-preset(最后)
    let memoryXml = '';
    if (CONTEXT_MEMORY_ENABLED) {
      try {
        memoryXml = await getDailyContextMemoryXml(groupId);
        if (memoryXml) {
          logger.debug(`上下文记忆: ${groupId} 已加载当日摘要`);
        }
      } catch (e) {
        logger.debug(`上下文记忆加载失败: ${groupId}`, { err: String(e) });
      }
    }

    const systemParts = [baseSystem, personaContext, emoXml, memoryXml, agentPresetXml].filter(Boolean);
    const systemContent = systemParts.join('\n\n');

    let conversations = [{ role: 'system', content: systemContent }, ...historyConversations];
    const overlays = { global: AGENT_PRESET_PLAIN_TEXT || AGENT_PRESET_RAW_TEXT || '' };
    const sendAndWaitWithConv = (m) => {
      const mm = m || {};
      if (!mm.requestId) {
        try {
          mm.requestId = `${convId || randomUUID()}:${randomUUID()}`;
        } catch {
          mm.requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        }
      }
      return sendAndWaitResult(mm);
    };

    // 记录初始消息数量
    const initialMessageCount = senderMessages.length;

    for await (const ev of sdk.stream({
      objective: userObjective,
      conversation: conversation,
      overlays
    })) {
      logger.debug('Agent事件', ev);

      if (currentTaskId && isTaskCancelled(currentTaskId)) {
        isCancelled = true;
        logger.info(`检测到任务已被取消: ${groupId} taskId=${currentTaskId}`);
        break;
      }

      // 在 start 事件时缓存消息 - 缓存最后一条待回复消息
      if (ev.type === 'start' && ev.runId) {
        // 记录 runId，用于后续在“改主意”场景下通知 MCP 取消对应运行
        trackRunForSender(userid, ev.runId);

        // 实时获取最新的消息列表
        senderMessages = getAllSenderMessages();

        // 检查是否有新消息到达
        if (senderMessages.length > initialMessageCount) {
          logger.info(
            `动态感知: ${groupId} 检测到新消息 ${initialMessageCount} -> ${senderMessages.length}，将更新上下文`
          );
        }
      }

      if (ev.type === 'judge') {
        if (!convId) convId = randomUUID();
        if (!ev.need) {
          // 开始构建 Bot 回复
          pairId = await historyManager.startAssistantMessage(groupId);
          logger.debug(`创建pairId-Judge: ${groupId} pairId ${pairId?.substring(0, 8)}`);

          // 实时获取最新的sender消息列表
          senderMessages = getAllSenderMessages();

          // 检查是否有新消息：如果有，需要拼接所有消息作为上下文
          if (senderMessages.length > initialMessageCount) {
            logger.info(`动态感知Judge: ${groupId} 检测到新消息，拼接完整上下文`);
          }

          const latestMsgJudge = senderMessages[senderMessages.length - 1] || msg;

          // 获取历史上下文（仅供参考，只包含该 sender 的历史消息）
          const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
          // 构建当前需要回复的消息（主要内容）- 使用最新的消息
          const userQuestion = buildSentraUserQuestionBlock(latestMsgJudge);

          // 组合上下文：历史上下文 + 当前消息
          if (contextXml) {
            currentUserContent = contextXml + '\n\n' + userQuestion;
          } else {
            currentUserContent = userQuestion;
          }

          // Judge 判定无需工具：为当前对话显式注入占位工具与结果，便于后续模型判断
          try {
            const reasonText =
              (latestMsgJudge?.summary || latestMsgJudge?.text || 'No tool required for this message.').trim();
            const toolsXML = [
              '<sentra-tools>',
              '  <invoke name="none">',
              '    <parameter name="no_tool">true</parameter>',
              `    <parameter name="reason">${reasonText}</parameter>`,
              '  </invoke>',
              '</sentra-tools>'
            ].join('\n');

            const evNoTool = {
              type: 'tool_result',
              aiName: 'none',
              plannedStepIndex: 0,
              reason: reasonText,
              result: {
                success: true,
                code: 'NO_TOOL',
                provider: 'system',
                data: { no_tool: true, reason: reasonText }
              }
            };
            const resultXML = buildSentraResultBlock(evNoTool);
            // 将占位工具+结果置于最前，保持与工具路径一致的上下文结构
            currentUserContent = toolsXML + '\n\n' + resultXML + '\n\n' + currentUserContent;
          } catch {}

          conversations.push({ role: 'user', content: currentUserContent });
          // logger.debug('Conversations', conversations);
          //console.log(JSON.stringify(conversations, null, 2))
          const result = await chatWithRetry(conversations, MAIN_AI_MODEL, groupId);

          if (!result.success) {
            logger.error(
              `AI响应失败Judge: ${groupId} 原因 ${result.reason}, 重试${result.retries}次`
            );
            if (pairId) {
              logger.debug(
                `取消pairId-Judge失败: ${groupId} pairId ${pairId.substring(0, 8)}`
              );
              await historyManager.cancelConversationPairById(groupId, pairId);
              pairId = null;
            }
            return;
          }

          const response = result.response;
          logger.success(`AI响应成功Judge: ${groupId} 重试${result.retries}次`);

          await historyManager.appendToAssistantMessage(groupId, response, pairId);

          const latestSenderMessages = getAllSenderMessages();
          if (latestSenderMessages.length > initialMessageCount) {
            logger.info(
              `动态感知Judge: ${groupId} 检测到补充消息 ${initialMessageCount} -> ${latestSenderMessages.length}，整合到上下文`
            );
          }

          if (isCancelled) {
            logger.info(`任务已取消: ${groupId} 跳过发送Judge阶段`);
            return;
          }

          senderMessages = getAllSenderMessages();
          const finalMsg = senderMessages[senderMessages.length - 1] || msg;
          const allowReply = true;
          logger.debug(
            `引用消息Judge: ${groupId} 消息${finalMsg.message_id}, sender ${finalMsg.sender_id}, 队列${senderMessages.length}条, 允许引用 ${allowReply}`
          );
          await smartSend(finalMsg, response, sendAndWaitWithConv, allowReply, { hasTool: false });
          hasReplied = true;

          const saved = await historyManager.finishConversationPair(
            groupId,
            pairId,
            currentUserContent
          );

          if (saved) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
              (e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
              }
            );
            triggerPresetTeachingIfNeeded({
              groupId,
              chatType,
              userId: userIdForMemory,
              userContent: currentUserContent,
              assistantContent: response
            }).catch((e) => {
              logger.debug(`PresetTeaching: 异步教导触发失败 ${groupId}`, { err: String(e) });
            });
          }

          pairId = null;
          return;
        }
      }

      if (ev.type === 'plan') {
        logger.info('执行计划', ev.plan.steps);
      }

      // 忽略 args/args_group 事件（只对 tool_result/_group 做回复）
      if (ev.type === 'args' || ev.type === 'args_group') {
        continue;
      }

      if (ev.type === 'tool_result' || ev.type === 'tool_result_group') {
        if (!pairId) {
          pairId = await historyManager.startAssistantMessage(groupId);
          logger.debug(`创建pairId-ToolResult: ${groupId} pairId ${pairId?.substring(0, 8)}`);
        }

        if (!currentUserContent) {
          senderMessages = getAllSenderMessages();

          if (senderMessages.length > initialMessageCount) {
            logger.info(
              `动态感知ToolResult: ${groupId} 检测到新消息，拼接完整上下文`
            );
          }

          const latestMsgTool = senderMessages[senderMessages.length - 1] || msg;

          // 获取该 sender 的历史上下文
          const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
          const userQuestion = buildSentraUserQuestionBlock(latestMsgTool);

          if (contextXml) {
            currentUserContent = contextXml + '\n\n' + userQuestion;
          } else {
            currentUserContent = userQuestion;
          }
        }

        // 构建结果观测块
        let content = '';
        try {
          content = buildSentraResultBlock(ev);
        } catch (e) {
          logger.warn('构建 <sentra-result> 失败，回退 JSON 注入');
          content = JSON.stringify(ev);
        }

        const fullContext = content + '\n\n' + currentUserContent;

        // 更新 currentUserContent 为包含工具结果的完整上下文，确保保存到历史记录时不丢失工具结果
        currentUserContent = fullContext;

        conversations.push({ role: 'user', content: fullContext });
        //console.log(JSON.stringify(conversations, null, 2))
        const result = await chatWithRetry(conversations, MAIN_AI_MODEL, groupId);

        if (!result.success) {
          logger.error(
            `AI响应失败ToolResult: ${groupId} 原因 ${result.reason}, 重试${result.retries}次`
          );
          if (pairId) {
            logger.debug(
              `取消pairId-ToolResult失败: ${groupId} pairId ${pairId.substring(0, 8)}`
            );
            await historyManager.cancelConversationPairById(groupId, pairId);
            pairId = null;
          }
          return;
        }

        const response = result.response;
        logger.success(`AI响应成功ToolResult: ${groupId} 重试${result.retries}次`);

        await historyManager.appendToAssistantMessage(groupId, response, pairId);

        const latestSenderMessages = getAllSenderMessages();
        if (latestSenderMessages.length > initialMessageCount) {
          logger.info(
            `动态感知ToolResult: ${groupId} 检测到补充消息 ${initialMessageCount} -> ${latestSenderMessages.length}，整合到上下文`
          );
        }

        if (isCancelled) {
          logger.info(`任务已取消: ${groupId} 跳过发送ToolResult阶段`);
          return;
        }

        senderMessages = getAllSenderMessages();
        const finalMsg = senderMessages[senderMessages.length - 1] || msg;
        const allowReply = true;
        logger.debug(
          `引用消息ToolResult: ${groupId} 消息${finalMsg.message_id}, sender ${finalMsg.sender_id}, 队列${senderMessages.length}条, 允许引用 ${allowReply}`
        );
        await smartSend(finalMsg, response, sendAndWaitWithConv, allowReply, { hasTool: true });
        hasReplied = true;

        const chatTypeTool = msg?.group_id ? 'group' : 'private';
        const userIdForMemoryTool = userid || '';
        triggerPresetTeachingIfNeeded({
          groupId,
          chatType: chatTypeTool,
          userId: userIdForMemoryTool,
          userContent: currentUserContent,
          assistantContent: response
        }).catch((e) => {
          logger.debug(`PresetTeaching: 异步教导触发失败 ${groupId}`, { err: String(e) });
        });

        conversations.push({ role: 'assistant', content: response });
      }

      if (ev.type === 'summary') {
        logger.info('对话总结', ev.summary);

        if (ev.runId) {
          untrackRunForSender(userid, ev.runId);
        }

        if (isCancelled) {
          logger.info(`任务已取消: ${groupId} 跳过保存对话对Summary阶段`);
          if (pairId) {
            logger.debug(`清理pairId: ${groupId} pairId ${pairId?.substring(0, 8)}`);
            await historyManager.cancelConversationPairById(groupId, pairId);
            pairId = null;
          }
          break;
        }

        if (pairId) {
          logger.debug(`保存对话对: ${groupId} pairId ${pairId.substring(0, 8)}`);
          const saved = await historyManager.finishConversationPair(
            groupId,
            pairId,
            currentUserContent
          );
          if (!saved) {
            logger.warn(`保存失败: ${groupId} pairId ${pairId.substring(0, 8)} 状态不一致`);
          }

          if (saved) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
              (e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
              }
            );
          }

          pairId = null;
        } else {
          logger.warn(`跳过保存: ${groupId} pairId为null`);
        }
        break;
      }
    }
  } catch (error) {
    logger.error('处理消息异常: ', error);

    if (pairId) {
      logger.debug(`取消pairId-异常: ${groupId} pairId ${pairId.substring(0, 8)}`);
      await historyManager.cancelConversationPairById(groupId, pairId);
    }
  } finally {
    if (currentTaskId) {
      clearCancelledTask(currentTaskId);
    }
    // 任务完成，释放并发槽位并尝试拉起队列中的下一条
    // completeTask 会自动调用 replyPolicy.js 中的 removeActiveTask
    if (taskId && userid) {
      const next = await completeTask(userid, taskId);
      if (next && next.msg) {
        const nextUserId = String(next.msg?.sender_id ?? '');
        // 队列中的任务作为新的聚合会话起点
        startBundleForQueuedMessage(nextUserId, next.msg);
        const bundledNext = await collectBundleForSender(nextUserId);
        if (bundledNext) {
          await handleOneMessageCore(ctx, bundledNext, next.id);
        }
      }

      // 检查是否有待处理的消息（延迟聚合）
      const mergedMsg = drainPendingMessagesForSender(userid);
      if (mergedMsg) {
        const replyDecision = await shouldReply(mergedMsg);
        if (replyDecision.needReply) {
          logger.info(
            `延迟聚合回复决策: ${replyDecision.reason} (taskId=${replyDecision.taskId})`
          );
          await handleOneMessageCore(ctx, mergedMsg, replyDecision.taskId);
        } else {
          logger.debug(`延迟聚合跳过: ${replyDecision.reason}`);
        }
      }
    }

    logger.debug(`任务清理完成: ${groupId} sender ${userid}`);
  }
}
