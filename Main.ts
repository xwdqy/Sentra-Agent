import { loadEnv, initEnvWatcher, getEnv, getEnvInt, getEnvBool, getEnvTimeoutMs, onEnvReload } from './utils/envHotReloader.js';
import SentraMcpSDK from 'sentra-mcp';
import SentraPromptsSDK from 'sentra-prompts';
import { Agent } from "./src/agentRuntime.js";
import fs from 'fs';
import path from 'path';
import { createWebSocketClient } from './components/WebSocketClient.js';
import { buildSentraResultBlock, buildSentraInputBlock, convertHistoryToMCPFormat } from './utils/protocolUtils.js';
import { smartSend } from './utils/sendUtils.js';
import { cleanupExpiredCache, saveMessageCache, loadMessageCache } from './utils/messageCache.js';
import { SocialContextManager } from './utils/socialContextManager.js';
import { timeParser } from './src/time-parser.js';
type HistoryStoreLike = { list: (runId: string, start: number, end: number) => Promise<unknown> };
type RuntimePersistenceContext = {
  conversationId?: string;
  channelId?: string;
  identityKey?: string;
  groupId?: string;
  userId?: string;
  [key: string]: unknown;
};
type RuntimeProtocolPersistPayload = {
  op: 'start' | 'checkpoint' | 'final';
  runId: string;
  objective?: string;
  context?: RuntimePersistenceContext;
  patch?: Record<string, unknown>;
  event?: Record<string, unknown>;
  status?: string;
  reasonCode?: string;
  source?: string;
  note?: string;
};
type RuntimePersistenceModuleLike = {
  loadRuntimeRunCheckpointSnapshot?: (args?: {
    runId?: string;
  }) => Promise<Record<string, unknown> | null>;
  listRuntimeRunCheckpointSnapshots?: (args?: {
    includeTerminal?: boolean;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  listRuntimeDelaySessionSnapshots?: (args?: {
    includeCompleted?: boolean;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  loadRuntimeDelaySessionSnapshot?: (args?: {
    sessionId?: string;
    runId?: string;
    orchestratorRunId?: string;
  }) => Promise<Record<string, unknown> | null>;
  persistRuntimeRunStart?: (args?: {
    runId?: string;
    objective?: string;
    context?: RuntimePersistenceContext;
    source?: string;
  }) => Promise<unknown>;
  persistRuntimeCheckpoint?: (args?: {
    runId?: string;
    context?: RuntimePersistenceContext;
    patch?: Record<string, unknown>;
    event?: Record<string, unknown> | null;
  }) => Promise<unknown>;
  persistRuntimeRunFinal?: (args?: {
    runId?: string;
    context?: RuntimePersistenceContext;
    status?: string;
    reasonCode?: string;
    source?: string;
    note?: string;
    objective?: string;
  }) => Promise<unknown>;
};
import { buildSentraEmoSection } from './utils/emoXml.js';
import {
  shouldReply,
  completeTask,
  getActiveTaskCount,
} from './utils/replyPolicy.js';
import { randomUUID } from 'crypto';
import GroupHistoryManager from './utils/groupHistoryManager.js';
import UserPersonaManager, { type UserPersonaManagerOptions } from './utils/userPersonaManager.js';
import { createLogger } from './utils/logger.js';
import { collectXmlTagTextValues } from './utils/xmlUtils.js';
import { getDailyContextMemoryXml } from './utils/contextMemoryManager.js';
import {
  handleIncomingMessage,
  startBundleForQueuedMessage,
  collectBundleForSender,
  drainPendingMessagesForSender,
  requeuePendingMessageForSender
} from './utils/messageBundler.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from './utils/jsonToSentraXmlConverter.js';
import { chatWithRetry as chatWithRetryCore } from './components/ChatWithRetry.js';
import { triggerContextSummarizationIfNeededCore } from './components/ContextSummarizer.js';
import { triggerPresetTeachingIfNeededCore } from './components/PresetTeachingTrigger.js';
import { handleOneMessageCore } from './components/MessagePipeline.js';
import { setupSocketHandlers } from './components/SocketHandlers.js';
import { initAgentPresetCore } from './components/AgentPresetInitializer.js';
import { initWorldbookCore } from './components/WorldbookInitializer.js';
import { startPendingTaskScheduler } from './components/PendingTaskScheduler.js';
import { buildTaskRecoveryRootDirectiveXml } from './components/TaskRecoveryDirective.js';
import { startDelayJobWorker, enqueueDelayedJob } from './utils/delayJobQueue.js';
import { createDelayJobRunJob } from './components/DelayJobWorker.js';
import { startRefreshWatcher } from './components/RefreshWatcherCoordinator.js';
import { resolveRuntimeSignalActionByModel } from './components/RuntimeSignalActionResolver.js';
import { createRunKernel, type RunKernelRuntimeEvent } from './components/RunKernel.js';
import { createRuntimeResumeController, type DelayRuntimeSessionSnapshot } from './components/runtime/RuntimeResumeController.js';
import { buildRuntimeSkillRefsSystemAddon } from './utils/runtimeSkillContextBuilder.js';
import type { ChatMessage } from './src/types.js';
import { buildPrivateScopeId, extractScopeId, isGroupScopeId } from './utils/conversationId.js';

type SentraEmoInstance = {
  baseURL?: string;
  timeout: number;
  analyze: (text: string | { text: string }, opts?: Record<string, unknown>) => Promise<unknown>;
  userAnalytics: (senderId: string, options?: Record<string, unknown>) => Promise<unknown>;
};
type SentraEmoConstructor = new (options?: { baseURL?: string; timeout?: number }) => SentraEmoInstance;
const sentraEmoModule = await import(new URL('../sentra-emo/sdk/index.js', import.meta.url).toString());
const SentraEmoCtor = (() => {
  const ctor = (sentraEmoModule as { default?: SentraEmoConstructor }).default;
  if (!ctor) throw new Error('SentraEmo module not found or missing default export');
  return ctor;
})();
const historyStoreModule = await import(new URL('../sentra-mcp/src/history/store.js', import.meta.url).toString());
const HistoryStore = (historyStoreModule as { HistoryStore?: HistoryStoreLike }).HistoryStore;
if (!HistoryStore) {
  throw new Error('HistoryStore module not found or missing export');
}
const runtimePersistenceModule = await import(
  new URL('../sentra-mcp/src/agent/controllers/runtime_persistence_controller.js', import.meta.url).toString()
).catch(() => null) as RuntimePersistenceModuleLike | null;
const loadRuntimeRunCheckpointSnapshot = runtimePersistenceModule?.loadRuntimeRunCheckpointSnapshot;
const listRuntimeRunCheckpointSnapshots = runtimePersistenceModule?.listRuntimeRunCheckpointSnapshots;
const listRuntimeDelaySessionSnapshots = runtimePersistenceModule?.listRuntimeDelaySessionSnapshots;
const loadRuntimeDelaySessionSnapshot = runtimePersistenceModule?.loadRuntimeDelaySessionSnapshot;
const persistRuntimeRunStart = runtimePersistenceModule?.persistRuntimeRunStart;
const persistRuntimeCheckpoint = runtimePersistenceModule?.persistRuntimeCheckpoint;
const persistRuntimeRunFinal = runtimePersistenceModule?.persistRuntimeRunFinal;

type RpcMessage = Record<string, unknown> & { requestId?: string };
type TaskPromise = { content?: string; evidence?: string; fulfilled?: boolean };
type TaskToolCall = { name?: string; code?: string; success?: boolean };
type TaskRecoveryTask = {
  taskId?: string;
  runId?: string;
  objective?: string;
  stage?: string;
  summary?: string;
  reason?: string;
  userId?: string | number;
  groupId?: string | number;
  isComplete?: boolean;
  recoveryCount?: number;
  createdAt?: string | number;
  expiresAt?: string | number;
  lastRecoveryAt?: string | number;
  lastRecoveryStatus?: string;
  promises?: TaskPromise[];
  toolCalls?: TaskToolCall[];
  [key: string]: unknown;
};
type TaskRecoveryCandidate = {
  attempt?: number;
  source?: 'checkpoint' | string;
  runId?: string;
  conversationId?: string;
  task?: TaskRecoveryTask | null;
};
type IncomingMessage = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  sender_name?: string;
  message_id?: string | number | null;
  text?: string;
  summary?: string;
  summary_text?: string;
  summary_xml?: string;
  objective?: string;
  objective_text?: string;
  objective_xml?: string;
  at_users?: Array<string | number>;
  time_str?: string;
  [key: string]: unknown;
};
type CancelRunOptions = {
  mode?: string;
  cutoffTs?: number;
  action?: string;
  reason?: string;
  reasonCode?: string;
  source?: string;
  sourceEventId?: string;
  latestUserObjective?: string;
  latestUserObjectiveXml?: string;
};
type RuntimeSignalAction = 'cancel' | 'supplement' | 'replan' | 'append' | 'ignore';
type ConversationRuntimeStateName = 'IDLE' | 'BUNDLING' | 'RUNNING' | 'DRAINING' | 'FINALIZED';
type ConversationRuntimeState = {
  state: ConversationRuntimeStateName;
  generation: number;
  signalSeq: number;
  activeRunCount: number;
  lastRunId: string;
  updatedAt: number;
};
type RuntimeStateTransitionMeta = {
  reasonCode?: string;
  source?: string;
  runId?: string;
  activeRunCount?: number;
  note?: string;
};
type RunInfo = { startedAt: number };
type RunMap = Map<string, RunInfo>;
type ConversationRunMap = Map<string, RunMap>;
type ChatOptions = Record<string, unknown> & { model?: string; __sentraExpectedOutput?: string };
type PresetSnapshot = {
  json?: Record<string, unknown>;
  xml?: string;
  plainText?: string;
  sourcePath?: string;
  sourceFileName?: string;
  rawText?: string;
};
type AgentConfig = {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
};
type AgentWithConfig = InstanceType<typeof Agent> & { config: AgentConfig };

const ENV_PATH = '.env';
loadEnv(ENV_PATH);
initEnvWatcher(ENV_PATH);

const sdk = new SentraMcpSDK();
await sdk.init();
await cleanupExpiredCache();
const WS_HOST = getEnv('WS_HOST', 'localhost');
const WS_PORT = getEnv('WS_PORT', '6702');
const WS_URL = `ws://${WS_HOST}:${WS_PORT}`;

const socket = createWebSocketClient(WS_URL, {
  reconnectIntervalMs: getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000) ?? 10000,
  maxReconnectAttempts: getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60) ?? 60,
  getReconnectIntervalMs: () => getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000) ?? 10000,
  getMaxReconnectAttempts: () => getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60) ?? 60
});
const send = (obj: unknown) => socket.send(obj);

