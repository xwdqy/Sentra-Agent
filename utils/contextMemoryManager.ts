import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { getRedisSafe } from './redisClient.js';
import { DateTime } from 'luxon';
import { formatDateFromMillis } from './timeUtils.js';
import { escapeXml, escapeXmlAttr, getFastXmlParser } from './xmlUtils.js';
import { getEnv, getEnvInt } from './envHotReloader.js';
import { countTextTokens, truncateTextByTokens } from './tokenTextTruncator.js';
import { buildGroupScopeId, buildPrivateScopeId, parseScopeId } from './conversationId.js';

const logger = createLogger('ContextMemory');
const CONTEXT_MEMORY_PREFIX = 'sentra_memory_';
const CURSOR_SUFFIX = '_cursor';
const EVENT_CURSOR_SUFFIX = '_cursor_event_index';
const SUMMARY_LEASE_SUFFIX = '_summary_lease';
const MEMORY_RESULT_VALUE_MAX_TOKENS = 50;
const MEMORY_RESULT_MAX_DEPTH = 6;
const MEMORY_RESULT_MAX_KEYS = 24;
const MEMORY_RESULT_MAX_ARRAY_ITEMS = 16;
const MEMORY_TOOL_RESULTS_MAX_ITEMS = 64;
const MEMORY_ASSISTANT_RESP_MAX_ITEMS = 48;

type ContextMemoryRuntimeConfig = {
  prefix: string;
  ttlSeconds: number;
  timezone: string;
};

type ContextMemoryItem = {
  groupId: string | number;
  scopeType: string;
  scopeId: string;
  scopeKey: string;
  date: string;
  timeStart: number | null;
  timeEnd: number | null;
  summary: string;
  keywords: string[];
  eventBoard: string[];
  artifacts: ContextMemoryArtifact[];
  sourceDir: string | null;
  eventRange: ContextMemoryEventRange | null;
  model: string | null;
  chatType: string | null;
  userId: string | null;
  createdAt: number;
};

export type ContextMemoryArtifact = {
  captain?: string;
  type?: string;
  kind?: string;
  path?: string;
  url?: string;
  originalPath?: string;
  outputPath?: string;
  exists?: boolean;
  [key: string]: unknown;
};

type ContextMemoryEventRange = {
  startCursor: number;
  endCursor: number;
  count: number;
  tokens: number;
};

export type ContextMemoryPayload = {
  summary?: string;
  timeStart?: number | null;
  timeEnd?: number | null;
  keywords?: string[];
  eventBoard?: string[];
  clues?: string[]; // legacy fallback
  artifacts?: ContextMemoryArtifact[];
  sourceXml?: string;
  eventRange?: Partial<ContextMemoryEventRange>;
  model?: string;
  chatType?: string;
  userId?: string;
};

export type ContextMemorySaveResult = {
  saved: boolean;
  redisSaved: boolean;
  localSaved: boolean;
  reason: string;
  date?: string;
  key?: string;
  sourceDir?: string | null;
};

type ContextMemoryRow = {
  summary: string;
  timeStart?: number | null;
  timeEnd?: number | null;
  keywords?: string[];
  eventBoard?: string[];
  artifacts?: ContextMemoryArtifact[];
};

type ContextScopeInfo = {
  scopeType: 'group' | 'private' | 'unknown';
  scopeId: string;
  scopeKey: string;
  scopeFolder: string;
};

function getContextMemoryRuntimeConfig(): ContextMemoryRuntimeConfig {
  const prefix = CONTEXT_MEMORY_PREFIX;
  const ttlRaw = getEnvInt('REDIS_CONTEXT_MEMORY_TTL_SECONDS', 0);
  const ttlSeconds = typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) ? ttlRaw : 0;
  const timezone = getEnv('CONTEXT_MEMORY_TIMEZONE', 'Asia/Shanghai') || 'Asia/Shanghai';
  return { prefix, ttlSeconds, timezone };
}

function buildDailyKey(groupId: string | number, dateStr: string): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}_${dateStr}`;
}

function buildDailySummaryKey(groupId: string | number, dateStr: string): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}_summary_${dateStr}`;
}

function buildCursorKey(groupId: string | number): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}${CURSOR_SUFFIX}`;
}

function buildEventKey(groupId: string | number): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}_events`;
}

