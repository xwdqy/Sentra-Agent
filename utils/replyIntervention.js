import { Agent } from '../agent.js';
import { createLogger } from './logger.js';

const logger = createLogger('ReplyIntervention');

const ENABLE_REPLY_INTERVENTION = (process.env.ENABLE_REPLY_INTERVENTION || 'true') === 'true';
const REPLY_DECISION_MODEL = process.env.REPLY_DECISION_MODEL || process.env.MAIN_AI_MODEL || 'gpt-4o-mini';
const REPLY_DECISION_MAX_TOKENS = parseInt(process.env.REPLY_DECISION_MAX_TOKENS || '128', 10);

let sharedAgent = null;

function getAgent() {
  if (!ENABLE_REPLY_INTERVENTION) {
    return null;
  }
  if (sharedAgent) {
    return sharedAgent;
  }
  try {
    sharedAgent = new Agent({
      // 复用主站点配置，避免单独维护一套 API_KEY/API_BASE_URL
      apiKey: process.env.API_KEY,
      apiBaseUrl: process.env.API_BASE_URL,
      defaultModel: REPLY_DECISION_MODEL,
      temperature: 0,
      maxTokens: REPLY_DECISION_MAX_TOKENS,
      maxRetries: parseInt(process.env.REPLY_DECISION_MAX_RETRIES || process.env.MAX_RETRIES || '3', 10),
      timeout: parseInt(process.env.REPLY_DECISION_TIMEOUT || process.env.TIMEOUT || '15000', 10)
    });
    logger.config('ReplyIntervention 初始化', {
      model: REPLY_DECISION_MODEL,
      maxTokens: REPLY_DECISION_MAX_TOKENS
    });
  } catch (e) {
    logger.error('初始化 ReplyIntervention Agent 失败，将回退为默认必回策略', e);
    sharedAgent = null;
  }
  return sharedAgent;
}

const DECISION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'decide_reply',
      description: 'Decide whether the assistant should reply to this group chat message.',
      parameters: {
        type: 'object',
        properties: {
          should_reply: {
            type: 'boolean',
            description: '是否需要立即由机器人回复本次消息（true/false）'
          },
          reason: {
            type: 'string',
            description: '简要中文原因说明，用于日志，比如：用户在提问 / 只是简单致谢 / 重复内容等'
          },
          confidence: {
            type: 'number',
            description: '本次判断的置信度，0-1 之间的数字',
            minimum: 0,
            maximum: 1
          },
          priority: {
            type: 'string',
            description: '回复优先级：high/normal/low',
            enum: ['high', 'normal', 'low']
          },
          should_quote: {
            type: 'boolean',
            description: '是否建议使用引用回复（如果平台支持）'
          }
        },
        required: ['should_reply', 'reason', 'confidence']
      }
    }
  }
];

const DEDUP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'decide_send_dedup',
      description: 'Judge whether the candidate reply text makes the base reply text redundant for the same conversation.',
      parameters: {
        type: 'object',
        properties: {
          are_similar: {
            type: 'boolean',
            description: 'true if the two replies express essentially the same meaning and the earlier one can be dropped.'
          },
          similarity: {
            type: 'number',
            description: 'Optional similarity score between 0 and 1 (higher = more similar).',
            minimum: 0,
            maximum: 1
          },
          reason: {
            type: 'string',
            description: 'Short English or Chinese explanation of why they are or are not considered duplicates.'
          }
        },
        required: ['are_similar']
      }
    }
  }
];

const OVERRIDE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'decide_override',
      description: '判断新消息与之前消息之间的关系，以及是否需要取消当前正在执行的旧任务。',
      parameters: {
        type: 'object',
        properties: {
          relation: {
            type: 'string',
            description: '新消息与之前消息之间的语义关系：override=改主意/重写、append=补充信息、refine=细化/修正、unrelated=无关新话题',
            enum: ['override', 'append', 'refine', 'unrelated']
          },
          should_cancel: {
            type: 'boolean',
            description: '是否建议取消当前正在执行的旧任务（true/false）'
          },
          reason: {
            type: 'string',
            description: '简短中文说明，例如："用户将地点从上海改为北京"'
          },
          confidence: {
            type: 'number',
            description: '判断置信度（0-1）',
            minimum: 0,
            maximum: 1
          }
        },
        required: ['relation', 'should_cancel', 'confidence']
      }
    }
  }
];

