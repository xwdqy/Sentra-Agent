import { loadEnv, initEnvWatcher, getEnv, getEnvInt, getEnvBool, getEnvTimeoutMs, onEnvReload } from './utils/envHotReloader.js';
import SentraMcpSDK from 'sentra-mcp';
import SentraPromptsSDK from 'sentra-prompts';
import { Agent } from "./src/agentRuntime.js";
import fs from 'fs';
import path from 'path';
import { createWebSocketClient } from './components/WebSocketClient.js';
import { buildSentraResultBlock, buildSentraUserQuestionBlock, convertHistoryToMCPFormat } from './utils/protocolUtils.js';
import { smartSend } from './utils/sendUtils.js';
import { cleanupExpiredCache, saveMessageCache, loadMessageCache } from './utils/messageCache.js';
import { SocialContextManager } from './utils/socialContextManager.js';
import { timeParser } from './src/time-parser.js';
type HistoryStoreLike = { list: (runId: string, start: number, end: number) => Promise<unknown> };
import { buildSentraEmoSection } from './utils/emoXml.js';
import {
  shouldReply,
  completeTask,
  getActiveTaskCount,
  isTaskCancelled,
  clearCancelledTask,
  markTasksCancelledForSender
} from './utils/replyPolicy.js';
import { randomUUID } from 'crypto';
import GroupHistoryManager from './utils/groupHistoryManager.js';
import UserPersonaManager, { type UserPersonaManagerOptions } from './utils/userPersonaManager.js';
import { createLogger } from './utils/logger.js';
import { getDailyContextMemoryXml } from './utils/contextMemoryManager.js';
import {
  handleIncomingMessage,
  startBundleForQueuedMessage,
  collectBundleForSender,
  drainPendingMessagesForSender,
  requeuePendingMessageForSender
} from './utils/messageBundler.js';
import { decideOverrideIntent } from './utils/replyIntervention.js';
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
import { triggerTaskCompletionAnalysis } from './components/TaskCompletionAnalyzer.js';
import { handleGroupReplyCandidate } from './utils/groupReplyMerger.js';
import { startDelayJobWorker, enqueueDelayedJob } from './utils/delayJobQueue.js';
import { createDelayJobRunJob } from './components/DelayJobWorker.js';
import type { ChatMessage } from './src/types.js';

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

type RpcMessage = Record<string, unknown> & { requestId?: string };
type TaskPromise = { content?: string; evidence?: string; fulfilled?: boolean };
type TaskToolCall = { name?: string; code?: string; success?: boolean };
type TaskRecoveryTask = {
  taskId?: string;
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
  jsonPath?: string;
  attempt?: number;
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
  objective?: string;
  at_users?: Array<string | number>;
  time_str?: string;
  [key: string]: unknown;
};
type CancelRunOptions = { mode?: string; cutoffTs?: number };
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

const taskRecoveryQueue: TaskRecoveryCandidate[] = [];
let taskRecoveryRunning = false;

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
  taskRecoveryQueue.push(candidate);
  processTaskRecoveryQueue().catch((e) => {
    logger.warn('任务补全入队执行失败', { err: String(e) });
  });
}

// senderId -> Map<conversationKey, Map<runId, { startedAt: number }>>
// 用于在“改主意”场景下通知 MCP 取消对应会话下的运行，避免误伤其他群/私聊
const runningRunsBySender = new Map<string, ConversationRunMap>();

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
  const rid = String(runId);
  if (!runs.has(rid)) {
    runs.set(rid, { startedAt: Date.now() });
  }
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
  if (runs.size === 0) {
    byConv.delete(convKey);
  }
  if (byConv.size === 0) {
    runningRunsBySender.delete(sKey);
  }
}

