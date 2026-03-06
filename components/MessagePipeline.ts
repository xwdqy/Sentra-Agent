import { getEnvBool, getEnvInt, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import {
  parseSentraMessage,
  buildSentraInputBlock,
  buildSentraMessageBlock,
  applySentraMessageSegmentMessageId,
  applySentraMessageSegmentMessageIds
} from '../utils/protocolUtils.js';
import type { MergedUser, UserQuestionMessage } from '../utils/protocolUtils.js';
import { judgeReplySimilarity } from '../utils/replySimilarityJudge.js';
import { generateToolPreReply } from './ToolPreReplyGenerator.js';
import { decideExecutionPath } from './ToolRoutingDecider.js';

import { createRagSdk, getRagRuntimeConfig } from 'sentra-rag';
import { textSegmentation } from '../src/segmentation.js';
import { enqueueRagIngest } from '../utils/ragIngestQueue.js';
import { collectXmlTagTextValues, escapeXml, extractAllFullXMLTags, extractFullXMLTag, extractXMLTag } from '../utils/xmlUtils.js';
import {
  createRuntimeSkillContextBuilder,
  type ResultRoundMode
} from '../utils/runtimeSkillContextBuilder.js';
import {
  appendRuntimeUserMessage,
  composeRuntimeConversationMessages,
  resolveTimestampMsFromRecord
} from '../utils/contextMessageComposer.js';
import { tMessagePipeline } from '../utils/i18n/messagePipelineCatalog.js';
import { appendContextMemoryEvent } from '../utils/contextMemoryManager.js';
import {
  appendDelayRuntimeSessionEvent,
  createDelayRuntimeSession,
  getDelayRuntimeSessionSnapshot,
  isDelayRuntimeSessionDueFired,
  markDelayRuntimeSessionCompleted,
  updateDelayRuntimeSession
} from '../utils/delayRuntimeSessionStore.js';
import {
  type DelayReasonArgs,
  type DelayReasonCode,
  buildDelayReasonArgs,
  DELAY_REASON_CODE,
  normalizeDelayReasonArgs,
  normalizeDelayReasonCode
} from '../utils/delayReasonCodes.js';
import { DELAY_RUNTIME_AI_NAME, DELAY_RUNTIME_KIND } from '../utils/delayRuntimeConstants.js';
import type { DelayReplayPayload, DelayReplayToolResultEvent } from '../utils/delayRuntimeTypes.js';
import { applyScheduledReplyAction, scheduleReplyAction } from '../utils/replyActionScheduler.js';
import {
  McpRuntimeProtocolTracker,
  type RuntimeProtocolConsumeResult,
  type RuntimeProtocolSnapshot
} from '../utils/mcpRuntimeProtocol.js';
import {
  buildSkillsDispatchFinalEvents,
  SKILLS_RUNTIME_ACTION,
  SKILLS_RUNTIME_EXECUTOR,
  SKILLS_RUNTIME_STEP_ID,
  SKILLS_RUNTIME_OUTCOME_CODE
} from '../utils/runtimeActionProtocol.js';
import { RunStateMachine } from './runtime/RunStateMachine.js';
import type { ChatMessage } from '../src/types.js';
import { buildGroupScopeId, buildPrivateScopeId, isGroupScopeId } from '../utils/conversationId.js';

type RagChunk = { rawText?: string; text?: string;[key: string]: unknown };
type RagContextResult = { chunks?: RagChunk[]; contextText?: string; stats?: Record<string, unknown> | null };
type RagSdk = {
  getContextHybrid: (query: string) => Promise<RagContextResult>;
  getContextFromFulltext: (query: string, opts?: { limit?: number; expandParent?: boolean }) => Promise<RagContextResult>;
};
type RagRuntimeConfig = {
  timeoutMs: number;
  cacheTtlMs: number;
  keywordTopN: number;
  keywordFulltextLimit: number;
  maxContextCharsPerItem: number;
  maxContextItems: number;
};

const ragSdkCreator: (opts: { watchEnv?: boolean }) => Promise<RagSdk> =
  createRagSdk as (opts: { watchEnv?: boolean }) => Promise<RagSdk>;
const ragRuntimeConfig: () => RagRuntimeConfig =
  getRagRuntimeConfig as () => RagRuntimeConfig;

type PlanStep = {
  aiName?: string;
  displayIndex?: number | string;
  title?: string;
  summary?: string;
  task?: string;
  goal?: string;
  description?: string;
  objective?: string;
};
type Plan = { steps?: PlanStep[] };

type MsgLike = UserQuestionMessage & {
  summary?: string;
  summary_text?: string;
  summary_xml?: string;
  objective?: string;
  objective_text?: string;
  objective_xml?: string;
  _merged?: boolean;
  _mergedUsers?: MergedUser[];
  _proactive?: boolean;
  _proactiveFirst?: boolean;
  _sentraRootDirectiveXml?: string;
  _replyAction?: 'silent' | 'action' | 'short' | 'delay' | string;
  _delayPlan?: {
    whenText?: string;
    fireAt?: number;
    delayMs?: number;
    targetISO?: string;
    timezone?: string;
    parserMethod?: string;
  } | null;
  _delayReplay?: DelayReplayPayload | null;
  _runtimeResume?: {
    fromCheckpoint?: boolean;
    runId?: string;
    conversationId?: string;
    status?: string;
    stage?: string;
    reasonCode?: string;
    updatedAt?: number;
    objective?: string;
    lastCompletedStepIndex?: number;
    totalSteps?: number;
    [key: string]: unknown;
  } | null;
  _taskIdOverride?: string | null;
  _taskRecoveryAttempt?: number;
  _taskRecoverySkipAnalysis?: boolean;
};

type RagCacheEntry = { at: number; block: string };
type RerankStats = Record<string, unknown>;

type LoggerLike = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
};

type ConversationHistoryOptions = {
  recentPairs?: number;
  maxTokens?: number;
  senderId?: string | null;
  timeStart?: number;
  timeEnd?: number;
};

type StartAssistantMessageOptions = {
  scopeSenderId?: string | null;
  commitMode?: string | null;
  userId?: string | null;
  pairId?: string | null;
};

type HistoryManagerLike = {
  getPendingMessagesContext: (groupId: string, senderId?: string | null) => string;
  startProcessingMessages: (groupId: string, senderId: string) => Promise<void>;
  getPendingMessagesBySender: (groupId: string, senderId: string) => MsgLike[];
  maxConversationPairs?: number;
  getConversationHistoryForContext: (groupId: string, options?: ConversationHistoryOptions) => ChatMessage[];
  startAssistantMessage: (groupId: string, options?: StartAssistantMessageOptions | null) => Promise<string | number>;
  appendToAssistantMessage: (groupId: string, content: string, pairId: string | number | null) => Promise<void>;
  replaceAssistantMessage: (groupId: string, content: string, pairId: string | number | null) => Promise<void>;
  appendToConversationPairMessages: (groupId: string, pairId: string | number, role: string, content: string) => Promise<void>;
  finishConversationPair: (groupId: string, pairId: string | number, userContent: string | null) => Promise<unknown>;
  cancelConversationPairById: (groupId: string, pairId: string | number) => Promise<void>;
  promoteScopedConversationsToShared: (groupId: string, senderId: string) => Promise<void>;
  clearScopedConversationsForSender: (groupId: string, senderId: string) => Promise<void>;
  getLastAssistantMessageContent: (groupId: string) => string | null;
};

type ParsedTimeResult = {
  success: boolean;
  windowTimestamps?: { start: number; end: number };
  windowFormatted?: { start?: string; end?: string };
};

type TimeParserLike = {
  containsTimeExpression: (text: string, opts?: { language?: string }) => boolean;
  parseTimeExpression: (text: string, opts?: Record<string, unknown>) => ParsedTimeResult | null;
};

type ToolInvocation = { aiName: string; args?: Record<string, ParamValue> };
type ToolResultEvent = {
  type?: string;
  aiName?: string;
  runtimeControl?: string;
  plannedStepIndex?: number;
  stepIndex?: number;
  executionIndex?: number;
  result?: Record<string, unknown>;
  [key: string]: unknown;
};

type StreamEvent = ToolResultEvent & {
  runId?: string;
  round?: number;
  summary?: string;
  plan?: Plan;
  objective?: string;
  toolsXml?: string;
  resultStream?: string;
  resultStatus?: string;
  events?: ToolResultEvent[];
  exec?: Record<string, unknown> | null;
  response?: string;
  noReply?: boolean;
  responses?: AssistantBridgeResponseItem[];
};

type ParamValue =
  | string
  | number
  | boolean
  | null
  | ParamValue[]
  | { [key: string]: ParamValue };

type AssistantBridgeResponseItem = {
  phase?: string;
  content?: string;
  noReply?: boolean;
  delivered?: boolean;
  ts?: number;
  meta?: Record<string, unknown>;
};

type AssistantBridgeBatch = {
  runId: string;
  responses?: AssistantBridgeResponseItem[];
  objective?: string;
  reason?: string;
  context?: Record<string, unknown>;
};

type CompletionAssistantResponseTraceItem = {
  runId: string;
  phase: string;
  content: string;
  noReply: boolean;
  delivered: boolean;
  ts: number;
  meta: Record<string, unknown>;
};

type RuntimeProtocolPersistPayload = {
  op: 'start' | 'checkpoint' | 'final';
  runId: string;
  objective?: string;
  context?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  event?: Record<string, unknown>;
  status?: string;
  reasonCode?: string;
  source?: string;
  note?: string;
};

type ChatWithRetryResult = {
  success: boolean;
  response?: string | null;
  noReply?: boolean;
  reason?: string;
  retries?: number;
  toolsOnly?: boolean;
  rawToolsXml?: string;
};
type ChatWithRetryFn = (
  conversations: ChatMessage[],
  options: { model?: string; __sentraExpectedOutput?: string },
  groupId: string
) => Promise<ChatWithRetryResult>;

type SendAndWaitFn = (payload: Record<string, unknown>) => Promise<unknown>;

type SmartSendFn = (
  msg: MsgLike,
  response: string,
  sendAndWaitResult: SendAndWaitFn,
  allowReply: boolean,
  options?: { hasTool?: boolean; immediate?: boolean }
) => Promise<unknown>;

type StreamToolsXmlParams = {
  toolsXml: string;
  objective?: string;
  conversation?: { role: string; content: unknown }[];
  context?: Record<string, unknown>;
  overlays?: Record<string, unknown>;
  promptOverlays?: Record<string, unknown>;
  channelId?: string;
  identityKey?: string;
};

type SdkLike = {
  callTool?: (params: { aiName: string; args?: Record<string, unknown>; context?: Record<string, unknown> }) => Promise<unknown>;
  dispatchAction?: (params: {
    request?: Record<string, unknown>;
    context?: Record<string, unknown>;
    executionOptions?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  streamToolsXml?: (params: StreamToolsXmlParams) => AsyncIterable<StreamEvent>;
  stream: (params: Record<string, unknown>) => AsyncIterable<StreamEvent>;
  cancelRun?: (runId: string, meta?: Record<string, unknown>) => void;
  reportAssistantResponsesBatch?: (params: AssistantBridgeBatch) => Promise<unknown>;
  reportFeedbackFlushDone?: (params: {
    runId: string;
    round?: number;
    reason?: string;
    flushedCount?: number;
    context?: Record<string, unknown>;
  }) => Promise<unknown>;
  sendAndWaitResult?: SendAndWaitFn;
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
};

type ReplyDecision = {
  needReply: boolean;
  taskId?: string | null;
  action?: 'silent' | 'action' | 'short' | 'delay' | string;
  delay?: {
    whenText?: string;
    fireAt?: number;
    delayMs?: number;
    targetISO?: string;
    timezone?: string;
    parserMethod?: string;
  } | null;
  reason?: string;
  reason_code?: string;
};

type MessagePipelineContext = {
  logger: LoggerLike;
  historyManager: HistoryManagerLike;
  timeParser: TimeParserLike;
  MCP_MAX_CONTEXT_PAIRS?: number;
  CONTEXT_MEMORY_ENABLED?: boolean | (() => boolean);
  getDailyContextMemoryXml: (groupId: string) => Promise<string>;
  personaManager?: { formatPersonaForContext: (senderId: string) => string };
  emo?: { userAnalytics: (senderId: string, options?: Record<string, unknown>) => Promise<unknown> };
  buildSentraEmoSection: (data: unknown) => string;
  WORLDBOOK_XML?: string;
  AGENT_PRESET_XML?: string;
  AGENT_PRESET_PLAIN_TEXT?: string;
  AGENT_PRESET_RAW_TEXT?: string;
  baseSystem: string | ((requiredOutput: string, runtimeOptions?: Record<string, unknown>) => Promise<unknown> | unknown);
  convertHistoryToMCPFormat: (history: ChatMessage[], options?: Record<string, unknown>) => ChatMessage[];
  buildSentraInputBlock: (params: {
    currentMessage?: MsgLike | null;
    pendingMessages?: MsgLike[];
    historyMessages?: MsgLike[];
    toolResults?: Record<string, unknown>[];
  }) => string;
  buildSentraResultBlock: (ev: Record<string, unknown>) => string;
  smartSend: SmartSendFn;
  sdk: SdkLike;
  trackRunForSender: (userId: string, groupId: string, runId: string) => void;
  untrackRunForSender: (userId: string, groupId: string, runId: string) => void;
  chatWithRetry: ChatWithRetryFn;
  MAIN_AI_MODEL?: string;
  triggerContextSummarizationIfNeeded: (payload: { groupId: string; chatType: string; userId: string }) => Promise<unknown>;
  triggerPresetTeachingIfNeeded: (payload: {
    groupId: string;
    chatType: string;
    userId: string;
    userContent: string;
    assistantContent: string;
  }) => Promise<unknown>;
  completeTask: (conversationId: string, taskId: string) => Promise<{ id?: string; msg?: MsgLike; conversationId?: string } | null | undefined>;
  startBundleForQueuedMessage: (conversationId: string, msg: MsgLike) => void;
  collectBundleForSender: (conversationId: string) => Promise<MsgLike | null>;
  drainPendingMessagesForSender: (conversationId: string) => MsgLike | null;
  shouldReply: (msg: MsgLike, meta?: Record<string, unknown>) => Promise<ReplyDecision>;
  sendAndWaitResult: SendAndWaitFn;
  randomUUID: () => string;
  saveMessageCache: (runId: string, payload: Record<string, unknown>) => Promise<unknown>;
  enqueueDelayedJob: (job: Record<string, unknown>) => Promise<unknown>;
  desireManager?: { onBotMessage: (msg: MsgLike, options?: Record<string, unknown>) => Promise<void> };
  socialContextManager?: { getXml: () => Promise<string> };
  agent: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  persistRuntimeProtocolState?: (payload: RuntimeProtocolPersistPayload) => Promise<unknown>;
  loadRuntimeRunCheckpointSnapshot?: (args?: { runId?: string }) => Promise<Record<string, unknown> | null>;
};

const swallowOnceStateByConversation = new Map<string, { used: boolean; lastUpdatedAt: number }>();

const ragCacheByConversation = new Map<string, RagCacheEntry>();

const toolPreReplyLastSentAtByUser = new Map<string, number>();

const PIPELINE_RESPONSE_PHASE = Object.freeze({
  delayAck: 'delay_ack',
  delayDeferredJudge: 'delay_deferred_judge',
  judge: 'judge',
  toolPreReply: 'tool_pre_reply',
  toolProgress: 'tool_progress',
  toolFinal: 'tool_final'
} as const);

const PIPELINE_RESPONSE_STAGE = Object.freeze({
  delayPreReply: 'delay_pre_reply',
  delayQueue: 'delay_queue',
  judgeNoTools: 'judge_no_tools',
  toolPreReply: 'tool_pre_reply',
  toolResultStream: 'tool_result_stream',
  completed: 'completed'
} as const);

const MCP_RUNTIME_CONTROL_REASON = Object.freeze({
  delayActionExecuteOnce: 'delay_action_execute_once'
} as const);

const MCP_RESTART_REASON = Object.freeze({
  toolsOnlyRestart: 'tools_only_restart',
  toolProgressToolsOnlyRestart: 'tool_progress_tools_only_restart'
} as const);

const ASSISTANT_BRIDGE_FLUSH_REASON = Object.freeze({
  realtimeDelivery: 'realtime_delivery',
  restartForToolsXml: 'restart_for_tools_xml',
  delayQueuedJudgeNoTools: 'delay_queued_judge_no_tools',
  judgeNoToolsDone: 'judge_no_tools_done',
  feedbackWait: 'feedback_wait',
  delayQueuedCompleted: 'delay_queued_completed',
  completedWithRealtimeFeedback: 'completed_with_realtime_feedback',
  completedDone: 'completed_done',
  pipelineFinally: 'pipeline_finally',
  pipelineFinallyScheduled: 'pipeline_finally_scheduled'
} as const);

const ORCHESTRATOR_RUNTIME_OUTCOME_CODE = Object.freeze({
  completed: 'orchestrator_round_completed',
  deferred: 'orchestrator_round_deferred',
  childFailed: 'orchestrator_child_failed',
  exception: 'orchestrator_round_exception'
} as const);

const SKILLS_PROTOCOL_STAGE = Object.freeze({
  stream: 'skills_protocol_stream',
  final: 'skills_protocol_final',
  exception: 'skills_protocol_exception'
} as const);

const SKILLS_PROTOCOL_REASON = Object.freeze({
  roundIncomplete: 'skills_round_incomplete',
  roundException: 'skills_round_exception',
  dispatchFailed: 'skills_dispatch_failed',
  replyDeferred: 'skills_reply_deferred',
  replyEmpty: 'skills_reply_empty',
  replyNoReply: 'skills_reply_no_reply',
  replyCompleted: 'skills_reply_completed',
  escalatedToTools: 'skills_escalated_to_tools',
  judgeFailed: 'skills_judge_failed'
} as const);

let ragSdkPromise: Promise<RagSdk> | null = null;
async function getRagSdk(): Promise<RagSdk> {
  if (!ragSdkPromise) {
    ragSdkPromise = ragSdkCreator({ watchEnv: false }).catch((e) => {
      ragSdkPromise = null;
      throw e;
    });
  }
  return ragSdkPromise;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race<T>([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('RAG_TIMEOUT')), ms);
    })
  ]);
}

function getToolPreReplyRuntimeConfig(): { enabled: boolean | undefined; cooldownMs: number | undefined } {
  return {
    enabled: getEnvBool('ENABLE_TOOL_PREREPLY', true),
    cooldownMs: getEnvInt('TOOL_PREREPLY_COOLDOWN_MS', 60000)
  };
}

function extractToolNamesFromPlan(plan: Plan | null | undefined): string[] {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const name = typeof step?.aiName === 'string' ? step.aiName.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function buildPlanSummary(plan: Plan | null | undefined, limit = 6): string {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return '';
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(limit, steps.length) : steps.length;
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const step = steps[i] || {};
    const idx = Number.isFinite(Number(step.displayIndex)) ? Number(step.displayIndex) : (i + 1);
    const text =
      (typeof step.title === 'string' && step.title.trim()) ||
      (typeof step.summary === 'string' && step.summary.trim()) ||
      (typeof step.task === 'string' && step.task.trim()) ||
      (typeof step.goal === 'string' && step.goal.trim()) ||
      (typeof step.description === 'string' && step.description.trim()) ||
      (typeof step.objective === 'string' && step.objective.trim()) ||
      '';
    if (!text) continue;
    lines.push(`${idx}. ${text}`);
  }
  return lines.join('\n');
}

function normalizeRagQueryText(text: unknown): string {
  const s = String(text || '').trim();
  if (!s) return '';
  const merged = s
    .split('\n')
    .map((line) => String(line || '').replace(/^\[[^\]]{1,30}\]\s*/g, '').trim())
    .filter(Boolean)
    .join('\n');
  if (merged.length <= 2000) return merged;
  return merged.substring(0, 2000);
}

function extractTextFromMessageLike(msg: unknown): string {
  const m = (msg && typeof msg === 'object') ? (msg as Record<string, unknown>) : {};
  const segsRaw = Array.isArray(m.message)
    ? m.message
    : (Array.isArray(m.segments) ? m.segments : []);
  const segTexts: string[] = [];
  for (const seg of segsRaw) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type.trim().toLowerCase() : '';
    if (type !== 'text') continue;
    const data = (s.data && typeof s.data === 'object') ? (s.data as Record<string, unknown>) : {};
    const t = typeof data.text === 'string' ? data.text.trim() : '';
    if (!t) continue;
    segTexts.push(t);
  }
  const segText = segTexts.join('\n').trim();

  const fromXml = (xmlLike: string): string => {
    const s = String(xmlLike || '').trim();
    if (!s || !s.startsWith('<')) return '';
    const textMatches = collectXmlTagTextValues(s, ['text']);
    if (textMatches.length > 0) return textMatches.join('\n').trim();
    const preview = collectXmlTagTextValues(s, ['preview_text']);
    if (preview.length > 0) return preview[0] || '';
    return '';
  };

  const fallbackCandidates = [
    m.objective_text,
    m.summary_text,
    m.objective,
    m.summary,
    m.text
  ];
  for (const candidate of fallbackCandidates) {
    if (typeof candidate !== 'string') continue;
    const t = candidate.trim();
    if (!t) continue;
    if (t.startsWith('<')) {
      const extracted = fromXml(t);
      if (extracted) return extracted;
      continue;
    }
    return t;
  }
  return segText;
}

