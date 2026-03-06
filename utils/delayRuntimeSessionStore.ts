import { createLogger } from './logger.js';
import {
  DELAY_REASON_CODE,
  normalizeDelayReasonArgs,
  normalizeDelayReasonCode,
  type DelayReasonArgs,
  type DelayReasonCode
} from './delayReasonCodes.js';
import type { DelayReplayToolResultEvent } from './delayRuntimeTypes.js';
import { tDelayRuntimeSessionStore } from './i18n/delayRuntimeSessionStoreCatalog.js';

const logger = createLogger('DelayRuntimeSessionStore');

type DelayRuntimeReplayEvent = DelayReplayToolResultEvent;
type DelayRuntimeBaseMessage = Record<string, unknown>;

export type DelayRuntimeSession = {
  sessionId: string;
  createdAt: number;
  fireAt: number;
  dueFiredAt: number | null;
  completedAt: number | null;
  runId: string;
  type: string;
  groupId: string;
  userId: string;
  senderId: string;
  delayWhenText: string;
  delayTargetISO: string;
  reason: string;
  reasonCode: DelayReasonCode;
  reasonArgs: DelayReasonArgs;
  deferredResponseXml: string;
  bufferedEvents: DelayRuntimeReplayEvent[];
  baseMessage: DelayRuntimeBaseMessage | null;
  replayCursor: {
    nextOffset: number;
    totalEvents: number;
    status: string;
    lastReplayRunId: string;
    updatedAt: number;
  };
};

type CreateDelayRuntimeSessionParams = {
  sessionId: string;
  fireAt: number;
  runId?: string;
  type?: string;
  groupId?: string | number | null;
  userId?: string | number | null;
  senderId?: string | number | null;
  delayWhenText?: string;
  delayTargetISO?: string;
  reason?: string;
  reasonCode?: DelayReasonCode | string;
  reasonArgs?: DelayReasonArgs | null;
  deferredResponseXml?: string;
  baseMessage?: DelayRuntimeBaseMessage | null;
};

type DelayRuntimeSessionPatch = Partial<Omit<DelayRuntimeSession, 'sessionId' | 'createdAt'>>;

const sessions = new Map<string, DelayRuntimeSession>();

