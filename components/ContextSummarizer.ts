import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../src/types.js';
import { createLogger } from '../utils/logger.js';
import { compressContext } from '../utils/contextCompressor.js';
import { getEnv, getEnvInt, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import {
  acquireContextSummaryLease,
  buildContextMemoryEventsXml,
  collectArtifactsFromContextEvents,
  getLastSummarizedPairCount,
  getUnsummarizedContextMemoryEvents,
  releaseContextSummaryLease,
  saveContextMemoryItem,
  setLastSummarizedPairCount
} from '../utils/contextMemoryManager.js';

const logger = createLogger('ContextSummarizer');
const CONTEXT_MEMORY_IDLE_MINUTES_FIXED = 30;
const CONTEXT_MEMORY_SUMMARY_LEASE_SECONDS = 180;
const CONTEXT_MEMORY_POLICY = {
  forceExtraTokens: 2048,
  forceRatio: 1.5,
  keywordTopN: 12,
  maxSummarySentences: 4
} as const;

interface ContextSummarizerOptions {
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  groupId?: string;
  chatType?: string;
  userId?: string;
  CONTEXT_MEMORY_ENABLED?: boolean;
  CONTEXT_MEMORY_MODEL?: string;
  MAIN_AI_MODEL?: string;
  presetPlainText?: string;
  presetRawText?: string;
}

function clipText(raw: unknown, max = 12000): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function mergeStringList(
  primary: unknown,
  secondary: unknown,
  max = 12,
  itemMax = 120
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushFrom = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const text = String(item ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const clipped = text.length > itemMax ? text.slice(0, itemMax) : text;
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clipped);
      if (out.length >= max) return;
    }
  };
  pushFrom(primary);
  if (out.length < max) pushFrom(secondary);
  return out;
}