let socialContextManager: SocialContextManager | null = null;

try {
  socket.on('open', () => {
    try {
      if (socialContextManager && typeof socialContextManager.refresh === 'function') {
        socialContextManager.refresh(false).catch(() => { });
      }
    } catch { }
  });
} catch { }

const logger = createLogger('Main');
logger.info(`连接到 WebSocket 服务: ${WS_URL}`);

let runKernelDispatchMessage: ((msg: IncomingMessage, taskId?: string | null) => Promise<void>) | null = null;
let runKernelDispatchRuntimeEvent: ((event: RunKernelRuntimeEvent) => Promise<void>) | null = null;

const taskRecoveryQueue: TaskRecoveryCandidate[] = [];
let taskRecoveryRunning = false;

function getTaskRecoveryCandidateKey(candidate: TaskRecoveryCandidate | null | undefined): string {
  const runId = String(candidate?.runId || candidate?.task?.runId || candidate?.task?.taskId || '').trim();
  if (runId) return `run:${runId}`;
  const conversationId = String(candidate?.conversationId || '').trim();
  if (conversationId) return `conversation:${conversationId}`;
  return '';
}

async function processTaskRecoveryQueue() {
  if (taskRecoveryRunning) return;
  const next = taskRecoveryQueue.shift();
  if (!next) return;
  taskRecoveryRunning = true;
  try {
    await runTaskRecovery(next);
  } catch (e) {
    logger.warn('任务补全队列执行失败', { err: String(e) });
  } finally {
    taskRecoveryRunning = false;
  }
  if (taskRecoveryQueue.length > 0) {
    setTimeout(() => {
      processTaskRecoveryQueue().catch((err) => {
        logger.warn('任务补全队列后续执行失败', { err: String(err) });
      });
    }, 0);
  }
}

function enqueueTaskRecoveryCandidate(candidate: TaskRecoveryCandidate) {
  if (!candidate || !candidate.task) return;
  const candidateKey = getTaskRecoveryCandidateKey(candidate);
  if (candidateKey) {
    const duplicated = taskRecoveryQueue.some((item) => getTaskRecoveryCandidateKey(item) === candidateKey);
    if (duplicated) {
      return;
    }
  }
  taskRecoveryQueue.push(candidate);
  processTaskRecoveryQueue().catch((e) => {
    logger.warn('任务补全入队执行失败', { err: String(e) });
  });
}

// senderId -> Map<conversationKey, Map<runId, { startedAt: number }>>
// 用于在“改主意”场景下通知 MCP 取消对应会话下的运行，避免误伤其他群/私聊
const runningRunsBySender = new Map<string, ConversationRunMap>();
const conversationRuntimeStateBySender = new Map<string, Map<string, ConversationRuntimeState>>();
const runtimeStateTransitionMetrics = {
  totalTransitions: 0,
  byTransition: new Map<string, number>(),
  byStateEnter: new Map<string, number>(),
  byReasonCode: new Map<string, number>(),
  byConversation: new Map<string, number>(),
  lastTransitionAt: 0
};
const RUNTIME_STATE_METRICS_SNAPSHOT_EVERY = 20;

function normalizeRuntimeSignalAction(action: unknown): RuntimeSignalAction {
  const s = String(action || '').trim().toLowerCase();
  if (s === 'cancel') return 'cancel';
  if (s === 'supplement') return 'supplement';
  if (s === 'replan') return 'replan';
  if (s === 'append') return 'append';
  return 'ignore';
}

