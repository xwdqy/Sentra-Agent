import { Agent, type AgentConfig } from '../src/agentRuntime.js';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt, getEnvBool, getEnvTimeoutMs, onEnvReload } from './envHotReloader.js';
import { initAgentPresetCore } from '../components/AgentPresetInitializer.js';
type LoadPromptFn = (name: string, params?: Record<string, unknown>) => Promise<string> | string;
const promptsModule = await import(new URL('../../prompts/loader.js', import.meta.url).toString());
const loadPrompt = (promptsModule as { loadPrompt?: LoadPromptFn }).loadPrompt;
if (!loadPrompt) {
  throw new Error('loadPrompt not found in prompts/loader.js');
}
import SentraPromptsSDK from 'sentra-prompts';
import { chatWithRetry as chatWithRetryCore } from '../components/ChatWithRetry.js';
import { parseReplyGateDecisionFromSentraTools, parseSentraResponse } from './protocolUtils.js';
import fs from 'fs/promises';
import path from 'path';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('ReplyIntervention');

type TaskPromise = { content?: string; fulfilled?: boolean; [key: string]: unknown };
type TaskToolCall = { name?: string; aiName?: string; success?: boolean; [key: string]: unknown };
type TaskSnapshot = {
  taskId?: string;
  status?: string;
  isComplete?: boolean;
  summary?: string;
  reason?: string;
  promises?: TaskPromise[];
  toolCalls?: TaskToolCall[];
};

type SendFusionCandidate = { text?: string; taskId?: string | number };
type SendFusionPayload = { candidates?: SendFusionCandidate[]; groupId?: string | number; userQuestion?: string };

type OverrideDecisionPayload = {
  scene?: string;
  senderId?: string | null;
  groupId?: string | null;
  taskGroupId?: string | null;
  prevMessages?: Array<{ text?: string; summary?: string; time?: string }>;
  newMessage?: { text?: string; summary?: string; time?: string };
  signals?: Record<string, unknown>;
};

type AgentLike = InstanceType<typeof Agent>;
type AgentWithConfig = AgentLike & { config?: AgentConfig };

type MessageLike = {
  type?: string;
  summary?: string;
  text?: string;
  sender_id?: string | number | null;
  sender_name?: string;
  group_id?: string | number | null;
  self_id?: string | number | null;
  [key: string]: unknown;
};

type ReplyGateSignals = {
  is_group?: boolean;
  is_private?: boolean;
  mentioned_by_at?: boolean;
  mentioned_by_name?: boolean;
  mentioned_names?: Array<string | number>;
  mentioned_name_hit_count?: number;
  mentioned_name_hits_in_text?: boolean;
  mentioned_name_hits_in_summary?: boolean;
  senderReplyCountWindow?: number;
  groupReplyCountWindow?: number;
  senderFatigue?: number;
  groupFatigue?: number;
  senderLastReplyAgeSec?: number | null;
  groupLastReplyAgeSec?: number | null;
  is_followup_after_bot_reply?: boolean;
  activeTaskCount?: number;
  [key: string]: unknown;
};

type BotInfo = {
  self_id?: string | number | null;
  bot_names?: Array<string | number>;
  [key: string]: unknown;
};

type DecisionContextMessage = {
  sender_id?: string | number;
  sender_name?: string;
  summary?: string;
  text?: string;
  time?: string;
  source?: string;
  pair_id?: string | number;
  timestamp?: string | number;
  [key: string]: unknown;
};

type DecisionContext = {
  group_recent_messages?: DecisionContextMessage[];
  sender_recent_messages?: DecisionContextMessage[];
  bot_recent_messages?: DecisionContextMessage[];
  [key: string]: unknown;
};

type DecisionPayload = {
  scene: string;
  sender_id: string;
  sender_name: string;
  group_id: string | number | null;
  bot: { self_id: string; bot_names: string[] };
  summary: string;
  signals: ReplyGateSignals;
  context?: DecisionContext;
  policy_config?: PolicyConfig;
};

type PlanGroupSignals = {
  mentionedByAt?: boolean;
  mentionedByName?: boolean;
  mentionedNames?: Array<string | number>;
  mentionedNameHitCount?: number;
  mentionedNameHitsInText?: boolean;
  mentionedNameHitsInSummary?: boolean;
  senderReplyCountWindow?: number;
  groupReplyCountWindow?: number;
  senderFatigue?: number;
  groupFatigue?: number;
  senderLastReplyAgeSec?: number;
  groupLastReplyAgeSec?: number;
  isFollowupAfterBotReply?: boolean;
  activeTaskCount?: number;
};

type PlanGroupOptions = {
  signals?: PlanGroupSignals;
  context?: DecisionContext;
  policy?: PolicyConfig;
  bot?: BotInfo;
};

type OverrideSignals = {
  mentioned_by_at?: boolean;
  mentioned_by_name?: boolean;
  [key: string]: unknown;
};

type AttentionConfig = {
  enabled?: boolean;
  windowMs?: number;
  maxSenders?: number;
};

type FatigueConfig = {
  enabled?: boolean;
  windowMs?: number;
  baseLimit?: number;
  minIntervalMs?: number;
  backoffFactor?: number;
  maxBackoffMultiplier?: number;
};

type PolicyConfig = {
  mentionMustReply?: boolean;
  followupWindowSec?: number;
  attention?: AttentionConfig;
  userFatigue?: FatigueConfig;
  groupFatigue?: FatigueConfig;
};

let cachedPresetContextForDecision: string | null = null;
let presetInitPromiseForDecision: Promise<string> | null = null;

const REPLY_DECISION_PROMPT_NAME = 'reply_decision';
const REPLY_FUSION_PROMPT_NAME = 'reply_fusion';
const REPLY_OVERRIDE_PROMPT_NAME = 'reply_override';

let cachedReplyDecisionSystemPrompt: string | null = null;
let cachedReplyFusionSystemPrompt: string | null = null;
let cachedReplyOverrideSystemPrompt: string | null = null;

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');
let cachedDecisionToolsBaseSystem: string | null = null;
let cachedReplyFusionBaseSystem: string | null = null;

async function getDecisionToolsBaseSystem() {
  if (cachedDecisionToolsBaseSystem) return cachedDecisionToolsBaseSystem;
  const template = "{{sentra_short_root_tools_only}}\n\n{{sentra_protocol_tools_only}}\n\n{{qq_system_prompt}}";
  const resolved = await SentraPromptsSDK(template, PROMPTS_CONFIG_PATH);
  cachedDecisionToolsBaseSystem = resolved;
  return resolved;
}

async function getReplyFusionBaseSystem() {
  if (cachedReplyFusionBaseSystem) return cachedReplyFusionBaseSystem;
  const template = "{{sentra_short_root_response_only}}\n\n{{sentra_protocol_response_only}}\n\n{{sentra_protocol_format}}\n\n{{qq_system_prompt}}";
  const resolved = await SentraPromptsSDK(template, PROMPTS_CONFIG_PATH);
  cachedReplyFusionBaseSystem = resolved;
  return resolved;
}

function takePrefix(text: string, count: number): string {
  if (!text || count <= 0) return '';
  let out = '';
  const max = Math.min(text.length, count);
  for (let i = 0; i < max; i++) {
    out += text[i] || '';
  }
  return out;
}

function takeFirst<T>(items: T[], count: number): T[] {
  if (!Array.isArray(items) || count <= 0) return [];
  const out: T[] = [];
  const max = Math.min(items.length, count);
  for (let i = 0; i < max; i++) {
    const item = items[i];
    if (item !== undefined) {
      out.push(item);
    }
  }
  return out;
}