// 精准取消：仅取消指定 sender + 会话下、在 cutoffTs 之前启动的运行
function cancelRunsForSender(senderId: string, conversationKey: string | null, options: CancelRunOptions = {}) {
  if (!senderId) return;
  const sKey = String(senderId);
  const convKey = conversationKey != null ? String(conversationKey) : `U:${sKey}`;
  const byConv = runningRunsBySender.get(sKey);
  if (!byConv) return;
  const runs = byConv.get(convKey);
  if (!runs || runs.size === 0) return;

  const now = Date.now();
  const mode = options && typeof options.mode === 'string' ? options.mode : '';
  const cutoffTs = (typeof options.cutoffTs === 'number' && Number.isFinite(options.cutoffTs))
    ? options.cutoffTs
    : now;

  for (const [rid, info] of runs.entries()) {
    const startedAt = info && Number.isFinite(info.startedAt) ? info.startedAt : 0;
    if (mode === 'conversation' || !startedAt || startedAt <= cutoffTs) {
      try {
        sdk.cancelRun?.(rid);
      } catch { }
      runs.delete(rid);
    }
  }

  if (runs.size === 0) {
    byConv.delete(convKey);
  }
  if (byConv.size === 0) {
    runningRunsBySender.delete(sKey);
  }
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
  try {
    if (!fs.existsSync(dir)) {
      logger.warn('AgentPresetWatcher: 预设目录不存在，跳过监听', { path: dir });
      return;
    }

    fs.watch(dir, { persistent: false }, async (eventType, filename) => {
      try {
        logger.info('AgentPresetWatcher: 检测到预设目录变更', {
          eventType,
          filename: filename || ''
        });
        await refreshAgentPreset();
      } catch (e) {
        logger.warn('AgentPresetWatcher: 刷新预设失败', { err: String(e) });
      }
    });

    logger.info('AgentPresetWatcher: 已启动预设目录监听', { path: dir });
  } catch (e) {
    logger.warn('AgentPresetWatcher: 启动监听失败', { err: String(e) });
  }
}

initAgentPresetWatcher();

