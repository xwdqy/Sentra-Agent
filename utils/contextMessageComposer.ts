import type { ChatMessage } from '../src/types.js';
import { escapeXml, extractXMLTag } from './xmlUtils.js';

type TimedChatMessage = ChatMessage & { timestamp?: number };
type ChatMode = 'group' | 'private' | 'unknown';
type TimeMetaDecorationOptions = {
  previousUserTimestampMs?: number | null;
  chatMode?: ChatMode;
  gapThresholdMs?: number;
};

export type RuntimeConversationComposeOptions = {
  historyMessages?: TimedChatMessage[];
  memoryPackXml?: string;
  currentUserContent?: string;
  currentUserTimestampMs?: number | null;
  timezone?: string;
};

function normalizeEpochMs(raw: unknown): number | null {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  let out = num;
  if (out < 1e11) out = out * 1000;
  if (out > 1e15) out = Math.floor(out / 1000);
  out = Math.floor(out);
  if (!Number.isFinite(out) || out <= 0) return null;
  return out;
}

function parseTimeStringToMs(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const asEpoch = normalizeEpochMs(text);
  if (asEpoch) return asEpoch;

  const normalized = text
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日|号/g, ' ')
    .replace(/凌晨|上午|中午|下午|晚上/g, ' ')
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const ms = Date.parse(normalized);
  if (Number.isFinite(ms) && ms > 0) return ms;

  const msRaw = Date.parse(text);
  if (Number.isFinite(msRaw) && msRaw > 0) return msRaw;
  return null;
}

function getLocaleTimeParts(ms: number, timezone: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date(ms));
  const pick = (type: string, fallback = '') =>
    parts.find((p) => p.type === type)?.value || fallback;
  return {
    year: pick('year', '1970'),
    month: pick('month', '1'),
    day: pick('day', '1'),
    hour: pick('hour', '00'),
    minute: pick('minute', '00')
  };
}

export function formatZhLocalTime(ms: number, timezone = 'Asia/Shanghai'): string {
  const safeMs = normalizeEpochMs(ms) ?? Date.now();
  const p = getLocaleTimeParts(safeMs, timezone);
  const hourNum = Number(p.hour);
  const period = !Number.isFinite(hourNum)
    ? '上午'
    : (hourNum < 6 ? '凌晨' : (hourNum < 12 ? '上午' : (hourNum < 18 ? '下午' : '晚上')));
  return `${p.year}年${p.month}月${p.day}日 ${period} ${p.hour}:${p.minute}`;
}

export function resolveTimestampMsFromRecord(raw: unknown): number | null {
  const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const numericKeys = [
    'timestamp',
    'timestamp_ms',
    'time_ms',
    'time',
    'ts',
    'created_at',
    'createdAt',
    'send_time',
    'message_time'
  ];
  for (const key of numericKeys) {
    const ms = normalizeEpochMs(rec[key]);
    if (ms) return ms;
  }
  const textKeys = ['time_str', 'timeText', 'time_text'];
  for (const key of textKeys) {
    const ms = parseTimeStringToMs(rec[key]);
    if (ms) return ms;
  }
  return null;
}

export function extractTimestampMsFromContent(content: unknown): number | null {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const direct = normalizeEpochMs(extractXMLTag(text, 'timestamp_ms'));
  if (direct) return direct;
  const ts = normalizeEpochMs(extractXMLTag(text, 'timestamp'));
  if (ts) return ts;
  const fromTimeStr = parseTimeStringToMs(extractXMLTag(text, 'time_str'));
  if (fromTimeStr) return fromTimeStr;
  const fromTime = parseTimeStringToMs(extractXMLTag(text, 'time'));
  if (fromTime) return fromTime;
  return null;
}

function detectChatModeFromContent(content: unknown): ChatMode {
  const text = String(content ?? '').trim();
  if (!text) return 'unknown';
  const chatType = String(extractXMLTag(text, 'chat_type') || '').trim().toLowerCase();
  if (chatType === 'group' || chatType === 'private') return chatType as ChatMode;
  const groupId = String(extractXMLTag(text, 'group_id') || '').trim();
  const userId = String(extractXMLTag(text, 'user_id') || '').trim();
  if (/^\d+$/.test(groupId)) return 'group';
  if (/^\d+$/.test(userId)) return 'private';
  return 'unknown';
}

function formatGapDuration(gapMs: number): string {
  const safe = Math.max(0, Math.floor(gapMs));
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (safe < hourMs) {
    const minutes = Math.max(1, Math.floor(safe / minuteMs));
    return `${minutes}分钟`;
  }
  if (safe < dayMs) {
    const hours = Math.floor(safe / hourMs);
    const minutes = Math.floor((safe % hourMs) / minuteMs);
    return `${hours}小时${minutes}分钟`;
  }
  const days = Math.floor(safe / dayMs);
  const hours = Math.floor((safe % dayMs) / hourMs);
  return `${days}天${hours}小时`;
}

function buildGapRootHint(gapMs: number, mode: ChatMode): string {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return '';
  const scope = mode === 'group' ? '群聊' : (mode === 'private' ? '私聊' : '会话');
  const duration = formatGapDuration(gapMs);
  return `距上次${scope}回复过了${duration}，先简要承接上下文再继续。`;
}

function getDefaultGapThresholdMs(mode: ChatMode): number {
  if (mode === 'group') return 2 * 60 * 60 * 1000;
  if (mode === 'private') return 30 * 60 * 1000;
  return 30 * 60 * 1000;
}

