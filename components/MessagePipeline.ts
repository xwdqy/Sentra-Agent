import { getEnvBool, getEnvInt, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import {
  parseSentraResponse,
  buildSentraToolsBlockFromArgsObject
} from '../utils/protocolUtils.js';
import type { MergedUser, UserQuestionMessage } from '../utils/protocolUtils.js';
import { judgeReplySimilarity } from '../utils/replySimilarityJudge.js';
import { generateToolPreReply } from './ToolPreReplyGenerator.js';
import { decideReplyOrTools } from './ToolRoutingDecider.js';

import { createRagSdk, getRagRuntimeConfig } from 'sentra-rag';
import { textSegmentation } from '../src/segmentation.js';
import { enqueueRagIngest } from '../utils/ragIngestQueue.js';
import type { ChatMessage } from '../src/types.js';

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
  objective?: string;
  _merged?: boolean;
  _mergedUsers?: MergedUser[];
  _proactive?: boolean;
  _proactiveFirst?: boolean;
  _sentraRootDirectiveXml?: string;
  _taskIdOverride?: string | null;
  _taskFile?: string | null;
  _taskRecoveryAttempt?: number;
  _taskRecoverySkipSave?: boolean;
  _taskRecoveryForceSave?: boolean;
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
  plannedStepIndex?: number;
  stepIndex?: number;
  executionIndex?: number;
  result?: Record<string, unknown>;
  [key: string]: unknown;
};

type StreamEvent = ToolResultEvent & {
  runId?: string;
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
};

type ParamValue =
  | string
  | number
  | boolean
  | null
  | ParamValue[]
  | { [key: string]: ParamValue };

type ScheduleInfo = {
  targetISO?: string;
  timezone?: string;
  text?: string;
  mode?: string;
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
  streamToolsXml?: (params: StreamToolsXmlParams) => AsyncIterable<StreamEvent>;
  stream: (params: Record<string, unknown>) => AsyncIterable<StreamEvent>;
  cancelRun?: (runId: string) => void;
  sendAndWaitResult?: SendAndWaitFn;
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
};

type ReplyDecision = { needReply: boolean; taskId?: string | null };

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
  baseSystem: string | ((requiredOutput: string) => Promise<unknown> | unknown);
  convertHistoryToMCPFormat: (history: ChatMessage[], options?: Record<string, unknown>) => ChatMessage[];
  buildSentraUserQuestionBlock: (msg: MsgLike) => string;
  buildSentraResultBlock: (ev: Record<string, unknown>) => string;
  smartSend: SmartSendFn;
  sdk: SdkLike;
  isTaskCancelled: (taskId: string) => boolean;
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
  clearCancelledTask: (taskId: string | null | undefined) => void;
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
  triggerTaskCompletionAnalysis: (payload: Record<string, unknown>) => Promise<unknown>;
  agent: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
};

const swallowOnceStateByConversation = new Map<string, { used: boolean; lastUpdatedAt: number }>();

const ragCacheByConversation = new Map<string, RagCacheEntry>();

const toolPreReplyLastSentAtByUser = new Map<string, number>();

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
      const parsed = parseSentraResponse(response);
      const segs = parsed && Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
      assistantText = segs.join('\n\n').trim();
    } catch { }

    if (!assistantText) {
      assistantText = String(response || '').trim();
    }

    const userText = String(userObjective || msg?.text || msg?.summary || '').trim();
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
      logger?.info('RAG: 入库任务已入队', { docId, conversationId });
      return;
    }

    logger?.info('RAG: 跳过入库（userText/assistantText为空）', {
      conversationId,
      hasUserText: !!userText,
      hasAssistantText: !!assistantText
    });
  } catch (e) {
    logger?.warn('RAG: 异步入库入队失败（已忽略）', { err: String(e) });
  }
}

function ensureSentraResponseHasTarget(raw: unknown, msg: MsgLike | null | undefined): string {
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!s) return s;
  if (!s.startsWith('<sentra-response>')) return s;
  if (!s.endsWith('</sentra-response>')) return s;

  const hasGroup = s.includes('<group_id>') && s.includes('</group_id>');
  const hasUser = s.includes('<user_id>') && s.includes('</user_id>');

  const msgType = msg?.type === 'group' ? 'group' : (msg?.type === 'private' ? 'private' : '');
  const currentTag = msgType === 'group' ? 'group_id' : (msgType === 'private' ? 'user_id' : '');
  const currentId = msgType === 'group'
    ? String(msg?.group_id ?? '').trim()
    : String(msg?.sender_id ?? '').trim();

  const stripTag = (tagName: string, input: string): string => {
    try {
      const re = new RegExp(`\\n?\\s*<${tagName}>[\\s\\S]*?<\\/${tagName}>\\s*`, 'g');
      return String(input || '').replace(re, '\n');
    } catch {
      return input;
    }
  };

  let out = s;

  if (hasGroup && hasUser) {
    // 协议要求：只能有一个 target。优先保留“当前会话类型”的 target。
    if (currentTag === 'group_id') {
      out = stripTag('user_id', out);
    } else if (currentTag === 'user_id') {
      out = stripTag('group_id', out);
    } else {
      out = stripTag('user_id', out);
    }
  }

  const hasAny = out.includes('<group_id>') && out.includes('</group_id>') || (out.includes('<user_id>') && out.includes('</user_id>'));
  if (!hasAny && currentTag && currentId && /^\d+$/.test(currentId)) {
    const insert = `  <${currentTag}>${currentId}</${currentTag}>`;
    if (out.startsWith('<sentra-response>\n')) {
      out = out.replace('<sentra-response>\n', `<sentra-response>\n${insert}\n`);
    } else {
      out = out.replace('<sentra-response>', `<sentra-response>\n${insert}`);
    }
  }

  return out;
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
 * 针对“补充消息”的单次吞吐策略（按会话维度）：
 * - 每个会话在两次真实发送之间，若本次任务期间检测到补充消息，则允许吞掉一次已生成的回复；
 * - 吞掉时仅跳过外发（不调用 smartSend），但仍保留内部对话记录；
 * - 一旦有一次真实发送成功，则重置该会话的吞吐状态；
 * - 受 SWALLOW_ON_SUPPLEMENT_ENABLED / SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS 控制，可通过 .env 开关与调参。
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
  if (!s) return '<sentra-response></sentra-response>';
  try {
    const toolsOnly = typeof s === 'string' && s.startsWith('<sentra-tools>') && s.endsWith('</sentra-tools>') && !s.includes('<sentra-response>');
    if (toolsOnly) return s;
  } catch { }
  try {
    const parsed = parseSentraResponse(s);
    if (parsed && parsed.shouldSkip) {
      return '<sentra-response></sentra-response>';
    }
    return s;
  } catch {
    return '<sentra-response></sentra-response>';
  }
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
  // 去重并排序，确保集合比较稳定
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
    '  <objective>你的当前目标是：把 candidate_response 中的 `<sentra-response>` 改写成一条新的、自然的用户可见回复。在保持事实、数字、结论完全一致的前提下，显著降低与 original_response 的句子与段落相似度（通过重组结构、调整信息顺序、改写句式与过渡语来完成），避免“复读”。</objective>',
    '  <allow_tools>false</allow_tools>',
    '  <original_response><![CDATA[',
    prevBlock,
    '  ]]></original_response>',
    '  <candidate_response><![CDATA[',
    candBlock,
    '  ]]></candidate_response>',
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块：<sentra-response>...</sentra-response>；除此之外不要输出任何字符、解释、前后缀。</item>',
    '    <item>最终输出的 `<sentra-response>` 必须包含至少一个非空的 `<text1>`。</item>',
    '    <item>严禁输出 `<sentra-tools>`（本阶段不允许调用工具）。</item>',
    '    <item>严禁在最终答案中重复输出 original_response 或 candidate_response 的原文块（不要引用/粘贴它们）。</item>',
    '    <item>严格保持事实、数值、时间、地点、结论不变；不要加入与当前对话无关的新事实，也不要扩大/缩小原意。</item>',
    '    <item>不要大段复制粘贴；不要仅做同义词替换。必须通过段落重组、信息顺序调整、句式改写与新的过渡表达来降低相似度。</item>',
    '    <item>保持语言风格、礼貌程度与 candidate_response 一致；如 candidate_response 含有 `<resources>` / `<send>` 等结构，请保持其语义一致且格式有效。</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

type ResultRoundMode = 'single' | 'group';

function buildResultRoundRootXml(mode: ResultRoundMode): string {
  if (mode === 'group') {
    return '<root>本轮拿到 sentra-result-group，仅输出 sentra-response；按 group/order_step_ids 顺序消费结果</root>';
  }
  return '<root>本轮拿到 sentra-result，仅输出 sentra-response；基于当前结果增量回复</root>';
}

function appendRootAtBottom(userContent: unknown, rootXml: string): string {
  const base = typeof userContent === 'string' ? userContent.trim() : String(userContent ?? '').trim();
  const root = typeof rootXml === 'string' ? rootXml.trim() : '';
  if (!root) return base;
  if (base.includes(root)) return base;
  if (!base) return root;
  return `${base}\n\n${root}`;
}