function buildEventCursorKey(groupId: string | number): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}${EVENT_CURSOR_SUFFIX}`;
}

function buildSummaryLeaseKey(groupId: string | number): string {
  const { prefix } = getContextMemoryRuntimeConfig();
  return `${prefix}${String(groupId)}${SUMMARY_LEASE_SUFFIX}`;
}

export async function getLastSummarizedPairCount(groupId: string | number): Promise<number> {
  try {
    const redis = getRedisSafe();
    if (!redis) return 0;
    const key = buildEventCursorKey(groupId);
    let val = await redis.get(key);
    if (!val) {
      val = await redis.get(buildCursorKey(groupId));
    }
    if (!val) return 0;
    const n = parseInt(val, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  } catch (e) {
    logger.warn('getLastSummarizedPairCount failed', { groupId, err: String(e) });
    return 0;
  }
}

export async function setLastSummarizedPairCount(groupId: string | number, count: number): Promise<void> {
  try {
    const redis = getRedisSafe();
    if (!redis) return;
    const v = Math.max(0, Number.isFinite(count) ? count : 0);
    await redis.set(buildCursorKey(groupId), String(v));
    await redis.set(buildEventCursorKey(groupId), String(v));
  } catch (e) {
    logger.warn('setLastSummarizedPairCount failed', { groupId, err: String(e) });
  }
}

export async function acquireContextSummaryLease(
  groupId: string | number,
  owner: string,
  ttlSeconds = 180
): Promise<boolean> {
  try {
    const redis = getRedisSafe();
    if (!redis) return false;
    const key = buildSummaryLeaseKey(groupId);
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 180;
    const res = await (redis as unknown as {
      set: (k: string, v: string, mode: string, mode2: string, sec: number) => Promise<string | null>;
    }).set(key, String(owner || ''), 'NX', 'EX', ttl);
    return String(res || '').toUpperCase() === 'OK';
  } catch (e) {
    logger.warn('acquireContextSummaryLease failed', { groupId, err: String(e) });
    return false;
  }
}

export async function releaseContextSummaryLease(groupId: string | number, owner: string): Promise<void> {
  try {
    const redis = getRedisSafe();
    if (!redis) return;
    const key = buildSummaryLeaseKey(groupId);
    const current = await redis.get(key);
    if (current && current === String(owner || '')) {
      await redis.del(key);
    }
  } catch (e) {
    logger.warn('releaseContextSummaryLease failed', { groupId, err: String(e) });
  }
}

function clipText(raw: unknown, max = 32000): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function sanitizePathSegment(raw: unknown, max = 120): string {
  const text = String(raw ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  if (!text) return 'unknown';
  return text.length > max ? text.slice(0, max) : text;
}

function resolveContextScopeInfo(
  groupId: string | number,
  chatTypeRaw?: string | null,
  userIdRaw?: string | null
): ContextScopeInfo {
  const keyRaw = String(groupId ?? '').trim();
  const chatType = String(chatTypeRaw || '').trim().toLowerCase();
  const userId = String(userIdRaw || '').trim();
  const parsed = parseScopeId(keyRaw);

  let scopeType: ContextScopeInfo['scopeType'] = 'unknown';
  let scopeId = '';
  let scopeKey = keyRaw || 'unknown';

  if (parsed.kind === 'group') {
    scopeType = 'group';
    scopeId = parsed.id.trim();
    scopeKey = buildGroupScopeId(scopeId || 'unknown');
  } else if (parsed.kind === 'private') {
    scopeType = 'private';
    scopeId = parsed.id.trim();
    scopeKey = buildPrivateScopeId(scopeId || 'unknown');
  } else if (chatType === 'group') {
    scopeType = 'group';
    scopeId = keyRaw || userId || 'unknown';
    scopeKey = buildGroupScopeId(scopeId);
  } else if (chatType === 'private') {
    scopeType = 'private';
    scopeId = userId || keyRaw || 'unknown';
    scopeKey = buildPrivateScopeId(scopeId);
  } else {
    scopeType = 'unknown';
    scopeId = keyRaw || userId || 'unknown';
    scopeKey = `X_${scopeId}`;
  }

  const prefix = scopeType === 'group' ? 'G' : (scopeType === 'private' ? 'U' : 'X');
  const scopeFolder = `${prefix}_${sanitizePathSegment(scopeId || 'unknown')}`;

  return {
    scopeType,
    scopeId: scopeId || 'unknown',
    scopeKey,
    scopeFolder
  };
}

function clipTextByTokens(raw: unknown, maxTokens = MEMORY_RESULT_VALUE_MAX_TOKENS, maxChars = 12000): string {
  const text = clipText(raw, maxChars);
  if (!text) return '';
  const tokenLimit = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : MEMORY_RESULT_VALUE_MAX_TOKENS;
  const out = truncateTextByTokens(text, { maxTokens: tokenLimit, suffix: ' ...' });
  return String(out.text || '').trim();
}

function normalizeStringArray(input: unknown, maxItems = 12, maxChars = 2000): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const text = clipText(item, maxChars).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function isProbablyUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function normalizeArtifactCaptain(raw: unknown, index: number): string {
  const t = clipText(raw, 120).replace(/\s+/g, ' ').trim();
  if (t) return t;
  return `artifact_${index + 1}`;
}

function normalizeArtifacts(input: unknown): ContextMemoryArtifact[] {
  if (!Array.isArray(input)) return [];
  const out: ContextMemoryArtifact[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const captain = normalizeArtifactCaptain(rec.captain ?? rec.label ?? rec.name ?? rec.title, i);
    const outputPath = clipText(rec.outputPath ?? rec.path ?? rec.value ?? rec.file ?? rec.filePath, 1200);
    const originalPath = clipText(rec.originalPath, 1200);
    const urlValue = clipText(rec.url, 1200);
    const type = clipText(rec.type, 80);
    const kind = clipText(rec.kind, 80);
    out.push({
      captain,
      ...(type ? { type } : {}),
      ...(kind ? { kind } : {}),
      ...(outputPath ? { outputPath } : {}),
      ...(originalPath ? { originalPath } : {}),
      ...(urlValue ? { url: urlValue } : {}),
    });
  }
  return out;
}

function readXmlNodeText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node).trim();
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = readXmlNodeText(item);
      if (text) return text;
    }
    return '';
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['#text'] === 'string' && obj['#text'].trim()) {
      return obj['#text'].trim();
    }
  }
  return '';
}

function extractArtifactsFromSentraMessageContent(content: unknown): ContextMemoryArtifact[] {
  const xml = clipText(content, 120000);
  if (!xml || !xml.includes('<sentra-message') || !xml.includes('<segment')) return [];
  try {
    const parsed = getFastXmlParser().parse(xml);
    const out: ContextMemoryArtifact[] = [];
    const allowedTypes = new Set(['image', 'file', 'video', 'audio', 'record']);

    const walk = (node: unknown) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;

      if (Object.prototype.hasOwnProperty.call(obj, 'segment')) {
        const segRaw = obj.segment;
        const segments = Array.isArray(segRaw) ? segRaw : [segRaw];
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          if (!seg || typeof seg !== 'object') continue;
          const segObj = seg as Record<string, unknown>;
          const segType = readXmlNodeText(segObj.type).toLowerCase();
          if (!allowedTypes.has(segType)) continue;
          const data = segObj.data && typeof segObj.data === 'object'
            ? (segObj.data as Record<string, unknown>)
            : {};
          const filePath = readXmlNodeText(data.file);
          const pathValue = readXmlNodeText(data.path);
          const urlValue = readXmlNodeText(data.url);
          if (!filePath && !pathValue && !urlValue) continue;
          out.push({
            captain: `${segType}_${i + 1}`,
            kind: segType,
            ...(filePath ? { outputPath: filePath } : {}),
            ...(!filePath && pathValue ? { outputPath: pathValue } : {}),
            ...(urlValue ? { url: urlValue } : {}),
          });
        }
      }

      for (const value of Object.values(obj)) {
        walk(value);
      }
    };

    walk(parsed);
    return out;
  } catch {
    return [];
  }
}

function extractArtifactsFromAssistantResponses(input: unknown): ContextMemoryArtifact[] {
  if (!Array.isArray(input)) return [];
  const out: ContextMemoryArtifact[] = [];
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const content = typeof rec.content === 'string' ? rec.content : '';
    if (!content) continue;
    out.push(...extractArtifactsFromSentraMessageContent(content));
  }
  return out;
}

function isNoisyResultKey(raw: string): boolean {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return true;
  return key === 'stack'
    || key === 'trace'
    || key === 'raw'
    || key === 'rawtext'
    || key === 'rawxml'
    || key === 'rawhtml'
    || key === 'debug'
    || key === 'logs'
    || key === 'log'
    || key === 'prompt';
}

function compactResultValue(
  value: unknown,
  options: {
    depth?: number;
    maxDepth?: number;
    maxKeys?: number;
    maxItems?: number;
    maxTokens?: number;
  } = {}
): unknown {
  const depth = Number.isFinite(Number(options.depth)) ? Number(options.depth) : 0;
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : MEMORY_RESULT_MAX_DEPTH;
  const maxKeys = Number.isFinite(Number(options.maxKeys)) ? Number(options.maxKeys) : MEMORY_RESULT_MAX_KEYS;
  const maxItems = Number.isFinite(Number(options.maxItems)) ? Number(options.maxItems) : MEMORY_RESULT_MAX_ARRAY_ITEMS;
  const maxTokens = Number.isFinite(Number(options.maxTokens)) ? Number(options.maxTokens) : MEMORY_RESULT_VALUE_MAX_TOKENS;

  if (value == null) return value;
  if (typeof value === 'string') {
    const text = clipTextByTokens(value, maxTokens, 12000);
    return text || undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') return value;
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (typeof value === 'object') {
      try {
        return `[object:${Object.keys(value as Record<string, unknown>).length}]`;
      } catch {
        return '[object]';
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length && i < maxItems; i++) {
      const v = compactResultValue(value[i], {
        depth: depth + 1,
        maxDepth,
        maxKeys,
        maxItems,
        maxTokens
      });
      if (v === undefined) continue;
      out.push(v);
    }
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let used = 0;
    for (const key of Object.keys(obj)) {
      if (used >= maxKeys) break;
      if (isNoisyResultKey(key)) continue;
      const v = compactResultValue(obj[key], {
        depth: depth + 1,
        maxDepth,
        maxKeys,
        maxItems,
        maxTokens
      });
      if (v === undefined) continue;
      out[key] = v;
      used += 1;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function extractToolResultErrorText(result: Record<string, unknown>): string {
  const err = result?.error;
  if (typeof err === 'string' && err.trim()) return clipTextByTokens(err, MEMORY_RESULT_VALUE_MAX_TOKENS, 4000);
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const msg = typeof rec.message === 'string' && rec.message.trim()
      ? rec.message
      : (typeof rec.reason === 'string' ? rec.reason : '');
    if (msg) return clipTextByTokens(msg, MEMORY_RESULT_VALUE_MAX_TOKENS, 4000);
  }
  if (typeof result.message === 'string' && result.message.trim()) {
    return clipTextByTokens(result.message, MEMORY_RESULT_VALUE_MAX_TOKENS, 4000);
  }
  if (typeof result.reason === 'string' && result.reason.trim()) {
    return clipTextByTokens(result.reason, MEMORY_RESULT_VALUE_MAX_TOKENS, 4000);
  }
  return '';
}

function normalizeToolResultForMemory(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const aiName = clipTextByTokens(rec.aiName, 12, 160);
  const stepId = clipTextByTokens(rec.stepId, 20, 240);
  const reason = Array.isArray(rec.reason) ? normalizeStringArray(rec.reason, 6) : [];
  if (aiName) out.aiName = aiName;
  if (stepId) out.stepId = stepId;
  if (reason.length > 0) out.reason = reason;

  const plannedStepIndex = Number(rec.plannedStepIndex);
  const stepIndex = Number(rec.stepIndex);
  const executionIndex = Number(rec.executionIndex);
  const elapsedMs = Number(rec.elapsedMs);
  if (Number.isFinite(plannedStepIndex)) out.plannedStepIndex = plannedStepIndex;
  if (Number.isFinite(stepIndex)) out.stepIndex = stepIndex;
  if (Number.isFinite(executionIndex)) out.executionIndex = executionIndex;
  if (Number.isFinite(elapsedMs)) out.elapsedMs = elapsedMs;

  const result = rec.result && typeof rec.result === 'object'
    ? (rec.result as Record<string, unknown>)
    : null;
  if (result) {
    const compact: Record<string, unknown> = {};
    compact.success = result.success === true;
    const code = clipTextByTokens(result.code, 16, 160);
    const provider = clipTextByTokens(result.provider, 16, 160);
    if (code) compact.code = code;
    if (provider) compact.provider = provider;

    const errorText = extractToolResultErrorText(result);
    if (errorText) compact.error = errorText;

    const artifacts = normalizeArtifacts(result.artifacts);
    if (artifacts.length > 0) compact.artifacts = artifacts.slice(0, 24);

    if (Object.prototype.hasOwnProperty.call(result, 'data')) {
      const compactData = compactResultValue(result.data, {
        maxDepth: MEMORY_RESULT_MAX_DEPTH,
        maxKeys: MEMORY_RESULT_MAX_KEYS,
        maxItems: MEMORY_RESULT_MAX_ARRAY_ITEMS,
        maxTokens: MEMORY_RESULT_VALUE_MAX_TOKENS
      });
      if (compactData !== undefined) compact.data = compactData;
    }

    out.result = compact;
  } else {
    const compactFallback = compactResultValue(rec, {
      maxDepth: 3,
      maxKeys: 12,
      maxItems: 8,
      maxTokens: MEMORY_RESULT_VALUE_MAX_TOKENS
    });
    if (compactFallback && typeof compactFallback === 'object') {
      return compactFallback as Record<string, unknown>;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function normalizeToolResultsForMemory(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < input.length && i < MEMORY_TOOL_RESULTS_MAX_ITEMS; i++) {
    const normalized = normalizeToolResultForMemory(input[i]);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

function normalizeAssistantResponsesForMemory(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < input.length && i < MEMORY_ASSISTANT_RESP_MAX_ITEMS; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const normalized: Record<string, unknown> = {
      phase: clipTextByTokens(rec.phase, 12, 80) || 'unknown',
      delivered: rec.delivered === true,
      noReply: rec.noReply === true
    };
    const ts = Number(rec.ts);
    if (Number.isFinite(ts) && ts > 0) normalized.ts = ts;

    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (content) {
      normalized.content = clipText(content, 64000);
    }

    const meta = compactResultValue(rec.meta, {
      maxDepth: 3,
      maxKeys: 12,
      maxItems: 10,
      maxTokens: MEMORY_RESULT_VALUE_MAX_TOKENS
    });
    if (meta && typeof meta === 'object') {
      normalized.meta = meta;
    }

    out.push(normalized);
  }
  return out;
}

export type ContextMemoryEventPayload = {
  kind?: string;
  timestamp?: number;
  timeStart?: number | null;
  timeEnd?: number | null;
  chatType?: string;
  userId?: string;
  objective?: string;
  objectiveXml?: string;
  contentText?: string;
  contentXml?: string;
  summaryText?: string;
  reasons?: string[];
  toolResults?: unknown[];
  assistantResponses?: unknown[];
  artifacts?: ContextMemoryArtifact[];
  metadata?: Record<string, unknown>;
  tokenCount?: number;
};

export type ContextMemoryEvent = {
  id: string;
  kind: string;
  timestamp: number;
  timeStart: number | null;
  timeEnd: number | null;
  chatType: string | null;
  userId: string | null;
  objective: string;
  objectiveXml: string;
  contentText: string;
  contentXml: string;
  summaryText: string;
  reasons: string[];
  toolResults: unknown[];
  assistantResponses: unknown[];
  artifacts: ContextMemoryArtifact[];
  metadata: Record<string, unknown>;
  tokenCount: number;
  createdAt: number;
};

export type ContextMemoryUnsummarizedSlice = {
  events: ContextMemoryEvent[];
  startCursor: number;
  endCursor: number;
  totalEvents: number;
  unsummarizedTokens: number;
  timeStart: number | null;
  timeEnd: number | null;
  lastEventAt: number | null;
};

function toJsonSafeValue<T = unknown>(value: unknown): T | null {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return null;
  }
}

function buildTokenTextForEvent(payload: ContextMemoryEventPayload): string {
  const normalizedToolResults = normalizeToolResultsForMemory(payload.toolResults);
  const normalizedAssistantResponses = normalizeAssistantResponsesForMemory(payload.assistantResponses);
  const parts: string[] = [];
  const pushUnique = (raw: unknown, maxChars = 12000) => {
    const text = clipText(raw, maxChars);
    if (!text) return;
    if (parts.includes(text)) return;
    parts.push(text);
  };
  pushUnique(payload.objective);
  pushUnique(payload.contentText);
  if (payload.summaryText) parts.push(String(payload.summaryText));
  pushUnique(payload.objectiveXml, 10000);
  pushUnique(payload.contentXml, 10000);
  if (Array.isArray(payload.reasons) && payload.reasons.length > 0) parts.push(payload.reasons.join('\n'));
  if (normalizedToolResults.length > 0) {
    const text = toJsonSafeValue(normalizedToolResults);
    if (text != null) parts.push(clipText(JSON.stringify(text), 12000));
  }
  if (normalizedAssistantResponses.length > 0) {
    const text = toJsonSafeValue(normalizedAssistantResponses);
    if (text != null) parts.push(clipText(JSON.stringify(text), 64000));
  }
  return parts.join('\n\n').trim();
}

function parseContextMemoryEvent(raw: string): ContextMemoryEvent | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    const kind = clipText(obj.kind, 60) || 'event';
    const timestamp = Number(obj.timestamp);
    const tokenCount = Number(obj.tokenCount);
    const parsedToolResults = normalizeToolResultsForMemory(obj.toolResults);
    const parsedAssistantResponses = normalizeAssistantResponsesForMemory(obj.assistantResponses);
    const explicitArtifacts = normalizeArtifacts(obj.artifacts);
    const parsedArtifacts = dedupeArtifacts(explicitArtifacts);

    return {
      id: clipText(obj.id, 120) || `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      kind,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
      timeStart: Number.isFinite(Number(obj.timeStart)) ? Number(obj.timeStart) : null,
      timeEnd: Number.isFinite(Number(obj.timeEnd)) ? Number(obj.timeEnd) : null,
      chatType: clipText(obj.chatType, 24) || null,
      userId: clipText(obj.userId, 64) || null,
      objective: clipText(obj.objective, 12000),
      objectiveXml: clipText(obj.objectiveXml, 24000),
      contentText: clipText(obj.contentText, 12000),
      contentXml: clipText(obj.contentXml, 24000),
      summaryText: clipText(obj.summaryText, 12000),
      reasons: normalizeStringArray(obj.reasons, 16),
      toolResults: parsedToolResults,
      assistantResponses: parsedAssistantResponses,
      artifacts: parsedArtifacts,
      metadata: (obj.metadata && typeof obj.metadata === 'object') ? (obj.metadata as Record<string, unknown>) : {},
      tokenCount: Number.isFinite(tokenCount) && tokenCount > 0 ? Math.floor(tokenCount) : 0,
      createdAt: Number.isFinite(Number(obj.createdAt)) ? Number(obj.createdAt) : Date.now()
    };
  } catch {
    return null;
  }
}

