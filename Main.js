import { loadEnv, initEnvWatcher, getEnv, getEnvInt, getEnvBool, onEnvReload } from './utils/envHotReloader.js';
import SentraMcpSDK from 'sentra-mcp';
import SentraPromptsSDK from 'sentra-prompts';
import { Agent } from "./agent.js";
import fs from 'fs';
import { createWebSocketClient } from './components/WebSocketClient.js';
import { buildSentraResultBlock, buildSentraUserQuestionBlock, convertHistoryToMCPFormat } from './utils/protocolUtils.js';
import { smartSend } from './utils/sendUtils.js';
import { cleanupExpiredCache, saveMessageCache, loadMessageCache } from './utils/messageCache.js';
import { SocialContextManager } from './utils/socialContextManager.js';
import SentraEmo from './sentra-emo/sdk/index.js';
import { timeParser } from './src/time-parser.js';
import { HistoryStore } from './sentra-mcp/src/history/store.js';
import { buildSentraEmoSection } from './utils/emoXml.js';
import {
  shouldReply,
  completeTask,
  getActiveTaskCount,
  isTaskCancelled,
  clearCancelledTask,
  markTasksCancelledForSender,
  resetReplyGateForSender
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
  drainPendingMessagesForSender,
  getMessageBundlerStats
} from './utils/messageBundler.js';
import { decideOverrideIntent } from './utils/replyIntervention.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from './utils/jsonToSentraXmlConverter.js';
import { chatWithRetry as chatWithRetryCore } from './components/ChatWithRetry.js';
import { triggerContextSummarizationIfNeededCore } from './components/ContextSummarizer.js';
import { triggerPresetTeachingIfNeededCore } from './components/PresetTeachingTrigger.js';
import { handleOneMessageCore } from './components/MessagePipeline.js';
import { setupSocketHandlers } from './components/SocketHandlers.js';
import { initAgentPresetCore } from './components/AgentPresetInitializer.js';
import DesireManager from './utils/desireManager.js';
import { buildProactiveRootDirectiveXml, checkProactiveWhitelistTarget } from './components/ProactiveDirectivePlanner.js';
import { handleGroupReplyCandidate } from './utils/groupReplyMerger.js';
import { startDelayJobWorker, enqueueDelayedJob } from './utils/delayJobQueue.js';
import { createDelayJobRunJob } from './components/DelayJobWorker.js';
import { replySendQueue } from './utils/replySendQueue.js';

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
  reconnectIntervalMs: getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000),
  maxReconnectAttempts: getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60),
  getReconnectIntervalMs: () => getEnvInt('WS_RECONNECT_INTERVAL_MS', 10000),
  getMaxReconnectAttempts: () => getEnvInt('WS_MAX_RECONNECT_ATTEMPTS', 60)
});
const send = (obj) => socket.send(obj);

let socialContextManager = null;

try {
  socket.on('open', () => {
    try {
      if (socialContextManager && typeof socialContextManager.refresh === 'function') {
        socialContextManager.refresh(false).catch(() => {});
      }
    } catch {}
  });
} catch {}

const logger = createLogger('Main');
logger.info(`连接到 WebSocket 服务: ${WS_URL}`);

const proactiveQueue = [];
let proactiveRunning = false;

async function processProactiveQueue() {
	if (proactiveRunning) return;
	const next = proactiveQueue.shift();
	if (!next) return;
	proactiveRunning = true;
	try {
		await runProactiveReply(next);
	} catch (e) {
		logger.warn('主动回复队列执行失败', { err: String(e) });
	} finally {
		proactiveRunning = false;
	}
	if (proactiveQueue.length > 0) {
		setTimeout(() => {
			processProactiveQueue().catch((err) => {
				logger.warn('主动回复队列后续执行失败', { err: String(err) });
			});
		}, 0);
	}
}