function initWorldbookWatcher() {
  if (WORLDBOOK_WATCHER_STARTED) return;
  WORLDBOOK_WATCHER_STARTED = true;

  const dir = './agent-presets';
  try {
    if (!fs.existsSync(dir)) {
      logger.warn('WorldbookWatcher: 世界书目录不存在，跳过监听', { path: dir });
      return;
    }

    fs.watch(dir, { persistent: false }, async (eventType, filename) => {
      try {
        logger.info('WorldbookWatcher: 检测到世界书目录变更', {
          eventType,
          filename: filename || ''
        });
        await refreshWorldbook();
      } catch (e) {
        logger.warn('WorldbookWatcher: 刷新世界书失败', { err: String(e) });
      }
    });

    logger.info('WorldbookWatcher: 已启动世界书目录监听', { path: dir });
  } catch (e) {
    logger.warn('WorldbookWatcher: 启动监听失败', { err: String(e) });
  }
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
    contextMemoryModel: getEnv('CONTEXT_MEMORY_MODEL', mainAiModel) || mainAiModel,
    contextMemoryTriggerDiscardedPairs: getEnvInt('CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS', 0) ?? 0
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
    CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS: runtimeCfg.contextMemoryTriggerDiscardedPairs,
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
  const getRecoveryRuntimeConfig = () => {
    const maxFailureAttemptsRaw = getEnvInt('TASK_RECOVERY_MAX_FAILURE_ATTEMPTS', 2);
    const fileTtlHoursRaw = getEnvInt('TASK_RECOVERY_FILE_TTL_HOURS', 24);
    const maxFailureAttempts = Number.isFinite(maxFailureAttemptsRaw) && Number(maxFailureAttemptsRaw) > 0
      ? Math.max(1, Number(maxFailureAttemptsRaw))
      : 2;
    const fileTtlHours = Number.isFinite(fileTtlHoursRaw) && Number(fileTtlHoursRaw) > 0
      ? Number(fileTtlHoursRaw)
      : 24;
    return { maxFailureAttempts, fileTtlHours };
  };

  const toEpochMs = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value !== 'string') return 0;
    const s = value.trim();
    if (!s) return 0;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n;
    const ts = Date.parse(s);
    if (Number.isFinite(ts) && ts > 0) return ts;
    return 0;
  };

  const deleteTaskArtifacts = async (jsonPathRaw: string | null | undefined) => {
    const p = jsonPathRaw ? String(jsonPathRaw) : '';
    if (!p) return;
    try {
      await fs.promises.unlink(p);
    } catch { }
    try {
      const mdPath = p.replace(/\.json$/i, '.md');
      if (mdPath && mdPath !== p) {
        await fs.promises.unlink(mdPath);
      }
    } catch { }
  };

  const markFailureAndMaybeDelete = async (jsonPathRaw: string | null | undefined, taskRaw: TaskRecoveryTask | null) => {
    const p = jsonPathRaw ? String(jsonPathRaw) : '';
    if (!p) return;
    const cfg = getRecoveryRuntimeConfig();
    let current: TaskRecoveryTask = taskRaw && typeof taskRaw === 'object' ? { ...taskRaw } : {};
    if (!current || typeof current !== 'object') current = {};
    try {
      const raw = await fs.promises.readFile(p, 'utf-8');
      const fromDisk = JSON.parse(raw);
      if (fromDisk && typeof fromDisk === 'object') {
        current = { ...(fromDisk as TaskRecoveryTask) };
      }
    } catch { }

    const prevCount = Number.isFinite(Number(current.recoveryCount)) ? Number(current.recoveryCount) : 0;
    const nextCount = Math.max(0, prevCount) + 1;
    if (nextCount >= cfg.maxFailureAttempts) {
      await deleteTaskArtifacts(p);
      logger.info('任务补全失败达到阈值，已删除任务文件', {
        jsonPath: p,
        recoveryCount: nextCount,
        maxFailureAttempts: cfg.maxFailureAttempts
      });
      return;
    }

    const nowMs = Date.now();
    const createdAtMs = toEpochMs(current.createdAt) || toEpochMs(current.timestamp) || nowMs;
    const expiresAtMs = toEpochMs(current.expiresAt) || (createdAtMs + cfg.fileTtlHours * 3600 * 1000);

    const nextTask: TaskRecoveryTask = {
      ...current,
      recoveryCount: nextCount,
      createdAt: createdAtMs,
      expiresAt: expiresAtMs,
      lastRecoveryAt: nowMs,
      lastRecoveryStatus: 'failed'
    };

    try {
      await fs.promises.writeFile(p, JSON.stringify(nextTask, null, 2), 'utf-8');
      logger.info('任务补全失败，已写回重试计数', {
        jsonPath: p,
        recoveryCount: nextCount,
        maxFailureAttempts: cfg.maxFailureAttempts
      });
    } catch (e) {
      logger.warn('任务补全失败写回任务文件失败，删除以避免滞留', {
        jsonPath: p,
        err: String(e)
      });
      await deleteTaskArtifacts(p);
    }
  };

  const jsonPath = candidate?.jsonPath;
  const attempt = Number.isFinite(candidate?.attempt) ? Number(candidate.attempt) : 1;
  let task: TaskRecoveryTask | null = candidate?.task || null;
  if (jsonPath) {
    try {
      const raw = await fs.promises.readFile(jsonPath, 'utf-8');
      task = JSON.parse(raw) as TaskRecoveryTask;
    } catch (e) {
      logger.debug('任务补全: 读取任务文件失败，跳过', { err: String(e), jsonPath });
      return;
    }
  }
  if (!task || typeof task !== 'object') return;
  if (task.isComplete === true) return;

  const userId = task.userId != null ? String(task.userId) : '';
  if (!userId) return;

  const groupIdRaw = task.groupId != null ? String(task.groupId) : '';
  const isGroup = groupIdRaw && groupIdRaw.startsWith('G:');
  const groupIdPlain = isGroup ? groupIdRaw.substring(2) : '';
  const conversationId = isGroup
    ? `group_${groupIdPlain}_sender_${userId}`
    : `private_${userId}`;

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
      : '有一个未完成的任务需要继续';

  const rootXml = buildTaskRecoveryRootDirectiveXml({
    task,
    chatType: isGroup ? 'group' : 'private',
    userId,
    ...(groupIdRaw ? { groupId: groupIdRaw } : {})
  });

  const recoveryMsg: IncomingMessage = {
    type: isGroup ? 'group' : 'private',
    sender_id: userId,
    text: summary,
    _proactive: true,
    _proactiveFirst: true,
    _disablePreReply: true,
    _taskRecoveryAttempt: attempt,
    _taskRecoverySkipSave: false,
    _taskRecoveryForceSave: true,
    _taskRecoverySkipAnalysis: true,
    _sentraRootDirectiveXml: rootXml,
    _taskFile: jsonPath || null,
    _taskIdOverride: task.taskId || null,
    ...(isGroup ? { group_id: groupIdPlain } : {})
  };

  try {
    await handleOneMessage(recoveryMsg, task.taskId || null);
    await deleteTaskArtifacts(jsonPath || null);
    logger.info('任务补全执行成功，已删除任务文件', {
      jsonPath: jsonPath || null,
      taskId: task.taskId || null
    });
  } catch (e) {
    logger.warn('任务补全执行失败', {
      jsonPath: jsonPath || null,
      taskId: task.taskId || null,
      err: String(e)
    });
    await markFailureAndMaybeDelete(jsonPath || null, task);
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
      buildSentraUserQuestionBlock,
      buildSentraResultBlock,
      smartSend,
      agent,
      sdk,
      isTaskCancelled,
      trackRunForSender,
      untrackRunForSender,
      chatWithRetry,
      MAIN_AI_MODEL: runtimeCfg.mainAiModel,
      triggerContextSummarizationIfNeeded,
      triggerPresetTeachingIfNeeded,
      clearCancelledTask,
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
      triggerTaskCompletionAnalysis
    },
    msg,
    taskId
  );
}

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');

