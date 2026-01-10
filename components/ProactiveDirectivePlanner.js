import { Agent } from '../agent.js';
import { createLogger } from '../utils/logger.js';
import { getEnv, getEnvInt } from '../utils/envHotReloader.js';
import { parseSentraResponse } from '../utils/protocolUtils.js';
import { escapeXml, appendXmlBlockLines, appendConstraintsBlock } from '../utils/xmlUtils.js';
import { chatWithRetry as chatWithRetryCore } from './ChatWithRetry.js';
import { initAgentPresetCore } from './AgentPresetInitializer.js';
import sentraPrompts from 'sentra-prompts';

const logger = createLogger('ProactiveDirectivePlanner');

function toBool(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return false;
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function parseIdList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return new Set();
  const items = s
    .split(',')
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  const out = new Set();
  for (const it of items) {
    const normalized = String(it).replace(/^(G:|U:)/i, '').trim();
    if (!normalized) continue;
    const num = Number(normalized);
    if (Number.isFinite(num) && num > 0) {
      out.add(String(Math.trunc(num)));
    } else {
      const digits = normalized.replace(/\D+/g, '');
      if (digits) out.add(digits);
    }
  }
  return out;
}

let cachedProactiveWhitelistGroupsRaw = null;
let cachedProactiveWhitelistUsersRaw = null;
let cachedProactiveWhitelistGroups = new Set();
let cachedProactiveWhitelistUsers = new Set();

function getProactiveWhitelistGroups() {
  const raw = getEnv('PROACTIVE_WHITELIST_GROUPS', '');
  if (raw !== cachedProactiveWhitelistGroupsRaw) {
    cachedProactiveWhitelistGroupsRaw = raw;
    cachedProactiveWhitelistGroups = parseIdList(raw);
  }
  return cachedProactiveWhitelistGroups;
}

function getProactiveWhitelistUsers() {
  const raw = getEnv('PROACTIVE_WHITELIST_USERS', '');
  if (raw !== cachedProactiveWhitelistUsersRaw) {
    cachedProactiveWhitelistUsersRaw = raw;
    cachedProactiveWhitelistUsers = parseIdList(raw);
  }
  return cachedProactiveWhitelistUsers;
}

function getProactiveWhitelistLogFiltered() {
  return toBool(getEnv('PROACTIVE_LOG_FILTERED', 'false'));
}

export function isProactiveWhitelistConfigured() {
  const groups = getProactiveWhitelistGroups();
  const users = getProactiveWhitelistUsers();
  return groups.size > 0 || users.size > 0;
}

export function checkProactiveWhitelistTarget(payload = {}) {
  const {
    chatType = 'group',
    groupId = null,
    userId = null
  } = payload || {};

  const groups = getProactiveWhitelistGroups();
  const users = getProactiveWhitelistUsers();
  const logFiltered = getProactiveWhitelistLogFiltered();
  const configured = groups.size > 0 || users.size > 0;

  if (!configured) {
    return {
      allowed: false,
      reason: 'proactive_whitelist_empty',
      logFiltered,
      chatType,
      groupId,
      userId
    };
  }

  const ct = chatType === 'private' ? 'private' : 'group';

  if (ct === 'private') {
    const uid = userId != null ? String(userId).replace(/^(U:)/i, '').trim() : '';
    const key = uid && Number.isFinite(Number(uid)) ? String(Math.trunc(Number(uid))) : uid;
    if (!key) {
      return {
        allowed: false,
        reason: 'missing_user_id',
        logFiltered,
        chatType: ct,
        groupId,
        userId
      };
    }
    if (!users.has(key)) {
      return {
        allowed: false,
        reason: 'user_not_in_proactive_whitelist',
        logFiltered,
        chatType: ct,
        groupId,
        userId: key
      };
    }
    return {
      allowed: true,
      reason: 'ok',
      logFiltered,
      chatType: ct,
      groupId,
      userId: key
    };
  }

  const gid = groupId != null ? String(groupId).replace(/^(G:)/i, '').trim() : '';
  const gkey = gid && Number.isFinite(Number(gid)) ? String(Math.trunc(Number(gid))) : gid;
  if (!gkey) {
    return {
      allowed: false,
      reason: 'missing_group_id',
      logFiltered,
      chatType: ct,
      groupId,
      userId
    };
  }
  if (!groups.has(gkey)) {
    return {
      allowed: false,
      reason: 'group_not_in_proactive_whitelist',
      logFiltered,
      chatType: ct,
      groupId: gkey,
      userId
    };
  }
  return {
    allowed: true,
    reason: 'ok',
    logFiltered,
    chatType: ct,
    groupId: gkey,
    userId
  };
}

function getPlannerConfig() {
  const model = getEnv('PROACTIVE_DIRECTIVE_MODEL', 'gpt-4.1-mini');
  const maxTokens = getEnvInt('PROACTIVE_DIRECTIVE_MAX_TOKENS', 4096);
  const timeout = getEnvInt('PROACTIVE_DIRECTIVE_TIMEOUT', 60000);
  const maxRetries = getEnvInt('PROACTIVE_DIRECTIVE_MAX_RETRIES', 3);
  return { model, maxTokens, timeout, maxRetries };
}