const MAX_BUFFERED_EVENTS = 400;
const MAX_DELAY_RUNTIME_SESSIONS = 1024;
const RETAIN_AFTER_COMPLETED_MS = 30 * 60 * 1000;
const RETAIN_AFTER_DUE_MS = 60 * 60 * 1000;
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeId(value: unknown): string {
  const s = String(value ?? '').trim();
  return s;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneEvent(event: unknown): DelayRuntimeReplayEvent {
  if (!event || typeof event !== 'object') return {};
  return { ...(event as Record<string, unknown>) };
}

function cloneReasonArgs(value: unknown): DelayReasonArgs {
  return normalizeDelayReasonArgs(value);
}

function normalizeReplayCursor(value: unknown, fallback: DelayRuntimeSession['replayCursor']): DelayRuntimeSession['replayCursor'] {
  const src = (value && typeof value === 'object' && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};
  const nextOffsetRaw = Number(src.nextOffset);
  const totalEventsRaw = Number(src.totalEvents);
  return {
    nextOffset: Number.isFinite(nextOffsetRaw) && nextOffsetRaw >= 0
      ? Math.trunc(nextOffsetRaw)
      : Math.max(0, Number(fallback?.nextOffset || 0)),
    totalEvents: Number.isFinite(totalEventsRaw) && totalEventsRaw >= 0
      ? Math.trunc(totalEventsRaw)
      : Math.max(0, Number(fallback?.totalEvents || 0)),
    status: normalizeId(src.status ?? fallback?.status ?? ''),
    lastReplayRunId: normalizeId(src.lastReplayRunId ?? fallback?.lastReplayRunId ?? ''),
    updatedAt: toFiniteNumber(src.updatedAt, toFiniteNumber(fallback?.updatedAt, Date.now()))
  };
}

function pruneDelayRuntimeSessions(now = Date.now()): void {
  if (!sessions.size) return;
  let removedByCompleted = 0;
  let removedByDue = 0;
  let removedByAge = 0;
  let removedByCapacity = 0;

  for (const [sessionId, session] of sessions.entries()) {
    const completedAt = Number(session.completedAt || 0);
    const dueFiredAt = Number(session.dueFiredAt || 0);
    const createdAt = Number(session.createdAt || 0);

    if (completedAt > 0 && now - completedAt > RETAIN_AFTER_COMPLETED_MS) {
      sessions.delete(sessionId);
      removedByCompleted++;
      continue;
    }
    if (dueFiredAt > 0 && now - dueFiredAt > RETAIN_AFTER_DUE_MS) {
      sessions.delete(sessionId);
      removedByDue++;
      continue;
    }
    if (createdAt > 0 && now - createdAt > MAX_SESSION_AGE_MS) {
      sessions.delete(sessionId);
      removedByAge++;
      continue;
    }
  }

  if (sessions.size > MAX_DELAY_RUNTIME_SESSIONS) {
    const ordered = Array.from(sessions.values()).sort((a, b) => a.createdAt - b.createdAt);
    const removeCount = Math.max(0, ordered.length - MAX_DELAY_RUNTIME_SESSIONS);
    for (let i = 0; i < removeCount; i++) {
      const sessionId = String(ordered[i]?.sessionId || '').trim();
      if (!sessionId) continue;
      if (sessions.delete(sessionId)) {
        removedByCapacity++;
      }
    }
  }

  const removedTotal = removedByCompleted + removedByDue + removedByAge + removedByCapacity;
  if (removedTotal > 0) {
    logger.debug(tDelayRuntimeSessionStore('sessions_pruned'), {
      removedTotal,
      removedByCompleted,
      removedByDue,
      removedByAge,
      removedByCapacity,
      remaining: sessions.size
    });
  }
}

function buildSession(params: CreateDelayRuntimeSessionParams): DelayRuntimeSession {
  const now = Date.now();
  return {
    sessionId: normalizeId(params.sessionId),
    createdAt: now,
    fireAt: toFiniteNumber(params.fireAt, now),
    dueFiredAt: null,
    completedAt: null,
    runId: normalizeId(params.runId),
    type: normalizeId(params.type || 'private') || 'private',
    groupId: normalizeId(params.groupId),
    userId: normalizeId(params.userId),
    senderId: normalizeId(params.senderId),
    delayWhenText: normalizeId(params.delayWhenText),
    delayTargetISO: normalizeId(params.delayTargetISO),
    reason: normalizeId(params.reason),
    reasonCode: normalizeDelayReasonCode(params.reasonCode ?? params.reason, DELAY_REASON_CODE.dueReplay),
    reasonArgs: cloneReasonArgs(params.reasonArgs),
    deferredResponseXml: normalizeId(params.deferredResponseXml),
    bufferedEvents: [],
    baseMessage: params.baseMessage && typeof params.baseMessage === 'object'
      ? { ...(params.baseMessage as Record<string, unknown>) }
      : null,
    replayCursor: {
      nextOffset: 0,
      totalEvents: 0,
      status: 'pending',
      lastReplayRunId: '',
      updatedAt: now
    }
  };
}

export function createDelayRuntimeSession(params: CreateDelayRuntimeSessionParams): DelayRuntimeSession {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(params.sessionId);
  if (!sessionId) {
    throw new Error('createDelayRuntimeSession requires non-empty sessionId');
  }

  const existing = sessions.get(sessionId);
  if (existing) {
    return updateDelayRuntimeSession(sessionId, {
      fireAt: toFiniteNumber(params.fireAt, existing.fireAt),
      runId: normalizeId(params.runId) || existing.runId,
      type: normalizeId(params.type) || existing.type,
      groupId: normalizeId(params.groupId) || existing.groupId,
      userId: normalizeId(params.userId) || existing.userId,
      senderId: normalizeId(params.senderId) || existing.senderId,
      delayWhenText: normalizeId(params.delayWhenText) || existing.delayWhenText,
      delayTargetISO: normalizeId(params.delayTargetISO) || existing.delayTargetISO,
      reason: normalizeId(params.reason) || existing.reason,
      reasonCode: normalizeDelayReasonCode(params.reasonCode, existing.reasonCode),
      reasonArgs: params.reasonArgs != null ? cloneReasonArgs(params.reasonArgs) : existing.reasonArgs,
      deferredResponseXml: normalizeId(params.deferredResponseXml) || existing.deferredResponseXml,
      baseMessage: params.baseMessage && typeof params.baseMessage === 'object'
        ? { ...(params.baseMessage as Record<string, unknown>) }
        : existing.baseMessage
    });
  }

  const created = buildSession(params);
  sessions.set(sessionId, created);
  logger.debug(tDelayRuntimeSessionStore('session_created'), {
    sessionId,
    fireAt: created.fireAt,
    runId: created.runId || null
  });
  return {
    ...created,
    reasonArgs: cloneReasonArgs(created.reasonArgs),
    bufferedEvents: created.bufferedEvents.map(cloneEvent),
    replayCursor: normalizeReplayCursor(created.replayCursor, created.replayCursor)
  };
}

export function getDelayRuntimeSessionSnapshot(sessionIdRaw: unknown): DelayRuntimeSession | null {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return null;
  const current = sessions.get(sessionId);
  if (!current) return null;
  return {
    ...current,
    reasonArgs: cloneReasonArgs(current.reasonArgs),
    bufferedEvents: current.bufferedEvents.map(cloneEvent),
    baseMessage: current.baseMessage ? { ...current.baseMessage } : null,
    replayCursor: normalizeReplayCursor(current.replayCursor, current.replayCursor)
  };
}

export function updateDelayRuntimeSession(sessionIdRaw: unknown, patch: DelayRuntimeSessionPatch): DelayRuntimeSession {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) {
    throw new Error('updateDelayRuntimeSession requires non-empty sessionId');
  }
  const current = sessions.get(sessionId);
  if (!current) {
    throw new Error(`delay session not found: ${sessionId}`);
  }

  const next: DelayRuntimeSession = {
    ...current,
    ...patch,
    runId: patch.runId != null ? normalizeId(patch.runId) : current.runId,
    type: patch.type != null ? normalizeId(patch.type) || current.type : current.type,
    groupId: patch.groupId != null ? normalizeId(patch.groupId) : current.groupId,
    userId: patch.userId != null ? normalizeId(patch.userId) : current.userId,
    senderId: patch.senderId != null ? normalizeId(patch.senderId) : current.senderId,
    delayWhenText: patch.delayWhenText != null ? normalizeId(patch.delayWhenText) : current.delayWhenText,
    delayTargetISO: patch.delayTargetISO != null ? normalizeId(patch.delayTargetISO) : current.delayTargetISO,
    reason: patch.reason != null ? normalizeId(patch.reason) : current.reason,
    reasonCode: patch.reasonCode != null
      ? normalizeDelayReasonCode(patch.reasonCode, current.reasonCode)
      : current.reasonCode,
    reasonArgs: patch.reasonArgs != null ? cloneReasonArgs(patch.reasonArgs) : current.reasonArgs,
    deferredResponseXml: patch.deferredResponseXml != null ? normalizeId(patch.deferredResponseXml) : current.deferredResponseXml,
    bufferedEvents: Array.isArray(patch.bufferedEvents)
      ? patch.bufferedEvents.map(cloneEvent).slice(-MAX_BUFFERED_EVENTS)
      : current.bufferedEvents,
    baseMessage: patch.baseMessage === undefined
      ? current.baseMessage
      : (patch.baseMessage && typeof patch.baseMessage === 'object'
        ? { ...(patch.baseMessage as Record<string, unknown>) }
        : null),
    fireAt: patch.fireAt !== undefined ? toFiniteNumber(patch.fireAt, current.fireAt) : current.fireAt,
    dueFiredAt: patch.dueFiredAt !== undefined
      ? (patch.dueFiredAt == null ? null : toFiniteNumber(patch.dueFiredAt, current.dueFiredAt || Date.now()))
      : current.dueFiredAt,
    completedAt: patch.completedAt !== undefined
      ? (patch.completedAt == null ? null : toFiniteNumber(patch.completedAt, current.completedAt || Date.now()))
      : current.completedAt,
    replayCursor: patch.replayCursor !== undefined
      ? normalizeReplayCursor(patch.replayCursor, current.replayCursor)
      : current.replayCursor
  };

  sessions.set(sessionId, next);
  return {
    ...next,
    reasonArgs: cloneReasonArgs(next.reasonArgs),
    bufferedEvents: next.bufferedEvents.map(cloneEvent),
    baseMessage: next.baseMessage ? { ...next.baseMessage } : null,
    replayCursor: normalizeReplayCursor(next.replayCursor, next.replayCursor)
  };
}