const baseSystemTemplates = {
  auto: "{{sentra_short_root_auto}}\n\n{{sandbox_system_prompt}}\n\n{{qq_system_prompt}}",
  router: "{{sentra_short_root_router}}\n\n{{sentra_router_system_prompt}}\n\n{{qq_system_prompt}}",
  must_be_sentra_response: "{{sentra_short_root_response_only}}\n\n{{sentra_protocol_response_only}}\n\n{{sentra_protocol_format}}\n\n{{qq_system_prompt}}",
  must_be_sentra_tools: "{{sentra_short_root_tools_only}}\n\n{{sentra_protocol_tools_only}}\n\n{{sentra_protocol_result_schedule}}\n\n{{qq_system_prompt}}"
};

type BaseSystemKey = keyof typeof baseSystemTemplates;
const baseSystemCache = new Map<string, string>();
async function baseSystem(requiredOutput?: string) {
  const key = typeof requiredOutput === 'string' ? requiredOutput : 'auto';
  if (baseSystemCache.has(key)) return baseSystemCache.get(key) as string;
  const template = (key in baseSystemTemplates
    ? baseSystemTemplates[key as BaseSystemKey]
    : baseSystemTemplates.auto);
  const resolved = await SentraPromptsSDK(template, PROMPTS_CONFIG_PATH);
  baseSystemCache.set(key, resolved);
  return resolved;
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

    return result.ok ? result : null;
  }

  return null;
}

try {
  socialContextManager = new SocialContextManager({ sendAndWaitResult });
  // socialContextManager.refresh(false).catch(() => { }); // 注释掉：等待 WS open 事件时再刷新
} catch { }

const delayJobRunJob = createDelayJobRunJob({
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
  triggerTaskCompletionAnalysis,
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

setupSocketHandlers({
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
});

startPendingTaskScheduler({
  rootDir: './taskData',
  getActiveTaskCount,
  onCandidate: enqueueTaskRecoveryCandidate
});

