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
import { parseSentraMessage, parseSentraToolsInvocations } from './protocolUtils.js';
import { extractXMLTag } from './xmlUtils.js';
import fs from 'fs/promises';
import path from 'path';
import type { ChatMessage } from '../src/types.js';
import { tReplyIntervention } from './i18n/replyInterventionCatalog.js';
import {
  buildSentraContractPolicyText,
  buildSentraRootDirectiveFromContract,
  getSentraContractRequiredInvokeName,
  getSentraContractOutputInstruction,
} from './sentraToolsContractEngine.js';

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
const REPLY_GATE_CONTRACT_ID = 'reply_gate_decision';
const OVERRIDE_CONTRACT_ID = 'override_intent_decision';

const REPLY_GATE_INVOKE_NAME =
  getSentraContractRequiredInvokeName(REPLY_GATE_CONTRACT_ID, 'reply_gate_decision') ||
  'reply_gate_decision';
const REPLY_GATE_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(REPLY_GATE_CONTRACT_ID);
const REPLY_GATE_POLICY_TEXT = buildSentraContractPolicyText(REPLY_GATE_CONTRACT_ID);

const OVERRIDE_INVOKE_NAME =
  getSentraContractRequiredInvokeName(OVERRIDE_CONTRACT_ID, 'override_intent_decision') ||
  'override_intent_decision';
const OVERRIDE_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(OVERRIDE_CONTRACT_ID);
const OVERRIDE_POLICY_TEXT = buildSentraContractPolicyText(OVERRIDE_CONTRACT_ID);

let cachedReplyDecisionSystemPrompt: string | null = null;
let cachedReplyFusionSystemPrompt: string | null = null;
let cachedReplyOverrideSystemPrompt: string | null = null;

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');
let cachedDecisionToolsBaseSystem: string | null = null;
let cachedReplyFusionBaseSystem: string | null = null;
const REPLY_INTERVENTION_PROMPT_DIR = path.resolve('.', 'prompts', 'reply-intervention');
const REPLY_INTERVENTION_DEFAULT_LOCALE = 'zh-CN';

type ReplyGateRuleResource = {
  objective_lines?: string[];
  constraints?: string[];
  meta_note?: string;
};

type ReplyGateFewShotResource = {
  examples?: Array<{
    user?: FewShotUserInput;
    assistant?: FewShotAssistantInput;
  }>;
};

type OverrideRuleResource = {
  objective_lines?: string[];
  constraints?: string[];
  guidance_lines?: string[];
};

const replyGateRuleCache = new Map<string, ReplyGateRuleResource>();
const replyGateFewShotCache = new Map<string, ReplyGateFewShotResource>();
const overrideRuleCache = new Map<string, OverrideRuleResource>();

function resolveInterventionLocale(): string {
  const raw = String(getEnv('SENTRA_LOCALE', getEnv('LOCALE', REPLY_INTERVENTION_DEFAULT_LOCALE)) || '').trim();
  if (!raw) return REPLY_INTERVENTION_DEFAULT_LOCALE;
  return raw;
}

async function tryReadJsonResource<T extends Record<string, unknown>>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as T;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

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

function parseOverrideDecisionFromSentraTools(rawText: unknown): { decision: string; confidence: number | null; reason: string } | null {
  const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!raw) return null;
  let decision = '';
  let confidence: number | null = null;
  let reason = '';

  const invokes = parseSentraToolsInvocations(raw);
  const override = invokes.find((it) => String(it?.aiName || '').trim() === OVERRIDE_INVOKE_NAME);
  if (override) {
    decision = String(override?.args?.decision ?? '').trim().toLowerCase();
    const confRaw = override?.args?.confidence;
    if (confRaw != null && String(confRaw).trim()) {
      const confNum = Number.parseFloat(String(confRaw).trim());
      confidence = Number.isFinite(confNum) ? confNum : null;
    }
    reason = String(override?.args?.reason ?? '').trim();
  } else {
    decision = String(extractXMLTag(raw, 'decision') || '').trim().toLowerCase();
    const confText = String(extractXMLTag(raw, 'confidence') || '').trim();
    if (confText) {
      const confNum = Number.parseFloat(confText);
      confidence = Number.isFinite(confNum) ? confNum : null;
    }
    reason = String(extractXMLTag(raw, 'reason') || '').trim();
  }
  if (!decision) return null;
  return { decision, confidence, reason };
}

