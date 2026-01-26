import { Agent } from '../agent.js';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt, getEnvBool, getEnvTimeoutMs, onEnvReload } from './envHotReloader.js';
import { initAgentPresetCore } from '../components/AgentPresetInitializer.js';
import { loadPrompt } from '../prompts/loader.js';
import { chatWithRetry as chatWithRetryCore } from '../components/ChatWithRetry.js';
import { parseReplyGateDecisionFromSentraTools, parseSendFusionFromSentraTools, parseSentraResponse } from './protocolUtils.js';

const logger = createLogger('ReplyIntervention');

let cachedPresetContextForDecision = null;
let presetInitPromiseForDecision = null;

const REPLY_DECISION_PROMPT_NAME = 'reply_decision';
const REPLY_FUSION_PROMPT_NAME = 'reply_fusion';
const REPLY_OVERRIDE_PROMPT_NAME = 'reply_override';

let cachedReplyDecisionSystemPrompt = null;
let cachedReplyFusionSystemPrompt = null;
let cachedReplyOverrideSystemPrompt = null;

function parseEnterMainFlowDecision(rawText) {
  const t = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!t) return null;
  const m = t.match(/<enter_main_flow>\s*(true|false)\s*<\/enter_main_flow>/i);
  if (!m) return null;
  return m[1].toLowerCase() === 'true';
}

export async function decideSendFusionBatch(payload) {
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
    const model = mainModel;
    const maxTokens = 260;
    const systemPrompt = await getReplyFusionSystemPrompt();

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>send_fusion_v1</id>');
    rdLines.push('  <type>send_fusion</type>');
    rdLines.push('  <scope>assistant_reply</scope>');
    rdLines.push('  <objective>');
    rdLines.push('    你收到多条“同一轮对话的候选机器人回复”，它们往往啰嗦重复或相互补充。');
    rdLines.push('    你的任务：把这些候选回复压缩融合为一条最终回复，只发送一次，且不丢失重要信息。');
    rdLines.push('  </objective>');

    rdLines.push('  <constraints>');
    rdLines.push('    <item>禁止输出 <sentra-response>；必须输出一个 tools invoke: send_fusion。</item>');
    rdLines.push('    <item>融合后的回复要自然像聊天，不要提“候选/融合/工具/系统”等词。</item>');
    rdLines.push('    <item>禁止使用模板化旁白：不要写“根据你的请求…/工具调用…/系统提示…/工作流…”。</item>');
    rdLines.push('    <item>去重冗余，但保留不同候选里重要的事实、步骤、提醒、结论与约束。</item>');
    rdLines.push('  </constraints>');

    rdLines.push('  <send_fusion_input>');
    if (userQuestion) {
      rdLines.push('    <user_question>');
      rdLines.push(`      ${escapeXmlText(userQuestion)}`);
      rdLines.push('    </user_question>');
    }
    rdLines.push('    <candidates>');
    for (let i = 0; i < cleaned.length; i++) {
      const idx = i + 1;
      rdLines.push(`      <candidate index="${idx}">`);
      if (cleaned[i].taskId) {
        rdLines.push(`        <task_id>${escapeXmlText(cleaned[i].taskId)}</task_id>`);
      }
      rdLines.push('        <text>');
      rdLines.push(`          ${escapeXmlText(cleaned[i].text)}`);
      rdLines.push('        </text>');
      rdLines.push('      </candidate>');
    }
    rdLines.push('    </candidates>');
    rdLines.push('  </send_fusion_input>');
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const result = await chatWithRetryCore(
      agent,
      conversations,
      { model, maxTokens, __sentraExpectedOutput: 'send_fusion_tools' },
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

    const fusion = parseSendFusionFromSentraTools(rawText);
    if (!fusion || !Array.isArray(fusion.textSegments) || fusion.textSegments.length === 0) {
      logger.warn('SendFusion: 解析 send_fusion tools 失败，将回退为本地规则', {
        snippet: rawText.slice(0, 400)
      });
      return null;
    }

    logger.info(`SendFusion: 融合完成，segments=${fusion.textSegments.length}, reason=${fusion.reason || ''}`);
    return { textSegments: fusion.textSegments, reason: fusion.reason || '', raw: rawText };
  } catch (e) {
    logger.warn('SendFusion: 调用 LLM 融合失败，将回退为本地规则', { err: String(e) });
    return null;
  }
}

