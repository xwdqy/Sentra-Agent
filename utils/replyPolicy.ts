/**
 * 智能回复策略模块（精简版）
 * 功能：
 * - Per-sender 并发控制和队列机制
 * - UUID 跟踪和超时淘汰
 * - 是否进入一次对话任务由本模块决定，具体“回不回话”交给主模型和 Sentra 协议（<sentra-message>）
 */

import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { planGroupReplyDecision } from './replyIntervention.js';
import { assessReplyWorth } from '../components/ReplyGate.js';
import { loadAttentionStats, updateAttentionStatsAfterDecision } from './attentionStats.js';
import { getEnv, getEnvInt, getEnvBool } from './envHotReloader.js';
import { timeParser } from '../src/time-parser.js';
import { tReplyPolicy, tReplyGateBase, tReplyGateCode } from './i18n/replyPolicyCatalog.js';
import { buildGroupScopeId } from './conversationId.js';

const logger = createLogger('ReplyPolicy');

type MsgLike = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  text?: string;
  summary?: string;
  message_id?: string | number | null;
  self_id?: string | number | null;
  at_users?: Array<string | number>;
  [key: string]: unknown;
};

type TaskItem = {
  id: string;
  msg: MsgLike;
  conversationId: string;
  createdAt: number;
  senderId: string;
};

type GateSession = { value: number; lastTs: number };
type ReplyStats = { timestamps: number[] };
type AttentionWindowOptions = { isExplicitMention?: boolean; mentionedByName?: boolean };
type ReplyGateResult = {
  allow?: boolean;
  decision?: string;
  reason?: string;
  probability?: number | null;
  normalizedScore?: number | null;
  decisionContext?: Record<string, unknown>;
  source?: string;
  forceReply?: boolean;
  debug?: {
    analyzer?: {
      probability?: number | null;
      policy?: {
        action?: string;
        details?: Array<{ kind?: string; score?: number; matches?: number }>;
      };
    };
    [key: string]: unknown;
  };
};

type DecisionTrace = {
  source: string;
  isGroup: boolean;
  isExplicitMention: boolean;
  mentionedByName: boolean;
  isFollowupAfterBotReply: boolean;
  pureLocalGating: boolean;
  useLlmIntervention: boolean | null;
  gate: {
    decision?: string;
    normalizedScore?: number | null;
    reason?: string;
    analyzerProb?: number | null;
  } | null;
  gateAccum: {
    allow: boolean;
    gateProb: number;
    skip?: boolean;
  } | null;
  llmDecision: {
    shouldReply: boolean;
    confidence: number | null;
    reason: string | null;
  } | null;
};

type ReplyPolicyConfig = {
  [key: string]: unknown;
  maxConcurrentPerSender: number;
  queueTimeout: number;
  botNames: string[];
  attentionEnabled: boolean;
  attentionWindowMs: number;
  attentionMaxSenders: number;
  userFatigueEnabled: boolean;
  userReplyWindowMs: number;
  userReplyBaseLimit: number;
  userReplyMinIntervalMs: number;
  userReplyBackoffFactor: number;
  userReplyMaxBackoffMultiplier: number;
  groupFatigueEnabled: boolean;
  groupReplyWindowMs: number;
  groupReplyBaseLimit: number;
  groupReplyMinIntervalMs: number;
  groupReplyBackoffFactor: number;
  groupReplyMaxBackoffMultiplier: number;
  replyGateAccumBaseline: number;
  replyGateAccumThreshold: number;
  replyGateAccumHalflifeMs: number;
  mentionMustReply: boolean;
  pureLocalGating: boolean;
  replyFollowupWindowSec: number;
  replyFollowupMinGapMs: number;
  replyFollowupMaxCount: number;
  replyFollowupBoost: number;
  replySimilarityThreshold: number;
};