let sharedAgent = null;
let cachedSystemPrompt = null;
let cachedPlannerPresetXml = null;
let plannerPresetInitPromise = null;

function getPlannerAgent() {
  if (sharedAgent) return sharedAgent;
  try {
    const { model, maxTokens, timeout, maxRetries } = getPlannerConfig();
    sharedAgent = new Agent({
      apiKey: getEnv('API_KEY'),
      apiBaseUrl: getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'),
      defaultModel: model,
      temperature: 0.2,
      maxTokens,
      maxRetries,
      timeout
    });
    if (typeof logger.config === 'function') {
      logger.config('ProactiveDirectivePlanner 初始化', { model, maxTokens });
    } else {
      logger.info(`ProactiveDirectivePlanner 初始化: model=${model}, maxTokens=${maxTokens}`);
    }
  } catch (e) {
    logger.warn('初始化 ProactiveDirectivePlanner 失败，将回退为默认 objective', { err: String(e) });
    sharedAgent = null;
  }
  return sharedAgent;
}

async function getPlannerAgentPresetXml() {
  if (cachedPlannerPresetXml !== null) {
    return cachedPlannerPresetXml;
  }

  if (!plannerPresetInitPromise) {
    plannerPresetInitPromise = (async () => {
      try {
        const agent = getPlannerAgent && typeof getPlannerAgent === 'function' ? getPlannerAgent() : null;
        const snapshot = await initAgentPresetCore(agent || null);
        const xml = snapshot && typeof snapshot.xml === 'string' ? snapshot.xml.trim() : '';
        cachedPlannerPresetXml = xml || '';
        if (cachedPlannerPresetXml) {
          logger.info('ProactiveDirectivePlanner: 已加载 Agent 预设 XML 用于主动规划');
        }
        return cachedPlannerPresetXml;
      } catch (e) {
        logger.warn('ProactiveDirectivePlanner: 加载 Agent 预设失败，将不注入人设 XML', { err: String(e) });
        cachedPlannerPresetXml = '';
        return cachedPlannerPresetXml;
      }
    })();
  }

  return plannerPresetInitPromise;
}

function extractObjectiveFromRawReply(text) {
	if (!text || typeof text !== 'string') return null;

	const trimmed = text.trim();
	if (!trimmed) return null;

	const hasSentraTag = trimmed.includes('<sentra-response>');

	// 优先走标准协议解析路径（包含 <sentra-response> 时）
	if (hasSentraTag) {
		try {
			const parsed = parseSentraResponse(trimmed);
			if (!parsed || !Array.isArray(parsed.textSegments)) return null;
			const segments = parsed.textSegments
				.map((s) => (s || '').trim())
				.filter(Boolean);
			if (segments.length === 0) return null;
			const joined = segments.join('\n');
			const plain = joined.replace(/\s+/g, '');
			if (plain.length < 6) return null;
			return joined;
		} catch (e) {
			logger.warn('ProactiveDirectivePlanner: 解析 sentra-response 失败，将尝试使用原文作为 objective', {
				err: String(e)
			});
		}
	}

	// 无协议标签或解析失败：不使用原文作为 objective，避免把旁白/英文垃圾引入主动规划
	return null;
}

async function getPlannerSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;

  try {
    const template = '{{sandbox_system_prompt}}\n\n{{qq_system_prompt}}';
    const base = await sentraPrompts(template);
    if (base && typeof base === 'string') {
      cachedSystemPrompt = base;
    }
  } catch (e) {
    logger.warn(
      'ProactiveDirectivePlanner: 通过 sentra-prompts 构建基础系统提示失败，将回退为空系统提示',
      {
        err: String(e)
      }
    );
  }

  if (!cachedSystemPrompt) {
    cachedSystemPrompt = '';
  }

  return cachedSystemPrompt;
}