function enqueueProactiveCandidate(candidate) {
	const lastMsg = candidate?.lastMsg;
	const senderId = lastMsg && lastMsg.sender_id != null
		? String(lastMsg.sender_id)
		: (candidate?.userId != null ? String(candidate.userId) : '');

	const proactiveWhitelist = checkProactiveWhitelistTarget({
		chatType: lastMsg && lastMsg.type === 'private' ? 'private' : 'group',
		groupId: lastMsg && lastMsg.group_id ? `G:${lastMsg.group_id}` : null,
		userId: senderId || null
	});
	if (!proactiveWhitelist.allowed) {
		if (proactiveWhitelist.logFiltered) {
			logger.info('主动回复白名单拦截: 候选入队时阻断', {
				reason: proactiveWhitelist.reason,
				chatType: proactiveWhitelist.chatType,
				groupId: proactiveWhitelist.groupId ?? null,
				userId: proactiveWhitelist.userId ?? null,
				conversationKey: candidate?.conversationKey || null
			});
		}
		return;
	}

	try {
		candidate._proactiveWhitelistChecked = true;
	} catch {}

	proactiveQueue.push(candidate);
	processProactiveQueue().catch((e) => {
		logger.warn('主动回复入队执行失败', { err: String(e) });
	});
}

// senderId -> Map<conversationKey, Map<runId, { startedAt: number }>>
// 用于在“改主意”场景下通知 MCP 取消对应会话下的运行，避免误伤其他群/私聊
const runningRunsBySender = new Map();

function trackRunForSender(senderId, conversationKey, runId) {
  if (!senderId || !runId) return;
  const sKey = String(senderId);
  const convKey = String(conversationKey ?? '');
  let byConv = runningRunsBySender.get(sKey);
  if (!byConv) {
    byConv = new Map();
    runningRunsBySender.set(sKey, byConv);
  }
  let runs = byConv.get(convKey);
  if (!runs) {
    runs = new Map();
    byConv.set(convKey, runs);
  }
  const rid = String(runId);
  if (!runs.has(rid)) {
    runs.set(rid, { startedAt: Date.now() });
  }
}