export function appendDelayRuntimeSessionEvent(sessionIdRaw: unknown, event: unknown): DelayRuntimeSession | null {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return null;
  const current = sessions.get(sessionId);
  if (!current) return null;
  current.bufferedEvents.push(cloneEvent(event));
  if (current.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
    current.bufferedEvents.splice(0, current.bufferedEvents.length - MAX_BUFFERED_EVENTS);
  }
  current.replayCursor = normalizeReplayCursor({
    ...current.replayCursor,
    totalEvents: current.bufferedEvents.length,
    updatedAt: Date.now()
  }, current.replayCursor);
  sessions.set(sessionId, current);
  return {
    ...current,
    reasonArgs: cloneReasonArgs(current.reasonArgs),
    bufferedEvents: current.bufferedEvents.map(cloneEvent),
    baseMessage: current.baseMessage ? { ...current.baseMessage } : null,
    replayCursor: normalizeReplayCursor(current.replayCursor, current.replayCursor)
  };
}

export function markDelayRuntimeSessionCompleted(sessionIdRaw: unknown, completedAt = Date.now()): DelayRuntimeSession | null {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return null;
  const current = sessions.get(sessionId);
  if (!current) return null;
  current.completedAt = toFiniteNumber(completedAt, Date.now());
  current.replayCursor = normalizeReplayCursor({
    ...current.replayCursor,
    status: 'completed',
    updatedAt: Date.now()
  }, current.replayCursor);
  sessions.set(sessionId, current);
  return {
    ...current,
    reasonArgs: cloneReasonArgs(current.reasonArgs),
    bufferedEvents: current.bufferedEvents.map(cloneEvent),
    baseMessage: current.baseMessage ? { ...current.baseMessage } : null,
    replayCursor: normalizeReplayCursor(current.replayCursor, current.replayCursor)
  };
}