function parseReplyGateDecisionByContract(rawText: unknown): { enter: boolean; action: string; delayWhen: string; reason: string } | null {
  const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!raw) return null;
  const invokes = parseSentraToolsInvocations(raw);
  const gate = invokes.find((it) => String(it?.aiName || '').trim() === REPLY_GATE_INVOKE_NAME);
  if (!gate || !gate.args || typeof gate.args !== 'object') return null;
  const args = gate.args as Record<string, unknown>;
  const enterRaw = args.enter;
  const enter =
    typeof enterRaw === 'boolean'
      ? enterRaw
      : String(enterRaw ?? '').trim().toLowerCase() === 'true'
        ? true
        : String(enterRaw ?? '').trim().toLowerCase() === 'false'
          ? false
          : null;
  if (typeof enter !== 'boolean') return null;
  const action = String(args.action ?? (enter ? 'action' : 'silent')).trim().toLowerCase();
  const delayWhen = String(args.delay_when ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  return { enter, action, delayWhen, reason };
}

async function loadLatestTaskSnapshot({ groupIdKey, userId }: { groupIdKey?: string; userId?: string } = {}): Promise<TaskSnapshot | null> {
  void groupIdKey;
  void userId;
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
    rdLines.push('    <item>你必须且只能输出一个顶层块：<sentra-message>...</sentra-message>；除此之外不要输出任何字符、解释、前后缀。</item>');
    rdLines.push('    <item>融合后的回复要自然像聊天，不要提“候选/融合/工具/系统”等词。</item>');
    rdLines.push('    <item>禁止使用模板化旁白：不要写“根据你的请求…/工具调用…/系统提示…/工作流…”。</item>');
    rdLines.push('    <item>去重冗余，但保留不同候选里重要的事实、步骤、提醒、结论与约束。</item>');
    rdLines.push('    <item><sentra-message> 内仅使用 message/segment 结构，建议 1-3 个 text segment（尽量短）。</item>');
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
      { model, maxTokens, __sentraExpectedOutput: 'sentra_message' },
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
      parsed = parseSentraMessage(rawText);
    } catch {
      parsed = null;
    }

    const segments = parsed && Array.isArray(parsed.textSegments)
      ? parsed.textSegments.map((t) => (t || '').trim()).filter(Boolean)
      : [];

    if (segments.length === 0) {
      logger.warn('SendFusion: 解析 sentra-message 失败或无文本，将回退为本地规则', {
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

function buildReplyGateRootDirectiveXml({
  scene,
  groupId,
  senderId,
  objectiveLines,
  metaNote,
  decisionInputXml
}: {
  scene?: string;
  groupId?: string;
  senderId?: string;
  objectiveLines?: string[];
  metaNote?: string;
  decisionInputXml?: string;
}): string {
  const targetLines: string[] = [
    '  <target>',
    `    <chat_type>${escapeXmlText(scene || '')}</chat_type>`
  ];
  if (groupId) targetLines.push(`    <group_id>${escapeXmlText(groupId)}</group_id>`);
  if (senderId) targetLines.push(`    <user_id>${escapeXmlText(senderId)}</user_id>`);
  targetLines.push('  </target>');

  const objectiveText = Array.isArray(objectiveLines)
    ? objectiveLines.map((x) => String(x || '').trim()).filter(Boolean).join(' ')
    : '';

  const extraBlocks: string[] = [targetLines.join('\n')];
  const note = String(metaNote || '').trim();
  if (note) {
    extraBlocks.push(
      '  <meta>',
      `    <note>${escapeXmlText(note)}</note>`,
      '  </meta>'
    );
  }
  const inputXml = String(decisionInputXml || '').trim();
  if (inputXml) {
    const indentedInput = inputXml
      .split('\n')
      .map((line) => (line ? `  ${line}` : ''))
      .join('\n');
    extraBlocks.push(indentedInput);
  }

  return buildSentraRootDirectiveFromContract({
    contractId: REPLY_GATE_CONTRACT_ID,
    idPrefix: 'reply_gate',
    scope: 'conversation',
    phaseOverride: 'ReplyIntervention',
    ...(objectiveText ? { objectiveOverride: objectiveText } : {}),
    extraBlocks
  });
}

function buildOverrideRootDirectiveXml({
  scene,
  groupId,
  senderId,
  objectiveLines,
  overrideDecisionInputXml
}: {
  scene?: string;
  groupId?: string;
  senderId?: string;
  objectiveLines?: string[];
  overrideDecisionInputXml?: string;
}): string {
  const targetLines: string[] = [
    '  <target>',
    `    <chat_type>${escapeXmlText(scene || '')}</chat_type>`
  ];
  if (groupId) targetLines.push(`    <group_id>${escapeXmlText(groupId)}</group_id>`);
  if (senderId) targetLines.push(`    <user_id>${escapeXmlText(senderId)}</user_id>`);
  targetLines.push('  </target>');

  const objectiveText = Array.isArray(objectiveLines)
    ? objectiveLines.map((x) => String(x || '').trim()).filter(Boolean).join(' ')
    : '';

  const inputXml = String(overrideDecisionInputXml || '').trim();
  const extraBlocks: string[] = [targetLines.join('\n')];
  if (inputXml) {
    const indentedInput = inputXml
      .split('\n')
      .map((line) => (line ? `  ${line}` : ''))
      .join('\n');
    extraBlocks.push(indentedInput);
  }

  return buildSentraRootDirectiveFromContract({
    contractId: OVERRIDE_CONTRACT_ID,
    idPrefix: 'override_intent',
    scope: 'conversation',
    phaseOverride: 'ReplyIntervention',
    ...(objectiveText ? { objectiveOverride: objectiveText } : {}),
    extraBlocks
  });
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
type FewShotAssistantInput = {
  enter: boolean;
  action?: 'silent' | 'action' | 'short' | 'delay';
  delayWhen?: string;
  reason?: string;
};

const DEFAULT_REPLY_GATE_RULES: Required<ReplyGateRuleResource> = Object.freeze({
  objective_lines: [
    '你只需做门禁动作判断：silent|action|short|delay。',
    `你必须输出且只能输出 1 个 <sentra-tools> 块，且其中必须包含 1 个 <invoke name="${REPLY_GATE_INVOKE_NAME}">。`,
    '该 invoke 必须包含 action(string)、enter(boolean)、reason(string)；当 action=delay 时必须额外提供 delay_when(string) 并使用可解析时间格式。'
  ],
  constraints: [
    'Detailed gate rules are defined in the system prompt (reply_decision). Treat this <constraints> block as a minimal placeholder.'
  ],
  meta_note: '下面的 <decision_input> 是一个结构化的辅助输入，其中已经包含了本条消息、群/用户的疲劳度、是否被 @ 以及最近对话的摘要等信号，你可以将其视为只读背景数据，用于支撑你的价值判断。'
});

function buildDefaultReplyGateFewShotExamples(primaryBotName: string): Array<{ user: FewShotUserInput; assistant: FewShotAssistantInput }> {
  return [
    {
      user: {
        id: 'fs_1',
        objectiveLine: 'Decide whether to enter main flow.',
        summary: `The user explicitly @${primaryBotName} and asked the bot to help solve an error.`,
        mentionedByAt: true,
        mentionedByName: true,
        followup: false,
        note: 'Few-shot example 1: explicit @ and actionable request'
      },
      assistant: {
        enter: true,
        action: 'action',
        reason: 'Explicitly addressed to the bot with a clear actionable request.'
      }
    },
    {
      user: {
        id: 'fs_2',
        objectiveLine: 'Decide whether to enter main flow.',
        summary: `The user directly called the bot name (${primaryBotName}) and requested a concrete task (write a simple script to compare two texts).`,
        mentionedByAt: false,
        mentionedByName: true,
        followup: false,
        note: 'Few-shot example 2: called by bot name and asked to do a task'
      },
      assistant: {
        enter: true,
        action: 'action',
        reason: 'The user directly called the bot by name and requested a task.'
      }
    },
    {
      user: {
        id: 'fs_3',
        objectiveLine: 'Decide whether to enter main flow.',
        summary: `Group chat praise/third-person mention about ${primaryBotName} with no actionable request; likely just casual chatter.`,
        mentionedByAt: false,
        mentionedByName: true,
        followup: false,
        note: 'Few-shot example 3: third-person mention/praise without a request'
      },
      assistant: {
        enter: false,
        action: 'silent',
        reason: 'No actionable request; replying may be unnecessary noise in group chat.'
      }
    },
    {
      user: {
        id: 'fs_4',
        objectiveLine: 'Decide whether to enter main flow.',
        summary: 'The message is clearly addressed to another member (not the bot) and asks the group for opinions.',
        mentionedByAt: false,
        mentionedByName: false,
        followup: false,
        note: 'Few-shot example 4: conversation is clearly between other members'
      },
      assistant: {
        enter: false,
        action: 'silent',
        reason: 'The message is addressed to someone else and not requesting the bot.'
      }
    },
    {
      user: {
        id: 'fs_5',
        objectiveLine: 'Decide whether to enter main flow.',
        summary: 'The user gives an explicit future-timed command: "过4分钟之后戳我2下".',
        mentionedByAt: true,
        mentionedByName: true,
        followup: false,
        note: 'Few-shot example 5: explicit delay intent should output action=delay + delay_when'
      },
      assistant: {
        enter: true,
        action: 'delay',
        delayWhen: '4分钟后',
        reason: 'Explicit future-timed request; defer user-facing reply and provide parseable delay_when.'
      }
    }
  ];
}

async function loadReplyGateRulesResource(locale: string): Promise<Required<ReplyGateRuleResource>> {
  const normalized = String(locale || '').trim() || REPLY_INTERVENTION_DEFAULT_LOCALE;
  const cached = replyGateRuleCache.get(normalized);
  if (cached && Array.isArray(cached.objective_lines) && Array.isArray(cached.constraints)) {
    return {
      objective_lines: cached.objective_lines,
      constraints: cached.constraints,
      meta_note: typeof cached.meta_note === 'string' ? cached.meta_note : DEFAULT_REPLY_GATE_RULES.meta_note
    };
  }

  const candidates = [normalized, REPLY_INTERVENTION_DEFAULT_LOCALE];
  for (const name of candidates) {
    const file = path.join(REPLY_INTERVENTION_PROMPT_DIR, name, 'reply_gate_rules.json');
    const parsed = await tryReadJsonResource<ReplyGateRuleResource>(file);
    if (!parsed) continue;
    const objective_lines = Array.isArray(parsed.objective_lines)
      ? parsed.objective_lines.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const constraints = Array.isArray(parsed.constraints)
      ? parsed.constraints.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const meta_note = typeof parsed.meta_note === 'string' ? parsed.meta_note.trim() : '';
    if (objective_lines.length > 0 && constraints.length > 0) {
      const value: Required<ReplyGateRuleResource> = {
        objective_lines,
        constraints,
        meta_note: meta_note || DEFAULT_REPLY_GATE_RULES.meta_note
      };
      replyGateRuleCache.set(normalized, value);
      return value;
    }
  }

  replyGateRuleCache.set(normalized, DEFAULT_REPLY_GATE_RULES);
  return DEFAULT_REPLY_GATE_RULES;
}

async function loadReplyGateFewShotResource(locale: string): Promise<ReplyGateFewShotResource> {
  const normalized = String(locale || '').trim() || REPLY_INTERVENTION_DEFAULT_LOCALE;
  const cached = replyGateFewShotCache.get(normalized);
  if (cached && Array.isArray(cached.examples)) return cached;

  const candidates = [normalized, REPLY_INTERVENTION_DEFAULT_LOCALE];
  for (const name of candidates) {
    const file = path.join(REPLY_INTERVENTION_PROMPT_DIR, name, 'reply_gate_fewshot.json');
    const parsed = await tryReadJsonResource<ReplyGateFewShotResource>(file);
    if (!parsed || !Array.isArray(parsed.examples) || parsed.examples.length === 0) continue;
    replyGateFewShotCache.set(normalized, parsed);
    return parsed;
  }

  const empty: ReplyGateFewShotResource = { examples: [] };
  replyGateFewShotCache.set(normalized, empty);
  return empty;
}

const DEFAULT_OVERRIDE_RULES: Required<OverrideRuleResource> = Object.freeze({
  objective_lines: [
    `输出 ${OVERRIDE_INVOKE_NAME} 决策（reply|pending|cancel_and_restart|cancel_only）。`
  ],
  constraints: [
    'Detailed rules are defined in the system prompt (reply_override). This is a minimal placeholder.'
  ],
  guidance_lines: [
    'Task: decide follow-up handling when a previous task may still be running.',
    'Input: prefer <summary> fields; <text> may be empty/noisy.',
    'Decision mapping:',
    '- cancel_only: user cancels previous task without new/changed request.',
    '- cancel_and_restart: user replaces the request OR adds clarifications/supplements to the same task (always).',
    '- reply: worth replying but does NOT require canceling the old task.',
    '- pending: hold and do not reply now.'
  ]
});

async function loadOverrideRuleResource(locale: string): Promise<Required<OverrideRuleResource>> {
  const normalized = String(locale || '').trim() || REPLY_INTERVENTION_DEFAULT_LOCALE;
  const cached = overrideRuleCache.get(normalized);
  if (cached && Array.isArray(cached.objective_lines) && Array.isArray(cached.constraints) && Array.isArray(cached.guidance_lines)) {
    return {
      objective_lines: cached.objective_lines,
      constraints: cached.constraints,
      guidance_lines: cached.guidance_lines
    };
  }

  const candidates = [normalized, REPLY_INTERVENTION_DEFAULT_LOCALE];
  for (const name of candidates) {
    const file = path.join(REPLY_INTERVENTION_PROMPT_DIR, name, 'override_rules.json');
    const parsed = await tryReadJsonResource<OverrideRuleResource>(file);
    if (!parsed) continue;
    const objective_lines = Array.isArray(parsed.objective_lines)
      ? parsed.objective_lines.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const constraints = Array.isArray(parsed.constraints)
      ? parsed.constraints.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const guidance_lines = Array.isArray(parsed.guidance_lines)
      ? parsed.guidance_lines.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (objective_lines.length > 0 && constraints.length > 0 && guidance_lines.length > 0) {
      const value: Required<OverrideRuleResource> = {
        objective_lines,
        constraints,
        guidance_lines
      };
      overrideRuleCache.set(normalized, value);
      return value;
    }
  }

  overrideRuleCache.set(normalized, DEFAULT_OVERRIDE_RULES);
  return DEFAULT_OVERRIDE_RULES;
}

async function buildReplyGateFewShotMessages(
  { scene, groupId, senderId, botNamesText }: { scene?: string; groupId?: string | number; senderId?: string | number; botNamesText?: string } = {}
): Promise<ChatMessage[]> {
  const safeScene = typeof scene === 'string' && scene ? scene : 'group';
  const safeGroupId = groupId != null ? String(groupId) : '';
  const safeSenderId = senderId != null ? String(senderId) : '';
  const botNameList = typeof botNamesText === 'string' && botNamesText.trim() ? botNamesText.trim() : '你';
  const primaryBotName = botNameList.split(',').map((x) => x.trim()).filter(Boolean)[0] || '你';

  const mkUser = ({ objectiveLine, summary, mentionedByAt, mentionedByName, followup, note }: FewShotUserInput) => {
    const decisionInputLines = [];
    decisionInputLines.push('<decision_input>');
    decisionInputLines.push(`  <scene>${escapeXmlText(safeScene)}</scene>`);
    decisionInputLines.push('  <bot>');
    decisionInputLines.push('    <self_id></self_id>');
    decisionInputLines.push(`    <bot_names>${escapeXmlText(botNameList)}</bot_names>`);
    decisionInputLines.push('  </bot>');
    decisionInputLines.push('  <message>');
    decisionInputLines.push('    <text></text>');
    decisionInputLines.push(`    <summary>${escapeXmlText(summary || '')}</summary>`);
    decisionInputLines.push('  </message>');
    decisionInputLines.push('  <signals>');
    decisionInputLines.push(`    <is_group>${safeScene === 'group' ? 'true' : 'false'}</is_group>`);
    decisionInputLines.push(`    <is_private>${safeScene === 'private' ? 'true' : 'false'}</is_private>`);
    decisionInputLines.push(`    <mentioned_by_at>${mentionedByAt ? 'true' : 'false'}</mentioned_by_at>`);
    decisionInputLines.push(`    <mentioned_by_name>${mentionedByName ? 'true' : 'false'}</mentioned_by_name>`);
    decisionInputLines.push('    <mentioned_names></mentioned_names>');
    decisionInputLines.push(`    <mentioned_name_hit_count>${mentionedByName ? '1' : '0'}</mentioned_name_hit_count>`);
    decisionInputLines.push('    <mentioned_name_hits_in_text>false</mentioned_name_hits_in_text>');
    decisionInputLines.push('    <mentioned_name_hits_in_summary>false</mentioned_name_hits_in_summary>');
    decisionInputLines.push('    <senderReplyCountWindow>0</senderReplyCountWindow>');
    decisionInputLines.push('    <groupReplyCountWindow>0</groupReplyCountWindow>');
    decisionInputLines.push('    <senderFatigue>0</senderFatigue>');
    decisionInputLines.push('    <groupFatigue>0</groupFatigue>');
    decisionInputLines.push('    <senderLastReplyAgeSec></senderLastReplyAgeSec>');
    decisionInputLines.push('    <groupLastReplyAgeSec></groupLastReplyAgeSec>');
    decisionInputLines.push(`    <is_followup_after_bot_reply>${followup ? 'true' : 'false'}</is_followup_after_bot_reply>`);
    decisionInputLines.push('    <activeTaskCount>0</activeTaskCount>');
    decisionInputLines.push('  </signals>');
    decisionInputLines.push('</decision_input>');
    return buildReplyGateRootDirectiveXml({
      scene: safeScene,
      groupId: safeGroupId,
      senderId: safeSenderId,
      objectiveLines: [objectiveLine || 'Decide whether to enter main flow for this message.'],
      metaNote: note || '',
      decisionInputXml: decisionInputLines.join('\n')
    });
  };

  const mkAssistant = ({ enter, action, delayWhen, reason }: FewShotAssistantInput) => {
    const resolvedAction = String(action || (enter ? 'action' : 'silent')).trim().toLowerCase();
    const lines = [
      '<sentra-tools>',
      `  <invoke name="${REPLY_GATE_INVOKE_NAME}">`,
      `    <parameter name="action"><string>${escapeXmlText(resolvedAction)}</string></parameter>`,
      `    <parameter name="enter"><boolean>${enter ? 'true' : 'false'}</boolean></parameter>`,
      ...(resolvedAction === 'delay' && String(delayWhen || '').trim()
        ? [`    <parameter name="delay_when"><string>${escapeXmlText(String(delayWhen).trim())}</string></parameter>`]
        : []),
      `    <parameter name="reason"><string>${escapeXmlText(reason || '')}</string></parameter>`,
      '  </invoke>',
      '</sentra-tools>'
    ];
    return lines.join('\n');
  };

  const locale = resolveInterventionLocale();
  const fewShotResource = await loadReplyGateFewShotResource(locale);
  const configuredPairs = Array.isArray(fewShotResource.examples) ? fewShotResource.examples : [];
  const defaultPairs = buildDefaultReplyGateFewShotExamples(primaryBotName);
  const pairs = configuredPairs.length > 0
    ? configuredPairs
        .map((item) => {
          const user = item && item.user && typeof item.user === 'object' ? item.user : null;
          const assistant = item && item.assistant && typeof item.assistant === 'object' ? item.assistant : null;
          if (!user || !assistant || typeof (assistant as FewShotAssistantInput).enter !== 'boolean') {
            return null;
          }
          return { user: user as FewShotUserInput, assistant: assistant as FewShotAssistantInput };
        })
        .filter((x): x is { user: FewShotUserInput; assistant: FewShotAssistantInput } => !!x)
    : defaultPairs;

  const examples: ChatMessage[] = [];
  for (const item of pairs) {
    examples.push({
      role: 'user',
      content: mkUser(item.user)
    });
    examples.push({
      role: 'assistant',
      content: mkAssistant(item.assistant)
    });
  }

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
  const summary = (
    (typeof msg?.text === 'string' ? msg.text : '') ||
    (typeof (msg as any)?.summary_text === 'string' ? (msg as any).summary_text : '') ||
    (typeof (msg as any)?.objective_text === 'string' ? (msg as any).objective_text : '') ||
    ''
  );

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
 * @returns {Promise<{ shouldReply: boolean, confidence: number, reason: string, priority: string, shouldQuote: boolean, action?: string, delayWhen?: string, raw?: any }|null>}
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
  const locale = resolveInterventionLocale();
  const gateRules = await loadReplyGateRulesResource(locale);
  const userContent = buildReplyGateRootDirectiveXml({
    scene,
    groupId: safeGroupId,
    senderId: safeSenderId,
    objectiveLines: gateRules.objective_lines,
    metaNote: gateRules.meta_note,
    decisionInputXml
  });

  try {
    const { model, maxTokens } = getDecisionConfig();
    const presetContext = await getDecisionAgentPresetContext();
    const systemPrompt = await getReplyDecisionSystemPrompt();
    const baseSystem = await getDecisionToolsBaseSystem();

    const toolDecisionConstraint = [
      '<sentra-protocol>',
      REPLY_GATE_OUTPUT_INSTRUCTION,
      REPLY_GATE_POLICY_TEXT,
      '</sentra-protocol>'
    ].join('\n');

    const systemContent = [baseSystem, toolDecisionConstraint, systemPrompt, presetContext].filter(Boolean).join('\n\n');

    const botNamesText = botNames.length ? botNames.join(',') : '';
    const fewShotMessages = await buildReplyGateFewShotMessages({
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
      const reason = tReplyIntervention('reply_gate_chat_retry_failed', {
        detail: result?.reason || 'unknown'
      });
      logger.warn('ReplyIntervention: chatWithRetry 返回失败结果，将默认判定为无需回复', {
        reason
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason,
        action: 'silent',
        priority: 'normal',
        shouldQuote: false,
        raw: result || null
      };
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    const toolDecision = parseReplyGateDecisionByContract(rawText);
    if (toolDecision && typeof toolDecision.enter === 'boolean') {
      const shouldReply = toolDecision.enter;
      const action = String(toolDecision.action || (shouldReply ? 'action' : 'silent')).trim().toLowerCase();
      const delayWhen = typeof toolDecision.delayWhen === 'string' ? toolDecision.delayWhen.trim() : '';
      const confidence = shouldReply ? 1.0 : 0.0;
      const reasonText = toolDecision.reason
        ? `ReplyGate(sentra-tools): ${toolDecision.reason}`
        : (shouldReply ? 'ReplyGate(sentra-tools): enter main flow' : 'ReplyGate(sentra-tools): stay silent');

      logger.info(
        `ReplyIntervention 判定: shouldReply=${shouldReply}, tool=${REPLY_GATE_INVOKE_NAME}, reason=${reasonText}`
      );

      return {
        shouldReply,
        confidence,
        reason: reasonText,
        action,
        delayWhen,
        priority: 'normal',
        shouldQuote: false,
        raw: {
          text: rawText,
          toolDecision
        }
      };
    }

    logger.warn(`ReplyIntervention: missing valid ${REPLY_GATE_INVOKE_NAME} invoke; default no reply`, {
      snippet: takePrefix(rawText, 500)
    });

    return {
      shouldReply: false,
      confidence: 0.0,
      reason: tReplyIntervention('reply_gate_invalid_output'),
      action: 'silent',
      priority: 'normal',
      shouldQuote: false,
      raw: { text: rawText }
    };
  } catch (e) {
    logger.warn('ReplyIntervention: 调用 LLM 决策失败，将默认判定为无需回复', { err: String(e) });
    return {
      shouldReply: false,
      confidence: 0.0,
      reason: tReplyIntervention('reply_gate_llm_failed', { detail: String(e) }),
      action: 'silent',
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
    const locale = resolveInterventionLocale();
    const overrideRules = await loadOverrideRuleResource(locale);
    const systemPrompt = await getReplyOverrideSystemPrompt();
    const baseSystem = await getDecisionToolsBaseSystem();

    const toolDecisionConstraint = [
      '<sentra-protocol>',
      OVERRIDE_OUTPUT_INSTRUCTION,
      OVERRIDE_POLICY_TEXT,
      '</sentra-protocol>'
    ].join('\n');

    const overrideGuidance = [
      '<override-guidance>',
      ...overrideRules.guidance_lines,
      '</override-guidance>'
    ].join('\n');

    const systemContent = [baseSystem, toolDecisionConstraint, systemPrompt, overrideGuidance]
      .filter(Boolean)
      .join('\n\n');
    const userContent = buildOverrideRootDirectiveXml({
      scene: safePayload.scene,
      groupId: safePayload.groupId || '',
      senderId: safePayload.senderId || '',
      objectiveLines: overrideRules.objective_lines,
      overrideDecisionInputXml: lines.join('\n')
    });

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
      const reason = tReplyIntervention('override_chat_retry_failed', {
        detail: result?.reason || 'unknown'
      });
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
      reason: tReplyIntervention('override_parse_failed'),
      snippet: takePrefix(rawText, 500)
    });
    return null;
  } catch (e) {
    logger.warn('OverrideIntervention: 调用 LLM 决策失败，默认不取消', {
      err: String(e),
      reason: tReplyIntervention('override_llm_failed', { detail: String(e) })
    });
    return null;
  }
}