type FatigueResult = { pass: boolean; reasonCode: string; count: number; fatigue: number; lastAgeSec: number | null };
type FatigueInfo = { count: number; fatigue: number; lastAgeSec: number | null };
type AttentionSession = {
  consideredCount: number;
  repliedCount: number;
  avgAnalyzerProb?: number;
  avgGateProb?: number;
  avgFusedProb?: number;
  replyRatio?: number;
};
type AttentionUpdatePayloadLike = {
  groupId?: string | number;
  senderId?: string | number;
  analyzerProb?: number;
  gateProb?: number;
  fusedProb?: number;
  didReply?: boolean;
};
type PlanGroupSignalsLike = {
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
type ReplyGateSignalsLike = {
  mentionedByAt?: boolean;
  mentionedByName?: boolean;
  senderReplyCountWindow?: number;
  groupReplyCountWindow?: number;
  senderFatigue?: number;
  groupFatigue?: number;
  isFollowupAfterBotReply?: boolean;
  attentionSession?: AttentionSession;
};

type ReplyAction = 'silent' | 'action' | 'short' | 'delay';
type DelayPlan = {
  whenText: string;
  fireAt: number;
  delayMs: number;
  targetISO: string;
  timezone: string;
  parserMethod?: string;
};

type ShouldReplyDecision = {
  needReply: boolean;
  action: ReplyAction;
  delay?: DelayPlan;
  reason_code: string;
  reason?: string;
  explainZh?: string;
  decisionSource?: string;
  decisionTrace?: DecisionTrace | Record<string, unknown>;
  mandatory: boolean;
  probability: number;
  conversationId: string;
  taskId: string | null;
};

const REASON_CODE = Object.freeze({
  force_reply: 'force_reply',
  private_llm_delay: 'private_llm_delay',
  private_llm_short: 'private_llm_short',
  private_llm_action: 'private_llm_action',
  private_llm_unavailable: 'private_llm_unavailable',
  local_concurrency_queue: 'local_concurrency_queue',
  local_attention_list: 'local_attention_list',
  local_attention_window: 'local_attention_window',
  local_group_fatigue: 'local_group_fatigue',
  local_sender_fatigue: 'local_sender_fatigue',
  local_reply_gate_ignore: 'local_reply_gate_ignore',
  local_reply_gate_accum: 'local_reply_gate_accum',
  llm_reply_enter: 'llm_reply_enter',
  llm_reply_silent: 'llm_reply_silent',
  local_mandatory_mention: 'local_mandatory_mention',
  final_no_reply: 'final_no_reply',
  final_enter_main: 'final_enter_main'
});

type ReasonCode = (typeof REASON_CODE)[keyof typeof REASON_CODE];

const senderQueues = new Map<string, TaskItem[]>();
const activeTasks = new Map<string, Set<string>>();
const groupAttention = new Map<string, Map<string, number>>();
const senderReplyStats = new Map<string, ReplyStats>(); // senderId -> { timestamps: number[] }
const groupReplyStats = new Map<string, ReplyStats>();  // groupKey -> { timestamps: number[] }
const cancelledTasks = new Set<string>();   // 记录被标记为取消的任务ID（taskId）
const gateSessions = new Map<string, GateSession>();

const senderLastTouchedAt = new Map<string, number>();

function readEnvInt(name: string, fallback: number): number {
  const raw = getEnvInt(name, fallback);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = getEnvBool(name, fallback);
  return raw === undefined ? fallback : raw;
}

function readEnvFloat(name: string, fallback: number): number {
  const raw = getEnv(name, String(fallback));
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : fallback;
}

function takeFirst<T>(arr: T[], count: number): T[] {
  if (!Array.isArray(arr) || count <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < arr.length && i < count; i++) {
    const item = arr[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

function joinFromIndex(parts: string[], startIndex: number, sep: string): string {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i >= startIndex) {
      const part = parts[i];
      if (part !== undefined) out.push(part);
    }
  }
  return out.join(sep);
}

function explainByReasonCode(reasonCode: string, params: Record<string, unknown> = {}, fallback = ''): string {
  const mapped = tReplyPolicy(reasonCode, params);
  if (mapped) return mapped;
  if (fallback) return fallback;
  return reasonCode;
}

function buildReasonFields(
  reasonCode: ReasonCode | string,
  options: {
    reasonDetail?: unknown;
    explainKey?: string;
    explainParams?: Record<string, unknown>;
    explainFallback?: string;
  } = {}
): { reason_code: string; reason: string; explainZh: string } {
  const reason_code = String(reasonCode || '').trim() || REASON_CODE.final_no_reply;
  const reason = typeof options.reasonDetail === 'string' && options.reasonDetail.trim()
    ? options.reasonDetail.trim()
    : reason_code;
  const explainKey = typeof options.explainKey === 'string' && options.explainKey.trim()
    ? options.explainKey.trim()
    : reason_code;
  const explainZh = explainByReasonCode(explainKey, options.explainParams || {}, options.explainFallback || reason);
  return { reason_code, reason, explainZh };
}

function getGateAnalyzerProb(gateResult: ReplyGateResult | null | undefined): number | null {
  const prob = gateResult?.debug?.analyzer?.probability;
  if (typeof prob === 'number' && Number.isFinite(prob)) return prob;
  return null;
}

function normalizeReplyAction(rawAction: unknown, fallbackByNeedReply: boolean): ReplyAction {
  const raw = String(rawAction ?? '').trim().toLowerCase();
  if (raw === 'silent' || raw === 'none') return 'silent';
  if (raw === 'short') return 'short';
  if (raw === 'delay') return 'delay';
  if (raw === 'action') return 'action';
  return fallbackByNeedReply ? 'action' : 'silent';
}

function collectDelayParseCandidates(msg: MsgLike | null | undefined, delayWhenRaw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  // 1) 优先模型给出的 delay_when
  push(delayWhenRaw);

  if (msg && typeof msg === 'object') {
    push(msg.text);
    push((msg as any).summary);
    push((msg as any).objective_text);
    push((msg as any).summary_text);
    push((msg as any).objective);
    push((msg as any).raw_text);
    push((msg as any).user_text);
  }

  return out;
}

function buildDelayPlanFromText(msg: MsgLike, delayWhenRaw: unknown): DelayPlan | null {
  const candidates = collectDelayParseCandidates(msg, delayWhenRaw);
  if (candidates.length === 0) return null;

  for (const sourceText of candidates) {
    try {
      const parsed = timeParser.parseTimeExpression(sourceText, {
        language: sourceText.match(/[\u4e00-\u9fa5]/) ? 'zh' : 'en',
        timezone: 'Asia/Shanghai'
      });
      if (!parsed || !parsed.success) continue;

      const targetMs =
        (parsed.parsedDateTime && typeof (parsed.parsedDateTime as any).toMillis === 'function')
          ? Number((parsed.parsedDateTime as any).toMillis())
          : Number(parsed.parsedTimestamp || 0);
      if (!Number.isFinite(targetMs) || targetMs <= 0) continue;

      const nowMs = Date.now();
      const delayMs = Math.max(0, targetMs - nowMs);
      if (delayMs <= 0) continue;

      const targetISO = parsed.parsedISO || new Date(targetMs).toISOString();
      return {
        whenText: sourceText,
        fireAt: targetMs,
        delayMs,
        targetISO,
        timezone: parsed.timezone || 'Asia/Shanghai',
        parserMethod: parsed.method || ''
      };
    } catch {
      continue;
    }
  }
  return null;
}

function touchSenderState(senderKey: string): void {
  const k = normalizeSenderId(senderKey);
  if (!k) return;
  senderLastTouchedAt.set(k, Date.now());
}

function pruneReplyPolicyState(): void {
  const ttlMsRaw = getEnvInt('REPLY_POLICY_STATE_TTL_MS', 30 * 60 * 1000);
  const ttlMs = Number.isFinite(ttlMsRaw) && Number(ttlMsRaw) > 0 ? Number(ttlMsRaw) : 30 * 60 * 1000;
  const maxCancelledRaw = getEnvInt('CANCELLED_TASKS_MAX', 5000);
  const maxCancelled = Number.isFinite(maxCancelledRaw) && Number(maxCancelledRaw) > 0 ? Number(maxCancelledRaw) : 5000;

  const now = Date.now();

  for (const [senderKey, ts] of senderLastTouchedAt.entries()) {
    if (!Number.isFinite(ts) || now - ts <= ttlMs) continue;

    const q = senderQueues.get(senderKey);
    const a = activeTasks.get(senderKey);

    const hasQueue = Array.isArray(q) && q.length > 0;
    const hasActive = a && a instanceof Set && a.size > 0;

    if (!hasQueue && !hasActive) {
      senderQueues.delete(senderKey);
      activeTasks.delete(senderKey);
      gateSessions.delete(senderKey);
      senderReplyStats.delete(senderKey);
      senderLastTouchedAt.delete(senderKey);
    }
  }

  for (const [groupKey, map] of groupAttention.entries()) {
    if (!map || !(map instanceof Map)) {
      groupAttention.delete(groupKey);
      continue;
    }
    for (const [sid, ts] of map.entries()) {
      if (!Number.isFinite(ts) || now - ts > 10 * 60 * 1000) {
        map.delete(sid);
      }
    }
    if (map.size === 0) {
      groupAttention.delete(groupKey);
    }
  }

  if (cancelledTasks.size > maxCancelled) {
    cancelledTasks.clear();
  }
}

try {
  const intervalMs = readEnvInt('REPLY_POLICY_PRUNE_INTERVAL_MS', 60000);
  const timer = setInterval(() => {
    try { pruneReplyPolicyState(); } catch {}
  }, intervalMs);
  timer.unref?.();
} catch {}

function parseReplyGateReason(reason: unknown): {
  subsystem: string;
  base: string;
  baseZh: string;
  codes: string[];
  codesZh: string[];
  raw: string;
} | null {
  const raw = typeof reason === 'string' ? reason : String(reason ?? '');
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const subsystem = parts[0] || '';
  if (subsystem !== 'conversation_analyzer') return null;
  const base = parts[1] || '';
  const suffix = joinFromIndex(parts, 2, ':');
  const codes = suffix ? suffix.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const baseZh = tReplyGateBase(base);
  const codesZh = codes.map((c) => tReplyGateCode(c));
  return { subsystem, base, baseZh, codes, codesZh, raw };
}

function buildReplyGateExplainZh(gateResult: ReplyGateResult | null | undefined): {
  summary: string;
  parsed: ReturnType<typeof parseReplyGateReason> | null;
} {
  const parsed = parseReplyGateReason(gateResult?.reason);
  if (!parsed) {
    return {
      summary: typeof gateResult?.reason === 'string' ? gateResult.reason : String(gateResult?.reason ?? ''),
      parsed: null
    };
  }
  const detail = parsed.codesZh.length ? `；细项：${parsed.codesZh.join('；')}` : '';
  let policyDetail = '';
  const policy = gateResult?.debug?.analyzer?.policy;
  if (policy && typeof policy === 'object' && policy.action) {
    const details = Array.isArray(policy.details) ? policy.details : [];
    const detailTexts = details
      .map((d) => {
        if (!d || typeof d !== 'object') return '';
        const kind = d.kind ? String(d.kind) : '';
        const score = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;
        const matches = typeof d.matches === 'number' && Number.isFinite(d.matches) ? d.matches : null;
        const bits = [];
        if (kind) bits.push(kind);
        if (score != null) bits.push(`score=${score.toFixed(3)}`);
        if (matches != null) bits.push(`matches=${matches}`);
        return bits.join(',');
      })
      .filter(Boolean);
    const brief = takeFirst(detailTexts, 4);
    if (brief.length) {
      policyDetail = `；合规细节：${brief.join(' | ')}`;
    }
  }
  return {
    summary: `${parsed.baseZh}${detail}${policyDetail}`,
    parsed
  };
}

/**
 * 任务状态
 */
class Task {
  id: string;
  msg: MsgLike;
  conversationId: string;
  createdAt: number;
  senderId: string;

  constructor(msg: MsgLike, conversationId: string) {
    this.id = randomUUID();
    this.msg = msg;
    this.conversationId = conversationId;
    this.createdAt = Date.now();
    this.senderId = String(msg.sender_id ?? '');
  }
}

function normalizeSenderId(senderId: unknown): string {
  return String(senderId ?? '');
}

function buildConversationId(msg: MsgLike, senderId: unknown): string {
  const sid = normalizeSenderId(senderId ?? (msg && msg.sender_id));
  if (msg && msg.group_id) {
    return `group_${msg.group_id}_sender_${sid}`;
  }
  return `private_${sid}`;
}

function getGroupKey(groupId: unknown): string {
  return buildGroupScopeId(groupId);
}

function resetGateSessionForConversationId(conversationId: string): void {
  const key = normalizeSenderId(conversationId);
  if (!key) return;
  const session = gateSessions.get(key);
  if (session) {
    session.value = 0;
    session.lastTs = 0;
  }
}

function updateGateSessionAndCheck(
  msg: MsgLike,
  senderId: string,
  config: ReplyPolicyConfig,
  gateProb: number,
  activeCount: number
): boolean {
  if (!msg || msg.type !== 'group' || !msg.group_id) return true;
  if (!Number.isFinite(gateProb) || gateProb <= 0) return true;

  const baseline = Number.isFinite(config.replyGateAccumBaseline)
    ? config.replyGateAccumBaseline
    : 0.15;
  const threshold = Number.isFinite(config.replyGateAccumThreshold)
    ? config.replyGateAccumThreshold
    : 1.0;
  const halflifeMs = Number.isFinite(config.replyGateAccumHalflifeMs) && config.replyGateAccumHalflifeMs > 0
    ? config.replyGateAccumHalflifeMs
    : 180000;

  const eff = gateProb - baseline;
  const now = Date.now();
  const key = buildConversationId(msg, senderId);
  let session = gateSessions.get(key);
  if (!session) {
    session = { value: 0, lastTs: now };
    gateSessions.set(key, session);
  }

  const lastTs = Number.isFinite(session.lastTs) && session.lastTs > 0 ? session.lastTs : now;
  let value = Number.isFinite(session.value) ? session.value : 0;
  const dt = now - lastTs;
  if (dt > 0 && halflifeMs > 0) {
    const decay = Math.pow(0.5, dt / halflifeMs);
    value *= decay;
  }
  if (eff > 0) {
    value += eff;
  }

  session.value = value;
  session.lastTs = now;

  if (value < threshold) {
    return false;
  }

  if (activeCount > 0) {
    session.value = 0;
    session.lastTs = now;
    return false;
  }

  session.value = 0;
  session.lastTs = now;
  return true;
}

function getOrInitSenderStats(senderId: unknown): ReplyStats {
  const key = normalizeSenderId(senderId);
  if (!senderReplyStats.has(key)) {
    senderReplyStats.set(key, { timestamps: [] });
  }
  return senderReplyStats.get(key) || { timestamps: [] };
}

function getOrInitGroupStats(groupId: unknown): ReplyStats {
  const key = getGroupKey(groupId);
  if (!groupReplyStats.has(key)) {
    groupReplyStats.set(key, { timestamps: [] });
  }
  return groupReplyStats.get(key) || { timestamps: [] };
}

function pruneTimestamps(
  timestamps: number[],
  now: number,
  windowMs: number
): { list: number[]; count: number; last: number | null } {
  if (!Array.isArray(timestamps) || !windowMs || windowMs <= 0) {
    return { list: [], count: 0, last: null };
  }
  const list: number[] = [];
  let last = null;
  for (const t of timestamps) {
    if (now - t <= windowMs) {
      list.push(t);
      last = t;
    }
  }
  return { list, count: list.length, last };
}

function shouldPassAttentionWindow(
  msg: MsgLike,
  senderId: string,
  config: ReplyPolicyConfig,
  options: AttentionWindowOptions = {}
): boolean {
  if (!config.attentionEnabled) return true;
  if (!msg || !msg.group_id) return true;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return true;
  if (!windowMs || windowMs <= 0) return true;

  const groupKey = getGroupKey(msg.group_id);
  const now = Date.now();
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }

  for (const [sid, ts] of map.entries()) {
    if (now - ts > windowMs) {
      map.delete(sid);
    }
  }

  if (map.size < maxSenders) {
    return true;
  }

  if (map.has(senderId)) {
    return true;
  }

  if (options.isExplicitMention) {
    return true;
  }

  return false;
}

function isSenderInAttentionList(
  msg: MsgLike,
  senderId: string,
  config: ReplyPolicyConfig
): boolean {
  if (!config.attentionEnabled) return true;
  if (!msg || !msg.group_id) return true;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return true;
  if (!windowMs || windowMs <= 0) return true;

  const groupKey = getGroupKey(msg.group_id);
  const now = Date.now();
  let map = groupAttention.get(groupKey);
  if (!map) {
    return false;
  }

  for (const [sid, ts] of map.entries()) {
    if (now - ts > windowMs) {
      map.delete(sid);
    }
  }

  return map.has(senderId);
}

function markAttentionWindow(
  msg: MsgLike,
  senderId: string,
  config: ReplyPolicyConfig
): void {
  if (!config.attentionEnabled) return;
  if (!msg || !msg.group_id) return;
  const maxSenders = config.attentionMaxSenders;
  const windowMs = config.attentionWindowMs;
  if (!maxSenders || maxSenders <= 0) return;
  if (!windowMs || windowMs <= 0) return;

  const groupKey = getGroupKey(msg.group_id);
  let map = groupAttention.get(groupKey);
  if (!map) {
    map = new Map();
    groupAttention.set(groupKey, map);
  }
  map.set(senderId, Date.now());
}

function evaluateGroupFatigue(
  msg: MsgLike,
  config: ReplyPolicyConfig,
  options: AttentionWindowOptions = {}
): FatigueResult {
  const result: FatigueResult = { pass: true, reasonCode: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.groupFatigueEnabled) return result;
  if (!msg || msg.type !== 'group' || !msg.group_id) return result;

  const windowMs = config.groupReplyWindowMs;
  const baseLimit = config.groupReplyBaseLimit;
  const minInterval = config.groupReplyMinIntervalMs;
  let factor = Number.isFinite(config.groupReplyBackoffFactor) ? config.groupReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.groupReplyMaxBackoffMultiplier) ? config.groupReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitGroupStats(msg.group_id);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reasonCode = REASON_CODE.local_group_fatigue;
    return result;
  }

  return result;
}