function isMemoryPackContent(content: unknown): boolean {
  const text = String(content ?? '');
  return text.includes('<sentra-memory-pack>');
}

export function decorateUserContentWithTimeMeta(
  content: unknown,
  timestampMs?: number | null,
  timezone = 'Asia/Shanghai',
  options: TimeMetaDecorationOptions = {}
): string {
  const body = String(content ?? '').trim();
  if (!body) return '';
  if (body.includes('<sentra-message-time>')) return body;
  const ts = normalizeEpochMs(timestampMs) ?? extractTimestampMsFromContent(body) ?? Date.now();
  const localText = formatZhLocalTime(ts, timezone);
  const previousTs = normalizeEpochMs(options.previousUserTimestampMs);
  const mode = options.chatMode || detectChatModeFromContent(body);
  const gapThresholdMs = Number.isFinite(Number(options.gapThresholdMs))
    ? Math.max(0, Number(options.gapThresholdMs))
    : getDefaultGapThresholdMs(mode);
  const gapMs = previousTs && ts > previousTs ? ts - previousTs : 0;
  const rootHint = previousTs && gapMs > gapThresholdMs ? buildGapRootHint(gapMs, mode) : '';
  const timeMeta = [
    '<sentra-message-time>',
    `  <time>${escapeXml(localText)}</time>`,
    `  <timestamp_ms>${ts}</timestamp_ms>`,
    ...(rootHint ? [`  <root>${escapeXml(rootHint)}</root>`] : []),
    '</sentra-message-time>'
  ].join('\n');
  return `${timeMeta}\n${body}`;
}

function findLastUserMeta(messages: ChatMessage[]): { timestampMs: number | null; mode: ChatMode } {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (!msg || msg.role !== 'user') continue;
    const text = String(msg.content ?? '').trim();
    if (!text || isMemoryPackContent(text)) continue;
    const ts = extractTimestampMsFromContent(text);
    const mode = detectChatModeFromContent(text);
    return { timestampMs: ts, mode };
  }
  return { timestampMs: null, mode: 'unknown' };
}

export function appendRuntimeUserMessage(
  messages: ChatMessage[],
  content: unknown,
  options: {
    timestampMs?: number | null;
    timezone?: string;
    modeHint?: ChatMode;
  } = {}
): ChatMessage {
  const timezone = String(options.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  const { timestampMs: prevTs, mode: prevMode } = findLastUserMeta(messages);
  const ts = normalizeEpochMs(options.timestampMs) ?? extractTimestampMsFromContent(content) ?? Date.now();
  const mode = options.modeHint || detectChatModeFromContent(content) || prevMode;
  const decorated = decorateUserContentWithTimeMeta(content, ts, timezone, {
    previousUserTimestampMs: prevTs,
    chatMode: mode
  });
  const row = { role: 'user', content: decorated, timestamp: ts };
  return row as ChatMessage;
}

export function composeRuntimeConversationMessages(options: RuntimeConversationComposeOptions = {}): ChatMessage[] {
  const history = Array.isArray(options.historyMessages) ? options.historyMessages : [];
  const timezone = String(options.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  const out: Array<{ role: ChatMessage['role']; content: string; ts: number; idx: number }> = [];

  let cursorTs = 0;
  let idx = 0;
  let lastUserTs: number | null = null;
  let lastUserMode: ChatMode = 'unknown';

  const pushMsg = (role: ChatMessage['role'], content: string, rawTs: number | null, kind: 'normal' | 'memory' = 'normal') => {
    const text = String(content || '').trim();
    if (!text) return;
    let ts = normalizeEpochMs(rawTs);
    if (!ts) ts = extractTimestampMsFromContent(text);
    if (!ts) ts = cursorTs > 0 ? cursorTs + 1 : Date.now() + idx;
    if (ts <= cursorTs) ts = cursorTs + 1;
    cursorTs = ts;
    let nextContent = text;
    if (role === 'user') {
      const modeDetected = detectChatModeFromContent(text);
      const mode = modeDetected !== 'unknown' ? modeDetected : lastUserMode;
      nextContent = decorateUserContentWithTimeMeta(text, ts, timezone, {
        previousUserTimestampMs: kind === 'memory' ? null : lastUserTs,
        chatMode: mode
      });
      if (kind !== 'memory') {
        lastUserTs = ts;
        if (modeDetected !== 'unknown') lastUserMode = modeDetected;
      }
    }
    out.push({
      role,
      content: nextContent,
      ts,
      idx: idx++
    });
  };

  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    const ts = normalizeEpochMs((m as { timestamp?: unknown }).timestamp) ?? extractTimestampMsFromContent(content);
    pushMsg(role, content, ts, 'normal');
  }

  const memoryPackXml = String(options.memoryPackXml || '').trim();
  if (memoryPackXml) {
    pushMsg('user', memoryPackXml, null, 'memory');
  }

  const currentUserContent = String(options.currentUserContent || '').trim();
  if (currentUserContent) {
    const currentTs = normalizeEpochMs(options.currentUserTimestampMs) ?? extractTimestampMsFromContent(currentUserContent) ?? Date.now();
    pushMsg('user', currentUserContent, currentTs, 'normal');
  }

  out.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.idx - b.idx;
  });

  return out.map((item) => {
    const row = { role: item.role, content: item.content, timestamp: item.ts };
    return row as ChatMessage;
  });
}
