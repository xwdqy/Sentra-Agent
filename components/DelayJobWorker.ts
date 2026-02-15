import { createLogger } from '../utils/logger.js';
import { getEnvBool } from '../utils/envHotReloader.js';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('DelayJobWorker');

type BaseMessage = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  text?: string;
  summary?: string;
  message_id?: string | number | null;
};

type DelaySchedule = {
  mode?: string;
  text?: string;
  targetISO?: string;
  timezone?: string;
};

type DelayJob = {
  aiName?: string;
  jobId?: string | number;
  runId?: string;
  scheduleMode?: string;
  schedule?: DelaySchedule;
  plannedStepIndex?: number;
  type?: string;
  groupId?: string | number | null;
  userId?: string | number | null;
  reason?: string;
  args?: Record<string, unknown>;
  delayMs?: number;
  retryDelayMs?: number;
  contextForLlmProgress?: string;
  contextForLlmCompletion?: string;
  fireAt?: number;
};

type HistoryEntry = {
  type?: string;
  aiName?: string;
  plannedStepIndex?: number | string;
  ts?: number | string;
  args?: Record<string, unknown>;
};

type ToolCallResult = {
  success?: boolean;
  code?: string;
  error?: string;
  data?: unknown;
  provider?: string;
};

type ChatWithRetryResult = {
  success: boolean;
  response?: string | null;
  noReply?: boolean;
  reason?: string;
  retries?: number;
};

type ChatWithRetryFn = (
  conversations: ChatMessage[],
  options: string | { model?: string; __sentraExpectedOutput?: string },
  groupId?: string
) => Promise<ChatWithRetryResult>;

type SendAndWaitResultFn = (payload: Record<string, unknown>) => Promise<unknown>;
type SdkSendAndWaitResultFn = {
  (payload: Record<string, unknown>): Promise<unknown>;
  (baseMsg: BaseMessage, reply: string, allowReply: boolean, options?: Record<string, unknown>): Promise<unknown>;
};

type HistoryStoreLike = {
  list: (runId: string, start: number, end: number) => Promise<unknown>;
};

type HistoryManagerLike = {
  getPendingMessagesContext: (groupIdKey: string, senderId?: string | null) => string;
  startAssistantMessage: (groupIdKey: string) => Promise<string | number>;
  cancelConversationPairById: (groupIdKey: string, pairId: string | number) => Promise<void>;
  appendToAssistantMessage: (groupIdKey: string, reply: string, pairId: string | number) => Promise<void>;
  finishConversationPair: (groupIdKey: string, pairId: string | number, userContent: string) => Promise<unknown>;
  promoteScopedConversationsToShared: (groupIdKey: string, senderId: string) => Promise<void>;
};