function evaluateSenderFatigue(
  msg: MsgLike,
  senderId: string,
  config: ReplyPolicyConfig,
  options: AttentionWindowOptions = {}
): FatigueResult {
  const result: FatigueResult = { pass: true, reasonCode: '', count: 0, fatigue: 0, lastAgeSec: null };
  if (!config.userFatigueEnabled) return result;
  if (!msg || msg.type !== 'group') return result;

  const windowMs = config.userReplyWindowMs;
  const baseLimit = config.userReplyBaseLimit;
  const minInterval = config.userReplyMinIntervalMs;
  let factor = Number.isFinite(config.userReplyBackoffFactor) ? config.userReplyBackoffFactor : 2;
  let maxMult = Number.isFinite(config.userReplyMaxBackoffMultiplier) ? config.userReplyMaxBackoffMultiplier : 8;
  if (!windowMs || windowMs <= 0 || !baseLimit || baseLimit <= 0 || !minInterval || minInterval <= 0) {
    return result;
  }
  if (!Number.isFinite(factor) || factor <= 1) factor = 2;
  if (!Number.isFinite(maxMult) || maxMult <= 1) maxMult = 8;

  const now = Date.now();
  const stats = getOrInitSenderStats(senderId);
  const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
  stats.timestamps = pruned.list;
  result.count = pruned.count;
  result.lastAgeSec = pruned.last ? (now - pruned.last) / 1000 : null;

  if (pruned.count === 0 || !pruned.last) {
    result.fatigue = 0;
    return result;
  }

  const ratio = pruned.count / baseLimit;
  const clipped = Math.min(Math.max(ratio, 0), 2);
  result.fatigue = clipped / 2; // 映射到 0-1

  if (ratio <= 1) {
    return result;
  }

  const overload = Math.max(0, Math.floor(pruned.count - baseLimit));
  const mult = Math.min(Math.pow(factor, overload), maxMult);
  const requiredInterval = minInterval * mult;
  const elapsed = now - pruned.last;

  const isImportant = !!options.isExplicitMention || !!options.mentionedByName;
  if (!isImportant && elapsed < requiredInterval) {
    result.pass = false;
    result.reasonCode = REASON_CODE.local_sender_fatigue;
    return result;
  }

  return result;
}