async function buildTimeContext() {
  const tz = getEnv('CONTEXT_MEMORY_TIMEZONE', 'Asia/Shanghai');

  const template = {
    dateStr: '{{date}}',
    timeStr: '{{time_24}}',
    weekday: '{{weekday}}',
    holidayHint: '{{holiday}}',
    isWeekend: '{{is_weekend}}',
    isWorkday: '{{is_workday}}',
    hour: '{{current_hour}}',
    month: '{{month}}',
    day: '{{day}}',
    timeContext: '{{time_context}}'
  };

  try {
    const parsed = await sentraPrompts.parseObj(template);

    const hourNum = Number.parseInt(parsed.hour, 10);
    const monthNum = Number.parseInt(parsed.month, 10);
    const dayNum = Number.parseInt(parsed.day, 10);
    const isWeekend = toBool(parsed.isWeekend);
    const timeOfDay = parsed.timeContext || '';

    return {
      dateStr: parsed.dateStr || '',
      timeStr: parsed.timeStr || '',
      weekday: parsed.weekday || '',
      hour: Number.isFinite(hourNum) ? hourNum : new Date().getHours(),
      month: Number.isFinite(monthNum) ? monthNum : new Date().getMonth() + 1,
      day: Number.isFinite(dayNum) ? dayNum : new Date().getDate(),
      isWeekend,
      timeOfDay,
      holidayHint: parsed.holidayHint || null,
      isWorkday: toBool(parsed.isWorkday),
      timezone: tz
    };
  } catch (e) {
    logger.warn('ProactiveDirectivePlanner: 通过 sentra-prompts 获取时间/节假日信息失败，将使用本地时间作为回退', { err: String(e) });
  }

  const now = new Date();

  let dateStr = now.toISOString().slice(0, 10);
  let timeStr = now.toTimeString().slice(0, 5);
  let weekday = '';
  try {
    const fmtDate = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const fmtTime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit'
    });
    const fmtWeekday = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      weekday: 'long'
    });
    dateStr = fmtDate.format(now);
    timeStr = fmtTime.format(now);
    weekday = fmtWeekday.format(now);
  } catch {}

  const hour = now.getHours();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const dow = now.getDay();
  const isWeekend = dow === 0 || dow === 6;

  return {
    dateStr,
    timeStr,
    weekday,
    hour,
    month,
    day,
    isWeekend,
    timeOfDay: '',
    holidayHint: null,
    isWorkday: null,
    timezone: tz
  };
}

function formatLocalDateTime(ms, timezone) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const tz = timezone || getEnv('CONTEXT_MEMORY_TIMEZONE', 'Asia/Shanghai');
  try {
    const d = new Date(ms);
    const fmtDate = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const fmtTime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const dateStr = fmtDate.format(d);
    const timeStr = fmtTime.format(d);
    return `${dateStr} ${timeStr}`;
  } catch {
    return null;
  }
}

function buildPendingMessagesXmlFromContext(conversationContext) {
  if (!conversationContext || typeof conversationContext !== 'object') return '';

  const groupMsgs = Array.isArray(conversationContext.group_recent_messages)
    ? conversationContext.group_recent_messages
    : [];
  const senderMsgs = Array.isArray(conversationContext.sender_recent_messages)
    ? conversationContext.sender_recent_messages
    : [];

  const merged = [];
  const pushList = (arr) => {
    for (const m of arr) {
      if (!m || typeof m !== 'object') continue;
      merged.push(m);
    }
  };

  pushList(groupMsgs);
  pushList(senderMsgs);

  if (merged.length === 0) return '';

  const lines = [];
  lines.push('<sentra-pending-messages>');
  lines.push(`  <total_count>${merged.length}</total_count>`);
  lines.push(
    '  <note>以下是最近若干条对话上下文（群聊与该用户相关消息的混合），仅作为背景，帮助你理解话题走向与气氛；请不要继续逐条解答其中的问题，也不要重复已有回复，本轮任务是为 Bot 决定是否以及如何以全新视角主动开口。</note>'
  );
  lines.push('  <context_messages>');

  merged.forEach((m, index) => {
    const senderId = m.sender_id != null ? String(m.sender_id) : '';
    const senderName = typeof m.sender_name === 'string' && m.sender_name.trim()
      ? m.sender_name
      : 'Unknown';
    const text = typeof m.text === 'string' ? m.text : '';
    const timeStr = typeof m.time === 'string' ? m.time : '';

    lines.push(`    <message index="${index + 1}">`);
    if (senderId) {
      lines.push(`      <sender_id>${escapeXml(senderId)}</sender_id>`);
    }
    lines.push(`      <sender_name>${escapeXml(senderName)}</sender_name>`);
    if (text) {
      lines.push(`      <text>${escapeXml(text)}</text>`);
    }
    if (timeStr) {
      lines.push(`      <time>${escapeXml(timeStr)}</time>`);
    }
    lines.push('    </message>');
  });

  lines.push('  </context_messages>');
  lines.push('</sentra-pending-messages>');

  return lines.join('\n');
}