export function markDelayRuntimeSessionDueFired(sessionIdRaw: unknown, dueAt = Date.now()): DelayRuntimeSession | null {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return null;
  const current = sessions.get(sessionId);
  if (!current) return null;
  current.dueFiredAt = toFiniteNumber(dueAt, Date.now());
  current.replayCursor = normalizeReplayCursor({
    ...current.replayCursor,
    status: 'due_fired',
    updatedAt: Date.now()
  }, current.replayCursor);
  sessions.set(sessionId, current);
  return {
    ...current,
    reasonArgs: cloneReasonArgs(current.reasonArgs),
    bufferedEvents: current.bufferedEvents.map(cloneEvent),
    baseMessage: current.baseMessage ? { ...current.baseMessage } : null,
    replayCursor: normalizeReplayCursor(current.replayCursor, current.replayCursor)
  };
}

export function isDelayRuntimeSessionDueFired(sessionIdRaw: unknown): boolean {
  pruneDelayRuntimeSessions();

  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return false;
  const current = sessions.get(sessionId);
  return !!(current && Number.isFinite(Number(current.dueFiredAt)) && Number(current.dueFiredAt) > 0);
}

export function deleteDelayRuntimeSession(sessionIdRaw: unknown): void {
  const sessionId = normalizeId(sessionIdRaw);
  if (!sessionId) return;
  sessions.delete(sessionId);
}
