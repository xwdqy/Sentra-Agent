import { loadEnv, initEnvWatcher, getEnv, getEnvInt, getEnvBool } from './utils/envHotReloader.js';
import SentraMcpSDK from 'sentra-mcp';
import SentraPromptsSDK from 'sentra-prompts';
import { Agent } from "./agent.js";
import fs from 'fs';
import { createWebSocketClient } from './components/WebSocketClient.js';
import { buildSentraResultBlock, buildSentraUserQuestionBlock, convertHistoryToMCPFormat } from './utils/protocolUtils.js';
import { smartSend } from './utils/sendUtils.js';
import { cleanupExpiredCache } from './utils/messageCache.js';
import SentraEmo from './sentra-emo/sdk/index.js';
import { timeParser } from './src/time-parser.js';
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
import UserPersonaManager from './utils/userPersonaManager.js';
import { createLogger } from './utils/logger.js';
import { getDailyContextMemoryXml } from './utils/contextMemoryManager.js';
import {
  handleIncomingMessage,
  startBundleForQueuedMessage,
  collectBundleForSender,
  drainPendingMessagesForSender
} from './utils/messageBundler.js';
import { decideOverrideIntent } from './utils/replyIntervention.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from './utils/jsonToSentraXmlConverter.js';
import { chatWithRetry as chatWithRetryCore } from './components/ChatWithRetry.js';
import { triggerContextSummarizationIfNeededCore } from './components/ContextSummarizer.js';
import { triggerPresetTeachingIfNeededCore } from './components/PresetTeachingTrigger.js';
import { handleOneMessageCore } from './components/MessagePipeline.js';
import { setupSocketHandlers } from './components/SocketHandlers.js';
import { initAgentPresetCore } from './components/AgentPresetInitializer.js';

const ENV_PATH = process.env.ENV_FILE || '.env';
loadEnv(ENV_PATH);
initEnvWatcher(ENV_PATH);

const sdk = new SentraMcpSDK();
await sdk.init();
await cleanupExpiredCache();
const WS_HOST = getEnv('WS_HOST', 'localhost');
const WS_PORT = getEnv('WS_PORT', '6702');
const WS_TIMEOUT = getEnvInt('WS_TIMEOUT', 10000);
const WS_RECONNECT_INTERVAL_MS = getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000);
const WS_MAX_RECONNECT_ATTEMPTS = getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60);
const WS_URL = `ws://${WS_HOST}:${WS_PORT}`;

const socket = createWebSocketClient(WS_URL, {
  reconnectIntervalMs: WS_RECONNECT_INTERVAL_MS,
  maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS
});
const send = (obj) => socket.send(obj);

const logger = createLogger('Main');
logger.info(`连接到 WebSocket 服务: ${WS_URL}`);

// senderId -> Set<runId>：用于在“改主意”场景下通知 MCP 取消对应运行
const runningRunsBySender = new Map();

function trackRunForSender(senderId, runId) {
  if (!senderId || !runId) return;
  const key = String(senderId);
  let set = runningRunsBySender.get(key);
  if (!set) {
    set = new Set();
    runningRunsBySender.set(key, set);
  }
  set.add(String(runId));
}

function untrackRunForSender(senderId, runId) {
  if (!senderId || !runId) return;
  const key = String(senderId);
  const set = runningRunsBySender.get(key);
  if (!set) return;
  set.delete(String(runId));
  if (set.size === 0) {
    runningRunsBySender.delete(key);
  }
}

function cancelRunsForSender(senderId) {
  if (!senderId) return;
  const key = String(senderId);
  const set = runningRunsBySender.get(key);
  if (!set || set.size === 0) return;
  for (const rid of set) {
    try { sdk.cancelRun?.(rid); } catch {}
  }
}

const agent = new Agent({
  apiKey: getEnv('API_KEY', process.env.OPENAI_API_KEY),
  apiBaseUrl: getEnv('API_BASE_URL', 'https://api.openai.com/v1'),
  defaultModel: getEnv('MAIN_AI_MODEL', getEnv('MODEL_NAME', 'gpt-3.5-turbo')),
  temperature: parseFloat(getEnv('TEMPERATURE', '0.7')),
  maxTokens: getEnvInt('MAX_TOKENS', 4096),
  maxRetries: getEnvInt('MAX_RETRIES', 3),
  timeout: getEnvInt('TIMEOUT', 60000)
});

let AGENT_PRESET_RAW_TEXT = '';
let AGENT_PRESET_JSON = null;
let AGENT_PRESET_XML = '';
let AGENT_PRESET_PLAIN_TEXT = '';
let AGENT_PRESET_SOURCE_PATH = '';
let AGENT_PRESET_SOURCE_FILE_NAME = '';
let AGENT_PRESET_WATCHER_STARTED = false;

async function refreshAgentPreset() {
  const snapshot = await initAgentPresetCore(agent);
  AGENT_PRESET_RAW_TEXT = snapshot.rawText || '';
  AGENT_PRESET_JSON = snapshot.json || null;
  AGENT_PRESET_XML = snapshot.xml || '';
  AGENT_PRESET_PLAIN_TEXT = snapshot.plainText || '';
  AGENT_PRESET_SOURCE_PATH = snapshot.sourcePath || '';
  AGENT_PRESET_SOURCE_FILE_NAME = snapshot.sourceFileName || '';
}

await refreshAgentPreset();

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

const SENTRA_EMO_TIMEOUT = getEnvInt('SENTRA_EMO_TIMEOUT', 60000);
const emo = new SentraEmo({ 
  baseURL: getEnv('SENTRA_EMO_URL', undefined) || undefined, 
  timeout: SENTRA_EMO_TIMEOUT 
});