function buildPlannerRootDirectiveXml(options) {
  const {
    chatType,
    groupId,
    userId,
    desireScore,
    topicHint,
    presetPlainText,
    presetXml: effectivePresetXml,
    personaXml,
    emoXml,
    memoryXml,
    time,
    lastBotMessage,
    userEngagement
  } = options || {};

  const safeChatType = chatType === 'private' ? 'private' : 'group';
  const safeGroupId = groupId ? String(groupId) : '';
  const safeUserId = userId ? String(userId) : '';
  const scoreText = Number.isFinite(desireScore) ? String(Math.round(desireScore)) : '0';
  const topicShort = String(topicHint || '').slice(0, 200).trim();
  const presetSummary = String(presetPlainText || '').slice(0, 800);
  const lastBotMessagePreview =
    typeof lastBotMessage === 'string'
      ? lastBotMessage.replace(/\s+/g, ' ').trim().slice(0, 120)
      : '';

  const ue = userEngagement && typeof userEngagement === 'object' ? userEngagement : null;
  const tz = (time && time.timezone) || getEnv('CONTEXT_MEMORY_TIMEZONE', 'Asia/Shanghai');
  const timeSinceLastUserSec =
    ue && typeof ue.timeSinceLastUserSec === 'number' && ue.timeSinceLastUserSec >= 0
      ? Math.round(ue.timeSinceLastUserSec)
      : null;
  const timeSinceLastUserReplySec =
    ue && typeof ue.timeSinceLastUserReplySec === 'number' && ue.timeSinceLastUserReplySec >= 0
      ? Math.round(ue.timeSinceLastUserReplySec)
      : null;
  const timeSinceLastProactiveSec =
    ue && typeof ue.timeSinceLastProactiveSec === 'number' && ue.timeSinceLastProactiveSec >= 0
      ? Math.round(ue.timeSinceLastProactiveSec)
      : null;
  const ignoredStrikes =
    ue && typeof ue.ignoredProactiveStrikes === 'number' && ue.ignoredProactiveStrikes >= 0
      ? ue.ignoredProactiveStrikes
      : 0;
  const penaltyActive = !!(ue && ue.penaltyActive);
  const repliedSinceLastProactive = !!(ue && ue.repliedSinceLastProactive);
  const lastUserAtTs = ue && Number.isFinite(ue.lastUserAt) && ue.lastUserAt > 0 ? ue.lastUserAt : 0;
  const lastUserReplyAtTs =
    ue && Number.isFinite(ue.lastUserReplyAt) && ue.lastUserReplyAt > 0 ? ue.lastUserReplyAt : 0;
  const lastProactiveAtTs =
    ue && Number.isFinite(ue.lastProactiveAt) && ue.lastProactiveAt > 0 ? ue.lastProactiveAt : 0;
  const penaltyUntilTs =
    ue && Number.isFinite(ue.penaltyUntil) && ue.penaltyUntil > 0 ? ue.penaltyUntil : 0;
  const lastUserAtLocal = lastUserAtTs > 0 ? formatLocalDateTime(lastUserAtTs, tz) : null;
  const lastUserReplyAtLocal =
    lastUserReplyAtTs > 0 ? formatLocalDateTime(lastUserReplyAtTs, tz) : null;
  const lastProactiveAtLocal =
    lastProactiveAtTs > 0 ? formatLocalDateTime(lastProactiveAtTs, tz) : null;
  const penaltyUntilLocal = penaltyUntilTs > 0 ? formatLocalDateTime(penaltyUntilTs, tz) : null;

  const rdLines = [];

  const objectiveLines = [];
  if (topicShort) {
    objectiveLines.push(
      `可以参考最近对话大致语境「${topicShort}」，但请优先从你自己的长期人设、兴趣和当日整体上下文出发（参见 <sentra-agent-preset>、<sentra-memory> 等），主动选择一个你认为此刻对用户更轻松、有趣或有价值的切入点，可以是相关的新子话题，也可以是温和的转场，而不是继续围绕用户刚说的那句话做解答。`
    );
  } else {
    objectiveLines.push(
      '根据当前会话的整体氛围、节奏和情绪，将已有对话视为“已经发生过的背景”，从 自己 的视角和长期人设出发规划本轮是否以及如何主动发言，可以结合当日摘要与用户长期兴趣引出新的话题，而不是去寻找还没回答完的问题。'
    );
  }
  if (lastBotMessagePreview) {
    objectiveLines.push(
      `上一轮你已经向用户发送过一条回复，其大致内容是「${lastBotMessagePreview}」。本轮在考虑是否以及如何主动开口时，必须显式避免重复该回复的核心意思或仅做同义改写；如果要继续相关话题，应换一个明显不同的新角度或子话题，否则请选择保持沉默。`
    );
  }
  objectiveLines.push(
    '在判断是否值得开口时，请先参考 <sentra-agent-preset> 中定义的 Bot 人设和长期行为模式，再结合 <sentra-memory> 中的当日对话摘要、用户长期习惯/情绪，以及 <sentra-pending-messages> 中最近多轮对话（仅作背景），主观判断本轮是否值得开口，并优先寻找“有新意的视角或子话题”（例如生活类联想、人设相关分享、情绪安抚、不同维度的背景补充），而不是继续从同一技术点/同一问题给出更多解释或注意事项。'
  );
  objectiveLines.push(
    '在规划“如何主动开口”时，可以先用工具在后台找一点真实信息/素材（如查最新进展、看时间/节假日、生成可分享内容等），但最终对用户说出来必须像你在聊天与分享，不得播报工具/流程/协议，不要出现“根据你的请求/工具调用/系统提示”等旁白。'
  );
  objectiveLines.push(
    '请把你的输出当作“你下一条准备对用户说的话的草稿方向”。用 1-2 句自然中文（口语一点、贴人设）说明你想从哪个新角度/新子话题轻轻接上去；如果想不到有价值的新内容，就规划为保持沉默（输出空的 sentra-response）。'
  );

  rdLines.push('<sentra-root-directive>');
  rdLines.push('  <id>proactive_objective_planner_v1</id>');
  rdLines.push('  <type>internal_planner</type>');
  rdLines.push('  <scope>conversation</scope>');
  rdLines.push('  <target>');
  rdLines.push(`    <chat_type>${escapeXml(safeChatType)}</chat_type>`);
  if (safeGroupId) {
    rdLines.push(`    <group_id>${escapeXml(safeGroupId)}</group_id>`);
  }
  if (safeUserId) {
    rdLines.push(`    <user_id>${escapeXml(safeUserId)}</user_id>`);
  }
  rdLines.push('  </target>');

  appendXmlBlockLines(rdLines, 'objective', objectiveLines, {
    indent: 1,
    transformLine: (line) => escapeXml(line)
  });

  appendConstraintsBlock(
    rdLines,
    [
      '优先考虑用户体验与不打扰原则：如果找不到有新意且对用户有价值的延展话题，应规划为“本轮保持沉默或轻度陪伴”。',
      '不要机械复述用户刚说过的话，也不要简单改写你最近几轮已经给出的回答；避免继续围绕同一个问题给出多轮近似答案。',
      '在私聊中可以更主动、更细腻一些，可以围绕用户的长期兴趣、情绪和日常生活拓展话题；在群聊中则更克制，避免刷屏或抢话。',
      '可以从 Bot 自身的人设/兴趣出发提出你 genuinely 好奇或想分享的点，例如分享见闻、推荐内容、提出开放性问题，但必须与当前对话语境保持相关，避免生硬跑题。',
      '在做是否以及如何主动发言的规划时，优先遵循 <sentra-agent-preset> 中定义的长期人设与行为规则，用户画像、情绪和记忆等信息仅作为辅助参考。',
      '当你意识到自己只是想“再补充说明一下刚才的问题”或“换一种说法继续解释同一个知识点”时，应将本轮 objective 设定为保持沉默或轻度陪伴，而不是继续输出类似内容。',
      '当 <user_engagement> 中显示用户长时间未回复、或存在多次 ignored_proactive_strikes / penalty_active=true 时，应明显降低主动规划的频率，更倾向将本轮 objective 规划为保持沉默或仅作轻度陪伴。'
    ],
    1
  );
  rdLines.push('  <meta>');
  rdLines.push(`    <desire_score>${scoreText}</desire_score>`);
  if (time) {
    if (time.dateStr) {
      rdLines.push(`    <date>${escapeXml(String(time.dateStr))}</date>`);
    }
    if (time.timeStr) {
      rdLines.push(`    <time_24>${escapeXml(String(time.timeStr))}</time_24>`);
    }
    if (time.weekday) {
      rdLines.push(`    <weekday>${escapeXml(String(time.weekday))}</weekday>`);
    }
    rdLines.push(`    <hour>${escapeXml(String(time.hour))}</hour>`);
    rdLines.push(`    <month>${escapeXml(String(time.month))}</month>`);
    rdLines.push(`    <day>${escapeXml(String(time.day))}</day>`);
    rdLines.push(`    <is_weekend>${time.isWeekend ? 'true' : 'false'}</is_weekend>`);
    if (time.isWorkday != null) {
      rdLines.push(`    <is_workday>${time.isWorkday ? 'true' : 'false'}</is_workday>`);
    }
    if (time.timeOfDay) {
      rdLines.push(`    <time_context>${escapeXml(String(time.timeOfDay))}</time_context>`);
    }
    if (time.holidayHint) {
      rdLines.push(`    <holiday_hint>${escapeXml(String(time.holidayHint))}</holiday_hint>`);
    }
  }
  if (topicShort) {
    rdLines.push(`    <topic_hint>${escapeXml(topicShort)}</topic_hint>`);
  }
  if (presetSummary) {
    rdLines.push(`    <preset_plain_text>${escapeXml(presetSummary)}</preset_plain_text>`);
  }
  if (ue) {
    rdLines.push('    <user_engagement>');
    if (timeSinceLastUserSec != null) {
      rdLines.push(`      <time_since_last_user_sec>${timeSinceLastUserSec}</time_since_last_user_sec>`);
    }
    if (timeSinceLastUserReplySec != null) {
      rdLines.push(
        `      <time_since_last_user_reply_sec>${timeSinceLastUserReplySec}</time_since_last_user_reply_sec>`
      );
    }
    if (timeSinceLastProactiveSec != null) {
      rdLines.push(
        `      <time_since_last_proactive_sec>${timeSinceLastProactiveSec}</time_since_last_proactive_sec>`
      );
    }
    rdLines.push(`      <ignored_proactive_strikes>${ignoredStrikes}</ignored_proactive_strikes>`);
    rdLines.push(`      <penalty_active>${penaltyActive ? 'true' : 'false'}</penalty_active>`);
    rdLines.push(
      `      <replied_since_last_proactive>${repliedSinceLastProactive ? 'true' : 'false'}</replied_since_last_proactive>`
    );
    if (lastUserAtLocal) {
      rdLines.push(
        `      <last_user_at_local>${escapeXml(lastUserAtLocal)}</last_user_at_local>`
      );
    }
    if (lastUserReplyAtLocal) {
      rdLines.push(
        `      <last_user_reply_at_local>${escapeXml(lastUserReplyAtLocal)}</last_user_reply_at_local>`
      );
    }
    if (lastProactiveAtLocal) {
      rdLines.push(
        `      <last_proactive_at_local>${escapeXml(lastProactiveAtLocal)}</last_proactive_at_local>`
      );
    }
    if (penaltyUntilLocal) {
      rdLines.push(
        `      <penalty_until_local>${escapeXml(penaltyUntilLocal)}</penalty_until_local>`
      );
    }
    rdLines.push('    </user_engagement>');
  }
  rdLines.push('  </meta>');
  rdLines.push('</sentra-root-directive>');

  return rdLines.join('\n');
}