type SdkLike = {
  callTool: (params: { aiName: string; args?: Record<string, unknown>; context?: Record<string, unknown> }) => Promise<unknown>;
  sendAndWaitResult?: SdkSendAndWaitResultFn;
  stream?: (params: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
};

type DelayJobContext = {
  HistoryStore: HistoryStoreLike;
  loadMessageCache: (runId: string) => Promise<{ message?: BaseMessage } | null>;
  enqueueDelayedJob: (job: DelayJob) => Promise<unknown>;
  sdk: SdkLike;
  historyManager: HistoryManagerLike;
  buildSentraResultBlock: (ev: Record<string, unknown>) => string;
  buildSentraUserQuestionBlock: (msg: BaseMessage) => string;
  getDailyContextMemoryXml: (groupIdKey: string) => Promise<string>;
  personaManager?: { formatPersonaForContext: (senderId: string) => string };
  emo?: { userAnalytics: (senderId: string, options: { days: number }) => Promise<unknown> };
  buildSentraEmoSection: (ua: unknown) => string;
  WORLDBOOK_XML?: string;
  AGENT_PRESET_XML?: string;
  baseSystem?: string | ((requiredOutput: string) => Promise<unknown> | unknown);
  CONTEXT_MEMORY_ENABLED?: boolean | (() => boolean);
  MAIN_AI_MODEL?: string | (() => string);
  triggerContextSummarizationIfNeeded: (payload: { groupId: string; chatType: string; userId: string }) => Promise<unknown>;
  triggerPresetTeachingIfNeeded: (payload: {
    groupId: string;
    chatType: string;
    userId: string;
    userContent: string;
    assistantContent: string;
  }) => Promise<unknown>;
  chatWithRetry: ChatWithRetryFn;
  smartSend?: (
    baseMsg: BaseMessage,
    reply: string,
    sendAndWaitResult: SendAndWaitResultFn,
    allowReply: boolean,
    options?: { hasTool?: boolean }
  ) => Promise<unknown>;
  sendAndWaitResult?: SendAndWaitResultFn;
  randomUUID: () => string;
  getActiveTaskCount?: (senderId?: string) => number;
  triggerTaskCompletionAnalysis?: (payload: Record<string, unknown>) => Promise<unknown>;
  agent?: unknown;
  socialContextManager?: { getXml: () => Promise<string> } | null;
};

function normalizeReplyText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export function createDelayJobRunJob(ctx: DelayJobContext) {
  const {
    HistoryStore,
    loadMessageCache,
    enqueueDelayedJob,
    sdk,
    historyManager,
    buildSentraResultBlock,
    buildSentraUserQuestionBlock,
    getDailyContextMemoryXml,
    personaManager,
    emo,
    buildSentraEmoSection,
    WORLDBOOK_XML,
    AGENT_PRESET_XML,
    baseSystem,
    CONTEXT_MEMORY_ENABLED,
    MAIN_AI_MODEL,
    triggerContextSummarizationIfNeeded,
    triggerPresetTeachingIfNeeded,
    chatWithRetry,
    smartSend,
    sendAndWaitResult,
    randomUUID,
    triggerTaskCompletionAnalysis
  } = ctx;

  const resolveBaseSystem = async (requiredOutput: string): Promise<string> => {
    try {
      if (typeof baseSystem === 'function') {
        const v = await baseSystem(requiredOutput);
        return typeof v === 'string' ? v : String(v ?? '');
      }
      return typeof baseSystem === 'string' ? baseSystem : String(baseSystem ?? '');
    } catch {
      return '';
    }
  };

  function getContextMemoryEnabled() {
    try {
      return typeof CONTEXT_MEMORY_ENABLED === 'function'
        ? !!CONTEXT_MEMORY_ENABLED()
        : !!CONTEXT_MEMORY_ENABLED;
    } catch {
      return false;
    }
  }

  function getMainAiModel() {
    try {
      const v = typeof MAIN_AI_MODEL === 'function' ? MAIN_AI_MODEL() : MAIN_AI_MODEL;
      return typeof v === 'string' && v.trim() ? v.trim() : 'gpt-3.5-turbo';
    } catch {
      return 'gpt-3.5-turbo';
    }
  }

  async function buildDelaySystemContent(groupIdKey: string, senderId: string): Promise<string> {
    let personaXml = '';
    if (personaManager && senderId) {
      try {
        personaXml = personaManager.formatPersonaForContext(senderId);
      } catch { }
    }
    let emoXml = '';
    try {
      const emoEnabled = getEnvBool('SENTRA_EMO_ENABLED', false);
      if (emoEnabled && emo && senderId) {
        const ua = await emo.userAnalytics(senderId, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
      }
    } catch { }
    let memoryXml = '';
    if (getContextMemoryEnabled()) {
      try {
        memoryXml = await getDailyContextMemoryXml(groupIdKey);
      } catch { }
    }
    const worldbookXml = WORLDBOOK_XML || '';
    const agentPresetXml = AGENT_PRESET_XML || '';

    const baseSystemText = await resolveBaseSystem('must_be_sentra_response');

    let socialXml = '';
    try {
      if (ctx && ctx.socialContextManager && typeof ctx.socialContextManager.getXml === 'function') {
        socialXml = await ctx.socialContextManager.getXml();
      }
    } catch { }

    const parts = [baseSystemText, personaXml, emoXml, memoryXml, socialXml, worldbookXml, agentPresetXml].filter(Boolean);
    return parts.join('\n\n');
  }

  async function sendDelayedReply(baseMsg: BaseMessage, reply: string, hasToolFlag = true): Promise<void> {
    if (!reply) return;
    try {
      if (typeof smartSend === 'function' && typeof sendAndWaitResult === 'function') {
        const allowReply = true;
        await smartSend(baseMsg, reply, sendAndWaitResult, allowReply, { hasTool: hasToolFlag });
      } else {
        logger.warn('DelayJobWorker: 缺少 smartSend/sendAndWaitResult，无法发送延迟任务回复', {
          type: baseMsg?.type,
          group_id: baseMsg?.group_id ?? undefined,
          sender_id: baseMsg?.sender_id ?? undefined
        });
      }
    } catch (e) {
      const gk = baseMsg?.group_id ? `G:${baseMsg.group_id}` : `U:${baseMsg?.sender_id || ''}`;
      logger.warn('DelayJobWorker: 发送延迟任务回复失败', { err: String(e), groupId: gk });
    }
  }

  function buildConversationId(baseMsg: BaseMessage, senderId: string): string | null {
    const uid = String(senderId || baseMsg?.sender_id || '').trim();
    if (!uid) return null;
    const gid = baseMsg?.group_id != null ? String(baseMsg.group_id).trim() : '';
    if (gid) return `group_${gid}_sender_${uid}`;
    return `private_${uid}`;
  }

  function triggerCompletionAnalysisSafe(payload: Record<string, unknown>): void {
    try {
      if (typeof triggerTaskCompletionAnalysis !== 'function') return;
      triggerTaskCompletionAnalysis(payload).catch((e) => {
        logger.debug('DelayJobWorker: TaskCompletionAnalysis failed', { err: String(e) });
      });
    } catch (e) {
      logger.debug('DelayJobWorker: TaskCompletionAnalysis error', { err: String(e) });
    }
  }

  return async function runJob(job: DelayJob): Promise<void> {
    try {
      const aiName = job && job.aiName;
      if (!aiName) {
        logger.warn('DelayJobWorker: job 缺少 aiName，跳过', { jobId: job && job.jobId });
        return;
      }

      const runId = job && job.runId;
      const scheduleModeRaw = job && job.scheduleMode;
      const scheduleMode = typeof scheduleModeRaw === 'string'
        ? scheduleModeRaw
        : (job && job.schedule && job.schedule.mode) || undefined;
      const scheduleModeNorm = typeof scheduleMode === 'string' ? scheduleMode.toLowerCase() : '';
      const isImmediateSendOnly = scheduleModeNorm === 'immediate_exec';
      const plannedStepIndex = Number.isFinite(job && job.plannedStepIndex)
        ? Number(job.plannedStepIndex)
        : 0;

      let cacheMsg: BaseMessage | null = null;
      if (runId) {
        try {
          const cache = await loadMessageCache(runId);
          cacheMsg = cache && cache.message ? cache.message : null;
        } catch (e) {
          logger.debug('DelayJobWorker: 读取消息缓存失败', { runId, err: String(e) });
        }
      }

      const fallbackSenderId = job && job.userId ? String(job.userId) : '';
      const fallbackMsg: BaseMessage = {
        type: (job && job.type) || 'private',
        sender_id: fallbackSenderId,
        text: (job && job.reason) || '',
        summary: (job && job.reason) || ''
      };
      if (job && job.groupId) {
        fallbackMsg.group_id = job.groupId;
      }
      const baseMsg: BaseMessage = cacheMsg || fallbackMsg;

      const senderId = String(baseMsg.sender_id || fallbackSenderId || '');
      const groupIdKey = baseMsg.group_id ? `G:${baseMsg.group_id}` : `U:${senderId}`;
      const systemContent = await buildDelaySystemContent(groupIdKey, senderId);
      const contextXml = historyManager.getPendingMessagesContext(groupIdKey, senderId);
      const contextForLlmProgress = job && typeof job.contextForLlmProgress === 'string' ? job.contextForLlmProgress : '';
      const contextForLlmCompletion = job && typeof job.contextForLlmCompletion === 'string' ? job.contextForLlmCompletion : '';
      const chatType = baseMsg.group_id ? 'group' : 'private';
      const userIdForMemory = senderId || '';
      const conversationId = buildConversationId(baseMsg, senderId);

      if (isImmediateSendOnly && runId) {
      let history: HistoryEntry[] = [];
      try {
          const list = await HistoryStore.list(runId, 0, -1);
          if (Array.isArray(list)) {
            history = list as HistoryEntry[];
          }
        } catch (e) {
          logger.debug('DelayJobWorker: 读取 HistoryStore 失败', { runId, err: String(e) });
        }

        let toolEntry: HistoryEntry | null = null;
        if (Array.isArray(history) && history.length > 0) {
          const candidates = history.filter(
            (x) =>
              x &&
              x.type === 'tool_result' &&
              x.aiName === aiName &&
              Number(x.plannedStepIndex ?? 0) === plannedStepIndex
          );
          if (candidates.length > 0) {
            candidates.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
            const last = candidates[candidates.length - 1];
            toolEntry = last || null;
          }
        }

        if (!toolEntry) {
          const scheduleInfo = job && job.schedule ? job.schedule : {};
          const delayMs = Number.isFinite(job && job.delayMs)
            ? Number(job.delayMs)
            : Number(job && job.delayMs ? job.delayMs : 0) || 0;

          const progressEv = {
            type: 'tool_result',
            aiName: 'schedule_progress',
            plannedStepIndex,
            executionIndex: -1,
            reason:
              (job && job.reason)
                ? job.reason
                : (scheduleInfo && scheduleInfo.text)
                  ? `正在执行定时任务 ${scheduleInfo.text}`
                  : '定时任务仍在执行中',
            nextStep: '',
            args: {
              original_aiName: aiName,
              status: 'in_progress',
              elapsedMs: 0,
              delayMs,
              schedule: scheduleInfo
            },
            result: {
              success: true,
              code: 'IN_PROGRESS',
              provider: 'system',
              data: {
                original_aiName: aiName,
                kind: 'delay_progress',
                status: 'in_progress',
                delayMs,
                elapsedMs: 0,
                schedule_text: scheduleInfo && scheduleInfo.text,
                schedule_targetISO: scheduleInfo && scheduleInfo.targetISO,
                schedule_timezone: scheduleInfo && scheduleInfo.timezone
              }
            },
            elapsedMs: 0,
            dependsOn: [],
            dependedBy: [],
            groupId: null,
            groupSize: 1,
            toolMeta: { provider: 'system' }
          };

          let progressXml;
          try {
            progressXml = buildSentraResultBlock(progressEv);
          } catch (e) {
            logger.warn('DelayJobWorker: 构建进度 <sentra-result> 失败，回退 JSON', {
              err: String(e)
            });
            progressXml = JSON.stringify(progressEv);
          }

          const userQuestionXml = buildSentraUserQuestionBlock(baseMsg);
          const combinedUserQuestion = contextForLlmProgress
            ? contextForLlmProgress
            : (contextXml
              ? `${contextXml}\n\n${userQuestionXml}`
              : userQuestionXml);
          const fullUserContent = `${progressXml}\n\n${combinedUserQuestion}`;

          const conversations: ChatMessage[] = [
            { role: 'system', content: systemContent },
            { role: 'user', content: fullUserContent }
          ];

          const progressPairId = await historyManager.startAssistantMessage(groupIdKey);

          const llmRes = await chatWithRetry(
            conversations,
            { model: getMainAiModel(), __sentraExpectedOutput: 'sentra_response' },
            groupIdKey
          );

          if (!llmRes || !llmRes.success) {
            logger.error('DelayJobWorker: AI 生成延迟进度回复失败', {
              groupId: groupIdKey,
              reason: llmRes && llmRes.reason,
              retries: llmRes && llmRes.retries
            });
            try {
              await historyManager.cancelConversationPairById(groupIdKey, progressPairId);
            } catch (e) {
              logger.debug('DelayJobWorker: 取消进度对话对失败', {
                groupId: groupIdKey,
                err: String(e)
              });
            }
          } else {
            const reply = normalizeReplyText(llmRes.response);
            const noReply = !!llmRes.noReply;

            await historyManager.appendToAssistantMessage(
              groupIdKey,
              reply,
              progressPairId
            );

            const savedProgress = await historyManager.finishConversationPair(
              groupIdKey,
              progressPairId,
              fullUserContent
            );
            if (!savedProgress) {
              logger.warn(
                `保存进度对话对失败: ${groupIdKey} pairId ${String(progressPairId).substring(0, 8)}`
              );
            } else {
              if (String(groupIdKey || '').startsWith('G:') && senderId) {
                try {
                  await historyManager.promoteScopedConversationsToShared(groupIdKey, senderId);
                } catch { }
              }
              triggerContextSummarizationIfNeeded({
                groupId: groupIdKey,
                chatType,
                userId: userIdForMemory
              }).catch((e) => {
                logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
                  err: String(e)
                });
              });
              triggerPresetTeachingIfNeeded({
                groupId: groupIdKey,
                chatType,
                userId: userIdForMemory,
                userContent: fullUserContent,
                assistantContent: reply
              }).catch((e) => {
                logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
                  err: String(e)
                });
              });
            }

            if (!noReply) {
              const allowReply = true;
              await sdk && sdk.sendAndWaitResult
                ? sdk.sendAndWaitResult(baseMsg, reply, allowReply, { hasTool: true })
                : null;
            } else {
              logger.info('DelayJobWorker: 模型选择对延迟进度保持沉默', { groupId: groupIdKey });
            }
          }

          const retryDelayMsBase =
            Number.isFinite(job && job.retryDelayMs) && Number(job.retryDelayMs) > 0
              ? Number(job.retryDelayMs)
              : 5000;
          const retryDelayMs = Math.max(1000, Math.min(retryDelayMsBase, 60000));
          const nextFireAt = Date.now() + retryDelayMs;

          const nextJob = {
            ...job,
            jobId: job && job.jobId ? String(job.jobId) + '_retry_' + Date.now() : randomUUID(),
            fireAt: nextFireAt
          };

          await enqueueDelayedJob(nextJob);
          return;
        }

        const ev = toolEntry;
        let resultXml;
        try {
          resultXml = buildSentraResultBlock(ev);
        } catch (e) {
          logger.warn('DelayJobWorker: 构建 <sentra-result> 失败，回退 JSON', { err: String(e) });
          resultXml = JSON.stringify(ev);
        }

        // 当已有 tool_result 时，跳过冗余的 <sentra-user-question>，避免误导模型
        // 明确标记任务已到期 (isDue=true)，让模型知道该发送最终通知了
        const fullUserContent = resultXml;

        const conversations: ChatMessage[] = [
          { role: 'system', content: systemContent },
          { role: 'user', content: fullUserContent }
        ];

        const pairId = await historyManager.startAssistantMessage(groupIdKey);

        const llmRes = await chatWithRetry(
          conversations,
          { model: getMainAiModel(), __sentraExpectedOutput: 'sentra_response' },
          groupIdKey
        );

        if (!llmRes || !llmRes.success) {
          logger.error('DelayJobWorker: AI 生成延迟任务回复失败', {
            groupId: groupIdKey,
            reason: llmRes && llmRes.reason,
            retries: llmRes && llmRes.retries
          });
          try {
            await historyManager.cancelConversationPairById(groupIdKey, pairId);
          } catch (e) {
            logger.debug('DelayJobWorker: 取消延迟任务对话对失败', {
              groupId: groupIdKey,
              err: String(e)
            });
          }
          return;
        }

        const reply = normalizeReplyText(llmRes.response);
        const noReply = !!llmRes.noReply;

        await historyManager.appendToAssistantMessage(groupIdKey, reply, pairId);

        const savedPair = await historyManager.finishConversationPair(
          groupIdKey,
          pairId,
          fullUserContent
        );
        if (!savedPair) {
          logger.warn(
            `保存延迟任务对话对失败: ${groupIdKey} pairId ${String(pairId).substring(0, 8)}`
          );
        } else {
          if (String(groupIdKey || '').startsWith('G:') && senderId) {
            try {
              await historyManager.promoteScopedConversationsToShared(groupIdKey, senderId);
            } catch { }
          }
          triggerContextSummarizationIfNeeded({
            groupId: groupIdKey,
            chatType,
            userId: userIdForMemory
          }).catch((e) => {
            logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
              err: String(e)
            });
          });
          triggerPresetTeachingIfNeeded({
            groupId: groupIdKey,
            chatType,
            userId: userIdForMemory,
            userContent: fullUserContent,
            assistantContent: reply
          }).catch((e) => {
            logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
              err: String(e)
            });
          });
        }

        if (noReply) {
          logger.info('DelayJobWorker: 模型选择对延迟任务保持沉默', { groupId: groupIdKey });
          return;
        }

        await sendDelayedReply(baseMsg, reply, true);
        triggerCompletionAnalysisSafe({
          agent: ctx?.agent || ctx?.sdk,
          groupId: groupIdKey,
          conversationId,
          userId: senderId,
          userObjective: (job && job.reason) || '',
          toolInvocations: [{ aiName, args: toolEntry?.args || {} }],
          toolResultEvents: [toolEntry],
          finalResponse: reply,
          hasToolCalled: true
        });
        return;
      }

      const toolArgs = job && job.args && typeof job.args === 'object' ? job.args : {};
      const startedAt = Date.now();
      let toolRes: ToolCallResult;
      try {
        const contextForTool = {
          source: 'delay_queue',
          runId: job && job.runId ? String(job.runId) : undefined,
        };
        toolRes = (await sdk.callTool({ aiName, args: toolArgs, context: contextForTool })) as ToolCallResult;
      } catch (e) {
        toolRes = { success: false, code: 'ERROR', error: String(e), data: null };
      }
      const elapsedMs = Date.now() - startedAt;

      const ev = {
        type: 'tool_result',
        aiName,
        plannedStepIndex,
        resultStatus: 'final',
        executionIndex: -1,
        reason: (job && job.reason) || '延迟任务到期自动执行',
        nextStep: '',
        args: toolArgs,
        result: toolRes,
        completion: {
          state: 'completed',
          mustAnswerFromResult: true,
          instruction: 'Tool execution has finished for this step. Answer the user based on the tool result and extracted files/resources.'
        },
        elapsedMs,
        dependsOn: [],
        dependedBy: [],
        groupId: null,
        groupSize: 1,
        toolMeta: { provider: (toolRes && toolRes.provider) || 'delay_queue' }
      };

      let resultXml;
      try {
        resultXml = buildSentraResultBlock(ev);
      } catch (e) {
        logger.warn('DelayJobWorker: 构建 <sentra-result> 失败，回退 JSON', { err: String(e) });
        resultXml = JSON.stringify(ev);
      }

      // 到点执行完成：只注入最终 <sentra-result>，避免再次注入 pending/user-question 误导模型重复“承诺/计划”。
      const fullUserContent = resultXml;

      const conversations: ChatMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: fullUserContent }
      ];

      const pairId = await historyManager.startAssistantMessage(groupIdKey);

      const llmRes = await chatWithRetry(
        conversations,
        { model: getMainAiModel(), __sentraExpectedOutput: 'sentra_response' },
        groupIdKey
      );

      if (!llmRes || !llmRes.success) {
        logger.error('DelayJobWorker: AI 生成延迟任务回复失败', {
          groupId: groupIdKey,
          reason: llmRes && llmRes.reason,
          retries: llmRes && llmRes.retries
        });
        try {
          await historyManager.cancelConversationPairById(groupIdKey, pairId);
        } catch (e) {
          logger.debug('DelayJobWorker: 取消延迟任务对话对失败', {
            groupId: groupIdKey,
            err: String(e)
          });
        }
        return;
      }

      const reply = normalizeReplyText(llmRes.response);
      const noReply = !!llmRes.noReply;

      await historyManager.appendToAssistantMessage(groupIdKey, reply, pairId);

      const savedPair = await historyManager.finishConversationPair(
        groupIdKey,
        pairId,
        fullUserContent
      );
      if (!savedPair) {
        logger.warn(
          `保存延迟任务对话对失败: ${groupIdKey} pairId ${String(pairId).substring(0, 8)}`
        );
      } else {
        if (String(groupIdKey || '').startsWith('G:') && senderId) {
          try {
            await historyManager.promoteScopedConversationsToShared(groupIdKey, senderId);
          } catch { }
        }
        triggerContextSummarizationIfNeeded({
          groupId: groupIdKey,
          chatType,
          userId: userIdForMemory
        }).catch((e) => {
          logger.debug(`ContextMemory: 异步摘要触发失败 ${groupIdKey}`, {
            err: String(e)
          });
        });
        triggerPresetTeachingIfNeeded({
          groupId: groupIdKey,
          chatType,
          userId: userIdForMemory,
          userContent: fullUserContent,
          assistantContent: reply
        }).catch((e) => {
          logger.debug(`PresetTeaching: 异步教导触发失败 ${groupIdKey}`, {
            err: String(e)
          });
        });
      }

      if (noReply) {
        logger.info('DelayJobWorker: 模型选择对延迟任务保持沉默', { groupId: groupIdKey });
        return;
      }

      await sendDelayedReply(baseMsg, reply, true);
      triggerCompletionAnalysisSafe({
        agent: ctx?.agent || ctx?.sdk,
        groupId: groupIdKey,
        conversationId,
        userId: senderId,
        userObjective: (job && job.reason) || '',
        toolInvocations: [{ aiName, args: toolArgs }],
        toolResultEvents: [ev],
        finalResponse: reply,
        hasToolCalled: true
      });
      return;
    } catch (e) {
      logger.warn('DelayJobWorker: 处理延迟任务异常', { err: String(e) });
    }
  };
}