// 群聊历史记录管理器
const historyManager = new GroupHistoryManager({
  maxConversationPairs: getEnvInt('MAX_CONVERSATION_PAIRS', 20)
});

// 用户画像管理器
const ENABLE_USER_PERSONA = getEnvBool('ENABLE_USER_PERSONA', true);
const personaManager = ENABLE_USER_PERSONA ? new UserPersonaManager({
  agent: agent,
  dataDir: getEnv('PERSONA_DATA_DIR', './userData'),
  updateIntervalMs: getEnvInt('PERSONA_UPDATE_INTERVAL_MS', 600000),
  minMessagesForUpdate: getEnvInt('PERSONA_MIN_MESSAGES', 10),
  maxHistorySize: getEnvInt('PERSONA_MAX_HISTORY', 100),
  model: getEnv('PERSONA_MODEL', 'gpt-4o-mini'),
  recentMessagesCount: getEnvInt('PERSONA_RECENT_MESSAGES', 40),
  halfLifeMs: getEnvInt('PERSONA_HALFLIFE_MS', 172800000),
  maxTraits: getEnvInt('PERSONA_MAX_TRAITS', 6),
  maxInterests: getEnvInt('PERSONA_MAX_INTERESTS', 8),
  maxPatterns: getEnvInt('PERSONA_MAX_PATTERNS', 6),
  maxInsights: getEnvInt('PERSONA_MAX_INSIGHTS', 6)
}) : null;

if (!ENABLE_USER_PERSONA) {
  logger.info('用户画像功能已禁用（ENABLE_USER_PERSONA=false）');
}

const MAIN_AI_MODEL = getEnv('MAIN_AI_MODEL', getEnv('MODEL_NAME', 'gpt-3.5-turbo'));
const MCP_MAX_CONTEXT_PAIRS = getEnvInt('MCP_MAX_CONTEXT_PAIRS', getEnvInt('MAX_CONVERSATION_PAIRS', 20));
const CONTEXT_MEMORY_ENABLED = getEnvBool('CONTEXT_MEMORY_ENABLED', true);
const CONTEXT_MEMORY_MODEL = getEnv('CONTEXT_MEMORY_MODEL', MAIN_AI_MODEL);
const CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS = getEnvInt('CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS', 0);

// 带重试的 AI 响应函数委托到 components/ChatWithRetry.js，避免 Main.js 过大
async function chatWithRetry(conversations, modelOrOptions, groupId) {
  return chatWithRetryCore(agent, conversations, modelOrOptions, groupId);
}

async function triggerPresetTeachingIfNeeded({ groupId, chatType, userId, userContent, assistantContent }) {
  const result = await triggerPresetTeachingIfNeededCore({
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    userContent,
    assistantContent,
    getPresetSnapshot: () => ({
      json: AGENT_PRESET_JSON,
      sourcePath: AGENT_PRESET_SOURCE_PATH,
      sourceFileName: AGENT_PRESET_SOURCE_FILE_NAME,
      rawText: AGENT_PRESET_RAW_TEXT
    })
  });

  if (!result || typeof result !== 'object') {
    return;
  }

  // 如果组件已经帮忙生成了衍生字段，则同步回 Main.js 的全局状态
  if (result.json && typeof result.json === 'object') {
    AGENT_PRESET_JSON = result.json;
    if (result.xml || result.plainText) {
      AGENT_PRESET_XML = result.xml || buildAgentPresetXml(AGENT_PRESET_JSON) || '';
      AGENT_PRESET_PLAIN_TEXT = result.plainText || formatPresetJsonAsPlainText(AGENT_PRESET_JSON) || '';
    } else {
      AGENT_PRESET_XML = buildAgentPresetXml(AGENT_PRESET_JSON) || '';
      AGENT_PRESET_PLAIN_TEXT = formatPresetJsonAsPlainText(AGENT_PRESET_JSON) || '';
    }
  }
}

async function triggerContextSummarizationIfNeeded({ groupId, chatType, userId }) {
  return triggerContextSummarizationIfNeededCore({
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    MCP_MAX_CONTEXT_PAIRS,
    CONTEXT_MEMORY_ENABLED,
    CONTEXT_MEMORY_MODEL,
    CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS,
    MAIN_AI_MODEL,
    presetPlainText: AGENT_PRESET_PLAIN_TEXT,
    presetRawText: AGENT_PRESET_RAW_TEXT
  });
}

// 处理一条（可能已聚合的）消息，并在完成后尝试拉起队列中的下一条
async function handleOneMessage(msg, taskId) {
  return handleOneMessageCore(
    {
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
    },
    msg,
    taskId
  );
}

const baseSystemText = "{{sandbox_system_prompt}}\n{{sentra_tools_rules}}\n现在时间：{{time}}\n\n平台：\n{{qq_system_prompt}}";
const baseSystem = await SentraPromptsSDK(baseSystemText);

function sendAndWaitResult(message) {
  return new Promise((resolve) => {
    const msg = message || {};
    if (!msg.requestId) {
      try {
        msg.requestId = randomUUID();
      } catch {
        msg.requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      }
    }
    const requestId = msg.requestId;
    const timeout = setTimeout(() => {
      logger.warn(`请求超时: ${requestId}`);
      resolve(null);
    }, WS_TIMEOUT);

    const handler = (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'result' && payload.requestId === requestId) {
          clearTimeout(timeout);
          socket.off('message', handler);
          resolve(payload.ok ? payload : null);
        }
      } catch (e) {}
    };

    socket.on('message', handler);
    send(msg);
  });
}

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
  collectBundleForSender,
  shouldReply,
  handleOneMessage
});