function ensureConversationRuntimeState(senderId: string, conversationKey: string): ConversationRuntimeState {
  const sKey = String(senderId || '');
  const cKey = String(conversationKey || '');
  let byConv = conversationRuntimeStateBySender.get(sKey);
  if (!byConv) {
    byConv = new Map<string, ConversationRuntimeState>();
    conversationRuntimeStateBySender.set(sKey, byConv);
  }
  let state = byConv.get(cKey);
  if (!state) {
    state = {
      state: 'IDLE',
      generation: 0,
      signalSeq: 0,
      activeRunCount: 0,
      lastRunId: '',
      updatedAt: Date.now()
    };
    byConv.set(cKey, state);
  }
  return state;
}

function bumpCounter(map: Map<string, number>, key: string, delta = 1) {
  const k = String(key || '').trim();
  if (!k) return;
  map.set(k, (map.get(k) || 0) + delta);
}

function snapshotRuntimeStateMetrics() {
  const topN = (src: Map<string, number>, limit = 8) =>
    Array.from(src.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));
  return {
    totalTransitions: runtimeStateTransitionMetrics.totalTransitions,
    lastTransitionAt: runtimeStateTransitionMetrics.lastTransitionAt || 0,
    topTransitions: topN(runtimeStateTransitionMetrics.byTransition),
    topStates: topN(runtimeStateTransitionMetrics.byStateEnter),
    topReasons: topN(runtimeStateTransitionMetrics.byReasonCode),
    topConversations: topN(runtimeStateTransitionMetrics.byConversation)
  };
}

function updateConversationRuntimeState(
  senderId: string,
  conversationKey: string,
  nextState: ConversationRuntimeStateName,
  meta: RuntimeStateTransitionMeta = {}
) {
  const sKey = String(senderId || '');
  const convKey = String(conversationKey || '');
  if (!sKey || !convKey) return;

  const state = ensureConversationRuntimeState(sKey, convKey);
  const prevState = state.state;
  const finalState = String(nextState || '').trim().toUpperCase() as ConversationRuntimeStateName;
  const reasonCode = String(meta.reasonCode || '').trim() || 'unspecified';
  const source = String(meta.source || '').trim() || 'main_runtime';
  const runId = String(meta.runId || '').trim();
  const nowTs = Date.now();
  const activeRunCount = Number.isFinite(Number(meta.activeRunCount))
    ? Math.max(0, Number(meta.activeRunCount))
    : state.activeRunCount;

  state.state = finalState;
  state.activeRunCount = activeRunCount;
  if (runId) state.lastRunId = runId;
  state.updatedAt = nowTs;

  if (prevState !== finalState) {
    runtimeStateTransitionMetrics.totalTransitions += 1;
    runtimeStateTransitionMetrics.lastTransitionAt = nowTs;
    bumpCounter(runtimeStateTransitionMetrics.byTransition, `${prevState}->${finalState}`);
    bumpCounter(runtimeStateTransitionMetrics.byStateEnter, finalState);
    bumpCounter(runtimeStateTransitionMetrics.byReasonCode, reasonCode);
    bumpCounter(runtimeStateTransitionMetrics.byConversation, convKey);
    logger.info('[RuntimeState] transition', {
      sender: sKey,
      conversation: convKey,
      from: prevState,
      to: finalState,
      reason_code: reasonCode,
      source,
      runId: runId || state.lastRunId || '',
      generation: state.generation,
      signalSeq: state.signalSeq,
      activeRunCount: state.activeRunCount,
      note: String(meta.note || '')
    });
    if (runtimeStateTransitionMetrics.totalTransitions % RUNTIME_STATE_METRICS_SNAPSHOT_EVERY === 0) {
      logger.info('[RuntimeStateMetrics] snapshot', snapshotRuntimeStateMetrics());
    }
    return;
  }

  logger.debug('[RuntimeState] unchanged', {
    sender: sKey,
    conversation: convKey,
    state: finalState,
    reason_code: reasonCode,
    source,
    runId: runId || state.lastRunId || '',
    generation: state.generation,
    signalSeq: state.signalSeq,
    activeRunCount: state.activeRunCount
  });
}

function trackRunForSender(senderId: string, conversationKey: string, runId: string) {
  if (!senderId || !runId) return;
  const sKey = String(senderId);
  const convKey = String(conversationKey ?? '');
  let byConv = runningRunsBySender.get(sKey);
  if (!byConv) {
    byConv = new Map<string, RunMap>();
    runningRunsBySender.set(sKey, byConv);
  }
  let runs = byConv.get(convKey);
  if (!runs) {
    runs = new Map<string, RunInfo>();
    byConv.set(convKey, runs);
  }
  const prevSize = runs.size;
  const rid = String(runId);
  if (!runs.has(rid)) {
    runs.set(rid, { startedAt: Date.now() });
  }
  const runtimeState = ensureConversationRuntimeState(sKey, convKey);
  if (prevSize === 0 && runs.size > 0) {
    runtimeState.generation = Math.max(1, runtimeState.generation + 1);
    runtimeState.signalSeq = 0;
  }
  runtimeState.lastRunId = rid;
  updateConversationRuntimeState(sKey, convKey, 'RUNNING', {
    reasonCode: prevSize === 0 ? 'run_started' : 'run_tracked',
    source: 'trackRunForSender',
    runId: rid,
    activeRunCount: runs.size
  });
}

function untrackRunForSender(senderId: string, conversationKey: string, runId: string) {
  if (!senderId || !runId) return;
  const sKey = String(senderId);
  const convKey = String(conversationKey ?? '');
  const byConv = runningRunsBySender.get(sKey);
  if (!byConv) return;
  const runs = byConv.get(convKey);
  if (!runs) return;
  const rid = String(runId);
  runs.delete(rid);
  const runtimeState = ensureConversationRuntimeState(sKey, convKey);
  if (runs.size === 0) {
    byConv.delete(convKey);
    updateConversationRuntimeState(sKey, convKey, 'FINALIZED', {
      reasonCode: 'run_finished',
      source: 'untrackRunForSender',
      runId: rid,
      activeRunCount: 0
    });
  }
  if (byConv.size === 0) {
    runningRunsBySender.delete(sKey);
  }
  if (runs.size > 0) {
    updateConversationRuntimeState(sKey, convKey, 'RUNNING', {
      reasonCode: 'run_still_active',
      source: 'untrackRunForSender',
      runId: rid,
      activeRunCount: runs.size
    });
  }
  runtimeState.updatedAt = Date.now();
}