function extractStructuredObjectiveXmlFromMessageLike(msg: unknown): string {
  const m = (msg && typeof msg === 'object') ? (msg as Record<string, unknown>) : {};
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

function extractRagKeywords(text: unknown, limit: number | string | null | undefined): string[] {
  const n = Number(limit);
  const max = Number.isFinite(n) && n > 0 ? n : 0;
  if (max <= 0) return [];
  try {
    const raw = textSegmentation.segment(String(text || ''), { useSegmentation: true });
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of raw) {
      const t = String(token || '').trim();
      if (!t) continue;
      if (t.length <= 1) continue;
      if (!/[a-zA-Z0-9\u4e00-\u9fff]/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

function escapeXmlText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function summarizeStreamEventForLog(ev: StreamEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src: Record<string, unknown> = (ev && typeof ev === 'object') ? ev as Record<string, unknown> : {};

  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) return;
    out[key] = value;
  };

  put('type', String(src.type || '').trim() || 'unknown');
  put('runId', String(src.runId || '').trim());
  put('reason', String(src.reason || '').trim());
  put('round', Number.isFinite(Number(src.round)) ? Number(src.round) : undefined);
  put('interrupted', typeof src.interrupted === 'boolean' ? src.interrupted : undefined);
  put('flushAcked', typeof src.flushAcked === 'boolean' ? src.flushAcked : undefined);
  put('batchCount', Number.isFinite(Number(src.batchCount)) ? Number(src.batchCount) : undefined);
  put('responseCount', Number.isFinite(Number(src.responseCount)) ? Number(src.responseCount) : undefined);
  put('waitMode', String(src.waitMode || '').trim());
  put('sinceTs', Number.isFinite(Number(src.sinceTs)) ? Number(src.sinceTs) : undefined);
  put('resultStatus', String(src.resultStatus || '').trim());
  put('summary', typeof src.summary === 'string' ? src.summary : undefined);
  put('objective', typeof src.objective === 'string' ? src.objective : undefined);
  put('response', typeof src.response === 'string' ? src.response : undefined);
  put('resultStream', typeof src.resultStream === 'string' ? src.resultStream : undefined);
  put('toolsXml', typeof src.toolsXml === 'string' ? src.toolsXml : undefined);

  const events = Array.isArray(src.events) ? src.events : [];
  if (events.length > 0) {
    put('eventsCount', events.length);
    for (let i = 0; i < events.length; i++) {
      const item = (events[i] && typeof events[i] === 'object') ? events[i] as Record<string, unknown> : {};
      const prefix = `event${i + 1}`;
      put(`${prefix}.type`, String(item.type || '').trim() || 'unknown');
      put(`${prefix}.aiName`, String(item.aiName || '').trim());
      put(`${prefix}.runtimeControl`, String(item.runtimeControl || '').trim());
      put(`${prefix}.plannedStepIndex`, Number.isFinite(Number(item.plannedStepIndex)) ? Number(item.plannedStepIndex) : undefined);
      put(`${prefix}.stepIndex`, Number.isFinite(Number(item.stepIndex)) ? Number(item.stepIndex) : undefined);
      put(`${prefix}.executionIndex`, Number.isFinite(Number(item.executionIndex)) ? Number(item.executionIndex) : undefined);
    }
  }

  const responses = Array.isArray(src.responses) ? src.responses : [];
  if (responses.length > 0) {
    put('responsesCount', responses.length);
    for (let i = 0; i < responses.length; i++) {
      const item = (responses[i] && typeof responses[i] === 'object') ? responses[i] as Record<string, unknown> : {};
      const prefix = `response${i + 1}`;
      put(`${prefix}.index`, Number.isFinite(Number(item.index)) ? Number(item.index) : i + 1);
      put(`${prefix}.phase`, String(item.phase || '').trim() || 'unknown');
      put(`${prefix}.contentOmitted`, true);
      put(`${prefix}.contentLength`, Number.isFinite(Number(item.contentLength)) ? Number(item.contentLength) : undefined);
      put(`${prefix}.noReply`, item.noReply === true);
      put(`${prefix}.delivered`, item.delivered === true);
      put(`${prefix}.ts`, Number.isFinite(Number(item.ts)) ? Number(item.ts) : undefined);
      if (item.meta && typeof item.meta === 'object') {
        try {
          put(`${prefix}.metaJson`, JSON.stringify(item.meta));
        } catch {
          put(`${prefix}.metaJson`, String(item.meta));
        }
      }
    }
  }

  const context = (src.context && typeof src.context === 'object') ? src.context as Record<string, unknown> : null;
  if (context) {
    put('context.channelId', String(context.channelId || '').trim());
    put('context.groupId', String(context.groupId || '').trim());
    put('context.userId', String(context.userId || '').trim());
    put('context.feedbackRound', Number.isFinite(Number(context.feedbackRound)) ? Number(context.feedbackRound) : undefined);
  }

  return out;
}

function buildRagSystemBlock({
  queryText,
  contextText,
  chunks,
  stats,
  maxCharsPerItem,
  maxItems
}: {
  queryText?: string;
  contextText?: string;
  chunks?: RagChunk[];
  stats?: RerankStats | null;
  maxCharsPerItem?: number;
  maxItems?: number;
}): string {
  const q = String(queryText || '').trim();
  const ctx = String(contextText || '').trim();
  const items = Array.isArray(chunks) ? chunks : [];
  if (!q || (!ctx && items.length === 0)) return '';

  const perItemLimitRaw = Number(maxCharsPerItem);
  const perItemLimit = Number.isFinite(perItemLimitRaw) ? perItemLimitRaw : -1;
  const maxItemsRaw = Number(maxItems);
  const maxItemsLimit = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? Math.floor(maxItemsRaw) : 0;

  const clipped = (() => {
    if (items.length > 0) {
      const out: string[] = [];
      let used = 0;
      for (const c of items) {
        if (maxItemsLimit > 0 && used >= maxItemsLimit) break;
        let piece = String(c?.rawText || c?.text || '').trim();
        if (!piece) continue;
        if (perItemLimit > 0 && piece.length > perItemLimit) {
          piece = piece.substring(0, perItemLimit);
        }
        out.push(piece);
        used += 1;
      }
      return out.join('\n\n').trim();
    }
    return ctx;
  })();
  const s = stats && typeof stats === 'object' ? stats : null;
  const statsLine = s
    ? (() => {
      try {
        const compact = {
          vectorHits: s.vectorHits,
          fulltextHits: s.fulltextHits,
          parentExpanded: s.parentExpanded,
          mergedContextChunks: s.mergedContextChunks,
          contextChars: s.contextChars,
          rerankMode: s.rerankMode
        };
        return JSON.stringify(compact);
      } catch {
        return '';
      }
    })()
    : '';

  const rules = [
    'The following evidence is system-injected RAG context.',
    'Use it only to improve accuracy; do not quote it verbatim or expose retrieval details.',
    'Do not invent facts beyond the evidence; if unsure, say so and ask for clarification.'
  ];

  return [
    '<sentra-rag-context>',
    `  <query>${escapeXmlText(q.length > 240 ? q.substring(0, 240) : q)}</query>`,
    (statsLine ? `  <stats_json>${escapeXmlText(statsLine)}</stats_json>` : ''),
    '  <rules>',
    ...rules.map((r) => `    <rule>${escapeXmlText(r)}</rule>`),
    '  </rules>',
    '  <evidence>',
    `${escapeXmlText(clipped)}`,
    '  </evidence>',
    '</sentra-rag-context>'
  ].filter((x) => x !== '').join('\n');
}

const MEMORY_PACK_MAX_ITEMS = 4;
const MEMORY_PACK_SUMMARY_MAX_CHARS = 260;
const MEMORY_PACK_EVENT_MAX_ITEMS = 2;
const MEMORY_PACK_EVENT_MAX_CHARS = 180;
const MEMORY_PACK_KEYWORD_MAX_ITEMS = 8;
const MEMORY_PACK_KEYWORD_MAX_CHARS = 48;

function clipMemoryText(raw: unknown, maxChars: number): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function buildSentraMemoryPackXml(memoryXml: unknown, groupId: string): string {
  const full = extractFullXMLTag(String(memoryXml ?? ''), 'sentra-memory') || String(memoryXml ?? '').trim();
  if (!full || !full.includes('<sentra-memory')) return '';

  const date = clipMemoryText(extractXMLTag(full, 'date'), 40);
  const itemXmlList = extractAllFullXMLTags(full, 'item').slice(0, MEMORY_PACK_MAX_ITEMS);
  if (itemXmlList.length === 0) return '';

  const lines: string[] = [];
  lines.push('<sentra-memory-pack>');
  lines.push('  <kind>runtime_memory_digest</kind>');
  lines.push('  <readonly>true</readonly>');
  lines.push('  <source>daily_context_memory</source>');
  if (groupId) lines.push(`  <group_id>${escapeXml(groupId)}</group_id>`);
  if (date) lines.push(`  <date>${escapeXml(date)}</date>`);
  lines.push('  <usage>');
  lines.push('    <rule>This block is synthetic background memory, not a user request.</rule>');
  lines.push('    <rule>Do not reply to this block directly.</rule>');
  lines.push('    <rule>If conflict exists, prefer current sentra-input/current_messages.</rule>');
  lines.push('  </usage>');
  lines.push('  <items>');

  for (let i = 0; i < itemXmlList.length; i++) {
    const itemXml = itemXmlList[i] || '';
    const summary = clipMemoryText(extractXMLTag(itemXml, 'summary'), MEMORY_PACK_SUMMARY_MAX_CHARS);
    if (!summary) continue;
    const timeRange = clipMemoryText(extractXMLTag(itemXml, 'time_range'), 80);
    const keywords = collectXmlTagTextValues(itemXml, ['keyword'])
      .map((x) => clipMemoryText(x, MEMORY_PACK_KEYWORD_MAX_CHARS))
      .filter(Boolean)
      .slice(0, MEMORY_PACK_KEYWORD_MAX_ITEMS);
    const events = collectXmlTagTextValues(itemXml, ['event'])
      .map((x) => clipMemoryText(x, MEMORY_PACK_EVENT_MAX_CHARS))
      .filter(Boolean)
      .slice(0, MEMORY_PACK_EVENT_MAX_ITEMS);
    const artifactCount = (String(itemXml).match(/<artifact\b/gi) || []).length;

    lines.push(`    <item index="${i + 1}">`);
    if (timeRange) lines.push(`      <time_range>${escapeXml(timeRange)}</time_range>`);
    lines.push(`      <summary>${escapeXml(summary)}</summary>`);
    if (keywords.length > 0) {
      lines.push('      <keywords>');
      for (const kw of keywords) {
        lines.push(`        <keyword>${escapeXml(kw)}</keyword>`);
      }
      lines.push('      </keywords>');
    }
    if (events.length > 0) {
      lines.push('      <event_board>');
      for (const ev of events) {
        lines.push(`        <event>${escapeXml(ev)}</event>`);
      }
      lines.push('      </event_board>');
    }
    if (artifactCount > 0) {
      lines.push(`      <artifact_count>${artifactCount}</artifact_count>`);
    }
    lines.push('    </item>');
  }

  lines.push('  </items>');
  lines.push('</sentra-memory-pack>');
  return lines.join('\n');
}

function tryEnqueueRagIngestAfterSave({
  logger,
  conversationId,
  groupId,
  userid,
  userObjective,
  msg,
  response
}: {
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  conversationId?: string;
  groupId?: string;
  userid?: string;
  userObjective?: string | null;
  msg?: MsgLike;
  response?: string;
} = {}) {
  if (!getEnvBool('ENABLE_RAG', true)) return;
  try {
    logger?.info('RAG: post-save hook reached', { conversationId, groupId });
    logger?.info('RAG: preparing ingest payload', { conversationId });

    let assistantText = '';
    try {
      const parsed = parseSentraMessage(response);
      const segs = parsed && Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
      assistantText = segs.join('\n\n').trim();
    } catch { }

    if (!assistantText) {
      assistantText = String(response || '').trim();
    }

    const userText = String(
      userObjective ||
      extractTextFromMessageLike(msg) ||
      msg?.text ||
      msg?.summary ||
      ''
    ).trim();
    if (userText && assistantText) {
      const contextText = [
        'CHAT INGEST GRAPH GUIDANCE (STRICT):',
        '- You are extracting a knowledge graph from a chat turn.',
        '- Do NOT create entities for role labels like "USER", "ASSISTANT", "SYSTEM", "BOT".',
        '- Prefer real-world entities: people, accounts, apps, packages, versions, files, errors, URLs, orgs, concepts.',
        '- Relations MUST be specific predicates (avoid generic RELATED). Examples: "asks_about", "mentions", "uses", "depends_on", "causes_error", "version_of".',
        '- IMPORTANT: Use a stable canonical_name so entities can MERGE across turns/documents:',
        '  - For packages/libs/tools: use lowercase, strip versions (e.g. "react@18" -> "react").',
        '  - For files/paths: normalize slashes to "/" and prefer repo-relative paths when possible.',
        '  - For errors: keep the canonical error code/name stable (e.g. "FST_ERR_CTP_EMPTY_JSON_BODY").',
        '- Every entity/relation should include evidence (segment_id + quote) whenever possible.',
        '- If the only possible entities are role labels, output zero entities/relations.',
      ].join('\n');

      const docId = `chat_${conversationId}_${Date.now()}`;
      const title = userText.length > 60 ? userText.substring(0, 60) : userText;
      const source = `sentra_chat:${groupId}`;
      const userIdForMemory = userid || '';
      const text = [
        `conversationId: ${conversationId}`,
        `groupId: ${groupId}`,
        `userId: ${userIdForMemory}`,
        `ts: ${Date.now()}`,
        '',
        'USER:',
        userText,
        '',
        'ASSISTANT:',
        assistantText
      ].join('\n');

      logger?.info('RAG: enqueue ingest (before)', { docId, conversationId });
      enqueueRagIngest({ text, docId, title, source, contextText });
      logger?.info('RAG: ingest task enqueued', { docId, conversationId });
      return;
    }

    logger?.info('RAG: skip ingest because userText/assistantText is empty', {
      conversationId,
      hasUserText: !!userText,
      hasAssistantText: !!assistantText
    });
  } catch (e) {
    logger?.warn('RAG: enqueue ingest failed (ignored)', { err: String(e) });
  }
}

function ensureSentraMessageHasTarget(raw: unknown, msg: MsgLike | null | undefined): string {
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!s) return s;
  if (!s.startsWith('<sentra-message>')) return s;
  if (!s.endsWith('</sentra-message>')) return s;

  const parsed = parseSentraMessage(s);
  const declaredChatType = typeof parsed?.chat_type === 'string'
    ? parsed.chat_type.trim().toLowerCase()
    : '';
  const hasGroup = typeof parsed?.group_id === 'string' && /^\d+$/.test(parsed.group_id.trim());
  const hasUser = typeof parsed?.user_id === 'string' && /^\d+$/.test(parsed.user_id.trim());

  const hasValidDeclaredTarget =
    (declaredChatType === 'group' && hasGroup && !hasUser) ||
    (declaredChatType === 'private' && hasUser && !hasGroup);
  if (hasValidDeclaredTarget) {
    return s;
  }

  const msgType = msg?.type === 'group' ? 'group' : (msg?.type === 'private' ? 'private' : '');
  const currentTag = msgType === 'group' ? 'group_id' : (msgType === 'private' ? 'user_id' : '');
  const currentId = msgType === 'group'
    ? String(msg?.group_id ?? '').trim()
    : String(msg?.sender_id ?? '').trim();

  if (!currentTag || !currentId || !/^\d+$/.test(currentId)) {
    return s;
  }

  return buildSentraMessageBlock({
    chat_type: msgType,
    ...(msgType === 'group' ? { group_id: currentId } : { user_id: currentId }),
    ...(parsed?.sender_id ? { sender_id: parsed.sender_id } : {}),
    ...(parsed?.sender_name ? { sender_name: parsed.sender_name } : {}),
    ...(parsed?.message_id ? { message_id: parsed.message_id } : {}),
    message: Array.isArray(parsed?.message) ? parsed.message : []
  });
}

function getSwallowOnSupplementRuntimeConfig(): { enabled: boolean; maxWaitMs: number } {
  const enabled = getEnvBool('SWALLOW_ON_SUPPLEMENT_ENABLED', true);
  const maxWaitMs = getEnvInt('SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS', 0);
  const maxWait = typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs) ? maxWaitMs : 0;
  return {
    enabled: !!enabled,
    maxWaitMs: maxWait
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 补充消息单次吞吐策略（按会话维度）：
 * 1. 同一会话在两次真实发送之间，若检测到补充消息，允许吞掉一次已生成回复。
 * 2. 吞掉时只跳过外发（不调用 smartSend），但保留内部对话记录。
 * 3. 一旦有一次真实发送成功，重置该会话的吞吐状态。
 * 4. 由 SWALLOW_ON_SUPPLEMENT_ENABLED / SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS 控制。
 */
function shouldSwallowReplyForConversation(conversationId: string, hasSupplementDuringTask: boolean): boolean {
  const cfg = getSwallowOnSupplementRuntimeConfig();
  if (!cfg.enabled || !conversationId || !hasSupplementDuringTask) return false;

  const existing = swallowOnceStateByConversation.get(conversationId);
  if (existing && existing.used) {
    return false;
  }

  swallowOnceStateByConversation.set(conversationId, {
    used: true,
    lastUpdatedAt: Date.now()
  });
  return true;
}

function markReplySentForConversation(conversationId: string) {
  if (!conversationId) return;
  swallowOnceStateByConversation.delete(conversationId);
}

function normalizeAssistantContentForHistory(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!s) return '<sentra-message></sentra-message>';
  try {
    const toolsOnly = typeof s === 'string' && s.startsWith('<sentra-tools>') && s.endsWith('</sentra-tools>') && !s.includes('<sentra-message>');
    if (toolsOnly) return s;
  } catch { }
  try {
    const parsed = parseSentraMessage(s);
    if (parsed && parsed.shouldSkip) {
      return '<sentra-message></sentra-message>';
    }
    return s;
  } catch {
    return '<sentra-message></sentra-message>';
  }
}

function extractDeliveredSegmentMessageIdsFromSendResult(
  sendResult: unknown
): Array<{ segmentIndex: number; messageId: string }> {
  if (!sendResult || typeof sendResult !== 'object') return [];
  const root = sendResult as Record<string, unknown>;
  const meta = root.__sentraDeliveryMeta;
  if (!meta || typeof meta !== 'object') return [];
  const arr = (meta as Record<string, unknown>).segmentMessageIds;
  if (!Array.isArray(arr)) return [];
  const out: Array<{ segmentIndex: number; messageId: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    const idxRaw = Number(src.segmentIndex);
    if (!Number.isFinite(idxRaw) || idxRaw <= 0) continue;
    const messageId = String(src.messageId ?? '').trim();
    if (!messageId || messageId === '0') continue;
    out.push({ segmentIndex: Math.floor(idxRaw), messageId });
  }
  return out;
}

function extractDeliveredMessageIdFromSendResult(sendResult: unknown): string {
  if (!sendResult || typeof sendResult !== 'object') return '';

  const segmentMapped = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
  if (segmentMapped.length > 0) {
    const first = segmentMapped
      .slice()
      .sort((a, b) => a.segmentIndex - b.segmentIndex)[0];
    if (first && first.messageId) return first.messageId;
  }

  const data = (sendResult as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return '';

  const asObj = data as Record<string, unknown>;
  const pick = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s || s === '0') return '';
    return s;
  };

  const direct = pick(asObj.message_id);
  if (direct) return direct;

  const nested = asObj.data && typeof asObj.data === 'object'
    ? (asObj.data as Record<string, unknown>)
    : null;
  if (nested) {
    const nestedId = pick(nested.message_id);
    if (nestedId) return nestedId;
  }
  return '';
}

function normalizeResourceKeys(resources: unknown[]): string[] {
  if (!Array.isArray(resources) || resources.length === 0) return [];
  const keys: string[] = [];
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const typeRaw = (r as { type?: unknown }).type;
    const sourceRaw = (r as { source?: unknown }).source;
    const type = typeof typeRaw === 'string' ? typeRaw.trim() : '';
    const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : '';
    if (!type || !source) continue;
    keys.push(`${type}::${source}`);
  }
  if (!keys.length) return [];
  // 去重后排序，保证集合比较稳定。
  return Array.from(new Set(keys)).sort();
}

function areResourceSetsEqual(aResources: unknown[], bResources: unknown[]): boolean {
  const a = normalizeResourceKeys(aResources);
  const b = normalizeResourceKeys(bResources);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildRewriteRootDirectiveXml(previousResponseXml: string, candidateResponseXml: string): string {
  const safePrev = (previousResponseXml || '').trim();
  const safeCand = (candidateResponseXml || '').trim();

  const wrapCdata = (text: string) => String(text || '').replace(/]]>/g, ']]]]><![CDATA[>');
  const prevBlock = safePrev ? wrapCdata(safePrev) : '';
  const candBlock = safeCand ? wrapCdata(safeCand) : '';

  return [
    '<sentra-root-directive>',
    '  <id>rewrite_response_v2</id>',
    '  <type>rewrite</type>',
    '  <scope>single_turn</scope>',
    '  <phase>ReplyRewrite</phase>',
    `  <objective>${tMessagePipeline('rewrite_root_objective')}</objective>`,
    '  <allow_tools>false</allow_tools>',
    '  <original_response><![CDATA[',
    prevBlock,
    '  ]]></original_response>',
    '  <candidate_response><![CDATA[',
    candBlock,
    '  ]]></candidate_response>',
    '  <constraints>',
    `    <item>${tMessagePipeline('rewrite_root_c1')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c2')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c3')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c4')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c5')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c6')}</item>`,
    `    <item>${tMessagePipeline('rewrite_root_c7')}</item>`,
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

function normalizeContentText(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : String(value ?? '').trim();
}

function pickSnapshotContent(primary: unknown, fallback: unknown = ''): string {
  const primaryText = normalizeContentText(primary);
  if (primaryText) return primaryText;
  return normalizeContentText(fallback);
}

function combineRootAndSnapshot(rootXml: unknown, snapshotBase: unknown): {
  apiContent: string;
  snapshotContent: string;
} {
  const root = normalizeContentText(rootXml);
  const snapshot = normalizeContentText(snapshotBase);
  if (!root) {
    return { apiContent: snapshot, snapshotContent: snapshot };
  }
  if (!snapshot) {
    return { apiContent: root, snapshotContent: '' };
  }
  return {
    apiContent: `${root}\n\n${snapshot}`,
    snapshotContent: snapshot
  };
}

function normalizeDelayReplayPayload(value: unknown): DelayReplayPayload | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const deferredRaw = Array.isArray(src.deferredToolResultEvents) ? src.deferredToolResultEvents : [];
  const deferredToolResultEvents: DelayReplayToolResultEvent[] = [];
  for (const item of deferredRaw) {
    if (!item || typeof item !== 'object') continue;
    const ev = item as Record<string, unknown>;
    const normalized: DelayReplayToolResultEvent = { ...ev };
    if (!normalized.type || typeof normalized.type !== 'string') {
      normalized.type = 'tool_result';
    }
    if (Array.isArray(ev.events)) {
      normalized.events = ev.events
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({ ...(x as Record<string, unknown>) }));
    }
    deferredToolResultEvents.push(normalized);
  }

  const out: DelayReplayPayload = {
    kind: typeof src.kind === 'string' ? src.kind : '',
    delaySessionId: typeof src.delaySessionId === 'string' ? src.delaySessionId : '',
    runId: typeof src.runId === 'string' ? src.runId : '',
    orchestratorRunId: typeof src.orchestratorRunId === 'string' ? src.orchestratorRunId : '',
    reason: typeof src.reason === 'string' ? src.reason : '',
    reasonCode: normalizeDelayReasonCode(
      typeof src.reasonCode === 'string' ? src.reasonCode : src.reason,
      DELAY_REASON_CODE.dueReplay
    ),
    reasonArgs: normalizeDelayReasonArgs(src.reasonArgs),
    hasTool: src.hasTool === true,
    delayWhenText: typeof src.delayWhenText === 'string' ? src.delayWhenText : '',
    delayTargetISO: typeof src.delayTargetISO === 'string' ? src.delayTargetISO : '',
    deferredResponseXml: typeof src.deferredResponseXml === 'string' ? src.deferredResponseXml : '',
    deferredToolResultEvents
  };
  if (src.replayCursor && typeof src.replayCursor === 'object' && !Array.isArray(src.replayCursor)) {
    const cur = src.replayCursor as Record<string, unknown>;
    out.replayCursor = {
      nextOffset: Number.isFinite(Number(cur.nextOffset)) ? Math.max(0, Math.trunc(Number(cur.nextOffset))) : 0,
      totalEvents: Number.isFinite(Number(cur.totalEvents))
        ? Math.max(0, Math.trunc(Number(cur.totalEvents)))
        : deferredToolResultEvents.length,
      status: typeof cur.status === 'string' ? cur.status : '',
      updatedAt: Number.isFinite(Number(cur.updatedAt)) ? Math.trunc(Number(cur.updatedAt)) : 0
    };
  }
  if (typeof src.jobId === 'string' || typeof src.jobId === 'number') {
    out.jobId = src.jobId;
  }
  return out;
}

type RuntimeResumeCheckpointSnapshot = {
  runId: string;
  status: string;
  stage: string;
  updatedAt: number;
  objective: string;
  lastCompletedStepIndex: number;
  totalSteps: number;
  completedStepCount: number;
  resumeCursorIndex: number;
  resumedStepCount: number;
  resumedUnfinishedStepCount: number;
  attempted: number;
  succeeded: number;
  resumeApplied: boolean;
  conversationId: string;
};

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isTerminalRunStatus(statusRaw: unknown): boolean {
  const status = String(statusRaw || '').trim().toLowerCase();
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function normalizeRuntimeResumeCheckpointSnapshot(raw: unknown): RuntimeResumeCheckpointSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const runId = String(src.runId || '').trim();
  if (!runId) return null;
  return {
    runId,
    status: String(src.status || '').trim().toLowerCase(),
    stage: String(src.stage || '').trim(),
    updatedAt: toFiniteInt(src.updatedAt, 0),
    objective: String(src.objective || '').trim(),
    lastCompletedStepIndex: toFiniteInt(src.lastCompletedStepIndex, -1),
    totalSteps: Math.max(0, toFiniteInt(src.totalSteps, 0)),
    completedStepCount: Math.max(0, toFiniteInt(src.completedStepCount, 0)),
    resumeCursorIndex: toFiniteInt(src.resumeCursorIndex, -1),
    resumedStepCount: Math.max(0, toFiniteInt(src.resumedStepCount, 0)),
    resumedUnfinishedStepCount: Math.max(0, toFiniteInt(src.resumedUnfinishedStepCount, 0)),
    attempted: Math.max(0, toFiniteInt(src.attempted, 0)),
    succeeded: Math.max(0, toFiniteInt(src.succeeded, 0)),
    resumeApplied: src.resumeApplied === true
      || String(src.resumeApplied || '').trim() === '1'
      || String(src.resumeApplied || '').trim().toLowerCase() === 'true',
    conversationId: String(src.conversationId || '').trim()
  };
}

function hasNoPendingRuntimeResumeSteps(params: {
  totalSteps: number;
  lastCompletedStepIndex: number;
  completedStepCount: number;
  cursorIndex: number;
  resumeCursorIndex: number;
  resumedStepCount: number;
  resumedUnfinishedStepCount: number;
  attempted: number;
  succeeded: number;
  resumeApplied: boolean;
  stage?: string;
  status?: string;
}): boolean {
  const totalSteps = Math.max(0, Number(params.totalSteps || 0));
  const lastCompletedStepIndex = Number(params.lastCompletedStepIndex || -1);
  const completedStepCount = Math.max(0, Number(params.completedStepCount || 0));
  const cursorIndex = Number(params.cursorIndex || -1);
  const resumeCursorIndex = Number(params.resumeCursorIndex || -1);
  const resumedStepCount = Math.max(0, Number(params.resumedStepCount || 0));
  const resumedUnfinishedStepCount = Math.max(0, Number(params.resumedUnfinishedStepCount || 0));
  const attempted = Math.max(0, Number(params.attempted || 0));
  const succeeded = Math.max(0, Number(params.succeeded || 0));
  const resumeApplied = params.resumeApplied === true;
  const stage = String(params.stage || '').trim().toLowerCase();
  const status = String(params.status || '').trim().toLowerCase();

  if (totalSteps <= 0) {
    const hasDeterministicCursor = (
      lastCompletedStepIndex >= 0
      || completedStepCount > 0
      || cursorIndex > 0
      || resumeCursorIndex > 0
      || resumedStepCount > 0
      || resumedUnfinishedStepCount > 0
    );
    if (!hasDeterministicCursor) return true;
    const weakOnlyStartStage = (
      (stage === '' || stage === 'start')
      && (status === '' || status === 'running')
      && lastCompletedStepIndex < 0
      && completedStepCount === 0
      && cursorIndex <= 0
      && resumeCursorIndex <= 0
      && resumedStepCount <= 0
      && resumedUnfinishedStepCount <= 0
      && (attempted > 0 || succeeded > 0 || resumeApplied)
    );
    if (weakOnlyStartStage) return true;
    return false;
  }

  if (lastCompletedStepIndex >= totalSteps - 1) return true;
  if (completedStepCount >= totalSteps) return true;
  if (cursorIndex >= totalSteps && cursorIndex >= 0) return true;
  if (resumeCursorIndex >= totalSteps && resumeCursorIndex >= 0) return true;
  if (resumeApplied && resumedUnfinishedStepCount === 0 && resumedStepCount >= totalSteps) return true;
  if (attempted >= totalSteps && succeeded >= totalSteps) return true;
  return false;
}

function toRecordObjectMaybe(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObjectMaybe(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const text = String(value || '').trim();
    if (!text) return null;
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
      const parsed = JSON.parse(text);
      return toRecordObjectMaybe(parsed);
    } catch {
      return null;
    }
  }
  return toRecordObjectMaybe(value);
}

function toStringMap(value: unknown): Record<string, string> {
  const src = toRecordObjectMaybe(value);
  if (!src) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(src)) {
    const k = String(key || '').trim();
    if (!k) continue;
    const v = String(raw ?? '').trim();
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function toRecordMap(value: unknown): Record<string, Record<string, unknown>> {
  const src = toRecordObjectMaybe(value);
  if (!src) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of Object.entries(src)) {
    const k = String(key || '').trim();
    if (!k) continue;
    const row = toRecordObjectMaybe(raw);
    if (!row) continue;
    out[k] = { ...row };
  }
  return out;
}

function dedupeByKey<T>(items: T[], buildKey: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = String(buildKey(item) || '');
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeRuntimeProtocolSnapshotForMerge(value: unknown): RuntimeProtocolSnapshot {
  const src = toRecordObjectMaybe(value) || {};
  const countersRaw = toRecordObjectMaybe(src.counters) || {};
  const toolGate = toRecordObjectMaybe(src.toolGate);
  const latestOrchestratorState = toRecordObjectMaybe(src.latestOrchestratorState);
  const assistantDeliveriesRaw = Array.isArray(src.assistantDeliveries) ? src.assistantDeliveries : [];
  const feedbackCyclesRaw = Array.isArray(src.feedbackCycles) ? src.feedbackCycles : [];
  const terminalOutcomesRaw = Array.isArray(src.terminalOutcomes) ? src.terminalOutcomes : [];
  const assistantDeliveries = assistantDeliveriesRaw
    .map((item) => toRecordObjectMaybe(item))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => ({
      runId: String(row.runId || '').trim(),
      phase: String(row.phase || '').trim(),
      noReply: typeof row.noReply === 'boolean' ? row.noReply : null,
      delivered: typeof row.delivered === 'boolean' ? row.delivered : null,
      contentLength: Math.max(0, toFiniteInt(row.contentLength, 0)),
      contentPreview: String(row.contentPreview || '').trim(),
      ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : null,
      stage: String(row.stage || '').trim()
    }));
  const feedbackCycles = feedbackCyclesRaw
    .map((item) => toRecordObjectMaybe(item))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => ({
      runId: String(row.runId || '').trim(),
      phase: String(row.phase || '').trim(),
      round: Number.isFinite(Number(row.round)) ? toFiniteInt(row.round, 0) : null,
      waitMode: String(row.waitMode || '').trim(),
      interrupted: typeof row.interrupted === 'boolean' ? row.interrupted : null,
      flushAcked: typeof row.flushAcked === 'boolean' ? row.flushAcked : null,
      batchCount: Number.isFinite(Number(row.batchCount)) ? toFiniteInt(row.batchCount, 0) : null,
      responseCount: Number.isFinite(Number(row.responseCount)) ? toFiniteInt(row.responseCount, 0) : null,
      flushedCount: Number.isFinite(Number(row.flushedCount)) ? toFiniteInt(row.flushedCount, 0) : null,
      reason: String(row.reason || '').trim(),
      ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : null
    }));
  const terminalOutcomes = terminalOutcomesRaw
    .map((item) => toRecordObjectMaybe(item))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => ({
      stepKey: String(row.stepKey || '').trim(),
      runId: String(row.runId || '').trim(),
      stepId: String(row.stepId || '').trim(),
      stepIndex: Number.isFinite(Number(row.stepIndex)) ? toFiniteInt(row.stepIndex, 0) : null,
      aiName: String(row.aiName || '').trim(),
      executor: String(row.executor || '').trim(),
      actionRef: String(row.actionRef || '').trim(),
      state: String(row.state || '').trim(),
      reasonCode: String(row.reasonCode || '').trim(),
      reason: String(row.reason || '').trim(),
      attemptNo: Number.isFinite(Number(row.attemptNo)) ? toFiniteInt(row.attemptNo, 0) : null,
      resultCode: String(row.resultCode || '').trim()
    }));
  return {
    toolGate: toolGate
      ? {
        need: typeof toolGate.need === 'boolean' ? toolGate.need : null,
        selectedCount: Number.isFinite(Number(toolGate.selectedCount)) ? toFiniteInt(toolGate.selectedCount, 0) : null,
        totalCount: Number.isFinite(Number(toolGate.totalCount)) ? toFiniteInt(toolGate.totalCount, 0) : null,
        selectedTools: Array.isArray(toolGate.selectedTools)
          ? toolGate.selectedTools.map((x) => String(x || '').trim()).filter(Boolean)
          : [],
        skippedCount: Number.isFinite(Number(toolGate.skippedCount)) ? toFiniteInt(toolGate.skippedCount, 0) : null,
        summary: String(toolGate.summary || '').trim()
      }
      : null,
    counters: {
      toolGate: Math.max(0, toFiniteInt(countersRaw.toolGate, 0)),
      actionRequest: Math.max(0, toFiniteInt(countersRaw.actionRequest, 0)),
      stepState: Math.max(0, toFiniteInt(countersRaw.stepState, 0)),
      actionResult: Math.max(0, toFiniteInt(countersRaw.actionResult, 0)),
      workspaceDiff: Math.max(0, toFiniteInt(countersRaw.workspaceDiff, 0)),
      assistantDelivery: Math.max(0, toFiniteInt(countersRaw.assistantDelivery, 0)),
      feedbackCycle: Math.max(0, toFiniteInt(countersRaw.feedbackCycle, 0)),
      orchestratorState: Math.max(0, toFiniteInt(countersRaw.orchestratorState, 0))
    },
    latestStepStateByStepKey: toStringMap(src.latestStepStateByStepKey),
    latestStepDetailByStepKey: toRecordMap(src.latestStepDetailByStepKey) as RuntimeProtocolSnapshot['latestStepDetailByStepKey'],
    latestActionResultByStepKey: toRecordMap(src.latestActionResultByStepKey) as RuntimeProtocolSnapshot['latestActionResultByStepKey'],
    latestWorkspaceDiffByStepKey: toRecordMap(src.latestWorkspaceDiffByStepKey) as RuntimeProtocolSnapshot['latestWorkspaceDiffByStepKey'],
    assistantDeliveries,
    feedbackCycles,
    latestOrchestratorState: latestOrchestratorState
      ? {
        runId: String(latestOrchestratorState.runId || '').trim(),
        state: String(latestOrchestratorState.state || '').trim(),
        status: String(latestOrchestratorState.status || '').trim(),
        reasonCode: String(latestOrchestratorState.reasonCode || '').trim(),
        note: String(latestOrchestratorState.note || '').trim(),
        childRunCount: Number.isFinite(Number(latestOrchestratorState.childRunCount))
          ? toFiniteInt(latestOrchestratorState.childRunCount, 0)
          : null,
        ts: Number.isFinite(Number(latestOrchestratorState.ts)) ? Number(latestOrchestratorState.ts) : null
      }
      : null,
    terminalOutcomes
  };
}