async function getDecisionAgentPresetContext() {
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
          const truncated = plain.length > maxLen ? plain.slice(0, maxLen) : plain;
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
  const mainModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo');
  const model = getEnv('REPLY_DECISION_MODEL', mainModel || 'gpt-4o-mini');
  const maxTokens = getEnvInt('REPLY_DECISION_MAX_TOKENS', 128);
  const maxRetries = getEnvInt('REPLY_DECISION_MAX_RETRIES', getEnvInt('MAX_RETRIES', 3));
  const globalTimeout = getEnvTimeoutMs('TIMEOUT', 180000, 900000);
  const timeout = getEnvTimeoutMs('REPLY_DECISION_TIMEOUT', globalTimeout, 900000);
  return { model, maxTokens, maxRetries, timeout };
}

let sharedAgent = null;

function getReplyDecisionBaseUrl() {
  return getEnv('REPLY_DECISION_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
}

function getReplyDecisionApiKey() {
  return getEnv('REPLY_DECISION_API_KEY', getEnv('API_KEY'));
}

function getAgent() {
  if (!isReplyInterventionEnabled()) {
    return null;
  }
  if (sharedAgent) {
    return sharedAgent;
  }
  try {
    const { model, maxTokens, maxRetries, timeout } = getDecisionConfig();
    sharedAgent = new Agent({
      // 复用主站点配置，避免单独维护一套 API_KEY/API_BASE_URL
      apiKey: getReplyDecisionApiKey(),
      apiBaseUrl: getReplyDecisionBaseUrl(),
      defaultModel: model,
      temperature: 0,
      maxTokens,
      maxRetries,
      timeout
    });
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
  } catch {}
});