export async function appendContextMemoryEvent(groupId: string | number, payload: ContextMemoryEventPayload): Promise<void> {
  try {
    const redis = getRedisSafe();
    if (!redis) return;
    const now = Date.now();
    const kind = clipText(payload?.kind, 60) || 'event';
    const normalizedToolResults = normalizeToolResultsForMemory(payload?.toolResults);
    const normalizedAssistantResponses = normalizeAssistantResponsesForMemory(payload?.assistantResponses);
    const explicitArtifacts = normalizeArtifacts(payload?.artifacts);
    const assistantResponseArtifacts = extractArtifactsFromAssistantResponses(normalizedAssistantResponses);
    const summaryArtifacts = extractArtifactsFromSentraMessageContent(payload?.summaryText);
    const normalizedArtifacts = dedupeArtifacts([
      ...explicitArtifacts,
      ...assistantResponseArtifacts,
      ...summaryArtifacts
    ]);
    const tokenText = buildTokenTextForEvent(payload);
    const tokenCountRaw = Number(payload?.tokenCount);
    const tokenCount = Number.isFinite(tokenCountRaw) && tokenCountRaw > 0
      ? Math.floor(tokenCountRaw)
      : countTextTokens(tokenText);
    const event: ContextMemoryEvent = {
      id: `${now}_${kind}_${Math.random().toString(16).slice(2, 10)}`,
      kind,
      timestamp: Number.isFinite(Number(payload?.timestamp)) ? Number(payload?.timestamp) : now,
      timeStart: Number.isFinite(Number(payload?.timeStart)) ? Number(payload?.timeStart) : null,
      timeEnd: Number.isFinite(Number(payload?.timeEnd)) ? Number(payload?.timeEnd) : null,
      chatType: clipText(payload?.chatType, 24) || null,
      userId: clipText(payload?.userId, 64) || null,
      objective: clipText(payload?.objective, 12000),
      objectiveXml: clipText(payload?.objectiveXml, 24000),
      contentText: clipText(payload?.contentText, 12000),
      contentXml: clipText(payload?.contentXml, 24000),
      summaryText: clipText(payload?.summaryText, 12000),
      reasons: normalizeStringArray(payload?.reasons, 16),
      toolResults: normalizedToolResults,
      assistantResponses: normalizedAssistantResponses,
      artifacts: normalizedArtifacts,
      metadata: (payload?.metadata && typeof payload.metadata === 'object')
        ? ((toJsonSafeValue(payload.metadata) || {}) as Record<string, unknown>)
        : {},
      tokenCount: Number.isFinite(tokenCount) && tokenCount > 0 ? tokenCount : 0,
      createdAt: now
    };
    const key = buildEventKey(groupId);
    await redis.rpush(key, JSON.stringify(event));
    const cfg = getContextMemoryRuntimeConfig();
    if (cfg.ttlSeconds > 0) {
      await redis.expire(key, cfg.ttlSeconds);
      await redis.expire(buildEventCursorKey(groupId), cfg.ttlSeconds);
      await redis.expire(buildCursorKey(groupId), cfg.ttlSeconds);
    }
  } catch (e) {
    logger.warn('appendContextMemoryEvent failed', { groupId, err: String(e) });
  }
}