function mergeRuntimeProtocolSnapshots(
  baseValue: unknown,
  extraValue: unknown
): RuntimeProtocolSnapshot {
  const base = normalizeRuntimeProtocolSnapshotForMerge(baseValue);
  const extra = normalizeRuntimeProtocolSnapshotForMerge(extraValue);
  const mergedLatestStepStateByStepKey = {
    ...base.latestStepStateByStepKey,
    ...extra.latestStepStateByStepKey
  };
  const mergedLatestStepDetailByStepKey = {
    ...base.latestStepDetailByStepKey,
    ...extra.latestStepDetailByStepKey
  };
  const mergedLatestActionResultByStepKey = {
    ...base.latestActionResultByStepKey,
    ...extra.latestActionResultByStepKey
  };
  const mergedLatestWorkspaceDiffByStepKey = {
    ...base.latestWorkspaceDiffByStepKey,
    ...extra.latestWorkspaceDiffByStepKey
  };
  const mergedAssistantDeliveries = dedupeByKey(
    [...base.assistantDeliveries, ...extra.assistantDeliveries],
    (item) => `${item.runId}|${item.phase}|${item.ts ?? 0}|${item.delivered == null ? '' : (item.delivered ? 1 : 0)}|${item.noReply == null ? '' : (item.noReply ? 1 : 0)}|${item.contentPreview}`
  ).slice(-96);
  const mergedFeedbackCycles = dedupeByKey(
    [...base.feedbackCycles, ...extra.feedbackCycles],
    (item) => `${item.runId}|${item.phase}|${item.round ?? ''}|${item.ts ?? 0}|${item.reason}|${item.flushedCount ?? ''}`
  ).slice(-96);
  const mergedTerminalOutcomes = dedupeByKey(
    [...base.terminalOutcomes, ...extra.terminalOutcomes],
    (item) => `${item.stepKey}|${item.runId}|${item.state}|${item.resultCode}|${item.attemptNo ?? ''}`
  ).slice(-96);

  const baseOrchestratorTs = Number(base.latestOrchestratorState?.ts || 0);
  const extraOrchestratorTs = Number(extra.latestOrchestratorState?.ts || 0);
  const latestOrchestratorState = (extra.latestOrchestratorState && extraOrchestratorTs >= baseOrchestratorTs)
    ? extra.latestOrchestratorState
    : base.latestOrchestratorState;
  const toolGate = extra.toolGate || base.toolGate || null;

  return {
    toolGate,
    counters: {
      toolGate: Math.max(base.counters.toolGate, extra.counters.toolGate, toolGate ? 1 : 0),
      actionRequest: Math.max(base.counters.actionRequest, extra.counters.actionRequest),
      stepState: Math.max(base.counters.stepState, extra.counters.stepState, Object.keys(mergedLatestStepStateByStepKey).length),
      actionResult: Math.max(base.counters.actionResult, extra.counters.actionResult, Object.keys(mergedLatestActionResultByStepKey).length),
      workspaceDiff: Math.max(base.counters.workspaceDiff, extra.counters.workspaceDiff, Object.keys(mergedLatestWorkspaceDiffByStepKey).length),
      assistantDelivery: Math.max(base.counters.assistantDelivery, extra.counters.assistantDelivery, mergedAssistantDeliveries.length),
      feedbackCycle: Math.max(base.counters.feedbackCycle, extra.counters.feedbackCycle, mergedFeedbackCycles.length),
      orchestratorState: Math.max(base.counters.orchestratorState, extra.counters.orchestratorState, latestOrchestratorState ? 1 : 0)
    },
    latestStepStateByStepKey: mergedLatestStepStateByStepKey,
    latestStepDetailByStepKey: mergedLatestStepDetailByStepKey,
    latestActionResultByStepKey: mergedLatestActionResultByStepKey,
    latestWorkspaceDiffByStepKey: mergedLatestWorkspaceDiffByStepKey,
    assistantDeliveries: mergedAssistantDeliveries,
    feedbackCycles: mergedFeedbackCycles,
    latestOrchestratorState: latestOrchestratorState || null,
    terminalOutcomes: mergedTerminalOutcomes
  };
}

function normalizeAssistantResponsesFromUnknown(value: unknown): CompletionAssistantResponseTraceItem[] {
  if (!Array.isArray(value)) return [];
  const out: CompletionAssistantResponseTraceItem[] = [];
  for (const item of value) {
    const row = toRecordObjectMaybe(item);
    if (!row) continue;
    const content = String(row.content ?? '').trim();
    if (!content) continue;
    const meta = toRecordObjectMaybe(row.meta) || {};
    out.push({
      runId: String(row.runId || '').trim(),
      phase: String(row.phase || 'assistant_response').trim() || 'assistant_response',
      content,
      noReply: row.noReply === true,
      delivered: row.delivered === true,
      ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : 0,
      meta
    });
  }
  return out;
}

function mergeAssistantResponsesForAnalysis(
  ...groups: Array<CompletionAssistantResponseTraceItem[]>
): CompletionAssistantResponseTraceItem[] {
  const merged = dedupeByKey(
    groups.flatMap((arr) => Array.isArray(arr) ? arr : []),
    (item) => `${item.runId}|${item.phase}|${item.ts}|${item.noReply ? 1 : 0}|${item.delivered ? 1 : 0}|${item.content}`
  );
  merged.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.runId !== b.runId) return a.runId.localeCompare(b.runId);
    return a.phase.localeCompare(b.phase);
  });
  return merged;
}

function compactAssistantResponsesForCheckpoint(
  items: CompletionAssistantResponseTraceItem[],
  maxItems = 160
): CompletionAssistantResponseTraceItem[] {
  const normalized = mergeAssistantResponsesForAnalysis(items);
  const sliced = normalized.slice(-Math.max(1, maxItems));
  return sliced.map((item) => {
    const stage = String((item.meta && typeof item.meta === 'object' ? item.meta.stage : '') || '').trim();
    const content = String(item.content || '');
    return {
      runId: item.runId,
      phase: item.phase,
      content: content.length > 1200 ? content.slice(0, 1200) : content,
      noReply: item.noReply === true,
      delivered: item.delivered === true,
      ts: item.ts,
      meta: stage ? { stage } : {}
    };
  });
}

function extractRuntimeProtocolFromCheckpoint(rawCheckpoint: unknown): RuntimeProtocolSnapshot | null {
  const checkpoint = toRecordObjectMaybe(rawCheckpoint);
  if (!checkpoint) return null;
  const runtimeProtocolRaw = parseJsonObjectMaybe(checkpoint.runtimeProtocol) || toRecordObjectMaybe(checkpoint.runtimeProtocol);
  if (!runtimeProtocolRaw) return null;
  return normalizeRuntimeProtocolSnapshotForMerge(runtimeProtocolRaw);
}

function extractAssistantResponsesFromCheckpoint(rawCheckpoint: unknown): CompletionAssistantResponseTraceItem[] {
  const checkpoint = toRecordObjectMaybe(rawCheckpoint);
  if (!checkpoint) return [];
  const candidates: unknown[] = [];
  if (checkpoint.assistantResponses != null) candidates.push(checkpoint.assistantResponses);
  if (checkpoint.assistantResponseTrace != null) candidates.push(checkpoint.assistantResponseTrace);
  if (checkpoint.assistantResponseTraces != null) candidates.push(checkpoint.assistantResponseTraces);
  const out: CompletionAssistantResponseTraceItem[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      out.push(...normalizeAssistantResponsesFromUnknown(candidate));
      continue;
    }
    const parsed = parseJsonObjectMaybe(candidate);
    if (!parsed) continue;
    const fromItems = Array.isArray(parsed.items) ? parsed.items : [];
    out.push(...normalizeAssistantResponsesFromUnknown(fromItems));
  }
  return mergeAssistantResponsesForAnalysis(out);
}

function buildAssistantResponsesFromRuntimeProtocolPreview(snapshot: RuntimeProtocolSnapshot): CompletionAssistantResponseTraceItem[] {
  const deliveries = Array.isArray(snapshot.assistantDeliveries) ? snapshot.assistantDeliveries : [];
  const out: CompletionAssistantResponseTraceItem[] = [];
  for (const item of deliveries) {
    const content = String(item.contentPreview || '').trim();
    if (!content) continue;
    out.push({
      runId: String(item.runId || '').trim(),
      phase: String(item.phase || '').trim() || 'assistant_response',
      content,
      noReply: item.noReply === true,
      delivered: item.delivered === true,
      ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : 0,
      meta: item.stage ? { stage: String(item.stage || '').trim(), source: 'runtime_protocol_preview' } : { source: 'runtime_protocol_preview' }
    });
  }
  return mergeAssistantResponsesForAnalysis(out);
}

