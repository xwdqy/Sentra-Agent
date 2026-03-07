import { createLogger } from '../utils/logger.js';
import {
  createDelayRuntimeSession,
  getDelayRuntimeSessionSnapshot,
  markDelayRuntimeSessionDueFired,
  updateDelayRuntimeSession
} from '../utils/delayRuntimeSessionStore.js';
import {
  type DelayReasonArgs,
  type DelayReasonCode,
  DELAY_REASON_CODE,
  normalizeDelayReasonArgs,
  normalizeDelayReasonCode
} from '../utils/delayReasonCodes.js';
import { DELAY_RUNTIME_KIND } from '../utils/delayRuntimeConstants.js';
import type { DelayDueTriggerJob, DelayReplayToolResultEvent } from '../utils/delayRuntimeTypes.js';
import { tDelayJobWorker } from '../utils/i18n/delayJobWorkerCatalog.js';

const logger = createLogger('DelayJobWorker');

type BaseMessage = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  text?: string;
  summary?: string;
  message_id?: string | number | null;
  [key: string]: unknown;
};

type DelayJob = DelayDueTriggerJob & {
  reasonCode?: DelayReasonCode | string;
  reasonArgs?: DelayReasonArgs;
};

type DelayJobContext = {
  loadMessageCache?: (runId: string) => Promise<{ message?: BaseMessage } | null>;
  dispatchToMainPipeline?: (msg: BaseMessage & Record<string, unknown>, taskId?: string | null) => Promise<void>;
  dispatchRuntimeEvent?: (event: {
    type: 'delay_due_triggered';
    payload: Record<string, unknown>;
  }) => Promise<void>;
  loadDelayRuntimeSessionFromRuntimeStore?: (params: {
    delaySessionId?: string;
    runId?: string;
    orchestratorRunId?: string;
  }) => Promise<Record<string, unknown> | null>;
  persistDelayRuntimeSessionToRuntimeStore?: (params: {
    runId?: string;
    orchestratorRunId?: string;
    session: Record<string, unknown>;
    eventType: string;
  }) => Promise<void>;
  randomUUID?: () => string;
  [key: string]: unknown;
};

type DelayRuntimeSessionFromStore = {
  sessionId: string;
  createdAt: number;
  fireAt: number;
  dueFiredAt: number;
  completedAt: number;
  runId: string;
  type: string;
  groupId: string;
  userId: string;
  senderId: string;
  delayWhenText: string;
  delayTargetISO: string;
  reason: string;
  reasonCode: string;
  reasonArgs: DelayReasonArgs;
  deferredResponseXml: string;
  bufferedEvents: DelayReplayToolResultEvent[];
  baseMessage: BaseMessage | null;
  replayCursor: {
    nextOffset: number;
    totalEvents: number;
    status: string;
    lastReplayRunId: string;
    updatedAt: number;
  };
  checkpointRunId: string;
  orchestratorRunId: string;
  parentRunId: string;
  updatedAt: number;
};

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeDelayRuntimeSessionFromStore(raw: unknown): DelayRuntimeSessionFromStore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const sessionId = String(src.sessionId || '').trim();
  if (!sessionId) return null;
  const bufferedEvents = normalizeDeferredToolEvents(src.bufferedEvents);
  const reasonArgs = normalizeDelayReasonArgs(src.reasonArgs);
  const baseMessage = (src.baseMessage && typeof src.baseMessage === 'object' && !Array.isArray(src.baseMessage))
    ? { ...(src.baseMessage as Record<string, unknown>) } as BaseMessage
    : null;
  const replayCursorRaw = (src.replayCursor && typeof src.replayCursor === 'object' && !Array.isArray(src.replayCursor))
    ? (src.replayCursor as Record<string, unknown>)
    : {};
  return {
    sessionId,
    createdAt: toFiniteInt(src.createdAt, 0),
    fireAt: toFiniteInt(src.fireAt, 0),
    dueFiredAt: toFiniteInt(src.dueFiredAt, 0),
    completedAt: toFiniteInt(src.completedAt, 0),
    runId: String(src.runId || '').trim(),
    type: String(src.type || '').trim(),
    groupId: String(src.groupId || '').trim(),
    userId: String(src.userId || '').trim(),
    senderId: String(src.senderId || '').trim(),
    delayWhenText: String(src.delayWhenText || '').trim(),
    delayTargetISO: String(src.delayTargetISO || '').trim(),
    reason: String(src.reason || '').trim(),
    reasonCode: String(src.reasonCode || '').trim(),
    reasonArgs,
    deferredResponseXml: String(src.deferredResponseXml || '').trim(),
    bufferedEvents,
    baseMessage,
    replayCursor: {
      nextOffset: toFiniteInt(replayCursorRaw.nextOffset, 0),
      totalEvents: toFiniteInt(replayCursorRaw.totalEvents, bufferedEvents.length),
      status: String(replayCursorRaw.status || '').trim(),
      lastReplayRunId: String(replayCursorRaw.lastReplayRunId || '').trim(),
      updatedAt: toFiniteInt(replayCursorRaw.updatedAt, 0)
    },
    checkpointRunId: String(src.checkpointRunId || '').trim(),
    orchestratorRunId: String(src.orchestratorRunId || '').trim(),
    parentRunId: String(src.parentRunId || '').trim(),
    updatedAt: toFiniteInt(src.updatedAt, 0)
  };
}