// 向指定 sender + 会话下的在途运行分发 runtime 用户信号，由 MCP 统一判定（cancel/replan/supplement/ignore）。
// 返回本次实际分发到的 run 数量。
async function dispatchRuntimeSignalForActiveRuns(
  senderId: string,
  conversationKey: string | null,
  options: CancelRunOptions = {}
) : Promise<number> {
  if (!senderId) return 0;
  const sKey = String(senderId);
  const convKey = conversationKey != null ? String(conversationKey) : buildPrivateScopeId(sKey);
  const byConv = runningRunsBySender.get(sKey);
  if (!byConv) return 0;
  const runs = byConv.get(convKey);
  if (!runs || runs.size === 0) {
    const runtimeState0 = ensureConversationRuntimeState(sKey, convKey);
    runtimeState0.updatedAt = Date.now();
    updateConversationRuntimeState(sKey, convKey, 'FINALIZED', {
      reasonCode: 'no_active_run',
      source: 'dispatchRuntimeSignalForActiveRuns',
      activeRunCount: 0
    });
    return 0;
  }

  const now = Date.now();
  const mode = options && typeof options.mode === 'string' ? options.mode : '';
  const cutoffTs = (typeof options.cutoffTs === 'number' && Number.isFinite(options.cutoffTs))
    ? options.cutoffTs
    : now;
  const signalObjective = typeof options.latestUserObjective === 'string'
    ? options.latestUserObjective
    : '';
  const signalObjectiveXml = typeof options.latestUserObjectiveXml === 'string'
    ? options.latestUserObjectiveXml
    : '';
  const signalTextFromXml = (() => {
    const xml = signalObjectiveXml.trim();
    if (!xml) return '';
    const textMatches = collectXmlTagTextValues(xml, ['text']);
    if (textMatches.length > 0) return textMatches.join('\n').trim();
    const preview = collectXmlTagTextValues(xml, ['preview_text']);
    if (preview.length > 0) return preview[0];
    return '';
  })();
  const signalText = signalObjective.trim() || signalTextFromXml;
  if (!signalText) return 0;
  const runtimeState = ensureConversationRuntimeState(sKey, convKey);
  updateConversationRuntimeState(sKey, convKey, 'DRAINING', {
    reasonCode: 'runtime_signal_dispatch_start',
    source: 'dispatchRuntimeSignalForActiveRuns',
    activeRunCount: runs.size
  });
  runtimeState.updatedAt = now;
  if (!Number.isFinite(runtimeState.generation) || runtimeState.generation <= 0) {
    runtimeState.generation = 1;
  }
  runtimeState.signalSeq = Math.max(0, Number(runtimeState.signalSeq || 0)) + 1;
  const requestedAction = normalizeRuntimeSignalAction(options?.action);
  let inferredAction = requestedAction;
  let modelReason = '';
  if (requestedAction === 'ignore') {
    const toolsOnlySystem = String(
      (await baseSystem('must_be_sentra_tools', {
        stage: 'runtime_signal_action_resolver',
        userText: signalText
      })) || ''
    ).trim();
    const resolved = await resolveRuntimeSignalActionByModel({
      chatWithRetry,
      model: getMainRuntimeConfig().mainAiModel,
      systemPrompt: toolsOnlySystem,
      groupId: convKey,
      objective: 'Handle runtime follow-up signal while MCP task is running.',
      signalText,
      signalMeta: JSON.stringify({
        mode,
        source: String(options?.source || ''),
        reason: String(options?.reason || ''),
        conversationKey: convKey,
        senderId: sKey,
        signalObjectiveXml: signalObjectiveXml ? '[present]' : ''
      }),
      timeoutMs: getEnvTimeoutMs('TIMEOUT', 180000, 900000)
    });
    if (resolved) {
      inferredAction = normalizeRuntimeSignalAction(resolved.action);
      modelReason = String(resolved.reason || '').trim();
    }
  }
  const reasonCode = String(options?.reasonCode || '').trim() || (
    inferredAction !== 'ignore'
      ? 'runtime_action_model_resolved'
      : 'active_task_followup'
  );
  const sourceEventId = String(options?.sourceEventId || '').trim();

  let dispatchedCount = 0;
  for (const [rid, info] of runs.entries()) {
    const startedAt = info && Number.isFinite(info.startedAt) ? info.startedAt : 0;
    if (mode === 'conversation' || !startedAt || startedAt <= cutoffTs) {
      try {
        const runtimeSdk = sdk as unknown as {
          reportUserRuntimeSignal?: (params: Record<string, unknown>) => Promise<unknown>;
        };
        if (typeof runtimeSdk.reportUserRuntimeSignal === 'function') {
          runtimeSdk.reportUserRuntimeSignal({
            runId: rid,
            objective: signalText,
            objectiveXml: signalObjectiveXml,
            source: typeof options.source === 'string' ? options.source : 'main_runtime_followup',
            reason: modelReason || (typeof options.reason === 'string' ? options.reason : ''),
            reasonCode,
            ...(sourceEventId ? { sourceEventId } : {}),
            ...(inferredAction !== 'ignore' ? { action: inferredAction } : {}),
            generation: runtimeState.generation,
            signalSeq: runtimeState.signalSeq,
            context: {
              conversationId: convKey,
              channelId: convKey,
              identityKey: convKey,
              userId: sKey,
              generation: runtimeState.generation,
              signalSeq: runtimeState.signalSeq,
              conversationState: runtimeState.state
            }
          }).catch(() => {});
          dispatchedCount += 1;
          runtimeState.lastRunId = rid;
        }
      } catch { }
    }
  }
  if (dispatchedCount > 0) {
    updateConversationRuntimeState(sKey, convKey, 'RUNNING', {
      reasonCode: 'runtime_signal_dispatched',
      source: 'dispatchRuntimeSignalForActiveRuns',
      runId: runtimeState.lastRunId || '',
      activeRunCount: runs.size
    });
    runtimeState.updatedAt = Date.now();
  } else {
    updateConversationRuntimeState(sKey, convKey, 'RUNNING', {
      reasonCode: 'runtime_signal_no_target',
      source: 'dispatchRuntimeSignalForActiveRuns',
      activeRunCount: runs.size
    });
  }
  return dispatchedCount;
}