function recordReplyForFatigue(msg: MsgLike, senderId: string, config: ReplyPolicyConfig): void {
  if (!msg || msg.type !== 'group') return;
  const now = Date.now();

  if (config.userFatigueEnabled) {
    const windowMs = config.userReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitSenderStats(senderId);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }

  if (config.groupFatigueEnabled && msg.group_id) {
    const windowMs = config.groupReplyWindowMs;
    if (windowMs && windowMs > 0) {
      const stats = getOrInitGroupStats(msg.group_id);
      const pruned = pruneTimestamps(stats.timestamps, now, windowMs);
      pruned.list.push(now);
      stats.timestamps = pruned.list;
    }
  }
}

/**
 * 获取或创建用户队列
 */
function getSenderQueue(senderId: string): TaskItem[] {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  let queue = senderQueues.get(key);
  if (!queue) {
    queue = [];
    senderQueues.set(key, queue);
  }
  return queue;
}

/**
 * 获取用户当前活跃任务数
 */
export function getActiveTaskCount(senderId?: string | null): number {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  let set = activeTasks.get(key);
  if (!set) {
    set = new Set();
    activeTasks.set(key, set);
  }
  return set.size;
}

function getActiveTaskSet(senderId: string): Set<string> {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  let set = activeTasks.get(key);
  if (!set) {
    set = new Set();
    activeTasks.set(key, set);
  }
  return set;
}

export function markTasksCancelledForSender(senderId: string): void {
  const set = getActiveTaskSet(senderId);
  if (!set || set.size === 0) {
    return;
  }
  for (const taskId of set) {
    if (taskId) {
      cancelledTasks.add(taskId);
    }
  }
  const shortIds = Array.from(set).map((id) => (id ? String(id).substring(0, 8) : 'null'));
  logger.info(`标记取消任务: sender=${normalizeSenderId(senderId)}, tasks=[${shortIds.join(',')}]`);
}

export function isTaskCancelled(taskId: string): boolean {
  if (!taskId) return false;
  return cancelledTasks.has(taskId);
}

export function clearCancelledTask(taskId?: string | null): void {
  if (!taskId) return;
  cancelledTasks.delete(taskId);
}

export function resetReplyGateForSender(senderId: string): void {
  if (!senderId) return;
  resetGateSessionForConversationId(senderId);
}

/**
 * 添加活跃任务
 */
function addActiveTask(senderId: string, taskId: string): void {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (!activeTasks.has(key)) {
    activeTasks.set(key, new Set());
  }
  activeTasks.get(key)!.add(taskId);
  logger.debug(`活跃任务+: ${key} 添加任务 ${taskId?.substring(0,8)}, 当前活跃数: ${activeTasks.get(key)!.size}`);
  resetGateSessionForConversationId(senderId);
}

/**
 * 移除活跃任务并尝试处理队列
 */
function removeActiveTask(senderId: string, taskId: string): void {
  const key = normalizeSenderId(senderId);
  touchSenderState(key);
  if (activeTasks.has(key)) {
    activeTasks.get(key)!.delete(taskId);
    logger.debug(`活跃任务-: ${key} 移除任务 ${taskId?.substring(0,8)}, 剩余活跃数: ${activeTasks.get(key)!.size}`);
  }
}

/**
 * 解析环境变量中的bot名称列表
 */
function parseBotNames(): string[] {
  const names = String(getEnv('BOT_NAMES', '') ?? '');
  if (!names.trim()) return [];
  return names.split(',').map(n => n.trim()).filter(Boolean);
}

/**
 * 解析配置参数
 */
function getConfig(): ReplyPolicyConfig {
  const botNames = parseBotNames();
  const attentionWindowMs = readEnvInt('ATTENTION_WINDOW_MS', 120000);
  const attentionMaxSenders = readEnvInt('ATTENTION_MAX_SENDERS', 3);
  const replyFollowupWindowSecRaw = readEnvInt('REPLY_DECISION_FOLLOWUP_WINDOW_SEC', 180);
  const replyFollowupWindowSec = replyFollowupWindowSecRaw > 0 ? replyFollowupWindowSecRaw : 0;
  return {
    // bot 名称列表（支持多个昵称，仅用于简单“是否被提及”的判断）
    botNames,
    // Per-sender 最大并发数
    maxConcurrentPerSender: readEnvInt('MAX_CONCURRENT_PER_SENDER', 1),
    // 队列任务最大等待时间（毫秒）
    queueTimeout: readEnvInt('QUEUE_TIMEOUT', 30000),
    // 显式 @ 是否必须回复（true=显式 @ 一律回复；false=交给模型和人设决定）
    mentionMustReply: readEnvBool('MENTION_MUST_REPLY', false),
    pureLocalGating: readEnvBool('PURE_LOCAL_REPLY_GATING', true),
    replyFollowupWindowSec,
    attentionEnabled: readEnvBool('ATTENTION_WINDOW_ENABLED', true),
    attentionWindowMs,
    attentionMaxSenders,
    // 群/用户疲劳控制（短期窗口 + 指数退避）
    userFatigueEnabled: readEnvBool('USER_FATIGUE_ENABLED', true),
    userReplyWindowMs: readEnvInt('USER_REPLY_WINDOW_MS', 300000),
    userReplyBaseLimit: readEnvInt('USER_REPLY_BASE_LIMIT', 5),
    userReplyMinIntervalMs: readEnvInt('USER_REPLY_MIN_INTERVAL_MS', 10000),
    userReplyBackoffFactor: readEnvFloat('USER_REPLY_BACKOFF_FACTOR', 2),
    userReplyMaxBackoffMultiplier: readEnvFloat('USER_REPLY_MAX_BACKOFF_MULTIPLIER', 8),
    groupFatigueEnabled: readEnvBool('GROUP_FATIGUE_ENABLED', true),
    groupReplyWindowMs: readEnvInt('GROUP_REPLY_WINDOW_MS', 300000),
    groupReplyBaseLimit: readEnvInt('GROUP_REPLY_BASE_LIMIT', 30),
    groupReplyMinIntervalMs: readEnvInt('GROUP_REPLY_MIN_INTERVAL_MS', 2000),
    groupReplyBackoffFactor: readEnvFloat('GROUP_REPLY_BACKOFF_FACTOR', 2),
    groupReplyMaxBackoffMultiplier: readEnvFloat('GROUP_REPLY_MAX_BACKOFF_MULTIPLIER', 8),
    replyGateAccumBaseline: readEnvFloat('REPLY_GATE_ACCUM_BASELINE', 0.15),
    replyGateAccumThreshold: readEnvFloat('REPLY_GATE_ACCUM_THRESHOLD', 1),
    replyGateAccumHalflifeMs: readEnvInt('REPLY_GATE_ACCUM_HALFLIFE_MS', 180000),
    replyFollowupMinGapMs: readEnvInt('REPLY_DECISION_FOLLOWUP_MIN_GAP_MS', 0),
    replyFollowupMaxCount: readEnvInt('REPLY_DECISION_FOLLOWUP_MAX_COUNT', 0),
    replyFollowupBoost: readEnvFloat('REPLY_DECISION_FOLLOWUP_BOOST', 0),
    replySimilarityThreshold: readEnvFloat('REPLY_SIMILARITY_THRESHOLD', 0)
  };
}

/**
 * 处理队列中的待定任务
 */