function untrackRunForSender(senderId, conversationKey, runId) {
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
function cancelRunsForSender(senderId, conversationKey, options = {}) {
  if (!senderId) return;
  const sKey = String(senderId);
  const convKey = String(conversationKey ?? '');
  const byConv = runningRunsBySender.get(sKey);
  if (!byConv) return;
  const runs = byConv.get(convKey);
  if (!runs || runs.size === 0) return;

  const now = Date.now();
  const cutoffTs = Number.isFinite(options.cutoffTs) ? options.cutoffTs : now;

  for (const [rid, info] of runs.entries()) {
    const startedAt = info && Number.isFinite(info.startedAt) ? info.startedAt : 0;
    if (!startedAt || startedAt <= cutoffTs) {
      try {
        sdk.cancelRun?.(rid);
      } catch {}
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

const agent = new Agent({
  apiKey: getEnv('API_KEY'),
  apiBaseUrl: getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'),
  defaultModel: getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo'),
  temperature: parseFloat(getEnv('TEMPERATURE', '0.7')),
  maxTokens: getEnvInt('MAX_TOKENS', 4096),
  maxRetries: getEnvInt('MAX_RETRIES', 3),
  timeout: getEnvInt('TIMEOUT', 60000)
});

onEnvReload(() => {
  try {
    const nextBaseUrl = getEnv('API_BASE_URL', 'https://yuanplus.chat/v1');
    const nextApiKey = getEnv('API_KEY');
    const nextModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo');
    const nextTemperature = parseFloat(getEnv('TEMPERATURE', '0.7'));
    const nextMaxTokens = getEnvInt('MAX_TOKENS', 4096);
    const nextMaxRetries = getEnvInt('MAX_RETRIES', 3);
    const nextTimeout = getEnvInt('TIMEOUT', 60000);

    if (nextBaseUrl && nextBaseUrl !== agent.config.apiBaseUrl) agent.config.apiBaseUrl = nextBaseUrl;
    if (nextApiKey && nextApiKey !== agent.config.apiKey) agent.config.apiKey = nextApiKey;
    if (nextModel && nextModel !== agent.config.defaultModel) agent.config.defaultModel = nextModel;
    if (Number.isFinite(nextTemperature) && nextTemperature !== agent.config.temperature) agent.config.temperature = nextTemperature;
    if (Number.isFinite(nextMaxTokens) && nextMaxTokens !== agent.config.maxTokens) agent.config.maxTokens = nextMaxTokens;
    if (Number.isFinite(nextMaxRetries) && nextMaxRetries !== agent.config.maxRetries) agent.config.maxRetries = nextMaxRetries;
    if (Number.isFinite(nextTimeout) && nextTimeout !== agent.config.timeout) agent.config.timeout = nextTimeout;
  } catch {}
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

function getEmoRuntimeConfig() {
  const timeoutRaw = getEnvInt('SENTRA_EMO_TIMEOUT', 60000);
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60000;
  const baseRaw = getEnv('SENTRA_EMO_URL', '') || '';
  const baseURL = typeof baseRaw === 'string' && baseRaw.trim() ? baseRaw.trim() : null;
  return { timeout, baseURL };
}

function getDefaultEmoBaseURL() {
  try {
    const tmp = new SentraEmo();
    return typeof tmp.baseURL === 'string' && tmp.baseURL.trim() ? tmp.baseURL.trim() : null;
  } catch {
    return null;
  }
}

const emoCfg = getEmoRuntimeConfig();
const emo = new SentraEmo({
  baseURL: emoCfg.baseURL || undefined,
  timeout: emoCfg.timeout
});

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
const personaManager = new UserPersonaManager({
  agent: agent,
  dataDir: getEnv('PERSONA_DATA_DIR', './userData'),
  updateIntervalMs: getEnvInt('PERSONA_UPDATE_INTERVAL_MS', 600000),
  minMessagesForUpdate: getEnvInt('PERSONA_MIN_MESSAGES', 10),
  maxHistorySize: getEnvInt('PERSONA_MAX_HISTORY', 100),
  model: getEnv('PERSONA_MODEL', 'gpt-4.1-mini'),
  baseUrl: getEnv('PERSONA_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
  apiKey: getEnv('PERSONA_API_KEY', getEnv('API_KEY')),
  recentMessagesCount: getEnvInt('PERSONA_RECENT_MESSAGES', 40),
  halfLifeMs: getEnvInt('PERSONA_HALFLIFE_MS', 172800000),
  maxTraits: getEnvInt('PERSONA_MAX_TRAITS', 6),
  maxInterests: getEnvInt('PERSONA_MAX_INTERESTS', 8),
  maxPatterns: getEnvInt('PERSONA_MAX_PATTERNS', 6),
  maxInsights: getEnvInt('PERSONA_MAX_INSIGHTS', 6)
});

if (!personaManager.enabled) {
  logger.info('用户画像功能已禁用（ENABLE_USER_PERSONA=false）');
}

// 主动回复调度器（基于时间衰减概率 + 每小时上限）
const desireManager = new DesireManager();

if (!desireManager.enabled) {
  logger.info('主动欲望/主动回复功能已禁用（DESIRE_ENABLED=false）');
}

function getMainRuntimeConfig() {
  const mainAiModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo');
  return {
    mainAiModel,
    mcpMaxContextPairs: getEnvInt('MCP_MAX_CONTEXT_PAIRS', getEnvInt('MAX_CONVERSATION_PAIRS', 20)),
    contextMemoryEnabled: getEnvBool('CONTEXT_MEMORY_ENABLED', true),
    contextMemoryModel: getEnv('CONTEXT_MEMORY_MODEL', mainAiModel),
    contextMemoryTriggerDiscardedPairs: getEnvInt('CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS', 0)
  };
}

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
  const runtimeCfg = getMainRuntimeConfig();
  return triggerContextSummarizationIfNeededCore({
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    MCP_MAX_CONTEXT_PAIRS: runtimeCfg.mcpMaxContextPairs,
    CONTEXT_MEMORY_ENABLED: runtimeCfg.contextMemoryEnabled,
    CONTEXT_MEMORY_MODEL: runtimeCfg.contextMemoryModel,
    CONTEXT_MEMORY_TRIGGER_DISCARDED_PAIRS: runtimeCfg.contextMemoryTriggerDiscardedPairs,
    MAIN_AI_MODEL: runtimeCfg.mainAiModel,
    presetPlainText: AGENT_PRESET_PLAIN_TEXT,
    presetRawText: AGENT_PRESET_RAW_TEXT
  });
}

async function runProactiveReply(candidate) {
  if (!candidate || !candidate.lastMsg) return;

  const lastMsg = candidate.lastMsg;
  const userid = String(lastMsg?.sender_id ?? '');
  const groupIdKey = lastMsg?.group_id ? `G:${lastMsg.group_id}` : `U:${userid}`;
  const isFirstAfterUser = !!candidate.isFirstAfterUser;

  const runtimeCfg = getMainRuntimeConfig();

  const proactiveWhitelist = checkProactiveWhitelistTarget({
    chatType: lastMsg.type === 'private' ? 'private' : 'group',
    groupId: lastMsg?.group_id ? `G:${lastMsg.group_id}` : null,
    userId: userid || null
  });
  if (!proactiveWhitelist.allowed) {
    if (proactiveWhitelist.logFiltered) {
      logger.info('主动回复白名单拦截: 出队执行时阻断', {
        reason: proactiveWhitelist.reason,
        chatType: proactiveWhitelist.chatType,
        groupId: proactiveWhitelist.groupId ?? null,
        userId: proactiveWhitelist.userId ?? null,
        conversationKey: candidate?.conversationKey || null,
        checkedAtEnqueue: !!candidate?._proactiveWhitelistChecked
      });
    }
    return;
  }

  try {
    const proactiveConversationId = lastMsg?.group_id
      ? `group_${lastMsg.group_id}_sender_${userid}`
      : `private_${userid}`;
    resetReplyGateForSender(proactiveConversationId);
    const activeCountAtRun = getActiveTaskCount(proactiveConversationId);
    if (activeCountAtRun > 0) {
      logger.info(
        `主动回复跳过: sender=${userid} 出队时检测到有被动任务在处理，放弃本轮主动`,
        {
          conversationKey: candidate?.conversationKey || null,
          chatType: candidate?.chatType || null
        }
      );
      return;
    }

	let conversationContext = null;
	let topicHint = '';
	try {
	  const ctx = historyManager.getRecentMessagesForDecision(groupIdKey, userid);
	  if (ctx && typeof ctx === 'object') {
	    conversationContext = ctx;
	    const senderMsgs = Array.isArray(ctx.sender_recent_messages) ? ctx.sender_recent_messages : [];
	    const groupMsgs = Array.isArray(ctx.group_recent_messages) ? ctx.group_recent_messages : [];
	
	    const texts = [];
	    const pickLastTexts = (arr, n) => {
	      const slice = arr.slice(-n);
	      return slice
	        .map((m) => (m && typeof m.text === 'string' ? m.text.trim() : ''))
	        .filter(Boolean);
	    };
	
	    texts.push(...pickLastTexts(senderMsgs, 3));
	    if (texts.length === 0) {
	      texts.push(...pickLastTexts(groupMsgs, 3));
	    }
	
	    if (texts.length > 0) {
	      topicHint = texts.join(' / ');
	    }
	  }
	} catch (e) {
	  logger.debug('runProactiveReply: 获取最近话题上下文失败，将回退为最后一条消息', { err: String(e) });
	}

	if (!topicHint) {
	  topicHint = (typeof lastMsg.text === 'string' ? lastMsg.text : '');
	}

	let plannerTopicHint = topicHint;
	let plannerTopicFromMemory = false;

	let lastBotMessage = null;
	try {
	  if (historyManager && typeof historyManager.getLastAssistantMessageContent === 'function') {
		lastBotMessage = historyManager.getLastAssistantMessageContent(groupIdKey);
	  }
	} catch (e) {
	  logger.debug('runProactiveReply: 获取最近一次 Bot 回复失败，将忽略该块', { err: String(e) });
	}

	let personaXml = '';
	if (personaManager && userid) {
	  try {
	    personaXml = personaManager.formatPersonaForContext(userid);
	  } catch (e) {
	    logger.debug('runProactiveReply: 加载用户画像失败，将忽略该块', { err: String(e) });
	  }
	}

	let emoXml = '';
	try {
	  if (emo && userid) {
	    const ua = await emo.userAnalytics(userid, { days: 7 });
	    emoXml = buildSentraEmoSection(ua);
	  }
	} catch (e) {
	  logger.debug('runProactiveReply: 加载情绪分析失败，将忽略该块', { err: String(e) });
	}

	let memoryXml = '';
	if (runtimeCfg?.contextMemoryEnabled) {
	  try {
	    memoryXml = await getDailyContextMemoryXml(groupIdKey);
	  } catch (e) {
	    logger.debug('runProactiveReply: 加载上下文记忆失败，将忽略该块', { err: String(e) });
	  }
	}

	if (memoryXml) {
	  try {
	    const matches = Array.from(memoryXml.matchAll(/<summary>([\s\S]*?)<\/summary>/g));
	    const summaries = matches
	      .map((m) => (m[1] || '').trim())
	      .filter(Boolean);
	    if (summaries.length > 0) {
	      const joined = summaries.join(' / ');
	      plannerTopicHint = joined.slice(0, 200);
	      plannerTopicFromMemory = true;
	    }
	  } catch (e) {
	    logger.debug('runProactiveReply: 从上下文记忆提取高层话题失败，将继续使用原有 topicHint', { err: String(e) });
	  }
	}

	let userEngagement = null;
	if (desireManager && typeof desireManager.getUserEngagementSummary === 'function') {
	  try {
	    const conversationKey = candidate.conversationKey || groupIdKey;
	    userEngagement = await desireManager.getUserEngagementSummary(conversationKey, userid);
	  } catch (e) {
	    logger.debug('runProactiveReply: 获取用户主动参与度摘要失败，将忽略该块', { err: String(e) });
	  }
	}

	const isGroupChat = lastMsg.type === 'private' ? false : true;
	if (isGroupChat && !plannerTopicFromMemory && plannerTopicHint) {
	  try {
	    const staleThresholdSec = getEnvInt('DESIRE_GROUP_TOPIC_STALE_SEC', 180);
	    const timeSinceLastUserSec =
	      userEngagement && typeof userEngagement.timeSinceLastUserSec === 'number'
	        ? userEngagement.timeSinceLastUserSec
	        : null;
	
	    if (
	      Number.isFinite(staleThresholdSec) &&
	      staleThresholdSec > 0 &&
	      Number.isFinite(timeSinceLastUserSec) &&
	      timeSinceLastUserSec >= staleThresholdSec
	    ) {
	      logger.debug('runProactiveReply: 群聊话题已过期，将清空 topicHint，仅使用长期记忆/人设', {
	        groupIdKey,
	        userId: userid,
	        timeSinceLastUserSec,
	        staleThresholdSec
	      });
	      plannerTopicHint = '';
	    }
	  } catch (e) {
	    logger.debug('runProactiveReply: 计算话题过期状态失败，将继续使用原有 topicHint', { err: String(e) });
	  }
	}

	const rootXml = await buildProactiveRootDirectiveXml({
	  chatType: lastMsg.type === 'private' ? 'private' : 'group',
	  groupId: groupIdKey,
	  userId: userid,
	  desireScore: candidate.desireScore,
	  topicHint: plannerTopicHint,
	  presetPlainText: AGENT_PRESET_PLAIN_TEXT,
	  presetXml: AGENT_PRESET_XML,
	  personaXml,
	  emoXml,
	  memoryXml,
	  conversationContext,
	  lastBotMessage,
	  userEngagement
	});

    // 构造一条“虚拟”的用户消息，标记为主动触发，并通过主流程/MCP 处理
    const proactiveMsg = {
      ...lastMsg,
      _proactive: true,
      _proactiveFirst: isFirstAfterUser,
      _sentraRootDirectiveXml: rootXml
    };

    await handleOneMessage(proactiveMsg, null);
  } catch (e) {
    const now = Date.now();
    const errText = String(e);
    if (
      runProactiveReply._lastWarnErr === errText &&
      typeof runProactiveReply._lastWarnAt === 'number' &&
      now - runProactiveReply._lastWarnAt < 60000
    ) {
      logger.debug('主动回复流程异常(已节流)', { err: errText });
      return;
    }
    runProactiveReply._lastWarnErr = errText;
    runProactiveReply._lastWarnAt = now;
    logger.warn('主动回复流程异常', { err: errText });
  }
}

// 处理一条（可能已聚合的）消息，并在完成后尝试拉起队列中的下一条
async function handleOneMessage(msg, taskId) {
  const runtimeCfg = getMainRuntimeConfig();
  return handleOneMessageCore(
    {
      logger,
      historyManager,
      timeParser,
      MCP_MAX_CONTEXT_PAIRS: runtimeCfg.mcpMaxContextPairs,
      CONTEXT_MEMORY_ENABLED: runtimeCfg.contextMemoryEnabled,
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
      desireManager,
      socialContextManager
    },
    msg,
    taskId
  );
}

const baseSystemText = "{{sandbox_system_prompt}}\n\n{{qq_system_prompt}}";
const baseSystem = await SentraPromptsSDK(baseSystemText);

async function sendAndWaitResult(message) {
  const maxRetriesRaw = getEnvInt('SEND_RPC_MAX_RETRIES', 0);
  const timeoutRaw = getEnvInt('SEND_RPC_TIMEOUT_MS', 120000);

  const maxRetries = Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0
    ? maxRetriesRaw
    : 0;
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? timeoutRaw
    : 120000;

  const doOnce = () => {
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

      let settled = false;
      let timeout;
      const handler = (data) => {
        if (settled) return;
        try {
          const payload = JSON.parse(data.toString());
          if (payload.type === 'result' && payload.requestId === requestId) {
            settled = true;
            clearTimeout(timeout);
            socket.off('message', handler);
            resolve(payload);
          }
        } catch (e) {}
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
  socialContextManager.refresh(false).catch(() => {});
} catch {}

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
  desireManager,
  getActiveTaskCount,
  enqueueProactiveCandidate,
  socialContextManager
});

startDelayJobWorker({
  intervalMs: getEnvInt('DELAY_QUEUE_POLL_INTERVAL_MS', 1000),
  maxLagMs: getEnvInt('DELAY_QUEUE_MAX_LAG_MS', 0),
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
  collectBundleForSender,
  shouldReply,
  handleOneMessage,
  desireManager,
  handleGroupReplyCandidate,
  completeTask
});

async function runDesireTick() {
  const intervalMsRaw = getEnvInt('DESIRE_TICK_INTERVAL_MS', 60000);
  const intervalMs = intervalMsRaw > 0 ? intervalMsRaw : 60000;

  setTimeout(() => {
    runDesireTick().catch((e) => {
      logger.warn('DesireManager proactive scheduler tick failed', { err: String(e) });
    });
  }, intervalMs);

  if (!desireManager || !desireManager.enabled) {
    return;
  }

  try {
    const now = Date.now();
    const candidates = await desireManager.collectProactiveCandidates(now);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return;
    }
    for (const c of candidates) {
      const lastMsg = c?.lastMsg;
      const senderId =
        lastMsg && lastMsg.sender_id != null
          ? String(lastMsg.sender_id)
          : (c?.userId ? String(c.userId) : '');

      if (!senderId) {
        logger.debug('主动回复候选跳过: 缺少 senderId', {
          conversationKey: c?.conversationKey || null
        });
        continue;
      }

      const convKey = lastMsg && lastMsg.group_id
        ? `group_${lastMsg.group_id}_sender_${senderId}`
        : `private_${senderId}`;
      const activeCount = getActiveTaskCount(convKey);
      if (activeCount > 0) {
        logger.info(
          `主动回复跳过: sender=${senderId} 当前有 ${activeCount} 个被动任务在处理，暂不触发主动回复`,
          {
            conversationKey: c?.conversationKey || null,
            chatType: c?.chatType || null
          }
        );
        continue;
      }

      const proactiveWhitelist = checkProactiveWhitelistTarget({
        chatType: lastMsg && lastMsg.type === 'private' ? 'private' : 'group',
        groupId: lastMsg && lastMsg.group_id ? `G:${lastMsg.group_id}` : null,
        userId: senderId || null
      });
      if (!proactiveWhitelist.allowed) {
        if (proactiveWhitelist.logFiltered) {
          logger.info('主动回复白名单拦截: 候选入队前过滤', {
            reason: proactiveWhitelist.reason,
            chatType: proactiveWhitelist.chatType,
            groupId: proactiveWhitelist.groupId ?? null,
            userId: proactiveWhitelist.userId ?? null,
            conversationKey: c?.conversationKey || null
          });
        }
        continue;
      }

      enqueueProactiveCandidate(c);
    }
  } catch (e) {
    logger.warn('DesireManager proactive scheduler failed', { err: String(e) });
  }
}

runDesireTick().catch((e) => {
  logger.warn('DesireManager proactive scheduler bootstrap failed', { err: String(e) });
});