const SYSTEM_PROMPT = [
  '<role>reply_decision_classifier</role>',
  '<task>',
  '  Decide whether the QQ assistant should reply to the current message.',
  '  You never generate natural language chat replies for the user; you only output a structured Sentra XML decision.',
  '</task>',
  '<input_format>',
  '  The user message will contain exactly one <decision_input> block with structured fields.',
  '  Structure:',
  '  <decision_input>',
  '    <scene>group | private | unknown</scene>',
  '    <sender>',
  '      <id>sender_id string</id>',
  '      <name>sender_name string</name>',
  '    </sender>',
  '    <group_id>group_id string or empty for private chats</group_id>',
  '    <message>',
  '      <text>raw user text (may be empty)</text>',
  '      <summary>platform summary text (may be empty)</summary>',
  '    </message>',
  '    <message_features>',
  '      <text_length>length of message.text in characters</text_length>',
  '      <summary_length>length of message.summary in characters</summary_length>',
  '      <has_question_mark>true | false</has_question_mark>',
  '      <has_url>true | false</has_url>',
  '      <has_at_symbol>true | false</has_at_symbol>',
  '    </message_features>',
  '    <signals>',
  '      <is_group>true | false</is_group>',
  '      <is_private>true | false</is_private>',
  '      <mentioned_by_at>true | false</mentioned_by_at>',
  '      <mentioned_by_name>true | false</mentioned_by_name>',
  '      <mentioned_names>zero or more matched bot names</mentioned_names>',
  '      <senderReplyCountWindow>number</senderReplyCountWindow>',
  '      <groupReplyCountWindow>number</groupReplyCountWindow>',
  '      <senderFatigue>float between 0 and 1</senderFatigue>',
  '      <groupFatigue>float between 0 and 1</groupFatigue>',
  '      <senderLastReplyAgeSec>number or empty</senderLastReplyAgeSec>',
  '      <groupLastReplyAgeSec>number or empty</groupLastReplyAgeSec>',
  '      <is_followup_after_bot_reply>true | false</is_followup_after_bot_reply>',
  '      <activeTaskCount>number of currently active tasks for this sender</activeTaskCount>',
  '    </signals>',
  '    <policy_config>',
  '      <mention_must_reply>true | false</mention_must_reply>',
  '      <followup_window_sec>number of seconds counted as follow-up after last bot reply</followup_window_sec>',
  '      <attention>',
  '        <enabled>true | false</enabled>',
  '        <window_ms>time window in ms during which attention window applies</window_ms>',
  '        <max_senders>max distinct senders allowed in attention window</max_senders>',
  '      </attention>',
  '      <user_fatigue>',
  '        <enabled>true | false</enabled>',
  '        <window_ms>rolling window in ms for counting user replies</window_ms>',
  '        <base_limit>baseline allowed replies in the window</base_limit>',
  '        <min_interval_ms>minimum interval before backoff</min_interval_ms>',
  '        <backoff_factor>backoff growth factor</backoff_factor>',
  '        <max_backoff_multiplier>max backoff multiplier</max_backoff_multiplier>',
  '      </user_fatigue>',
  '      <group_fatigue>',
  '        <enabled>true | false</enabled>',
  '        <window_ms>rolling window in ms for counting group replies</window_ms>',
  '        <base_limit>baseline allowed replies in the window</base_limit>',
  '        <min_interval_ms>minimum interval before backoff</min_interval_ms>',
  '        <backoff_factor>backoff growth factor</backoff_factor>',
  '        <max_backoff_multiplier>max backoff multiplier</max_backoff_multiplier>',
  '      </group_fatigue>',
  '    </policy_config>',
  '    <context>',
  '      <group_recent_messages>',
  '        <!-- ordered from oldest to newest -->',
  '        <message>',
  '          <sender_id>string</sender_id>',
  '          <sender_name>string</sender_name>',
  '          <text>string</text>',
  '          <time>string</time>',
  '        </message>',
  '        ...',
  '      </group_recent_messages>',
  '      <sender_recent_messages>',
  '        <message>',
  '          <sender_id>string</sender_id>',
  '          <sender_name>string</sender_name>',
  '          <text>string</text>',
  '          <time>string</time>',
  '        </message>',
  '        ...',
  '      </sender_recent_messages>',
  '    </context>',
  '    <payload_json>{...full JSON mirror of the same data...}</payload_json>',
  '  </decision_input>',
  '</input_format>',
  '<decision_rules>',
  '  <rule id="1">Focus mainly on scene="group". For private chats you can still make a best-effort decision.</rule>',
  '  <rule id="2">Use the mention signals with strict priority: mentioned_by_at (explicit @) has the highest priority; mentioned_by_name (name mention) is next; messages without any mention have the lowest priority.</rule>',
  '  <rule id="3">For messages with mentioned_by_at=true, you should almost always set should_reply=true, unless the content is clearly not asking the assistant to act (pure jokes about the bot, spam, or obviously irrelevant). Treat explicit @ as the strongest intent signal.</rule>',
  '  <rule id="4">For messages with mentioned_by_name=true (but no explicit @), you should usually prefer should_reply=true when there is a reasonable chance the user is addressing the assistant, especially when there is a question or instruction.</rule>',
  '  <rule id="5">For messages without any mention, you should be conservative: rely on message_features (has_question_mark, text_length, has_url) and recent history to reply only when there is a clear question, request, or instruction.</rule>',
  '  <rule id="6">If the current message or recent sender messages contain a clear question, request, or instruction for the assistant, then should_reply=true, especially when is_followup_after_bot_reply is true.</rule>',
  '  <rule id="7">If the content is only emojis, very short acknowledgements ("ok", "thanks", "got it", "done"), laughter ("哈哈", "lol"), or obvious low-information chatter, then should_reply=false, unless there is a strong mention signal that clearly requires a response.</rule>',
  '  <rule id="8a">When is_followup_after_bot_reply is true, use sender_recent_messages to detect if the user is continuing the same topic (follow-up question, extra constraints, parameter changes, corrections).</rule>',
  '  <rule id="8b">If it is a continuation of the same topic, prefer should_reply=true even when there is no explicit @ mention.</rule>',
  '  <rule id="8c">Only choose should_reply=false in follow-up mode when the message clearly closes the conversation (pure thanks, confirmation, or obvious closure).</rule>',
  '  <rule id="9">Higher senderFatigue / groupFatigue means you should filter out low-value messages more aggressively, but still reply to clear questions or important requests. Treat fatigue scores and policy_config as soft guidance, not hard cutoffs.</rule>',
  '</decision_rules>',
  '<output_requirements>',
  '  You must output exactly one <sentra-reply-decision> XML block and nothing else (no markdown, no chat text).',
  '  Strict XML structure:',
  '  <sentra-reply-decision>',
  '    <should_reply>true|false</should_reply>',
  '    <confidence>0.0-1.0</confidence>',
  '    <priority>high|normal|low</priority>',
  '    <should_quote>true|false</should_quote>',
  '    <reason>Short explanation in Chinese or English describing the main factors in your decision.</reason>',
  '  </sentra-reply-decision>',
  '  - Do not output <sentra-response> or any other Sentra protocol tags here.',
  '  - Do not wrap the XML in markdown code fences.',
  '</output_requirements>'
].join('\n');
const DEDUP_SYSTEM_PROMPT = [
  '<role>send_dedup_judge</role>',
  '<task>',
  '  Given two candidate reply texts A (base) and B (candidate) for the same conversation,',
  '  decide whether B makes A redundant from the user\'s perspective.',
  '</task>',
  '<guidelines>',
  '  - Treat A as an earlier reply that would be sent first.',
  '  - Treat B as a later reply that could replace A.',
  '  - If B clearly covers the key information, tone and intent of A (even with slightly different wording),',
  '    they are considered duplicates and A can be dropped.',
  '  - If A and B contain different facts, different suggestions, or complementary content,',
  '    they are NOT duplicates and both may be sent.',
  '  - Small wording differences, extra emojis, or short compliments do NOT prevent them from being duplicates.',
  '</guidelines>',
  '<output>',
  '  You must call the decide_send_dedup tool with:',
  '  - are_similar=true if B makes A redundant;',
  '  - are_similar=false otherwise;',
  '  - optional similarity in [0,1];',
  '  - a short reason.',
  '</output>'
].join('\n');