export async function handleOneMessageCore(ctx: MessagePipelineContext, msg: MsgLike, taskId: string | null | undefined) {
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
    WORLDBOOK_XML,
    AGENT_PRESET_XML,
    AGENT_PRESET_PLAIN_TEXT,
    AGENT_PRESET_RAW_TEXT,
    baseSystem,
    convertHistoryToMCPFormat,    buildSentraResultBlock,
    smartSend,
    sdk,
    trackRunForSender,
    untrackRunForSender,
    chatWithRetry,
    MAIN_AI_MODEL,
    triggerContextSummarizationIfNeeded,
    triggerPresetTeachingIfNeeded,
    completeTask,
    startBundleForQueuedMessage,
    collectBundleForSender,
    drainPendingMessagesForSender,
    shouldReply,
    sendAndWaitResult,
    randomUUID,
    saveMessageCache,
    enqueueDelayedJob,
    persistRuntimeProtocolState,
    loadRuntimeRunCheckpointSnapshot
  } = ctx;

  const userid = String(msg?.sender_id ?? '');
  const privateScopeId = buildPrivateScopeId(userid);
  const groupId = msg?.group_id ? buildGroupScopeId(msg.group_id) : privateScopeId;
  const channelId = groupId;
  const identityKey = msg?.group_id ? `${buildGroupScopeId(msg.group_id)}|${privateScopeId}` : privateScopeId;
  const currentTaskId = taskId;
  const runStartedAt = Date.now();
  const orchestratorRunId = `orchestrator_${randomUUID()}`;

  const mergedUsers = Array.isArray(msg?._mergedUsers) ? msg._mergedUsers : null;
  const isMergedGroup = !!msg?._merged && mergedUsers && mergedUsers.length > 1 && msg?.type === 'group';

  const isProactive = !!msg?._proactive;
  const isProactiveFirst = !!msg?._proactiveFirst;
  const proactiveRootXml =
    typeof msg?._sentraRootDirectiveXml === 'string' && msg._sentraRootDirectiveXml.trim()
      ? msg._sentraRootDirectiveXml.trim()
      : null;
  const runtimeResumeSignal = (msg?._runtimeResume && typeof msg._runtimeResume === 'object' && !Array.isArray(msg._runtimeResume))
    ? (msg._runtimeResume as Record<string, unknown>)
    : null;
  let runtimeResumeEnabled = runtimeResumeSignal?.fromCheckpoint === true;
  let runtimeResumeRunId = String(runtimeResumeSignal?.runId || msg?._taskIdOverride || '').trim();
  let runtimeResumeStatus = String(runtimeResumeSignal?.status || '').trim().toLowerCase();
  let runtimeResumeStage = String(runtimeResumeSignal?.stage || '').trim();
  let runtimeResumeLastCompletedStepIndex = toFiniteInt(runtimeResumeSignal?.lastCompletedStepIndex, -1);
  let runtimeResumeTotalSteps = Math.max(0, toFiniteInt(runtimeResumeSignal?.totalSteps, 0));
  let runtimeResumeCompletedStepCount = Math.max(0, toFiniteInt(runtimeResumeSignal?.completedStepCount, 0));
  let runtimeResumeResumeCursorIndex = toFiniteInt(runtimeResumeSignal?.resumeCursorIndex, -1);
  let runtimeResumeResumedStepCount = Math.max(0, toFiniteInt(runtimeResumeSignal?.resumedStepCount, 0));
  let runtimeResumeResumedUnfinishedStepCount = Math.max(0, toFiniteInt(runtimeResumeSignal?.resumedUnfinishedStepCount, 0));
  let runtimeResumeAttempted = Math.max(0, toFiniteInt(runtimeResumeSignal?.attempted, 0));
  let runtimeResumeSucceeded = Math.max(0, toFiniteInt(runtimeResumeSignal?.succeeded, 0));
  let runtimeResumeApplied = runtimeResumeSignal?.resumeApplied === true
    || String(runtimeResumeSignal?.resumeApplied || '').trim() === '1'
    || String(runtimeResumeSignal?.resumeApplied || '').trim().toLowerCase() === 'true';
  let runtimeResumeCursorIndex = runtimeResumeTotalSteps > 0
    ? Math.min(runtimeResumeTotalSteps, Math.max(0, runtimeResumeLastCompletedStepIndex + 1))
    : Math.max(0, runtimeResumeLastCompletedStepIndex + 1);
  let runtimeResumeObjective = String(runtimeResumeSignal?.objective || '').trim();
  let runtimeResumeUpdatedAt = toFiniteInt(runtimeResumeSignal?.updatedAt, 0);
  let runtimeResumeLoadedFromCheckpoint = false;
  let runtimeResumeDecisionKind: '' | 'accepted' | 'skipped' = '';
  let runtimeResumeDecisionReasonCode = '';
  if (runtimeResumeEnabled && runtimeResumeRunId && typeof loadRuntimeRunCheckpointSnapshot === 'function') {
    try {
      const rawCheckpoint = await loadRuntimeRunCheckpointSnapshot({ runId: runtimeResumeRunId });
      const normalizedCheckpoint = normalizeRuntimeResumeCheckpointSnapshot(rawCheckpoint);
      if (normalizedCheckpoint) {
        runtimeResumeLoadedFromCheckpoint = true;
        runtimeResumeRunId = normalizedCheckpoint.runId;
        runtimeResumeStatus = String(normalizedCheckpoint.status || runtimeResumeStatus || '').trim().toLowerCase();
        runtimeResumeStage = String(normalizedCheckpoint.stage || runtimeResumeStage || '').trim();
        runtimeResumeLastCompletedStepIndex = toFiniteInt(
          normalizedCheckpoint.lastCompletedStepIndex,
          runtimeResumeLastCompletedStepIndex
        );
        runtimeResumeTotalSteps = Math.max(0, toFiniteInt(normalizedCheckpoint.totalSteps, runtimeResumeTotalSteps));
        runtimeResumeCompletedStepCount = Math.max(
          0,
          toFiniteInt(normalizedCheckpoint.completedStepCount, runtimeResumeCompletedStepCount)
        );
        runtimeResumeResumeCursorIndex = toFiniteInt(
          normalizedCheckpoint.resumeCursorIndex,
          runtimeResumeResumeCursorIndex
        );
        runtimeResumeResumedStepCount = Math.max(
          0,
          toFiniteInt(normalizedCheckpoint.resumedStepCount, runtimeResumeResumedStepCount)
        );
        runtimeResumeResumedUnfinishedStepCount = Math.max(
          0,
          toFiniteInt(normalizedCheckpoint.resumedUnfinishedStepCount, runtimeResumeResumedUnfinishedStepCount)
        );
        runtimeResumeAttempted = Math.max(0, toFiniteInt(normalizedCheckpoint.attempted, runtimeResumeAttempted));
        runtimeResumeSucceeded = Math.max(0, toFiniteInt(normalizedCheckpoint.succeeded, runtimeResumeSucceeded));
        runtimeResumeApplied = normalizedCheckpoint.resumeApplied === true || runtimeResumeApplied;
        runtimeResumeCursorIndex = runtimeResumeTotalSteps > 0
          ? Math.min(runtimeResumeTotalSteps, Math.max(0, runtimeResumeLastCompletedStepIndex + 1))
          : Math.max(0, runtimeResumeLastCompletedStepIndex + 1);
        runtimeResumeObjective = String(normalizedCheckpoint.objective || runtimeResumeObjective || '').trim();
        runtimeResumeUpdatedAt = toFiniteInt(normalizedCheckpoint.updatedAt, runtimeResumeUpdatedAt);
      }
    } catch (e) {
      logger.warn('runtime resume checkpoint load failed', {
        groupId,
        runId: runtimeResumeRunId || null,
        err: String(e)
      });
    }
  }
  if (runtimeResumeEnabled && runtimeResumeStatus && isTerminalRunStatus(runtimeResumeStatus)) {
    runtimeResumeEnabled = false;
    runtimeResumeDecisionKind = 'skipped';
    runtimeResumeDecisionReasonCode = 'resume_checkpoint_terminal';
    logger.info('runtime resume skipped: checkpoint already terminal', {
      groupId,
      runId: runtimeResumeRunId || null,
      status: runtimeResumeStatus || null
    });
  }
  if (runtimeResumeEnabled && hasNoPendingRuntimeResumeSteps({
    totalSteps: runtimeResumeTotalSteps,
    lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
    completedStepCount: runtimeResumeCompletedStepCount,
    cursorIndex: runtimeResumeCursorIndex,
    resumeCursorIndex: runtimeResumeResumeCursorIndex,
    resumedStepCount: runtimeResumeResumedStepCount,
    resumedUnfinishedStepCount: runtimeResumeResumedUnfinishedStepCount,
    attempted: runtimeResumeAttempted,
    succeeded: runtimeResumeSucceeded,
    resumeApplied: runtimeResumeApplied,
    stage: runtimeResumeStage,
    status: runtimeResumeStatus
  })) {
    runtimeResumeEnabled = false;
    runtimeResumeDecisionKind = 'skipped';
    runtimeResumeDecisionReasonCode = 'resume_no_pending_steps';
    logger.info('runtime resume skipped: no pending steps', {
      groupId,
      runId: runtimeResumeRunId || null,
      stage: runtimeResumeStage || null,
      status: runtimeResumeStatus || null,
      lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
      completedStepCount: runtimeResumeCompletedStepCount,
      totalSteps: runtimeResumeTotalSteps,
      cursorIndex: runtimeResumeCursorIndex,
      resumeCursorIndex: runtimeResumeResumeCursorIndex
    });
  }
  if (runtimeResumeEnabled && !runtimeResumeRunId) {
    runtimeResumeEnabled = false;
    runtimeResumeDecisionKind = 'skipped';
    runtimeResumeDecisionReasonCode = 'resume_missing_run_id';
    logger.info('runtime resume skipped: missing runId', { groupId });
  }
  if (runtimeResumeEnabled) {
    runtimeResumeDecisionKind = 'accepted';
    runtimeResumeDecisionReasonCode = 'resume_signal_accepted';
    logger.info('runtime resume input accepted', {
      groupId,
      runId: runtimeResumeRunId || null,
      stage: runtimeResumeStage || null,
      status: runtimeResumeStatus || null,
      loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
      lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
      totalSteps: runtimeResumeTotalSteps,
      cursorIndex: runtimeResumeCursorIndex
    });
  }
  const requestedReplyAction = String(msg?._replyAction || '').trim().toLowerCase();
  const delayReplayPayload = normalizeDelayReplayPayload(msg?._delayReplay);
  const isDelayReplayDue = !!delayReplayPayload;
  const delayPlan =
    msg?._delayPlan && typeof msg._delayPlan === 'object'
      ? msg._delayPlan
      : null;
  const parsedDelayFireAt = delayPlan && Number.isFinite(Number(delayPlan.fireAt))
    ? Number(delayPlan.fireAt)
    : 0;
  const hasDelayAction = requestedReplyAction === 'delay' && parsedDelayFireAt > Date.now();
  const delayWhenText = hasDelayAction
    ? String(delayPlan?.whenText || '').trim()
    : '';
  const delayTargetISO = hasDelayAction
    ? String(delayPlan?.targetISO || '').trim()
    : '';
  const delayReplayRunId = isDelayReplayDue
    ? String(delayReplayPayload?.runId || '').trim()
    : '';
  const delayReplayReasonCode: DelayReasonCode = isDelayReplayDue
    ? normalizeDelayReasonCode(
      delayReplayPayload?.reasonCode || delayReplayPayload?.reason,
      DELAY_REASON_CODE.dueReplay
    )
    : DELAY_REASON_CODE.dueReplay;
  const delayReplayReasonArgs = isDelayReplayDue
    ? normalizeDelayReasonArgs(delayReplayPayload?.reasonArgs)
    : {};
  const delayReplayReason = isDelayReplayDue
    ? String(delayReplayPayload?.reason || delayReplayReasonCode || '').trim()
    : '';
  const delayReplayDeferredResponse = isDelayReplayDue
    ? String(delayReplayPayload?.deferredResponseXml || '').trim()
    : '';
  const delayReplayToolEvents = isDelayReplayDue && Array.isArray(delayReplayPayload?.deferredToolResultEvents)
    ? delayReplayPayload!.deferredToolResultEvents || []
    : [];
  const delayReplayCursorOffset = (() => {
    if (!isDelayReplayDue) return 0;
    const fromCursor = Number(delayReplayPayload?.replayCursor?.nextOffset);
    if (Number.isFinite(fromCursor) && fromCursor >= 0) return Math.trunc(fromCursor);
    const fromReasonArgs = Number((delayReplayReasonArgs as Record<string, unknown>)?.replay_cursor_offset);
    if (Number.isFinite(fromReasonArgs) && fromReasonArgs >= 0) return Math.trunc(fromReasonArgs);
    return 0;
  })();
  const delayReplayCursorTotalEvents = (() => {
    if (!isDelayReplayDue) return 0;
    const fromCursor = Number(delayReplayPayload?.replayCursor?.totalEvents);
    if (Number.isFinite(fromCursor) && fromCursor >= 0) return Math.trunc(fromCursor);
    return delayReplayToolEvents.length;
  })();
  const delayReplayCursorStatus = isDelayReplayDue
    ? String(delayReplayPayload?.replayCursor?.status || '').trim()
    : '';
  const delayReplaySessionId = isDelayReplayDue
    ? String(delayReplayPayload?.delaySessionId || '').trim()
    : '';
  const delaySessionId = hasDelayAction
    ? randomUUID()
    : delayReplaySessionId;
  const delayRuntimeReasonCode = DELAY_REASON_CODE.runtime;
  const delayRuntimeReasonArgs = buildDelayReasonArgs(delayWhenText, delayTargetISO);
  const delayRuntimeReason = delayRuntimeReasonCode;
  const effectiveReplyAction =
    isDelayReplayDue
      ? 'delay_due'
      : requestedReplyAction === 'short'
      ? 'short'
      : (hasDelayAction ? 'delay' : 'action');

  const conversationId = msg?.group_id
    ? `group_${msg.group_id}_sender_${userid}`
    : `private_${userid}`;

  logger.info(
    tMessagePipeline('reply_action_runtime'),
    {
      conversation: conversationId,
      action: effectiveReplyAction,
      ...(hasDelayAction
        ? { delayWhen: delayWhenText || '', target: delayTargetISO || '' }
        : {}),
      ...(isDelayReplayDue
        ? {
          replayRunId: delayReplayRunId || 'none',
          replayEvents: delayReplayToolEvents.length
        }
        : {})
    }
  );

  let convId: string | null = null;
  let pairId: string | number | null = null;
  let currentRunId: string | null = null;
  let currentUserContent = '';
  let currentUserContentSnapshot = '';
  // 记录是否已发过第一条对外回复（用于控制引用/节流逻辑）。
  let hasReplied = false;
  let hasToolPreReplied = false;
  let hasRealtimeToolFeedback = false;
  let hasDelayPreReplySent = false;
  let delayBufferingEnabled = hasDelayAction;
  let delayDueTriggerQueued = false;
  let delayBufferedEventCount = 0;
  let hasSupplementDuringTask = false; // Whether supplemental messages were detected during this task; used for single swallow control.
  let endedBySchedule = false; // Reused as "ended by deferred delay queue handoff".
  const pendingToolArgsByStepIndex = new Map<number, { aiName?: string; args?: Record<string, ParamValue> }>();
  const toolTurnInvocationSet = new Set<string>();
  const toolTurnInvocations: ToolInvocation[] = [];
  const toolTurnResultEvents: ToolResultEvent[] = [];
  const runtimeProtocolTracker = new McpRuntimeProtocolTracker();
  const persistRuntimeProtocolStateSafe = async (payload: RuntimeProtocolPersistPayload) => {
    if (typeof persistRuntimeProtocolState !== 'function') return;
    const runId = String(payload?.runId || '').trim();
    if (!runId) return;
    const mergedContext: Record<string, unknown> = {
      conversationId,
      channelId,
      identityKey,
      groupId,
      userId: userid,
      orchestratorRunId,
      parentRunId: orchestratorRunId,
      orchestrator_run_id: orchestratorRunId,
      parent_run_id: orchestratorRunId,
      ...(payload.context && typeof payload.context === 'object' ? payload.context : {})
    };
    try {
      await persistRuntimeProtocolState({
        ...payload,
        runId,
        context: mergedContext
      });
    } catch (e) {
      logger.debug('runtime protocol persistence failed', {
        err: String(e),
        groupId,
        runId
      });
    }
  };
  if (runtimeResumeRunId && runtimeResumeDecisionKind) {
    await persistRuntimeProtocolStateSafe({
      op: 'checkpoint',
      runId: runtimeResumeRunId,
      patch: {
        runtimeResumeSignal: {
          decision: runtimeResumeDecisionKind,
          reasonCode: runtimeResumeDecisionReasonCode || '',
          loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
          checkpointStage: runtimeResumeStage || '',
          checkpointStatus: runtimeResumeStatus || '',
          lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
          totalSteps: runtimeResumeTotalSteps,
          resumeCursorIndex: runtimeResumeCursorIndex,
          updatedAt: runtimeResumeUpdatedAt
        }
      },
      event: {
        type: runtimeResumeDecisionKind === 'accepted'
          ? 'runtime_resume_signal_accepted'
          : 'runtime_resume_signal_skipped',
        reasonCode: runtimeResumeDecisionReasonCode || '',
        runId: runtimeResumeRunId,
        loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
        checkpointStage: runtimeResumeStage || '',
        checkpointStatus: runtimeResumeStatus || '',
        resumeCursorIndex: runtimeResumeCursorIndex
      },
      source: 'message_pipeline_runtime_resume'
    });
  }
  const delayReplayRawEvents: DelayReplayToolResultEvent[] = [];
  let toolResultArrived = false;
  let toolPreReplyJobStarted = false;
  let toolPreReplyFallbackToolNames: string[] = [];
  let finalResponseForCompletionAnalysis = '';
  let completionAnalysisHasToolCalled = false;
  let lastRealtimeToolResponse = '';
  let userObjective: string | null = null;
  const orchestratorChildRunIds = new Set<string>();
  const assistantBridgeBatches = new Map<string, {
    runId: string;
    objective: string;
    responses: AssistantBridgeResponseItem[];
    lastSentIndex: number;
    lastFeedbackSentIndex: number;
  }>();
  const assistantBridgeRealtimeFlushTimers = new Map<string, NodeJS.Timeout>();

  const cloneDeferredReplayEvent = (ev: StreamEvent): DelayReplayToolResultEvent => {
    const src = ev as Record<string, unknown>;
    const out: DelayReplayToolResultEvent = { ...src };
    if (!out.type || typeof out.type !== 'string') {
      out.type = 'tool_result';
    }
    if (Array.isArray(src.events)) {
      out.events = src.events
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({ ...(x as Record<string, unknown>) }));
    }
    return out;
  };

  const ensureAssistantBridgeBatch = (runIdLike: unknown, objectiveLike?: unknown) => {
    const rid = String(runIdLike ?? '').trim();
    if (!rid) return null;
    let batch = assistantBridgeBatches.get(rid);
    if (!batch) {
      batch = {
        runId: rid,
        objective: typeof objectiveLike === 'string' ? objectiveLike : '',
        responses: [],
        lastSentIndex: 0,
        lastFeedbackSentIndex: 0
      };
      assistantBridgeBatches.set(rid, batch);
    } else if (!batch.objective && typeof objectiveLike === 'string' && objectiveLike.trim()) {
      batch.objective = objectiveLike;
    }
    return batch;
  };

  const recordAssistantBridgeResponse = (params: {
    runId?: unknown;
    phase: string;
    content?: unknown;
    noReply?: boolean;
    delivered?: boolean;
    meta?: Record<string, unknown>;
  }) => {
    const rid = String(params.runId ?? '').trim();
    if (!rid) return;
    const content = typeof params.content === 'string'
      ? params.content
      : String(params.content ?? '');
    if (!content.trim()) return;
    const batch = ensureAssistantBridgeBatch(rid, userObjective || '');
    if (!batch) return;
    batch.responses.push({
      phase: String(params.phase || 'unknown'),
      content,
      noReply: params.noReply === true,
      delivered: params.delivered === true,
      ts: Date.now(),
      meta: params.meta && typeof params.meta === 'object' ? params.meta : {}
    });
    runtimeProtocolTracker.consume({
      type: 'assistant_delivery',
      runId: rid,
      phase: String(params.phase || 'unknown'),
      noReply: params.noReply === true,
      delivered: params.delivered === true,
      contentLength: content.length,
      content,
      ts: Date.now(),
      meta: params.meta && typeof params.meta === 'object' ? params.meta : {}
    });

    if (params.noReply !== true && params.delivered === true) {
      const timerId = assistantBridgeRealtimeFlushTimers.get(rid);
      if (!timerId) {
        const t = setTimeout(() => {
          assistantBridgeRealtimeFlushTimers.delete(rid);
          flushAssistantBridgeRun(rid, ASSISTANT_BRIDGE_FLUSH_REASON.realtimeDelivery).catch((e) => {
            logger.debug(tMessagePipeline('response_bridge_realtime_flush_failed'), { runId: rid, err: String(e) });
          });
        }, 80);
        assistantBridgeRealtimeFlushTimers.set(rid, t);
      }
    }
  };

  const flushAssistantBridgeRun = async (
    runIdLike: unknown,
    reason: string,
    options?: { round?: number; requireAck?: boolean }
  ) => {
    const rid = String(runIdLike ?? '').trim();
    if (!rid) return;
    const batch = assistantBridgeBatches.get(rid);
    const pendingResponses = batch ? batch.responses.slice(batch.lastSentIndex) : [];
    const isFeedbackEvalFlush = options?.requireAck === true && reason === ASSISTANT_BRIDGE_FLUSH_REASON.feedbackWait;
    const feedbackResponses = (() => {
      if (!batch || !isFeedbackEvalFlush) return [];
      const start = Math.max(0, Math.min(Number(batch.lastFeedbackSentIndex || 0), batch.responses.length));
      return batch.responses.slice(start);
    })();
    const responsesToReport = isFeedbackEvalFlush ? feedbackResponses : pendingResponses;
    const roundRaw = Number(options?.round);
    const round = Number.isFinite(roundRaw) ? Math.max(0, Math.floor(roundRaw)) : 0;
    let flushedCount = 0;

    if (batch && responsesToReport.length && sdk && typeof sdk.reportAssistantResponsesBatch === 'function') {
      try {
        const report = await sdk.reportAssistantResponsesBatch({
          runId: rid,
          responses: responsesToReport,
          objective: batch.objective || String(userObjective || ''),
          reason,
          context: {
            conversationId,
            channelId,
            identityKey,
            groupId,
            userId: userid,
            orchestratorRunId,
            parentRunId: orchestratorRunId,
            feedbackRound: round
          }
        });
        batch.lastSentIndex = batch.responses.length;
        if (isFeedbackEvalFlush) {
          batch.lastFeedbackSentIndex = batch.responses.length;
        }
        flushedCount = Number.isFinite(Number((report as { count?: number })?.count))
          ? Number((report as { count?: number })?.count)
          : responsesToReport.length;
      } catch (e) {
        logger.warn(tMessagePipeline('response_bridge_flush_failed'), { runId: rid, reason, err: String(e) });
      }
    } else if (batch && isFeedbackEvalFlush && responsesToReport.length === 0) {
      // feedback round saw no new assistant responses; mark current boundary to avoid carrying old responses into next round
      batch.lastFeedbackSentIndex = batch.responses.length;
    }

    if (options?.requireAck && sdk && typeof sdk.reportFeedbackFlushDone === 'function') {
      try {
        logger.debug('ResponseBridge: feedback flush ack begin', {
          runId: rid,
          round,
          reason,
          flushedCount,
          pendingResponses: responsesToReport.length
        });
        await sdk.reportFeedbackFlushDone({
          runId: rid,
          round,
          reason,
          flushedCount,
          context: {
            conversationId,
            channelId,
            identityKey,
            groupId,
            userId: userid,
            orchestratorRunId,
            parentRunId: orchestratorRunId
          }
        });
        runtimeProtocolTracker.consume({
          type: 'feedback_flush_done',
          runId: rid,
          round,
          reason,
          flushedCount,
          ts: Date.now()
        });
        logger.debug('ResponseBridge: feedback flush ack done', {
          runId: rid,
          round,
          reason,
          flushedCount
        });
      } catch (e) {
        logger.warn(tMessagePipeline('response_bridge_feedback_flush_done_failed'), { runId: rid, round, err: String(e) });
      }
    } else if (options?.requireAck) {
      logger.warn('ResponseBridge: feedback flush ack unavailable', {
        runId: rid,
        hasSdk: !!sdk,
        hasMethod: !!(sdk && typeof sdk.reportFeedbackFlushDone === 'function')
      });
    }
  };

  const flushAllAssistantBridgeRuns = async (reason: string) => {
    const timers = Array.from(assistantBridgeRealtimeFlushTimers.values());
    for (const t of timers) {
      try { clearTimeout(t); } catch { }
    }
    assistantBridgeRealtimeFlushTimers.clear();

    const runIds = Array.from(assistantBridgeBatches.keys());
    for (const rid of runIds) {
      await flushAssistantBridgeRun(rid, reason);
    }
  };

  const collectAssistantResponsesForCompletionAnalysis = (): CompletionAssistantResponseTraceItem[] => {
    const out: CompletionAssistantResponseTraceItem[] = [];
    for (const [runId, batch] of assistantBridgeBatches.entries()) {
      const responses = Array.isArray(batch?.responses) ? batch.responses : [];
      for (const item of responses) {
        if (!item || typeof item !== 'object') continue;
        const content = typeof item.content === 'string' ? item.content : String(item.content ?? '');
        if (!content.trim()) continue;
        out.push({
          runId: String(runId || ''),
          phase: String(item.phase || 'unknown'),
          content,
          noReply: item.noReply === true,
          delivered: item.delivered === true,
          ts: typeof item.ts === 'number' && Number.isFinite(item.ts) ? item.ts : 0,
          meta: item.meta && typeof item.meta === 'object' ? item.meta : {}
        });
      }
    }
    out.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.runId !== b.runId) return a.runId.localeCompare(b.runId);
      return a.phase.localeCompare(b.phase);
    });
    return mergeAssistantResponsesForAnalysis(out);
  };

  const isPreFeedbackResponseForCompletionAnalysis = (
    phaseLike: unknown,
    metaLike: unknown
  ): boolean => {
    const phase = String(phaseLike || '').trim().toLowerCase();
    const meta = metaLike && typeof metaLike === 'object'
      ? metaLike as Record<string, unknown>
      : {};
    const stage = String(meta.stage || '').trim().toLowerCase();

    if (phase === PIPELINE_RESPONSE_PHASE.toolPreReply) return true;
    if (phase === PIPELINE_RESPONSE_PHASE.delayAck) return true;
    if (phase.startsWith('delay_deferred_')) return true;

    if (stage === PIPELINE_RESPONSE_STAGE.toolPreReply) return true;
    if (stage === PIPELINE_RESPONSE_STAGE.delayPreReply) return true;
    if (stage === PIPELINE_RESPONSE_STAGE.delayQueue) return true;

    return false;
  };

  const backfillCompletionEvidenceFromCheckpoint = async (
    liveRuntimeProtocol: RuntimeProtocolSnapshot,
    liveAssistantResponses: CompletionAssistantResponseTraceItem[]
  ): Promise<{
    runtimeProtocol: RuntimeProtocolSnapshot;
    assistantResponses: CompletionAssistantResponseTraceItem[];
    checkpointRunIds: string[];
  }> => {
    let mergedRuntimeProtocol = normalizeRuntimeProtocolSnapshotForMerge(liveRuntimeProtocol);
    let mergedAssistantResponses = mergeAssistantResponsesForAnalysis(liveAssistantResponses);
    const touchedRunIds: string[] = [];
    if (typeof loadRuntimeRunCheckpointSnapshot !== 'function') {
      mergedAssistantResponses = mergeAssistantResponsesForAnalysis(
        mergedAssistantResponses,
        buildAssistantResponsesFromRuntimeProtocolPreview(mergedRuntimeProtocol)
      );
      return {
        runtimeProtocol: mergedRuntimeProtocol,
        assistantResponses: mergedAssistantResponses,
        checkpointRunIds: touchedRunIds
      };
    }

    const queue: string[] = [];
    const visited = new Set<string>();
    const enqueue = (runIdLike: unknown) => {
      const rid = String(runIdLike || '').trim();
      if (!rid) return;
      if (visited.has(rid)) return;
      if (queue.includes(rid)) return;
      queue.push(rid);
    };

    enqueue(orchestratorRunId);
    enqueue(currentRunId);
    enqueue(runtimeResumeRunId);
    for (const childRunId of orchestratorChildRunIds.values()) {
      enqueue(childRunId);
    }

    const maxScan = 64;
    while (queue.length > 0 && visited.size < maxScan) {
      const rid = String(queue.shift() || '').trim();
      if (!rid || visited.has(rid)) continue;
      visited.add(rid);
      try {
        const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: rid });
        if (!checkpoint || typeof checkpoint !== 'object') continue;
        touchedRunIds.push(rid);
        const checkpointObj = checkpoint as Record<string, unknown>;
        const checkpointProtocol = extractRuntimeProtocolFromCheckpoint(checkpointObj);
        if (checkpointProtocol) {
          mergedRuntimeProtocol = mergeRuntimeProtocolSnapshots(mergedRuntimeProtocol, checkpointProtocol);
        }
        const checkpointResponses = extractAssistantResponsesFromCheckpoint(checkpointObj);
        if (checkpointResponses.length > 0) {
          mergedAssistantResponses = mergeAssistantResponsesForAnalysis(
            mergedAssistantResponses,
            checkpointResponses
          );
        }
        const childRunIds = Array.isArray(checkpointObj.childRunIds)
          ? checkpointObj.childRunIds
          : [];
        for (const childRunId of childRunIds) {
          enqueue(childRunId);
        }
        enqueue(checkpointObj.orchestratorRunId);
        enqueue(checkpointObj.parentRunId);
        const runLineage = toRecordObjectMaybe(checkpointObj.runLineage);
        if (runLineage) {
          enqueue(runLineage.orchestratorRunId);
          enqueue(runLineage.parentRunId);
        }
      } catch (e) {
        logger.debug('completion analysis checkpoint backfill failed', {
          runId: rid,
          groupId,
          err: String(e)
        });
      }
    }

    mergedAssistantResponses = mergeAssistantResponsesForAnalysis(
      mergedAssistantResponses,
      buildAssistantResponsesFromRuntimeProtocolPreview(mergedRuntimeProtocol)
    );

    return {
      runtimeProtocol: mergedRuntimeProtocol,
      assistantResponses: mergedAssistantResponses,
      checkpointRunIds: touchedRunIds
    };
  };

  const stableJson = (value: unknown): string => {
    const seen = new WeakSet<object>();
    const encode = (v: unknown): unknown => {
      if (v == null) return v;
      if (Array.isArray(v)) return v.map(encode);
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        if (seen.has(obj)) return '[Circular]';
        seen.add(obj);
        const sortedKeys = Object.keys(obj).sort();
        const out: Record<string, unknown> = {};
        for (const key of sortedKeys) {
          out[key] = encode(obj[key]);
        }
        return out;
      }
      return v;
    };
    try {
      return JSON.stringify(encode(value));
    } catch {
      return '';
    }
  };

  const toNum = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  type ToolInvocationIdentity = {
    stepId?: string;
    plannedStepIndex?: number | null;
    stepIndex?: number | null;
    executionIndex?: number | null;
  };

  const buildToolInvocationKey = (
    toolName: string,
    toolArgs: Record<string, ParamValue> | undefined,
    identity: ToolInvocationIdentity,
    fallbackSeq: number
  ): string => {
    const stepId = typeof identity?.stepId === 'string' ? identity.stepId.trim() : '';
    const planned = toNum(identity?.plannedStepIndex);
    const step = toNum(identity?.stepIndex);
    const exec = toNum(identity?.executionIndex);
    const argsHash = stableJson(toolArgs || {});
    if (stepId || planned != null || step != null || exec != null) {
      return `${toolName}|sid:${stepId || ''}|p:${planned ?? ''}|s:${step ?? ''}|e:${exec ?? ''}|a:${argsHash}`;
    }
    return `${toolName}|a:${argsHash}|seq:${fallbackSeq}`;
  };

  const recordToolInvocationForCompletionAnalysis = (
    toolName: string,
    toolArgs: Record<string, ParamValue> | undefined,
    identity: ToolInvocationIdentity
  ) => {
    if (!toolName) return;
    const key = buildToolInvocationKey(toolName, toolArgs, identity, toolTurnResultEvents.length + toolTurnInvocations.length);
    if (toolTurnInvocationSet.has(key)) return;
    toolTurnInvocationSet.add(key);
    const invocation: ToolInvocation = toolArgs
      ? { aiName: toolName, args: toolArgs }
      : { aiName: toolName };
    toolTurnInvocations.push(invocation);
  };

  const recordToolTurnEventForCompletionAnalysis = (evLike: ToolResultEvent) => {
    if (!evLike || typeof evLike !== 'object') return;
    runtimeProtocolTracker.ingestToolResult(evLike);
    const idx = typeof evLike.plannedStepIndex === 'number'
      ? evLike.plannedStepIndex
      : (typeof evLike.stepIndex === 'number' ? evLike.stepIndex : null);
    const protocolMatch = runtimeProtocolTracker.matchToolResult(evLike);
    const cached = idx != null ? pendingToolArgsByStepIndex.get(idx) : null;
    const toolName = typeof cached?.aiName === 'string'
      ? cached.aiName
      : (typeof protocolMatch?.aiName === 'string' && protocolMatch.aiName
        ? protocolMatch.aiName
        : (typeof evLike.aiName === 'string' ? evLike.aiName : ''));
    const toolArgs = cached?.args && typeof cached.args === 'object'
      ? cached.args
      : (protocolMatch?.args && typeof protocolMatch.args === 'object'
        ? (protocolMatch.args as Record<string, ParamValue>)
        : (evLike.args && typeof evLike.args === 'object' ? (evLike.args as Record<string, ParamValue>) : undefined));

    recordToolInvocationForCompletionAnalysis(toolName, toolArgs, {
      stepId: typeof evLike.stepId === 'string' ? evLike.stepId : '',
      plannedStepIndex: typeof evLike.plannedStepIndex === 'number' ? evLike.plannedStepIndex : null,
      stepIndex: typeof evLike.stepIndex === 'number' ? evLike.stepIndex : null,
      executionIndex: typeof evLike.executionIndex === 'number' ? evLike.executionIndex : null
    });

    if (idx != null) {
      pendingToolArgsByStepIndex.delete(idx);
    }

    toolTurnResultEvents.push(evLike);
    completionAnalysisHasToolCalled = true;
  };

  type RuntimeProtocolHandler = (payload: RuntimeProtocolConsumeResult) => boolean;
  const runtimeProtocolHandlers: Record<string, RuntimeProtocolHandler> = {
    action_request: (payload) => {
      if (payload.kind !== 'action_request') return false;
      const req = payload.record;
      const stepIdx = req.stepIndex != null ? req.stepIndex : req.plannedStepIndex;
      if (stepIdx != null && stepIdx >= 0) {
        const entry: { aiName?: string; args?: Record<string, ParamValue> } = {};
        if (req.aiName) entry.aiName = req.aiName;
        if (req.args && typeof req.args === 'object') {
          entry.args = req.args as Record<string, ParamValue>;
        }
        pendingToolArgsByStepIndex.set(stepIdx, entry);
      }
      if (req.aiName) {
        recordToolInvocationForCompletionAnalysis(
          req.aiName,
          (req.args && typeof req.args === 'object') ? (req.args as Record<string, ParamValue>) : undefined,
          {
            stepId: req.stepId || '',
            plannedStepIndex: req.plannedStepIndex,
            stepIndex: req.stepIndex,
            executionIndex: req.executionIndex
          }
        );
      }
      return true;
    },
    tool_gate: (payload) => payload.kind === 'tool_gate',
    step_state: (payload) => payload.kind === 'step_state',
    workspace_diff: (payload) => payload.kind === 'workspace_diff',
    assistant_delivery: (payload) => payload.kind === 'assistant_delivery',
    feedback_cycle: (payload) => {
      if (payload.kind !== 'feedback_cycle') return false;
      const phase = String(payload.record?.phase || '').trim().toLowerCase();
      // feedback_wait 需要继续流经事件分支，以触发 flush+ack 上报，不能在协议层提前消费掉。
      if (phase === 'feedback_wait') return false;
      return true;
    },
    orchestrator_state: (payload) => payload.kind === 'orchestrator_state'
  };

  // 从 proactive root 指令 XML 中提取 <objective> 文本，用作 MCP objective。
  const extractObjectiveFromRoot = (xml: string | null | undefined): string | null => {
    if (!xml || typeof xml !== 'string') return null;
    const inner = String(extractXMLTag(xml, 'objective') || '').trim();
    if (!inner) return null;
    // 折叠多行，避免 objective 过长影响日志可读性。
    const flat = inner.replace(/\s+/g, ' ').trim();
    return flat || null;
  };

  let activeSkillsProtocolRunId = '';
  let activeSkillsProtocolFinalized = true;
  let orchestratorRunStarted = false;
  let orchestratorRunFinalized = false;
  let orchestratorRunFinalStatus: string = 'completed';
  let orchestratorRunFinalReasonCode: string = ORCHESTRATOR_RUNTIME_OUTCOME_CODE.completed;
  let orchestratorRunFinalNote: string = '';
  let orchestratorProtocolEventSincePersist = 0;
  let orchestratorProtocolLastPersistTs = 0;
  const ORCHESTRATOR_PROTOCOL_PERSIST_MIN_EVENTS = 8;
  const ORCHESTRATOR_PROTOCOL_PERSIST_MIN_INTERVAL_MS = 1500;
  const orchestratorStateMachine = new RunStateMachine({
    orchestratorRunId,
    initialStatus: 'running',
    initialReasonCode: 'orchestrator_initialized',
    initialNote: ''
  });

  const ensureOrchestratorRuntimeStarted = async (objectiveText: unknown) => {
    if (orchestratorRunStarted) return;
    orchestratorRunStarted = true;
    runtimeProtocolTracker.consume({
      type: 'orchestrator_state',
      runId: orchestratorRunId,
      state: 'running',
      status: 'running',
      reasonCode: 'orchestrator_started',
      note: '',
      childRunCount: orchestratorStateMachine.listChildRunIds().length,
      ts: Date.now()
    });
    await persistRuntimeProtocolStateSafe({
      op: 'start',
      runId: orchestratorRunId,
      objective: String(objectiveText || ''),
      source: 'message_pipeline_orchestrator'
    });
  };
  const registerOrchestratorChildRun = (runIdLike: unknown) => {
    const rid = String(runIdLike ?? '').trim();
    if (!rid) return;
    if (rid === orchestratorRunId) return;
    orchestratorChildRunIds.add(rid);
    orchestratorStateMachine.startChildRun(rid);
  };
  const setOrchestratorOutcome = ({
    status,
    reasonCode,
    note
  }: {
    status?: string;
    reasonCode?: string;
    note?: string;
  }) => {
    const outcome = orchestratorStateMachine.setOutcome({
      status: String(status || '').trim().toLowerCase(),
      reasonCode: String(reasonCode || '').trim(),
      note: String(note || '').trim()
    });
    orchestratorRunFinalStatus = String(outcome.status || orchestratorRunFinalStatus || 'completed');
    orchestratorRunFinalReasonCode = String(outcome.reasonCode || orchestratorRunFinalReasonCode || '');
    orchestratorRunFinalNote = String(outcome.note || orchestratorRunFinalNote || '');
    runtimeProtocolTracker.consume({
      type: 'orchestrator_state',
      runId: orchestratorRunId,
      state: String(orchestratorRunFinalStatus || 'completed'),
      status: String(orchestratorRunFinalStatus || 'completed'),
      reasonCode: String(orchestratorRunFinalReasonCode || ''),
      note: String(orchestratorRunFinalNote || ''),
      childRunCount: orchestratorStateMachine.listChildRunIds().length,
      ts: Date.now()
    });
  };
  const maybePersistOrchestratorProtocolCheckpoint = async (trigger: string, force = false) => {
    if (!orchestratorRunStarted || orchestratorRunFinalized) return;
    const nowTs = Date.now();
    if (!force) {
      if (orchestratorProtocolEventSincePersist < ORCHESTRATOR_PROTOCOL_PERSIST_MIN_EVENTS) return;
      if ((nowTs - orchestratorProtocolLastPersistTs) < ORCHESTRATOR_PROTOCOL_PERSIST_MIN_INTERVAL_MS) return;
    }
    const snapshot = runtimeProtocolTracker.snapshot();
    const assistantResponsesSnapshot = compactAssistantResponsesForCheckpoint(
      collectAssistantResponsesForCompletionAnalysis(),
      128
    );
    await persistRuntimeProtocolStateSafe({
      op: 'checkpoint',
      runId: orchestratorRunId,
      patch: {
        stage: 'orchestrator_protocol',
        status: String(orchestratorRunFinalStatus || 'running'),
        runtimeProtocol: snapshot,
        assistantResponses: assistantResponsesSnapshot,
        activeChildRunId: String(currentRunId || '')
      },
      event: {
        type: 'orchestrator_protocol_snapshot',
        trigger: String(trigger || ''),
        assistantResponseCount: assistantResponsesSnapshot.length,
        activeChildRunId: String(currentRunId || '')
      },
      source: 'message_pipeline_orchestrator'
    });
    orchestratorProtocolLastPersistTs = nowTs;
    orchestratorProtocolEventSincePersist = 0;
  };
  const registerOrchestratorChildOutcome = (params: {
    runId: unknown;
    status?: unknown;
    reasonCode?: unknown;
    note?: unknown;
    resultCode?: unknown;
  }) => {
    const runId = String(params?.runId ?? '').trim();
    if (!runId || runId === orchestratorRunId) return;
    registerOrchestratorChildRun(runId);
    orchestratorStateMachine.setChildOutcome({
      runId,
      status: String(params?.status ?? '').trim().toLowerCase() || 'completed',
      reasonCode: String(params?.reasonCode ?? '').trim(),
      note: String(params?.note ?? '').trim(),
      resultCode: String(params?.resultCode ?? '').trim()
    });
  };
  const buildSkillsFinalActionResultPayload = (params: {
    runId: string;
    success: boolean;
    resultCode: string;
    reasonCode: string;
    note: string;
    stage: string;
  }): {
    inputArgs: Record<string, unknown>;
    outputData: Record<string, unknown>;
    outputProvider: string;
    evidence: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    metrics: Record<string, unknown>;
    errorClass: string;
    retryable: boolean;
  } => {
    const runId = String(params.runId || '').trim();
    const allResponses = collectAssistantResponsesForCompletionAnalysis();
    const responses = runId
      ? allResponses.filter((item) => String(item.runId || '').trim() === runId)
      : allResponses;
    const delivered = responses.filter((item) => item.delivered === true);
    const noReply = responses.filter((item) => item.noReply === true);
    const visibleDelivered = delivered.filter((item) => {
      if (item.noReply === true) return false;
      if (!String(item.content || '').trim()) return false;
      return !isPreFeedbackResponseForCompletionAnalysis(item.phase, item.meta);
    });
    const latestVisible = visibleDelivered.length > 0 ? visibleDelivered[visibleDelivered.length - 1] : null;
    const latestVisiblePreview = latestVisible
      ? clipMemoryText(String(latestVisible.content || '').trim(), 240)
      : '';
    const evidence: Array<Record<string, unknown>> = [
      {
        kind: 'skills_round_status',
        stage: String(params.stage || ''),
        reasonCode: String(params.reasonCode || ''),
        resultCode: String(params.resultCode || ''),
        success: params.success === true,
        deferred: endedBySchedule === true,
        hasReplied: hasReplied === true,
        hasRealtimeToolFeedback: hasRealtimeToolFeedback === true
      },
      {
        kind: 'assistant_delivery_stats',
        runId,
        totalResponses: responses.length,
        deliveredResponses: delivered.length,
        visibleDeliveredResponses: visibleDelivered.length,
        noReplyResponses: noReply.length
      }
    ];
    if (latestVisiblePreview) {
      evidence.push({
        kind: 'assistant_visible_response_preview',
        phase: String(latestVisible?.phase || ''),
        delivered: latestVisible?.delivered === true,
        preview: latestVisiblePreview
      });
    }
    return {
      inputArgs: {
        route: 'skills',
        mode: 'dialogue_reply'
      },
      outputData: {
        stage: String(params.stage || ''),
        reasonCode: String(params.reasonCode || ''),
        resultCode: String(params.resultCode || ''),
        note: String(params.note || ''),
        runId,
        responseCount: responses.length,
        visibleDeliveredCount: visibleDelivered.length,
        deferred: endedBySchedule === true
      },
      outputProvider: 'runtime_skills',
      evidence,
      artifacts: [],
      metrics: {
        elapsedMs: 0,
        responseCount: responses.length,
        toolInvocationCount: toolTurnInvocations.length,
        toolResultCount: toolTurnResultEvents.length
      },
      errorClass: params.success ? '' : 'skills_round_failure',
      retryable: false
    };
  };
  const finalizeSkillsProtocolState = async (params: {
    runId: string;
    success: boolean;
    resultCode: string;
    reasonCode: string;
    note: string;
    stage?: string;
  }) => {
    const runId = String(params.runId || '').trim();
    if (!runId) return;
    const reasonCode = String(params.reasonCode || '').trim();
    const resultCode = String(params.resultCode || '').trim();
    const note = String(params.note || '').trim();
    const stage = String(params.stage || SKILLS_PROTOCOL_STAGE.final).trim() || SKILLS_PROTOCOL_STAGE.final;
    const finalPayload = buildSkillsFinalActionResultPayload({
      runId,
      success: params.success === true,
      resultCode,
      reasonCode,
      note,
      stage
    });

    const events = buildSkillsDispatchFinalEvents({
      runId,
      success: params.success === true,
      resultCode,
      reasonCode,
      reason: note,
      inputArgs: finalPayload.inputArgs,
      outputData: finalPayload.outputData,
      outputProvider: finalPayload.outputProvider,
      evidence: finalPayload.evidence,
      artifacts: finalPayload.artifacts,
      metrics: finalPayload.metrics,
      errorClass: finalPayload.errorClass,
      retryable: finalPayload.retryable
    });
    for (const event of events) {
      runtimeProtocolTracker.consume(event);
      if (event && typeof event === 'object' && String((event as { type?: unknown }).type || '').trim() === 'tool_result') {
        try {
          recordToolTurnEventForCompletionAnalysis(event as ToolResultEvent);
        } catch { }
      }
    }
    const snapshot = runtimeProtocolTracker.snapshot();
    await persistRuntimeProtocolStateSafe({
      op: 'checkpoint',
      runId,
      patch: {
        stage,
        status: params.success ? 'completed' : 'failed',
        lastReasonCode: reasonCode,
        resultCode,
        skillsActionResult: {
          ok: params.success === true,
          code: resultCode,
          errorClass: finalPayload.errorClass,
          retryable: finalPayload.retryable,
          action: {
            aiName: SKILLS_RUNTIME_ACTION,
            executor: SKILLS_RUNTIME_EXECUTOR,
            actionRef: SKILLS_RUNTIME_ACTION,
            stepId: SKILLS_RUNTIME_STEP_ID
          },
          status: {
            success: params.success === true,
            code: resultCode,
            message: note
          },
          inputArgs: finalPayload.inputArgs,
          outputData: finalPayload.outputData,
          outputProvider: finalPayload.outputProvider,
          evidence: finalPayload.evidence,
          artifacts: finalPayload.artifacts,
          metrics: finalPayload.metrics
        },
        runtimeProtocol: snapshot
      },
      event: {
        type: 'skills_protocol_finalized',
        success: params.success === true,
        resultCode,
        reasonCode,
        note
      },
      source: 'message_pipeline_skills'
    });
    await persistRuntimeProtocolStateSafe({
      op: 'final',
      runId,
      status: params.success ? 'completed' : 'failed',
      reasonCode,
      source: 'message_pipeline_skills',
      note,
      objective: String(userObjective || '')
    });
    registerOrchestratorChildOutcome({
      runId,
      status: params.success ? 'completed' : 'failed',
      reasonCode,
      note,
      resultCode
    });
  };
  const finalizeOrchestratorRuntime = async () => {
    if (!orchestratorRunStarted || orchestratorRunFinalized) return;
    await maybePersistOrchestratorProtocolCheckpoint('orchestrator_finalize_start', true);
    if (orchestratorRunFinalStatus !== 'failed') {
      if (endedBySchedule) {
        setOrchestratorOutcome({
          status: 'completed',
          reasonCode: ORCHESTRATOR_RUNTIME_OUTCOME_CODE.deferred,
          note: orchestratorRunFinalNote || 'response deferred to delay runtime queue'
        });
      } else {
        const childStates = orchestratorStateMachine.listChildRunStates();
        const hasFailedChild = childStates.some((x) => String(x?.status || '').toLowerCase() === 'failed');
        if (hasFailedChild && !hasReplied && !lastRealtimeToolResponse) {
          setOrchestratorOutcome({
            status: 'failed',
            reasonCode: ORCHESTRATOR_RUNTIME_OUTCOME_CODE.childFailed,
            note: orchestratorRunFinalNote || 'child runtime run failed and no assistant reply was delivered'
          });
        } else {
          setOrchestratorOutcome({
            status: 'completed',
            reasonCode: orchestratorRunFinalReasonCode || ORCHESTRATOR_RUNTIME_OUTCOME_CODE.completed,
            note: orchestratorRunFinalNote
          });
        }
      }
    }
    const childRuns = orchestratorStateMachine.listChildRunIds();
    const orchestratorStepStates = orchestratorStateMachine.listChildStepStates();
    const orchestratorStepStateCount = orchestratorStateMachine.countChildStepStates();
    const childRunStates = orchestratorStateMachine.listChildRunStates();
    const childRunStatusCount = orchestratorStateMachine.countChildRunStatus();
    const finalRuntimeProtocolSnapshot = runtimeProtocolTracker.snapshot();
    const finalAssistantResponsesSnapshot = compactAssistantResponsesForCheckpoint(
      collectAssistantResponsesForCompletionAnalysis(),
      160
    );
    await persistRuntimeProtocolStateSafe({
      op: 'checkpoint',
      runId: orchestratorRunId,
      patch: {
        stage: 'orchestrator_round_final',
        status: String(orchestratorRunFinalStatus || 'completed'),
        childRunIds: childRuns,
        childRunCount: childRuns.length,
        orchestratorStepStates,
        orchestratorStepStateCount,
        childRunStates,
        childRunStatusCount,
        runtimeProtocol: finalRuntimeProtocolSnapshot,
        assistantResponses: finalAssistantResponsesSnapshot,
        activeChildRunId: String(currentRunId || '')
      },
      event: {
        type: 'orchestrator_child_runs_snapshot',
        childRunIds: childRuns,
        childRunCount: childRuns.length,
        orchestratorStepStates,
        orchestratorStepStateCount,
        childRunStates,
        childRunStatusCount,
        assistantResponseCount: finalAssistantResponsesSnapshot.length,
        activeChildRunId: String(currentRunId || '')
      },
      source: 'message_pipeline_orchestrator'
    });
    orchestratorRunFinalized = true;
    await persistRuntimeProtocolStateSafe({
      op: 'final',
      runId: orchestratorRunId,
      status: String(orchestratorRunFinalStatus || 'completed'),
      reasonCode: String(orchestratorRunFinalReasonCode || ORCHESTRATOR_RUNTIME_OUTCOME_CODE.completed),
      note: String(orchestratorRunFinalNote || ''),
      objective: String(userObjective || ''),
      source: 'message_pipeline_orchestrator'
    });
  };

  try {
    // 步骤1：将该 sender 的消息从 pending 移到 processing，避免处理中丢失补充消息。
    await historyManager.startProcessingMessages(groupId, userid);

    // 步骤2：读取该 sender 的全部消息（pending + processing）。
    const getAllSenderMessages = (): MsgLike[] => {
      return historyManager.getPendingMessagesBySender(groupId, userid);
    };

    // 获取该 sender 的全部消息。
    let senderMessages: MsgLike[] = getAllSenderMessages();
    // 主动回合下队列可能为空，回退使用当前 msg。
    if (isProactive && (!Array.isArray(senderMessages) || senderMessages.length === 0)) {
      senderMessages = [msg];
    }

    // 构建拼接内容：按时间顺序串联同 sender 的消息，保留任务演进轨迹。
    const buildConcatenatedContent = (messages: MsgLike[]) => {
      const pickContent = (m: MsgLike) => {
        if (!m) return '';
        const segText = extractTextFromMessageLike(m);
        const o =
          typeof m.objective === 'string' && m.objective.trim()
            ? m.objective.trim()
            : '';
        const t =
          typeof m.text === 'string' && m.text.trim() ? m.text.trim() : '';
        const s =
          typeof m.summary === 'string' && m.summary.trim()
            ? m.summary.trim()
            : '';
        return segText || t || o || s || '';
      };

      if (messages.length === 0) {
        return pickContent(msg);
      }
      // 用空行拼接并保留时间戳，便于模型理解顺序。
      return messages
        .map((m: MsgLike) => {
          const timeStr = m.time_str || '';
          const content = pickContent(m);
          if (!content) return '';
          return timeStr ? `[${timeStr}] ${content}` : content;
        })
        .filter(Boolean)
        .join('\n\n');
    };

    // objective 生成策略：
    // 1) 主动回合优先用 root 里的 <objective>；
    // 2) 否则使用用户消息拼接内容，保证各阶段意图一致。
    userObjective = null;
    if (isMergedGroup) {
      const mergedLines: string[] = [];
      const mergedList = mergedUsers || [];
      mergedList.forEach((u, idx) => {
        const name = String(u?.sender_name || u?.nickname || u?.name || `User${idx + 1}`).trim();
        const raw = (u?.raw && typeof u.raw === 'object')
          ? (u.raw as Record<string, unknown>)
          : {};
        const baseText = (
          extractTextFromMessageLike(u) ||
          (typeof u?.text === 'string' && u.text.trim()) ||
          (typeof raw.objective === 'string' && raw.objective.trim()) ||
          (typeof raw.text === 'string' && raw.text.trim()) ||
          (typeof raw.summary === 'string' && raw.summary.trim()) ||
          (typeof u?.summary === 'string' && u.summary.trim()) ||
          ''
        );
        if (!baseText) return;
        mergedLines.push(name ? `${name}: ${baseText}` : baseText);
      });
      const mergedText = mergedLines.join('\n\n');
      userObjective = mergedText || buildConcatenatedContent(senderMessages);
    } else if (isProactive && proactiveRootXml) {
      userObjective = extractObjectiveFromRoot(proactiveRootXml) || buildConcatenatedContent(senderMessages);
    } else {
      userObjective = buildConcatenatedContent(senderMessages);
    }
    if (runtimeResumeEnabled && runtimeResumeObjective) {
      userObjective = runtimeResumeObjective;
      logger.info('runtime resume objective restored from checkpoint', {
        groupId,
        runId: runtimeResumeRunId || null,
        objectiveLength: String(runtimeResumeObjective || '').length,
        cursorIndex: runtimeResumeCursorIndex
      });
    }

    // 构建 MCP 对话上下文：
    // 1) 历史工具上下文；
    // 2) 当前用户输入（Sentra XML）。
    // 若当前输入带时间表达式，优先筛时间窗口内历史再补最近上下文。
    const timeText = (extractTextFromMessageLike(msg) || msg?.text || msg?.summary || '').trim();

    const mcpMaxPairs = typeof MCP_MAX_CONTEXT_PAIRS === 'number' ? MCP_MAX_CONTEXT_PAIRS : undefined;
    const contextPairsLimit =
      Number.isFinite(mcpMaxPairs) && (mcpMaxPairs as number) > 0
        ? (mcpMaxPairs as number)
        : historyManager.maxConversationPairs || 20;

    const contextTokensLimit = getEnvInt('MCP_MAX_CONTEXT_TOKENS', 0) || 0;

    const isGroupChat = isGroupScopeId(groupId);
    let historyConversations = historyManager.getConversationHistoryForContext(groupId, {
      recentPairs: contextPairsLimit,
      maxTokens: contextTokensLimit,
      senderId: isGroupChat ? userid : null
    });
    try {
      if (timeText) {
        const hasTime = timeParser.containsTimeExpression(timeText, { language: 'zh-cn' });
        if (hasTime) {
          logger.info(tMessagePipeline('time_expr_detected', { text: timeText }));
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
              recentPairs: contextPairsLimit,
              maxTokens: contextTokensLimit,
              senderId: isGroupChat ? userid : null
            });
            if (Array.isArray(enhancedHistory)) {
              if (enhancedHistory.length > 0) {
                historyConversations = enhancedHistory;
                logger.info(
                  tMessagePipeline('time_window_hit', {
                    groupId,
                    start: fmtStart,
                    end: fmtEnd,
                    historyCount: historyConversations.length,
                    limit: contextPairsLimit
                  })
                );
              } else {
                logger.info(
                  tMessagePipeline('time_window_no_history', {
                    groupId,
                    start: fmtStart,
                    end: fmtEnd,
                    historyCount: historyConversations.length,
                    limit: contextPairsLimit
                  })
                );
              }
            }
          } else {
            logger.info(tMessagePipeline('time_parse_failed_keep_history', { groupId }));
          }
        } else {
          logger.debug(tMessagePipeline('time_expr_not_detected', { groupId, text: timeText }));
        }
      }
    } catch (e) {
      logger.warn(tMessagePipeline('time_parse_or_filter_failed', { groupId }), { err: String(e) });
    }

    // 主动回合后续延展：仅依赖 root + 系统上下文，不再注入逐条历史，避免过度黏住最近一句。
    const effectiveHistoryConversations = isProactive && !isProactiveFirst ? [] : historyConversations;

    const mcpHistory = convertHistoryToMCPFormat(effectiveHistoryConversations);

    // 复用构建逻辑：pending-messages（如有）+ sentra-input（当前消息）。
    const latestMsg = senderMessages[senderMessages.length - 1] || msg;
    let userContentNoRootForRouter = '';

    if (isProactive && !isProactiveFirst) {
      // 主动回合后续：仅依赖 root 与系统上下文，不重复注入用户问题。
      const bundled = combineRootAndSnapshot(proactiveRootXml, '');
      currentUserContent = bundled.apiContent;
      currentUserContentSnapshot = bundled.snapshotContent;
      userContentNoRootForRouter = '';
    } else {
      // 群聊：pendingContextXml 含“其他成员 + 当前用户累计消息”；私聊仅当前用户历史。
      const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
      const baseUserMsg = isMergedGroup ? msg : latestMsg;
      const combinedUserContent = buildSentraInputBlock({
        currentMessage: baseUserMsg,
        pendingMessagesXml: pendingContextXml || ''
      });
      userContentNoRootForRouter = combinedUserContent;
      const bundled = combineRootAndSnapshot(proactiveRootXml, combinedUserContent);
      currentUserContent = bundled.apiContent;
      currentUserContentSnapshot = bundled.snapshotContent;
    }

    let conversation: ChatMessage[] = [];

    // 获取用户画像（启用时）。
    let personaContext = '';
    if (personaManager && userid) {
      personaContext = personaManager.formatPersonaForContext(userid);
      if (personaContext) {
        logger.debug(tMessagePipeline('persona_loaded', { userId: userid }));
      }
    }

    // 获取近期情绪（用于 <sentra-emo>）。
    let emoXml = '';
    try {
      const emoEnabled = getEnvBool('SENTRA_EMO_ENABLED', false);
      if (emoEnabled && emo && userid) {
        const emoStartAt = Date.now();
        logger.debug(tMessagePipeline('emo_start_user_analytics'), { userid });
        const ua = await emo.userAnalytics(userid, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
        logger.debug(tMessagePipeline('emo_user_analytics_done'), { userid, ms: Date.now() - emoStartAt });
      }
    } catch (e) {
      logger.warn(tMessagePipeline('emo_user_analytics_failed_ignored'), { err: String(e) });
    }

    const agentPresetXml = AGENT_PRESET_XML || '';

    const resolveBaseSystem = async (requiredOutput: string, runtimeOptions?: Record<string, unknown>) => {
      try {
        const base = ctx && Object.prototype.hasOwnProperty.call(ctx, 'baseSystem') ? ctx.baseSystem : '';
        if (typeof base === 'function') {
          const r = await base(requiredOutput, runtimeOptions);
          return typeof r === 'string' ? r : String(r ?? '');
        }
        return typeof base === 'string' ? base : String(base ?? '');
      } catch {
        return '';
      }
    };

    const worldbookXml = WORLDBOOK_XML || '';

    let ragBlock = '';
    const ragEnabled = getEnvBool('ENABLE_RAG', true);
    const ragCfg = ragEnabled ? ragRuntimeConfig() : null;
    {
      if (!ragEnabled || !ragCfg) {
        logger.info(tMessagePipeline('rag_disabled'), { conversationId });
      } else {
        const cfg = ragCfg;
        logger.info(tMessagePipeline('rag_pipeline_reached'), { conversationId });

        const fallbackQueryRaw = String(extractTextFromMessageLike(msg) || msg?.text || msg?.summary || '').trim();
        const queryText = normalizeRagQueryText(userObjective) || normalizeRagQueryText(fallbackQueryRaw);
        if (queryText) {
          logger.info(tMessagePipeline('rag_attempting_retrieval'), {
            conversationId,
            queryPreview: queryText.length > 120 ? queryText.substring(0, 120) : queryText
          });
          const cacheKey = `${conversationId}::${queryText}`;
          const cached = ragCacheByConversation.get(cacheKey);
          if (cached && typeof cached === 'object' && Number.isFinite(cached.at) && cached.block) {
            if (Date.now() - cached.at <= cfg.cacheTtlMs) {
              ragBlock = cached.block;
              logger.info(tMessagePipeline('rag_cache_hit'), { conversationId });
            } else {
              ragCacheByConversation.delete(cacheKey);
            }
          }

          if (!ragBlock) {
            try {
              const rag = await withTimeout(getRagSdk(), cfg.timeoutMs);
              const keywords = extractRagKeywords(queryText, cfg.keywordTopN);

              if (Array.isArray(keywords) && keywords.length > 0) {
                logger.info(tMessagePipeline('rag_keywords'), { conversationId, keywords: keywords.join(', ') });
              }

              const hybridPromise = rag.getContextHybrid(queryText);
              const keywordPromises = keywords.map((k) =>
                rag.getContextFromFulltext(k, { limit: cfg.keywordFulltextLimit, expandParent: true })
              );

              const settled = await withTimeout(
                Promise.allSettled([hybridPromise, ...keywordPromises]),
                cfg.timeoutMs
              );

              const hybridRes = settled[0] && settled[0].status === 'fulfilled' ? settled[0].value : null;
              const extraChunks: RagChunk[] = [];
              const extraContexts: string[] = [];
              for (let i = 1; i < settled.length; i++) {
                const it = settled[i];
                if (it && it.status === 'fulfilled' && it.value) {
                  if (Array.isArray(it.value.chunks)) {
                    extraChunks.push(...it.value.chunks);
                  }
                  if (it.value.contextText) {
                    extraContexts.push(String(it.value.contextText || '').trim());
                  }
                }
              }

              const mergedChunks: RagChunk[] = [];
              const seenChunks = new Set<string>();
              const pushChunk = (c: RagChunk) => {
                const text = String(c?.rawText || c?.text || '').trim();
                if (!text || seenChunks.has(text)) return;
                seenChunks.add(text);
                mergedChunks.push(c);
              };

              if (hybridRes && Array.isArray(hybridRes.chunks)) {
                for (const c of hybridRes.chunks) {
                  pushChunk(c);
                }
              }

              if (extraChunks.length > 0) {
                for (const c of extraChunks) {
                  pushChunk(c);
                }
              }

              const mergedExtra = Array.from(new Set(extraContexts.filter(Boolean))).join('\n\n');
              const mergedContext = [
                hybridRes && hybridRes.contextText ? String(hybridRes.contextText || '').trim() : '',
                mergedExtra
              ]
                .filter(Boolean)
                .join('\n\n')
                .trim();

              if (!mergedContext) {
                logger.info(tMessagePipeline('rag_retrieval_done_no_context'), {
                  conversationId,
                  keywords: Array.isArray(keywords) ? keywords.join(', ') : ''
                });
              }

              ragBlock = buildRagSystemBlock({
                queryText,
                contextText: mergedContext,
                chunks: mergedChunks,
                stats: hybridRes && hybridRes.stats ? hybridRes.stats : null,
                maxCharsPerItem: cfg.maxContextCharsPerItem,
                maxItems: cfg.maxContextItems
              });

              if (ragBlock) {
                ragCacheByConversation.set(cacheKey, { at: Date.now(), block: ragBlock });
                logger.info(tMessagePipeline('rag_context_injected'), {
                  conversationId,
                  queryPreview: queryText.length > 120 ? queryText.substring(0, 120) : queryText
                });
                logger.info(tMessagePipeline('rag_context_preview'), {
                  conversationId,
                  contextChars: mergedContext ? String(mergedContext).length : 0,
                  preview: mergedContext && String(mergedContext).length > 320
                    ? String(mergedContext).substring(0, 320)
                    : String(mergedContext || '')
                });
              } else {
                logger.info(tMessagePipeline('rag_empty_block'), { conversationId });
              }
            } catch (e) {
              logger.warn(tMessagePipeline('rag_retrieval_failed_ignored'), { err: String(e) });
            }
          }
        } else {
          logger.info(tMessagePipeline('rag_skip_empty_query'), { conversationId });
        }
      }
    }

    let socialXml = '';
    try {
      if (ctx && ctx.socialContextManager && typeof ctx.socialContextManager.getXml === 'function') {
        socialXml = await ctx.socialContextManager.getXml();
      }
    } catch { }

    let memoryUserPack = '';
    if (CONTEXT_MEMORY_ENABLED) {
      try {
        const memoryXml = await getDailyContextMemoryXml(groupId);
        if (memoryXml) {
          logger.debug(tMessagePipeline('daily_context_memory_loaded', { groupId }));
          memoryUserPack = buildSentraMemoryPackXml(memoryXml, groupId);
        }
      } catch (e) {
        logger.debug(tMessagePipeline('context_memory_load_failed', { groupId }), { err: String(e) });
      }
    }

    const currentUserTs = resolveTimestampMsFromRecord(msg) ?? Date.now();
    conversation = composeRuntimeConversationMessages({
      historyMessages: mcpHistory as Array<ChatMessage & { timestamp?: number }>,
      memoryPackXml: memoryUserPack,
      currentUserContent,
      currentUserTimestampMs: currentUserTs,
      timezone: 'Asia/Shanghai'
    });
    logger.debug(
      `MCP context ${groupId}: history=${effectiveHistoryConversations.length} (limit=${contextPairsLimit}) -> mcpHistory=${mcpHistory.length} + memory=${memoryUserPack ? 1 : 0} + current=1 => total=${conversation.length}`
    );

    // 组合系统提示词：baseSystem + persona + emo + social + worldbook + agent-preset + rag。
    const runtimeSkillContextBuilder = createRuntimeSkillContextBuilder();

    type RuntimeSystemHint = {
      stage?: string;
      userText?: string;
      toolText?: string;
    };

    const hashSignal = (text: string): string => {
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    };

    const getRuntimeSystemHintKey = (hint?: RuntimeSystemHint): string => {
      if (!hint) return 'none';
      const stage = String(hint.stage || 'runtime').trim().toLowerCase();
      const user = String(hint.userText || '').trim();
      const tool = String(hint.toolText || '').trim();
      const joined = `${stage}\n${user}\n${tool}`;
      if (!joined.trim()) return `${stage}:empty`;
      return `${stage}:${hashSignal(joined)}`;
    };

    const systemContentCache = new Map<string, string>();
    const getSystemContent = async (requiredOutput: string, hint?: RuntimeSystemHint) => {
      const key = typeof requiredOutput === 'string' ? requiredOutput : 'auto';
      const cacheKey = `${key}|${getRuntimeSystemHintKey(hint)}`;
      if (systemContentCache.has(cacheKey)) return systemContentCache.get(cacheKey) as string;
      const runtimeSkillAugment = await runtimeSkillContextBuilder.getSystemAugment(key, hint);
      const baseSystemText = await resolveBaseSystem(key, {
        dynamic_skill_refs: runtimeSkillAugment.refs,
        dynamic_skill_stage: hint?.stage || 'runtime',
        dynamic_skill_block: runtimeSkillAugment.dynamicSkillBlock
      });
      const parts = [
        baseSystemText,
        personaContext,
        emoXml,
        socialXml,
        worldbookXml,
        agentPresetXml,
        ragBlock
      ].filter(Boolean);
      const out = parts.join('\n\n');
      systemContentCache.set(cacheKey, out);
      return out;
    };

    const rebuildConversationsWithSystem = async (
      requiredOutput: string,
      conv: ChatMessage[],
      hint?: RuntimeSystemHint
    ): Promise<ChatMessage[]> => {
      const src = Array.isArray(conv) ? conv : [];
      const rest = src.length > 0 && src[0] && src[0].role === 'system'
        ? src.filter((_, idx) => idx > 0)
        : src;
      return [{ role: 'system', content: await getSystemContent(requiredOutput, hint) }, ...rest] as ChatMessage[];
    };

    const systemContent = await getSystemContent('auto', {
      stage: 'bootstrap',
      userText: userContentNoRootForRouter || currentUserContent
    });

    const buildChatWithRetryOptions = (expectedOutput: string): { model?: string; __sentraExpectedOutput?: string } => {
      const opts: { model?: string; __sentraExpectedOutput?: string } = { __sentraExpectedOutput: expectedOutput };
      if (MAIN_AI_MODEL) {
        opts.model = MAIN_AI_MODEL;
      }
      return opts;
    };

    const maybeRewriteSentraMessage = async (rawResponse: string) => {
      try {
        if (!rawResponse || typeof rawResponse !== 'string') return null;

        if (
          !historyManager ||
          typeof historyManager.getLastAssistantMessageContent !== 'function'
        ) {
          return null;
        }

        const previousContent = historyManager.getLastAssistantMessageContent(groupId);
        if (!previousContent || typeof previousContent !== 'string') {
          return null;
        }

        let prevParsed;
        let currParsed;
        try {
          prevParsed = parseSentraMessage(previousContent);
          currParsed = parseSentraMessage(rawResponse);
        } catch (e) {
          logger.debug(tMessagePipeline('rewrite_parse_failed_skip'), {
            err: String(e)
          });
          return null;
        }

        const prevTextSegments = Array.isArray(prevParsed.textSegments)
          ? prevParsed.textSegments
          : [];
        const currTextSegments = Array.isArray(currParsed.textSegments)
          ? currParsed.textSegments
          : [];

        const prevText = prevTextSegments.join('\n\n').trim();
        const currText = currTextSegments.join('\n\n').trim();

        if (!prevText || !currText) {
          return null;
        }

        // 资源集合必须完全一致，才认为是“同一条消息下的复述”。
        const resourcesEqual = areResourceSetsEqual(prevParsed.resources ?? [], currParsed.resources ?? []);
        if (!resourcesEqual) {
          return null;
        }

        const sim = await judgeReplySimilarity(prevText, currText);
        if (!sim || !sim.areSimilar) {
          return null;
        }

        logger.info(tMessagePipeline('rewrite_detected_high_similarity'), {
          groupId,
          similarity: sim.similarity,
          source: sim.source
        });

        const rootXml = buildRewriteRootDirectiveXml(previousContent, rawResponse);
        const convForRewrite: ChatMessage[] = [
          {
            role: 'system',
            content: await getSystemContent('must_be_sentra_message', {
              stage: 'rewrite_round',
              userText: rootXml
            })
          },
          { role: 'user', content: rootXml }
        ];

        const rewriteResult = await chatWithRetry(
          convForRewrite,
          buildChatWithRetryOptions('sentra_message'),
          groupId
        );
        if (!rewriteResult || !rewriteResult.success || !rewriteResult.response) {
          logger.warn(tMessagePipeline('rewrite_call_failed_fallback'), {
            reason: rewriteResult?.reason || 'unknown'
          });
          return null;
        }

        const rewritten = rewriteResult.response;

        let parsedRewritten;
        try {
          parsedRewritten = parseSentraMessage(rewritten);
        } catch (e) {
          logger.warn(tMessagePipeline('rewrite_parse_failed_fallback'), {
            err: String(e)
          });
          return null;
        }

        const rewrittenTextSegments = Array.isArray(parsedRewritten.textSegments)
          ? parsedRewritten.textSegments
          : [];
        const rewrittenText = rewrittenTextSegments.join('\n\n').trim();

        if (parsedRewritten.shouldSkip || !rewrittenText) {
          logger.warn(tMessagePipeline('rewrite_empty_or_skip_abort'));
          return null;
        }

        // 可选：改写后再做一次相似度检测，避免仍然高度相似。
        try {
          const simAfter = await judgeReplySimilarity(prevText, rewrittenText);
          if (
            simAfter &&
            simAfter.areSimilar &&
            simAfter.similarity != null &&
            (sim.similarity == null || simAfter.similarity >= sim.similarity)
          ) {
            logger.info(tMessagePipeline('rewrite_still_similar_fallback'), {
              similarityBefore: sim.similarity,
              similarityAfter: simAfter.similarity
            });
            return null;
          }
        } catch { }

        logger.info(tMessagePipeline('rewrite_success_use_rewritten'));
        return rewritten;
      } catch (e) {
        logger.warn(tMessagePipeline('rewrite_runtime_error_skip'), {
          err: String(e)
        });
        return null;
      }
    };

    let conversations: ChatMessage[] = [{ role: 'system', content: systemContent }, ...conversation];
    const baseGlobalOverlay = AGENT_PRESET_PLAIN_TEXT || AGENT_PRESET_RAW_TEXT || '';
    let overlays;
    if (isProactive) {
      overlays = {
        global: baseGlobalOverlay,
        plan:
          'This is a proactive round. Prioritize root-directive objective and produce natural persona-aligned chat content. Never expose tool/protocol/process narration.',
        arggen:
          'For proactive rounds, prefer lightweight tool arguments that can provide concrete new signals. Final user-facing text must not mention tool execution internals.',
        judge:
          'Prefer plans that provide new information or useful perspective. Reject low-value repetitive continuation or process narration outputs.',
        final_judge:
          'Final proactive reply should contain actual value and stay persona-aligned. If output becomes low-value or process-like, prefer noReply=true.'
      };
    } else {
      overlays = { global: baseGlobalOverlay };
    }
    const sendAndWaitWithConv = (m: MsgLike) => {
      type OutgoingMsg = MsgLike & { requestId?: string };
      const mm: OutgoingMsg = (m || {}) as OutgoingMsg;
      if (!mm.requestId) {
        try {
          mm.requestId = `${convId || randomUUID()}:${randomUUID()}`;
        } catch {
          mm.requestId = `${Date.now()}_${Math.random().toString(16).replace(/^0\./, '')}`;
        }
      }
      return sendAndWaitResult(mm);
    };

    // 记录初始消息数量。
    const initialMessageCount = senderMessages.length;
    const replyAnchorMsg = senderMessages[senderMessages.length - 1] || msg;

    const sendDelayPreReplyIfNeeded = async () => {
      if (!hasDelayAction || hasDelayPreReplySent) return;
      if (hasToolPreReplied || hasRealtimeToolFeedback || toolResultArrived) return;
      const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
      const delayUserContentNoRoot = buildSentraInputBlock({
        currentMessage: replyAnchorMsg,
        pendingMessagesXml: pendingContextXml || ''
      });
      const delayPreReplyJudgeSummary = [
        'Delay pre-reply required.',
        delayWhenText ? `Target delay expression: ${delayWhenText}.` : '',
        delayTargetISO ? `Target ISO time: ${delayTargetISO}.` : '',
        'Send one concise acknowledgement now; final full reply will be produced at due time.'
      ]
        .filter(Boolean)
        .join(' ');
      const preReplyRaw = await generateToolPreReply({
        chatWithRetry,
        baseConversations: await rebuildConversationsWithSystem('must_be_sentra_message', conversations, {
          stage: 'delay_prereply',
          userText: delayUserContentNoRoot
        }),
        userContentNoRoot: delayUserContentNoRoot,
        judgeSummary: delayPreReplyJudgeSummary,
        toolNames: ['delay_runtime'],
        timeoutMs: getEnvTimeoutMs('TOOL_PREREPLY_TIMEOUT_MS', 180000, 900000),
        ...(groupId != null ? { groupId } : {}),
        ...(MAIN_AI_MODEL ? { model: MAIN_AI_MODEL } : {}),
        ...(proactiveRootXml ? { originalRootXml: proactiveRootXml } : {})
      });
      if (!preReplyRaw) {
        logger.warn(tMessagePipeline('delay_pre_reply_generation_empty'), { groupId, runId: currentRunId || null });
        return;
      }
      const preReplyXml = ensureSentraMessageHasTarget(preReplyRaw, msg);
      try {
        const sendResult = await smartSend(
          replyAnchorMsg,
          preReplyXml,
          sendAndWaitWithConv,
          true,
          { hasTool: true, immediate: true }
        );
        const deliveredSegmentIds = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
        const deliveredMessageId = extractDeliveredMessageIdFromSendResult(sendResult);
        const preReplyDeliveredXml = deliveredSegmentIds.length > 0
          ? applySentraMessageSegmentMessageIds(preReplyXml, deliveredSegmentIds)
          : (deliveredMessageId
            ? applySentraMessageSegmentMessageId(preReplyXml, deliveredMessageId)
            : preReplyXml);
        hasReplied = true;
        hasToolPreReplied = true;
        hasDelayPreReplySent = true;
        markReplySentForConversation(conversationId);
        const preReplyForHistory = normalizeAssistantContentForHistory(preReplyDeliveredXml);
        try {
          const preReplyPairId = isGroupChat
            ? await historyManager.startAssistantMessage(groupId, {
              commitMode: 'scoped',
              scopeSenderId: userid
            })
            : await historyManager.startAssistantMessage(groupId);
          await historyManager.appendToAssistantMessage(groupId, preReplyForHistory, preReplyPairId);
          const preReplyUserForHistory = pickSnapshotContent(
            delayUserContentNoRoot || currentUserContentSnapshot,
            buildSentraInputBlock({ currentMessage: replyAnchorMsg })
          );
          const savedPreReply = await historyManager.finishConversationPair(
            groupId,
            preReplyPairId,
            preReplyUserForHistory
          );
          if (savedPreReply && !isGroupChat) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            triggerContextSummarizationIfNeeded({
              groupId,
              chatType,
              userId: userIdForMemory
            }).catch((e) => {
              logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
            });
            triggerPresetTeachingIfNeeded({
              groupId,
              chatType,
              userId: userIdForMemory,
              userContent: preReplyUserForHistory,
              assistantContent: preReplyForHistory
            }).catch((e) => {
              logger.debug(tMessagePipeline('preset_teaching_async_failed', { groupId }), { err: String(e) });
            });
          }
        } catch (e) {
          logger.debug(tMessagePipeline('delay_pre_reply_save_failed'), { groupId, err: String(e) });
        }
        recordAssistantBridgeResponse({
          runId: currentRunId,
          phase: PIPELINE_RESPONSE_PHASE.delayAck,
          content: preReplyDeliveredXml,
          noReply: false,
          delivered: true,
          meta: {
            stage: PIPELINE_RESPONSE_STAGE.delayPreReply,
            delay_when: delayWhenText,
            target_iso: delayTargetISO
          }
        });
      } catch (e) {
        logger.warn(tMessagePipeline('delay_pre_reply_send_failed'), { err: String(e), groupId });
      }
    };

    const normalizeDeferredToolEvents = (
      items: Array<ToolResultEvent | DelayReplayToolResultEvent>
    ): DelayReplayToolResultEvent[] => {
      const out: DelayReplayToolResultEvent[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const src = item as Record<string, unknown>;
        const normalized: DelayReplayToolResultEvent = {
          ...src,
          type: typeof src.type === 'string' ? src.type : 'tool_result'
        };
        if (Array.isArray(src.events)) {
          normalized.events = src.events
            .filter((x) => x && typeof x === 'object')
            .map((x) => ({ ...(x as Record<string, unknown>) }));
        }
        out.push(normalized);
      }
      return out;
    };

    const logDelayRuntime = (
      level: 'debug' | 'info' | 'warn',
      phase: string,
      extra?: Record<string, unknown>
    ) => {
      const payload: Record<string, unknown> = {
        conversationId,
        groupId,
        sessionId: delaySessionId || null,
        runId: currentRunId || delayReplayRunId || null,
        hasDelayAction,
        isDelayReplayDue,
        buffering: hasDelayAction ? delayBufferingEnabled : false,
        phase
      };
      if (extra && typeof extra === 'object') {
        Object.assign(payload, extra);
      }
      logger[level](tMessagePipeline('delay_runtime_event'), payload);
    };

    const toFiniteInt = (value: unknown, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : fallback;
    };

    const buildDelayRuntimeSessionCheckpointRecord = () => {
      if (!hasDelayAction || !delaySessionId) return null;
      const snapshot = getDelayRuntimeSessionSnapshot(delaySessionId);
      if (!snapshot) return null;
      const bufferedEvents = Array.isArray(snapshot.bufferedEvents)
        ? snapshot.bufferedEvents
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({ ...(x as Record<string, unknown>) }))
        : [];
      const reasonArgs = (snapshot.reasonArgs && typeof snapshot.reasonArgs === 'object' && !Array.isArray(snapshot.reasonArgs))
        ? { ...(snapshot.reasonArgs as Record<string, unknown>) }
        : {};
      const baseMessage = (snapshot.baseMessage && typeof snapshot.baseMessage === 'object' && !Array.isArray(snapshot.baseMessage))
        ? { ...(snapshot.baseMessage as Record<string, unknown>) }
        : null;
      const replayCursorRaw = (snapshot.replayCursor && typeof snapshot.replayCursor === 'object' && !Array.isArray(snapshot.replayCursor))
        ? (snapshot.replayCursor as Record<string, unknown>)
        : {};
      return {
        sessionId: String(snapshot.sessionId || delaySessionId).trim(),
        createdAt: toFiniteInt(snapshot.createdAt, 0),
        fireAt: toFiniteInt(snapshot.fireAt, parsedDelayFireAt > 0 ? parsedDelayFireAt : Date.now()),
        dueFiredAt: toFiniteInt(snapshot.dueFiredAt, 0),
        completedAt: toFiniteInt(snapshot.completedAt, 0),
        runId: String(snapshot.runId || currentRunId || '').trim(),
        type: String(snapshot.type || msg?.type || (msg?.group_id ? 'group' : 'private') || '').trim(),
        groupId: String(snapshot.groupId || msg?.group_id || '').trim(),
        userId: String(snapshot.userId || userid || '').trim(),
        senderId: String(snapshot.senderId || userid || '').trim(),
        delayWhenText: String(snapshot.delayWhenText || delayWhenText || '').trim(),
        delayTargetISO: String(snapshot.delayTargetISO || delayTargetISO || '').trim(),
        reason: String(snapshot.reason || delayRuntimeReason || '').trim(),
        reasonCode: String(snapshot.reasonCode || delayRuntimeReasonCode || '').trim(),
        reasonArgs,
        deferredResponseXml: String(snapshot.deferredResponseXml || '').trim(),
        bufferedEvents,
        baseMessage,
        replayCursor: {
          nextOffset: toFiniteInt(replayCursorRaw.nextOffset, 0),
          totalEvents: toFiniteInt(replayCursorRaw.totalEvents, bufferedEvents.length),
          status: String(replayCursorRaw.status || '').trim(),
          lastReplayRunId: String(replayCursorRaw.lastReplayRunId || '').trim(),
          updatedAt: toFiniteInt(replayCursorRaw.updatedAt, 0)
        },
        checkpointRunId: '',
        orchestratorRunId: String(orchestratorRunId || '').trim(),
        parentRunId: String(orchestratorRunId || '').trim(),
        updatedAt: Date.now()
      };
    };

    const persistDelayRuntimeSessionCheckpoint = async (trigger: string) => {
      if (!delaySessionId) return;
      const record = buildDelayRuntimeSessionCheckpointRecord();
      if (!record) return;
      const runIds = Array.from(new Set([
        String(orchestratorRunId || '').trim(),
        String(currentRunId || '').trim(),
        String(record.runId || '').trim()
      ].filter(Boolean)));
      if (runIds.length === 0) return;
      for (const runIdForCheckpoint of runIds) {
        await persistRuntimeProtocolStateSafe({
          op: 'checkpoint',
          runId: runIdForCheckpoint,
          patch: {
            delayRuntimeSession: {
              ...record,
              checkpointRunId: runIdForCheckpoint,
              orchestratorRunId: String(orchestratorRunId || runIdForCheckpoint).trim(),
              parentRunId: String(orchestratorRunId || runIdForCheckpoint).trim(),
              updatedAt: Date.now()
            }
          },
          event: {
            type: 'delay_runtime_session_checkpoint',
            trigger: String(trigger || '').trim(),
            sessionId: record.sessionId,
            fireAt: record.fireAt,
            dueFiredAt: record.dueFiredAt,
            completedAt: record.completedAt,
            runId: String(record.runId || '').trim(),
            bufferedEvents: Array.isArray(record.bufferedEvents) ? record.bufferedEvents.length : 0,
            replayNextOffset: Number(record.replayCursor?.nextOffset || 0),
            replayStatus: String(record.replayCursor?.status || '')
          },
          source: 'message_pipeline_delay_runtime'
        });
      }
    };

    const updateDelayReplayCursorState = async (patch: {
      nextOffset?: number;
      totalEvents?: number;
      status?: string;
      lastReplayRunId?: string;
    }) => {
      if (!delaySessionId) return;
      try {
        const current = getDelayRuntimeSessionSnapshot(delaySessionId);
        if (!current) return;
        const baseCursor = (current.replayCursor && typeof current.replayCursor === 'object')
          ? current.replayCursor as Record<string, unknown>
          : {};
        const nextOffsetRaw = patch.nextOffset !== undefined ? Number(patch.nextOffset) : Number(baseCursor.nextOffset);
        const totalEventsRaw = patch.totalEvents !== undefined ? Number(patch.totalEvents) : Number(baseCursor.totalEvents);
        const nextOffset = Number.isFinite(nextOffsetRaw) && nextOffsetRaw >= 0 ? Math.trunc(nextOffsetRaw) : 0;
        const totalEvents = Number.isFinite(totalEventsRaw) && totalEventsRaw >= 0 ? Math.trunc(totalEventsRaw) : 0;
        updateDelayRuntimeSession(delaySessionId, {
          replayCursor: {
            nextOffset,
            totalEvents,
            status: String(patch.status ?? baseCursor.status ?? '').trim(),
            lastReplayRunId: String(patch.lastReplayRunId ?? baseCursor.lastReplayRunId ?? '').trim(),
            updatedAt: Date.now()
          }
        });
        await persistDelayRuntimeSessionCheckpoint('replay_cursor_update');
      } catch (e) {
        logger.debug(tMessagePipeline('delay_runtime_update_run_id_failed'), {
          err: String(e),
          groupId,
          sessionId: delaySessionId
        });
      }
    };

    const syncDelayBufferingFromSession = () => {
      if (!hasDelayAction || !delayBufferingEnabled || !delaySessionId) return;
      if (parsedDelayFireAt > 0 && Date.now() >= parsedDelayFireAt) {
        delayBufferingEnabled = false;
        logger.info(tMessagePipeline('delay_runtime_switched_by_local_timer'), {
          groupId,
          sessionId: delaySessionId,
          runId: currentRunId || null,
          fireAt: parsedDelayFireAt
        });
        return;
      }
      if (!isDelayRuntimeSessionDueFired(delaySessionId)) return;
      delayBufferingEnabled = false;
      logger.info(tMessagePipeline('delay_runtime_switched_due_trigger'), {
        groupId,
        sessionId: delaySessionId,
        runId: currentRunId || null
      });
      void persistDelayRuntimeSessionCheckpoint('sync_due_fired');
    };

    const isDelayBufferingActive = () => {
      syncDelayBufferingFromSession();
      return hasDelayAction && delayBufferingEnabled;
    };

    const ensureDelayRuntimeSessionReady = async (): Promise<boolean> => {
      if (!hasDelayAction || !delaySessionId || typeof enqueueDelayedJob !== 'function') return false;
      if (delayDueTriggerQueued) return true;
      const fireAt = parsedDelayFireAt;
      if (!Number.isFinite(fireAt)) {
        logDelayRuntime('warn', 'session_init_invalid_fire_at', { fireAt: parsedDelayFireAt });
        return false;
      }
      if (fireAt <= Date.now()) {
        delayBufferingEnabled = false;
        logDelayRuntime('warn', 'session_init_fire_at_passed', { fireAt });
        return false;
      }

      try {
        createDelayRuntimeSession({
          sessionId: delaySessionId,
          fireAt,
          runId: currentRunId || '',
          type: msg?.type || (msg?.group_id ? 'group' : 'private'),
          groupId: msg?.group_id || null,
          userId: userid,
          senderId: userid,
          delayWhenText,
          delayTargetISO,
          reason: delayRuntimeReason,
          reasonCode: delayRuntimeReasonCode,
          reasonArgs: delayRuntimeReasonArgs,
          baseMessage: msg && typeof msg === 'object' ? { ...(msg as Record<string, unknown>) } : null
        });
        await persistDelayRuntimeSessionCheckpoint('session_created');

        const dueJob = {
          kind: DELAY_RUNTIME_KIND.dueTriggerJob,
          jobId: delaySessionId,
          delaySessionId,
          runId: currentRunId || null,
          orchestratorRunId: orchestratorRunId || null,
          createdAt: Date.now(),
          fireAt,
          delayMs: Math.max(0, fireAt - Date.now()),
          type: msg?.type || (msg?.group_id ? 'group' : 'private'),
          groupId: msg?.group_id || null,
          userId: userid,
          aiName: DELAY_RUNTIME_AI_NAME.dueTrigger,
          reason: delayRuntimeReason,
          reasonCode: delayRuntimeReasonCode,
          reasonArgs: delayRuntimeReasonArgs,
          delayWhenText,
          delayTargetISO
        };
        await enqueueDelayedJob(dueJob);
        delayDueTriggerQueued = true;
        await persistDelayRuntimeSessionCheckpoint('due_trigger_queued');
        logDelayRuntime('info', 'due_trigger_queued', {
          fireAt,
          delayMs: Math.max(0, fireAt - Date.now()),
          delayWhenText: delayWhenText || null,
          delayTargetISO: delayTargetISO || null
        });
        logger.info(tMessagePipeline('delay_due_trigger_queued'), {
          groupId,
          sessionId: delaySessionId,
          fireAt
        });
        return true;
      } catch (e) {
        logger.warn(tMessagePipeline('delay_runtime_session_init_failed'), {
          err: String(e),
          groupId,
          sessionId: delaySessionId
        });
        delayBufferingEnabled = false;
        return false;
      }
    };

    const appendDelayReplayEventToSession = (event: DelayReplayToolResultEvent) => {
      if (!hasDelayAction || !delaySessionId || !event || typeof event !== 'object') return;
      try {
        appendDelayRuntimeSessionEvent(delaySessionId, event as Record<string, unknown>);
        delayBufferedEventCount++;
        if (delayBufferedEventCount <= 3 || delayBufferedEventCount % 20 === 0) {
          void persistDelayRuntimeSessionCheckpoint('buffered_event');
        }
        if (delayBufferedEventCount <= 3 || delayBufferedEventCount % 20 === 0) {
          logDelayRuntime('debug', 'buffered_result_event', {
            bufferedCount: delayBufferedEventCount,
            eventType: String(event?.type || 'tool_result')
          });
        }
      } catch (e) {
        logger.debug(tMessagePipeline('delay_runtime_append_event_failed'), {
          err: String(e),
          groupId,
          sessionId: delaySessionId
        });
      }
    };

    const enqueueDelayReplayJob = async (params: {
      runId?: string | null;
      deferredResponseXml?: string;
      deferredToolResultEvents?: Array<ToolResultEvent | DelayReplayToolResultEvent>;
      hasTool?: boolean;
      reason?: string;
      reasonCode?: DelayReasonCode | string;
      reasonArgs?: DelayReasonArgs;
      markCompleted?: boolean;
    }): Promise<boolean> => {
      if (!hasDelayAction || !delaySessionId) return false;
      const ready = await ensureDelayRuntimeSessionReady();
      if (!ready) return false;

      const deferredResponseXml = typeof params.deferredResponseXml === 'string'
        ? params.deferredResponseXml.trim()
        : '';
      const deferredToolResultEvents = Array.isArray(params.deferredToolResultEvents)
        ? normalizeDeferredToolEvents(params.deferredToolResultEvents)
        : [];
      const runIdForSession = typeof params.runId === 'string' && params.runId.trim()
        ? params.runId.trim()
        : (typeof currentRunId === 'string' && currentRunId.trim() ? currentRunId.trim() : '');
      const reasonCodeText = normalizeDelayReasonCode(
        typeof params.reasonCode === 'string' && params.reasonCode.trim()
          ? params.reasonCode.trim()
          : (typeof params.reason === 'string' && params.reason.trim()
            ? params.reason.trim()
            : delayRuntimeReasonCode),
        delayRuntimeReasonCode
      );
      const reasonArgs = normalizeDelayReasonArgs(
        params.reasonArgs && typeof params.reasonArgs === 'object'
          ? params.reasonArgs
          : delayRuntimeReasonArgs
      );
      const reasonText = reasonCodeText;

      try {
        const sessionPatch: {
          runId: string;
          reason: string;
          reasonCode: DelayReasonCode;
          reasonArgs: DelayReasonArgs;
          deferredResponseXml?: string;
          replayCursor?: {
            nextOffset: number;
            totalEvents: number;
            status: string;
            lastReplayRunId: string;
            updatedAt: number;
          };
        } = {
          runId: runIdForSession,
          reason: reasonText,
          reasonCode: reasonCodeText,
          reasonArgs,
          replayCursor: {
            nextOffset: 0,
            totalEvents: deferredToolResultEvents.length,
            status: params.markCompleted !== false ? 'queued_completed' : 'queued_pending',
            lastReplayRunId: '',
            updatedAt: Date.now()
          }
        };
        if (deferredResponseXml) {
          sessionPatch.deferredResponseXml = deferredResponseXml;
        }
        updateDelayRuntimeSession(delaySessionId, sessionPatch);
        if (deferredToolResultEvents.length > 0) {
          updateDelayRuntimeSession(delaySessionId, {
            bufferedEvents: deferredToolResultEvents
          });
        }
        if (params.markCompleted !== false) {
          markDelayRuntimeSessionCompleted(delaySessionId, Date.now());
        }
        await persistDelayRuntimeSessionCheckpoint('session_updated');
        logDelayRuntime('info', 'session_state_updated', {
          reason: reasonText,
          reasonCode: reasonCodeText,
          reasonArgs,
          events: deferredToolResultEvents.length,
          hasDeferredResponse: !!deferredResponseXml,
          markCompleted: params.markCompleted !== false
        });
        logger.info(tMessagePipeline('delay_runtime_session_updated'), {
          groupId,
          sessionId: delaySessionId,
          runId: runIdForSession || null,
          reasonCode: reasonCodeText,
          events: deferredToolResultEvents.length,
          hasDeferredResponse: !!deferredResponseXml,
          completed: params.markCompleted !== false
        });
        return true;
      } catch (e) {
        logger.warn(tMessagePipeline('delay_runtime_session_update_failed'), {
          err: String(e),
          groupId,
          sessionId: delaySessionId
        });
        return false;
      }
    };

    if (hasDelayAction) {
      const delayReady = await ensureDelayRuntimeSessionReady();
      if (delayReady && isDelayBufferingActive()) {
        await sendDelayPreReplyIfNeeded();
      } else if (!delayReady) {
        logDelayRuntime('warn', 'session_not_ready_fallback_to_normal');
      }
    }
    if (runtimeResumeEnabled && runtimeResumeRunId) {
      await persistRuntimeProtocolStateSafe({
        op: 'checkpoint',
        runId: runtimeResumeRunId,
        patch: {
          stage: 'runtime_resume_prepare',
          status: 'running',
          runtimeResume: {
            fromCheckpoint: true,
            runId: runtimeResumeRunId,
            loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
            checkpointStage: runtimeResumeStage || '',
            checkpointStatus: runtimeResumeStatus || '',
            lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
            totalSteps: runtimeResumeTotalSteps,
            resumeCursorIndex: runtimeResumeCursorIndex,
            updatedAt: runtimeResumeUpdatedAt
          }
        },
        event: {
          type: 'runtime_resume_prepare',
          fromCheckpoint: true,
          runId: runtimeResumeRunId,
          loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
          checkpointStage: runtimeResumeStage || '',
          checkpointStatus: runtimeResumeStatus || '',
          lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
          totalSteps: runtimeResumeTotalSteps,
          resumeCursorIndex: runtimeResumeCursorIndex,
          updatedAt: runtimeResumeUpdatedAt
        },
        source: 'message_pipeline_runtime_resume'
      });
    }
    await ensureOrchestratorRuntimeStarted(userObjective || currentUserContentSnapshot || currentUserContent || '');

    let forceNeedTools = false;
    let forceSkillsPath = false;
    let mcpExternalReasons: string[] = [];
    if (!isDelayReplayDue) {
      try {
        const routerStartAt = Date.now();
        logger.debug(tMessagePipeline('tool_router_begin'), {
          groupId,
          hasProactiveRoot: !!proactiveRootXml,
          userPreview: String(userContentNoRootForRouter || '').length > 160
            ? String(userContentNoRootForRouter || '').substring(0, 160)
            : String(userContentNoRootForRouter || '')
        });
        const routerSkillHint = {
          stage: 'tool_router',
          userText: userContentNoRootForRouter || currentUserContentSnapshot || currentUserContent
        };
        const routerUserContentForModel = await runtimeSkillContextBuilder.appendRuntimeRoundRootAtBottom({
          mode: 'router',
          stage: 'tool_router',
          userContent: userContentNoRootForRouter || currentUserContentSnapshot || currentUserContent,
          hint: routerSkillHint
        });
        const decision = await decideExecutionPath({
          chatWithRetry,
          baseConversations: await rebuildConversationsWithSystem('router', conversations, {
            stage: 'tool_router',
            userText: routerUserContentForModel
          }),
          userContentNoRoot: routerUserContentForModel,
          timeoutMs: getEnvTimeoutMs('TIMEOUT', 180000, 900000),
          ...(groupId != null ? { groupId } : {}),
          ...(MAIN_AI_MODEL ? { model: MAIN_AI_MODEL } : {}),
          ...(proactiveRootXml ? { originalRootXml: proactiveRootXml } : {})
        });

        const routePath = decision
          ? (decision.path === 'mcp' ? 'mcp' : 'skills')
          : 'skills';
        forceNeedTools = routePath === 'mcp';
        forceSkillsPath = routePath === 'skills';
        mcpExternalReasons = routePath === 'mcp' && Array.isArray(decision?.reasons)
          ? decision.reasons
            .map((x) => (typeof x === 'string' ? x.trim() : ''))
            .filter(Boolean)
          : [];

        logger.debug(tMessagePipeline('tool_router_done'), {
          groupId,
          ms: Date.now() - routerStartAt,
          path: routePath,
          confidence: decision?.confidence ?? null,
          routerReasons: Array.isArray(decision?.reasons) ? decision.reasons : null,
          mcpExternalReasons: mcpExternalReasons.length > 0 ? mcpExternalReasons : null,
          fallback: decision ? null : 'router_null_default_skills'
        });
      } catch (e) {
        logger.debug(tMessagePipeline('tool_router_failed_ignored'), { groupId, err: String(e) });
      }
    }
    if (runtimeResumeEnabled && !isDelayReplayDue) {
      forceNeedTools = true;
      forceSkillsPath = false;
      if (!Array.isArray(mcpExternalReasons)) mcpExternalReasons = [];
      mcpExternalReasons.push(
        `runtime_resume_checkpoint:run_id=${runtimeResumeRunId || 'unknown'} cursor=${runtimeResumeCursorIndex}`
      );
      logger.info('runtime resume forces mcp execution route', {
        groupId,
        runId: runtimeResumeRunId || null,
        cursorIndex: runtimeResumeCursorIndex
      });
    }

    // Judge/ToolResult 最终发送前，可按配置额外等待一小段时间：
    // 1) 等待期间发现新消息 -> 标记 hasSupplementDuringTask=true，触发单次吞吐；
    // 2) 未发现新消息 -> 继续发送当前结果。
    async function maybeWaitForSupplementBeforeSend() {
      const cfg = getSwallowOnSupplementRuntimeConfig();
      if (!cfg.enabled) {
        return;
      }

      const baseMessages = getAllSenderMessages();
      const baseCount = Array.isArray(baseMessages) ? baseMessages.length : 0;

      if (baseCount > initialMessageCount) {
        hasSupplementDuringTask = true;
        ctx.logger.info(
          tMessagePipeline('supplement_wait_already_has_new', {
            groupId,
            initialCount: initialMessageCount,
            baseCount
          })
        );
        return;
      }

      if (cfg.maxWaitMs <= 0) {
        return;
      }

      const maxWait = cfg.maxWaitMs;
      const pollInterval = Math.min(500, Math.max(100, Math.floor(maxWait / 5)));
      const startWaitAt = Date.now();
      ctx.logger.debug(
        tMessagePipeline('supplement_wait_start', {
          groupId,
          maxWait,
          baseCount
        })
      );

      while (Date.now() - startWaitAt < maxWait) {
        await sleep(pollInterval);

        const latest = getAllSenderMessages();
        const latestCount = Array.isArray(latest) ? latest.length : 0;
        if (latestCount > baseCount) {
          hasSupplementDuringTask = true;
          ctx.logger.info(
            tMessagePipeline('supplement_wait_detected_new', {
              groupId,
              baseCount,
              latestCount
            })
          );
          return;
        }
      }

      ctx.logger.debug(
        tMessagePipeline('supplement_wait_no_new_continue', {
          groupId,
          waitMs: Date.now() - startWaitAt
        })
      );
    }

    let streamAttempt = 0;
    while (streamAttempt < 2) {
      let restartMcp = false;
      let restartObjective = null;

      logger.debug(tMessagePipeline('mcp_identity', { groupId, channelId, identityKey }));

      syncDelayBufferingFromSession();
      const useDelayReplayStream = isDelayReplayDue;
      const isDelaySinglePassRuntimeActive = () => isDelayBufferingActive() && !useDelayReplayStream;
      const delayRuntimeControl = isDelaySinglePassRuntimeActive()
        ? {
          skipEvaluation: true,
          skipSummary: true,
          singlePass: true,
          disableAdaptive: true,
          disablePlanRepair: true,
          disablePlanPatch: true,
          disableArgFixRetry: true,
          reason: MCP_RUNTIME_CONTROL_REASON.delayActionExecuteOnce
        }
        : null;
      const delayReplayRunIdForRound = delayReplayRunId || randomUUID();
      if (delayRuntimeControl) {
        logger.info(tMessagePipeline('mcp_runtime_control_enabled_for_delay'), {
          groupId,
          conversationId,
          reason: delayRuntimeControl.reason
        });
      }

      const buildDelayReplayStreamIterator = (): AsyncIterable<StreamEvent> => {
        const replayEventsAll = Array.isArray(delayReplayToolEvents) ? delayReplayToolEvents : [];
        const replayStartOffset = Math.max(0, Math.min(
          Number.isFinite(Number(delayReplayCursorOffset)) ? Math.trunc(Number(delayReplayCursorOffset)) : 0,
          replayEventsAll.length
        ));
        const replayEvents = replayEventsAll.slice(replayStartOffset);
        const replayTotalEvents = Math.max(
          replayEventsAll.length,
          Number.isFinite(Number(delayReplayCursorTotalEvents)) ? Math.trunc(Number(delayReplayCursorTotalEvents)) : 0
        );
        const replayReason = delayReplayReason || delayReplayReasonCode || DELAY_REASON_CODE.dueReplay;
        const deferredResponse = delayReplayDeferredResponse;
        const replayDelayWhen = String(
          delayReplayReasonArgs?.delay_when || delayWhenText || ''
        ).trim();
        const replayDelayTargetIso = String(
          delayReplayReasonArgs?.delay_target_iso || delayTargetISO || ''
        ).trim();
        const buildSyntheticDueReplayEvent = (): StreamEvent => {
          const reasonText = replayDelayWhen
            ? `Delay due now (${replayDelayWhen})`
            : (replayDelayTargetIso ? `Delay due now (${replayDelayTargetIso})` : 'Delay due now');
          const data: Record<string, unknown> = {
            synthetic: true,
            delay_due: true,
            require_user_delivery: true,
            reason_code: delayReplayReasonCode || DELAY_REASON_CODE.dueReplay,
            reason: replayReason
          };
          if (replayDelayWhen) data.delay_when = replayDelayWhen;
          if (replayDelayTargetIso) data.delay_target_iso = replayDelayTargetIso;
          if (deferredResponse) data.has_deferred_response = true;
          return {
            type: 'tool_result',
            runId: delayReplayRunIdForRound,
            aiName: DELAY_RUNTIME_AI_NAME.dueTrigger,
            stepId: 'delay_due_replay',
            plannedStepIndex: 0,
            executionIndex: 0,
            resultStream: 'synthetic',
            resultStatus: 'final',
            reason: reasonText,
            completion: {
              state: 'completed',
              mustAnswerFromResult: true,
              instruction: 'Delay is due. Execute the promised reply now.'
            },
            result: {
              success: true,
              code: 'DELAY_DUE_TRIGGERED',
              provider: 'runtime',
              data
            }
          };
        };
        return (async function* (): AsyncGenerator<StreamEvent> {
          await updateDelayReplayCursorState({
            status: 'replaying',
            totalEvents: replayTotalEvents,
            nextOffset: replayStartOffset,
            lastReplayRunId: delayReplayRunIdForRound
          });
          yield {
            type: 'start',
            runId: delayReplayRunIdForRound,
            objective: userObjective || replayReason
          };

          let replayEmittedCount = 0;
          let replayAbsoluteOffset = replayStartOffset;
          if (replayEvents.length > 0) {
            for (const item of replayEvents) {
              const replayEv = { ...(item as Record<string, unknown>) };
              if (!(typeof replayEv.type === 'string' && replayEv.type.trim())) {
                replayEv.type = 'tool_result';
              }
              if (!(typeof replayEv.runId === 'string' && replayEv.runId.trim())) {
                replayEv.runId = delayReplayRunIdForRound;
              }
              replayEmittedCount += 1;
              replayAbsoluteOffset += 1;
              await updateDelayReplayCursorState({
                status: 'replaying',
                totalEvents: replayTotalEvents,
                nextOffset: replayAbsoluteOffset,
                lastReplayRunId: delayReplayRunIdForRound
              });
              yield replayEv as StreamEvent;
            }
          } else {
            logDelayRuntime('info', 'due_replay_synthesized_tool_result', {
              replayRunId: delayReplayRunIdForRound,
              replayReason: replayReason || null,
              replayDelayWhen: replayDelayWhen || null,
              replayDelayTargetIso: replayDelayTargetIso || null,
              hasDeferredResponse: !!deferredResponse
            });
            replayEmittedCount = 1;
            replayAbsoluteOffset = Math.max(replayAbsoluteOffset, 1);
            await updateDelayReplayCursorState({
              status: 'synthetic_replay',
              totalEvents: replayTotalEvents,
              nextOffset: replayAbsoluteOffset,
              lastReplayRunId: delayReplayRunIdForRound
            });
            yield buildSyntheticDueReplayEvent();
          }

          await updateDelayReplayCursorState({
            status: 'replay_buffer_drained',
            totalEvents: replayTotalEvents,
            nextOffset: replayAbsoluteOffset,
            lastReplayRunId: delayReplayRunIdForRound
          });

          const completedEv: StreamEvent = {
            type: 'completed',
            runId: delayReplayRunIdForRound,
            reason: replayReason,
            exec: {
              attempted: replayEmittedCount,
              succeeded: replayEmittedCount
            }
          };
          if (deferredResponse) completedEv.response = deferredResponse;
          yield completedEv;
        })();
      };

      const willStreamToolsXml = !useDelayReplayStream && !!(
        forceNeedTools &&
        userObjective &&
        userObjective.trim().startsWith('<sentra-tools>') &&
        typeof sdk.streamToolsXml === 'function'
      );
      const useSkillsOnlyStream = !useDelayReplayStream && forceSkillsPath && !forceNeedTools;
      const skillsProtocolRunIdForRound = useSkillsOnlyStream ? `skills_${randomUUID()}` : '';
      if (skillsProtocolRunIdForRound) {
        registerOrchestratorChildRun(skillsProtocolRunIdForRound);
      }
      let skillsProtocolFinalizedForRound = false;
      activeSkillsProtocolRunId = skillsProtocolRunIdForRound;
      activeSkillsProtocolFinalized = !skillsProtocolRunIdForRound;
      const finalizeSkillsProtocolForRound = async (params: {
        success: boolean;
        resultCode: string;
        reasonCode: string;
        note: string;
      }) => {
        if (!skillsProtocolRunIdForRound || skillsProtocolFinalizedForRound) return;
        await finalizeSkillsProtocolState({
          runId: skillsProtocolRunIdForRound,
          success: params.success === true,
          resultCode: String(params.resultCode || '').trim(),
          reasonCode: String(params.reasonCode || '').trim(),
          note: String(params.note || '').trim(),
          stage: SKILLS_PROTOCOL_STAGE.final
        });
        skillsProtocolFinalizedForRound = true;
        activeSkillsProtocolFinalized = true;
      };
      const mcpStreamContext: Record<string, unknown> = {
        orchestratorRunId,
        parentRunId: orchestratorRunId,
        orchestrator_run_id: orchestratorRunId,
        parent_run_id: orchestratorRunId
      };
      if (runtimeResumeEnabled && runtimeResumeRunId) {
        mcpStreamContext.resumeRunId = runtimeResumeRunId;
        mcpStreamContext.resume_run_id = runtimeResumeRunId;
        mcpStreamContext.runId = runtimeResumeRunId;
        mcpStreamContext.run_id = runtimeResumeRunId;
        mcpStreamContext.runtimeResume = {
          fromCheckpoint: true,
          runId: runtimeResumeRunId,
          loadedFromCheckpoint: runtimeResumeLoadedFromCheckpoint,
          checkpointStage: runtimeResumeStage || '',
          checkpointStatus: runtimeResumeStatus || '',
          lastCompletedStepIndex: runtimeResumeLastCompletedStepIndex,
          totalSteps: runtimeResumeTotalSteps,
          resumeCursorIndex: runtimeResumeCursorIndex,
          updatedAt: runtimeResumeUpdatedAt
        };
      }
      if (delayRuntimeControl) {
        mcpStreamContext.runtimeControl = delayRuntimeControl;
      }
      if (Array.isArray(mcpExternalReasons) && mcpExternalReasons.length > 0) {
        mcpStreamContext.externalReasons = mcpExternalReasons;
      }
      if (useSkillsOnlyStream) {
        mcpStreamContext.preferredRoute = 'skills';
      }
      const buildSkillsOnlyStreamIterator = (): AsyncIterable<StreamEvent> => {
        return (async function* () {
          const stream = sdk.stream({
            objective: userObjective,
            conversation,
            context: mcpStreamContext,
            overlays,
            forceNeedTools: false,
            channelId,
            identityKey
          });
          for await (const ev of stream) {
            yield ev;
          }
        })();
      };
      if (useDelayReplayStream) {
        logDelayRuntime('info', 'due_replay_stream_start', {
          replayRunId: delayReplayRunIdForRound,
          replayEvents: delayReplayToolEvents.length,
          hasDeferredResponse: !!delayReplayDeferredResponse,
          replayReason: delayReplayReason || delayReplayReasonCode || DELAY_REASON_CODE.dueReplay,
          replayReasonArgs: delayReplayReasonArgs
        });
        logger.info(tMessagePipeline('delay_replay_due_use_main_pipeline'), {
          groupId,
          runId: delayReplayRunIdForRound,
          replayEvents: delayReplayToolEvents.length,
          hasDeferredResponse: !!delayReplayDeferredResponse
        });
      }
      if (willStreamToolsXml) {
        try {
          const u = String(userObjective || '').trim();
          logger.info(tMessagePipeline('direct_tools_exec_use_stream_tools_xml'), {
            groupId,
            attempt: streamAttempt + 1,
            length: u.length,
            preview: u.length > 160 ? u.substring(0, 160) : u
          });
        } catch { }
      }
      if (useSkillsOnlyStream) {
        logger.info(tMessagePipeline('tool_router_done'), {
          groupId,
          path: 'skills',
          runtime: 'mcp_judge_prefilter'
        });
        await persistRuntimeProtocolStateSafe({
          op: 'start',
          runId: skillsProtocolRunIdForRound,
          objective: String(userObjective || ''),
          status: 'running',
          source: 'message_pipeline_skills'
        });
      }

      const hasMcpStreamContext = Object.keys(mcpStreamContext).length > 0;

      const streamIterator: AsyncIterable<StreamEvent> = useDelayReplayStream
        ? buildDelayReplayStreamIterator()
        : useSkillsOnlyStream
          ? buildSkillsOnlyStreamIterator()
        : willStreamToolsXml
          ? (sdk.streamToolsXml as (params: StreamToolsXmlParams) => AsyncIterable<StreamEvent>)({
            toolsXml: userObjective,
            objective: userObjective,
            conversation,
            ...(hasMcpStreamContext ? { context: mcpStreamContext } : {}),
            overlays,
            channelId,
            identityKey
          })
          : sdk.stream({
            objective: userObjective,
            conversation: conversation,
            ...(hasMcpStreamContext ? { context: mcpStreamContext } : {}),
            overlays,
            forceNeedTools,
            channelId,
            identityKey
          });

      for await (const ev of streamIterator) {
        registerOrchestratorChildRun((ev as { runId?: unknown })?.runId);
        syncDelayBufferingFromSession();
        logger.debug(tMessagePipeline('agent_event'), summarizeStreamEventForLog(ev));

        const protocolConsumed = runtimeProtocolTracker.consume(ev);
        const protocolHandler = runtimeProtocolHandlers[protocolConsumed.kind];
        if (typeof protocolHandler === 'function' && protocolHandler(protocolConsumed)) {
          orchestratorProtocolEventSincePersist += 1;
          await maybePersistOrchestratorProtocolCheckpoint(String(protocolConsumed.kind || 'runtime_protocol'));
          if (skillsProtocolRunIdForRound && !skillsProtocolFinalizedForRound) {
            const snapshot = runtimeProtocolTracker.snapshot();
            await persistRuntimeProtocolStateSafe({
              op: 'checkpoint',
              runId: skillsProtocolRunIdForRound,
              patch: {
                stage: SKILLS_PROTOCOL_STAGE.stream,
                status: 'running',
                runtimeProtocol: snapshot
              },
              event: {
                type: 'skills_protocol_event',
                eventType: String(protocolConsumed.kind || ''),
                runId: skillsProtocolRunIdForRound
              },
              source: 'message_pipeline_skills'
            });
          }
          continue;
        }

        if (ev.type === 'assistant_response_batch') {
          const responses = Array.isArray(ev.responses) ? ev.responses : [];
          for (const item of responses) {
            if (!item || typeof item !== 'object') continue;
            const content = typeof item.content === 'string'
              ? item.content
              : String(item.content ?? '');
            if (!content.trim()) continue;
            const noReply = item.noReply === true;
            const delivered = item.delivered === true;
            if (delivered && !noReply) {
              lastRealtimeToolResponse = content;
            }
          }
          continue;
        }

        const getToolOrderKey = (x: ToolResultEvent): [number, number] => {
          try {
            const planned = (x && typeof x.plannedStepIndex === 'number') ? x.plannedStepIndex : null;
            const step = (x && typeof x.stepIndex === 'number') ? x.stepIndex : null;
            const exec = (x && typeof x.executionIndex === 'number') ? x.executionIndex : null;
            // 排序优先级：plannedStepIndex > stepIndex > executionIndex。
            const a = planned != null ? planned : (step != null ? step : 999999);
            const b = exec != null ? exec : 999999;
            return [a, b];
          } catch {
            return [999999, 999999];
          }
        };

        const sortToolEventsInPlace = (arr: ToolResultEvent[]) => {
          if (!Array.isArray(arr) || arr.length <= 1) return;
          arr.sort((l, r) => {
            const [la, lb] = getToolOrderKey(l);
            const [ra, rb] = getToolOrderKey(r);
            if (la !== ra) return la - ra;
            if (lb !== rb) return lb - rb;
            return 0;
          });
        };

        // start 事件：初始化本轮上下文与缓存。
        if (ev.type === 'start' && ev.runId) {
          currentRunId = ev.runId;
          ensureAssistantBridgeBatch(ev.runId, ev.objective || userObjective || '');
          if (hasDelayAction) {
            logDelayRuntime('info', 'mcp_run_started', {
              mcpRunId: ev.runId,
              objectivePreview: String(ev.objective || '').slice(0, 120)
            });
          }
          // 记录 runId 与会话，用于只取消当前会话内运行。
          trackRunForSender(userid, conversationId, ev.runId);
          if (hasDelayAction && delaySessionId) {
            try {
              updateDelayRuntimeSession(delaySessionId, {
                runId: ev.runId
              });
              await persistDelayRuntimeSessionCheckpoint('mcp_run_started');
            } catch (e) {
              logger.debug(tMessagePipeline('delay_runtime_update_run_id_failed'), {
                err: String(e),
                groupId,
                sessionId: delaySessionId
              });
            }
          }

          // 实时刷新当前 sender 的最新消息列表。
          senderMessages = getAllSenderMessages();

          // 保存消息缓存，便于插件通过 runId 回查 user_id/group_id。
          if (typeof saveMessageCache === 'function') {
            try {
              const cacheMsg = senderMessages[senderMessages.length - 1] || msg;
              await saveMessageCache(ev.runId, cacheMsg);
            } catch (e) {
              logger.debug(
                tMessagePipeline('message_cache_save_failed', {
                  groupId,
                  runId: ev.runId
                }),
                { err: String(e) }
              );
            }
          }

          // 检查处理中是否出现补充消息。
          if (senderMessages.length > initialMessageCount) {
            hasSupplementDuringTask = true;
            logger.info(
              tMessagePipeline('dynamic_context_detected_new_message', {
                groupId,
                initialCount: initialMessageCount,
                currentCount: senderMessages.length
              })
            );
          }
        }

        if (ev.type === 'judge') {
          if (!convId) convId = randomUUID();
          if (!ev.need) {
            const isSkillsJudgeNoToolRound = useSkillsOnlyStream;
            if (isDelayBufferingActive()) {
              await sendDelayPreReplyIfNeeded();
              const runIdForJudge = (typeof ev.runId === 'string' && ev.runId.trim())
                ? ev.runId
                : currentRunId;
              const queued = await enqueueDelayReplayJob({
                runId: runIdForJudge,
                deferredResponseXml: '',
                hasTool: false,
                reasonCode: DELAY_REASON_CODE.judgeReply,
                reasonArgs: delayRuntimeReasonArgs
              });
              if (queued) {
                logDelayRuntime('info', 'judge_no_tools_handoff_to_due_without_generation', {
                  runId: runIdForJudge || null
                });
                await flushAssistantBridgeRun(
                  runIdForJudge,
                  ASSISTANT_BRIDGE_FLUSH_REASON.delayQueuedJudgeNoTools
                );
                if (isSkillsJudgeNoToolRound) {
                  await finalizeSkillsProtocolForRound({
                    success: true,
                    resultCode: SKILLS_RUNTIME_OUTCOME_CODE.deferred,
                    reasonCode: SKILLS_PROTOCOL_REASON.replyDeferred,
                    note: 'skills reply deferred to delay queue'
                  });
                }
                endedBySchedule = true;
                return;
              }
            }
            // 创建本轮 assistant pair。
            pairId = await historyManager.startAssistantMessage(groupId);
            const pairIdPreview = pairId != null ? String(pairId).substring(0, 8) : '';
            logger.debug(tMessagePipeline('create_pair_judge', { groupId, pairId: pairIdPreview }));

            // 实时刷新 sender 消息。
            senderMessages = getAllSenderMessages();

            // 若出现新消息，后续合并全部内容进上下文。
            if (senderMessages.length > initialMessageCount) {
              logger.info(tMessagePipeline('dynamic_context_judge_detected_new_message', { groupId }));
            }

            const latestMsgJudge = senderMessages[senderMessages.length - 1] || msg;

            let judgeBaseContent = '';
            if (isProactive && !isProactiveFirst) {
              // 主动回合后续：不再围绕最新用户消息构造 user-question，仅使用 root 指令。
              judgeBaseContent = '';
              const bundled = combineRootAndSnapshot(proactiveRootXml, '');
              currentUserContent = bundled.apiContent;
              currentUserContentSnapshot = bundled.snapshotContent;
            } else {
              // 获取待处理上下文（群聊含他人+当前用户，私聊仅当前用户）。
              const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
              judgeBaseContent = buildSentraInputBlock({
                currentMessage: latestMsgJudge,
                pendingMessagesXml: contextXml || ''
              });

              const bundled = combineRootAndSnapshot(proactiveRootXml, judgeBaseContent);
              currentUserContent = bundled.apiContent;
              currentUserContentSnapshot = bundled.snapshotContent;
            }

            try {
              if (pairId) {
                await historyManager.appendToConversationPairMessages(
                  groupId,
                  pairId,
                  'user',
                  pickSnapshotContent(currentUserContentSnapshot, judgeBaseContent)
                );
              }
            } catch { }

            const judgeSkillHint = {
              stage: 'judge_round',
              userText: currentUserContentSnapshot || currentUserContent
            };
            const judgeUserContentForModel = await runtimeSkillContextBuilder.appendRuntimeRoundRootAtBottom({
              mode: 'must_be_sentra_message',
              stage: 'judge_round',
              userContent: currentUserContent,
              hint: judgeSkillHint
            });

            const judgeUserTs = resolveTimestampMsFromRecord(latestMsgJudge) ?? Date.now();
            conversations.push(
              appendRuntimeUserMessage(conversations, judgeUserContentForModel, {
                timestampMs: judgeUserTs,
                timezone: 'Asia/Shanghai'
              })
            );
            const result = await chatWithRetry(
              await rebuildConversationsWithSystem('must_be_sentra_message', conversations as ChatMessage[], {
                stage: 'judge_round',
                userText: judgeUserContentForModel
              }),
              buildChatWithRetryOptions('sentra_message'),
              groupId
            );

            if (!result.success) {
              logger.error(
                tMessagePipeline('judge_ai_response_failed', {
                  groupId,
                  reason: result.reason,
                  retries: result.retries
                })
              );
              if (pairId) {
                logger.debug(
                  tMessagePipeline('cancel_pair_judge_failed', {
                    groupId,
                    pairId: String(pairId).substring(0, 8)
                  })
                );
                await historyManager.cancelConversationPairById(groupId, pairId);
                pairId = null;
              }
              if (isGroupChat && userid) {
                try {
                  await historyManager.clearScopedConversationsForSender(groupId, userid);
                } catch { }
              }
              if (isSkillsJudgeNoToolRound) {
                await finalizeSkillsProtocolForRound({
                  success: false,
                  resultCode: SKILLS_RUNTIME_OUTCOME_CODE.failed,
                  reasonCode: SKILLS_PROTOCOL_REASON.judgeFailed,
                  note: String(result.reason || 'judge round failed')
                });
              }
              return;
            }

            if (result.toolsOnly && result.rawToolsXml) {
              const toolsXml = String(result.rawToolsXml || '').trim();
                if (toolsXml) {
                if (isDelaySinglePassRuntimeActive()) {
                  logger.info(tMessagePipeline('tools_only_ignored_delay_single_pass'), {
                    groupId,
                    length: toolsXml.length
                  });
                } else {
                  userObjective = toolsXml;
                  forceNeedTools = true;
                  restartMcp = true;
                  restartObjective = toolsXml;
                  logger.info(tMessagePipeline('tools_only_direct_exec'), {
                    groupId,
                    attempt: streamAttempt + 2,
                    length: toolsXml.length,
                    preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                  });
                }
              }

              if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
                try {
                  sdk.cancelRun(currentRunId, {
                    source: 'message_pipeline',
                    reason: MCP_RESTART_REASON.toolsOnlyRestart,
                    latestUserObjective: String(
                      extractTextFromMessageLike(msg) ||
                      msg?.objective_text ||
                      msg?.summary_text ||
                      msg?.text ||
                      ''
                    ),
                    latestUserObjectiveXml: String(
                      (typeof msg?.objective_xml === 'string' && msg.objective_xml.trim())
                        ? msg.objective_xml
                        : ((typeof msg?.objective === 'string' && msg.objective.trim().startsWith('<'))
                          ? msg.objective
                          : '')
                    ),
                    cancelledBy: userid
                  });
                  try {
                    untrackRunForSender(userid, conversationId, currentRunId);
                  } catch { }
                } catch { }
              }
              currentRunId = null;

              try {
                if (pairId) {
                  await historyManager.cancelConversationPairById(groupId, pairId);
                }
              } catch { }
              pairId = null;

              if (restartMcp) {
                await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.restartForToolsXml);
                if (isSkillsJudgeNoToolRound) {
                  await finalizeSkillsProtocolForRound({
                    success: true,
                    resultCode: SKILLS_RUNTIME_OUTCOME_CODE.deferred,
                    reasonCode: SKILLS_PROTOCOL_REASON.escalatedToTools,
                    note: 'skills round escalated to mcp tools execution'
                  });
                }
                break;
              }
            }

            let response = typeof result.response === 'string' ? result.response : '';
            const noReply = !!result.noReply;
            logger.success(tMessagePipeline('judge_ai_response_success', { groupId, retries: result.retries }));
            if (!response) {
              logger.error(tMessagePipeline('ai_response_empty_judge', { groupId }));
              if (pairId) {
                try {
                  await historyManager.cancelConversationPairById(groupId, pairId);
                } catch { }
                pairId = null;
              }
              if (isGroupChat && userid) {
                try {
                  await historyManager.clearScopedConversationsForSender(groupId, userid);
                } catch { }
              }
              if (isSkillsJudgeNoToolRound) {
                await finalizeSkillsProtocolForRound({
                  success: false,
                  resultCode: SKILLS_RUNTIME_OUTCOME_CODE.empty,
                  reasonCode: SKILLS_PROTOCOL_REASON.replyEmpty,
                  note: 'judge returned empty response'
                });
              }
              return;
            }

            const rewrittenJudge = await maybeRewriteSentraMessage(response);
            if (rewrittenJudge && typeof rewrittenJudge === 'string') {
              response = rewrittenJudge;
            }

            response = ensureSentraMessageHasTarget(response, msg);
            const runIdForJudge = (typeof ev.runId === 'string' && ev.runId.trim())
              ? ev.runId
              : currentRunId;

            if (isDelayBufferingActive()) {
              await sendDelayPreReplyIfNeeded();
              const queued = await enqueueDelayReplayJob({
                runId: runIdForJudge,
                deferredResponseXml: response,
                hasTool: false,
                reasonCode: DELAY_REASON_CODE.judgeReply,
                reasonArgs: delayRuntimeReasonArgs
              });
              if (queued) {
                logDelayRuntime('info', 'judge_reply_handoff_to_due', {
                  runId: runIdForJudge || null,
                  hasDeferredResponse: true
                });
                recordAssistantBridgeResponse({
                  runId: runIdForJudge,
                  phase: PIPELINE_RESPONSE_PHASE.delayDeferredJudge,
                  content: response,
                  noReply: false,
                  delivered: false,
                  meta: { stage: PIPELINE_RESPONSE_STAGE.delayQueue, source: PIPELINE_RESPONSE_STAGE.judgeNoTools }
                });
                if (pairId) {
                  try {
                    await historyManager.cancelConversationPairById(groupId, pairId);
                  } catch { }
                  pairId = null;
                }
                await flushAssistantBridgeRun(runIdForJudge, ASSISTANT_BRIDGE_FLUSH_REASON.delayQueuedJudgeNoTools);
                if (isSkillsJudgeNoToolRound) {
                  await finalizeSkillsProtocolForRound({
                    success: true,
                    resultCode: SKILLS_RUNTIME_OUTCOME_CODE.deferred,
                    reasonCode: SKILLS_PROTOCOL_REASON.replyDeferred,
                    note: 'skills reply queued for delay replay'
                  });
                }
                endedBySchedule = true;
                return;
              }
            }

            recordAssistantBridgeResponse({
              runId: runIdForJudge,
              phase: PIPELINE_RESPONSE_PHASE.judge,
              content: response,
              noReply,
              delivered: !noReply,
              meta: { stage: PIPELINE_RESPONSE_STAGE.judgeNoTools }
            });

            const responseForHistory = normalizeAssistantContentForHistory(response);
            if (pairId) {
              await historyManager.appendToAssistantMessage(groupId, responseForHistory, pairId);
            }

            const latestSenderMessages = getAllSenderMessages();
            if (latestSenderMessages.length > initialMessageCount) {
              hasSupplementDuringTask = true;
              logger.info(
                tMessagePipeline('dynamic_context_judge_detected_supplemental', {
                  groupId,
                  initialCount: initialMessageCount,
                  currentCount: latestSenderMessages.length
                })
              );
            }

            if (!noReply) {
              await maybeWaitForSupplementBeforeSend();

              const finalMsg = replyAnchorMsg;
              const allowReply = true;

              const swallow = shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask);
              if (swallow) {
                logger.info(
                  tMessagePipeline('supplement_swallow_judge', {
                    groupId,
                    conversationId
                  })
                );
              } else {
                logger.debug(
                  tMessagePipeline('judge_quote_send', {
                    groupId,
                    messageId: finalMsg.message_id,
                    senderId: finalMsg.sender_id,
                    queueCount: senderMessages.length,
                    allowReply
                  })
                );
                const sendResult = await smartSend(finalMsg, response, sendAndWaitWithConv, allowReply, { hasTool: false });
                const deliveredSegmentIds = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
                const deliveredMessageId = extractDeliveredMessageIdFromSendResult(sendResult);
                if (pairId && (deliveredSegmentIds.length > 0 || deliveredMessageId)) {
                  const patched = deliveredSegmentIds.length > 0
                    ? applySentraMessageSegmentMessageIds(responseForHistory, deliveredSegmentIds)
                    : applySentraMessageSegmentMessageId(responseForHistory, deliveredMessageId);
                  await historyManager.replaceAssistantMessage(groupId, patched, pairId);
                  response = patched;
                }
                hasReplied = true;
                if (ctx.desireManager) {
                  try {
                    await ctx.desireManager.onBotMessage(finalMsg, { proactive: !!msg?._proactive });
                  } catch (e) {
                    logger.debug(tMessagePipeline('desire_on_bot_message_judge_failed'), { err: String(e) });
                  }
                }

                markReplySentForConversation(conversationId);
              }
            } else {
              logger.info(tMessagePipeline('judge_no_reply_skip_send'));
            }

            if (!pairId) {
              logger.warn(tMessagePipeline('save_failed_pairid_empty', { groupId }));
            } else {
              const saved = await historyManager.finishConversationPair(
                groupId,
                pairId,
                null
              );

              if (saved) {
                const chatType = msg?.group_id ? 'group' : 'private';
                const userIdForMemory = userid || '';
                triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
                  (e) => {
                    logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
                  }
                );
                triggerPresetTeachingIfNeeded({
                  groupId,
                  chatType,
                  userId: userIdForMemory,
                  userContent: pickSnapshotContent(currentUserContentSnapshot, judgeBaseContent),
                  assistantContent: response
                }).catch((e) => {
                  logger.debug(tMessagePipeline('preset_teaching_async_failed', { groupId }), { err: String(e) });
                });

                tryEnqueueRagIngestAfterSave({
                  logger,
                  conversationId,
                  groupId,
                  userid: userIdForMemory,
                  userObjective: userObjective ?? null,
                  msg,
                  response
                });
              }
            }

            pairId = null;
            await flushAssistantBridgeRun(runIdForJudge, ASSISTANT_BRIDGE_FLUSH_REASON.judgeNoToolsDone);
            if (isSkillsJudgeNoToolRound) {
              await finalizeSkillsProtocolForRound({
                success: true,
                resultCode: noReply ? SKILLS_RUNTIME_OUTCOME_CODE.noReply : SKILLS_RUNTIME_OUTCOME_CODE.completed,
                reasonCode: noReply ? SKILLS_PROTOCOL_REASON.replyNoReply : SKILLS_PROTOCOL_REASON.replyCompleted,
                note: noReply ? 'skills reply generated with noReply=true' : 'skills reply delivered via judge path'
              });
            }
            return;
          }
        }

        if (ev.type === 'judge') {
          try {
            if (Array.isArray(ev.toolNames)) {
              toolPreReplyFallbackToolNames = ev.toolNames
                .map((s) => String(s || '').trim())
                .filter(Boolean);
            }
          } catch { }
        }

        if (ev.type === 'plan' && ev.plan && Array.isArray(ev.plan.steps)) {
          const plan = ev.plan;
          logger.info(tMessagePipeline('execute_plan'), plan.steps);
          try {
            const cfg = getToolPreReplyRuntimeConfig();
            if (
              cfg.enabled &&
              !isDelayBufferingActive() &&
              !toolPreReplyJobStarted &&
              !hasToolPreReplied &&
              !hasRealtimeToolFeedback
            ) {
              const senderMsgsNow = getAllSenderMessages();
              const latestMsgPlanNeed = senderMsgsNow[senderMsgsNow.length - 1] || msg;

              const planToolNames = extractToolNamesFromPlan(plan);
              const toolNames = planToolNames.length > 0 ? planToolNames : toolPreReplyFallbackToolNames;
              const toolCount = toolNames.length;

              if (toolCount === 0) {
                continue;
              }

              const cooldownMs = Number(cfg.cooldownMs);
              const bypassCooldown = toolCount >= 3;
              const senderKey = String(userid || '');
              const nowMs = Date.now();
              const lastSentAt = senderKey ? Number(toolPreReplyLastSentAtByUser.get(senderKey) || 0) : 0;
              const inCooldown =
                !bypassCooldown &&
                senderKey &&
                Number.isFinite(cooldownMs) &&
                cooldownMs > 0 &&
                lastSentAt > 0 &&
                nowMs - lastSentAt < cooldownMs;

              if (inCooldown) {
                continue;
              }

              const baseUserContentNoRoot = (() => {
                if (isProactive && !isProactiveFirst) return '';
                const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
                return buildSentraInputBlock({
                  currentMessage: latestMsgPlanNeed,
                  pendingMessagesXml: pendingContextXml || ''
                });
              })();
              const runIdForPreReply = (typeof ev.runId === 'string' && ev.runId.trim())
                ? ev.runId
                : currentRunId;

              toolPreReplyJobStarted = true;

              const judgeSummary = buildPlanSummary(plan) || ev.summary;
              const preReplyPromise = generateToolPreReply({
                chatWithRetry,
                baseConversations: await rebuildConversationsWithSystem('must_be_sentra_message', conversations, {
                  stage: 'tool_prereply',
                  userText: baseUserContentNoRoot
                }),
                userContentNoRoot: baseUserContentNoRoot,
                toolNames,
                timeoutMs: getEnvTimeoutMs('TOOL_PREREPLY_TIMEOUT_MS', 180000, 900000),
                ...(groupId != null ? { groupId } : {}),
                ...(MAIN_AI_MODEL ? { model: MAIN_AI_MODEL } : {}),
                ...(proactiveRootXml ? { originalRootXml: proactiveRootXml } : {}),
                ...(judgeSummary ? { judgeSummary } : {})
              });

              preReplyPromise.then(async (preReplyRaw) => {
                if (!preReplyRaw) return;
                if (hasToolPreReplied || hasRealtimeToolFeedback || toolResultArrived) return;

                const preReply = ensureSentraMessageHasTarget(preReplyRaw, msg);
                hasReplied = true;
                hasToolPreReplied = true;

                const sendResult = await smartSend(
                  latestMsgPlanNeed,
                  preReply,
                  sendAndWaitWithConv,
                  true,
                  { hasTool: true, immediate: true }
                );
                const deliveredSegmentIds = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
                const deliveredMessageId = extractDeliveredMessageIdFromSendResult(sendResult);
                const deliveredPreReply = deliveredSegmentIds.length > 0
                  ? applySentraMessageSegmentMessageIds(preReply, deliveredSegmentIds)
                  : (deliveredMessageId
                    ? applySentraMessageSegmentMessageId(preReply, deliveredMessageId)
                    : preReply);
                const preReplyForHistory = normalizeAssistantContentForHistory(deliveredPreReply);
                recordAssistantBridgeResponse({
                  runId: runIdForPreReply,
                  phase: PIPELINE_RESPONSE_PHASE.toolPreReply,
                  content: deliveredPreReply,
                  noReply: false,
                  delivered: true,
                  meta: { stage: PIPELINE_RESPONSE_STAGE.toolPreReply }
                });

                try {
                  if (preReplyForHistory) {
                    conversations.push({ role: 'assistant', content: preReplyForHistory });
                  }
                } catch { }

                if (senderKey) {
                  toolPreReplyLastSentAtByUser.set(senderKey, Date.now());
                }

                try {
                  const preReplyPairId = isGroupChat
                    ? await historyManager.startAssistantMessage(groupId, {
                      commitMode: 'scoped',
                      scopeSenderId: userid
                    })
                    : await historyManager.startAssistantMessage(groupId);
                  await historyManager.appendToAssistantMessage(
                    groupId,
                    preReplyForHistory,
                    preReplyPairId
                  );

                  const preReplyUserForHistory = baseUserContentNoRoot || buildSentraInputBlock({ currentMessage: latestMsgPlanNeed });
                  const savedPreReply = await historyManager.finishConversationPair(
                    groupId,
                    preReplyPairId,
                    preReplyUserForHistory
                  );

                  if (savedPreReply && !isGroupChat) {
                    const chatType = msg?.group_id ? 'group' : 'private';
                    const userIdForMemory = userid || '';

                    triggerContextSummarizationIfNeeded({
                      groupId,
                      chatType,
                      userId: userIdForMemory
                    }).catch((e) => {
                      logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
                    });

                    triggerPresetTeachingIfNeeded({
                      groupId,
                      chatType,
                      userId: userIdForMemory,
                      userContent: baseUserContentNoRoot,
                      assistantContent: preReplyForHistory
                    }).catch((e) => {
                      logger.debug(tMessagePipeline('preset_teaching_async_failed', { groupId }), { err: String(e) });
                    });
                  }
                } catch (e) {
                  logger.debug(tMessagePipeline('tool_pre_reply_save_failed'), { err: String(e) });
                }
              }).catch((e) => {
                logger.debug(tMessagePipeline('tool_pre_reply_failed'), { err: String(e) });
              });
            }
          } catch (e) {
            logger.debug(tMessagePipeline('tool_pre_reply_failed'), { err: String(e) });
          }
        }

        if (ev.type === 'args') {
          try {
            const idx = typeof ev.plannedStepIndex === 'number' ? ev.plannedStepIndex : ev.stepIndex;
            if (typeof idx === 'number') {
              const aiName = typeof ev.aiName === 'string' ? ev.aiName : '';
              const args = ev.args && typeof ev.args === 'object'
                ? (ev.args as Record<string, ParamValue>)
                : {};
              const entry = aiName ? { aiName, args } : { args };
              pendingToolArgsByStepIndex.set(idx, entry);
            }
          } catch { }
          continue;
        }

        if (ev.type === 'args_group') {
          try {
            const items = Array.isArray(ev.items) ? ev.items : [];
            for (const item of items) {
              if (!item || typeof item !== 'object') continue;
              const idx = typeof item.plannedStepIndex === 'number' ? item.plannedStepIndex : item.stepIndex;
              if (typeof idx !== 'number') continue;
              const aiName = typeof item.aiName === 'string' ? item.aiName : '';
              const args = item.args && typeof item.args === 'object'
                ? (item.args as Record<string, ParamValue>)
                : {};
              const entry = aiName ? { aiName, args } : { args };
              pendingToolArgsByStepIndex.set(idx, entry);
            }
          } catch { }
          continue;
        }

        if (
          ev.type === 'tool_choice' &&
          (ev.status === 'in_progress' || ev.status === 'scheduled')
        ) {
          // Legacy MCP schedule progress event: ignore at main runtime.
          continue;
        }

        if (ev.type === 'tool_result' || ev.type === 'tool_result_group') {
          if (isDelayBufferingActive()) {
            try {
              const replayEvent = cloneDeferredReplayEvent(ev);
              delayReplayRawEvents.push(replayEvent);
              appendDelayReplayEventToSession(replayEvent);
            } catch { }
          }
          const isStreamEvent = !!ev?.resultStream;
          const streamStatus = String(ev?.resultStatus || '').toLowerCase();
          const isStreamProgress = isStreamEvent && (
            streamStatus === 'progress' ||
            streamStatus === 'final' ||
            streamStatus === ''
          );
          if (!toolResultArrived) {
            toolResultArrived = true;
          }

          try {
            if (ev.type === 'tool_result') {
              recordToolTurnEventForCompletionAnalysis(ev);
            } else {
              const events = Array.isArray(ev.events) ? ev.events : [];
              if (events.length === 0) {
                recordToolTurnEventForCompletionAnalysis(ev);
              } else {
                for (const item of events) {
                  recordToolTurnEventForCompletionAnalysis(item);
                }
              }
            }
          } catch { }

          if (!isStreamProgress) {
            // 非 result-stream 进度事件：先收集，最终在 completed 阶段统一生成 ToolFinal。
            continue;
          }

          if (!currentUserContent) {
            senderMessages = getAllSenderMessages();

            if (senderMessages.length > initialMessageCount) {
              logger.info(
                tMessagePipeline('dynamic_context_tool_result_detected_new_message', { groupId })
              );
            }

            const latestMsgTool = senderMessages[senderMessages.length - 1] || msg;

            if (isProactive && !isProactiveFirst) {
              // 主动回合后续：仅基于 root 与工具结果总结，不重新注入用户问题。
              const bundled = combineRootAndSnapshot(proactiveRootXml, '');
              currentUserContent = bundled.apiContent;
              currentUserContentSnapshot = bundled.snapshotContent;
            } else {
              // 获取待处理上下文（群聊含他人+当前用户，私聊仅当前用户）。
              const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
              const toolBaseContent = buildSentraInputBlock({
                currentMessage: latestMsgTool,
                pendingMessagesXml: contextXml || ''
              });

              const bundled = combineRootAndSnapshot(proactiveRootXml, toolBaseContent);
              currentUserContent = bundled.apiContent;
              currentUserContentSnapshot = bundled.snapshotContent;
            }
          }

          if (!isDelayBufferingActive()) {
            hasRealtimeToolFeedback = true;
          }

          if (isDelayBufferingActive()) {
            // Delay mode only buffers tool results now; final reply is replayed by delay worker.
            continue;
          }

          // Result rounds always inject one combined user block:
          // <sentra-input> on top + <sentra-result(_group)> below.
          let resultXml = '';
          try {
            resultXml = buildSentraResultBlock(ev);
          } catch {
            try { resultXml = JSON.stringify(ev); } catch { resultXml = ''; }
          }
          const resultMode: ResultRoundMode = ev.type === 'tool_result_group' ? 'group' : 'single';
          const resultSkillHint = {
            stage: 'tool_result_round',
            userText: currentUserContent,
            toolText: resultXml
          };
          const resultBundle = await runtimeSkillContextBuilder.buildResultRoundBundle({
            resultPayload: resultXml,
            mode: resultMode,
            requiredOutputMode: 'must_be_sentra_message',
            stage: 'tool_result_round',
            baseUserContentApi: currentUserContent,
            baseUserContentSnapshot: currentUserContentSnapshot,
            hint: resultSkillHint
          });
          const fullUserContent = resultBundle.apiContent;

          const toolPairId = await historyManager.startAssistantMessage(groupId);
          try {
            if (fullUserContent) {
              await historyManager.appendToConversationPairMessages(
                groupId,
                toolPairId,
                'user',
                pickSnapshotContent(resultBundle.snapshotContent, currentUserContentSnapshot)
              );
            }
          } catch { }

          const toolRoundUserMsg = appendRuntimeUserMessage(conversations, fullUserContent, {
            timestampMs: Date.now(),
            timezone: 'Asia/Shanghai'
          });
          const toolRoundUserContent = toolRoundUserMsg.content;
          const convForTool: ChatMessage[] = [
            ...conversations,
            toolRoundUserMsg
          ];

          let toolResponse = null;
          let toolNoReply = false;
          try {
            const result = await chatWithRetry(
              await rebuildConversationsWithSystem('must_be_sentra_message', convForTool, {
                stage: 'tool_result_round',
                userText: currentUserContent,
                toolText: resultXml
              }),
              buildChatWithRetryOptions('sentra_message'),
              groupId
            );

            if (result && result.success && result.toolsOnly && result.rawToolsXml) {
              const toolsXml = String(result.rawToolsXml || '').trim();
                if (toolsXml) {
                if (isDelaySinglePassRuntimeActive()) {
                  logger.info(tMessagePipeline('tools_only_ignored_delay_single_pass_tool_progress'), {
                    groupId,
                    length: toolsXml.length
                  });
                } else {
                  userObjective = toolsXml;
                    forceNeedTools = true;
                    restartObjective = toolsXml;
                    restartMcp = true;
                    logger.info(tMessagePipeline('tools_only_direct_exec_tool_progress'), {
                      groupId,
                      attempt: streamAttempt + 2,
                      length: toolsXml.length,
                    preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                  });
                }
              }
            } else if (result && result.success) {
              toolResponse = typeof result.response === 'string' ? result.response : '';
              toolNoReply = !!result.noReply;
            }
          } catch (e) {
            logger.warn(tMessagePipeline('tool_progress_realtime_reply_failed'), { err: String(e) });
          }

          if (restartMcp) {
            await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.restartForToolsXml);
            try {
              await historyManager.cancelConversationPairById(groupId, toolPairId);
            } catch { }
            if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
              try {
                sdk.cancelRun(currentRunId, {
                  source: 'message_pipeline',
                  reason: MCP_RESTART_REASON.toolProgressToolsOnlyRestart,
                  latestUserObjective: String(
                    extractTextFromMessageLike(msg) ||
                    msg?.objective_text ||
                    msg?.summary_text ||
                    msg?.text ||
                    ''
                  ),
                  latestUserObjectiveXml: String(
                    (typeof msg?.objective_xml === 'string' && msg.objective_xml.trim())
                      ? msg.objective_xml
                      : ((typeof msg?.objective === 'string' && msg.objective.trim().startsWith('<'))
                        ? msg.objective
                        : '')
                  ),
                  cancelledBy: userid
                });
                try {
                  untrackRunForSender(userid, conversationId, currentRunId);
                } catch { }
              } catch { }
            }
            currentRunId = null;
            break;
          }

          if (toolResponse) {
            toolResponse = ensureSentraMessageHasTarget(toolResponse, msg);
            try {
              const parsedToolResp = parseSentraMessage(toolResponse);
              if (parsedToolResp && parsedToolResp.shouldSkip) {
                await historyManager.cancelConversationPairById(groupId, toolPairId);
                continue;
              }
            } catch { }
            recordAssistantBridgeResponse({
              runId: ev.runId || currentRunId,
              phase: PIPELINE_RESPONSE_PHASE.toolProgress,
              content: toolResponse,
              noReply: toolNoReply,
              delivered: !toolNoReply,
              meta: {
                stage: PIPELINE_RESPONSE_STAGE.toolResultStream
              }
            });
            lastRealtimeToolResponse = toolResponse;
            const toolResponseForHistory = normalizeAssistantContentForHistory(toolResponse);
            await historyManager.appendToAssistantMessage(groupId, toolResponseForHistory, toolPairId);

            // 关键：将“本轮工具调用轨迹”按顺序追加入 conversations，保证后续上下文不乱序。
            try {
              if (toolRoundUserContent) {
                conversations.push(toolRoundUserMsg);
              }
              if (toolResponseForHistory) {
                conversations.push({ role: 'assistant', content: toolResponseForHistory });
              }
            } catch { }

            if (!toolNoReply) {
              const swallow = shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask);
              if (!swallow) {
                const finalMsgTool = replyAnchorMsg;
                const allowReply = !hasReplied;
                const sendResult = await smartSend(
                  finalMsgTool,
                  toolResponse,
                  sendAndWaitWithConv,
                  allowReply,
                  { hasTool: true, immediate: true }
                );
                const deliveredSegmentIds = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
                const deliveredMessageId = extractDeliveredMessageIdFromSendResult(sendResult);
                if (deliveredSegmentIds.length > 0 || deliveredMessageId) {
                  const patched = deliveredSegmentIds.length > 0
                    ? applySentraMessageSegmentMessageIds(toolResponseForHistory, deliveredSegmentIds)
                    : applySentraMessageSegmentMessageId(toolResponseForHistory, deliveredMessageId);
                  await historyManager.replaceAssistantMessage(groupId, patched, toolPairId);
                  try {
                    if (conversations.length > 0) {
                      const last = conversations[conversations.length - 1];
                      if (last && last.role === 'assistant') {
                        last.content = patched;
                      }
                    }
                  } catch { }
                  toolResponse = patched;
                }
                hasReplied = true;
                hasToolPreReplied = true;
                if (ctx.desireManager) {
                  try {
                    await ctx.desireManager.onBotMessage(finalMsgTool, { proactive: !!msg?._proactive });
                  } catch (e) {
                    logger.debug(tMessagePipeline('desire_on_bot_message_tool_progress_failed'), { err: String(e) });
                  }
                }
                markReplySentForConversation(conversationId);
              }
            }
          }

          try {
            if (toolResponse) {
              await historyManager.finishConversationPair(groupId, toolPairId, null);
            } else {
              await historyManager.cancelConversationPairById(groupId, toolPairId);
            }
          } catch { }
          continue;
        }

        if (ev.type === 'feedback_wait') {
          const evRoundRaw = Number((ev as { round?: unknown })?.round);
          await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.feedbackWait, {
            round: Number.isFinite(evRoundRaw) ? evRoundRaw : 0,
            requireAck: true
          });
          continue;
        }

        if (ev.type === 'completed') {
          const evRunId = String(ev?.runId || '').trim();
          const evEval = (ev && typeof ev === 'object' && ev.evaluation && typeof ev.evaluation === 'object')
            ? (ev.evaluation as Record<string, unknown>)
            : null;
          const evCancelled = (ev && typeof ev === 'object' && (ev as { cancelled?: unknown }).cancelled === true);
          const childStatus = evCancelled
            ? 'cancelled'
            : (evEval && evEval.success === false ? 'failed' : 'completed');
          const childReasonCode = evCancelled
            ? 'run_cancelled'
            : (evEval && evEval.success === false
              ? String(evEval.nextAction || 'evaluation_incomplete').trim()
              : 'run_completed');
          const childResultCode = evCancelled
            ? 'RUN_CANCELLED'
            : (evEval && evEval.success === false
              ? String(evEval.completionLevel || 'EVAL_INCOMPLETE').trim().toUpperCase()
              : 'RUN_COMPLETED');
          const childNote = evEval && typeof evEval.summary === 'string'
            ? String(evEval.summary || '').trim()
            : '';
          if (evRunId) {
            registerOrchestratorChildOutcome({
              runId: evRunId,
              status: childStatus,
              reasonCode: childReasonCode,
              note: childNote,
              resultCode: childResultCode
            });
          }
          logger.info(tMessagePipeline('task_completed'), {
            runId: ev.runId || null,
            attempted: ev?.exec?.attempted,
            succeeded: ev?.exec?.succeeded
          });

          if (ev.runId) {
            untrackRunForSender(userid, conversationId, ev.runId);
          }

          if (isDelayBufferingActive()) {
            await sendDelayPreReplyIfNeeded();

            const runIdForDelay = (typeof ev.runId === 'string' && ev.runId.trim())
              ? ev.runId
              : currentRunId;
            const deferredToolEvents = delayReplayRawEvents.length > 0
              ? delayReplayRawEvents
              : (toolTurnResultEvents.length > 0
                ? toolTurnResultEvents
                : []);
            const deferredResponse = typeof ev.response === 'string' ? ev.response : '';
            const queued = await enqueueDelayReplayJob({
              runId: runIdForDelay,
              deferredResponseXml: deferredResponse,
              deferredToolResultEvents: deferredToolEvents,
              hasTool: deferredToolEvents.length > 0,
              reasonCode: DELAY_REASON_CODE.completed,
              reasonArgs: delayRuntimeReasonArgs
            });

            if (queued) {
              logDelayRuntime('info', 'completed_handoff_to_due', {
                runId: runIdForDelay || null,
                deferredToolEvents: deferredToolEvents.length,
                hasDeferredResponse: !!deferredResponse
              });
              if (pairId) {
                try {
                  await historyManager.cancelConversationPairById(groupId, pairId);
                } catch { }
                pairId = null;
              }
              await flushAssistantBridgeRun(runIdForDelay, ASSISTANT_BRIDGE_FLUSH_REASON.delayQueuedCompleted);
              endedBySchedule = true;
              break;
            }
          }

          if (hasRealtimeToolFeedback) {
            const savedSummary = hasReplied;
            if (savedSummary) {
              const chatType = msg?.group_id ? 'group' : 'private';
              const userIdForMemory = userid || '';
              if (isGroupChat && userid) {
                try {
                  await historyManager.promoteScopedConversationsToShared(groupId, userid);
                } catch { }
              }
              triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
                (e) => {
                  logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
                }
              );

              if (lastRealtimeToolResponse) {
                finalResponseForCompletionAnalysis = String(lastRealtimeToolResponse || '');
                tryEnqueueRagIngestAfterSave({
                  logger,
                  conversationId,
                  groupId,
                  userid: userIdForMemory,
                  userObjective: userObjective ?? null,
                  msg,
                  response: lastRealtimeToolResponse
                });
              }
            }
            await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.completedWithRealtimeFeedback);
            break;
          }

          if (pairId) {
            let toolResponse = null;
            let toolNoReply = false;
            try {
              if (toolTurnResultEvents.length > 0) {
                // completed 阶段输出 ToolFinal 前，先确保 toolTurnResultEvents 顺序稳定。
                sortToolEventsInPlace(toolTurnResultEvents);
                const resultGroupEv = {
                  type: 'tool_result_group',
                  groupId: 'tool_turn',
                  groupSize: toolTurnResultEvents.length,
                  orderStepIds: toolTurnResultEvents.map((x, i) => {
                    const raw = typeof x?.stepId === 'string' ? x.stepId.trim() : '';
                    if (raw) return raw;
                    const planned = typeof x?.plannedStepIndex === 'number' ? x.plannedStepIndex : i;
                    return `step_${planned}`;
                  }),
                  events: toolTurnResultEvents
                };
                const resultXml = buildSentraResultBlock(resultGroupEv);
                const finalGroupHint = {
                  stage: 'tool_final_group',
                  userText: currentUserContent,
                  toolText: resultXml
                };
                const finalResultBundle = await runtimeSkillContextBuilder.buildResultRoundBundle({
                  resultPayload: resultXml,
                  mode: 'group',
                  requiredOutputMode: 'must_be_sentra_message',
                  stage: 'tool_final_group',
                  baseUserContentApi: currentUserContent,
                  baseUserContentSnapshot: currentUserContentSnapshot,
                  hint: finalGroupHint
                });
                const fullUserContent = finalResultBundle.apiContent;

                try {
                  await historyManager.appendToConversationPairMessages(
                    groupId,
                    pairId,
                    'user',
                    pickSnapshotContent(finalResultBundle.snapshotContent, currentUserContentSnapshot)
                  );
                } catch { }

                const finalRoundUserMsg = appendRuntimeUserMessage(conversations, fullUserContent, {
                  timestampMs: Date.now(),
                  timezone: 'Asia/Shanghai'
                });
                const finalRoundUserContent = finalRoundUserMsg.content;
                const convForFinal: ChatMessage[] = [
                  ...conversations,
                  finalRoundUserMsg
                ];

                const result = await chatWithRetry(
                  await rebuildConversationsWithSystem('must_be_sentra_message', convForFinal, {
                    stage: 'tool_final_group',
                    userText: currentUserContent,
                    toolText: resultXml
                  }),
                  buildChatWithRetryOptions('sentra_message'),
                  groupId
                );
                if (result && result.success && result.toolsOnly && result.rawToolsXml) {
                  const toolsXml = String(result.rawToolsXml || '').trim();
                  if (toolsXml) {
                    if (isDelaySinglePassRuntimeActive()) {
                      logger.info(tMessagePipeline('tools_only_ignored_delay_single_pass_tool_final'), {
                        groupId,
                        length: toolsXml.length
                      });
                    } else {
                      userObjective = toolsXml;
                      forceNeedTools = true;
                      restartObjective = toolsXml;
                      restartMcp = true;
                      logger.info(tMessagePipeline('tools_only_direct_exec_tool_final'), {
                        groupId,
                        attempt: streamAttempt + 2,
                        length: toolsXml.length,
                        preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                      });
                    }
                  }
                  try {
                    await historyManager.cancelConversationPairById(groupId, pairId);
                  } catch { }
                  pairId = null;
                  await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.restartForToolsXml);
                  break;
                }

                if (result && result.success) {
                  toolResponse = typeof result.response === 'string' ? result.response : '';
                  toolNoReply = !!result.noReply;
                } else {
                  logger.error(tMessagePipeline('tool_final_ai_response_failed'), {
                    groupId,
                    reason: result?.reason || 'unknown',
                    retries: result?.retries || 0
                  });
                }
              }
            } catch (e) {
              logger.warn(tMessagePipeline('tool_final_reply_generation_failed'), { err: String(e) });
            }

            if (toolResponse) {
              finalResponseForCompletionAnalysis = String(toolResponse || '');
              const rewritten = await maybeRewriteSentraMessage(toolResponse);
              if (rewritten && typeof rewritten === 'string') {
                toolResponse = rewritten;
              }

              toolResponse = ensureSentraMessageHasTarget(toolResponse, msg);
              recordAssistantBridgeResponse({
                runId: ev.runId || currentRunId,
                phase: PIPELINE_RESPONSE_PHASE.toolFinal,
                content: toolResponse,
                noReply: toolNoReply,
                delivered: !toolNoReply,
                meta: { stage: PIPELINE_RESPONSE_STAGE.completed }
              });

              const toolResponseForHistory = normalizeAssistantContentForHistory(toolResponse);
              if (pairId) {
                await historyManager.appendToAssistantMessage(groupId, toolResponseForHistory, pairId);
              }

              if (!toolNoReply) {
                await maybeWaitForSupplementBeforeSend();

                const finalMsgTool = replyAnchorMsg;
                const swallow = shouldSwallowReplyForConversation(
                  conversationId,
                  hasSupplementDuringTask
                );
                if (!swallow) {
                  const sendResult = await smartSend(
                    finalMsgTool,
                    toolResponse,
                    sendAndWaitWithConv,
                    true,
                    { hasTool: true }
                  );
                  const deliveredSegmentIds = extractDeliveredSegmentMessageIdsFromSendResult(sendResult);
                  const deliveredMessageId = extractDeliveredMessageIdFromSendResult(sendResult);
                  if (pairId && (deliveredSegmentIds.length > 0 || deliveredMessageId)) {
                    const patched = deliveredSegmentIds.length > 0
                      ? applySentraMessageSegmentMessageIds(toolResponseForHistory, deliveredSegmentIds)
                      : applySentraMessageSegmentMessageId(toolResponseForHistory, deliveredMessageId);
                    await historyManager.replaceAssistantMessage(groupId, patched, pairId);
                    toolResponse = patched;
                  }
                  hasReplied = true;
                  if (ctx.desireManager) {
                    try {
                      await ctx.desireManager.onBotMessage(finalMsgTool, {
                        proactive: !!msg?._proactive
                      });
                    } catch (e) {
                      logger.debug(tMessagePipeline('desire_on_bot_message_tool_final_failed'), {
                        err: String(e)
                      });
                    }
                  }
                  markReplySentForConversation(conversationId);
                }
              }
            }

            if (!pairId) {
              logger.warn(tMessagePipeline('save_failed_pairid_empty', { groupId }));
            } else {
              logger.debug(
                tMessagePipeline('save_pair_debug', {
                  groupId,
                  pairId: String(pairId).substring(0, 8)
                })
              );
              const saved = await historyManager.finishConversationPair(groupId, pairId, null);
              if (!saved) {
                logger.warn(
                  tMessagePipeline('save_status_mismatch', {
                    groupId,
                    pairId: String(pairId).substring(0, 8)
                  })
                );
              }

              if (saved) {
                completionAnalysisHasToolCalled = completionAnalysisHasToolCalled || toolTurnInvocations.length > 0 || toolTurnResultEvents.length > 0;
                const chatType = msg?.group_id ? 'group' : 'private';
                const userIdForMemory = userid || '';
                if (isGroupChat && userid) {
                  try {
                    await historyManager.promoteScopedConversationsToShared(groupId, userid);
                  } catch { }
                }
                triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch(
                  (e) => {
                    logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
                  }
                );

                const ragPayload: {
                  logger: LoggerLike;
                  conversationId: string;
                  groupId: string;
                  userid: string;
                  userObjective: string | null;
                  msg: MsgLike;
                  response?: string;
                } = {
                  logger,
                  conversationId,
                  groupId,
                  userid: userIdForMemory,
                  userObjective: userObjective ?? null,
                  msg
                };
                if (toolResponse) {
                  ragPayload.response = toolResponse;
                }
                tryEnqueueRagIngestAfterSave(ragPayload);
              }

              pairId = null;
            }
          } else {
            logger.warn(tMessagePipeline('skip_save_pairid_null', { groupId }));
          }
          await flushAssistantBridgeRun(ev.runId || currentRunId, ASSISTANT_BRIDGE_FLUSH_REASON.completedDone);
          break;
        }

        if (ev.type === 'summary') {
          logger.info(tMessagePipeline('summary_non_terminal'), ev.summary);
        }
      }

      if (restartMcp && restartObjective && streamAttempt === 0 && !isDelaySinglePassRuntimeActive()) {
        userObjective = restartObjective;
        endedBySchedule = false;
        streamAttempt++;
        continue;
      }

      if (skillsProtocolRunIdForRound && !skillsProtocolFinalizedForRound) {
        await finalizeSkillsProtocolForRound({
          success: false,
          resultCode: SKILLS_RUNTIME_OUTCOME_CODE.failed,
          reasonCode: SKILLS_PROTOCOL_REASON.roundIncomplete,
          note: 'skills protocol round ended without terminal judge outcome'
        });
      }
      activeSkillsProtocolRunId = '';
      activeSkillsProtocolFinalized = true;

      break;
    }
  } catch (error) {
    setOrchestratorOutcome({
      status: 'failed',
      reasonCode: ORCHESTRATOR_RUNTIME_OUTCOME_CODE.exception,
      note: String(error || '')
    });
    logger.error(tMessagePipeline('process_message_exception'), error);
    if (activeSkillsProtocolRunId && !activeSkillsProtocolFinalized) {
      const reason = String(error || 'skills round exception').trim() || 'skills round exception';
      try {
        await finalizeSkillsProtocolState({
          runId: activeSkillsProtocolRunId,
          success: false,
          resultCode: SKILLS_RUNTIME_OUTCOME_CODE.failed,
          reasonCode: SKILLS_PROTOCOL_REASON.roundException,
          note: reason,
          stage: SKILLS_PROTOCOL_STAGE.exception
        });
      } catch (persistErr) {
        logger.warn('runtime protocol persistence failed', {
          err: String(persistErr),
          runId: activeSkillsProtocolRunId,
          stage: SKILLS_PROTOCOL_STAGE.exception
        });
      } finally {
        activeSkillsProtocolFinalized = true;
        activeSkillsProtocolRunId = '';
      }
    }

    if (pairId) {
      logger.debug(
        tMessagePipeline('cancel_pair_exception', {
          groupId,
          pairId: String(pairId).substring(0, 8)
        })
      );
      await historyManager.cancelConversationPairById(groupId, pairId);
    }

    if (isGroupScopeId(groupId) && userid) {
      try {
        await historyManager.clearScopedConversationsForSender(groupId, userid);
      } catch { }
    }
  } finally {
    try {
      await finalizeOrchestratorRuntime();
    } catch { }
    try {
      await flushAllAssistantBridgeRuns(
        endedBySchedule ? ASSISTANT_BRIDGE_FLUSH_REASON.pipelineFinallyScheduled : ASSISTANT_BRIDGE_FLUSH_REASON.pipelineFinally
      );
    } catch { }

    // 任务完成后释放并发槽位，并尝试拉起队列中的下一条。
    // completeTask 会自动调用 replyPolicy.js 的 removeActiveTask。
    if (taskId && userid) {
      const next = await completeTask(conversationId, taskId);
      if (next && next.msg) {
        const nextConversationId = String(next.conversationId ?? '');
        // 队列里的任务作为新的聚合会话起点。
        startBundleForQueuedMessage(nextConversationId, next.msg);
        const bundledNext = await collectBundleForSender(nextConversationId);
        if (bundledNext) {
          await handleOneMessageCore(ctx, bundledNext, next.id);
        }
      }

      // 检查是否有待处理的消息（延迟聚合）。
      const mergedMsg = drainPendingMessagesForSender(conversationId);
      if (mergedMsg) {
        const replyDecision = await shouldReply(mergedMsg, { source: 'pending_merged' });
        const actionSchedule = scheduleReplyAction(replyDecision);
        if (actionSchedule.needReply) {
          applyScheduledReplyAction(mergedMsg, actionSchedule);
          logger.debug(tMessagePipeline('delayed_merge_enter_reply', { taskId: replyDecision.taskId || 'null' }));
          await handleOneMessageCore(ctx, mergedMsg, replyDecision.taskId);
        } else {
          logger.debug(
            tMessagePipeline('delayed_merge_skipped_by_policy')
          );
        }
      }
    }

    // Completion/recovery state relies on runtime checkpoint chain only.

    try {
      if (CONTEXT_MEMORY_ENABLED && groupId) {
        const runtimeProtocolSnapshot = runtimeProtocolTracker.snapshot();
        const assistantResponsesForMemory = collectAssistantResponsesForCompletionAnalysis();
        const objectiveSnapshot = typeof userObjective === 'string' ? userObjective : '';
        const latestUserText = String(extractTextFromMessageLike(msg) || msg?.text || msg?.summary || '').trim();
        const objectiveXmlSnapshot = extractStructuredObjectiveXmlFromMessageLike(msg);
        const summaryText = String(finalResponseForCompletionAnalysis || '').trim();
        const reasonHints: string[] = [];
        if (hasRealtimeToolFeedback) reasonHints.push('has_realtime_tool_feedback');
        if (completionAnalysisHasToolCalled) reasonHints.push('tool_called');
        if (runtimeProtocolSnapshot.counters.actionRequest > 0) reasonHints.push('action_request_seen');
        if (runtimeProtocolSnapshot.counters.actionResult > 0) reasonHints.push('action_result_seen');
        if (runtimeProtocolSnapshot.counters.stepState > 0) reasonHints.push('step_state_seen');
        if (runtimeProtocolSnapshot.counters.workspaceDiff > 0) reasonHints.push('workspace_diff_seen');
        if (runtimeProtocolSnapshot.counters.assistantDelivery > 0) reasonHints.push('assistant_delivery_seen');
        if (runtimeProtocolSnapshot.counters.feedbackCycle > 0) reasonHints.push('feedback_cycle_seen');
        if (runtimeProtocolSnapshot.counters.orchestratorState > 0) reasonHints.push('orchestrator_state_seen');
        if (runtimeProtocolSnapshot.toolGate) reasonHints.push('tool_gate_seen');
        if (endedBySchedule) reasonHints.push('delay_handoff');
        await appendContextMemoryEvent(groupId, {
          kind: 'mcp_run_slice',
          timestamp: Date.now(),
          timeStart: runStartedAt,
          timeEnd: Date.now(),
          chatType: msg?.group_id ? 'group' : 'private',
          userId: userid || '',
          objective: objectiveSnapshot || latestUserText,
          ...(objectiveXmlSnapshot ? { objectiveXml: objectiveXmlSnapshot, contentXml: objectiveXmlSnapshot } : {}),
          contentText: latestUserText,
          summaryText,
          reasons: reasonHints,
          toolResults: toolTurnResultEvents,
          assistantResponses: assistantResponsesForMemory,
          metadata: {
            conversationId,
            taskId: currentTaskId || null,
            hasToolCalled: completionAnalysisHasToolCalled || toolTurnResultEvents.length > 0 || toolTurnInvocations.length > 0,
            runEndedBySchedule: endedBySchedule,
            runtimeProtocol: runtimeProtocolSnapshot
          }
        });
        triggerContextSummarizationIfNeeded({
          groupId,
          chatType: msg?.group_id ? 'group' : 'private',
          userId: userid || ''
        }).catch((e) => {
          logger.debug(tMessagePipeline('context_memory_async_summary_failed', { groupId }), { err: String(e) });
        });
      }
    } catch (e) {
      logger.debug('context memory event append failed', { err: String(e), groupId });
    }

    logger.debug(tMessagePipeline('task_cleanup_done', { groupId, userId: userid }));
  }
}