function buildResultUserContent(
  resultPayload: unknown,
  mode: ResultRoundMode,
  baseUserContent?: unknown
): string {
  const resultPart = typeof resultPayload === 'string'
    ? resultPayload.trim()
    : String(resultPayload ?? '').trim();
  const basePart = typeof baseUserContent === 'string'
    ? baseUserContent.trim()
    : String(baseUserContent ?? '').trim();
  const merged = resultPart && basePart
    ? `${resultPart}\n\n${basePart}`
    : (resultPart || basePart);
  return appendRootAtBottom(merged, buildResultRoundRootXml(mode));
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
    randomUUID,
    saveMessageCache,
    enqueueDelayedJob
  } = ctx;

  const userid = String(msg?.sender_id ?? '');
  const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${userid}`;
  const channelId = groupId;
  const identityKey = msg?.group_id ? `G:${msg.group_id}|U:${userid}` : `U:${userid}`;
  const currentTaskId = taskId;

  const mergedUsers = Array.isArray(msg?._mergedUsers) ? msg._mergedUsers : null;
  const isMergedGroup = !!msg?._merged && mergedUsers && mergedUsers.length > 1 && msg?.type === 'group';

  const isProactive = !!msg?._proactive;
  const isProactiveFirst = !!msg?._proactiveFirst;
  const proactiveRootXml =
    typeof msg?._sentraRootDirectiveXml === 'string' && msg._sentraRootDirectiveXml.trim()
      ? msg._sentraRootDirectiveXml.trim()
      : null;

  const conversationId = msg?.group_id
    ? `group_${msg.group_id}_sender_${userid}`
    : `private_${userid}`;

  let convId: string | null = null;
  let pairId: string | number | null = null;
  let currentRunId: string | null = null;
  let currentUserContent = '';
  let isCancelled = false; // 任务取消标记：检测到新消息时设置为 true
  let hasReplied = false; // 引用控制标记：记录是否已经发送过第一次回复（只有第一次引用消息）
  let hasToolPreReplied = false;
  let hasRealtimeToolFeedback = false;
  let hasSupplementDuringTask = false; // 本次任务期间是否检测到补充消息，用于单次吞吐控制
  let endedBySchedule = false; // 当遇到 schedule 延迟任务并成功入队时，提前结束本轮事件循环
  const pendingToolArgsByStepIndex = new Map<number, { aiName?: string; args?: Record<string, ParamValue> }>();
  const toolTurnInvocationSet = new Set<string>();
  const toolTurnInvocations: ToolInvocation[] = [];
  const toolTurnResultEvents: ToolResultEvent[] = [];
  let toolResultArrived = false;
  let toolPreReplyJobStarted = false;
  let toolPreReplySingleSkipTools: string[] = [];
  let toolPreReplyFallbackToolNames: string[] = [];
  let finalResponseForCompletionAnalysis = '';
  let completionAnalysisHasToolCalled = false;
  let lastRealtimeToolResponse = '';
  let userObjective = null;

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

  const buildToolInvocationKey = (
    toolName: string,
    toolArgs: Record<string, ParamValue> | undefined,
    evLike: ToolResultEvent,
    fallbackSeq: number
  ): string => {
    const stepId = typeof evLike?.stepId === 'string' ? evLike.stepId.trim() : '';
    const planned = toNum(evLike?.plannedStepIndex);
    const step = toNum(evLike?.stepIndex);
    const exec = toNum(evLike?.executionIndex);
    const argsHash = stableJson(toolArgs || {});
    if (stepId || planned != null || step != null || exec != null) {
      return `${toolName}|sid:${stepId || ''}|p:${planned ?? ''}|s:${step ?? ''}|e:${exec ?? ''}|a:${argsHash}`;
    }
    return `${toolName}|a:${argsHash}|seq:${fallbackSeq}`;
  };

  const recordToolTurnEventForCompletionAnalysis = (evLike: ToolResultEvent) => {
    if (!evLike || typeof evLike !== 'object') return;
    const idx = typeof evLike.plannedStepIndex === 'number'
      ? evLike.plannedStepIndex
      : (typeof evLike.stepIndex === 'number' ? evLike.stepIndex : null);
    const cached = idx != null ? pendingToolArgsByStepIndex.get(idx) : null;
    const toolName = typeof cached?.aiName === 'string'
      ? cached.aiName
      : (typeof evLike.aiName === 'string' ? evLike.aiName : '');
    const toolArgs = cached?.args && typeof cached.args === 'object'
      ? cached.args
      : (evLike.args && typeof evLike.args === 'object' ? (evLike.args as Record<string, ParamValue>) : undefined);

    if (toolName) {
      const key = buildToolInvocationKey(toolName, toolArgs, evLike, toolTurnResultEvents.length);
      if (!toolTurnInvocationSet.has(key)) {
        toolTurnInvocationSet.add(key);
        const invocation: ToolInvocation = toolArgs
          ? { aiName: toolName, args: toolArgs }
          : { aiName: toolName };
        toolTurnInvocations.push(invocation);
      }
    }

    if (idx != null) {
      pendingToolArgsByStepIndex.delete(idx);
    }

    toolTurnResultEvents.push(evLike);
    completionAnalysisHasToolCalled = true;
  };

  // 从主动 root 指令 XML 中提取 <objective> 文本，用于 MCP 的 objective
  const extractObjectiveFromRoot = (xml: string | null | undefined): string | null => {
    if (!xml || typeof xml !== 'string') return null;
    const m = xml.match(/<objective>([\s\S]*?)<\/objective>/i);
    if (!m) return null;
    const inner = String(m[1] || '').trim();
    if (!inner) return null;
    // 压平多行，避免 objective 过长影响日志可读性
    const flat = inner.replace(/\s+/g, ' ').trim();
    return flat || null;
  };

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
    const getAllSenderMessages = (): MsgLike[] => {
      return historyManager.getPendingMessagesBySender(groupId, userid);
    };

    // 获取该sender_id的所有消息
    let senderMessages: MsgLike[] = getAllSenderMessages();
    // 主动触发场景下，队列里通常没有待处理消息，此时回退使用当前msg本身
    if (isProactive && (!Array.isArray(senderMessages) || senderMessages.length === 0)) {
      senderMessages = [msg];
    }

    /**
     * 构建拼接内容：将该sender_id的所有消息按时间顺序拼接
     * 让bot能看到完整的任务演变过程（原始请求 -> 修正 -> 补充）
     */
    const buildConcatenatedContent = (messages: MsgLike[]) => {
      const pickContent = (m: MsgLike) => {
        if (!m) return '';
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
        return o || t || s || '';
      };

      if (messages.length === 0) {
        return pickContent(msg);
      }
      // 拼接所有消息，用换行符分隔，保留时间戳以便bot理解顺序
      return messages
        .map((m: MsgLike) => {
          const timeStr = m.time_str || '';
          const content = pickContent(m);
          return timeStr ? `[${timeStr}] ${content}` : content;
        })
        .filter(Boolean)
        .join('\n\n');
    };

    // objective: 主动场景优先使用 root 指令中的 <objective>，否则回退为用户消息拼接
    // 确保 bot 在所有阶段都能看到清晰的“本轮意图”，而不是简单重复上一条用户文本
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

    // conversation: 构建 MCP FC 协议格式的对话上下文
    // 包含：1. 历史工具调用上下文 2. 当前用户消息（使用 Sentra XML 块，而非 summary 文本）
    // 使用聚合后的最终用户输入（msg）进行时间解析：若文本包含时间表达式，则优先选取该时间段内的历史对话，再合并最近若干对话
    const timeText = (msg?.text || msg?.summary || '').trim();

    const mcpMaxPairs = typeof MCP_MAX_CONTEXT_PAIRS === 'number' ? MCP_MAX_CONTEXT_PAIRS : undefined;
    const contextPairsLimit =
      Number.isFinite(mcpMaxPairs) && (mcpMaxPairs as number) > 0
        ? (mcpMaxPairs as number)
        : historyManager.maxConversationPairs || 20;

    const contextTokensLimit = getEnvInt('MCP_MAX_CONTEXT_TOKENS', 0) || 0;

    const isGroupChat = String(groupId || '').startsWith('G:');
    let historyConversations = historyManager.getConversationHistoryForContext(groupId, {
      recentPairs: contextPairsLimit,
      maxTokens: contextTokensLimit,
      senderId: isGroupChat ? userid : null
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
              recentPairs: contextPairsLimit,
              maxTokens: contextTokensLimit,
              senderId: isGroupChat ? userid : null
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

    // 主动回合的后续自我延展：仅依赖 root 指令 + 系统摘要，不再注入逐条对话历史，避免过度黏着用户最近话题
    const effectiveHistoryConversations = isProactive && !isProactiveFirst ? [] : historyConversations;

    const mcpHistory = convertHistoryToMCPFormat(effectiveHistoryConversations);

    // 复用构建逻辑：pending-messages（如果有） + sentra-user-question（当前消息）
    const latestMsg = senderMessages[senderMessages.length - 1] || msg;
    let userContentNoRootForRouter = '';

    if (isProactive && !isProactiveFirst) {
      // 后续主动回合：仅依赖 root 指令和系统上下文，不再重新注入用户问题
      currentUserContent = proactiveRootXml || '';
      userContentNoRootForRouter = '';
    } else {
      // 群聊：pendingContextXml 会包含“其他成员消息(上) + 该用户累计消息(下)”两段；私聊：只包含该用户历史
      const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
      const baseUserMsg = isMergedGroup ? msg : latestMsg;
      const userQuestionXml = buildSentraUserQuestionBlock(baseUserMsg);
      const combinedUserContent = pendingContextXml
        ? pendingContextXml + '\n\n' + userQuestionXml
        : userQuestionXml;
      userContentNoRootForRouter = combinedUserContent;
      currentUserContent = proactiveRootXml
        ? `${proactiveRootXml}\n\n${combinedUserContent}`
        : combinedUserContent;
    }

    const conversation: ChatMessage[] = [
      ...mcpHistory, // 历史上下文（user 的 sentra-user-question + assistant 的 sentra-tools），仅在需要时保留
      { role: 'user', content: currentUserContent } // 当前任务（XML 块）
    ];

    //console.log(JSON.stringify(conversation, null, 2))
    logger.debug(
      `MCP上下文: ${groupId} 使用历史${effectiveHistoryConversations.length}条 (limit=${contextPairsLimit}) → 转换后${mcpHistory.length}条 + 当前1条 = 总计${conversation.length}条`
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
      const emoEnabled = getEnvBool('SENTRA_EMO_ENABLED', false);
      if (emoEnabled && emo && userid) {
        const emoStartAt = Date.now();
        logger.debug('Emo: start userAnalytics', { userid });
        const ua = await emo.userAnalytics(userid, { days: 7 });
        emoXml = buildSentraEmoSection(ua);
        logger.debug('Emo: userAnalytics done', { userid, ms: Date.now() - emoStartAt });
      }
    } catch (e) {
      logger.warn('Emo: userAnalytics failed (ignored)', { err: String(e) });
    }

    const agentPresetXml = AGENT_PRESET_XML || '';

    const resolveBaseSystem = async (requiredOutput: string) => {
      try {
        const base = ctx && Object.prototype.hasOwnProperty.call(ctx, 'baseSystem') ? ctx.baseSystem : '';
        if (typeof base === 'function') {
          const r = await base(requiredOutput);
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
        logger.info('RAG: disabled', { conversationId });
      } else {
        const cfg = ragCfg;
        logger.info('RAG: pipeline reached', { conversationId });

        const fallbackQueryRaw = String(msg?.text || msg?.summary || '').trim();
        const queryText = normalizeRagQueryText(userObjective) || normalizeRagQueryText(fallbackQueryRaw);
        if (queryText) {
          logger.info('RAG: 尝试检索', {
            conversationId,
            queryPreview: queryText.length > 120 ? queryText.substring(0, 120) : queryText
          });
          const cacheKey = `${conversationId}::${queryText}`;
          const cached = ragCacheByConversation.get(cacheKey);
          if (cached && typeof cached === 'object' && Number.isFinite(cached.at) && cached.block) {
            if (Date.now() - cached.at <= cfg.cacheTtlMs) {
              ragBlock = cached.block;
              logger.info('RAG: 命中缓存', { conversationId });
            } else {
              ragCacheByConversation.delete(cacheKey);
            }
          }

          if (!ragBlock) {
            try {
              const rag = await withTimeout(getRagSdk(), cfg.timeoutMs);
              const keywords = extractRagKeywords(queryText, cfg.keywordTopN);

              if (Array.isArray(keywords) && keywords.length > 0) {
                logger.info('RAG: keywords', { conversationId, keywords: keywords.join(', ') });
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
                logger.info('RAG: 检索完成但无可用上下文', {
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
                logger.info('RAG: 上下文已注入', {
                  conversationId,
                  queryPreview: queryText.length > 120 ? queryText.substring(0, 120) : queryText
                });
                logger.info('RAG: context preview', {
                  conversationId,
                  contextChars: mergedContext ? String(mergedContext).length : 0,
                  preview: mergedContext && String(mergedContext).length > 320
                    ? String(mergedContext).substring(0, 320)
                    : String(mergedContext || '')
                });
              } else {
                logger.info('RAG: 未注入（ragBlock为空）', { conversationId });
              }
            } catch (e) {
              logger.warn('RAG: 检索失败（已忽略）', { err: String(e) });
            }
          }
        } else {
          logger.info('RAG: skip（empty query）', { conversationId });
        }
      }
    }

    let socialXml = '';
    try {
      if (ctx && ctx.socialContextManager && typeof ctx.socialContextManager.getXml === 'function') {
        socialXml = await ctx.socialContextManager.getXml();
      }
    } catch { }

    // 组合系统提示词：baseSystem + persona + emo + memory + social + worldbook + agent-preset + rag
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

    const systemContentCache = new Map();
    const getSystemContent = async (requiredOutput: string) => {
      const key = typeof requiredOutput === 'string' ? requiredOutput : 'auto';
      if (systemContentCache.has(key)) return systemContentCache.get(key);
      const baseSystemText = await resolveBaseSystem(key);
      const parts = [baseSystemText, personaContext, emoXml, memoryXml, socialXml, worldbookXml, agentPresetXml, ragBlock].filter(Boolean);
      const out = parts.join('\n\n');
      systemContentCache.set(key, out);
      return out;
    };

    const rebuildConversationsWithSystem = async (requiredOutput: string, conv: ChatMessage[]): Promise<ChatMessage[]> => {
      const src = Array.isArray(conv) ? conv : [];
      const rest = src.length > 0 && src[0] && src[0].role === 'system'
        ? src.filter((_, idx) => idx > 0)
        : src;
      return [{ role: 'system', content: await getSystemContent(requiredOutput) }, ...rest] as ChatMessage[];
    };

    const systemContent = await getSystemContent('auto');

    const buildChatWithRetryOptions = (expectedOutput: string): { model?: string; __sentraExpectedOutput?: string } => {
      const opts: { model?: string; __sentraExpectedOutput?: string } = { __sentraExpectedOutput: expectedOutput };
      if (MAIN_AI_MODEL) {
        opts.model = MAIN_AI_MODEL;
      }
      return opts;
    };

    const maybeRewriteSentraResponse = async (rawResponse: string) => {
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
          prevParsed = parseSentraResponse(previousContent);
          currParsed = parseSentraResponse(rawResponse);
        } catch (e) {
          logger.debug('ReplyRewrite: parseSentraResponse 失败，跳过重写', {
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

        // 资源集合必须完全一致，才认为是“同一条消息下的复读”，否则视为不同内容
        const resourcesEqual = areResourceSetsEqual(prevParsed.resources, currParsed.resources);
        if (!resourcesEqual) {
          return null;
        }

        const sim = await judgeReplySimilarity(prevText, currText);
        if (!sim || !sim.areSimilar) {
          return null;
        }

        logger.info('ReplyRewrite: 检测到与最近一次回复高度相似，尝试触发重写', {
          groupId,
          similarity: sim.similarity,
          source: sim.source
        });

        const rootXml = buildRewriteRootDirectiveXml(previousContent, rawResponse);
        const convForRewrite: ChatMessage[] = [
          { role: 'system', content: await getSystemContent('must_be_sentra_response') },
          { role: 'user', content: rootXml }
        ];

        const rewriteResult = await chatWithRetry(
          convForRewrite,
          buildChatWithRetryOptions('sentra_response'),
          groupId
        );
        if (!rewriteResult || !rewriteResult.success || !rewriteResult.response) {
          logger.warn('ReplyRewrite: 重写调用失败，将回退使用原始回复', {
            reason: rewriteResult?.reason || 'unknown'
          });
          return null;
        }

        const rewritten = rewriteResult.response;

        let parsedRewritten;
        try {
          parsedRewritten = parseSentraResponse(rewritten);
        } catch (e) {
          logger.warn('ReplyRewrite: 重写结果解析失败，将回退使用原始回复', {
            err: String(e)
          });
          return null;
        }

        const rewrittenTextSegments = Array.isArray(parsedRewritten.textSegments)
          ? parsedRewritten.textSegments
          : [];
        const rewrittenText = rewrittenTextSegments.join('\n\n').trim();

        if (parsedRewritten.shouldSkip || !rewrittenText) {
          logger.warn('ReplyRewrite: 重写结果为空或被标记为 shouldSkip，放弃重写');
          return null;
        }

        // 可选：再做一次相似度检查，避免“改写”后仍然高度相似
        try {
          const simAfter = await judgeReplySimilarity(prevText, rewrittenText);
          if (
            simAfter &&
            simAfter.areSimilar &&
            simAfter.similarity != null &&
            (sim.similarity == null || simAfter.similarity >= sim.similarity)
          ) {
            logger.info('ReplyRewrite: 重写后与上一轮仍高度相似，将回退原始回复', {
              similarityBefore: sim.similarity,
              similarityAfter: simAfter.similarity
            });
            return null;
          }
        } catch { }

        logger.info('ReplyRewrite: 重写成功，将使用改写后的回复替代原始回复');
        return rewritten;
      } catch (e) {
        logger.warn('ReplyRewrite: 执行重写逻辑时出现异常，跳过重写', {
          err: String(e)
        });
        return null;
      }
    };

    let conversations: ChatMessage[] = [{ role: 'system', content: systemContent }, ...historyConversations];
    const baseGlobalOverlay = AGENT_PRESET_PLAIN_TEXT || AGENT_PRESET_RAW_TEXT || '';
    let overlays;
    if (isProactive) {
      overlays = {
        global: baseGlobalOverlay,
        plan:
          '本轮为由 <sentra-root-directive type="proactive"> 标记的主动发言，请以 root directive 中的 objective 为最高准则，优先规划能引出“新视角/新子话题”的步骤；可以用工具在后台获取真实信息/素材支撑，但最终对用户呈现必须是人设内的自然聊天与分享，不得播报工具/流程/协议，不要出现“根据你的请求…/工具调用…/系统提示…”。',
        arggen:
          '当为主动回合生成工具参数时，优先选择能产出具体可观察结果的工具（如搜索结果、网页摘要、图片/视频/音乐卡片、天气/实时信息等），并将参数控制在一次轻量查询或生成范围；注意：这些是后台执行，最终对用户的文本不得出现“工具调用/返回/流程”。',
        judge:
          '在审核候选计划时，优先选择能带来具体新信息/新角度/轻度转场的方案；对于仅“继续解释当前问题”、或输出会变成“根据你的请求/工具调用/系统提示”这类旁白的方案，应认为不合格，并允许最终保持沉默。',
        final_judge:
          '在最终评估主动回复时，请检查内容是否真正带来了新的信息、视角或轻度转场，并且是否始终遵守人设口吻；若回复会变成流程播报（如“根据你的请求/工具调用/系统提示”）或仅为空泛客套话/轻微改写，应倾向 noReply=true 或大幅压缩内容，对于主动回合，保持沉默优于输出低价值内容。'
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

    // 记录初始消息数量
    const initialMessageCount = senderMessages.length;
    const replyAnchorMsg = senderMessages[senderMessages.length - 1] || msg;

    let forceNeedTools = false;
    const delegateToolDecisionToMcp = getEnvBool('MCP_DELEGATE_TOOL_DECISION', true);
    if (!delegateToolDecisionToMcp) {
      try {
        const routerStartAt = Date.now();
        logger.debug('ToolRouter: begin', {
          groupId,
          hasProactiveRoot: !!proactiveRootXml,
          userPreview: String(userContentNoRootForRouter || '').length > 160
            ? String(userContentNoRootForRouter || '').substring(0, 160)
            : String(userContentNoRootForRouter || '')
        });
        const routerOptions = {
          chatWithRetry,
          baseConversations: await rebuildConversationsWithSystem('router', conversations),
          userContentNoRoot: userContentNoRootForRouter,
          timeoutMs: getEnvTimeoutMs('TIMEOUT', 180000, 900000),
          ...(groupId != null ? { groupId } : {}),
          ...(MAIN_AI_MODEL ? { model: MAIN_AI_MODEL } : {}),
          ...(proactiveRootXml ? { originalRootXml: proactiveRootXml } : {})
        };
        const routed = await decideReplyOrTools(routerOptions);

        logger.debug('ToolRouter: done', {
          groupId,
          ms: Date.now() - routerStartAt,
          kind: routed && typeof routed === 'object' ? routed.kind : null
        });

        if (routed && routed.kind === 'reply' && typeof routed.response === 'string') {
          if (!convId) convId = randomUUID();
          pairId = await historyManager.startAssistantMessage(groupId);

          try {
            if (pairId != null) {
              await historyManager.appendToConversationPairMessages(groupId, pairId, 'user', currentUserContent || '');
            }
          } catch { }

          let response = routed.response;
          const noReply = !!routed.noReply;

          const rewritten = await maybeRewriteSentraResponse(response);
          if (rewritten && typeof rewritten === 'string') {
            response = rewritten;
          }

          response = ensureSentraResponseHasTarget(response, msg);

          const responseForHistory = normalizeAssistantContentForHistory(response);
          await historyManager.appendToAssistantMessage(groupId, responseForHistory, pairId);

          if (!noReply) {
            await maybeWaitForSupplementBeforeSend();

            const finalMsg = replyAnchorMsg;
            const swallow = shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask);
            if (!swallow) {
              await smartSend(finalMsg, response, sendAndWaitWithConv, true, { hasTool: false });
              hasReplied = true;
              if (ctx.desireManager) {
                try {
                  await ctx.desireManager.onBotMessage(finalMsg, { proactive: !!msg?._proactive });
                } catch (e) {
                  logger.debug('DesireManager onBotMessage(ToolRouter) failed', { err: String(e) });
                }
              }
              markReplySentForConversation(conversationId);
            }
          }

          const saved = pairId != null
            ? await historyManager.finishConversationPair(groupId, pairId, null)
            : null;
          if (saved) {
            const chatType = msg?.group_id ? 'group' : 'private';
            const userIdForMemory = userid || '';
            if (isGroupChat && userid) {
              try {
                await historyManager.promoteScopedConversationsToShared(groupId, userid);
              } catch { }
            }
            triggerContextSummarizationIfNeeded({ groupId, chatType, userId: userIdForMemory }).catch((e) => {
              logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
            });
            triggerPresetTeachingIfNeeded({
              groupId,
              chatType,
              userId: userIdForMemory,
              userContent: currentUserContent,
              assistantContent: response
            }).catch((e) => {
              logger.debug(`PresetTeaching: 异步教导触发失败 ${groupId}`, { err: String(e) });
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

          pairId = null;
          return;
        }

        if (routed && routed.kind === 'tools' && typeof routed.toolsXml === 'string' && routed.toolsXml.trim()) {
          userObjective = routed.toolsXml;
          forceNeedTools = true;
        }
      } catch (e) {
        logger.debug('ToolRouter: failed (ignored)', { groupId, err: String(e) });
      }
    }

    // 在 Judge / ToolResult 最终发送前，按需做一次额外静默等待：
    // - 若在 SWALLOW_ON_SUPPLEMENT_MAX_WAIT_MS 时间内检测到新消息，则标记 hasSupplementDuringTask=true，触发单次吞吐逻辑；
    // - 若未检测到新消息，则直接发送当前结果，避免无限等待。
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
          `补充消息静默等待: ${groupId} 发送前已存在补充消息 ${initialMessageCount} -> ${baseCount}，无需额外等待`
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
        `补充消息静默等待: ${groupId} 最多等待 ${maxWait}ms 观察是否有新消息 (base=${baseCount})`
      );

      while (Date.now() - startWaitAt < maxWait) {
        if (currentTaskId && isTaskCancelled(currentTaskId)) {
          ctx.logger.info(`任务已取消: ${groupId} 结束发送前静默等待`);
          return;
        }

        await sleep(pollInterval);

        const latest = getAllSenderMessages();
        const latestCount = Array.isArray(latest) ? latest.length : 0;
        if (latestCount > baseCount) {
          hasSupplementDuringTask = true;
          ctx.logger.info(
            `补充消息静默等待: ${groupId} 等待期间检测到新消息 ${baseCount} -> ${latestCount}，触发吞吐条件`
          );
          return;
        }
      }

      ctx.logger.debug(
        `补充消息静默等待: ${groupId} 等待 ${Date.now() - startWaitAt}ms 内未检测到新消息，直接发送`
      );
    }

    let streamAttempt = 0;
    while (streamAttempt < 2) {
      let restartMcp = false;
      let restartObjective = null;

      logger.debug(`MCP identity: ${groupId} channelId=${channelId} identityKey=${identityKey}`);

      const willStreamToolsXml = !!(
        forceNeedTools &&
        userObjective &&
        userObjective.trim().startsWith('<sentra-tools>') &&
        typeof sdk.streamToolsXml === 'function'
      );
      if (willStreamToolsXml) {
        try {
          const u = String(userObjective || '').trim();
          logger.info('DirectToolsExec: 使用 streamToolsXml 执行', {
            groupId,
            attempt: streamAttempt + 1,
            length: u.length,
            preview: u.length > 160 ? u.substring(0, 160) : u
          });
        } catch { }
      }

      const streamIterator: AsyncIterable<StreamEvent> = willStreamToolsXml
        ? (sdk.streamToolsXml as (params: StreamToolsXmlParams) => AsyncIterable<StreamEvent>)({
          toolsXml: userObjective,
          objective: userObjective,
          conversation,
          overlays,
          channelId,
          identityKey
        })
        : sdk.stream({
          objective: userObjective,
          conversation: conversation,
          overlays,
          forceNeedTools,
          channelId,
          identityKey
        });

      for await (const ev of streamIterator) {
        logger.debug('Agent事件', ev);

        const getToolOrderKey = (x: ToolResultEvent): [number, number] => {
          try {
            const planned = (x && typeof x.plannedStepIndex === 'number') ? x.plannedStepIndex : null;
            const step = (x && typeof x.stepIndex === 'number') ? x.stepIndex : null;
            const exec = (x && typeof x.executionIndex === 'number') ? x.executionIndex : null;
            // plannedStepIndex 优先，其次 stepIndex；executionIndex 作为细分排序
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

        if (currentTaskId && isTaskCancelled(currentTaskId)) {
          isCancelled = true;
          logger.info(`检测到任务已被取消: ${groupId} taskId=${currentTaskId}`);

          if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
            try {
              sdk.cancelRun(currentRunId);
              try {
                untrackRunForSender(userid, groupId, currentRunId);
              } catch { }
            } catch { }
          }
          currentRunId = null;
          break;
        }

        // 在 start 事件时缓存消息 - 缓存最后一条待回复消息
        if (ev.type === 'start' && ev.runId) {
          currentRunId = ev.runId;
          // 记录 runId 和会话，用于后续在“改主意”场景下仅取消本会话下的运行
          trackRunForSender(userid, groupId, ev.runId);

          // 实时获取最新的消息列表
          senderMessages = getAllSenderMessages();

          // 保存消息缓存（用于插件通过 runId 反查 user_id / group_id 等上下文）
          if (typeof saveMessageCache === 'function') {
            try {
              const cacheMsg = senderMessages[senderMessages.length - 1] || msg;
              await saveMessageCache(ev.runId, cacheMsg);
            } catch (e) {
              logger.debug(`保存消息缓存失败: ${groupId} runId=${ev.runId}`, { err: String(e) });
            }
          }

          // 检查是否有新消息到达
          if (senderMessages.length > initialMessageCount) {
            hasSupplementDuringTask = true;
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
            const pairIdPreview = pairId != null ? String(pairId).substring(0, 8) : '';
            logger.debug(`创建pairId-Judge: ${groupId} pairId ${pairIdPreview}`);

            // 实时获取最新的sender消息列表
            senderMessages = getAllSenderMessages();

            // 检查是否有新消息：如果有，需要拼接所有消息作为上下文
            if (senderMessages.length > initialMessageCount) {
              logger.info(`动态感知Judge: ${groupId} 检测到新消息，拼接完整上下文`);
            }

            const latestMsgJudge = senderMessages[senderMessages.length - 1] || msg;

            let judgeBaseContent = '';
            if (isProactive && !isProactiveFirst) {
              // 后续主动回合：不再围绕最近用户消息构造 user-question，仅使用 root 指令
              judgeBaseContent = '';
              currentUserContent = proactiveRootXml || '';
            } else {
              // 获取历史上下文（仅供参考：群聊包含“其他成员(上)+该用户累计(下)”，私聊仅该用户历史）
              const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
              // 构建当前需要回复的消息（主要内容）- 使用最新的消息
              const userQuestion = buildSentraUserQuestionBlock(latestMsgJudge);

              // 组合上下文：历史上下文 + 当前消息
              if (contextXml) {
                judgeBaseContent = contextXml + '\n\n' + userQuestion;
              } else {
                judgeBaseContent = userQuestion;
              }

              currentUserContent = proactiveRootXml
                ? `${proactiveRootXml}\n\n${judgeBaseContent}`
                : judgeBaseContent;
            }

            // Judge 判定无需工具：为当前对话显式注入占位工具与结果，便于后续模型判断
            let placeholderToolsXml = '';
            let placeholderResultXml = '';
            let placeholderResultRawXml = '';
            try {
              const rawReason =
                (typeof latestMsgJudge?.objective === 'string' &&
                  latestMsgJudge.objective.trim()) ||
                (typeof latestMsgJudge?.summary === 'string' &&
                  latestMsgJudge.summary.trim()) ||
                (typeof latestMsgJudge?.text === 'string' &&
                  latestMsgJudge.text.trim()) ||
                'No tool required for this message.';
              const reasonText = rawReason.trim();
              const toolsXML = String(buildSentraToolsBlockFromArgsObject('none', {
                no_tool: true,
                reason: reasonText
              }));

              const evNoTool = {
                type: 'tool_result',
                aiName: 'none',
                stepId: 'step_none_0',
                plannedStepIndex: 0,
                reason: reasonText,
                result: {
                  success: true,
                  code: 'NO_TOOL',
                  provider: 'system',
                  data: { no_tool: true, reason: reasonText }
                }
              };
              const resultXML = String(buildSentraResultBlock(evNoTool));
              placeholderToolsXml = toolsXML;
              placeholderResultRawXml = resultXML;
              placeholderResultXml = buildResultUserContent(resultXML, 'single');
            } catch { }

            try {
              if (pairId) {
                await historyManager.appendToConversationPairMessages(groupId, pairId, 'user', currentUserContent);
                if (placeholderToolsXml) {
                  await historyManager.appendToConversationPairMessages(groupId, pairId, 'assistant', placeholderToolsXml);
                }
                if (placeholderResultXml) {
                  await historyManager.appendToConversationPairMessages(groupId, pairId, 'user', placeholderResultXml);
                }
              }
            } catch { }

            if (placeholderToolsXml) {
              conversations.push({ role: 'assistant', content: placeholderToolsXml });
            }
            const judgeUserForModel = placeholderResultXml
              ? buildResultUserContent(placeholderResultRawXml || placeholderResultXml, 'single', currentUserContent)
              : currentUserContent;
            conversations.push({ role: 'user', content: judgeUserForModel });
            // logger.debug('Conversations', conversations);
            //console.log(JSON.stringify(conversations, null, 2))
            const result = await chatWithRetry(
              await rebuildConversationsWithSystem('must_be_sentra_response', conversations as ChatMessage[]),
              buildChatWithRetryOptions('sentra_response'),
              groupId
            );

            if (!result.success) {
              logger.error(
                `AI响应失败Judge: ${groupId} 原因 ${result.reason}, 重试${result.retries}次`
              );
              if (pairId) {
                logger.debug(
                  `取消pairId-Judge失败: ${groupId} pairId ${String(pairId).substring(0, 8)}`
                );
                await historyManager.cancelConversationPairById(groupId, pairId);
                pairId = null;
              }
              if (isGroupChat && userid) {
                try {
                  await historyManager.clearScopedConversationsForSender(groupId, userid);
                } catch { }
              }
              return;
            }

            if (result.toolsOnly && result.rawToolsXml) {
              const toolsXml = String(result.rawToolsXml || '').trim();
              if (toolsXml) {
                userObjective = toolsXml;
                forceNeedTools = true;
                restartMcp = true;
                restartObjective = toolsXml;
                logger.info('toolsOnly→direct-exec: 将直接执行 <sentra-tools>', {
                  groupId,
                  attempt: streamAttempt + 2,
                  length: toolsXml.length,
                  preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                });
              }

              if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
                try {
                  sdk.cancelRun(currentRunId);
                  try {
                    untrackRunForSender(userid, groupId, currentRunId);
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
                break;
              }
            }

            let response = typeof result.response === 'string' ? result.response : '';
            const noReply = !!result.noReply;
            logger.success(`AI响应成功Judge: ${groupId} 重试${result.retries}次`);
            if (!response) {
              logger.error(`AI响应失败Judge: ${groupId} response为空`);
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
              return;
            }

            const rewrittenJudge = await maybeRewriteSentraResponse(response);
            if (rewrittenJudge && typeof rewrittenJudge === 'string') {
              response = rewrittenJudge;
            }

            response = ensureSentraResponseHasTarget(response, msg);

            const responseForHistory = normalizeAssistantContentForHistory(response);
            if (pairId) {
              await historyManager.appendToAssistantMessage(groupId, responseForHistory, pairId);
            }

            const latestSenderMessages = getAllSenderMessages();
            if (latestSenderMessages.length > initialMessageCount) {
              hasSupplementDuringTask = true;
              logger.info(
                `动态感知Judge: ${groupId} 检测到补充消息 ${initialMessageCount} -> ${latestSenderMessages.length}，整合到上下文`
              );
            }

            if (isCancelled) {
              logger.info(`任务已取消: ${groupId} 跳过发送Judge阶段`);
              if (isGroupChat && userid) {
                try {
                  await historyManager.clearScopedConversationsForSender(groupId, userid);
                } catch { }
              }
              return;
            }

            if (!noReply) {
              await maybeWaitForSupplementBeforeSend();

              const finalMsg = replyAnchorMsg;
              const allowReply = true;

              const swallow = shouldSwallowReplyForConversation(conversationId, hasSupplementDuringTask);
              if (swallow) {
                logger.info(
                  `补充消息吞吐策略: ${groupId} 本轮Judge阶段检测到补充消息，跳过外发，仅保留内部对话记录 (conversation=${conversationId})`
                );
              } else {
                logger.debug(
                  `引用消息Judge: ${groupId} 消息${finalMsg.message_id}, sender ${finalMsg.sender_id}, 队列${senderMessages.length}条, 允许引用 ${allowReply}`
                );
                await smartSend(finalMsg, response, sendAndWaitWithConv, allowReply, { hasTool: false });
                hasReplied = true;
                if (ctx.desireManager) {
                  try {
                    await ctx.desireManager.onBotMessage(finalMsg, { proactive: !!msg?._proactive });
                  } catch (e) {
                    logger.debug('DesireManager onBotMessage(Judge) failed', { err: String(e) });
                  }
                }

                markReplySentForConversation(conversationId);
              }
            } else {
              logger.info(`Judge 阶段: 模型选择保持沉默 (noReply=true)，跳过发送`);
            }

            if (!pairId) {
              logger.warn(`保存失败: ${groupId} pairId为空`);
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
            return;
          }
        }

        if (ev.type === 'judge') {
          try {
            if (Array.isArray(ev.toolPreReplySingleSkipTools)) {
              toolPreReplySingleSkipTools = ev.toolPreReplySingleSkipTools
                .map((s) => String(s || '').trim())
                .filter(Boolean);
            }
            if (Array.isArray(ev.toolNames)) {
              toolPreReplyFallbackToolNames = ev.toolNames
                .map((s) => String(s || '').trim())
                .filter(Boolean);
            }
          } catch { }
        }

        if (ev.type === 'plan' && ev.plan && Array.isArray(ev.plan.steps)) {
          const plan = ev.plan;
          logger.info('执行计划', plan.steps);
          try {
            const cfg = getToolPreReplyRuntimeConfig();
            if (
              cfg.enabled &&
              !toolPreReplyJobStarted &&
              !hasToolPreReplied &&
              !hasRealtimeToolFeedback &&
              !isCancelled
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

              const singleSkipTools = Array.isArray(toolPreReplySingleSkipTools)
                ? toolPreReplySingleSkipTools
                : [];
              const shouldSkipPreReplyForSingleTool =
                toolCount === 1 &&
                singleSkipTools.length > 0 &&
                singleSkipTools.includes(String(toolNames[0] || '').trim());

              const baseUserContentNoRoot = (() => {
                if (isProactive && !isProactiveFirst) return '';
                const pendingContextXml = historyManager.getPendingMessagesContext(groupId, userid);
                const userQuestionXml = buildSentraUserQuestionBlock(latestMsgPlanNeed);
                return pendingContextXml
                  ? pendingContextXml + '\n\n' + userQuestionXml
                  : userQuestionXml;
              })();

              toolPreReplyJobStarted = true;

              const judgeSummary = buildPlanSummary(plan) || ev.summary;
              const preReplyPromise = shouldSkipPreReplyForSingleTool
                ? null
                : generateToolPreReply({
                  chatWithRetry,
                  baseConversations: await rebuildConversationsWithSystem('must_be_sentra_response', conversations),
                  userContentNoRoot: baseUserContentNoRoot,
                  toolNames,
                  skipToolNames: singleSkipTools,
                  timeoutMs: getEnvTimeoutMs('TOOL_PREREPLY_TIMEOUT_MS', 180000, 900000),
                  ...(groupId != null ? { groupId } : {}),
                  ...(MAIN_AI_MODEL ? { model: MAIN_AI_MODEL } : {}),
                  ...(proactiveRootXml ? { originalRootXml: proactiveRootXml } : {}),
                  ...(judgeSummary ? { judgeSummary } : {})
                });

              if (!preReplyPromise) {
                continue;
              }

              preReplyPromise.then(async (preReplyRaw) => {
                if (!preReplyRaw) return;
                if (isCancelled || hasToolPreReplied || hasRealtimeToolFeedback || toolResultArrived) return;

                const preReply = ensureSentraResponseHasTarget(preReplyRaw, msg);

                hasReplied = true;
                hasToolPreReplied = true;

                await smartSend(
                  latestMsgPlanNeed,
                  preReply,
                  sendAndWaitWithConv,
                  true,
                  { hasTool: true, immediate: true }
                );

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
                  const preReplyForHistory = normalizeAssistantContentForHistory(preReply);
                  await historyManager.appendToAssistantMessage(
                    groupId,
                    preReplyForHistory,
                    preReplyPairId
                  );

                  const preReplyUserForHistory = buildSentraUserQuestionBlock(latestMsgPlanNeed);
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
                      logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
                    });

                    triggerPresetTeachingIfNeeded({
                      groupId,
                      chatType,
                      userId: userIdForMemory,
                      userContent: baseUserContentNoRoot,
                      assistantContent: preReplyForHistory
                    }).catch((e) => {
                      logger.debug(`PresetTeaching: 异步教导触发失败 ${groupId}`, { err: String(e) });
                    });
                  }
                } catch (e) {
                  logger.debug('ToolPreReply: 保存预回复对话对失败', { err: String(e) });
                }
              }).catch((e) => {
                logger.debug('ToolPreReply: failed', { err: String(e) });
              });
            }
          } catch (e) {
            logger.debug('ToolPreReply: failed', { err: String(e) });
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

        // Schedule 延迟机制：
        // - status = 'scheduled'  表示已成功解析并设置 schedule，触发一条“定时任务已创建”的普通回复；
        // - status = 'in_progress' 表示到达 delayMs 时工具尚未完成，触发一条“任务仍在执行中的进度”回复；
        // 这两类事件都被包装为虚拟工具 schedule_progress 的 <sentra-result>，再通过主模型生成最终自然语言回复，
        // 与普通 tool_result 路径保持一致（同样走 chatWithRetry + <sentra-response> 流程），不直接发送底层 message 文本。
        if (
          ev.type === 'tool_choice' &&
          (ev.status === 'in_progress' || ev.status === 'scheduled')
        ) {
          const isScheduled = ev.status === 'scheduled';
          const evStatus = typeof ev.status === 'string' ? ev.status : '';
          const evReason = typeof ev.reason === 'string' ? ev.reason : '';
          const evAiName = typeof ev.aiName === 'string' ? ev.aiName : '';
          const evElapsedMs = typeof ev.elapsedMs === 'number' && Number.isFinite(ev.elapsedMs)
            ? ev.elapsedMs
            : Number(ev.elapsedMs || 0) || 0;
          const evDelayMs = typeof ev.delayMs === 'number' && Number.isFinite(ev.delayMs)
            ? ev.delayMs
            : Number(ev.delayMs || 0) || 0;
          const scheduleInfo: ScheduleInfo | null = ev.schedule && typeof ev.schedule === 'object'
            ? (ev.schedule as ScheduleInfo)
            : null;
          try {
            const senderMsgsNow = getAllSenderMessages();
            const latestMsgProgress = senderMsgsNow[senderMsgsNow.length - 1] || msg;

            let progressBaseContent = '';
            if (isProactive && !isProactiveFirst) {
              progressBaseContent = proactiveRootXml || '';
            } else {
              const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
              const userQuestion = buildSentraUserQuestionBlock(latestMsgProgress);
              if (contextXml) {
                progressBaseContent = contextXml + '\n\n' + userQuestion;
              } else {
                progressBaseContent = userQuestion;
              }
              if (proactiveRootXml) {
                progressBaseContent = `${proactiveRootXml}\n\n${progressBaseContent}`;
              }
            }

            let scheduleJobEnqueued = false;
            if (isScheduled && typeof enqueueDelayedJob === 'function') {
              try {
                const argsRaw = ev.args && typeof ev.args === 'object'
                  ? (ev.args as Record<string, unknown>)
                  : {};
                const baseArgs: Record<string, ParamValue> = { ...argsRaw } as Record<string, ParamValue>;
                if (Object.prototype.hasOwnProperty.call(baseArgs, 'schedule')) {
                  delete baseArgs.schedule;
                }

                const delayMs = evDelayMs;
                let fireAt = 0;
                if (scheduleInfo && scheduleInfo.targetISO) {
                  const ts = Date.parse(scheduleInfo.targetISO);
                  if (Number.isFinite(ts) && ts > 0) {
                    fireAt = ts;
                  }
                }
                if (!fireAt) {
                  fireAt = Date.now() + Math.max(0, delayMs);
                }

                const scheduleMode = typeof ev.scheduleMode === 'string'
                  ? ev.scheduleMode
                  : (scheduleInfo && scheduleInfo.mode) || undefined;

                const job = {
                  jobId: randomUUID(),
                  runId: ev.runId || null,
                  aiName: evAiName,
                  args: baseArgs,
                  schedule: scheduleInfo || null,
                  delayMs,
                  scheduleMode,
                  plannedStepIndex: typeof ev.stepIndex === 'number' ? ev.stepIndex : 0,
                  // 基础身份信息：用于在缓存缺失时仍可回退到合理的上下文
                  userId: userid,
                  groupId: msg?.group_id || null,
                  type: msg?.type || (msg?.group_id ? 'group' : 'private'),
                  // 人类可读原因：供延迟任务到期时作为上下文摘要
                  reason: evReason || (scheduleInfo && scheduleInfo.text
                    ? `定时执行 ${scheduleInfo.text}`
                    : '延迟任务到期自动执行'),
                  createdAt: Date.now(),
                  fireAt
                };

                await enqueueDelayedJob(job);
                scheduleJobEnqueued = true;

                const mode = scheduleMode || 'delayed_exec';
                if (mode === 'delayed_exec' && sdk && typeof sdk.cancelRun === 'function' && ev.runId) {
                  try {
                    sdk.cancelRun(ev.runId);
                    try {
                      untrackRunForSender(userid, groupId, ev.runId);
                    } catch { }
                  } catch (e) {
                    logger.debug('取消延迟任务对应的 MCP run 失败', {
                      groupId,
                      runId: ev.runId,
                      err: String(e)
                    });
                  }
                }
              } catch (e) {
                logger.warn('入队延迟任务失败，将继续按普通进度事件处理', {
                  err: String(e)
                });
              }
            }

            if (isScheduled && scheduleJobEnqueued && hasToolPreReplied) {
              endedBySchedule = true;
              break;
            }

            const progressEv = {
              type: 'tool_result',
              aiName: 'schedule_progress',
              stepId:
                (typeof ev.stepId === 'string' && ev.stepId.trim())
                  ? ev.stepId.trim()
                  : `step_schedule_${typeof ev.stepIndex === 'number' ? ev.stepIndex : 0}`,
              plannedStepIndex: typeof ev.stepIndex === 'number' ? ev.stepIndex : 0,
              executionIndex: -1,
              reason:
                evReason ||
                (isScheduled
                  ? '任务已成功设置定时执行'
                  : 'Scheduled tool is still running'),
              nextStep: '',
              args: {
                original_aiName: evAiName,
                status: evStatus,
                elapsedMs: evElapsedMs,
                delayMs: evDelayMs,
                schedule: scheduleInfo
              },
              result: {
                success: true,
                code: isScheduled ? 'SCHEDULED' : 'IN_PROGRESS',
                provider: 'system',
                data: {
                  // 正在执行的真实 MCP 工具
                  original_aiName: evAiName,
                  // 进度类型：schedule_ack / delay_progress
                  kind: isScheduled ? 'schedule_ack' : 'delay_progress',
                  status: evStatus,
                  // 延迟与耗时信息
                  delayMs: evDelayMs,
                  elapsedMs: evElapsedMs,
                  // 解析后的日程信息，供主模型按 MCP 语义理解
                  schedule_text: scheduleInfo?.text,
                  schedule_targetISO: scheduleInfo?.targetISO,
                  schedule_timezone: scheduleInfo?.timezone
                }
              },
              elapsedMs: evElapsedMs,
              dependsOnStepIds: [],
              dependedByStepIds: [],
              groupId: null,
              groupSize: 1,
              toolMeta: { provider: 'system' }
            };

            let progressContent = '';
            try {
              progressContent = buildSentraResultBlock(progressEv);
            } catch (e) {
              logger.warn('构建 <sentra-result> 失败，回退 JSON 注入');
              progressContent = JSON.stringify(progressEv);
            }
            const progressUserContent = buildResultUserContent(progressContent, 'single');

            const fullUserContent = buildResultUserContent(progressContent, 'single', progressBaseContent);

            const progressPairId = await historyManager.startAssistantMessage(groupId);

            // 使用与普通 tool_result 相同的主逻辑：
            // 将 schedule_progress 结果 + 用户上下文 作为一条新的 user 消息送入 MAIN_AI_MODEL，
            // 由模型生成最终要发送给用户的自然语言回复。
            try {
              await historyManager.appendToConversationPairMessages(groupId, progressPairId, 'user', progressBaseContent || '');
              await historyManager.appendToConversationPairMessages(groupId, progressPairId, 'user', progressUserContent);
            } catch { }

            const convForSchedule: ChatMessage[] = [
              ...conversations,
              { role: 'user', content: fullUserContent }
            ];

            const scheduleResult = await chatWithRetry(
              await rebuildConversationsWithSystem('must_be_sentra_response', convForSchedule),
              buildChatWithRetryOptions('sentra_response'),
              groupId
            );

            if (!scheduleResult.success) {
              logger.error(
                `AI响应失败ScheduleProgress: ${groupId} 原因 ${scheduleResult.reason}, 重试${scheduleResult.retries}次`
              );
              try {
                await historyManager.cancelConversationPairById(groupId, progressPairId);
              } catch (e) {
                logger.debug('取消pairId-ScheduleProgress失败', {
                  groupId,
                  err: String(e)
                });
              }
              continue;
            }

            if (scheduleResult.toolsOnly && scheduleResult.rawToolsXml) {
              const toolsXml = String(scheduleResult.rawToolsXml || '').trim();
              if (toolsXml) {
                userObjective = toolsXml;
                forceNeedTools = true;
                restartObjective = toolsXml;
                restartMcp = true;
                logger.info('toolsOnly→direct-exec(ScheduleProgress): 将直接执行 <sentra-tools>', {
                  groupId,
                  attempt: streamAttempt + 2,
                  length: toolsXml.length,
                  preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                });
              }

              if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
                try {
                  sdk.cancelRun(currentRunId);
                  try {
                    untrackRunForSender(userid, groupId, currentRunId);
                  } catch { }
                } catch { }
              }
              currentRunId = null;

              try {
                await historyManager.cancelConversationPairById(groupId, progressPairId);
              } catch { }

              if (restartMcp) {
                break;
              }
              continue;
            }

            const scheduleResponse = scheduleResult.response;
            const scheduleNoReply = !!scheduleResult.noReply;

            const scheduleResponseWithTarget = ensureSentraResponseHasTarget(scheduleResponse, msg);

            const scheduleResponseForHistory = normalizeAssistantContentForHistory(scheduleResponseWithTarget);
            await historyManager.appendToAssistantMessage(groupId, scheduleResponseForHistory, progressPairId);

            const savedProgress = await historyManager.finishConversationPair(
              groupId,
              progressPairId,
              null
            );
            if (!savedProgress) {
              logger.warn(
                `保存进度对话对失败: ${groupId} pairId ${String(progressPairId).substring(0, 8)}`
              );
            }

            if (!scheduleNoReply) {
              const finalMsgProgress = replyAnchorMsg;
              const allowReplyProgress = true;

              await smartSend(
                finalMsgProgress,
                scheduleResponseWithTarget,
                sendAndWaitWithConv,
                allowReplyProgress,
                { hasTool: true }
              );
              hasReplied = true;
              if (ctx.desireManager) {
                try {
                  await ctx.desireManager.onBotMessage(finalMsgProgress, {
                    proactive: !!msg?._proactive
                  });
                } catch (e) {
                  logger.debug('DesireManager onBotMessage(ToolProgress) failed', {
                    err: String(e)
                  });
                }
              }
              markReplySentForConversation(conversationId);
            } else {
              logger.info(
                `ScheduleProgress 阶段: 模型选择保持沉默 (noReply=true)，跳过发送`
              );
            }
          } catch (e) {
            logger.warn('处理 Schedule 延迟进度事件失败，将忽略本次中间状态', {
              err: String(e)
            });
          }
          if (isScheduled) {
            endedBySchedule = true;
            break;
          }
          continue;
        }

        if (ev.type === 'tool_result' || ev.type === 'tool_result_group') {
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
            // 非“结果流进度”事件：仅收集，最终在 completed 阶段统一生成 ToolFinal
            continue;
          }

          if (!currentUserContent) {
            senderMessages = getAllSenderMessages();

            if (senderMessages.length > initialMessageCount) {
              logger.info(
                `动态感知ToolResult: ${groupId} 检测到新消息，拼接完整上下文`
              );
            }

            const latestMsgTool = senderMessages[senderMessages.length - 1] || msg;

            if (isProactive && !isProactiveFirst) {
              // 后续主动回合：仅基于 root 指令和工具结果做总结，不重新注入用户问题
              currentUserContent = proactiveRootXml || '';
            } else {
              // 获取历史上下文（仅供参考：群聊包含“其他成员(上)+该用户累计(下)”，私聊仅该用户历史）
              const contextXml = historyManager.getPendingMessagesContext(groupId, userid);
              const userQuestion = buildSentraUserQuestionBlock(latestMsgTool);

              let toolBaseContent;
              if (contextXml) {
                toolBaseContent = contextXml + '\n\n' + userQuestion;
              } else {
                toolBaseContent = userQuestion;
              }

              currentUserContent = proactiveRootXml
                ? `${proactiveRootXml}\n\n${toolBaseContent}`
                : toolBaseContent;
            }
          }

          hasRealtimeToolFeedback = true;

          // 结果回合仅注入 sentra-result(+root)；不再重复注入基础 user-question，
          // 避免历史中出现重复的 user 记录。
          const shouldIncludeBaseUser = false;
          let resultXml = '';
          try {
            resultXml = buildSentraResultBlock(ev);
          } catch {
            try { resultXml = JSON.stringify(ev); } catch { resultXml = ''; }
          }
          const resultMode: ResultRoundMode = ev.type === 'tool_result_group' ? 'group' : 'single';
          const resultUserContent = buildResultUserContent(resultXml, resultMode);

          const toolPairId = await historyManager.startAssistantMessage(groupId);
          try {
            if (shouldIncludeBaseUser) {
              await historyManager.appendToConversationPairMessages(groupId, toolPairId, 'user', currentUserContent);
            }
            if (resultXml) {
              await historyManager.appendToConversationPairMessages(groupId, toolPairId, 'user', resultUserContent);
            }
          } catch { }

          const convForTool: ChatMessage[] = [
            ...conversations,
            ...(shouldIncludeBaseUser ? [{ role: 'user', content: currentUserContent } as ChatMessage] : []),
            { role: 'user', content: resultUserContent }
          ];

          let toolResponse = null;
          let toolNoReply = false;
          try {
            const result = await chatWithRetry(
              await rebuildConversationsWithSystem('must_be_sentra_response', convForTool),
              buildChatWithRetryOptions('sentra_response'),
              groupId
            );

            if (result && result.success && result.toolsOnly && result.rawToolsXml) {
              const toolsXml = String(result.rawToolsXml || '').trim();
              if (toolsXml) {
                userObjective = toolsXml;
                forceNeedTools = true;
                restartObjective = toolsXml;
                restartMcp = true;
                logger.info('toolsOnly→direct-exec(ToolProgress): 将直接执行 <sentra-tools>', {
                  groupId,
                  attempt: streamAttempt + 2,
                  length: toolsXml.length,
                  preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                });
              }
            } else if (result && result.success) {
              toolResponse = typeof result.response === 'string' ? result.response : '';
              toolNoReply = !!result.noReply;
            }
          } catch (e) {
            logger.warn('ToolProgress: 生成实时回复异常', { err: String(e) });
          }

          if (restartMcp) {
            try {
              await historyManager.cancelConversationPairById(groupId, toolPairId);
            } catch { }
            if (currentRunId && sdk && typeof sdk.cancelRun === 'function') {
              try {
                sdk.cancelRun(currentRunId);
                try {
                  untrackRunForSender(userid, groupId, currentRunId);
                } catch { }
              } catch { }
            }
            currentRunId = null;
            break;
          }

          if (toolResponse) {
            toolResponse = ensureSentraResponseHasTarget(toolResponse, msg);
            try {
              const parsedToolResp = parseSentraResponse(toolResponse);
              if (parsedToolResp && parsedToolResp.shouldSkip) {
                await historyManager.cancelConversationPairById(groupId, toolPairId);
                continue;
              }
            } catch { }
            lastRealtimeToolResponse = toolResponse;
            const toolResponseForHistory = normalizeAssistantContentForHistory(toolResponse);
            await historyManager.appendToAssistantMessage(groupId, toolResponseForHistory, toolPairId);

            // 关键：把“本次工具调用轨迹”按顺序追加进 conversations，保证后续 tool_result / ToolFinal 上下文不乱序
            try {
              if (shouldIncludeBaseUser) {
                conversations.push({ role: 'user', content: currentUserContent });
              }
              if (resultXml) {
                conversations.push({ role: 'user', content: resultUserContent });
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
                await smartSend(
                  finalMsgTool,
                  toolResponse,
                  sendAndWaitWithConv,
                  allowReply,
                  { hasTool: true, immediate: true }
                );
                hasReplied = true;
                hasToolPreReplied = true;
                if (ctx.desireManager) {
                  try {
                    await ctx.desireManager.onBotMessage(finalMsgTool, { proactive: !!msg?._proactive });
                  } catch (e) {
                    logger.debug('DesireManager onBotMessage(ToolProgress) failed', { err: String(e) });
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

        if (ev.type === 'completed') {
          logger.info('任务完成(completed)', {
            runId: ev.runId || null,
            attempted: ev?.exec?.attempted,
            succeeded: ev?.exec?.succeeded
          });

          if (ev.runId) {
            untrackRunForSender(userid, groupId, ev.runId);
          }

          if (isCancelled) {
            logger.info(`任务已取消: ${groupId} 跳过保存对话对(completed阶段)`);
            if (pairId) {
              logger.debug(`清理pairId: ${groupId} pairId ${pairId != null ? String(pairId).substring(0, 8) : ''}`);
              await historyManager.cancelConversationPairById(groupId, pairId);
              pairId = null;
            }
            if (isGroupChat && userid) {
              try {
                await historyManager.clearScopedConversationsForSender(groupId, userid);
              } catch { }
            }
            break;
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
                  logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
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
            break;
          }

          if (pairId) {
            let toolResponse = null;
            let toolNoReply = false;
            try {
              if (toolTurnResultEvents.length > 0) {
                // completed 阶段统一输出 ToolFinal 前，保证 toolTurnResultEvents 顺序稳定（按 plannedStepIndex/executionIndex）
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
                const resultUserContent = buildResultUserContent(resultXml, 'group');

                try {
                  await historyManager.appendToConversationPairMessages(groupId, pairId, 'user', currentUserContent);
                  await historyManager.appendToConversationPairMessages(groupId, pairId, 'user', resultUserContent);
                } catch { }

                const fullUserContent = buildResultUserContent(resultXml, 'group', currentUserContent);
                const convForFinal: ChatMessage[] = [
                  ...conversations,
                  { role: 'user', content: fullUserContent }
                ];

                const result = await chatWithRetry(
                  await rebuildConversationsWithSystem('must_be_sentra_response', convForFinal),
                  buildChatWithRetryOptions('sentra_response'),
                  groupId
                );
                if (result && result.success && result.toolsOnly && result.rawToolsXml) {
                  const toolsXml = String(result.rawToolsXml || '').trim();
                  if (toolsXml) {
                    userObjective = toolsXml;
                    forceNeedTools = true;
                    restartObjective = toolsXml;
                    restartMcp = true;
                    logger.info('toolsOnly→direct-exec(ToolFinal): 将直接执行 <sentra-tools>', {
                      groupId,
                      attempt: streamAttempt + 2,
                      length: toolsXml.length,
                      preview: toolsXml.length > 160 ? toolsXml.substring(0, 160) : toolsXml
                    });
                  }
                  try {
                    await historyManager.cancelConversationPairById(groupId, pairId);
                  } catch { }
                  pairId = null;
                  break;
                }

                if (result && result.success) {
                  toolResponse = typeof result.response === 'string' ? result.response : '';
                  toolNoReply = !!result.noReply;
                } else {
                  logger.error(
                    `AI响应失败ToolFinal: ${groupId} 原因 ${result?.reason || 'unknown'}, 重试${result?.retries || 0}次`
                  );
                }
              }
            } catch (e) {
              logger.warn('ToolFinal: 生成最终回复异常', { err: String(e) });
            }

            if (toolResponse) {
              finalResponseForCompletionAnalysis = String(toolResponse || '');
              const rewritten = await maybeRewriteSentraResponse(toolResponse);
              if (rewritten && typeof rewritten === 'string') {
                toolResponse = rewritten;
              }

              toolResponse = ensureSentraResponseHasTarget(toolResponse, msg);

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
                  await smartSend(
                    finalMsgTool,
                    toolResponse,
                    sendAndWaitWithConv,
                    true,
                    { hasTool: true }
                  );
                  hasReplied = true;
                  if (ctx.desireManager) {
                    try {
                      await ctx.desireManager.onBotMessage(finalMsgTool, {
                        proactive: !!msg?._proactive
                      });
                    } catch (e) {
                      logger.debug('DesireManager onBotMessage(ToolFinal) failed', {
                        err: String(e)
                      });
                    }
                  }
                  markReplySentForConversation(conversationId);
                }
              }
            }

            if (!pairId) {
              logger.warn(`保存失败: ${groupId} pairId为空`);
            } else {
              logger.debug(`保存对话对: ${groupId} pairId ${String(pairId).substring(0, 8)}`);
              const saved = await historyManager.finishConversationPair(groupId, pairId, null);
              if (!saved) {
                logger.warn(`保存失败: ${groupId} pairId ${String(pairId).substring(0, 8)} 状态不一致`);
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
                    logger.debug(`ContextMemory: 异步摘要触发失败 ${groupId}`, { err: String(e) });
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
            logger.warn(`跳过保存: ${groupId} pairId为null`);
          }
          break;
        }

        if (ev.type === 'summary') {
          logger.info('对话总结(summary，非结束信号)', ev.summary);
        }
      }

      if (restartMcp && restartObjective && streamAttempt === 0) {
        userObjective = restartObjective;
        isCancelled = false;
        endedBySchedule = false;
        streamAttempt++;
        continue;
      }

      break;
    }
  } catch (error) {
    logger.error('处理消息异常: ', error);

    if (pairId) {
      logger.debug(`取消pairId-异常: ${groupId} pairId ${String(pairId).substring(0, 8)}`);
      await historyManager.cancelConversationPairById(groupId, pairId);
    }

    if (String(groupId || '').startsWith('G:') && userid) {
      try {
        await historyManager.clearScopedConversationsForSender(groupId, userid);
      } catch { }
    }
  } finally {
    if (currentTaskId) {
      clearCancelledTask(currentTaskId);
    }
    // 任务完成，释放并发槽位并尝试拉起队列中的下一条
    // completeTask 会自动调用 replyPolicy.js 中的 removeActiveTask
    if (taskId && userid) {
      const next = await completeTask(conversationId, taskId);
      if (next && next.msg) {
        const nextConversationId = String(next.conversationId ?? '');
        // 队列中的任务作为新的聚合会话起点
        startBundleForQueuedMessage(nextConversationId, next.msg);
        const bundledNext = await collectBundleForSender(nextConversationId);
        if (bundledNext) {
          await handleOneMessageCore(ctx, bundledNext, next.id);
        }
      }

      // 检查是否有待处理的消息（延迟聚合）
      const mergedMsg = drainPendingMessagesForSender(conversationId);
      if (mergedMsg) {
        const replyDecision = await shouldReply(mergedMsg, { source: 'pending_merged' });
        if (replyDecision.needReply) {
          logger.debug(`延迟聚合进入回复流程: taskId=${replyDecision.taskId || 'null'}`);
          await handleOneMessageCore(ctx, mergedMsg, replyDecision.taskId);
        } else {
          logger.debug(
            '延迟聚合跳过: 根据智能策略，本次不回复（已完成延迟聚合）'
          );
        }
      }
    }

    try {
      const analyzer = ctx && typeof ctx.triggerTaskCompletionAnalysis === 'function'
        ? ctx.triggerTaskCompletionAnalysis
        : null;
      if (!!msg?._taskRecoverySkipAnalysis) {
        logger.info('TaskCompletionAnalyzer: 跳过（task recovery skip analysis）', {
          conversationId,
          taskId: taskId || null
        });
      } else if (!analyzer) {
        logger.debug('TaskCompletionAnalyzer: 跳过（缺少 triggerTaskCompletionAnalysis）', { conversationId });
      } else if (!conversationId || !userid) {
        logger.debug('TaskCompletionAnalyzer: 跳过（缺少 conversationId/userId）', {
          conversationId,
          userId: userid || null
        });
      } else {
        const payload = {
          agent: ctx?.agent || ctx?.sdk,
          groupId,
          conversationId,
          userId: userid,
          userObjective: typeof userObjective === 'string' ? userObjective : null,
          toolInvocations: toolTurnInvocations,
          toolResultEvents: toolTurnResultEvents,
          finalResponse: finalResponseForCompletionAnalysis,
          hasToolCalled: completionAnalysisHasToolCalled || toolTurnInvocations.length > 0 || toolTurnResultEvents.length > 0,
          taskIdOverride: msg?._taskIdOverride || null,
          originTaskFile: msg?._taskFile || null,
          taskRecoveryAttempt: msg?._taskRecoveryAttempt || 0,
          skipSaveOutput: !!msg?._taskRecoverySkipSave,
          forceSaveOutput: !!msg?._taskRecoveryForceSave
        };
        logger.info('TaskCompletionAnalyzer: 已调度', {
          conversationId,
          taskId: taskId || null,
          toolInvocations: toolTurnInvocations.length,
          toolResults: toolTurnResultEvents.length,
          finalResponseLen: String(finalResponseForCompletionAnalysis || '').length
        });
        setTimeout(() => {
          try {
            analyzer(payload).catch((e) => {
              logger.debug('TaskCompletionAnalyzer: 执行失败', { err: String(e), conversationId });
            });
          } catch (e) {
            logger.debug('TaskCompletionAnalyzer: 调度异常', { err: String(e), conversationId });
          }
        }, 0);
      }
    } catch (e) {
      logger.debug('TaskCompletionAnalyzer: 调度失败', { err: String(e), conversationId });
    }

    logger.debug(`任务清理完成: ${groupId} sender ${userid}`);
  }
}