function buildPlannerSystemContextXml(options) {
  const {
    presetXml,
    personaXml,
    emoXml,
    memoryXml,
    conversationContext,
    lastBotMessage
  } = options || {};

  const pieces = [];

  if (presetXml && typeof presetXml === 'string' && presetXml.trim()) {
    pieces.push(presetXml.trim());
  }

  if (personaXml && typeof personaXml === 'string' && personaXml.trim()) {
    pieces.push(personaXml.trim());
  }

  if (emoXml && typeof emoXml === 'string' && emoXml.trim()) {
    pieces.push(emoXml.trim());
  }

  if (memoryXml && typeof memoryXml === 'string' && memoryXml.trim()) {
    pieces.push(memoryXml.trim());
  }

  const lastBot = typeof lastBotMessage === 'string' ? lastBotMessage.trim() : '';
  if (lastBot) {
    const preview = lastBot.slice(0, 800);
    const block = [
      '<sentra-last-bot-message>',
      '  <note>以下是最近一次 Bot 已发送给用户的回复内容，用于帮助你避免重复或语义等价，只作对比参考，不需要逐句复述。</note>',
      `  <content>${escapeXml(preview)}</content>`,
      '</sentra-last-bot-message>'
    ].join('\n');
    pieces.push(block);
  }

  const pendingXml = buildPendingMessagesXmlFromContext(conversationContext);
  if (pendingXml) {
    pieces.push(pendingXml);
  }

  return pieces.join('\n\n');
}