function normalizeDeferredToolEvents(raw: unknown): DelayReplayToolResultEvent[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: DelayReplayToolResultEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    const normalized: DelayReplayToolResultEvent = {
      ...src,
      type: typeof src.type === 'string' ? src.type : 'tool_result'
    };
    if (Array.isArray(src.events)) {
      normalized.events = src.events
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({ ...(x as Record<string, unknown>) }));
    }
    out.push(normalized);
  }

  return out;
}

function buildDelayDueRootDirectiveXml(whenTextRaw: unknown, targetIsoRaw: unknown): string {
  const esc = (v: unknown) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  const whenText = String(whenTextRaw || '').trim();
  const targetIso = String(targetIsoRaw || '').trim();
  const objective = whenText || targetIso
    ? `The delayed task is now due (when="${whenText}", target_iso="${targetIso}"). Continue from current progress and report now.`
    : 'The delayed task is now due. Continue from current progress and report now.';

  return [
    '<sentra-root-directive>',
    '  <id>delay_due_runtime_v1</id>',
    '  <type>delay_due</type>',
    '  <scope>single_turn</scope>',
    `  <objective>${esc(objective)}</objective>`,
    '  <constraints>',
    '    <item>This is due-time execution. Do not send another pre-delay acknowledgement.</item>',
    '    <item>If tool results are partial, replay them in original order and then continue normal runtime flow.</item>',
    '    <item>If no tool result is available yet, treat this as due-triggered commitment execution and deliver the promised reply now.</item>',
    '    <item>Produce user-facing sentra-message output only.</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

export function createDelayJobRunJob(ctx: DelayJobContext) {
  const loadMessageCache = typeof ctx.loadMessageCache === 'function' ? ctx.loadMessageCache : null;
  const dispatchToMainPipeline = typeof ctx.dispatchToMainPipeline === 'function'
    ? ctx.dispatchToMainPipeline
    : null;
  const dispatchRuntimeEvent = typeof ctx.dispatchRuntimeEvent === 'function'
    ? ctx.dispatchRuntimeEvent
    : null;
  const loadDelayRuntimeSessionFromRuntimeStore = typeof ctx.loadDelayRuntimeSessionFromRuntimeStore === 'function'
    ? ctx.loadDelayRuntimeSessionFromRuntimeStore
    : null;
  const persistDelayRuntimeSessionToRuntimeStore = typeof ctx.persistDelayRuntimeSessionToRuntimeStore === 'function'
    ? ctx.persistDelayRuntimeSessionToRuntimeStore
    : null;
  const randomUUID = typeof ctx.randomUUID === 'function'
    ? ctx.randomUUID
    : () => `${Date.now()}_${Math.random().toString(16).substring(2)}`;

  return async function runJob(job: DelayJob): Promise<void> {
    try {
      if (!job || typeof job !== 'object') return;
      if (!dispatchRuntimeEvent && !dispatchToMainPipeline) {
        logger.warn(tDelayJobWorker('dispatch_missing_skip'), {
          jobId: job.jobId || null
        });
        return;
      }

      const runId = typeof job.runId === 'string' ? job.runId.trim() : '';
      const replayKind = String(job.kind || '').trim().toLowerCase();
      const delaySessionId = String(job.delaySessionId || job.jobId || '').trim();
      let effectiveRunId = runId;
      let deferredResponseXml = typeof job.deferredResponseXml === 'string' ? job.deferredResponseXml : '';
      let deferredToolResultEvents = normalizeDeferredToolEvents(job.deferredToolResultEvents);
      let hasTool = job.hasTool === true || deferredToolResultEvents.length > 0;
      let delayWhenText = typeof job.delayWhenText === 'string' ? job.delayWhenText : '';
      let delayTargetISO = typeof job.delayTargetISO === 'string' ? job.delayTargetISO : '';
      let reasonCode = normalizeDelayReasonCode(
        typeof job.reasonCode === 'string' && job.reasonCode.trim()
          ? job.reasonCode.trim()
          : (typeof job.reason === 'string' && job.reason.trim() ? job.reason.trim() : DELAY_REASON_CODE.dueReplay),
        DELAY_REASON_CODE.dueReplay
      );
      let reasonArgs = normalizeDelayReasonArgs(job.reasonArgs);
      let reason = typeof job.reason === 'string' && job.reason.trim()
        ? job.reason.trim()
        : reasonCode;
      let baseMessageFromSession: BaseMessage | null = null;
      let sessionReplayCursorForDispatch: Record<string, unknown> | null = null;
      const orchestratorRunId = String((job as Record<string, unknown>)?.orchestratorRunId || '').trim();

      if (replayKind === DELAY_RUNTIME_KIND.dueTriggerJob && delaySessionId) {
        let session = getDelayRuntimeSessionSnapshot(delaySessionId);
        if (!session && loadDelayRuntimeSessionFromRuntimeStore) {
          const loaded = await loadDelayRuntimeSessionFromRuntimeStore({
            delaySessionId,
            runId: effectiveRunId || '',
            orchestratorRunId
          });
          const normalizedLoaded = normalizeDelayRuntimeSessionFromStore(loaded);
          if (normalizedLoaded) {
            try {
              createDelayRuntimeSession({
                sessionId: normalizedLoaded.sessionId,
                fireAt: normalizedLoaded.fireAt,
                runId: normalizedLoaded.runId || effectiveRunId || '',
                type: normalizedLoaded.type || (job.type || 'private'),
                groupId: normalizedLoaded.groupId || job.groupId || null,
                userId: normalizedLoaded.userId || job.userId || null,
                senderId: normalizedLoaded.senderId || job.userId || null,
                delayWhenText: normalizedLoaded.delayWhenText || '',
                delayTargetISO: normalizedLoaded.delayTargetISO || '',
                reason: normalizedLoaded.reason || normalizedLoaded.reasonCode || '',
                reasonCode: normalizedLoaded.reasonCode || '',
                reasonArgs: normalizedLoaded.reasonArgs,
                deferredResponseXml: normalizedLoaded.deferredResponseXml || '',
                baseMessage: normalizedLoaded.baseMessage
              });
              updateDelayRuntimeSession(normalizedLoaded.sessionId, {
                bufferedEvents: normalizedLoaded.bufferedEvents,
                dueFiredAt: normalizedLoaded.dueFiredAt > 0 ? normalizedLoaded.dueFiredAt : null,
                completedAt: normalizedLoaded.completedAt > 0 ? normalizedLoaded.completedAt : null,
                replayCursor: normalizedLoaded.replayCursor
              });
              session = getDelayRuntimeSessionSnapshot(delaySessionId);
            } catch (e) {
              logger.debug(tDelayJobWorker('due_trigger_session_missing'), {
                sessionId: delaySessionId,
                runId: effectiveRunId || null,
                err: String(e)
              });
            }
          }
        }
        if (session) {
          const dueFiredAt = Date.now();
          const marked = markDelayRuntimeSessionDueFired(delaySessionId, dueFiredAt);
          const sessionAfterDue = marked || session;
          if (sessionAfterDue && persistDelayRuntimeSessionToRuntimeStore) {
            try {
              await persistDelayRuntimeSessionToRuntimeStore({
                runId: String(sessionAfterDue.runId || effectiveRunId || '').trim(),
                orchestratorRunId: String(orchestratorRunId || '').trim(),
                session: {
                  ...sessionAfterDue,
                  checkpointRunId: String((session as unknown as Record<string, unknown>)?.checkpointRunId || ''),
                  orchestratorRunId: String(orchestratorRunId || (session as unknown as Record<string, unknown>)?.orchestratorRunId || '')
                },
                eventType: 'delay_runtime_due_fired'
              });
            } catch (e) {
              logger.debug(tDelayJobWorker('run_job_failed'), {
                err: String(e),
                sessionId: delaySessionId,
                runId: effectiveRunId || null
              });
            }
          }
          effectiveRunId = String(session.runId || effectiveRunId || '').trim();
          if (Array.isArray(session.bufferedEvents) && session.bufferedEvents.length > 0) {
            deferredToolResultEvents = normalizeDeferredToolEvents(session.bufferedEvents);
          }
          deferredResponseXml = String(session.deferredResponseXml || deferredResponseXml || '');
          hasTool = deferredToolResultEvents.length > 0 || hasTool;
          delayWhenText = String(session.delayWhenText || delayWhenText || '');
          delayTargetISO = String(session.delayTargetISO || delayTargetISO || '');
          reasonCode = normalizeDelayReasonCode(
            session.reasonCode || session.reason || reasonCode,
            DELAY_REASON_CODE.dueReplay
          );
          reasonArgs = normalizeDelayReasonArgs(session.reasonArgs);
          reason = String(session.reason || reasonCode || reason || DELAY_REASON_CODE.dueReplay);
          baseMessageFromSession = session.baseMessage && typeof session.baseMessage === 'object'
            ? session.baseMessage as BaseMessage
            : null;
          sessionReplayCursorForDispatch = session.replayCursor && typeof session.replayCursor === 'object'
            ? { ...(session.replayCursor as Record<string, unknown>) }
            : null;
          logger.info(tDelayJobWorker('due_trigger_session_loaded'), {
            sessionId: delaySessionId,
            runId: effectiveRunId || null,
            bufferedEvents: Array.isArray(session.bufferedEvents) ? session.bufferedEvents.length : 0,
            hasDeferredResponse: !!String(session.deferredResponseXml || '').trim(),
            completedAt: session.completedAt || null,
            fireAt: session.fireAt || null
          });
        } else {
          logger.warn(tDelayJobWorker('due_trigger_session_missing'), {
            sessionId: delaySessionId,
            jobId: job.jobId || null,
            runId: effectiveRunId || null
          });
        }
      } else if (replayKind === DELAY_RUNTIME_KIND.dueTriggerJob && !delaySessionId) {
        logger.warn(tDelayJobWorker('due_trigger_missing_session_id'), {
          jobId: job.jobId || null,
          runId: effectiveRunId || null
        });
      }

      let cacheMsg: BaseMessage | null = null;
      if (effectiveRunId && loadMessageCache) {
        try {
          const cache = await loadMessageCache(effectiveRunId);
          cacheMsg = cache && cache.message ? cache.message : null;
        } catch (e) {
          logger.debug(tDelayJobWorker('load_message_cache_failed'), { runId: effectiveRunId, err: String(e) });
        }
      }

      const fallbackSenderId = String(job.userId || '').trim();
      const fallbackType = typeof job.type === 'string' && job.type.trim()
        ? job.type.trim()
        : (job.groupId != null ? 'group' : 'private');

      const baseMsg: BaseMessage = cacheMsg || baseMessageFromSession || {
        type: fallbackType,
        sender_id: fallbackSenderId,
        ...(job.groupId != null ? { group_id: job.groupId } : {}),
        text: typeof reason === 'string' ? reason : '',
        summary: typeof reason === 'string' ? reason : ''
      };

      const senderId = String(baseMsg.sender_id || fallbackSenderId || '').trim();
      if (!senderId) {
        logger.warn(tDelayJobWorker('missing_sender_skip'), {
          jobId: job.jobId || null,
          runId: effectiveRunId || null
        });
        return;
      }

      logger.info(tDelayJobWorker('dispatch_due_replay'), {
        jobId: String(job.jobId || ''),
        runId: effectiveRunId || null,
        sessionId: delaySessionId || null,
        senderId,
        groupId: baseMsg.group_id ?? job.groupId ?? null,
        hasTool,
        hasDeferredResponse: !!String(deferredResponseXml || '').trim(),
        reasonCode,
        replayEvents: deferredToolResultEvents.length,
        replayKind: replayKind || DELAY_RUNTIME_KIND.dueReplayPayload
      });
      if (dispatchRuntimeEvent) {
        await dispatchRuntimeEvent({
          type: 'delay_due_triggered',
          payload: {
            runId: effectiveRunId || randomUUID(),
            delaySessionId: delaySessionId || undefined,
            reason,
            reasonCode,
            reasonArgs,
            hasTool,
            delayWhenText,
            delayTargetISO,
            deferredResponseXml,
            deferredToolResultEvents,
            replayCursor: sessionReplayCursorForDispatch
              ? { ...sessionReplayCursorForDispatch }
              : ((job.replayCursor && typeof job.replayCursor === 'object')
                ? { ...(job.replayCursor as Record<string, unknown>) }
                : undefined),
            baseMessage: {
              ...baseMsg,
              sender_id: senderId,
              type: String(baseMsg.type || fallbackType || 'private'),
              ...(job.groupId != null ? { group_id: job.groupId } : {})
            },
            jobId: String(job.jobId || randomUUID()),
            userId: String(job.userId || senderId || '').trim(),
            groupId: job.groupId ?? baseMsg.group_id ?? null,
            type: String(baseMsg.type || fallbackType || 'private'),
            orchestratorRunId
          }
        });
        return;
      }
      if (dispatchToMainPipeline) {
        const dueRootDirective = buildDelayDueRootDirectiveXml(delayWhenText, delayTargetISO);
        const dueMsg: BaseMessage & Record<string, unknown> = {
          ...baseMsg,
          type: String(baseMsg.type || fallbackType || 'private'),
          sender_id: senderId,
          ...(job.groupId != null ? { group_id: job.groupId } : {}),
          _replyAction: 'action',
          _sentraRootDirectiveXml: dueRootDirective,
          _delayReplay: {
            kind: DELAY_RUNTIME_KIND.dueReplayPayload,
            jobId: String(job.jobId || randomUUID()),
            runId: effectiveRunId || randomUUID(),
            delaySessionId: delaySessionId || undefined,
            reason,
            reasonCode,
            reasonArgs,
            hasTool,
            delayWhenText,
            delayTargetISO,
            deferredResponseXml,
            deferredToolResultEvents
          }
        };
        await dispatchToMainPipeline(dueMsg, null);
      }
    } catch (e) {
      logger.warn(tDelayJobWorker('run_job_failed'), { err: String(e) });
    }
  };
}