async function processQueue(senderId: string): Promise<TaskItem | null> {
  const config = getConfig();
  const queue = getSenderQueue(senderId);
  
  // 只补充一个任务，由上层驱动继续触发
  if (getActiveTaskCount(senderId) < config.maxConcurrentPerSender && queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      return null;
    }
    
    // 检查是否超时
    const age = Date.now() - task.createdAt;
    if (age > config.queueTimeout) {
      logger.warn(`队列超时: 任务 ${task.id} 等待${age}ms，已放弃`);
      return null;
    }
    
    // 执行任务
    logger.debug(`队列补充: 任务 ${task.id} 开始处理`);
    addActiveTask(senderId, task.id);
    // 返回给上层处理
    return task;
  }
  return null;
}

/**
 * 完成任务（供外部调用）
 */
export async function completeTask(senderId: string, taskId: string): Promise<TaskItem | null> {
  removeActiveTask(senderId, taskId);
  logger.debug(`任务完成: sender=${normalizeSenderId(senderId)}, task=${taskId}`);
  const next = await processQueue(senderId);
  return next;
}

/**
 * 智能回复决策 v2.0
 * @param {Object} msg - 消息对象
 * @returns {Promise<ShouldReplyDecision>}
 */
export async function shouldReply(
  msg: MsgLike,
  options: { decisionContext?: Record<string, unknown> | null; forceReply?: boolean; source?: string } = {}
): Promise<ShouldReplyDecision> {
  const config = getConfig();
  const senderIdRaw = normalizeSenderId(msg.sender_id);
  const decisionContext = options.decisionContext || null;
  const source = options && typeof options.source === 'string' ? options.source : '';
  const forceReply = !!(options && options.forceReply);

  const conversationId = buildConversationId(msg, senderIdRaw);
  const senderKey = conversationId;
  if (forceReply) {
    const taskId = randomUUID();
    addActiveTask(senderKey, taskId);
    const reasonFields = buildReasonFields(REASON_CODE.force_reply, {
      reasonDetail: 'force_reply'
    });
    return {
      needReply: true,
      action: 'action',
      ...reasonFields,
      decisionSource: 'override_force',
      decisionTrace: { source: 'override_force', forceReply: true },
      mandatory: true,
      probability: 1.0,
      conversationId,
      taskId
    };
  }
  // 私聊：默认必回，但动作（action/short/delay）优先由 reply_gate_decision 决定。
  if (msg.type === 'private') {
    const taskId = randomUUID();
    addActiveTask(senderKey, taskId);

    try {
      const planOptions: {
        signals: PlanGroupSignalsLike;
        context?: Record<string, unknown>;
        bot: { self_id: string; bot_names: Array<string | number> };
      } = {
        signals: {
          mentionedByAt: false,
          mentionedByName: false,
          mentionedNames: [],
          mentionedNameHitCount: 0,
          mentionedNameHitsInText: false,
          mentionedNameHitsInSummary: false,
          senderReplyCountWindow: 0,
          groupReplyCountWindow: 0,
          senderFatigue: 0,
          groupFatigue: 0,
          isFollowupAfterBotReply: false,
          activeTaskCount: getActiveTaskCount(senderKey)
        },
        bot: {
          self_id: msg?.self_id != null ? String(msg.self_id) : '',
          bot_names: Array.isArray(config.botNames) ? config.botNames : []
        }
      };
      if (decisionContext) planOptions.context = decisionContext;

      const intervention = await planGroupReplyDecision(msg, planOptions);
      if (intervention && typeof intervention.shouldReply === 'boolean') {
        const reasonText = typeof intervention.reason === 'string' && intervention.reason.trim()
          ? intervention.reason.trim()
          : '';
        const actionFromIntervention = normalizeReplyAction(
          (intervention as { action?: unknown }).action,
          true
        );

        if (actionFromIntervention === 'delay') {
          const delayWhenCandidate =
            typeof (intervention as { delayWhen?: unknown }).delayWhen === 'string'
              ? (intervention as { delayWhen?: string }).delayWhen
              : '';
          const privateDelayWhen = String(delayWhenCandidate || '').trim();
          if (!privateDelayWhen) {
            logger.info(`私聊消息，LLM给出 delay 但缺少 delay_when，尝试按用户原始文本解析 (task=${taskId})`);
          }
          const privateDelayPlan = buildDelayPlanFromText(msg, privateDelayWhen);
          if (privateDelayPlan) {
            const whenText = String(privateDelayPlan.whenText || '').trim();
            logger.info(`私聊消息，LLM判定延迟回复 (action=delay, delayWhen=${whenText || 'n/a'}, task=${taskId})`);
            const reasonFields = buildReasonFields(REASON_CODE.private_llm_delay, {
              reasonDetail: reasonText || 'ReplyIntervention: private delay',
              explainKey: reasonText ? 'private_llm_delay_with_reason' : REASON_CODE.private_llm_delay,
              explainParams: { reason: reasonText }
            });
            return {
              needReply: true,
              action: 'delay',
              delay: privateDelayPlan,
              ...reasonFields,
              decisionSource: 'llm_private_delay',
              mandatory: true,
              probability: 1.0,
              conversationId,
              taskId
            };
          }
          logger.info(`私聊消息，LLM给出 delay 但 delay_when/原始文本均无法解析，按 action 处理 (task=${taskId})`);
        }

        if (actionFromIntervention === 'short') {
          logger.info(`私聊消息，LLM判定短回复 (action=short, task=${taskId})`);
          const reasonFields = buildReasonFields(REASON_CODE.private_llm_short, {
            reasonDetail: reasonText || 'ReplyIntervention: private short',
            explainKey: reasonText ? 'private_llm_short_with_reason' : REASON_CODE.private_llm_short,
            explainParams: { reason: reasonText }
          });
          return {
            needReply: true,
            action: 'short',
            ...reasonFields,
            decisionSource: 'llm_private_short',
            mandatory: true,
            probability: 1.0,
            conversationId,
            taskId
          };
        }

        if (actionFromIntervention === 'silent') {
          logger.info(`私聊消息，LLM判定 silent，但私聊强制覆盖为 action (task=${taskId})`);
        } else {
          logger.info(`私聊消息，LLM判定正常回复 (action=action, task=${taskId})`);
        }
        const reasonFields = buildReasonFields(REASON_CODE.private_llm_action, {
          reasonDetail: reasonText || 'ReplyIntervention: private action',
          explainKey: reasonText ? 'private_llm_action_with_reason' : REASON_CODE.private_llm_action,
          explainParams: { reason: reasonText }
        });
        return {
          needReply: true,
          action: 'action',
          ...reasonFields,
          decisionSource: 'llm_private_action',
          mandatory: true,
          probability: 1.0,
          conversationId,
          taskId
        };
      }
    } catch (e) {
      logger.debug('私聊 reply_gate_decision 调用失败，按 action 处理', { err: String(e) });
    }

    logger.info(`私聊消息，LLM决策不可用，按 action 处理 (task=${taskId})`);
    const reasonFields = buildReasonFields(REASON_CODE.private_llm_unavailable, {
      reasonDetail: 'private_llm_unavailable'
    });
    return {
      needReply: true,
      action: 'action',
      ...reasonFields,
      decisionSource: 'llm_private_unavailable',
      mandatory: true,
      probability: 1.0,
      conversationId,
      taskId
    };
  }

  // 群聊：并发和队列控制 + 轻量 LLM 决策是否回复
  const activeCount = getActiveTaskCount(senderKey);

  if (activeCount >= config.maxConcurrentPerSender) {
    const task = new Task(msg, conversationId);
    const queue = getSenderQueue(senderKey);
    queue.push(task);
    logger.debug(`并发限制: sender=${senderKey} 活跃=${activeCount}/${config.maxConcurrentPerSender}, 队列长度=${queue.length}`);
    const reasonFields = buildReasonFields(REASON_CODE.local_concurrency_queue, {
      reasonDetail: 'local_concurrency_queue'
    });
    return {
      needReply: false,
      action: 'silent',
      ...reasonFields,
      decisionSource: 'local_concurrency_queue',
      mandatory: false,
      probability: 0.0,
      conversationId,
      taskId: null
    };
  }

  const isGroup = msg.type === 'group';
  const selfId = msg.self_id;
  let attentionSession: AttentionSession | null = null;
  if (isGroup && msg.group_id) {
    try {
      const stats = await loadAttentionStats(msg.group_id, senderIdRaw);
      if (stats && typeof stats === 'object') {
        const considered = Number.isFinite(stats.consideredCount) ? stats.consideredCount : 0;
        const replied = Number.isFinite(stats.repliedCount) ? stats.repliedCount : 0;
        const avgAnalyzerProb =
          considered > 0 && typeof stats.sumAnalyzerProb === 'number'
            ? stats.sumAnalyzerProb / considered
            : undefined;
        const avgGateProb =
          considered > 0 && typeof stats.sumGateProb === 'number'
            ? stats.sumGateProb / considered
            : undefined;
        const avgFusedProb =
          considered > 0 && typeof stats.sumFusedProb === 'number'
            ? stats.sumFusedProb / considered
            : undefined;
        const replyRatio = considered > 0 ? (replied / considered) : undefined;
        const session: AttentionSession = {
          consideredCount: considered,
          repliedCount: replied
        };
        if (typeof avgAnalyzerProb === 'number') session.avgAnalyzerProb = avgAnalyzerProb;
        if (typeof avgGateProb === 'number') session.avgGateProb = avgGateProb;
        if (typeof avgFusedProb === 'number') session.avgFusedProb = avgFusedProb;
        if (typeof replyRatio === 'number') session.replyRatio = replyRatio;
        attentionSession = session;
      }
    } catch (e) {
      logger.debug(`loadAttentionStats 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }
  const isExplicitMention = Array.isArray(msg.at_users) && msg.at_users.some(at => String(at) === String(selfId));
  const groupInfo = msg.group_id ? `群${msg.group_id}` : '私聊';

  // 基于 BOT_NAMES 的名称提及检测（仅作为信号，不做硬编码规则）
  let mentionedByName = false;
  const mentionedNames: string[] = [];
  let mentionedNameHitsInText = false;
  let mentionedNameHitsInSummary = false;
  if (isGroup && Array.isArray(config.botNames) && config.botNames.length > 0) {
    const textLower = ((msg.text || '') + '').toLowerCase();
    const summaryLower = ((((msg as any).summary_text || (msg as any).objective_text || msg.summary || '') + '')).toLowerCase();
    const hits: string[] = [];
    if (textLower || summaryLower) {
      for (const name of config.botNames) {
        const raw = (name || '').trim();
        if (!raw) continue;
        const n = raw.toLowerCase();
        const hitText = !!textLower && textLower.includes(n);
        const hitSummary = !!summaryLower && summaryLower.includes(n);
        if (hitText || hitSummary) {
          hits.push(raw);
          if (hitText) mentionedNameHitsInText = true;
          if (hitSummary) mentionedNameHitsInSummary = true;
        }
      }
    }
    if (hits.length > 0) {
      const uniq = Array.from(new Set(hits));
      mentionedByName = true;
      mentionedNames.push(...uniq);
    }
  }

  let inAttentionList = true;
  if (isGroup && msg.group_id) {
    inAttentionList = isSenderInAttentionList(msg, senderIdRaw, config);
    if (!inAttentionList && !isExplicitMention && !mentionedByName) {
      const reasonFields = buildReasonFields(REASON_CODE.local_attention_list, {
        reasonDetail: 'local_attention_list'
      });
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reasonFields.explainZh}`);
      return {
        needReply: false,
        action: 'silent',
        ...reasonFields,
        decisionSource: 'local_attention_list',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }

  if (isGroup) {
    const pass = shouldPassAttentionWindow(msg, senderIdRaw, config, {
      isExplicitMention: isExplicitMention || mentionedByName
    });
    if (!pass) {
      const reasonFields = buildReasonFields(REASON_CODE.local_attention_window, {
        reasonDetail: 'local_attention_window'
      });
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reasonFields.explainZh}`);
      return {
        needReply: false,
        action: 'silent',
        ...reasonFields,
        decisionSource: 'local_attention_window',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }
  let senderFatigueInfo: FatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };
  let groupFatigueInfo: FatigueInfo = { count: 0, fatigue: 0, lastAgeSec: null };
  let senderFatiguePass = true;
  let senderFatigueReason = '';
  let groupFatiguePass = true;
  let groupFatigueReason = '';

  if (isGroup) {
    const gf = evaluateGroupFatigue(msg, config, {
      isExplicitMention,
      mentionedByName
    });
    groupFatigueInfo = { count: gf.count, fatigue: gf.fatigue, lastAgeSec: gf.lastAgeSec };
    groupFatiguePass = !!gf.pass;
    groupFatigueReason = gf.reasonCode || '';

    const uf = evaluateSenderFatigue(msg, senderIdRaw, config, {
      isExplicitMention,
      mentionedByName
    });
    senderFatigueInfo = { count: uf.count, fatigue: uf.fatigue, lastAgeSec: uf.lastAgeSec };
    senderFatiguePass = !!uf.pass;
    senderFatigueReason = uf.reasonCode || '';
    logger.debug(
      `[${groupInfo}] 疲劳统计: groupCount=${groupFatigueInfo.count}, groupFatigue=${groupFatigueInfo.fatigue.toFixed(2)}, senderCount=${senderFatigueInfo.count}, senderFatigue=${senderFatigueInfo.fatigue.toFixed(2)}, senderLastReplyAgeSec=${senderFatigueInfo.lastAgeSec ?? 'null'}`
    );
  }

  let isFollowupAfterBotReply = false;
  if (
    typeof senderFatigueInfo.lastAgeSec === 'number' &&
    senderFatigueInfo.lastAgeSec >= 0 &&
    Number.isFinite(config.replyFollowupWindowSec) &&
    config.replyFollowupWindowSec > 0
  ) {
    isFollowupAfterBotReply = senderFatigueInfo.lastAgeSec <= config.replyFollowupWindowSec;
  }

  if (isGroup && config.pureLocalGating) {
    if (!groupFatiguePass) {
      const reasonCode = groupFatigueReason || REASON_CODE.local_group_fatigue;
      const reasonFields = buildReasonFields(reasonCode, { reasonDetail: reasonCode });
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reasonFields.explainZh}`);
      return {
        needReply: false,
        action: 'silent',
        ...reasonFields,
        decisionSource: 'local_group_fatigue',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
    if (!senderFatiguePass) {
      const reasonCode = senderFatigueReason || REASON_CODE.local_sender_fatigue;
      const reasonFields = buildReasonFields(reasonCode, { reasonDetail: reasonCode });
      logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${reasonFields.explainZh}`);
      return {
        needReply: false,
        action: 'silent',
        ...reasonFields,
        decisionSource: 'local_sender_fatigue',
        mandatory: false,
        probability: 0.0,
        conversationId,
        taskId: null
      };
    }
  }

  const policyConfig = {
    mentionMustReply: !!config.mentionMustReply,
    followupWindowSec: Number.isFinite(config.replyFollowupWindowSec)
      ? config.replyFollowupWindowSec
      : 0,
    attention: {
      enabled: !!config.attentionEnabled,
      windowMs: config.attentionWindowMs,
      maxSenders: config.attentionMaxSenders
    },
    userFatigue: {
      enabled: !!config.userFatigueEnabled,
      windowMs: config.userReplyWindowMs,
      baseLimit: config.userReplyBaseLimit,
      minIntervalMs: config.userReplyMinIntervalMs,
      backoffFactor: config.userReplyBackoffFactor,
      maxBackoffMultiplier: config.userReplyMaxBackoffMultiplier
    },
    groupFatigue: {
      enabled: !!config.groupFatigueEnabled,
      windowMs: config.groupReplyWindowMs,
      baseLimit: config.groupReplyBaseLimit,
      minIntervalMs: config.groupReplyMinIntervalMs,
      backoffFactor: config.groupReplyBackoffFactor,
      maxBackoffMultiplier: config.groupReplyMaxBackoffMultiplier
    }
  };

  let probability = 1.0;
  let gateProb: number | null = null;
  let reasonCode: string = REASON_CODE.final_enter_main;
  let reason = isGroup ? 'group_message' : 'message';
  let mandatory = false;
  let shouldReplyFlag = true;
  let replyAction: ReplyAction = 'action';
  let delayPlan: DelayPlan | null = null;
  let gateResult: ReplyGateResult | null = null;
  let explainZh = '';
  let decisionSource = 'local_policy';
  const decisionTrace: DecisionTrace = {
    source,
    isGroup,
    isExplicitMention,
    mentionedByName: !!mentionedByName,
    isFollowupAfterBotReply,
    pureLocalGating: !!config.pureLocalGating,
    useLlmIntervention: null,
    gate: null,
    gateAccum: null,
    llmDecision: null
  };

  // 群聊 + 非显式 @ 的消息先通过 ReplyGate 进行价值预判：
  //  - decision = 'ignore'  => 直接不回
  //  - decision = 'llm'     => 继续交给 XML 决策 LLM
  if (isGroup && !isExplicitMention && !mentionedByName) {
    try {
      const gateSignals: ReplyGateSignalsLike = {
        mentionedByAt: isExplicitMention,
        mentionedByName,
        senderReplyCountWindow: senderFatigueInfo.count,
        groupReplyCountWindow: groupFatigueInfo.count,
        senderFatigue: senderFatigueInfo.fatigue,
        groupFatigue: groupFatigueInfo.fatigue,
        isFollowupAfterBotReply
      };
      if (attentionSession) gateSignals.attentionSession = attentionSession;
      gateResult = assessReplyWorth(msg, gateSignals, { decisionContext });

      if (gateResult && typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)) {
        const gateDecision: {
          decision?: string;
          normalizedScore?: number | null;
          reason?: string;
          analyzerProb?: number | null;
        } = {
          normalizedScore: gateResult.normalizedScore,
          analyzerProb: getGateAnalyzerProb(gateResult)
        };
        if (typeof gateResult.decision === 'string') gateDecision.decision = gateResult.decision;
        if (typeof gateResult.reason === 'string') gateDecision.reason = gateResult.reason;
        decisionTrace.gate = gateDecision;
      }

      if (gateResult && gateResult.decision === 'ignore') {
        const gateReason = `ReplyGate: ${gateResult.reason || 'low_interest_score'}`;
        const explain = buildReplyGateExplainZh(gateResult);
        explainZh = explain?.summary || '';
        decisionSource = 'local_reply_gate';
        reasonCode = REASON_CODE.local_reply_gate_ignore;
        const gateProbPercent =
          typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)
            ? (gateResult.normalizedScore * 100).toFixed(1)
            : '0.0';
        const analyzerProb = getGateAnalyzerProb(gateResult);
        const analyzerProbPercent =
          typeof analyzerProb === 'number' ? (analyzerProb * 100).toFixed(1) : 'null';

        logger.info(
          `[${groupInfo}] 用户${senderIdRaw} 预判为不回复: ${explainZh || explainByReasonCode(REASON_CODE.local_reply_gate_ignore)} (gateProb=${gateProbPercent}%, analyzerProb=${analyzerProbPercent}%, raw=${gateReason})`
        );
        if (isGroup && msg.group_id) {
          try {
            const analyzerProb = getGateAnalyzerProb(gateResult);
            const gateP =
              typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)
                ? gateResult.normalizedScore
                : null;
            const payload: AttentionUpdatePayloadLike = {
              groupId: msg.group_id,
              senderId: senderIdRaw,
              fusedProb: 0,
              didReply: false
            };
            if (typeof analyzerProb === 'number') payload.analyzerProb = analyzerProb;
            if (typeof gateP === 'number') payload.gateProb = gateP;
            await updateAttentionStatsAfterDecision(payload);
          } catch (e) {
            logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
              err: String(e)
            });
          }
        }
        const reasonFields = buildReasonFields(reasonCode, {
          reasonDetail: gateReason,
          explainFallback: explainZh || explainByReasonCode(REASON_CODE.local_reply_gate_ignore)
        });
        return {
          needReply: false,
          action: 'silent',
          ...reasonFields,
          decisionSource,
          decisionTrace,
          mandatory: false,
          probability: gateResult.normalizedScore ?? 0,
          conversationId,
          taskId: null
        };
      }
      // 其余情况（包括 gateResult.decision === 'llm' 或 gateResult 为空，
      // 以及 follow-up 但未被 policy_blocked 的 decision === 'ignore'）
      // 继续走后面的 planGroupReplyDecision XML 决策，并保留 gate 概率用于后续融合
      if (gateResult && typeof gateResult.normalizedScore === 'number' && Number.isFinite(gateResult.normalizedScore)) {
        const p = gateResult.normalizedScore;
        gateProb = p < 0 ? 0 : p > 1 ? 1 : p;
        if (config.pureLocalGating && !isFollowupAfterBotReply) {
          probability = gateProb;
        }
      }
    } catch (e) {
      logger.debug(`ReplyGate 预判失败，回退为正常 LLM 决策: ${groupInfo} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }

  if (isGroup && msg.group_id && !isExplicitMention && !mentionedByName && gateProb != null) {
    // 对于来自延迟聚合（改意愿后合并）的新意图，放宽 ReplyGateAccum：
    // - 仍然更新 attentionStats 统计
    // - 但不以 "below_threshold_or_busy" 作为硬门禁，避免用户明确改意愿后再次被吞掉
    const skipAccumThrottling = source === 'pending_merged' || isFollowupAfterBotReply;

    if (!skipAccumThrottling) {
      const allowByAccum = updateGateSessionAndCheck(msg, senderIdRaw, config, gateProb, activeCount);
      if (!allowByAccum) {
        decisionTrace.gateAccum = { allow: false, gateProb };
        try {
          const analyzerProb = getGateAnalyzerProb(gateResult);
          const payload: AttentionUpdatePayloadLike = {
            groupId: msg.group_id,
            senderId: senderIdRaw,
            fusedProb: 0,
            didReply: false
          };
          if (typeof analyzerProb === 'number') payload.analyzerProb = analyzerProb;
          if (typeof gateProb === 'number') payload.gateProb = gateProb;
          await updateAttentionStatsAfterDecision(payload);
        } catch (e) {
          logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
            err: String(e)
          });
        }
        const reasonAccum = 'ReplyGateAccum: below_threshold_or_busy';
        reasonCode = REASON_CODE.local_reply_gate_accum;
        explainZh = explainByReasonCode(REASON_CODE.local_reply_gate_accum);
        decisionSource = 'local_reply_gate_accum';
        logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${explainZh} (raw=${reasonAccum}, gateProb=${(gateProb * 100).toFixed(1)}%)`);
        const reasonFields = buildReasonFields(reasonCode, {
          reasonDetail: reasonAccum,
          explainFallback: explainZh
        });
        return {
          needReply: false,
          action: 'silent',
          ...reasonFields,
          decisionSource,
          decisionTrace,
          mandatory: false,
          probability: gateProb,
          conversationId,
          taskId: null
        };
      }
    } else {
      decisionTrace.gateAccum = { allow: true, gateProb, skip: true };
      // 仅记录一次统计，表明在高负载/节流场景下仍然尊重用户新的明确意图
      try {
        const analyzerProb = getGateAnalyzerProb(gateResult);
        const payload: AttentionUpdatePayloadLike = {
          groupId: msg.group_id,
          senderId: senderIdRaw,
          fusedProb: probability,
          didReply: true
        };
        if (typeof analyzerProb === 'number') payload.analyzerProb = analyzerProb;
        if (typeof gateProb === 'number') payload.gateProb = gateProb;
        await updateAttentionStatsAfterDecision(payload);
      } catch (e) {
        logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
          err: String(e)
        });
      }
      logger.info(`[${groupInfo}] 延迟聚合场景放宽 ReplyGateAccum: sender=${senderIdRaw}, gateProb=${gateProb}`);
    }
  }

  const useLlmIntervention = isGroup && (!config.pureLocalGating || isExplicitMention || mentionedByName || isFollowupAfterBotReply);
  decisionTrace.useLlmIntervention = useLlmIntervention;

  logger.debug(
    `[${groupInfo}] 决策路径: useLlm=${useLlmIntervention} (pureLocalGating=${!!config.pureLocalGating}, explicitAt=${isExplicitMention}, mentionedByName=${!!mentionedByName}, followup=${isFollowupAfterBotReply}, source=${source || 'direct'})`
  );

  if (useLlmIntervention) {
    decisionSource = 'llm_reply_intervention';
    const signals: PlanGroupSignalsLike = {
      mentionedByAt: isExplicitMention,
      mentionedByName,
      mentionedNames,
      mentionedNameHitCount: Array.isArray(mentionedNames) ? mentionedNames.length : 0,
      mentionedNameHitsInText: !!mentionedNameHitsInText,
      mentionedNameHitsInSummary: !!mentionedNameHitsInSummary,
      senderReplyCountWindow: senderFatigueInfo.count,
      groupReplyCountWindow: groupFatigueInfo.count,
      senderFatigue: senderFatigueInfo.fatigue,
      groupFatigue: groupFatigueInfo.fatigue,
      isFollowupAfterBotReply,
      activeTaskCount: activeCount
    };
    if (typeof senderFatigueInfo.lastAgeSec === 'number') {
      signals.senderLastReplyAgeSec = senderFatigueInfo.lastAgeSec;
    }
    if (typeof groupFatigueInfo.lastAgeSec === 'number') {
      signals.groupLastReplyAgeSec = groupFatigueInfo.lastAgeSec;
    }
    const planOptions: {
      signals: PlanGroupSignalsLike;
      context?: Record<string, unknown>;
      policy?: Record<string, unknown>;
      bot?: { self_id: string; bot_names: Array<string | number> };
    } = {
      signals,
      policy: policyConfig,
      bot: {
        self_id: msg?.self_id != null ? String(msg.self_id) : '',
        bot_names: Array.isArray(config.botNames) ? config.botNames : []
      }
    };
    if (decisionContext) planOptions.context = decisionContext;
    const intervention = await planGroupReplyDecision(msg, planOptions);

    if (intervention && typeof intervention.shouldReply === 'boolean') {
      const actionFromIntervention = normalizeReplyAction(
        (intervention as { action?: unknown }).action,
        intervention.shouldReply
      );
      replyAction = actionFromIntervention;
      shouldReplyFlag = actionFromIntervention !== 'silent';
      decisionTrace.llmDecision = {
        shouldReply: shouldReplyFlag,
        confidence:
          typeof intervention.confidence === 'number' && Number.isFinite(intervention.confidence)
            ? intervention.confidence
            : null,
        reason: typeof intervention.reason === 'string' ? intervention.reason : null
      };

      let interventionConfidence;
      if (typeof intervention.confidence === 'number' && Number.isFinite(intervention.confidence)) {
        const c = intervention.confidence;
        interventionConfidence = c < 0 ? 0 : c > 1 ? 1 : c;
      } else {
        interventionConfidence = shouldReplyFlag ? 1.0 : 0.0;
      }

      probability = interventionConfidence;
      reasonCode = shouldReplyFlag ? REASON_CODE.llm_reply_enter : REASON_CODE.llm_reply_silent;
      reason = intervention.reason
        ? `ReplyIntervention: ${intervention.reason}`
        : (shouldReplyFlag
            ? 'ReplyIntervention: LLM 判定应进入主对话流程'
            : 'ReplyIntervention: LLM 判定本轮不进入主对话流程');

      if (replyAction === 'delay') {
        const delayWhenCandidate =
          typeof (intervention as { delayWhen?: unknown }).delayWhen === 'string'
            ? (intervention as { delayWhen?: string }).delayWhen
            : '';
        const parsedDelay = buildDelayPlanFromText(msg, delayWhenCandidate);
        if (parsedDelay) {
          delayPlan = parsedDelay;
        } else {
          // 无法解析明确时间则回退为正常 action，避免进入无效 delay 态
          replyAction = shouldReplyFlag ? 'action' : 'silent';
          if (replyAction === 'action') {
            reason = `${reason} (delay parse failed, fallback to action)`;
          }
        }
      } else {
        delayPlan = null;
      }

      if (typeof intervention.reason === 'string' && intervention.reason.trim()) {
        explainZh = explainByReasonCode('llm_reply_with_reason', {
          reason: intervention.reason.trim()
        });
      } else {
        explainZh = explainByReasonCode(
          shouldReplyFlag ? REASON_CODE.llm_reply_enter : REASON_CODE.llm_reply_silent
        );
      }
    }
  }

  if (isGroup && isExplicitMention && config.mentionMustReply) {
    if (!shouldReplyFlag) {
      logger.info('当前决策判定无需回复，但配置要求对显式@必须回复，强制覆盖为需要回复');
    }
    shouldReplyFlag = true;
    replyAction = 'action';
    delayPlan = null;
    mandatory = true;
    reasonCode = REASON_CODE.local_mandatory_mention;
    reason = 'local_mandatory_mention';
    explainZh = explainByReasonCode(REASON_CODE.local_mandatory_mention);
    decisionSource = 'local_mandatory_mention';
    probability = 1.0;
  }

  if (isGroup && msg.group_id) {
    try {
      const analyzerProb = getGateAnalyzerProb(gateResult);
      const payload: AttentionUpdatePayloadLike = {
        groupId: msg.group_id,
        senderId: senderIdRaw,
        fusedProb: probability,
        didReply: shouldReplyFlag
      };
      if (typeof analyzerProb === 'number') payload.analyzerProb = analyzerProb;
      if (typeof gateProb === 'number') payload.gateProb = gateProb;
      await updateAttentionStatsAfterDecision(payload);
    } catch (e) {
      logger.debug(`updateAttentionStatsAfterDecision 失败: group ${msg.group_id} sender ${senderIdRaw}`, {
        err: String(e)
      });
    }
  }

  if (!shouldReplyFlag) {
    replyAction = 'silent';
    delayPlan = null;
    const finalCode = reasonCode || REASON_CODE.final_no_reply;
    const reasonFields = buildReasonFields(finalCode, {
      reasonDetail: reason,
      explainFallback: explainZh || explainByReasonCode(REASON_CODE.final_no_reply)
    });
    const zh = reasonFields.explainZh;
    logger.info(`[${groupInfo}] 用户${senderIdRaw} 决策为不回复: ${zh} (action=silent, raw=${reason}, p=${(probability * 100).toFixed(1)}%, src=${decisionSource})`);
    return {
      needReply: false,
      action: 'silent',
      ...reasonFields,
      decisionSource,
      decisionTrace,
      mandatory: false,
      probability,
      conversationId,
      taskId: null
    };
  }

  const taskId = randomUUID();
  addActiveTask(senderKey, taskId);
  if (isGroup) {
    markAttentionWindow(msg, senderIdRaw, config);
    recordReplyForFatigue(msg, senderIdRaw, config);
  }
  const finalCode = reasonCode || REASON_CODE.final_enter_main;
  const reasonFields = buildReasonFields(finalCode, {
    reasonDetail: reason,
    explainFallback: explainZh || explainByReasonCode(REASON_CODE.final_enter_main)
  });
  logger.info(
    `[${groupInfo}] 用户${senderIdRaw} 启动对话: ${reasonFields.explainZh} (action=${replyAction}${delayPlan ? `, delayWhen=${delayPlan.whenText || ''}` : ''}, raw=${reason}, mandatory=${mandatory}, p=${(probability * 100).toFixed(1)}%, src=${decisionSource}, task=${taskId})`
  );

  return {
    needReply: true,
    action: replyAction,
    ...(delayPlan ? { delay: delayPlan } : {}),
    ...reasonFields,
    decisionSource,
    decisionTrace,
    mandatory,
    probability,
    conversationId,
    taskId
  };
}