/**
 * 规划本轮主动 root 指令的 objective 文本
 * 返回一段纯中文描述（不包含 XML 标签），由调用方包裹在 <objective> 中。
 */
export async function planProactiveObjective(payload = {}) {
  const agent = getPlannerAgent();
  if (!agent) {
    logger.warn('ProactiveDirectivePlanner: planner agent 未初始化，将使用默认 objective');
    return null;
  }

  const time = await buildTimeContext();
  const {
    chatType = 'group',
    groupId = '',
    userId = '',
    desireScore = 0,
    topicHint = '',
    presetPlainText = '',
    presetXml = '',
    personaXml = '',
    emoXml = '',
    memoryXml = '',
    conversationContext = null,
    lastBotMessage = '',
    userEngagement = null
  } = payload || {};

  let effectivePresetXml = typeof presetXml === 'string' ? presetXml : '';
  if (!effectivePresetXml) {
    try {
      effectivePresetXml = await getPlannerAgentPresetXml();
    } catch (e) {
      logger.warn('ProactiveDirectivePlanner: 获取 Agent 预设 XML 失败，将继续使用空预设', { err: String(e) });
    }
  }

  const safeContext =
    conversationContext && typeof conversationContext === 'object'
      ? conversationContext
      : null;

  const baseSystemPrompt = await getPlannerSystemPrompt();
  const userContent = buildPlannerRootDirectiveXml({
    chatType,
    groupId,
    userId,
    desireScore,
    topicHint,
    presetPlainText,
    presetXml,
    personaXml,
    emoXml,
    memoryXml,
    time,
    lastBotMessage,
    userEngagement
  });

  const systemContextXml = buildPlannerSystemContextXml({
    presetXml: effectivePresetXml,
    personaXml,
    emoXml,
    memoryXml,
    conversationContext: safeContext,
    lastBotMessage
  });

  const systemContent = [baseSystemPrompt?.trim(), systemContextXml]
    .filter((chunk) => chunk && chunk.trim())
    .join('\n\n');

  try {
    const { model, maxTokens } = getPlannerConfig();

    const conversations = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];

    const groupIdForLog = groupId ? `proactive_planner_${groupId}` : 'proactive_planner';
    const result = await chatWithRetryCore(agent, conversations, { model, maxTokens }, groupIdForLog);

    if (!result || !result.success || !result.response) {
      logger.warn('ProactiveDirectivePlanner: chatWithRetry 返回失败结果，将回退为默认 objective', {
        reason: result?.reason || 'unknown'
      });
      return null;
    }

    const text = typeof result.response === 'string'
      ? result.response
      : String(result.response ?? '');

    const objective = extractObjectiveFromRawReply(text);

    if (!objective) {
      logger.warn('ProactiveDirectivePlanner: 模型返回内容无法用作 objective，将回退为默认文案', {
        snippet: text.slice(0, 120)
      });
      return null;
    }

    logger.debug('ProactiveDirectivePlanner: 生成主动 objective', {
      preview: objective.slice(0, 120)
    });

    return objective;
  } catch (e) {
    logger.warn('ProactiveDirectivePlanner: 规划 objective 失败，将回退为默认文案', { err: String(e) });
    return null;
  }
}