const apiKey = getEnv('API_KEY');
const apiBaseUrl = String(getEnv('API_BASE_URL', 'https://yuanplus.chat/v1') || 'https://yuanplus.chat/v1');
const defaultModel = String(getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo') || 'gpt-3.5-turbo');
const maxTokens = getEnvInt('MAX_TOKENS', 4096) ?? 4096;

const agent = new Agent({
  ...(apiKey ? { apiKey } : {}),
  apiBaseUrl,
  defaultModel,
  temperature: parseFloat(getEnv('TEMPERATURE', '0.7') || '0.7'),
  maxTokens,
  timeout: getEnvTimeoutMs('TIMEOUT', 180000, 900000)
}) as AgentWithConfig;

onEnvReload(() => {
  try {
    const nextBaseUrl = getEnv('API_BASE_URL', 'https://yuanplus.chat/v1');
    const nextApiKey = getEnv('API_KEY');
    const nextModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo');
    const nextTemperature = parseFloat(getEnv('TEMPERATURE', '0.7') || '0.7');
    const nextMaxTokens = getEnvInt('MAX_TOKENS', 4096) ?? 4096;
    const nextTimeout = getEnvTimeoutMs('TIMEOUT', 180000, 900000);

    if (nextBaseUrl && nextBaseUrl !== agent.config.apiBaseUrl) agent.config.apiBaseUrl = nextBaseUrl;
    if (nextApiKey && nextApiKey !== agent.config.apiKey) agent.config.apiKey = nextApiKey;
    if (nextModel && nextModel !== agent.config.defaultModel) agent.config.defaultModel = nextModel;
    if (Number.isFinite(nextTemperature) && nextTemperature !== agent.config.temperature) agent.config.temperature = nextTemperature;
    if (Number.isFinite(nextMaxTokens) && nextMaxTokens !== agent.config.maxTokens) agent.config.maxTokens = nextMaxTokens;
    if (Number.isFinite(nextTimeout) && nextTimeout !== agent.config.timeout) agent.config.timeout = nextTimeout;
  } catch { }
});

let AGENT_PRESET_RAW_TEXT = '';
let AGENT_PRESET_JSON: Record<string, unknown> | null = null;
let AGENT_PRESET_XML = '';
let AGENT_PRESET_PLAIN_TEXT = '';
let AGENT_PRESET_SOURCE_PATH = '';
let AGENT_PRESET_SOURCE_FILE_NAME = '';
let AGENT_PRESET_WATCHER_STARTED = false;

let WORLDBOOK_RAW_TEXT = '';
let WORLDBOOK_JSON: Record<string, unknown> | null = null;
let WORLDBOOK_XML = '';
let WORLDBOOK_PLAIN_TEXT = '';
let WORLDBOOK_SOURCE_PATH = '';
let WORLDBOOK_SOURCE_FILE_NAME = '';
let WORLDBOOK_WATCHER_STARTED = false;

async function refreshAgentPreset() {
  const snapshot = await initAgentPresetCore(agent);
  AGENT_PRESET_RAW_TEXT = snapshot.rawText || '';
  AGENT_PRESET_JSON = snapshot.json || null;
  AGENT_PRESET_XML = snapshot.xml || '';
  AGENT_PRESET_PLAIN_TEXT = snapshot.plainText || '';
  AGENT_PRESET_SOURCE_PATH = snapshot.sourcePath || '';
  AGENT_PRESET_SOURCE_FILE_NAME = snapshot.sourceFileName || '';
}

async function refreshWorldbook() {
  const snapshot = await initWorldbookCore();
  WORLDBOOK_RAW_TEXT = snapshot.rawText || '';
  WORLDBOOK_JSON = snapshot.json || null;
  WORLDBOOK_XML = snapshot.xml || '';
  WORLDBOOK_PLAIN_TEXT = snapshot.plainText || '';
  WORLDBOOK_SOURCE_PATH = snapshot.sourcePath || '';
  WORLDBOOK_SOURCE_FILE_NAME = snapshot.sourceFileName || '';
}

await refreshAgentPreset();
await refreshWorldbook();

function initAgentPresetWatcher() {
  if (AGENT_PRESET_WATCHER_STARTED) return;
  AGENT_PRESET_WATCHER_STARTED = true;

  const dir = './agent-presets';
  startRefreshWatcher({
    name: 'AgentPresetWatcher',
    dir,
    logger,
    debounceMs: 350,
    getTargets: () => {
      const configured = String(getEnv('AGENT_PRESET_FILE', 'default.txt') || 'default.txt');
      return [
        configured,
        AGENT_PRESET_SOURCE_FILE_NAME,
        'default.txt',
        'default.md',
        'default.json'
      ];
    },
    onRefresh: refreshAgentPreset,
    onRefreshFailedMessage: 'AgentPresetWatcher: 刷新预设失败'
  });
}

initAgentPresetWatcher();

function initWorldbookWatcher() {
  if (WORLDBOOK_WATCHER_STARTED) return;
  WORLDBOOK_WATCHER_STARTED = true;

  const dir = './agent-presets';
  startRefreshWatcher({
    name: 'WorldbookWatcher',
    dir,
    logger,
    debounceMs: 350,
    getTargets: () => {
      const configured = String(getEnv('WORLDBOOK_FILE', 'world/worldbook.json') || 'world/worldbook.json');
      return [
        configured,
        WORLDBOOK_SOURCE_FILE_NAME,
        'world',
        'world/worldbook.json',
        'world/worldbook_generated.json',
        'worldbook.json'
      ];
    },
    onRefresh: refreshWorldbook,
    onRefreshFailedMessage: 'WorldbookWatcher: 刷新世界书失败'
  });
}

initWorldbookWatcher();

function getEmoRuntimeConfig() {
  const timeout = getEnvTimeoutMs('SENTRA_EMO_TIMEOUT', 180000, 900000);
  const baseRaw = getEnv('SENTRA_EMO_URL', '') || '';
  const baseURL = typeof baseRaw === 'string' && baseRaw.trim() ? baseRaw.trim() : undefined;
  return { timeout, baseURL };
}

function getDefaultEmoBaseURL() {
  try {
    const tmp = new SentraEmoCtor();
    return typeof tmp.baseURL === 'string' && tmp.baseURL.trim() ? tmp.baseURL.trim() : undefined;
  } catch {
    return undefined;
  }
}

const emoCfg = getEmoRuntimeConfig();
const emoOptions: { baseURL?: string; timeout: number } = { timeout: emoCfg.timeout };
if (emoCfg.baseURL) emoOptions.baseURL = emoCfg.baseURL;
const emo = new SentraEmoCtor(emoOptions);

onEnvReload(() => {
  try {
    const next = getEmoRuntimeConfig();
    if (next.timeout && next.timeout !== emo.timeout) {
      emo.timeout = next.timeout;
      logger.info(`SentraEmo 配置热更新: timeout=${emo.timeout}ms`);
    }

    const nextBase = next.baseURL || getDefaultEmoBaseURL();
    if (nextBase && nextBase !== emo.baseURL) {
      emo.baseURL = nextBase;
      logger.info('SentraEmo 配置热更新: baseURL 已更新', { baseURL: emo.baseURL });
    }
  } catch (e) {
    logger.warn('SentraEmo 配置热更新失败（已忽略）', { err: String(e) });
  }
});

// 群聊历史记录管理器
const historyManager = new GroupHistoryManager({
  maxConversationPairs: getEnvInt('MAX_CONVERSATION_PAIRS', 20)
});

// 用户画像管理器
const personaOptions: UserPersonaManagerOptions = { agent };
const personaDataDir = getEnv('PERSONA_DATA_DIR', './userData') || './userData';
personaOptions.dataDir = personaDataDir;
personaOptions.updateIntervalMs = getEnvInt('PERSONA_UPDATE_INTERVAL_MS', 600000) ?? 600000;
personaOptions.minMessagesForUpdate = getEnvInt('PERSONA_MIN_MESSAGES', 10) ?? 10;
personaOptions.maxHistorySize = getEnvInt('PERSONA_MAX_HISTORY', 100) ?? 100;
personaOptions.model = getEnv('PERSONA_MODEL', 'grok-4.1') || 'grok-4.1';
personaOptions.baseUrl = getEnv('PERSONA_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')) || 'https://yuanplus.chat/v1';
const personaApiKey = getEnv('PERSONA_API_KEY', getEnv('API_KEY'));
if (personaApiKey) personaOptions.apiKey = personaApiKey;
personaOptions.recentMessagesCount = getEnvInt('PERSONA_RECENT_MESSAGES', 40) ?? 40;
personaOptions.halfLifeMs = getEnvInt('PERSONA_HALFLIFE_MS', 172800000) ?? 172800000;
personaOptions.maxTraits = getEnvInt('PERSONA_MAX_TRAITS', 6) ?? 6;
personaOptions.maxInterests = getEnvInt('PERSONA_MAX_INTERESTS', 8) ?? 8;
personaOptions.maxPatterns = getEnvInt('PERSONA_MAX_PATTERNS', 6) ?? 6;
personaOptions.maxInsights = getEnvInt('PERSONA_MAX_INSIGHTS', 6) ?? 6;
const personaManager = new UserPersonaManager(personaOptions);