export async function getUnsummarizedContextMemoryEvents(groupId: string | number): Promise<ContextMemoryUnsummarizedSlice> {
  const empty: ContextMemoryUnsummarizedSlice = {
    events: [],
    startCursor: 0,
    endCursor: 0,
    totalEvents: 0,
    unsummarizedTokens: 0,
    timeStart: null,
    timeEnd: null,
    lastEventAt: null
  };
  try {
    const redis = getRedisSafe();
    if (!redis) return empty;
    const key = buildEventKey(groupId);
    const total = await redis.llen(key);
    if (!Number.isFinite(total) || total <= 0) return empty;
    let cursor = await getLastSummarizedPairCount(groupId);
    if (cursor > total) {
      cursor = total;
      await setLastSummarizedPairCount(groupId, cursor);
    }
    const rows = await redis.lrange(key, cursor, -1);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ...empty, startCursor: cursor, endCursor: cursor, totalEvents: total };
    }
    const events: ContextMemoryEvent[] = [];
    let tokenSum = 0;
    let timeStart: number | null = null;
    let timeEnd: number | null = null;
    let lastEventAt: number | null = null;
    for (const raw of rows) {
      const ev = parseContextMemoryEvent(raw);
      if (!ev) continue;
      events.push(ev);
      tokenSum += Number.isFinite(ev.tokenCount) ? ev.tokenCount : 0;
      const tsCandidates = [ev.timeStart, ev.timeEnd, ev.timestamp].filter((x): x is number => typeof x === 'number' && x > 0);
      for (const ts of tsCandidates) {
        if (timeStart == null || ts < timeStart) timeStart = ts;
        if (timeEnd == null || ts > timeEnd) timeEnd = ts;
        if (lastEventAt == null || ts > lastEventAt) lastEventAt = ts;
      }
    }
    return {
      events,
      startCursor: cursor,
      endCursor: cursor + rows.length,
      totalEvents: total,
      unsummarizedTokens: tokenSum,
      timeStart,
      timeEnd,
      lastEventAt
    };
  } catch (e) {
    logger.warn('getUnsummarizedContextMemoryEvents failed', { groupId, err: String(e) });
    return empty;
  }
}