export async function buildProactiveRootDirectiveXml(payload = {}) {
  const {
    chatType: rawChatType = 'group',
    groupId: rawGroupId = '',
    userId: rawUserId = '',
    desireScore = 0,
    topicHint = '',
    presetPlainText = '',
    presetXml = '',
    personaXml = '',
    emoXml = '',
    memoryXml = '',
    conversationContext = null,
    lastBotMessage = '',
    userEngagement = null
  } = payload || {};

  const chatType = rawChatType === 'private' ? 'private' : 'group';
  const groupId = typeof rawGroupId === 'string' ? rawGroupId.replace(/^G:/, '') : String(rawGroupId || '');
  const userId = rawUserId ? String(rawUserId) : '';
  const score = Number.isFinite(desireScore) ? Math.round(desireScore) : 0;
  const topicHintText = typeof topicHint === 'string' ? topicHint : '';
  const presetPlainTextSafe = typeof presetPlainText === 'string' ? presetPlainText : '';
  const lastBotMessageSafe = typeof lastBotMessage === 'string' ? lastBotMessage.trim() : '';
  const lastBotMessagePreview = lastBotMessageSafe
    ? lastBotMessageSafe.replace(/\s+/g, ' ').slice(0, 200)
    : '';

  const ue = userEngagement && typeof userEngagement === 'object' ? userEngagement : null;
  const tz = getEnv('CONTEXT_MEMORY_TIMEZONE', 'Asia/Shanghai');
  const timeSinceLastUserSec =
    ue && typeof ue.timeSinceLastUserSec === 'number' && ue.timeSinceLastUserSec >= 0
      ? Math.round(ue.timeSinceLastUserSec)
      : null;
  const timeSinceLastUserReplySec =
    ue && typeof ue.timeSinceLastUserReplySec === 'number' && ue.timeSinceLastUserReplySec >= 0
      ? Math.round(ue.timeSinceLastUserReplySec)
      : null;
  const timeSinceLastProactiveSec =
    ue && typeof ue.timeSinceLastProactiveSec === 'number' && ue.timeSinceLastProactiveSec >= 0
      ? Math.round(ue.timeSinceLastProactiveSec)
      : null;
  const ignoredStrikes =
    ue && typeof ue.ignoredProactiveStrikes === 'number' && ue.ignoredProactiveStrikes >= 0
      ? ue.ignoredProactiveStrikes
      : 0;
  const penaltyActive = !!(ue && ue.penaltyActive);
  const repliedSinceLastProactive = !!(ue && ue.repliedSinceLastProactive);
  const lastUserAtTs = ue && Number.isFinite(ue.lastUserAt) && ue.lastUserAt > 0 ? ue.lastUserAt : 0;
  const lastUserReplyAtTs =
    ue && Number.isFinite(ue.lastUserReplyAt) && ue.lastUserReplyAt > 0 ? ue.lastUserReplyAt : 0;
  const lastProactiveAtTs =
    ue && Number.isFinite(ue.lastProactiveAt) && ue.lastProactiveAt > 0 ? ue.lastProactiveAt : 0;
  const penaltyUntilTs =
    ue && Number.isFinite(ue.penaltyUntil) && ue.penaltyUntil > 0 ? ue.penaltyUntil : 0;
  const lastUserAtLocal = lastUserAtTs > 0 ? formatLocalDateTime(lastUserAtTs, tz) : null;
  const lastUserReplyAtLocal =
    lastUserReplyAtTs > 0 ? formatLocalDateTime(lastUserReplyAtTs, tz) : null;
  const lastProactiveAtLocal =
    lastProactiveAtTs > 0 ? formatLocalDateTime(lastProactiveAtTs, tz) : null;
  const penaltyUntilLocal = penaltyUntilTs > 0 ? formatLocalDateTime(penaltyUntilTs, tz) : null;

  const lines = [];
  lines.push('<sentra-root-directive>');
  lines.push('  <id>proactive_speak_v1</id>');
  lines.push('  <type>proactive</type>');
  lines.push('  <scope>conversation</scope>');
  lines.push('  <target>');
  lines.push(`    <chat_type>${escapeXml(chatType)}</chat_type>`);
  if (groupId) {
    lines.push(`    <group_id>${escapeXml(groupId)}</group_id>`);
  }
  if (userId) {
    lines.push(`    <user_id>${escapeXml(userId)}</user_id>`);
  }
  lines.push('  </target>');

  let objectiveText = null;
  try {
    objectiveText = await planProactiveObjective({
      chatType,
      groupId,
      userId,
      desireScore: score,
      topicHint,
      presetPlainText,
      presetXml,
      personaXml,
      emoXml,
      memoryXml,
      conversationContext,
      lastBotMessage,
      userEngagement
    });
  } catch (e) {
    logger.warn('主动 root 指令规划失败，将回退为默认 objective', { err: String(e) });
  }

  const trimmedTopic = topicHintText ? topicHintText.trim() : '';
  const shortTopic = trimmedTopic;

  const defaultObjectiveLines = [];
  if (shortTopic) {
    defaultObjectiveLines.push(
      `围绕最近的语境「${shortTopic}」，从你的人设出发想一句“像真人顺口接话”的话：带一个新角度/新子话题，别再重复刚才的解释。`
    );
  } else {
    defaultObjectiveLines.push(
      '从你的人设出发想一句“像真人顺口接话”的话：可以轻轻转个新角度/新子话题，别写成说明书。'
    );
  }
  defaultObjectiveLines.push(
    '语气要像在聊天：短一点、自然一点，能带一点你人设的情绪/口头禅也行。'
  );
  defaultObjectiveLines.push(
    '如果你想用工具找个“有料的小点”再聊，也可以，但最终说出来必须像你在分享，而不是在播报工具或流程。'
  );
  defaultObjectiveLines.push(
    '不要用模板化旁白（例如“根据你的请求…/工具调用…”），要像真人顺口接话。'
  );
  defaultObjectiveLines.push(
    '如果想不到有价值的新内容，就保持沉默：输出空的 sentra-response。'
  );

  const effectiveObjective = (typeof objectiveText === 'string' && objectiveText.trim())
    ? objectiveText.trim()
    : defaultObjectiveLines.join('\n');

  appendXmlBlockLines(lines, 'objective', effectiveObjective, { indent: 1 });

  lines.push('  <allow_tools>true</allow_tools>');

  appendConstraintsBlock(
    lines,
    [
      '不要打断正在高频、多人的激烈对话。',
      '同一会话中，主动发言应保持适度，不要频繁刷屏。',
      '主动发言内容必须与最近的话题相关，可以是抛出新问题、补充背景信息、提出新角度或轻度转场，但不要机械重复你最近几条发言。',
      '如果主动发言的内容与上一轮或最近几轮你的发言高度相似（仅是改写或同义复述），应选择保持沉默。',
      '如无明显价值或可能打扰用户，应选择保持沉默。',
      '在适当时机，优先通过工具（例如搜索、知识库、历史上下文分析等）获取有趣或有用的信息，再结合你的人设进行分享或提问，以带出更有深度的新话题。',
      '当 <user_engagement> 中显示用户长时间未回复、或存在多次 ignored_proactive_strikes / penalty_active=true 时，应明显降低主动发言频率，优先将本轮规划为保持沉默或仅作轻度陪伴。'
    ],
    1
  );
  lines.push('  <meta>');
  lines.push(`    <desire_score>${score}</desire_score>`);
  if (lastBotMessagePreview) {
    lines.push(
      `    <last_bot_message_preview>${escapeXml(lastBotMessagePreview)}</last_bot_message_preview>`
    );
  }
  if (ue) {
    lines.push('    <user_engagement>');
    if (timeSinceLastUserSec != null) {
      lines.push(`      <time_since_last_user_sec>${timeSinceLastUserSec}</time_since_last_user_sec>`);
    }
    if (timeSinceLastUserReplySec != null) {
      lines.push(
        `      <time_since_last_user_reply_sec>${timeSinceLastUserReplySec}</time_since_last_user_reply_sec>`
      );
    }
    if (timeSinceLastProactiveSec != null) {
      lines.push(
        `      <time_since_last_proactive_sec>${timeSinceLastProactiveSec}</time_since_last_proactive_sec>`
      );
    }
    lines.push(`      <ignored_proactive_strikes>${ignoredStrikes}</ignored_proactive_strikes>`);
    lines.push(`      <penalty_active>${penaltyActive ? 'true' : 'false'}</penalty_active>`);
    lines.push(
      `      <replied_since_last_proactive>${repliedSinceLastProactive ? 'true' : 'false'}</replied_since_last_proactive>`
    );
    if (lastUserAtLocal) {
      lines.push(
        `      <last_user_at_local>${escapeXml(lastUserAtLocal)}</last_user_at_local>`
      );
    }
    if (lastUserReplyAtLocal) {
      lines.push(
        `      <last_user_reply_at_local>${escapeXml(lastUserReplyAtLocal)}</last_user_reply_at_local>`
      );
    }
    if (lastProactiveAtLocal) {
      lines.push(
        `      <last_proactive_at_local>${escapeXml(lastProactiveAtLocal)}</last_proactive_at_local>`
      );
    }
    if (penaltyUntilLocal) {
      lines.push(
        `      <penalty_until_local>${escapeXml(penaltyUntilLocal)}</penalty_until_local>`
      );
    }
    lines.push('    </user_engagement>');
  }
  lines.push('  </meta>');
  lines.push('</sentra-root-directive>');
  return lines.join('\n');
}