if (!personaManager.enabled) {
  logger.info('用户画像功能已禁用（ENABLE_USER_PERSONA=false）');
}

function getMainRuntimeConfig() {
  const mainAiModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo') || 'gpt-3.5-turbo';
  const defaultPairs = getEnvInt('MAX_CONVERSATION_PAIRS', 20) ?? 20;
  const mcpMaxContextPairs = getEnvInt('MCP_MAX_CONTEXT_PAIRS', defaultPairs) ?? defaultPairs;
  return {
    mainAiModel,
    mcpMaxContextPairs,
    contextMemoryEnabled: getEnvBool('CONTEXT_MEMORY_ENABLED', true) ?? true,
    contextMemoryModel: getEnv('CONTEXT_MEMORY_MODEL', mainAiModel) || mainAiModel
  };
}

// 带重试的 AI 响应函数委托到 components/ChatWithRetry.js，避免 Main.ts 过大
async function chatWithRetry(
  conversations: ChatMessage[],
  modelOrOptions: string | ChatOptions,
  groupId?: string
) {
  return chatWithRetryCore(agent, conversations, modelOrOptions, groupId);
}

async function triggerPresetTeachingIfNeeded({
  groupId,
  chatType,
  userId,
  userContent,
  assistantContent
}: {
  groupId?: string;
  chatType?: string;
  userId?: string;
  userContent?: string;
  assistantContent?: string;
}) {
  const result = await triggerPresetTeachingIfNeededCore({
    agent,
    historyManager,
    userContent,
    assistantContent,
    getPresetSnapshot: () => ({
      ...(AGENT_PRESET_JSON ? { json: AGENT_PRESET_JSON } : {}),
      sourcePath: AGENT_PRESET_SOURCE_PATH,
      sourceFileName: AGENT_PRESET_SOURCE_FILE_NAME,
      rawText: AGENT_PRESET_RAW_TEXT
    }),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(userId !== undefined ? { userId } : {})
  });

  const snapshot = result as PresetSnapshot | null;
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }

  // 如果组件已经帮忙生成了衍生字段，则同步回 Main.ts 的全局状态
  if (snapshot.json && typeof snapshot.json === 'object') {
    AGENT_PRESET_JSON = snapshot.json;
    if (snapshot.xml || snapshot.plainText) {
      AGENT_PRESET_XML = snapshot.xml || buildAgentPresetXml(AGENT_PRESET_JSON) || '';
      AGENT_PRESET_PLAIN_TEXT = snapshot.plainText || formatPresetJsonAsPlainText(AGENT_PRESET_JSON) || '';
    } else {
      AGENT_PRESET_XML = buildAgentPresetXml(AGENT_PRESET_JSON) || '';
      AGENT_PRESET_PLAIN_TEXT = formatPresetJsonAsPlainText(AGENT_PRESET_JSON) || '';
    }
  }
}