function escapeXmlText(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractFirstTagBlock(text, tagName) {
  if (!text) return null;
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
  const m = text.match(re);
  return m ? m[0] : null;
}

function extractTagText(xml, tagName) {
  if (!xml) return '';
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function parseReplyDecisionXml(text) {
  const xml = extractFirstTagBlock(text, 'sentra-reply-decision');
  if (!xml) {
    return { error: 'missing <sentra-reply-decision> block' };
  }

  const boolFrom = (raw) => {
    if (raw == null) return null;
    const t = String(raw).trim().toLowerCase();
    if (!t) return null;
    if (['true', '1', 'yes', 'y', 'reply'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'skip'].includes(t)) return false;
    return null;
  };

  const shouldReplyRaw = extractTagText(xml, 'should_reply');
  const shouldReply = boolFrom(shouldReplyRaw);
  if (shouldReply === null) {
    return { error: 'invalid or missing <should_reply> (expect true/false)' };
  }

  const confRaw = extractTagText(xml, 'confidence');
  let confidence = 1.0;
  if (confRaw) {
    const n = parseFloat(confRaw);
    if (!Number.isNaN(n)) {
      confidence = Math.min(1, Math.max(0, n));
    }
  } else if (!shouldReply) {
    confidence = 0.0;
  }

  const priorityRaw = extractTagText(xml, 'priority');
  let priority = 'normal';
  if (priorityRaw) {
    const p = String(priorityRaw).trim().toLowerCase();
    if (p === 'high' || p === 'low' || p === 'normal') {
      priority = p;
    }
  }

  const shouldQuoteRaw = extractTagText(xml, 'should_quote');
  const shouldQuote = !!boolFrom(shouldQuoteRaw);

  const reasonRaw = extractTagText(xml, 'reason');
  const reason = reasonRaw || (shouldReply ? '模型判定需要回复' : '模型判定无需回复');

  return {
    error: null,
    shouldReply,
    confidence,
    priority,
    shouldQuote,
    reason
  };
}

function parseOverrideDecisionXml(text) {
  const xml = extractFirstTagBlock(text, 'sentra-override-decision');
  if (!xml) {
    return { error: 'missing <sentra-override-decision> block' };
  }

  const boolFrom = (raw) => {
    if (raw == null) return null;
    const t = String(raw).trim().toLowerCase();
    if (!t) return null;
    if (['true', '1', 'yes', 'y'].includes(t)) return true;
    if (['false', '0', 'no', 'n'].includes(t)) return false;
    return null;
  };

  const shouldCancelRaw = extractTagText(xml, 'should_cancel');
  const shouldCancel = boolFrom(shouldCancelRaw);
  if (shouldCancel === null) {
    return { error: 'invalid or missing <should_cancel> (expect true/false)' };
  }

  const relationRaw = extractTagText(xml, 'relation');
  let relation = 'append';
  if (relationRaw) {
    const r = String(relationRaw).trim().toLowerCase();
    if (['override', 'append', 'refine', 'unrelated'].includes(r)) {
      relation = r;
    }
  }

  const confRaw = extractTagText(xml, 'confidence');
  let confidence = 0.8;
  if (confRaw) {
    const n = parseFloat(confRaw);
    if (!Number.isNaN(n)) {
      confidence = Math.min(1, Math.max(0, n));
    }
  }

  const reasonRaw = extractTagText(xml, 'reason');
  const reason = reasonRaw || (shouldCancel ? '模型判定需要取消当前任务' : '模型判定保留当前任务');

  return {
    error: null,
    relation,
    shouldCancel,
    confidence,
    reason
  };
}

function buildUserPayload(msg, extraSignals = {}, context = null, policyConfig = null) {
  const scene = msg?.type || 'unknown';
  const text = typeof msg?.text === 'string' ? msg.text : '';
  const summary = typeof msg?.summary === 'string' ? msg.summary : '';

  const payload = {
    scene,
    sender_id: String(msg?.sender_id ?? ''),
    sender_name: msg?.sender_name || '',
    group_id: msg?.group_id ?? null,
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

  const fullText = text || '';
  const fullSummary = summary || '';
  const messageFeatures = {
    text_length: fullText.length,
    summary_length: fullSummary.length,
    has_question_mark: /[?？]/.test(fullText),
    has_url: /(https?:\/\/|www\.)/i.test(fullText),
    has_at_symbol: /@/.test(fullText)
  };
  payload.message_features = messageFeatures;

  if (policyConfig && typeof policyConfig === 'object') {
    payload.policy_config = policyConfig;
  }

  const json = JSON.stringify(payload);

  const lines = [];
  lines.push('<decision_input>');
  lines.push(`<scene>${scene}</scene>`);
  lines.push('<sender>');
  lines.push(`<id>${payload.sender_id}</id>`);
  lines.push(`<name>${payload.sender_name}</name>`);
  lines.push('</sender>');
  lines.push(`<group_id>${payload.group_id ?? ''}</group_id>`);
  lines.push('<message>');
  lines.push(`<text>${text}</text>`);
  lines.push(`<summary>${summary}</summary>`);
  lines.push('</message>');
  const boolStr = (v) => (v ? 'true' : 'false');

  const mf = payload.message_features || messageFeatures;
  lines.push('<message_features>');
  lines.push(`<text_length>${
    typeof mf.text_length === 'number' ? String(mf.text_length) : ''
  }</text_length>`);
  lines.push(`<summary_length>${
    typeof mf.summary_length === 'number' ? String(mf.summary_length) : ''
  }</summary_length>`);
  lines.push(`<has_question_mark>${boolStr(!!mf.has_question_mark)}</has_question_mark>`);
  lines.push(`<has_url>${boolStr(!!mf.has_url)}</has_url>`);
  lines.push(`<has_at_symbol>${boolStr(!!mf.has_at_symbol)}</has_at_symbol>`);
  lines.push('</message_features>');

  const sig = payload.signals || {};

  lines.push('<signals>');
  lines.push(`<is_group>${boolStr(sig.is_group)}</is_group>`);
  lines.push(`<is_private>${boolStr(sig.is_private)}</is_private>`);
  lines.push(`<mentioned_by_at>${boolStr(!!sig.mentioned_by_at)}</mentioned_by_at>`);
  lines.push(`<mentioned_by_name>${boolStr(!!sig.mentioned_by_name)}</mentioned_by_name>`);
  const names = Array.isArray(sig.mentioned_names) ? sig.mentioned_names.join(',') : '';
  lines.push(`<mentioned_names>${names}</mentioned_names>`);
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

  lines.push('<group_recent_messages>');
  for (const m of groupMsgs) {
    const mid = m?.sender_id != null ? String(m.sender_id) : '';
    const mname = m?.sender_name || '';
    const mtext = m?.text || '';
    const mtime = m?.time || '';
    lines.push('<message>');
    lines.push(`<sender_id>${mid}</sender_id>`);
    lines.push(`<sender_name>${mname}</sender_name>`);
    lines.push(`<text>${mtext}</text>`);
    lines.push(`<time>${mtime}</time>`);
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
    lines.push(`<sender_id>${mid}</sender_id>`);
    lines.push(`<sender_name>${mname}</sender_name>`);
    lines.push(`<text>${mtext}</text>`);
    lines.push(`<time>${mtime}</time>`);
    lines.push('</message>');
  }
  lines.push('</sender_recent_messages>');
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
  if (!ENABLE_REPLY_INTERVENTION) {
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
    senderReplyCountWindow: typeof signals.senderReplyCountWindow === 'number' ? signals.senderReplyCountWindow : 0,
    groupReplyCountWindow: typeof signals.groupReplyCountWindow === 'number' ? signals.groupReplyCountWindow : 0,
    senderFatigue: typeof signals.senderFatigue === 'number' ? signals.senderFatigue : 0,
    groupFatigue: typeof signals.groupFatigue === 'number' ? signals.groupFatigue : 0,
    senderLastReplyAgeSec: typeof signals.senderLastReplyAgeSec === 'number' ? signals.senderLastReplyAgeSec : null,
    groupLastReplyAgeSec: typeof signals.groupLastReplyAgeSec === 'number' ? signals.groupLastReplyAgeSec : null,
    is_followup_after_bot_reply: !!signals.isFollowupAfterBotReply
  };

  const userContent = buildUserPayload(msg, extraSignals, options.context || null, options.policy || null);

  try {
    const raw = await agent.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      {
        model: REPLY_DECISION_MODEL,
        temperature: 0.1,
        maxTokens: REPLY_DECISION_MAX_TOKENS
      }
    );

    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    const parsed = parseReplyDecisionXml(text);

    if (parsed.error) {
      logger.warn('ReplyIntervention: XML 决策解析失败，将默认判定为无需回复', {
        err: parsed.error,
        snippet: text.slice(0, 500)
      });
      return {
        shouldReply: false,
        confidence: 0.0,
        reason: `XML decision parse failed: ${parsed.error}`,
        priority: 'normal',
        shouldQuote: false,
        raw: { error: parsed.error, snippet: text.slice(0, 200) }
      };
    }

    const { shouldReply, confidence, reason, priority, shouldQuote } = parsed;

    logger.info(
      `ReplyIntervention 判定: shouldReply=${shouldReply}, confidence=${(confidence * 100).toFixed(1)}%, priority=${priority}, reason=${reason}`
    );

    return {
      shouldReply,
      confidence,
      reason,
      priority,
      shouldQuote,
      raw: text
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

export async function decideSendDedupPair(baseText, candidateText) {
  if (!ENABLE_REPLY_INTERVENTION) {
    return null;
  }

  const agent = getAgent();
  if (!agent) {
    return null;
  }

  const a = (baseText || '').trim();
  const b = (candidateText || '').trim();
  if (!a || !b) {
    return null;
  }

  const userContent = [
    '<send_dedup_input>',
    '<base_text>',
    escapeXmlText(a),
    '</base_text>',
    '<candidate_text>',
    escapeXmlText(b),
    '</candidate_text>',
    '</send_dedup_input>'
  ].join('\n');

  try {
    const result = await agent.chat(
      [
        { role: 'system', content: DEDUP_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      {
        model: REPLY_DECISION_MODEL,
        temperature: 0,
        tools: DEDUP_TOOLS,
        tool_choice: { type: 'function', function: { name: 'decide_send_dedup' } }
      }
    );

    if (!result || typeof result !== 'object') {
      logger.warn('SendDedup: 工具返回结果不是对象，将回退为仅基于向量相似度判断');
      return null;
    }

    const areSimilar = !!result.are_similar;
    let similarity = null;
    if (typeof result.similarity === 'number' && !Number.isNaN(result.similarity)) {
      similarity = Math.max(0, Math.min(1, result.similarity));
    }
    const reason = typeof result.reason === 'string' ? result.reason : '';

    return { areSimilar, similarity, reason };
  } catch (e) {
    logger.warn('SendDedup: 调用 LLM 决策失败，将回退为仅基于向量相似度判断', { err: String(e) });
    return null;
  }
}

const OVERRIDE_SYSTEM_PROMPT = [
  '<role>override_intent_classifier</role>',
  '<task>',
  '  Decide the semantic relationship between a new user message and recent previous messages,',
  '  and whether the assistant should cancel the currently running task for that user.',
  '  You never generate chat replies for the user; you only output a structured Sentra XML decision.',
  '</task>',
  '<input_format>',
  '  You will receive exactly one <override_decision_input> block.',
  '  Structure:',
  '  <override_decision_input>',
  '    <scene>group | private | unknown</scene>',
  '    <sender_id>string</sender_id>',
  '    <group_id>string or empty</group_id>',
  '    <prev_messages>',
  '      <!-- ordered from oldest to newest -->',
  '      <message>',
  '        <text>string</text>',
  '        <time>string</time>',
  '      </message>',
  '      ...',
  '    </prev_messages>',
  '    <new_message>',
  '      <text>string</text>',
  '      <time>string</time>',
  '    </new_message>',
  '  </override_decision_input>',
  '</input_format>',
  '<relation_definitions>',
  '  <relation id="override">The new message explicitly changes or replaces the main request, so the old task is no longer needed.</relation>',
  '  <relation id="append">The new message adds extra requirements or parameters, while the original intent still stands.</relation>',
  '  <relation id="refine">The new message refines, corrects, or clarifies details of the existing request.</relation>',
  '  <relation id="unrelated">The new message is about a different topic and does not depend on the previous request.</relation>',
  '</relation_definitions>',
  '<decision_principles>',
  '  - When relation=override and the new request conflicts with or replaces the old one, usually should_cancel=true (cancel old task).',
  '  - When relation=append or refine, usually should_cancel=false (keep the task and incorporate new information).',
  '  - When relation=unrelated:',
  '    - If the system is likely processing only one task per user at a time, and the old task is still running,',
  '      you may set should_cancel=true to prioritize the latest request.',
  '</decision_principles>',
  '<output_requirements>',
  '  You must output exactly one <sentra-override-decision> XML block and nothing else (no markdown, no explanations outside XML).',
  '  Strict XML structure:',
  '  <sentra-override-decision>',
  '    <should_cancel>true|false</should_cancel>',
  '    <relation>override|append|refine|unrelated</relation>',
  '    <reason>Short explanation in Chinese or English describing your decision.</reason>',
  '    <confidence>0.0-1.0 (optional, omit if unsure)</confidence>',
  '  </sentra-override-decision>',
  '  - Do not wrap the XML in markdown code fences.',
  '  - Do not output any natural language chat outside the XML block.',
  '</output_requirements>'
].join('\n');

export async function decideOverrideIntent(payload) {
  if (!ENABLE_REPLY_INTERVENTION) {
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

    const userContent = lines.join('\n');

    const raw = await agent.chat(
      [
        { role: 'system', content: OVERRIDE_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      {
        model: REPLY_DECISION_MODEL,
        temperature: 0,
        maxTokens: 128
      }
    );

    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    const parsed = parseOverrideDecisionXml(text);

    if (parsed.error) {
      logger.warn('OverrideIntervention: XML 决策解析失败，将回退为不取消', {
        err: parsed.error,
        snippet: text.slice(0, 500)
      });
      return null;
    }

    const { relation, shouldCancel, confidence, reason } = parsed;

    logger.info(
      `OverrideIntervention 判定: relation=${relation}, shouldCancel=${shouldCancel}, confidence=${(confidence * 100).toFixed(1)}%, reason=${reason}`
    );

    return {
      relation,
      shouldCancel,
      confidence,
      reason,
      raw: text
    };
  } catch (e) {
    logger.warn('OverrideIntervention: 调用 LLM 决策失败，将回退为不取消', { err: String(e) });
    return null;
  }
}