async function getReplyDecisionSystemPrompt() {
  try {
    if (cachedReplyDecisionSystemPrompt) {
      return cachedReplyDecisionSystemPrompt;
    }
    const data = await loadPrompt(REPLY_DECISION_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
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
    const data = await loadPrompt(REPLY_FUSION_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
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
    const data = await loadPrompt(REPLY_OVERRIDE_PROMPT_NAME);
    const system = data && typeof data.system === 'string' ? data.system : '';
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

function escapeXmlText(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function buildUserPayload(msg, extraSignals = {}, context = null, policyConfig = null, botInfo = null) {
  const scene = msg?.type || 'unknown';
  const text = typeof msg?.text === 'string' ? msg.text : '';
  const summary = typeof msg?.summary === 'string' ? msg.summary : '';

  const resolvedBotInfo = botInfo && typeof botInfo === 'object' ? botInfo : {};
  const botSelfIdRaw = resolvedBotInfo.self_id ?? msg?.self_id ?? '';
  const botSelfId = botSelfIdRaw != null ? String(botSelfIdRaw) : '';
  const botNames = Array.isArray(resolvedBotInfo.bot_names)
    ? resolvedBotInfo.bot_names.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  const payload = {
    scene,
    sender_id: String(msg?.sender_id ?? ''),
    sender_name: msg?.sender_name || '',
    group_id: msg?.group_id ?? null,
    bot: {
      self_id: botSelfId,
      bot_names: botNames
    },
    text,
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

  const json = JSON.stringify(payload);

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
  lines.push(`<text>${escapeXmlText(text)}</text>`);
  lines.push(`<summary>${escapeXmlText(summary)}</summary>`);
  lines.push('</message>');
  const boolStr = (v) => (v ? 'true' : 'false');

  const sig = payload.signals || {};

  lines.push('<signals>');
  lines.push(`<is_group>${boolStr(sig.is_group)}</is_group>`);
  lines.push(`<is_private>${boolStr(sig.is_private)}</is_private>`);
  lines.push(`<mentioned_by_at>${boolStr(!!sig.mentioned_by_at)}</mentioned_by_at>`);
  lines.push(`<mentioned_by_name>${boolStr(!!sig.mentioned_by_name)}</mentioned_by_name>`);
  const names = Array.isArray(sig.mentioned_names) ? sig.mentioned_names.join(',') : '';
  lines.push(`<mentioned_names>${escapeXmlText(names)}</mentioned_names>`);
  lines.push(`<mentioned_name_hit_count>${
    typeof sig.mentioned_name_hit_count === 'number' ? String(sig.mentioned_name_hit_count) : ''
  }</mentioned_name_hit_count>`);
  lines.push(`<mentioned_name_hits_in_text>${boolStr(!!sig.mentioned_name_hits_in_text)}</mentioned_name_hits_in_text>`);
  lines.push(`<mentioned_name_hits_in_summary>${boolStr(!!sig.mentioned_name_hits_in_summary)}</mentioned_name_hits_in_summary>`);
  lines.push(`<senderReplyCountWindow>${
    typeof sig.senderReplyCountWindow === 'number' ? String(sig.senderReplyCountWindow) : ''
  }</senderReplyCountWindow>`);
  lines.push(`<groupReplyCountWindow>${
    typeof sig.groupReplyCountWindow === 'number' ? String(sig.groupReplyCountWindow) : ''
  }</groupReplyCountWindow>`);
  lines.push(`<senderFatigue>${
    typeof sig.senderFatigue === 'number' ? String(sig.senderFatigue) : ''
  }</senderFatigue>`);
  lines.push(`<groupFatigue>${
    typeof sig.groupFatigue === 'number' ? String(sig.groupFatigue) : ''
  }</groupFatigue>`);
  lines.push(`<senderLastReplyAgeSec>${
    typeof sig.senderLastReplyAgeSec === 'number' ? String(sig.senderLastReplyAgeSec) : ''
  }</senderLastReplyAgeSec>`);
  lines.push(`<groupLastReplyAgeSec>${
    typeof sig.groupLastReplyAgeSec === 'number' ? String(sig.groupLastReplyAgeSec) : ''
  }</groupLastReplyAgeSec>`);
  lines.push(`<is_followup_after_bot_reply>${boolStr(!!sig.is_followup_after_bot_reply)}</is_followup_after_bot_reply>`);
  lines.push(`<activeTaskCount>${
    typeof sig.activeTaskCount === 'number' ? String(sig.activeTaskCount) : ''
  }</activeTaskCount>`);
  lines.push('</signals>');

  const pc = payload.policy_config || {};
  lines.push('<policy_config>');
  lines.push(`<mention_must_reply>${boolStr(!!pc.mentionMustReply)}</mention_must_reply>`);
  lines.push(`<followup_window_sec>${
    typeof pc.followupWindowSec === 'number' ? String(pc.followupWindowSec) : ''
  }</followup_window_sec>`);
  const pa = pc.attention || {};
  lines.push('<attention>');
  lines.push(`<enabled>${boolStr(!!pa.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof pa.windowMs === 'number' ? String(pa.windowMs) : ''
  }</window_ms>`);
  lines.push(`<max_senders>${
    typeof pa.maxSenders === 'number' ? String(pa.maxSenders) : ''
  }</max_senders>`);
  lines.push('</attention>');
  const uf = pc.userFatigue || {};
  lines.push('<user_fatigue>');
  lines.push(`<enabled>${boolStr(!!uf.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof uf.windowMs === 'number' ? String(uf.windowMs) : ''
  }</window_ms>`);
  lines.push(`<base_limit>${
    typeof uf.baseLimit === 'number' ? String(uf.baseLimit) : ''
  }</base_limit>`);
  lines.push(`<min_interval_ms>${
    typeof uf.minIntervalMs === 'number' ? String(uf.minIntervalMs) : ''
  }</min_interval_ms>`);
  lines.push(`<backoff_factor>${
    typeof uf.backoffFactor === 'number' ? String(uf.backoffFactor) : ''
  }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${
    typeof uf.maxBackoffMultiplier === 'number' ? String(uf.maxBackoffMultiplier) : ''
  }</max_backoff_multiplier>`);
  lines.push('</user_fatigue>');
  const gf = pc.groupFatigue || {};
  lines.push('<group_fatigue>');
  lines.push(`<enabled>${boolStr(!!gf.enabled)}</enabled>`);
  lines.push(`<window_ms>${
    typeof gf.windowMs === 'number' ? String(gf.windowMs) : ''
  }</window_ms>`);
  lines.push(`<base_limit>${
    typeof gf.baseLimit === 'number' ? String(gf.baseLimit) : ''
  }</base_limit>`);
  lines.push(`<min_interval_ms>${
    typeof gf.minIntervalMs === 'number' ? String(gf.minIntervalMs) : ''
  }</min_interval_ms>`);
  lines.push(`<backoff_factor>${
    typeof gf.backoffFactor === 'number' ? String(gf.backoffFactor) : ''
  }</backoff_factor>`);
  lines.push(`<max_backoff_multiplier>${
    typeof gf.maxBackoffMultiplier === 'number' ? String(gf.maxBackoffMultiplier) : ''
  }</max_backoff_multiplier>`);
  lines.push('</group_fatigue>');
  lines.push('</policy_config>');

  lines.push('<context>');
  const ctx = payload.context || {};
  const groupMsgs = Array.isArray(ctx.group_recent_messages) ? ctx.group_recent_messages : [];
  const senderMsgs = Array.isArray(ctx.sender_recent_messages) ? ctx.sender_recent_messages : [];
  const botMsgs = Array.isArray(ctx.bot_recent_messages) ? ctx.bot_recent_messages : [];

  lines.push('<group_recent_messages>');
  for (const m of groupMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const mtext = m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${escapeXmlText(mid)}</sender_id>`);
    lines.push(`<sender_name>${escapeXmlText(mname)}</sender_name>`);
    lines.push(`<text>${escapeXmlText(mtext)}</text>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</group_recent_messages>');

  lines.push('<sender_recent_messages>');
  for (const m of senderMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const mtext = m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${escapeXmlText(mid)}</sender_id>`);
    lines.push(`<sender_name>${escapeXmlText(mname)}</sender_name>`);
    lines.push(`<text>${escapeXmlText(mtext)}</text>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</sender_recent_messages>');

  lines.push('<bot_recent_messages>');
  for (const m of botMsgs) {
    const mtext = m?.text || '';
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
    lines.push(`<text>${escapeXmlText(mtext)}</text>`);
    lines.push(`<time>${escapeXmlText(mtime)}</time>`);
    lines.push('</message>');
  }
  lines.push('</bot_recent_messages>');
  lines.push('</context>');

  lines.push('<payload_json>');
  lines.push(json);
  lines.push('</payload_json>');
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
export async function planGroupReplyDecision(msg, options = {}) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const signals = options.signals || {};
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
  rdLines.push(
    '    本轮你的任务不是直接生成给用户看的聊天回复，而是在 Sentra 沙盒环境中，根据当前这条消息及其上下文，判断“本轮你是否应该开口参与对话，以及以什么强度参与”。'
  );
  rdLines.push(
    '    你需要综合考虑：这条消息主要是在跟谁说话（是否显式 @ 你、是否用你的昵称/别称直接称呼你）、对话现在在讨论什么、你上一轮是否刚刚发言，以及群聊礼仪和不打扰原则。'
  );
  rdLines.push('    你的最终决策必须通过输出一个 <sentra-tools> 决策调用来表达：');
  rdLines.push('    - 你必须输出且只能输出 1 个 <sentra-tools> 块，并且其中必须包含 1 个 <invoke name="reply_gate_decision">。');
  rdLines.push('    - 该 invoke 必须包含两个参数：');
  rdLines.push('      - <parameter name="enter"><boolean>true|false</boolean></parameter>  表示是否进入主对话/MCP 流程。');
  rdLines.push('      - <parameter name="reason"><string>...</string></parameter>  用 1-2 句自然语言解释原因（内部用，不直接展示给用户）。');
  rdLines.push('    - 当 enter=false 时，表示本轮保持沉默，不进入主对话/MCP 流程。');
  rdLines.push(
    '    在本 root 指令下，你不负责生成正式的用户可见回复内容，也不负责调用工具；你只是做一次“是否需要由你发声、以及是否值得进入完整主对话流程”的价值判断。'
  );
  rdLines.push('  </objective>');

  rdLines.push('  <allow_tools>true</allow_tools>');

  rdLines.push('  <constraints>');
  rdLines.push('    <item>优先遵循平台关于群聊礼仪和不打扰原则：如果没有明确需要你发言的信号，应默认保持安静，而不是对每条群消息都给出评价。</item>');
  rdLines.push('    <item>显式 @ 你（mentioned_by_at=true），或者在文本中用你的昵称/别称以“直接对你说话”的方式提出请求或问题（例如“失语你帮我看看这个报错”“Aphasia 帮我写个脚本”），通常可视为明确点名，如果内容确实需要你的能力支持，应倾向于判定为“值得继续对话”。</item>');
  rdLines.push('    <item>当用户只是以第三人称提到你（例如“刚才失语好可爱”“失语前面那条说得不错”“@其他人：你看失语刚刚说的那个”），一般不要立即认为这是在和你对话；除非上下文明确表明他们正在等待你的进一步回应，否则应更倾向于保持沉默，只在极少数场景下建议用轻量表情/资源参与气氛，而不是长篇发言。</item>');
  rdLines.push('    <item>当 is_followup_after_bot_reply=true 且本条消息在语义上明显是基于你上一轮回答进行的追问、补充条件或指正错误时，应更倾向于认为需要继续对话；但如果只是简单致谢或短促寒暄（如“谢谢”“收到啦”“好耶”），尤其在你近期回复频繁时，可以选择保持沉默，以免刷屏。</item>');
  rdLines.push('    <item>请结合 senderReplyCountWindow / groupReplyCountWindow、senderFatigue / groupFatigue 等信号理解近期负载：在高频场景下，你只有在信号特别明确（显式点名、清晰问题、明显纠错）时才应继续发言；否则应优先选择沉默，或在极少数合适场景下仅以表情/轻量资源旁观。</item>');
  rdLines.push('    <item>如果当前消息主要是群成员之间的闲聊、内部梗、彼此互动，而你介入只会打断气氛或让对话变得机械，请判定为“本轮保持沉默”；只有当你能明显带来信息价值或积极情绪反馈时，才判断为需要参与。</item>');
  rdLines.push('    <item>你在本轮不负责真正写出发给用户看的正式聊天内容，也不负责调用外部工具；你只需通过 reply_gate_decision 的 reason 参数用 1-2 句话解释“为什么进入/不进入主流程”，该原因仅供内部日志与调试使用，不会直接展示给用户。</item>');
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

    const toolDecisionConstraint = [
      '<sentra-protocol>',
      'You MUST output exactly one <sentra-tools> block containing exactly one invoke:',
      '<invoke name="reply_gate_decision"> with parameters enter(boolean) and reason(string).',
      'Do NOT output any user-facing <sentra-response> in this decision task.',
      '</sentra-protocol>'
    ].join('\n');

    const systemContent = [toolDecisionConstraint, systemPrompt, presetContext].filter(Boolean).join('\n\n');
    const conversations = [
      { role: 'system', content: systemContent },
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
        snippet: rawText.slice(0, 500)
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason: 'parse sentra output failed',
        priority: 'normal',
        shouldQuote: false,
        raw: { error: String(e), snippet: rawText.slice(0, 200) }
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
export async function decideOverrideIntent(payload) {
  if (!isReplyInterventionEnabled()) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  try {
    const safePayload = {
      scene: payload?.scene || 'unknown',
      senderId: payload?.senderId || '',
      groupId: payload?.groupId || '',
      prevMessages: Array.isArray(payload?.prevMessages) ? payload.prevMessages.slice(-5) : [],
      newMessage: payload?.newMessage || null
    };

    const lines = [];
    lines.push('<override_decision_input>');
    lines.push(`<scene>${escapeXmlText(safePayload.scene)}</scene>`);
    lines.push(`<sender_id>${escapeXmlText(safePayload.senderId)}</sender_id>`);
    lines.push(`<group_id>${escapeXmlText(safePayload.groupId || '')}</group_id>`);
    lines.push('<prev_messages>');
    for (const m of safePayload.prevMessages) {
      if (!m || (!m.text && !m.summary)) continue;
      const text = m.text || m.summary || '';
      const time = m.time || '';
      lines.push('<message>');
      lines.push(`<text>${escapeXmlText(text)}</text>`);
      lines.push(`<time>${escapeXmlText(time)}</time>`);
      lines.push('</message>');
    }
    lines.push('</prev_messages>');

    const nm = safePayload.newMessage || {};
    const nmText = nm.text || nm.summary || '';
    const nmTime = nm.time || '';
    lines.push('<new_message>');
    lines.push(`<text>${escapeXmlText(nmText)}</text>`);
    lines.push(`<time>${escapeXmlText(nmTime)}</time>`);
    lines.push('</new_message>');
    lines.push('</override_decision_input>');

    const { model, maxTokens } = getDecisionConfig();
    const systemPrompt = await getReplyOverrideSystemPrompt();

    const rdLines = [];
    rdLines.push('<sentra-root-directive>');
    rdLines.push('  <id>override_intent_v1</id>');
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
    rdLines.push(
      '    当系统已经在为该用户执行一个“旧任务”时，你需要判断最新一条消息是否可以视为“改主意 / 换了一个新的主要需求”。'
    );
    rdLines.push(
      '    你的输出不会直接展示给用户，而是作为内部信号：通过是否在 <sentra-response> 中给出非空文本，来暗示是否需要取消旧任务、优先处理这条新消息。'
    );
    rdLines.push('  </objective>');

    rdLines.push('  <constraints>');
    rdLines.push(
      '    <item>如果新消息明确改变或替换了主要需求（例如“算了，帮我改成 XXX”、“不要之前那个了，改成……”），或与旧任务目标明显冲突/取代旧目标，可以认为需要取消旧任务、改为执行最新指令。</item>'
    );
    rdLines.push(
      '    <item>如果新消息只是补充参数、细节或修正错误（例如补充截图、纠正一个字段名、对你的回答作一点反馈），通常不需要取消旧任务。</item>'
    );
    rdLines.push(
      '    <item>如果新消息完全是另一个话题的闲聊或社交内容，且不会影响旧任务的正确性与必要性，可以保持旧任务继续执行。</item>'
    );
    rdLines.push(
      '    <item>当你判断“需要取消旧任务”时，请在 <sentra-response> 中输出一到数条简短的 &lt;textN&gt; 文本，总结核心理由；当你判断“不需要取消”时，请输出一个完全空的 &lt;sentra-response&gt;（不含任何 &lt;textN&gt;、资源或 &lt;emoji&gt; 标签）。</item>'
    );
    rdLines.push('  </constraints>');

    rdLines.push('  <meta>');
    rdLines.push('    <note>下面的 &lt;override_decision_input&gt; 提供了按时间排序的历史消息摘要和最新一条消息文本，仅用于内部改意愿判断。</note>');
    rdLines.push('  </meta>');

    const indentedInput = lines
      .join('\n')
      .split('\n')
      .map((line) => (line ? `  ${line}` : ''))
      .join('\n');
    rdLines.push(indentedInput);
    rdLines.push('</sentra-root-directive>');

    const userContent = rdLines.join('\n');

    const conversations = [
      { role: 'system', content: systemPrompt },
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
      { model, maxTokens },
      groupIdForLog
    );

    if (!result || !result.success || !result.response) {
      const reason = `chatWithRetry failed: ${result?.reason || 'unknown'}`;
      logger.warn('OverrideIntervention: chatWithRetry 返回失败结果，将回退为不取消', {
        reason
      });
      return null;
    }

    const rawText =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');

    let parsed;
    try {
      parsed = parseSentraResponse(rawText);
    } catch (e) {
      logger.warn('OverrideIntervention: 解析 <sentra-response> 失败，将回退为不取消', {
        err: String(e),
        snippet: rawText.slice(0, 500)
      });
      return null;
    }

    if (parsed.shouldSkip) {
      // 空 sentra-response：视为“本轮不建议取消当前任务”
      logger.info('OverrideIntervention: 模型输出空 sentra-response，视为不取消当前任务');
      return null;
    }

    const segments = Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
    const joinedReason = segments
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);

    const relation = 'override';
    const shouldCancel = true;
    const confidence = 0.9;
    const reasonText = joinedReason || '模型判定最新消息代表用户改主意，需要取消当前任务并优先处理该消息';

    logger.info(
      `OverrideIntervention 判定: relation=${relation}, shouldCancel=${shouldCancel}, confidence=${(
        confidence * 100
      ).toFixed(1)}%, reason=${reasonText}`
    );

    return {
      relation,
      shouldCancel,
      confidence,
      reason: reasonText,
      raw: rawText
    };
  } catch (e) {
    logger.warn('OverrideIntervention: 调用 LLM 决策失败，将回退为不取消', { err: String(e) });
    return null;
  }
}