async function triggerContextSummarizationIfNeeded({
  groupId,
  chatType,
  userId
}: {
  groupId?: string;
  chatType?: string;
  userId?: string;
}) {
  const runtimeCfg = getMainRuntimeConfig();
  const options = {
    agent,
    historyManager,
    MCP_MAX_CONTEXT_PAIRS: runtimeCfg.mcpMaxContextPairs,
    CONTEXT_MEMORY_ENABLED: runtimeCfg.contextMemoryEnabled,
    presetPlainText: AGENT_PRESET_PLAIN_TEXT,
    presetRawText: AGENT_PRESET_RAW_TEXT,
    ...(typeof runtimeCfg.contextMemoryModel === 'string' && runtimeCfg.contextMemoryModel
      ? { CONTEXT_MEMORY_MODEL: runtimeCfg.contextMemoryModel }
      : {}),
    ...(typeof runtimeCfg.mainAiModel === 'string' && runtimeCfg.mainAiModel
      ? { MAIN_AI_MODEL: runtimeCfg.mainAiModel }
      : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(userId !== undefined ? { userId } : {})
  };
  return triggerContextSummarizationIfNeededCore(options);
}

async function runTaskRecovery(candidate: TaskRecoveryCandidate) {
  const candidateSource = String(candidate?.source || '').trim().toLowerCase();
  if (candidateSource && candidateSource !== 'checkpoint') {
    logger.debug('任务补全: 跳过非 checkpoint 候选', { source: candidateSource });
    return;
  }

  const task = (candidate?.task && typeof candidate.task === 'object')
    ? candidate.task
    : null;
  if (!task) return;

  const status = String(task.status || '').trim().toLowerCase();
  if (task.isComplete === true || status === 'completed' || status === 'complete' || status === 'done') {
    return;
  }

  const attempt = Number.isFinite(candidate?.attempt) ? Math.max(1, Number(candidate.attempt)) : 1;
  const resumeRunId = String(candidate?.runId || task.runId || task.taskId || '').trim();
  if (!resumeRunId) {
    logger.debug('任务补全: 缺少可恢复 runId，跳过', { taskId: String(task.taskId || '') || null });
    return;
  }

  const conversationIdRaw = String(candidate?.conversationId || '').trim();
  const groupConversationMatch = conversationIdRaw.match(/^group_(.+?)_sender_(.+)$/i);
  const privateConversationMatch = conversationIdRaw.match(/^private_(.+)$/i);

  let userId = task.userId != null ? String(task.userId).trim() : '';
  if (!userId && groupConversationMatch?.[2]) userId = String(groupConversationMatch[2]).trim();
  if (!userId && privateConversationMatch?.[1]) userId = String(privateConversationMatch[1]).trim();
  if (!userId) return;

  let groupIdRaw = task.groupId != null ? String(task.groupId).trim() : '';
  if (!groupIdRaw && groupConversationMatch?.[1]) {
    groupIdRaw = `G_${String(groupConversationMatch[1]).trim()}`;
  }

  const isGroup = isGroupScopeId(groupIdRaw) || !!groupConversationMatch;
  const groupIdPlain = isGroup
    ? (extractScopeId(groupIdRaw) || String(groupConversationMatch?.[1] || '').trim())
    : '';
  const groupScopeId = isGroup
    ? (isGroupScopeId(groupIdRaw) ? groupIdRaw : `G_${groupIdPlain}`)
    : '';
  const conversationId = conversationIdRaw || (isGroup
    ? `group_${groupIdPlain}_sender_${userId}`
    : `private_${userId}`);

  const activeCount = getActiveTaskCount(conversationId);
  if (activeCount > 0) {
    logger.info(`任务补全跳过: sender=${userId} 当前有活跃任务`, {
      conversationId,
      activeCount
    });
    return;
  }

  const summary = (typeof task.summary === 'string' && task.summary.trim())
    ? task.summary.trim()
    : (typeof task.reason === 'string' && task.reason.trim())
      ? task.reason.trim()
      : (typeof task.objective === 'string' && task.objective.trim())
        ? task.objective.trim()
        : '有一个未完成的任务需要继续';

  const rootXml = buildTaskRecoveryRootDirectiveXml({
    task,
    chatType: isGroup ? 'group' : 'private',
    userId,
    ...(groupScopeId ? { groupId: groupScopeId } : {})
  });

  const recoveryMsg: IncomingMessage = {
    type: isGroup ? 'group' : 'private',
    sender_id: userId,
    text: summary,
    _proactive: true,
    _proactiveFirst: true,
    _disablePreReply: true,
    _taskRecoveryAttempt: attempt,
    _taskRecoverySkipAnalysis: false,
    _sentraRootDirectiveXml: rootXml,
    _taskIdOverride: task.taskId || resumeRunId || null,
    _runtimeResume: {
      fromCheckpoint: true,
      runId: resumeRunId,
      conversationId,
      status: String(task.status || '').trim(),
      stage: String(task.stage || '').trim(),
      objective: String(task.objective || '').trim()
    },
    ...(isGroup ? { group_id: groupIdPlain } : {})
  };

  try {
    if (runKernelDispatchMessage) {
      await runKernelDispatchMessage(recoveryMsg, task.taskId || null);
    } else {
      await handleOneMessage(recoveryMsg, task.taskId || null);
    }
    logger.info('checkpoint task recovery dispatched', {
      taskId: task.taskId || null,
      runId: resumeRunId,
      source: candidateSource || 'checkpoint',
      conversationId,
      attempt
    });
  } catch (e) {
    logger.warn('任务补全执行失败', {
      taskId: task.taskId || null,
      runId: resumeRunId,
      conversationId,
      attempt,
      err: String(e)
    });
  }
}

async function persistRuntimeProtocolState(payload: RuntimeProtocolPersistPayload): Promise<void> {
  const op = String(payload?.op || '').trim().toLowerCase();
  const runId = String(payload?.runId || '').trim();
  if (!runId || !op) return;
  const context = (payload?.context && typeof payload.context === 'object')
    ? payload.context
    : {};
  const source = String(payload?.source || 'main_runtime_protocol').trim() || 'main_runtime_protocol';
  try {
    if (op === 'start') {
      if (typeof persistRuntimeRunStart !== 'function') return;
      await persistRuntimeRunStart({
        runId,
        objective: String(payload?.objective || ''),
        context,
        source
      });
      return;
    }
    if (op === 'checkpoint') {
      if (typeof persistRuntimeCheckpoint !== 'function') return;
      await persistRuntimeCheckpoint({
        runId,
        context,
        patch: (payload?.patch && typeof payload.patch === 'object') ? payload.patch : {},
        event: (payload?.event && typeof payload.event === 'object') ? payload.event : null
      });
      return;
    }
    if (op === 'final') {
      if (typeof persistRuntimeRunFinal !== 'function') return;
      await persistRuntimeRunFinal({
        runId,
        context,
        status: String(payload?.status || 'completed'),
        reasonCode: String(payload?.reasonCode || 'run_finished'),
        source,
        note: String(payload?.note || ''),
        objective: String(payload?.objective || '')
      });
      return;
    }
  } catch (e) {
    logger.debug('runtime protocol persistence skipped', {
      op,
      runId,
      err: String(e)
    });
  }
}

async function handleOneMessage(msg: IncomingMessage, taskId?: string | null) {
  const runtimeCfg = getMainRuntimeConfig();
  return handleOneMessageCore(
    {
      logger: logger as Parameters<typeof handleOneMessageCore>[0]['logger'],
      historyManager: historyManager as Parameters<typeof handleOneMessageCore>[0]['historyManager'],
      timeParser,
      MCP_MAX_CONTEXT_PAIRS: runtimeCfg.mcpMaxContextPairs,
      CONTEXT_MEMORY_ENABLED: runtimeCfg.contextMemoryEnabled,
      getDailyContextMemoryXml,
      personaManager,
      emo,
      buildSentraEmoSection,
      WORLDBOOK_XML,
      AGENT_PRESET_XML,
      AGENT_PRESET_PLAIN_TEXT,
      AGENT_PRESET_RAW_TEXT,
      baseSystem,
      convertHistoryToMCPFormat,
      buildSentraInputBlock,
      buildSentraResultBlock,
      smartSend,
      agent,
      sdk,
      trackRunForSender,
      untrackRunForSender,
      chatWithRetry,
      MAIN_AI_MODEL: runtimeCfg.mainAiModel,
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
      ...(socialContextManager ? { socialContextManager } : {}),
      persistRuntimeProtocolState,
      ...(typeof loadRuntimeRunCheckpointSnapshot === 'function'
        ? { loadRuntimeRunCheckpointSnapshot }
        : {})
    },
    msg,
    taskId
  );
}

const runKernel = createRunKernel({
  logger,
  dispatchMessage: async (msg: Record<string, unknown>, taskId?: string | null) => {
    await handleOneMessage(msg as IncomingMessage, taskId ?? null);
  }
});
runKernelDispatchMessage = async (msg: IncomingMessage, taskId?: string | null) => {
  await runKernel.dispatchUserMessage(msg as unknown as Record<string, unknown>, taskId ?? null);
};
runKernelDispatchRuntimeEvent = async (event: RunKernelRuntimeEvent) => {
  await runKernel.dispatchRuntimeEvent(event);
};

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');

const baseSystemTemplates = {
  auto: "{{sentra_short_root_auto}}\n\n{{sandbox_system_prompt}}\n\n{{qq_system_prompt}}",
  router: "{{sentra_short_root_router}}\n\n{{sentra_router_system_prompt}}\n\n{{qq_system_prompt}}",
  must_be_sentra_message: "{{sandbox_system_prompt_response_only}}",
  must_be_sentra_tools: "{{sandbox_system_prompt_tools_only}}"
};

type BaseSystemKey = keyof typeof baseSystemTemplates;
const baseSystemCache = new Map<string, string>();
function hashStringFNV1a(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function baseSystem(requiredOutput?: string, runtimeOptions?: Record<string, unknown>) {
  const key = typeof requiredOutput === 'string' ? requiredOutput : 'auto';
  const runtimeAddon = buildRuntimeSkillRefsSystemAddon(runtimeOptions);
  const cacheKey = runtimeAddon ? `${key}|${hashStringFNV1a(runtimeAddon)}` : key;
  if (baseSystemCache.has(cacheKey)) return baseSystemCache.get(cacheKey) as string;
  const template = (key in baseSystemTemplates
    ? baseSystemTemplates[key as BaseSystemKey]
    : baseSystemTemplates.auto);
  const resolved = await SentraPromptsSDK(template, PROMPTS_CONFIG_PATH);
  const finalText = runtimeAddon ? `${resolved}\n\n${runtimeAddon}` : resolved;
  baseSystemCache.set(cacheKey, finalText);
  return finalText;
}

async function sendAndWaitResult(message: unknown): Promise<Record<string, unknown> | null> {
  const maxRetriesRaw = getEnvInt('SEND_RPC_MAX_RETRIES', 0) ?? 0;
  const timeoutRaw = getEnvTimeoutMs('SEND_RPC_TIMEOUT_MS', 180000, 900000);

  const maxRetries = Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0
    ? maxRetriesRaw
    : 0;
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? timeoutRaw
    : 180000;

  const doOnce = () => {
    return new Promise<Record<string, unknown> | null>((resolve) => {
      const msg: RpcMessage = (message && typeof message === 'object') ? (message as RpcMessage) : {};
      if (!msg.requestId) {
        try {
          msg.requestId = randomUUID();
        } catch {
          msg.requestId = `${Date.now()}_${Math.random().toString(16).substring(2)}`;
        }
      }
      const requestId = String(msg.requestId ?? '');

      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const handler = (data: unknown) => {
        if (settled) return;
        try {
          const text = (data && typeof (data as { toString?: () => string }).toString === 'function')
            ? (data as { toString: () => string }).toString()
            : '';
          if (!text) return;
          const payload = JSON.parse(text) as { type?: string; requestId?: string } & Record<string, unknown>;
          if (payload.type === 'result' && payload.requestId === requestId) {
            settled = true;
            if (timeout) clearTimeout(timeout);
            socket.off('message', handler);
            resolve(payload);
          }
        } catch (e) { }
      };

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`请求超时: ${requestId}`);
        socket.off('message', handler);
        resolve(null);
      }, timeoutMs);

      socket.on('message', handler);
      send(msg);
    });
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await doOnce();
    if (result === null) {
      if (attempt < maxRetries) {
        logger.warn(`RPC请求超时，准备重试 (${attempt + 1}/${maxRetries})`);
        continue;
      }
      return null;
    }

    if (result.ok) return result;

    try {
      const errMsg = result?.error != null ? String(result.error) : '';
      const requestId = result?.requestId != null ? String(result.requestId) : '';
      logger.warn(`RPC返回错误: requestId=${requestId || 'unknown'}${errMsg ? `, error=${errMsg}` : ''}`);
    } catch { }
    return null;
  }

  return null;
}