function dedupeArtifacts(items: ContextMemoryArtifact[]): ContextMemoryArtifact[] {
  const out: ContextMemoryArtifact[] = [];
  const seen = new Set<string>();
  for (const row of items) {
    const captain = clipText(row?.captain, 120);
    const outputPath = clipText(row?.outputPath ?? row?.path ?? row?.originalPath, 1200);
    const originalPath = clipText(row?.originalPath, 1200);
    const urlText = clipText(row?.url, 1200);
    const key = `${captain.toLowerCase()}|${outputPath.toLowerCase()}|${originalPath.toLowerCase()}|${urlText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(captain ? { captain } : {}),
      ...(row?.type ? { type: clipText(row.type, 80) } : {}),
      ...(row?.kind ? { kind: clipText(row.kind, 80) } : {}),
      ...(outputPath ? { outputPath } : {}),
      ...(originalPath ? { originalPath } : {}),
      ...(urlText ? { url: urlText } : {}),
    });
  }
  return out;
}

export function collectArtifactsFromContextEvents(events: ContextMemoryEvent[]): ContextMemoryArtifact[] {
  const collected: ContextMemoryArtifact[] = [];
  for (const ev of events) {
    if (Array.isArray(ev.artifacts) && ev.artifacts.length > 0) {
      collected.push(...ev.artifacts);
    }
  }
  return dedupeArtifacts(collected);
}

export function buildContextMemoryEventsXml(groupId: string | number, events: ContextMemoryEvent[]): string {
  const lines: string[] = [];
  lines.push('<sentra-memory-source>');
  lines.push(`  <group_id>${escapeXml(String(groupId))}</group_id>`);
  lines.push(`  <event_count>${events.length}</event_count>`);
  lines.push('  <events>');
  for (const [i, ev] of events.entries()) {
    if (!ev) continue;
    const idx = i + 1;
    lines.push(`    <event index="${escapeXmlAttr(String(idx))}" id="${escapeXmlAttr(ev.id)}" kind="${escapeXmlAttr(ev.kind)}">`);
    lines.push(`      <timestamp>${escapeXml(String(ev.timestamp))}</timestamp>`);
    if (ev.objective) lines.push(`      <objective>${escapeXml(ev.objective)}</objective>`);
    const normalizedContentText = clipText(ev.contentText, 12000);
    if (normalizedContentText && normalizedContentText !== ev.objective) {
      lines.push(`      <content_text>${escapeXml(normalizedContentText)}</content_text>`);
    }
    const userXml = clipText(ev.objectiveXml || ev.contentXml, 8000);
    if (userXml) lines.push(`      <user_xml>${escapeXml(userXml)}</user_xml>`);
    if (ev.summaryText) lines.push(`      <summary_text>${escapeXml(ev.summaryText)}</summary_text>`);
    if (Array.isArray(ev.assistantResponses) && ev.assistantResponses.length > 0) {
      lines.push('      <assistant_feedbacks>');
      for (const [respIndex, rawResp] of ev.assistantResponses.slice(0, MEMORY_ASSISTANT_RESP_MAX_ITEMS).entries()) {
        if (!rawResp || typeof rawResp !== 'object') continue;
        const rec = rawResp as Record<string, unknown>;
        const phase = clipText(rec.phase, 80) || 'unknown';
        const delivered = rec.delivered === true ? 'true' : 'false';
        const noReply = rec.noReply === true ? 'true' : 'false';
        const content = clipText(rec.content, 64000);
        lines.push(
          `        <feedback index="${escapeXmlAttr(String(respIndex + 1))}" phase="${escapeXmlAttr(phase)}" delivered="${delivered}" no_reply="${noReply}">`
        );
        if (content) {
          lines.push(`          <content>${escapeXml(content)}</content>`);
        }
        lines.push('        </feedback>');
      }
      lines.push('      </assistant_feedbacks>');
    }
    if (ev.reasons.length > 0) {
      lines.push('      <reasons>');
      for (const r of ev.reasons) {
        lines.push(`        <reason>${escapeXml(r)}</reason>`);
      }
      lines.push('      </reasons>');
    }
    if (ev.artifacts.length > 0) {
      lines.push('      <artifacts>');
      for (const art of ev.artifacts.slice(0, 120)) {
        lines.push(
          `        <artifact captain="${escapeXmlAttr(String(art?.captain || 'artifact'))}"` +
          ` path="${escapeXmlAttr(String(art?.outputPath || art?.path || art?.originalPath || ''))}"` +
          ` url="${escapeXmlAttr(String(art?.url || ''))}"` +
          ` type="${escapeXmlAttr(String(art?.type || ''))}"` +
          ` kind="${escapeXmlAttr(String(art?.kind || ''))}" />`
        );
      }
      lines.push('      </artifacts>');
    }
    lines.push('    </event>');
  }
  lines.push('  </events>');
  lines.push('</sentra-memory-source>');
  return lines.join('\n');
}

async function resolveExistingLocalPath(raw: unknown): Promise<string | null> {
  const text = clipText(raw, 1200);
  if (!text) return null;
  if (isProbablyUrl(text)) return null;
  const normalized = text.startsWith('file://') ? text.replace(/^file:\/\//i, '') : text;
  const candidates: string[] = [];
  if (path.isAbsolute(normalized)) {
    candidates.push(path.resolve(normalized));
  } else {
    candidates.push(path.resolve(process.cwd(), normalized));
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      candidates.push(path.resolve(normalized));
    }
  }
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return path.resolve(candidate);
    } catch {
    }
  }
  return null;
}

function sanitizeFileName(raw: string): string {
  const base = String(raw || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim();
  return base || 'artifact.bin';
}

function formatRangeFolderName(timeStart: number | null, timeEnd: number | null, nowMs: number): string {
  const { timezone } = getContextMemoryRuntimeConfig();
  const fallback = DateTime.fromMillis(nowMs).setZone(timezone);
  const from = (typeof timeStart === 'number' && timeStart > 0)
    ? DateTime.fromMillis(timeStart).setZone(timezone)
    : fallback;
  const to = (typeof timeEnd === 'number' && timeEnd > 0)
    ? DateTime.fromMillis(timeEnd).setZone(timezone)
    : fallback;
  return `${from.toFormat('HH_mm')}__${to.toFormat('HH_mm')}`;
}

async function ensureUniqueDir(baseDir: string): Promise<string> {
  const parentDir = path.dirname(baseDir);
  await fs.mkdir(parentDir, { recursive: true });
  try {
    await fs.mkdir(baseDir, { recursive: false });
    return baseDir;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code || '';
    if (code && code !== 'EEXIST') {
      throw e;
    }
  }
  for (let i = 2; i <= 9999; i++) {
    const next = `${baseDir}__${i}`;
    try {
      await fs.mkdir(next, { recursive: false });
      return next;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code || '';
      if (code && code !== 'EEXIST') {
        throw e;
      }
    }
  }
  throw new Error(`ensureUniqueDir: exhausted unique suffixes for ${baseDir}`);
}

async function materializeArtifactsForSummary(
  artifacts: ContextMemoryArtifact[],
  outputsDir: string
): Promise<ContextMemoryArtifact[]> {
  const out: ContextMemoryArtifact[] = [];
  await fs.mkdir(outputsDir, { recursive: true });
  for (let i = 0; i < artifacts.length; i++) {
    const src = artifacts[i];
    const captain = normalizeArtifactCaptain(src?.captain, i);
    const pathRaw = clipText(src?.outputPath ?? src?.path ?? src?.originalPath, 1200);
    const urlRaw = clipText(src?.url, 1200);
    const type = clipText(src?.type, 80);
    const kind = clipText(src?.kind, 80);

    if (urlRaw && isProbablyUrl(urlRaw)) {
      out.push({
        captain,
        ...(type ? { type } : {}),
        kind: kind || 'url',
        url: urlRaw,
        exists: true
      });
      continue;
    }

    const localAbs = await resolveExistingLocalPath(pathRaw);
    if (!localAbs) {
      out.push({
        captain,
        ...(type ? { type } : {}),
        kind: kind || 'path',
        ...(pathRaw ? { originalPath: pathRaw } : {}),
        exists: false
      });
      continue;
    }

    const ext = path.extname(localAbs);
    const base = sanitizeFileName(path.basename(localAbs, ext));
    const fileName = `${String(i + 1).padStart(3, '0')}_${base}${ext}`;
    const dst = path.resolve(outputsDir, fileName);
    try {
      await fs.copyFile(localAbs, dst);
      out.push({
        captain,
        ...(type ? { type } : {}),
        kind: kind || 'local_file',
        originalPath: localAbs,
        outputPath: dst,
        exists: true
      });
    } catch {
      out.push({
        captain,
        ...(type ? { type } : {}),
        kind: kind || 'local_file',
        originalPath: localAbs,
        exists: false
      });
    }
  }
  return out;
}

export async function saveContextMemoryItem(
  groupId: string | number,
  payload: ContextMemoryPayload
): Promise<ContextMemorySaveResult> {
  const redis = getRedisSafe();
  if (!redis) {
    return {
      saved: false,
      redisSaved: false,
      localSaved: false,
      reason: 'redis_unavailable'
    };
  }

  const summary = clipText(payload?.summary, 20000);
  if (!summary) {
    return {
      saved: false,
      redisSaved: false,
      localSaved: false,
      reason: 'empty_summary'
    };
  }

  const timeStart = Number.isFinite(Number(payload?.timeStart)) ? Number(payload?.timeStart) : null;
  const timeEnd = Number.isFinite(Number(payload?.timeEnd)) ? Number(payload?.timeEnd) : null;
  const model = clipText(payload?.model, 120) || null;
  const chatType = clipText(payload?.chatType, 24) || null;
  const userId = clipText(payload?.userId, 64) || null;
  const keywords = normalizeStringArray(payload?.keywords, 24);
  const eventBoard = normalizeStringArray(payload?.eventBoard ?? payload?.clues, 24);
  const sourceXml = clipText(payload?.sourceXml, 200000);
  const artifacts = normalizeArtifacts(payload?.artifacts);
  const eventRange: ContextMemoryEventRange | null = payload?.eventRange
    ? {
      startCursor: Number.isFinite(Number(payload.eventRange.startCursor)) ? Number(payload.eventRange.startCursor) : 0,
      endCursor: Number.isFinite(Number(payload.eventRange.endCursor)) ? Number(payload.eventRange.endCursor) : 0,
      count: Number.isFinite(Number(payload.eventRange.count)) ? Number(payload.eventRange.count) : 0,
      tokens: Number.isFinite(Number(payload.eventRange.tokens)) ? Number(payload.eventRange.tokens) : 0
    }
    : null;

  const now = Date.now();
  const baseTs = timeStart ?? now;
  const { timezone } = getContextMemoryRuntimeConfig();
  const dateStr = formatDateFromMillis(baseTs, timezone);
  const key = buildDailySummaryKey(groupId, dateStr);
  const scopeInfo = resolveContextScopeInfo(groupId, chatType, userId);

  const item: ContextMemoryItem = {
    groupId,
    scopeType: scopeInfo.scopeType,
    scopeId: scopeInfo.scopeId,
    scopeKey: scopeInfo.scopeKey,
    date: dateStr,
    timeStart,
    timeEnd,
    summary,
    keywords,
    eventBoard,
    artifacts,
    sourceDir: null,
    eventRange,
    model,
    chatType,
    userId,
    createdAt: now
  };

  let localSaved = false;
  try {
    const summaryRoot = path.resolve('.summary');
    const dateDir = path.join(summaryRoot, dateStr);
    const scopeDir = path.join(dateDir, scopeInfo.scopeFolder);
    const rangeDirName = formatRangeFolderName(timeStart, timeEnd, now);
    const summaryDir = await ensureUniqueDir(path.join(scopeDir, rangeDirName));
    const outputsDir = path.resolve(summaryDir, 'outputs');
    const copiedArtifacts = await materializeArtifactsForSummary(artifacts, outputsDir);
    item.artifacts = copiedArtifacts;
    item.sourceDir = summaryDir;
    await fs.mkdir(summaryDir, { recursive: true });
    await fs.writeFile(path.join(summaryDir, 'summary.json'), JSON.stringify(item, null, 2), 'utf-8');
    await fs.writeFile(path.join(summaryDir, 'source.xml'), sourceXml || '', 'utf-8');
    localSaved = true;
  } catch (e) {
    logger.warn('saveContextMemoryItem: write local summary failed', { groupId, err: String(e) });
  }

  const serialized = JSON.stringify(item);

  try {
    await redis.rpush(key, serialized);
    const { ttlSeconds } = getContextMemoryRuntimeConfig();
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await redis.expire(key, ttlSeconds);
    }
    logger.info(`saveContextMemoryItem: saved summary for ${groupId} date=${dateStr}`);
    return {
      saved: true,
      redisSaved: true,
      localSaved,
      reason: '',
      date: dateStr,
      key,
      sourceDir: item.sourceDir
    };
  } catch (e) {
    logger.warn('saveContextMemoryItem failed', { groupId, err: String(e) });
    return {
      saved: false,
      redisSaved: false,
      localSaved,
      reason: 'redis_write_failed',
      date: dateStr,
      key,
      sourceDir: item.sourceDir
    };
  }
}

function formatTimeRangeText(timeStart: number | null, timeEnd: number | null): string {
  if (!timeStart && !timeEnd) {
    return '';
  }

  try {
    const { timezone } = getContextMemoryRuntimeConfig();
    const fmt = (ms: number) => DateTime.fromMillis(ms).setZone(timezone).toFormat('yyyy-LL-dd HH:mm:ss');
    const hasStart = typeof timeStart === 'number' && timeStart > 0;
    const hasEnd = typeof timeEnd === 'number' && timeEnd > 0;

    if (hasStart && hasEnd) {
      return `${fmt(timeStart)} ~ ${fmt(timeEnd)}\u3010\u672c\u6b21\u8bb0\u5fc6\u7bc7\u8f7d\u7684\u5bf9\u8bdd\u65f6\u95f4\u8303\u56f4\u3011`;
    }
    if (hasStart) {
      return `${fmt(timeStart)} ~ \u5f53\u524d/\u672a\u77e3\u7ec8\u70b9\u3010\u6b64\u6b21\u8bb0\u5fc6\u4ee5\u8fd9\u4e2a\u65f6\u95f4\u4e3a\u8d77\u70b9\u3011`;
    }
    if (hasEnd) {
      return `\u672a\u77e3\u8d77\u70b9 ~ ${fmt(timeEnd)}\u3010\u672c\u6b21\u8bb0\u5fc6\u7d2f\u79ef\u5230\u8fd9\u4e2a\u65f6\u523b\u3011`;
    }
    return '';
  } catch {
    return '';
  }
}

export async function getDailyContextMemoryXml(groupId: string | number, nowMs: number = Date.now()): Promise<string> {
  try {
    const redis = getRedisSafe();
    if (!redis) return '';

    const { timezone } = getContextMemoryRuntimeConfig();
    const dateStr = formatDateFromMillis(nowMs, timezone);
    const keyV2 = buildDailySummaryKey(groupId, dateStr);
    let list = await redis.lrange(keyV2, 0, -1);
    if (!Array.isArray(list) || list.length === 0) {
      const keyLegacy = buildDailyKey(groupId, dateStr);
      list = await redis.lrange(keyLegacy, 0, -1);
    }

    if (!Array.isArray(list) || list.length === 0) {
      return '';
    }

    const items: ContextMemoryRow[] = [];
    for (const raw of list) {
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj.summary !== 'string' || !obj.summary.trim()) continue;
        items.push({
          summary: obj.summary,
          timeStart: typeof obj.timeStart === 'number' ? obj.timeStart : null,
          timeEnd: typeof obj.timeEnd === 'number' ? obj.timeEnd : null,
          keywords: normalizeStringArray((obj as Record<string, unknown>).keywords, 24),
          eventBoard: normalizeStringArray(
            (obj as Record<string, unknown>).eventBoard ?? (obj as Record<string, unknown>).clues,
            24
          ),
          artifacts: normalizeArtifacts((obj as Record<string, unknown>).artifacts)
        });
      } catch {
      }
    }

    if (items.length === 0) {
      return '';
    }

    let xml = '<sentra-memory>\n';
    xml += `  <date>${escapeXml(dateStr)}</date>\n`;
    xml += '  <items>\n';

    items.forEach((item: ContextMemoryRow, index: number) => {
      const idx = index + 1;
      const rangeText = formatTimeRangeText(item.timeStart ?? null, item.timeEnd ?? null);
      xml += `    <item index="${escapeXmlAttr(String(idx))}">\n`;
      if (rangeText) {
        xml += `      <time_range>${escapeXml(rangeText)}</time_range>\n`;
      }
      xml += `      <summary>${escapeXml(item.summary)}</summary>\n`;
      if (Array.isArray(item.keywords) && item.keywords.length > 0) {
        xml += '      <keywords>\n';
        for (const kw of item.keywords) {
          xml += `        <keyword>${escapeXml(String(kw || ''))}</keyword>\n`;
        }
        xml += '      </keywords>\n';
      }
      if (Array.isArray(item.eventBoard) && item.eventBoard.length > 0) {
        xml += '      <event_board>\n';
        for (const eventCard of item.eventBoard) {
          xml += `        <event>${escapeXml(String(eventCard || ''))}</event>\n`;
        }
        xml += '      </event_board>\n';
      }
      if (Array.isArray(item.artifacts) && item.artifacts.length > 0) {
        xml += '      <artifacts>\n';
        for (const art of item.artifacts.slice(0, 32)) {
          xml +=
            `        <artifact captain="${escapeXmlAttr(String(art.captain || 'artifact'))}"` +
            ` path="${escapeXmlAttr(String(art.outputPath || art.path || art.originalPath || ''))}"` +
            ` url="${escapeXmlAttr(String(art.url || ''))}"` +
            ` kind="${escapeXmlAttr(String(art.kind || ''))}"` +
            ` type="${escapeXmlAttr(String(art.type || ''))}" />\n`;
        }
        xml += '      </artifacts>\n';
      }
      xml += '    </item>\n';
    });

    xml += '  </items>\n';
    xml += '</sentra-memory>';

    return xml;
  } catch (e) {
    logger.warn('getDailyContextMemoryXml failed', { groupId, err: String(e) });
    return '';
  }
}