function mergeArtifacts(primary: unknown, secondary: unknown, max = 64): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pushFrom = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const row of arr) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const captain = clipText(rec.captain, 120);
      const outputPath = clipText(rec.outputPath ?? rec.path ?? rec.originalPath, 1200);
      const url = clipText(rec.url, 1200);
      const note = clipText(rec.note ?? rec.desc, 240);
      const key = `${captain.toLowerCase()}|${outputPath.toLowerCase()}|${url.toLowerCase()}|${note.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...(captain ? { captain } : {}),
        ...(clipText(rec.type, 80) ? { type: clipText(rec.type, 80) } : {}),
        ...(clipText(rec.kind, 80) ? { kind: clipText(rec.kind, 80) } : {}),
        ...(outputPath ? { outputPath } : {}),
        ...(url ? { url } : {}),
        ...(note ? { note } : {})
      });
      if (out.length >= max) return;
    }
  };
  pushFrom(primary);
  if (out.length < max) pushFrom(secondary);
  return out;
}

function readToolResultErrorText(result: Record<string, unknown>): string {
  const err = result?.error;
  if (typeof err === 'string' && err.trim()) return clipText(err, 600);
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    if (typeof rec.message === 'string' && rec.message.trim()) return clipText(rec.message, 600);
  }
  if (typeof result.message === 'string' && result.message.trim()) return clipText(result.message, 600);
  if (typeof result.reason === 'string' && result.reason.trim()) return clipText(result.reason, 600);
  return '';
}

function buildToolResultsDigest(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines: string[] = [];
  const maxLines = 48;
  for (let i = 0; i < items.length && lines.length < maxLines; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const aiName = clipText(rec.aiName, 80);
    const stepId = clipText(rec.stepId, 120);
    const elapsedMs = Number(rec.elapsedMs);
    const result = rec.result && typeof rec.result === 'object'
      ? (rec.result as Record<string, unknown>)
      : {};
    const success = result.success === true ? 'ok' : 'fail';
    const code = clipText(result.code, 48);
    const provider = clipText(result.provider, 48);
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts.length : 0;
    const errorText = readToolResultErrorText(result);
    const line = [
      `${i + 1}. tool=${aiName || 'unknown'}`,
      stepId ? `step=${stepId}` : '',
      Number.isFinite(elapsedMs) ? `elapsedMs=${elapsedMs}` : '',
      `success=${success}`,
      code ? `code=${code}` : '',
      provider ? `provider=${provider}` : '',
      `artifacts=${artifacts}`,
      errorText ? `error=${clipText(errorText, 200)}` : ''
    ].filter(Boolean).join(' | ');
    if (!line) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function buildAssistantResponsesDigest(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines: string[] = [];
  const maxLines = 40;
  for (let i = 0; i < items.length && lines.length < maxLines; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const phase = clipText(rec.phase, 48);
    const delivered = rec.delivered === true;
    const noReply = rec.noReply === true;
    const content = clipText(rec.content, 64000);
    const line = [
      `${i + 1}. phase=${phase || 'unknown'}`,
      `delivered=${delivered}`,
      `noReply=${noReply}`,
      content ? `content=${content}` : ''
    ].filter(Boolean).join(' | ');
    if (!line) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function buildConversationsFromEvents(events: Array<Record<string, unknown>>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const ev of events) {
    const objective = clipText(ev.objective, 12000);
    const contentText = clipText(ev.contentText, 12000);
    const objectiveXml = clipText(ev.objectiveXml, 16000);
    const contentXml = clipText(ev.contentXml, 16000);
    const summaryText = clipText(ev.summaryText, 12000);
    const reasons = Array.isArray(ev.reasons) ? ev.reasons.map((x) => clipText(x, 240)).filter(Boolean) : [];
    const toolResults = buildToolResultsDigest(ev.toolResults);
    const assistantResponses = buildAssistantResponsesDigest(ev.assistantResponses);
    const userParts: string[] = [];
    const pushUnique = (value: string) => {
      const text = String(value || '').trim();
      if (!text) return;
      if (userParts.includes(text)) return;
      userParts.push(text);
    };
    pushUnique(objective);
    if (contentText && contentText !== objective) pushUnique(contentText);
    pushUnique(objectiveXml);
    pushUnique(contentXml);
    if (userParts.length > 0) {
      out.push({ role: 'user', content: userParts.join('\n\n') });
    }

    const assistantParts = [summaryText, reasons.join('\n'), toolResults, assistantResponses].filter(Boolean);
    if (assistantParts.length > 0) {
      out.push({ role: 'assistant', content: assistantParts.join('\n\n') });
    }
  }
  return out;
}

export async function triggerContextSummarizationIfNeededCore(options: ContextSummarizerOptions = {}) {
  const {
    agent,
    groupId,
    chatType,
    userId,
    CONTEXT_MEMORY_ENABLED,
    CONTEXT_MEMORY_MODEL,
    MAIN_AI_MODEL,
    presetPlainText,
    presetRawText
  } = options;

  if (!CONTEXT_MEMORY_ENABLED) return;
  if (!agent || !groupId) return;

  const leaseOwner = randomUUID();
  const leaseAcquired = await acquireContextSummaryLease(
    groupId,
    leaseOwner,
    CONTEXT_MEMORY_SUMMARY_LEASE_SECONDS
  );
  if (!leaseAcquired) {
    logger.debug(`[${groupId}] ContextMemory: summary lease busy, skip this round`);
    return;
  }

  try {
    const slice = await getUnsummarizedContextMemoryEvents(groupId);
    if (!slice.events.length) return;

    const triggerTokensRaw = getEnvInt('CONTEXT_MEMORY_TRIGGER_TOKENS', 8192) ?? 8192;
    const triggerTokens = Number.isFinite(triggerTokensRaw) && triggerTokensRaw > 0 ? triggerTokensRaw : 8192;
    const halfTokens = Math.max(1, Math.floor(triggerTokens / 2));
    const idleMs = CONTEXT_MEMORY_IDLE_MINUTES_FIXED * 60 * 1000;
    const forceTokens = Math.max(
      triggerTokens + CONTEXT_MEMORY_POLICY.forceExtraTokens,
      Math.floor(triggerTokens * CONTEXT_MEMORY_POLICY.forceRatio)
    );
    const now = Date.now();
    const idleReached = typeof slice.lastEventAt === 'number' && slice.lastEventAt > 0
      ? now - slice.lastEventAt >= idleMs
      : false;

    const shouldTrigger =
      slice.unsummarizedTokens >= forceTokens ||
      slice.unsummarizedTokens >= triggerTokens ||
      (slice.unsummarizedTokens >= halfTokens && idleReached);

    if (!shouldTrigger) {
      logger.debug(
        `[${groupId}] ContextMemory: skip summary tokens=${slice.unsummarizedTokens}, trigger=${triggerTokens}, half=${halfTokens}, idleReached=${idleReached}`
      );
      return;
    }

    const conversations = buildConversationsFromEvents(slice.events as Array<Record<string, unknown>>);
    if (!conversations.length) {
      await setLastSummarizedPairCount(groupId, slice.endCursor);
      return;
    }

    const model = CONTEXT_MEMORY_MODEL || MAIN_AI_MODEL;
    const timeout = getEnvTimeoutMs(
      'CONTEXT_MEMORY_TIMEOUT_MS',
      getEnvTimeoutMs('TIMEOUT', 180000, 900000),
      900000
    );
    const contextMemoryBaseUrl = getEnv('CONTEXT_MEMORY_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
    const contextMemoryApiKey = getEnv('CONTEXT_MEMORY_API_KEY', getEnv('API_KEY'));
    const presetText = presetPlainText || presetRawText || '';

    const compressParams: {
      agent: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
      historyConversations: ChatMessage[];
      chatType: 'group' | 'private';
      maxSummarySentences: number;
      groupId?: string;
      userId?: string;
      timeStart?: number;
      timeEnd?: number;
      model?: string;
      presetText?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      timeout?: number;
    } = {
      agent,
      historyConversations: conversations,
      chatType: chatType === 'group' ? 'group' : 'private',
      maxSummarySentences: CONTEXT_MEMORY_POLICY.maxSummarySentences
    };

    if (groupId) compressParams.groupId = groupId;
    if (userId) compressParams.userId = userId;
    if (typeof slice.timeStart === 'number') compressParams.timeStart = slice.timeStart;
    if (typeof slice.timeEnd === 'number') compressParams.timeEnd = slice.timeEnd;
    if (model) compressParams.model = model;
    if (presetText) compressParams.presetText = presetText;
    if (contextMemoryBaseUrl) compressParams.apiBaseUrl = contextMemoryBaseUrl;
    if (contextMemoryApiKey) compressParams.apiKey = contextMemoryApiKey;
    if (Number.isFinite(timeout) && timeout > 0) compressParams.timeout = timeout;

    logger.info(
      `[${groupId}] ContextMemory: begin summary events=${slice.events.length}, tokens=${slice.unsummarizedTokens}, model=${model || 'default'}`
    );
    const {
      summary,
      keywords: modelKeywords,
      eventBoard: modelEventBoard
    } = await compressContext(compressParams);
    const summaryText = String(summary || '').trim();
    if (!summaryText) {
      await setLastSummarizedPairCount(groupId, slice.endCursor);
      return;
    }

    const latestCursor = await getLastSummarizedPairCount(groupId);
    if (latestCursor >= slice.endCursor) {
      logger.debug(
        `[${groupId}] ContextMemory: cursor already advanced to ${latestCursor}, skip duplicate save for ${slice.endCursor}`
      );
      return;
    }

    const sourceXml = buildContextMemoryEventsXml(groupId, slice.events);
    const eventArtifacts = collectArtifactsFromContextEvents(slice.events);
    const keywords = mergeStringList(modelKeywords, [], CONTEXT_MEMORY_POLICY.keywordTopN, 80);
    const eventBoard = mergeStringList(modelEventBoard, [], 24, 2000);
    const artifacts = mergeArtifacts(eventArtifacts, [], 64);

    const saveResult = await saveContextMemoryItem(groupId, {
      summary: summaryText,
      timeStart: slice.timeStart,
      timeEnd: slice.timeEnd,
      keywords,
      eventBoard,
      artifacts,
      sourceXml,
      eventRange: {
        startCursor: slice.startCursor,
        endCursor: slice.endCursor,
        count: slice.events.length,
        tokens: slice.unsummarizedTokens
      },
      ...(model ? { model } : {}),
      ...(chatType ? { chatType } : {}),
      ...(userId ? { userId } : {})
    });

    if (!saveResult.saved) {
      logger.warn(
        `[${groupId}] ContextMemory: summary save failed, cursor not advanced reason=${saveResult.reason || 'unknown'}`
      );
      return;
    }

    await setLastSummarizedPairCount(groupId, slice.endCursor);
    logger.info(
      `[${groupId}] ContextMemory: summary saved events=${slice.events.length}, cursor=${slice.endCursor}`
    );
  } catch (e) {
    logger.warn(`ContextMemory: summarize failed ${groupId}`, { err: String(e) });
  } finally {
    await releaseContextSummaryLease(groupId, leaseOwner);
  }
}