try {
  socialContextManager = new SocialContextManager({ sendAndWaitResult });
  // socialContextManager.refresh(false).catch(() => { }); // 注释掉：等待 WS open 事件时再刷新
} catch { }

const runtimeResumeController = createRuntimeResumeController({
  logger,
  enqueueDelayedJob,
  dispatchRuntimeEvent: async (event) => {
    if (!event || typeof event !== 'object') return;
    if (runKernelDispatchRuntimeEvent) {
      await runKernelDispatchRuntimeEvent(event as RunKernelRuntimeEvent);
      return;
    }
    logger.warn('RuntimeResume: runtime event dropped (kernel dispatcher unavailable)', {
      type: String((event as { type?: unknown })?.type || '')
    });
  },
  ...(typeof listRuntimeDelaySessionSnapshots === 'function' ? { listRuntimeDelaySessionSnapshots } : {}),
  ...(typeof loadRuntimeDelaySessionSnapshot === 'function' ? { loadRuntimeDelaySessionSnapshot } : {}),
  ...(typeof loadRuntimeRunCheckpointSnapshot === 'function' ? { loadRuntimeRunCheckpointSnapshot } : {}),
  ...(typeof listRuntimeRunCheckpointSnapshots === 'function' ? { listRuntimeRunCheckpointSnapshots } : {}),
  ...(typeof persistRuntimeCheckpoint === 'function' ? { persistRuntimeCheckpoint } : {})
});

const loadDelayRuntimeSessionFromRuntimeStore = async (params: {
  delaySessionId?: string;
  runId?: string;
  orchestratorRunId?: string;
}): Promise<DelayRuntimeSessionSnapshot | null> => {
  return runtimeResumeController.loadDelayRuntimeSessionFromRuntimeStore(params);
};

const persistDelayRuntimeSessionToRuntimeStore = async (params: {
  runId?: string;
  orchestratorRunId?: string;
  session: Record<string, unknown>;
  eventType: string;
}) => {
  return runtimeResumeController.persistDelayRuntimeSessionToRuntimeStore(params);
};

const delayJobRunJob = createDelayJobRunJob({
  HistoryStore,
  loadMessageCache,
  loadDelayRuntimeSessionFromRuntimeStore,
  persistDelayRuntimeSessionToRuntimeStore,
  dispatchRuntimeEvent: async (event) => {
    if (runKernelDispatchRuntimeEvent) {
      await runKernelDispatchRuntimeEvent(event as RunKernelRuntimeEvent);
      return;
    }
    if (runKernelDispatchMessage && event?.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      const msg = (payload.baseMessage && typeof payload.baseMessage === 'object')
        ? (payload.baseMessage as IncomingMessage)
        : null;
      if (msg) {
        await runKernelDispatchMessage(msg, null);
      }
    }
  },
  sdk,
  historyManager,
  buildSentraResultBlock,
  buildSentraInputBlock,
  getDailyContextMemoryXml,
  personaManager,
  emo,
  buildSentraEmoSection,
  WORLDBOOK_XML,
  AGENT_PRESET_XML,
  baseSystem,
  CONTEXT_MEMORY_ENABLED: () => getMainRuntimeConfig().contextMemoryEnabled,
  MAIN_AI_MODEL: () => getMainRuntimeConfig().mainAiModel,
  triggerContextSummarizationIfNeeded,
  triggerPresetTeachingIfNeeded,
  chatWithRetry,
  smartSend,
  sendAndWaitResult,
  randomUUID,
  getActiveTaskCount,
  socialContextManager,
  agent
});

const delayQueueIntervalMsRaw = getEnvInt('DELAY_QUEUE_POLL_INTERVAL_MS', 1000);
const delayQueueMaxLagMsRaw = getEnvInt('DELAY_QUEUE_MAX_LAG_MS', 0);
const delayQueueIntervalMs = Number.isFinite(Number(delayQueueIntervalMsRaw))
  ? Number(delayQueueIntervalMsRaw)
  : 1000;
const delayQueueMaxLagMs = Number.isFinite(Number(delayQueueMaxLagMsRaw))
  ? Number(delayQueueMaxLagMsRaw)
  : 0;

startDelayJobWorker({
  intervalMs: delayQueueIntervalMs,
  maxLagMs: delayQueueMaxLagMs,
  runJob: delayJobRunJob
});
runtimeResumeController.restoreRuntimeFromCheckpoints().catch((e) => {
  logger.warn('RuntimeResume: startup restore failed', { err: String(e) });
});

setupSocketHandlers({
  socket,
  logger,
  emo,
  historyManager,
  personaManager,
  getActiveTaskCount,
  handleIncomingMessage,
  dispatchRuntimeSignalForActiveRuns,
  markConversationRuntimeState: (senderId, conversationId, state, meta = {}) => {
    updateConversationRuntimeState(senderId, conversationId, state, {
      reasonCode: String(meta.reasonCode || '').trim() || 'socket_runtime_state',
      source: String(meta.source || '').trim() || 'socket_handlers',
      runId: String(meta.runId || '').trim(),
      note: String(meta.note || '').trim()
    });
  },
  collectBundleForSender,
  shouldReply,
  handleOneMessage: async (msg, taskId) => {
    if (runKernelDispatchMessage) {
      await runKernelDispatchMessage(msg as IncomingMessage, taskId ?? null);
      return;
    }
    await handleOneMessage(msg as IncomingMessage, taskId ?? null);
  },
  triggerContextSummarizationIfNeeded
});

startPendingTaskScheduler({
  getActiveTaskCount,
  ...(typeof listRuntimeRunCheckpointSnapshots === 'function'
    ? { listRuntimeRunCheckpointSnapshots }
    : {}),
  onCandidate: enqueueTaskRecoveryCandidate
});