function takeLast<T>(items: T[], count: number): T[] {
  if (!Array.isArray(items) || count <= 0) return [];
  const out: T[] = [];
  const start = Math.max(0, items.length - count);
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined) {
      out.push(item);
    }
  }
  return out;
}

function parseEnterMainFlowDecision(rawText: unknown): boolean | null {
  const t = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!t) return null;
  const m = t.match(/<enter_main_flow>\s*(true|false)\s*<\/enter_main_flow>/i);
  if (!m) return null;
  if (typeof m[1] !== 'string') return null;
  return m[1].toLowerCase() === 'true';
}

function parseOverrideDecisionFromSentraTools(rawText: unknown): { decision: string; confidence: number | null; reason: string } | null {
  const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!raw) return null;
  const toolsMatch = raw.match(/<sentra-tools[\s\S]*?<\/sentra-tools>/i);
  const xml = toolsMatch ? toolsMatch[0] : raw;
  const invokeMatch = xml.match(/<invoke[^>]*name=["']override_intent_decision["'][^>]*>([\s\S]*?)<\/invoke>/i);
  if (!invokeMatch) return null;
  const body = typeof invokeMatch[1] === 'string' ? invokeMatch[1] : '';
  if (!body) return null;
  let decision = '';
  let confidence = null;
  let reason = '';

  const decisionMatch = body.match(/<parameter[^>]*name=["']decision["'][^>]*>[\s\S]*?<string>([\s\S]*?)<\/string>[\s\S]*?<\/parameter>/i);
  if (decisionMatch) {
    const val = typeof decisionMatch[1] === 'string' ? decisionMatch[1] : '';
    decision = val.trim().toLowerCase();
  } else {
    const decisionBareMatch = body.match(/<parameter[^>]*name=["']decision["'][^>]*>([\s\S]*?)<\/parameter>/i);
    if (decisionBareMatch) {
      const val = typeof decisionBareMatch[1] === 'string' ? decisionBareMatch[1] : '';
      decision = val.trim().toLowerCase();
    } else {
      const decisionTagMatch = body.match(/<decision>([\s\S]*?)<\/decision>/i);
      if (decisionTagMatch) {
        const val = typeof decisionTagMatch[1] === 'string' ? decisionTagMatch[1] : '';
        decision = val.trim().toLowerCase();
      }
    }
  }

  const confMatch = body.match(/<parameter[^>]*name=["']confidence["'][^>]*>[\s\S]*?<number>([\s\S]*?)<\/number>[\s\S]*?<\/parameter>/i);
  if (confMatch) {
    const val = typeof confMatch[1] === 'string' ? confMatch[1] : '';
    confidence = parseFloat(val.trim());
  } else {
    const confBareMatch = body.match(/<parameter[^>]*name=["']confidence["'][^>]*>([\s\S]*?)<\/parameter>/i);
    if (confBareMatch) {
      const val = typeof confBareMatch[1] === 'string' ? confBareMatch[1] : '';
      confidence = parseFloat(val.trim());
    } else {
      const confTagMatch = body.match(/<confidence>([\s\S]*?)<\/confidence>/i);
      if (confTagMatch) {
        const val = typeof confTagMatch[1] === 'string' ? confTagMatch[1] : '';
        confidence = parseFloat(val.trim());
      }
    }
  }

  const reasonMatch = body.match(/<parameter[^>]*name=["']reason["'][^>]*>[\s\S]*?<string>([\s\S]*?)<\/string>[\s\S]*?<\/parameter>/i);
  if (reasonMatch) {
    const val = typeof reasonMatch[1] === 'string' ? reasonMatch[1] : '';
    reason = val.trim();
  } else {
    const reasonBareMatch = body.match(/<parameter[^>]*name=["']reason["'][^>]*>([\s\S]*?)<\/parameter>/i);
    if (reasonBareMatch) {
      const val = typeof reasonBareMatch[1] === 'string' ? reasonBareMatch[1] : '';
      reason = val.trim();
    } else {
      const reasonTagMatch = body.match(/<reason>([\s\S]*?)<\/reason>/i);
      if (reasonTagMatch) {
        const val = typeof reasonTagMatch[1] === 'string' ? reasonTagMatch[1] : '';
        reason = val.trim();
      }
    }
  }
  if (!decision) return null;
  return { decision, confidence, reason };
}

function buildTaskDirName(groupIdKey: unknown): string {
  const raw = typeof groupIdKey === 'string' ? groupIdKey.trim() : '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function loadLatestTaskSnapshot({ groupIdKey, userId }: { groupIdKey?: string; userId?: string } = {}): Promise<TaskSnapshot | null> {
  try {
    const dirName = buildTaskDirName(groupIdKey);
    if (!dirName) return null;
    const baseDir = path.join('.', 'taskData', dirName);
    let entries = [];
    try {
      entries = await fs.readdir(baseDir);
    } catch {
      return null;
    }
    const jsonFiles = entries.filter((f) => String(f).toLowerCase().endsWith('.json'));
    if (jsonFiles.length === 0) return null;

    const candidates = [];
    for (const file of jsonFiles) {
      const full = path.join(baseDir, file);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      candidates.push({ full, mtimeMs: stat.mtimeMs || 0 });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const uid = userId != null ? String(userId) : '';
    for (const item of takeFirst(candidates, 10)) {
      try {
        const raw = await fs.readFile(item.full, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (!data || typeof data !== 'object') continue;
        if (uid && data.userId != null && String(data.userId) !== uid) {
          continue;
        }
        const snapshot: TaskSnapshot = {
          promises: Array.isArray(data.promises) ? (data.promises as TaskPromise[]) : [],
          toolCalls: Array.isArray(data.toolCalls) ? (data.toolCalls as TaskToolCall[]) : []
        };
        const taskId = typeof data.taskId === 'string' ? data.taskId : (data.taskId != null ? String(data.taskId) : '');
        if (taskId) snapshot.taskId = taskId;
        const status = typeof data.status === 'string' ? data.status : (data.status != null ? String(data.status) : '');
        if (status) snapshot.status = status;
        if (typeof data.isComplete === 'boolean') snapshot.isComplete = data.isComplete;
        const summary = typeof data.summary === 'string' ? data.summary : (data.summary != null ? String(data.summary) : '');
        if (summary) snapshot.summary = summary;
        const reason = typeof data.reason === 'string' ? data.reason : (data.reason != null ? String(data.reason) : '');
        if (reason) snapshot.reason = reason;
        return snapshot;
      } catch {
        continue;
      }
    }
  } catch { }
  return null;
}

function buildTaskContextXml(taskCtx: TaskSnapshot | null | undefined): string {
  if (!taskCtx || typeof taskCtx !== 'object') return '';
  const lines = [];
  lines.push('<task_context>');
  if (taskCtx.taskId) lines.push(`  <task_id>${escapeXmlText(String(taskCtx.taskId))}</task_id>`);
  if (taskCtx.status) lines.push(`  <status>${escapeXmlText(String(taskCtx.status))}</status>`);
  if (typeof taskCtx.isComplete === 'boolean') {
    lines.push(`  <is_complete>${taskCtx.isComplete ? 'true' : 'false'}</is_complete>`);
  }
  if (taskCtx.summary) lines.push(`  <summary>${escapeXmlText(String(taskCtx.summary))}</summary>`);
  if (taskCtx.reason) lines.push(`  <reason>${escapeXmlText(String(taskCtx.reason))}</reason>`);
  if (Array.isArray(taskCtx.promises) && taskCtx.promises.length > 0) {
    lines.push('  <promises>');
    takeFirst(taskCtx.promises, 5).forEach((p, i) => {
      const content = p && p.content ? String(p.content) : '';
      const fulfilled = p && typeof p.fulfilled === 'boolean' ? p.fulfilled : false;
      lines.push(`    <item index="${i + 1}">`);
      lines.push(`      <content>${escapeXmlText(content)}</content>`);
      lines.push(`      <fulfilled>${fulfilled ? 'true' : 'false'}</fulfilled>`);
      lines.push('    </item>');
    });
    lines.push('  </promises>');
  }
  if (Array.isArray(taskCtx.toolCalls) && taskCtx.toolCalls.length > 0) {
    lines.push('  <tool_calls>');
    takeFirst(taskCtx.toolCalls, 5).forEach((t, i) => {
      const name = t && t.name ? String(t.name) : (t && t.aiName ? String(t.aiName) : '');
      const success = t && typeof t.success === 'boolean' ? t.success : null;
      lines.push(`    <item index="${i + 1}">`);
      lines.push(`      <name>${escapeXmlText(name)}</name>`);
      if (success != null) lines.push(`      <success>${success ? 'true' : 'false'}</success>`);
      lines.push('    </item>');
    });
    lines.push('  </tool_calls>');
  }
  lines.push('</task_context>');
  return lines.join('\n');
}

export async function decideSendFusionBatch(payload: SendFusionPayload | null | undefined) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const enabled = getEnvBool('SEND_FUSION_ENABLED', false);
  if (!enabled) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const groupId = payload?.groupId ? String(payload.groupId) : '';
  const userQuestion = (payload?.userQuestion || '').trim();

  const cleaned = candidates
    .map((c) => {
      const text = (c?.text || '').trim();
      const taskId = c?.taskId != null ? String(c.taskId) : '';
      return { text, taskId };
    })
    .filter((c) => !!c.text);

  if (cleaned.length < 2) {
    return null;
  }

  try {
    const mainModel = getEnv('MAIN_AI_MODEL', getEnv('MODEL_NAME', 'gpt-4o-mini'));
    const model = typeof mainModel === 'string' && mainModel ? mainModel : 'gpt-4o-mini';
    const maxTokens = 260;
    const systemPrompt = await getReplyFusionSystemPrompt();
    const baseSystem = await getReplyFusionBaseSystem();

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>send_fusion_v2</id>');
    rdLines.push('  <type>send_fusion</type>');
    rdLines.push('  <scope>assistant_reply</scope>');
    rdLines.push('  <objective>');
    rdLines.push('    你收到多条“同一轮对话的候选机器人回复”，它们往往啰嗦重复或相互补充。');
    rdLines.push('    你的任务：把这些候选回复压缩融合为一条最终回复，只发送一次，且不丢失重要信息。');
    rdLines.push('  </objective>');

    rdLines.push('  <constraints>');
    rdLines.push('    <item>你必须且只能输出一个顶层块：<sentra-response>...</sentra-response>；除此之外不要输出任何字符、解释、前后缀。</item>');
    rdLines.push('    <item>融合后的回复要自然像聊天，不要提“候选/融合/工具/系统”等词。</item>');
    rdLines.push('    <item>禁止使用模板化旁白：不要写“根据你的请求…/工具调用…/系统提示…/工作流…”。</item>');
    rdLines.push('    <item>去重冗余，但保留不同候选里重要的事实、步骤、提醒、结论与约束。</item>');
    rdLines.push('    <item><sentra-response> 内建议仅输出 text1/text2/text3（尽量短），并包含 <resources></resources>（保持为空即可）。</item>');
    rdLines.push('  </constraints>');

    rdLines.push('  <send_fusion_input>');
    if (userQuestion) {
      rdLines.push('    <user_question>');
      rdLines.push(`      ${escapeXmlText(userQuestion)}`);
      rdLines.push('    </user_question>');
    }
    rdLines.push('    <candidates>');
    for (let i = 0; i < cleaned.length; i++) {
      const item = cleaned[i];
      if (!item) continue;
      const idx = i + 1;
      rdLines.push(`      <candidate index="${idx}">`);
      if (item.taskId) {
        rdLines.push(`        <task_id>${escapeXmlText(item.taskId)}</task_id>`);
      }
      rdLines.push('        <text>');
      rdLines.push(`          ${escapeXmlText(item.text || '')}`);
      rdLines.push('        </text>');
      rdLines.push('      </candidate>');
    }
    rdLines.push('    </candidates>');
    rdLines.push('  </send_fusion_input>');
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations: ChatMessage[] = [
      { role: 'system', content: [baseSystem, systemPrompt].filter(Boolean).join('\n\n') },
      { role: 'user', content: userContent }
    ];

    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens, __sentraExpectedOutput: 'sentra_response' },
      groupId || 'send_fusion'
    );

    if (!result || !result.success || !result.response) {
      logger.warn('SendFusion: chatWithRetry 返回失败结果，将回退为本地规则', {
        reason: result?.reason || 'unknown'
      });
      return null;
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    let parsed = null;
    try {
      parsed = parseSentraResponse(rawText);
    } catch {
      parsed = null;
    }

    const segments = parsed && Array.isArray(parsed.textSegments)
      ? parsed.textSegments.map((t) => (t || '').trim()).filter(Boolean)
      : [];

    if (segments.length === 0) {
      logger.warn('SendFusion: 解析 sentra-response 失败或无文本，将回退为本地规则', {
        snippet: takePrefix(rawText, 400)
      });
      return null;
    }

    logger.info(`SendFusion: 融合完成，segments=${segments.length}`);
    return { textSegments: segments, raw: rawText };
  } catch (e) {
    logger.warn('SendFusion: 调用 LLM 融合失败，将回退为本地规则', { err: String(e) });
    return null;
  }
}

async function getDecisionAgentPresetContext(): Promise<string> {
  if (cachedPresetContextForDecision !== null) {
    return cachedPresetContextForDecision;
  }

  if (!presetInitPromiseForDecision) {
    presetInitPromiseForDecision = (async () => {
      try {
        const presetAgent = getAgent && typeof getAgent === 'function' ? getAgent() : null;
        const snapshot = await initAgentPresetCore(presetAgent || null);
        const xml = snapshot && typeof snapshot.xml === 'string' ? snapshot.xml.trim() : '';
        const plain = snapshot && typeof snapshot.plainText === 'string' ? snapshot.plainText.trim() : '';

        let context = '';
        if (xml) {
          context = xml;
        } else if (plain) {
          const maxLen = 4000;
          const truncated = plain.length > maxLen ? takePrefix(plain, maxLen) : plain;
          context = [
            '<sentra-agent-preset-text>',
            escapeXmlText(truncated),
            '</sentra-agent-preset-text>'
          ].join('\n');
        }

        cachedPresetContextForDecision = context || '';

        if (cachedPresetContextForDecision) {
          logger.info('ReplyIntervention: 已加载 Agent 预设上下文用于回复决策');
        }

        return cachedPresetContextForDecision;
      } catch (e) {
        logger.warn('ReplyIntervention: 加载 Agent 预设失败，将不注入人设上下文', { err: String(e) });
        cachedPresetContextForDecision = '';
        return cachedPresetContextForDecision;
      }
    })();
  }

  return presetInitPromiseForDecision;
}

function isReplyInterventionEnabled() {
  return getEnvBool('ENABLE_REPLY_INTERVENTION', true);
}

function getDecisionConfig() {
  const mainModel = String(getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo') || 'gpt-3.5-turbo');
  const model = String(getEnv('REPLY_DECISION_MODEL', mainModel || 'gpt-4o-mini') || 'gpt-4o-mini');
  const maxTokensRaw = getEnvInt('REPLY_DECISION_MAX_TOKENS', 128);
  const maxTokens = Number.isFinite(maxTokensRaw) ? Number(maxTokensRaw) : 128;
  const maxRetriesRaw = getEnvInt('REPLY_DECISION_MAX_RETRIES', getEnvInt('MAX_RETRIES', 3));
  const maxRetries = Number.isFinite(maxRetriesRaw) ? Number(maxRetriesRaw) : 0;
  const globalTimeoutRaw = getEnvTimeoutMs('TIMEOUT', 180000, 900000);
  const globalTimeout = Number.isFinite(globalTimeoutRaw) ? Number(globalTimeoutRaw) : 180000;
  const timeoutRaw = getEnvTimeoutMs('REPLY_DECISION_TIMEOUT', globalTimeout, 900000);
  const timeout = Number.isFinite(timeoutRaw) ? Number(timeoutRaw) : globalTimeout;
  return { model, maxTokens, maxRetries, timeout };
}

let sharedAgent: AgentWithConfig | null = null;

function getReplyDecisionBaseUrl() {
  return getEnv('REPLY_DECISION_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
}

function getReplyDecisionApiKey() {
  return getEnv('REPLY_DECISION_API_KEY', getEnv('API_KEY'));
}

function getAgent(): AgentWithConfig | null {
  if (!isReplyInterventionEnabled()) {
    return null;
  }
  if (sharedAgent) {
    return sharedAgent;
  }
  try {
    const { model, maxTokens, timeout } = getDecisionConfig();
    const cfg: AgentConfig = {
      // 复用主站点配置，避免单独维护一套 API_KEY/API_BASE_URL
      defaultModel: model,
      temperature: 0,
      maxTokens,
      timeout
    };
    const apiKey = getReplyDecisionApiKey();
    if (apiKey) cfg.apiKey = apiKey;
    const apiBaseUrl = getReplyDecisionBaseUrl();
    if (apiBaseUrl) cfg.apiBaseUrl = apiBaseUrl;
    sharedAgent = new Agent(cfg);
    logger.config('ReplyIntervention 初始化', {
      model,
      maxTokens
    });
  } catch (e) {
    logger.error('初始化 ReplyIntervention Agent 失败，将回退为默认必回策略', e);
    sharedAgent = null;
  }
  return sharedAgent;
}

onEnvReload(() => {
  try {
    if (!sharedAgent || !sharedAgent.config) return;

    const nextBaseUrl = getReplyDecisionBaseUrl();
    if (nextBaseUrl && nextBaseUrl !== sharedAgent.config.apiBaseUrl) {
      sharedAgent.config.apiBaseUrl = nextBaseUrl;
      logger.info('ReplyIntervention LLM 配置热更新: baseURL 已更新', { baseURL: nextBaseUrl });
    }

    const nextApiKey = getReplyDecisionApiKey();
    if (nextApiKey && nextApiKey !== sharedAgent.config.apiKey) {
      sharedAgent.config.apiKey = nextApiKey;
      logger.info('ReplyIntervention LLM 配置热更新: apiKey 已更新');
    }
  } catch { }
});

async function getReplyDecisionSystemPrompt() {
  try {
    if (cachedReplyDecisionSystemPrompt) {
      return cachedReplyDecisionSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_reply_decision_prompt_system}}",
      PROMPTS_CONFIG_PATH
    );
    if (system) {
      cachedReplyDecisionSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_decision prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>reply_decision_classifier</role>';
}

async function getReplyFusionSystemPrompt() {
  try {
    if (cachedReplyFusionSystemPrompt) {
      return cachedReplyFusionSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_reply_fusion_prompt_system}}",
      PROMPTS_CONFIG_PATH
    );
    if (system) {
      cachedReplyFusionSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_fusion prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>send_fusion_planner</role>';
}

async function getReplyOverrideSystemPrompt() {
  try {
    if (cachedReplyOverrideSystemPrompt) {
      return cachedReplyOverrideSystemPrompt;
    }
    const system = await SentraPromptsSDK(
      "{{sentra_reply_override_prompt_system}}",
      PROMPTS_CONFIG_PATH
    );
    if (system) {
      cachedReplyOverrideSystemPrompt = system;
      return system;
    }
  } catch (e) {
    logger.warn('ReplyIntervention: 加载 reply_override prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return '<role>override_intent_classifier</role>';
}

function escapeXmlText(text: unknown): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

type FewShotUserInput = {
  id?: string;
  objectiveLine?: string;
  summary?: string;
  mentionedByAt?: boolean;
  mentionedByName?: boolean;
  followup?: boolean;
  note?: string;
};
type FewShotAssistantInput = { enter: boolean; reason?: string };

function buildReplyGateFewShotMessages(
  { scene, groupId, senderId, botNamesText }: { scene?: string; groupId?: string | number; senderId?: string | number; botNamesText?: string } = {}
): ChatMessage[] {
  const safeScene = typeof scene === 'string' && scene ? scene : 'group';
  const safeGroupId = groupId != null ? String(groupId) : '';
  const safeSenderId = senderId != null ? String(senderId) : '';
  const botNameList = typeof botNamesText === 'string' && botNamesText.trim() ? botNamesText.trim() : '你';
  const primaryBotName = botNameList.split(',').map((x) => x.trim()).filter(Boolean)[0] || '你';

  const mkUser = ({ objectiveLine, summary, mentionedByAt, mentionedByName, followup, note }: FewShotUserInput) => {
    const rd = [];
    rd.push('<sentra-root-directive>');
    rd.push('  <id>reply_gate_v1</id>');
    rd.push('  <type>reply_gate</type>');
    rd.push('  <scope>conversation</scope>');
    rd.push('  <target>');
    rd.push(`    <chat_type>${escapeXmlText(safeScene)}</chat_type>`);
    if (safeGroupId) rd.push(`    <group_id>${escapeXmlText(safeGroupId)}</group_id>`);
    if (safeSenderId) rd.push(`    <user_id>${escapeXmlText(safeSenderId)}</user_id>`);
    rd.push('  </target>');
    rd.push('  <objective>');
    rd.push(`    ${escapeXmlText(objectiveLine || 'Decide whether to enter main flow for this message.')}`);
    rd.push('  </objective>');
    if (note) {
      rd.push('  <meta>');
      rd.push(`    <note>${escapeXmlText(note)}</note>`);
      rd.push('  </meta>');
    }
    rd.push('  <decision_input>');
    rd.push(`    <scene>${escapeXmlText(safeScene)}</scene>`);
    rd.push('    <bot>');
    rd.push('      <self_id></self_id>');
    rd.push(`      <bot_names>${escapeXmlText(botNameList)}</bot_names>`);
    rd.push('    </bot>');
    rd.push('    <message>');
    rd.push('      <text></text>');
    rd.push(`      <summary>${escapeXmlText(summary || '')}</summary>`);
    rd.push('    </message>');
    rd.push('    <signals>');
    rd.push(`      <is_group>${safeScene === 'group' ? 'true' : 'false'}</is_group>`);
    rd.push(`      <is_private>${safeScene === 'private' ? 'true' : 'false'}</is_private>`);
    rd.push(`      <mentioned_by_at>${mentionedByAt ? 'true' : 'false'}</mentioned_by_at>`);
    rd.push(`      <mentioned_by_name>${mentionedByName ? 'true' : 'false'}</mentioned_by_name>`);
    rd.push('      <mentioned_names></mentioned_names>');
    rd.push(`      <mentioned_name_hit_count>${mentionedByName ? '1' : '0'}</mentioned_name_hit_count>`);
    rd.push('      <mentioned_name_hits_in_text>false</mentioned_name_hits_in_text>');
    rd.push('      <mentioned_name_hits_in_summary>false</mentioned_name_hits_in_summary>');
    rd.push('      <senderReplyCountWindow>0</senderReplyCountWindow>');
    rd.push('      <groupReplyCountWindow>0</groupReplyCountWindow>');
    rd.push('      <senderFatigue>0</senderFatigue>');
    rd.push('      <groupFatigue>0</groupFatigue>');
    rd.push('      <senderLastReplyAgeSec></senderLastReplyAgeSec>');
    rd.push('      <groupLastReplyAgeSec></groupLastReplyAgeSec>');
    rd.push(`      <is_followup_after_bot_reply>${followup ? 'true' : 'false'}</is_followup_after_bot_reply>`);
    rd.push('      <activeTaskCount>0</activeTaskCount>');
    rd.push('    </signals>');
    rd.push('  </decision_input>');
    rd.push('</sentra-root-directive>');
    return rd.join('\n');
  };

  const mkAssistant = ({ enter, reason }: FewShotAssistantInput) => {
    return [
      '<sentra-tools>',
      '  <invoke name="reply_gate_decision">',
      `    <parameter name="enter"><boolean>${enter ? 'true' : 'false'}</boolean></parameter>`,
      `    <parameter name="reason"><string>${escapeXmlText(reason || '')}</string></parameter>`,
      '  </invoke>',
      '</sentra-tools>'
    ].join('\n');
  };

  const examples: ChatMessage[] = [];

  // 1) Explicit @ + clear request -> enter
  examples.push({
    role: 'user',
    content: mkUser({
      id: 'fs_1',
      objectiveLine: 'Decide whether to enter main flow.',
      summary: `The user explicitly @${primaryBotName} and asked the bot to help solve an error.`,
      mentionedByAt: true,
      mentionedByName: true,
      followup: false,
      note: 'Few-shot example 1: explicit @ and actionable request'
    })
  });
  examples.push({
    role: 'assistant',
    content: mkAssistant({
      enter: true,
      reason: 'Explicitly addressed to the bot with a clear actionable request.'
    })
  });

  // 2) Name call (BOT_NAMES) + request -> enter
  examples.push({
    role: 'user',
    content: mkUser({
      id: 'fs_2',
      objectiveLine: 'Decide whether to enter main flow.',
      summary: `The user directly called the bot name (${primaryBotName}) and requested a concrete task (write a simple script to compare two texts).`,
      mentionedByAt: false,
      mentionedByName: true,
      followup: false,
      note: 'Few-shot example 2: called by bot name and asked to do a task'
    })
  });
  examples.push({
    role: 'assistant',
    content: mkAssistant({
      enter: true,
      reason: 'The user directly called the bot by name and requested a task.'
    })
  });

  // 3) Third-person mention / praise, no request -> silent
  examples.push({
    role: 'user',
    content: mkUser({
      id: 'fs_3',
      objectiveLine: 'Decide whether to enter main flow.',
      summary: `Group chat praise/third-person mention about ${primaryBotName} with no actionable request; likely just casual chatter.`,
      mentionedByAt: false,
      mentionedByName: true,
      followup: false,
      note: 'Few-shot example 3: third-person mention/praise without a request'
    })
  });
  examples.push({
    role: 'assistant',
    content: mkAssistant({
      enter: false,
      reason: 'No actionable request; replying may be unnecessary noise in group chat.'
    })
  });

  // 4) Group chatter to others -> silent
  examples.push({
    role: 'user',
    content: mkUser({
      id: 'fs_4',
      objectiveLine: 'Decide whether to enter main flow.',
      summary: 'The message is clearly addressed to another member (not the bot) and asks the group for opinions.',
      mentionedByAt: false,
      mentionedByName: false,
      followup: false,
      note: 'Few-shot example 4: conversation is clearly between other members'
    })
  });
  examples.push({
    role: 'assistant',
    content: mkAssistant({
      enter: false,
      reason: 'The message is addressed to someone else and not requesting the bot.'
    })
  });

  return examples;
}
function buildUserPayload(
  msg: MessageLike | null | undefined,
  extraSignals: ReplyGateSignals = {},
  context: DecisionContext | null = null,
  policyConfig: PolicyConfig | null = null,
  botInfo: BotInfo | null = null
): string {
  const scene = msg?.type || 'unknown';
  const summary = typeof msg?.summary === 'string' ? msg.summary : '';

  const resolvedBotInfo: BotInfo = botInfo && typeof botInfo === 'object' ? botInfo : {};
  const botSelfIdRaw = resolvedBotInfo.self_id ?? msg?.self_id ?? '';
  const botSelfId = botSelfIdRaw != null ? String(botSelfIdRaw) : '';
  const botNames = Array.isArray(resolvedBotInfo.bot_names)
    ? resolvedBotInfo.bot_names.map((x: string | number | null | undefined) => String(x || '').trim()).filter(Boolean)
    : [];

  const payload: DecisionPayload = {
    scene,
    sender_id: String(msg?.sender_id ?? ''),
    sender_name: typeof msg?.sender_name === 'string' ? msg.sender_name : '',
    group_id: msg?.group_id ?? null,
    bot: {
      self_id: botSelfId,
      bot_names: botNames
    },
    summary,
    signals: {
      is_group: scene === 'group',
      is_private: scene === 'private',
      ...extraSignals
    }
  };

  if (context && typeof context === 'object') {
    payload.context = context;
  }

  if (policyConfig && typeof policyConfig === 'object') {
    payload.policy_config = policyConfig;
  }

  const lines = [];
  lines.push('<decision_input>');
  lines.push(`<scene>${escapeXmlText(scene)}</scene>`);
  lines.push('<sender>');
  lines.push(`<id>${escapeXmlText(payload.sender_id)}</id>`);
  lines.push(`<name>${escapeXmlText(payload.sender_name)}</name>`);
  lines.push('</sender>');
  lines.push(`<group_id>${escapeXmlText(payload.group_id ?? '')}</group_id>`);

  lines.push('<bot>');
  lines.push(`<self_id>${escapeXmlText(payload.bot?.self_id ?? '')}</self_id>`);
  const botNamesText = Array.isArray(payload.bot?.bot_names) ? payload.bot.bot_names.join(',') : '';
  lines.push(`<bot_names>${escapeXmlText(botNamesText)}</bot_names>`);
  lines.push('</bot>');

  lines.push('<message>');
  lines.push('<text></text>');
  lines.push(`<summary>${escapeXmlText(summary)}</summary>`);
  lines.push('</message>');
  const boolStr = (v: unknown) => (v ? 'true' : 'false');

  const sig: ReplyGateSignals = payload.signals || {};

  lines.push('<signals>');
  lines.push(`<is_group>${boolStr(sig.is_group)}</is_group>`);
  lines.push(`<is_private>${boolStr(sig.is_private)}</is_private>`);
  lines.push(`<mentioned_by_at>${boolStr(!!sig.mentioned_by_at)}</mentioned_by_at>`);
  lines.push(`<mentioned_by_name>${boolStr(!!sig.mentioned_by_name)}</mentioned_by_name>`);
  const names = Array.isArray(sig.mentioned_names) ? sig.mentioned_names.join(',') : '';
  lines.push(`<mentioned_names>${escapeXmlText(names)}</mentioned_names>`);
  lines.push(`<mentioned_name_hit_count>${typeof sig.mentioned_name_hit_count === 'number' ? String(sig.mentioned_name_hit_count) : ''
    }</mentioned_name_hit_count>`);
  lines.push(`<mentioned_name_hits_in_text>${boolStr(!!sig.mentioned_name_hits_in_text)}</mentioned_name_hits_in_text>`);
  lines.push(`<mentioned_name_hits_in_summary>${boolStr(!!sig.mentioned_name_hits_in_summary)}</mentioned_name_hits_in_summary>`);
  lines.push(`<senderReplyCountWindow>${typeof sig.senderReplyCountWindow === 'number' ? String(sig.senderReplyCountWindow) : ''
    }</senderReplyCountWindow>`);
  lines.push(`<groupReplyCountWindow>${typeof sig.groupReplyCountWindow === 'number' ? String(sig.groupReplyCountWindow) : ''
    }</groupReplyCountWindow>`);
  lines.push(`<senderFatigue>${typeof sig.senderFatigue === 'number' ? String(sig.senderFatigue) : ''
    }</senderFatigue>`);
  lines.push(`<groupFatigue>${typeof sig.groupFatigue === 'number' ? String(sig.groupFatigue) : ''
    }</groupFatigue>`);
  lines.push(`<senderLastReplyAgeSec>${typeof sig.senderLastReplyAgeSec === 'number' ? String(sig.senderLastReplyAgeSec) : ''
    }</senderLastReplyAgeSec>`);
  lines.push(`<groupLastReplyAgeSec>${typeof sig.groupLastReplyAgeSec === 'number' ? String(sig.groupLastReplyAgeSec) : ''
    }</groupLastReplyAgeSec>`);
  lines.push(`<is_followup_after_bot_reply>${boolStr(!!sig.is_followup_after_bot_reply)}</is_followup_after_bot_reply>`);
  lines.push(`<activeTaskCount>${typeof sig.activeTaskCount === 'number' ? String(sig.activeTaskCount) : ''
    }</activeTaskCount>`);
  lines.push('</signals>');

  const pc: PolicyConfig = payload.policy_config || {};
  lines.push('<policy_config>');
  lines.push(`<mention_must_reply>${boolStr(!!pc.mentionMustReply)}</mention_must_reply>`);
  lines.push(`<followup_window_sec>${typeof pc.followupWindowSec === 'number' ? String(pc.followupWindowSec) : ''
    }</followup_window_sec>`);
  const pa: AttentionConfig = pc.attention || {};
  lines.push('<attention>');
  lines.push(`<enabled>${boolStr(!!pa.enabled)}</enabled>`);
  lines.push(`<window_ms>${typeof pa.windowMs === 'number' ? String(pa.windowMs) : ''
    }</window_ms>`);
  lines.push(`<max_senders>${typeof pa.maxSenders === 'number' ? String(pa.maxSenders) : ''
    }</max_senders>`);
  lines.push('</attention>');
  const uf: FatigueConfig = pc.userFatigue || {};
  lines.push('<user_fatigue>');
  lines.push(`<enabled>${boolStr(!!uf.enabled)}</enabled>`);
  lines.push(`<window_ms>${typeof uf.windowMs === 'number' ? String(uf.windowMs) : ''
    }</window_ms>`);
  lines.push(`<base_limit>${typeof uf.baseLimit === 'number' ? String(uf.baseLimit) : ''
    }</base_limit>`);
  lines.push(`<min_interval_ms>${typeof uf.minIntervalMs === 'number' ? String(uf.minIntervalMs) : ''
    }</min_interval_ms>`);
  lines.push(`<backoff_factor>${typeof uf.backoffFactor === 'number' ? String(uf.backoffFactor) : ''
    }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${typeof uf.maxBackoffMultiplier === 'number' ? String(uf.maxBackoffMultiplier) : ''
    }</max_backoff_multiplier>`);
  lines.push('</user_fatigue>');
  const gf: FatigueConfig = pc.groupFatigue || {};
  lines.push('<group_fatigue>');
  lines.push(`<enabled>${boolStr(!!gf.enabled)}</enabled>`);
  lines.push(`<window_ms>${typeof gf.windowMs === 'number' ? String(gf.windowMs) : ''
    }</window_ms>`);
  lines.push(`<base_limit>${typeof gf.baseLimit === 'number' ? String(gf.baseLimit) : ''
    }</base_limit>`);
  lines.push(`<min_interval_ms>${typeof gf.minIntervalMs === 'number' ? String(gf.minIntervalMs) : ''
    }</min_interval_ms>`);
  lines.push(`<backoff_factor>${typeof gf.backoffFactor === 'number' ? String(gf.backoffFactor) : ''
    }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${typeof gf.maxBackoffMultiplier === 'number' ? String(gf.maxBackoffMultiplier) : ''
    }</max_backoff_multiplier>`);
  lines.push('</group_fatigue>');
  lines.push('</policy_config>');

  lines.push('<context>');
  const ctx: DecisionContext = payload.context || {};
  const groupMsgs = Array.isArray(ctx.group_recent_messages) ? ctx.group_recent_messages : [];
  const senderMsgs = Array.isArray(ctx.sender_recent_messages) ? ctx.sender_recent_messages : [];
  const botMsgs = Array.isArray(ctx.bot_recent_messages) ? ctx.bot_recent_messages : [];

  lines.push('<group_recent_messages>');
  for (const m of groupMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const msummary = m?.summary || m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${escapeXmlText(mid)}</sender_id>`);
    lines.push(`<sender_name>${escapeXmlText(mname)}</sender_name>`);
    lines.push('<text></text>');
    lines.push(`<summary>${escapeXmlText(msummary)}</summary>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</group_recent_messages>');

  lines.push('<sender_recent_messages>');
  for (const m of senderMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const msummary = m?.summary || m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${escapeXmlText(mid)}</sender_id>`);
    lines.push(`<sender_name>${escapeXmlText(mname)}</sender_name>`);
    lines.push('<text></text>');
    lines.push(`<summary>${escapeXmlText(msummary)}</summary>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</sender_recent_messages>');

  lines.push('<bot_recent_messages>');
  for (const m of botMsgs) {
    const msummary = m?.summary || m?.text || '';
    const mtime = m?.time || '';
    const msource = m?.source || '';
    const mpair = m?.pair_id != null ? String(m.pair_id) : '';
    const mts = m?.timestamp != null ? String(m.timestamp) : '';
    lines.push('<message>');
    if (msource) {
      lines.push(`<source>${escapeXmlText(msource)}</source>`);
    }
    if (mpair) {
      lines.push(`<pair_id>${escapeXmlText(mpair)}</pair_id>`);
    }
    if (mts) {
      lines.push(`<timestamp>${escapeXmlText(mts)}</timestamp>`);
    }
    lines.push('<text></text>');
    lines.push(`<summary>${escapeXmlText(msummary)}</summary>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</bot_recent_messages>');
  lines.push('</context>');
  lines.push('</decision_input>');

  return lines.join('\n');
}

/**
 * 群聊回复决策入口
 *
 * @param {Object} msg - 原始消息对象
 * @param {Object} options - 附加信号（由上层解析）
 * @param {Object} options.signals - 结构化信号，例如 { mentionedByAt, mentionedByName, mentionedNames }
 * @returns {Promise<{ shouldReply: boolean, confidence: number, reason: string, priority: string, shouldQuote: boolean, raw?: any }|null>}
 */
export async function planGroupReplyDecision(msg: MessageLike, options: PlanGroupOptions = {}) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const signals: PlanGroupSignals = options.signals || {};
  const extraSignals = {
    mentioned_by_at: !!signals.mentionedByAt,
    mentioned_by_name: !!signals.mentionedByName,
    mentioned_names: Array.isArray(signals.mentionedNames) ? signals.mentionedNames : [],
    mentioned_name_hit_count: typeof signals.mentionedNameHitCount === 'number' ? signals.mentionedNameHitCount : 0,
    mentioned_name_hits_in_text: !!signals.mentionedNameHitsInText,
    mentioned_name_hits_in_summary: !!signals.mentionedNameHitsInSummary,
    senderReplyCountWindow: typeof signals.senderReplyCountWindow === 'number' ? signals.senderReplyCountWindow : 0,
    groupReplyCountWindow: typeof signals.groupReplyCountWindow === 'number' ? signals.groupReplyCountWindow : 0,
    senderFatigue: typeof signals.senderFatigue === 'number' ? signals.senderFatigue : 0,
    groupFatigue: typeof signals.groupFatigue === 'number' ? signals.groupFatigue : 0,
    senderLastReplyAgeSec: typeof signals.senderLastReplyAgeSec === 'number' ? signals.senderLastReplyAgeSec : null,
    groupLastReplyAgeSec: typeof signals.groupLastReplyAgeSec === 'number' ? signals.groupLastReplyAgeSec : null,
    is_followup_after_bot_reply: !!signals.isFollowupAfterBotReply,
    activeTaskCount: typeof signals.activeTaskCount === 'number' ? signals.activeTaskCount : 0
  };

  const scene = msg?.type || 'unknown';
  const safeGroupId = msg?.group_id != null ? String(msg.group_id) : '';
  const safeSenderId = msg?.sender_id != null ? String(msg.sender_id) : '';

  const botInfo: BotInfo = options.bot && typeof options.bot === 'object' ? options.bot : {};
  const botNames = Array.isArray(botInfo.bot_names)
    ? botInfo.bot_names.map((x: string | number | null | undefined) => String(x || '').trim()).filter(Boolean)
    : [];

  const decisionInputXml = buildUserPayload(
    msg,
    extraSignals,
    options.context || null,
    options.policy || null,
    options.bot || null
  );

  const rdLines = [];
  rdLines.push('<sentra-root-directive>');
  rdLines.push('  <id>reply_gate_v1</id>');
  rdLines.push('  <type>reply_gate</type>');
  rdLines.push('  <scope>conversation</scope>');
  rdLines.push('  <target>');
  rdLines.push(`    <chat_type>${escapeXmlText(scene)}</chat_type>`);
  if (safeGroupId) {
    rdLines.push(`    <group_id>${escapeXmlText(safeGroupId)}</group_id>`);
  }
  if (safeSenderId) {
    rdLines.push(`    <user_id>${escapeXmlText(safeSenderId)}</user_id>`);
  }
  rdLines.push('  </target>');

  rdLines.push('  <objective>');
  rdLines.push('    你只需做门禁判断：本轮是否进入主对话/MCP 流程（enter=true/false）。');
  rdLines.push('    你必须输出且只能输出 1 个 <sentra-tools> 块，且其中必须包含 1 个 <invoke name="reply_gate_decision">。');
  rdLines.push('    该 invoke 必须包含 enter(boolean) 与 reason(string)，reason 用 1-2 句解释原因（内部用，不展示给用户）。');
  rdLines.push('  </objective>');

  rdLines.push('  <allow_tools>true</allow_tools>');

  rdLines.push('  <constraints>');
  rdLines.push('    <item>Detailed gate rules are defined in the system prompt (reply_decision). Treat this <constraints> block as a minimal placeholder.</item>');
  rdLines.push('  </constraints>');

  rdLines.push('  <meta>');
  rdLines.push('    <note>下面的 <decision_input> 是一个结构化的辅助输入，其中已经包含了本条消息、群/用户的疲劳度、是否被 @ 以及最近对话的摘要等信号，你可以将其视为只读背景数据，用于支撑你的价值判断。</note>');
  rdLines.push('  </meta>');

  const indentedDecision = decisionInputXml
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n');
  rdLines.push(indentedDecision);
  rdLines.push('</sentra-root-directive>');

  const userContent = rdLines.join('\n');

  try {
    const { model, maxTokens } = getDecisionConfig();
    const presetContext = await getDecisionAgentPresetContext();
    const systemPrompt = await getReplyDecisionSystemPrompt();
    const baseSystem = await getDecisionToolsBaseSystem();

    const toolDecisionConstraint = [
      '<sentra-protocol>',
      'You MUST output exactly one <sentra-tools> block containing exactly one invoke:',
      '<invoke name="reply_gate_decision"> with parameters enter(boolean) and reason(string).',
      'Do NOT output any user-facing <sentra-response> in this decision task.',
      '</sentra-protocol>'
    ].join('\n');

    const systemContent = [baseSystem, toolDecisionConstraint, systemPrompt, presetContext].filter(Boolean).join('\n\n');

    const botNamesText = botNames.length ? botNames.join(',') : '';
    const fewShotMessages = buildReplyGateFewShotMessages({
      scene,
      groupId: safeGroupId,
      senderId: safeSenderId,
      botNamesText
    });

    const conversations: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...fewShotMessages,
      { role: 'user', content: userContent }
    ];

    const groupIdForLog = msg?.group_id != null ? `reply_gate_${msg.group_id}` : 'reply_gate';
    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens, __sentraExpectedOutput: 'reply_gate_decision_tools' },
      groupIdForLog
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('ReplyIntervention: chatWithRetry 返回失败结果，将默认判定为无需回复', {
        reason
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason,
        priority: 'normal',
        shouldQuote: false,
        raw: result || null
      };
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    const toolDecision = parseReplyGateDecisionFromSentraTools(rawText);
    if (toolDecision && typeof toolDecision.enter === 'boolean') {
      const shouldReply = toolDecision.enter;
      const confidence = shouldReply ? 1.0 : 0.0;
      const reasonText = toolDecision.reason
        ? `ReplyGate(sentra-tools): ${toolDecision.reason}`
        : (shouldReply ? 'ReplyGate(sentra-tools): enter main flow' : 'ReplyGate(sentra-tools): stay silent');

      logger.info(
        `ReplyIntervention 判定: shouldReply=${shouldReply}, tool=reply_gate_decision, reason=${reasonText}`
      );

      return {
        shouldReply,
        confidence,
        reason: reasonText,
        priority: 'normal',
        shouldQuote: false,
        raw: {
          text: rawText,
          toolDecision
        }
      };
    }

    // Backward-compatible fallback (legacy output)
    let parsed;
    try {
      parsed = parseSentraResponse(rawText);
    } catch (e) {
      logger.warn('ReplyIntervention: 解析 sentra 输出失败，将默认判定为无需回复', {
        err: String(e),
        snippet: takePrefix(rawText, 500)
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason: 'parse sentra output failed',
        priority: 'normal',
        shouldQuote: false,
        raw: { error: String(e), snippet: takePrefix(rawText, 200) }
      };
    }

    const shouldSkip = !!parsed.shouldSkip;
    const explicitDecision = parseEnterMainFlowDecision(rawText);

    let shouldReply = false;
    if (typeof explicitDecision === 'boolean') {
      shouldReply = explicitDecision;
    } else if (shouldSkip) {
      shouldReply = false;
    } else {
      shouldReply = false;
      logger.warn('ReplyIntervention: 缺失 reply_gate_decision 且缺失 <enter_main_flow>，保守默认不进入主对话流程', {
        replyMode: parsed.replyMode || 'none'
      });
    }

    const confidence = shouldReply ? 1.0 : 0.0;
    const reasonText = shouldReply
      ? 'ReplyGate(legacy): enter main flow'
      : 'ReplyGate(legacy): stay silent';

    logger.info(
      `ReplyIntervention 判定(legacy): shouldReply=${shouldReply}, shouldSkip=${shouldSkip}, explicitDecision=${explicitDecision}, replyMode=${parsed.replyMode || 'none'}, reason=${reasonText}`
    );

    return {
      shouldReply,
      confidence,
      reason: reasonText,
      priority: 'normal',
      shouldQuote: false,
      raw: {
        text: rawText,
        explicitDecision,
        shouldSkip
      }
    };
  } catch (e) {
    logger.warn('ReplyIntervention: 调用 LLM 决策失败，将默认判定为无需回复', { err: String(e) });
    return {
      shouldReply: false,
      confidence: 0.0,
      reason: 'LLM decision failed (timeout or API error), default no reply',
      priority: 'normal',
      shouldQuote: false,
      raw: { error: String(e) }
    };
  }
}
export async function decideOverrideIntent(payload: OverrideDecisionPayload | null | undefined) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  try {
    const safePayload: {
      scene: string;
      senderId: string;
      groupId: string;
      taskGroupId: string;
      prevMessages: Array<{ text?: string; summary?: string; time?: string }>;
      newMessage: { text?: string; summary?: string; time?: string } | null;
      signals: OverrideSignals;
    } = {
      scene: payload?.scene || 'unknown',
      senderId: payload?.senderId || '',
      groupId: payload?.groupId || '',
      taskGroupId: payload?.taskGroupId || '',
      prevMessages: Array.isArray(payload?.prevMessages) ? takeLast(payload.prevMessages, 5) : [],
      newMessage: payload?.newMessage || null,
      signals: payload?.signals && typeof payload.signals === 'object' ? (payload.signals as OverrideSignals) : {}
    };

    const nm: { text?: string; summary?: string; time?: string } = safePayload.newMessage || {};
    const nmSummary = nm.summary || nm.text || '';
    const mentionedByAt = !!safePayload.signals?.mentioned_by_at;
    const mentionedByName = !!safePayload.signals?.mentioned_by_name;
    const explicitCancel = /(?:取消|不用了|算了|停下|停止|别做|不要了|撤销|先不用|先别|改成|换成)/.test(nmSummary);

    const taskCtx = await loadLatestTaskSnapshot({
      groupIdKey: safePayload.taskGroupId || safePayload.groupId,
      userId: safePayload.senderId
    });

    const lines = [];
    lines.push('<override_decision_input>');
    lines.push(`<scene>${escapeXmlText(safePayload.scene)}</scene>`);
    lines.push(`<sender_id>${escapeXmlText(safePayload.senderId)}</sender_id>`);
    lines.push(`<group_id>${escapeXmlText(safePayload.groupId || '')}</group_id>`);
    lines.push('<signals>');
    lines.push(`<mentioned_by_at>${mentionedByAt ? 'true' : 'false'}</mentioned_by_at>`);
    lines.push(`<mentioned_by_name>${mentionedByName ? 'true' : 'false'}</mentioned_by_name>`);
    lines.push(`<explicit_cancel>${explicitCancel ? 'true' : 'false'}</explicit_cancel>`);
    lines.push('</signals>');
    if (taskCtx) {
      lines.push(buildTaskContextXml(taskCtx));
    }
    lines.push('<prev_messages>');
    for (const m of safePayload.prevMessages) {
      if (!m || (!m.text && !m.summary)) continue;
      const summary = m.summary || m.text || '';
      const time = m.time || '';
      lines.push('<message>');
      lines.push('<text></text>');
      lines.push(`<summary>${escapeXmlText(summary)}</summary>`);
      lines.push(`<time>${escapeXmlText(time)}</time>`);
      lines.push('</message>');
    }
    lines.push('</prev_messages>');

    const nmTime = nm.time || '';
    lines.push('<new_message>');
    lines.push('<text></text>');
    lines.push(`<summary>${escapeXmlText(nmSummary)}</summary>`);
    lines.push(`<time>${escapeXmlText(nmTime)}</time>`);
    lines.push('</new_message>');
    lines.push('</override_decision_input>');

    const { model, maxTokens } = getDecisionConfig();
    const systemPrompt = await getReplyOverrideSystemPrompt();
    const baseSystem = await getDecisionToolsBaseSystem();

    const toolDecisionConstraint = [
      '<sentra-protocol>',
      'You MUST output exactly one <sentra-tools> block containing exactly one invoke:',
      '<invoke name="override_intent_decision"> with parameters decision(string), confidence(number optional), reason(string optional).',
      'Do NOT output any user-facing <sentra-response> in this decision task.',
      '</sentra-protocol>'
    ].join('\n');

    const overrideGuidance = [
      '<override-guidance>',
      'Task: decide follow-up handling when a previous task may still be running.',
      'Input: prefer <summary> fields; <text> may be empty/noisy.',
      'Decision mapping:',
      '- cancel_only: user cancels previous task without new/changed request.',
      '- cancel_and_restart: user replaces the request OR adds clarifications/supplements to the same task (always).',
      '- reply: worth replying but does NOT require canceling the old task.',
      '- pending: hold and do not reply now.',
      '</override-guidance>'
    ].join('\n');

    const systemContent = [baseSystem, toolDecisionConstraint, systemPrompt, overrideGuidance]
      .filter(Boolean)
      .join('\n\n');

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>override_intent_v3</id>');
    rdLines.push('  <type>override_intent</type>');
    rdLines.push('  <scope>conversation</scope>');
    rdLines.push('  <target>');
    rdLines.push(`    <chat_type>${escapeXmlText(safePayload.scene)}</chat_type>`);
    if (safePayload.groupId) {
      rdLines.push(`    <group_id>${escapeXmlText(safePayload.groupId)}</group_id>`);
    }
    if (safePayload.senderId) {
      rdLines.push(`    <user_id>${escapeXmlText(safePayload.senderId)}</user_id>`);
    }
    rdLines.push('  </target>');
    rdLines.push('  <objective>');
    rdLines.push('    输出 override_intent_decision 决策（reply|pending|cancel_and_restart|cancel_only）。');
    rdLines.push('  </objective>');
    rdLines.push('  <constraints>');
    rdLines.push('    <item>Detailed rules are defined in the system prompt (reply_override). This is a minimal placeholder.</item>');
    rdLines.push('  </constraints>');

    const indentedInput = lines
      .join('\n')
      .split('\n')
      .map((line) => (line ? `  ${line}` : ''))
      .join('\n');
    rdLines.push(indentedInput);
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations: ChatMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];

    const groupIdForLog = safePayload.groupId
      ? `override_${safePayload.groupId}`
      : safePayload.senderId
        ? `override_user_${safePayload.senderId}`
        : 'override';

    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens, __sentraExpectedOutput: 'override_intent_decision_tools' },
      groupIdForLog
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('OverrideIntervention: chatWithRetry 返回失败，默认不取消', { reason });
      return null;
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    const toolDecision = parseOverrideDecisionFromSentraTools(rawText);
    if (toolDecision && toolDecision.decision) {
      const decision = toolDecision.decision;
      const confidence =
        typeof toolDecision.confidence === 'number' && Number.isFinite(toolDecision.confidence)
          ? toolDecision.confidence
          : (decision.startsWith('cancel') ? 0.9 : 0.6);
      const reasonText = toolDecision.reason
        ? `OverrideDecision: ${toolDecision.reason}`
        : `OverrideDecision: ${decision}`;

      logger.info(
        `OverrideIntervention 决定: decision=${decision}, confidence=${(confidence * 100).toFixed(1)}%, reason=${reasonText}`
      );

      return {
        relation: 'override',
        shouldCancel: decision === 'cancel_and_restart' || decision === 'cancel_only',
        decision,
        confidence,
        reason: reasonText,
        raw: rawText
      };
    }

    logger.warn('OverrideIntervention: tools parse failed, default to no-cancel', {
      snippet: takePrefix(rawText, 500)
    });
    return null;
  } catch (e) {
    logger.warn('OverrideIntervention: 调用 LLM 决策失败，默认不取消', { err: String(e) });
    return null;
  }
}
