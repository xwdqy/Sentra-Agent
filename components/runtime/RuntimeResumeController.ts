import { DELAY_RUNTIME_AI_NAME, DELAY_RUNTIME_KIND } from '../../utils/delayRuntimeConstants.js';
import { DELAY_REASON_CODE, normalizeDelayReasonArgs, normalizeDelayReasonCode } from '../../utils/delayReasonCodes.js';

export type DelayRuntimeSessionSnapshot = {
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
  reasonArgs: Record<string, unknown>;
  deferredResponseXml: string;
  bufferedEvents: Array<Record<string, unknown>>;
  baseMessage: Record<string, unknown> | null;
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

type RuntimeRunCheckpointSnapshot = {
  runId: string;
  status: string;
  stage: string;
  updatedAt: number;
  conversationId: string;
  objective: string;
  userId: string;
  groupId: string;
  channelId: string;
  identityKey: string;
  lastCompletedStepIndex: number;
  totalSteps: number;
  [key: string]: unknown;
};

type RuntimeResumeDispatchEvent = {
  type: 'runtime_resume_checkpoint';
  payload: Record<string, unknown>;
};

type RuntimeResumeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

type RuntimeResumeControllerContext = {
  logger?: RuntimeResumeLogger;
  enqueueDelayedJob: (job: Record<string, unknown>) => Promise<unknown>;
  dispatchRuntimeEvent?: (event: RuntimeResumeDispatchEvent) => Promise<void>;
  listRuntimeDelaySessionSnapshots?: (args?: {
    includeCompleted?: boolean;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  loadRuntimeDelaySessionSnapshot?: (args?: {
    sessionId?: string;
    runId?: string;
    orchestratorRunId?: string;
  }) => Promise<Record<string, unknown> | null>;
  loadRuntimeRunCheckpointSnapshot?: (args?: {
    runId?: string;
  }) => Promise<Record<string, unknown> | null>;
  listRuntimeRunCheckpointSnapshots?: (args?: {
    includeTerminal?: boolean;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  persistRuntimeCheckpoint?: (args?: {
    runId?: string;
    context?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    event?: Record<string, unknown> | null;
  }) => Promise<unknown>;
};

const PENDING_RUN_RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PENDING_RUN_RESUME_MAX_DISPATCH_PER_BOOT = 64;
const PENDING_RUN_RESUME_DISPATCH_COOLDOWN_MS = 2 * 60 * 1000;
const PENDING_RUN_STATUS = new Set(['running', 'queued', 'pending', '']);
const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled']);

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeRuntimeRunCheckpointSnapshot(raw: unknown): RuntimeRunCheckpointSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const runId = String(src.runId || '').trim();
  if (!runId) return null;
  return {
    ...src,
    runId,
    status: String(src.status || '').trim().toLowerCase(),
    stage: String(src.stage || '').trim(),
    updatedAt: toFiniteInt(src.updatedAt, 0),
    conversationId: String(src.conversationId || '').trim(),
    objective: String(src.objective || '').trim(),
    userId: String(src.userId || '').trim(),
    groupId: String(src.groupId || '').trim(),
    channelId: String(src.channelId || '').trim(),
    identityKey: String(src.identityKey || '').trim(),
    lastCompletedStepIndex: toFiniteInt(src.lastCompletedStepIndex, -1),
    totalSteps: toFiniteInt(src.totalSteps, 0)
  };
}

function hasNoPendingStepsFromCheckpoint(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const src = raw as Record<string, unknown>;
  const totalSteps = Math.max(0, toFiniteInt(src.totalSteps, 0));
  const lastCompletedStepIndex = toFiniteInt(src.lastCompletedStepIndex, -1);
  const completedStepCount = Math.max(0, toFiniteInt(src.completedStepCount, 0));
  const resumeCursorIndex = toFiniteInt(src.resumeCursorIndex, -1);
  const stage = String(src.stage || '').trim().toLowerCase();
  const status = String(src.status || '').trim().toLowerCase();
  const resumedStepCount = Math.max(0, toFiniteInt(src.resumedStepCount, 0));
  const resumedUnfinishedStepCount = Math.max(0, toFiniteInt(src.resumedUnfinishedStepCount, 0));
  const attempted = Math.max(0, toFiniteInt(src.attempted, 0));
  const succeeded = Math.max(0, toFiniteInt(src.succeeded, 0));
  const resumeAppliedRaw = src.resumeApplied;
  const resumeApplied = resumeAppliedRaw === true
    || String(resumeAppliedRaw || '').trim() === '1'
    || String(resumeAppliedRaw || '').trim().toLowerCase() === 'true';
  if (totalSteps <= 0) {
    const hasDeterministicCursor = (
      lastCompletedStepIndex >= 0
      || completedStepCount > 0
      || resumeCursorIndex > 0
      || resumedStepCount > 0
      || resumedUnfinishedStepCount > 0
    );
    // No deterministic cursor when totalSteps=0 should not be resumed.
    if (!hasDeterministicCursor) return true;
    const weakOnlyStartStage = (
      (stage === '' || stage === 'start')
      && (status === '' || status === 'running')
      && lastCompletedStepIndex < 0
      && completedStepCount === 0
      && resumeCursorIndex <= 0
      && resumedStepCount <= 0
      && resumedUnfinishedStepCount <= 0
      && (attempted > 0 || succeeded > 0 || resumeApplied)
    );
    if (weakOnlyStartStage) return true;
  }

  if (lastCompletedStepIndex >= totalSteps - 1) return true;
  if (completedStepCount >= totalSteps) return true;
  if (resumeCursorIndex >= totalSteps && resumeCursorIndex >= 0) return true;
  if (resumeApplied && resumedUnfinishedStepCount === 0 && resumedStepCount >= totalSteps) return true;
  if (attempted >= totalSteps && succeeded >= totalSteps) return true;
  return false;
}

function normalizeResumeDispatchState(raw: unknown): {
  lastDecision: string;
  lastReasonCode: string;
  lastDispatchAt: number;
  lastScanAt: number;
  attemptCount: number;
  skipCount: number;
  lastDispatchedCheckpointVersion: number;
} {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  return {
    lastDecision: String(src.lastDecision || '').trim(),
    lastReasonCode: String(src.lastReasonCode || '').trim(),
    lastDispatchAt: toFiniteInt(src.lastDispatchAt, 0),
    lastScanAt: toFiniteInt(src.lastScanAt, 0),
    attemptCount: Math.max(0, toFiniteInt(src.attemptCount, 0)),
    skipCount: Math.max(0, toFiniteInt(src.skipCount, 0)),
    lastDispatchedCheckpointVersion: Math.max(0, toFiniteInt(src.lastDispatchedCheckpointVersion, 0))
  };
}

function extractCheckpointVersion(raw: unknown): number {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const stateVersion = Math.max(0, toFiniteInt(src.stateVersion, 0));
  if (stateVersion > 0) return stateVersion;
  const checkpointVersion = Math.max(0, toFiniteInt(src.checkpointVersion, 0));
  if (checkpointVersion > 0) return checkpointVersion;
  return Math.max(0, toFiniteInt(src.version, 0));
}

export function normalizeDelayRuntimeSessionSnapshot(raw: unknown): DelayRuntimeSessionSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const sessionId = String(src.sessionId || '').trim();
  if (!sessionId) return null;
  const bufferedEvents = Array.isArray(src.bufferedEvents)
    ? src.bufferedEvents.filter((x) => x && typeof x === 'object').map((x) => ({ ...(x as Record<string, unknown>) }))
    : [];
  const reasonArgs = (src.reasonArgs && typeof src.reasonArgs === 'object' && !Array.isArray(src.reasonArgs))
    ? { ...(src.reasonArgs as Record<string, unknown>) }
    : {};
  const baseMessage = (src.baseMessage && typeof src.baseMessage === 'object' && !Array.isArray(src.baseMessage))
    ? { ...(src.baseMessage as Record<string, unknown>) }
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
      totalEvents: toFiniteInt(replayCursorRaw.totalEvents, Array.isArray(bufferedEvents) ? bufferedEvents.length : 0),
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

export function createRuntimeResumeController(ctx: RuntimeResumeControllerContext) {
  const logger = ctx?.logger || {};
  const enqueueDelayedJob = ctx.enqueueDelayedJob;
  const dispatchRuntimeEvent = typeof ctx.dispatchRuntimeEvent === 'function'
    ? ctx.dispatchRuntimeEvent
    : null;
  const listRuntimeDelaySessionSnapshots = ctx.listRuntimeDelaySessionSnapshots;
  const loadRuntimeDelaySessionSnapshot = ctx.loadRuntimeDelaySessionSnapshot;
  const loadRuntimeRunCheckpointSnapshot = ctx.loadRuntimeRunCheckpointSnapshot;
  const listRuntimeRunCheckpointSnapshots = ctx.listRuntimeRunCheckpointSnapshots;
  const persistRuntimeCheckpoint = ctx.persistRuntimeCheckpoint;
  const dispatchedResumeRunIds = new Set<string>();
  const bootDispatchId = `resume_boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const persistResumeDispatchDecision = async (params: {
    runId: string;
    decision: 'dispatched' | 'skipped' | 'dispatch_failed';
    reasonCode: string;
    checkpoint?: Record<string, unknown> | null;
    payload?: Record<string, unknown>;
  }) => {
    if (typeof persistRuntimeCheckpoint !== 'function') return;
    const runId = String(params.runId || '').trim();
    if (!runId) return;
    const now = Date.now();
    const cp = (params.checkpoint && typeof params.checkpoint === 'object' && !Array.isArray(params.checkpoint))
      ? params.checkpoint
      : null;
    const prevResume = normalizeResumeDispatchState(cp?.resumeDispatch);
    const decision = params.decision;
    const reasonCode = String(params.reasonCode || '').trim() || (decision === 'dispatched' ? 'resume_dispatched' : 'resume_skipped');
    const checkpointVersion = extractCheckpointVersion(cp);
    const nextResume = {
      ...prevResume,
      lastDecision: decision,
      lastReasonCode: reasonCode,
      lastScanAt: now,
      attemptCount: prevResume.attemptCount + (decision === 'dispatched' ? 1 : 0),
      skipCount: prevResume.skipCount + (decision === 'skipped' ? 1 : 0),
      updatedAt: now,
      bootDispatchId,
      ...(decision === 'dispatched' ? { lastDispatchAt: now } : {}),
      ...(
        decision === 'dispatched' && checkpointVersion > 0
          ? { lastDispatchedCheckpointVersion: checkpointVersion }
          : {}
      )
    };
    try {
      await persistRuntimeCheckpoint({
        runId,
        context: {
          ...(cp && typeof cp === 'object' ? cp : {}),
          runId
        },
        patch: {
          resumeDispatch: nextResume
        },
        event: {
          type: 'runtime_resume_dispatch',
          decision,
          reasonCode,
          runId,
          bootDispatchId,
          attemptCount: nextResume.attemptCount,
          skipCount: nextResume.skipCount,
          lastDispatchAt: nextResume.lastDispatchAt || 0,
          ...(params.payload && typeof params.payload === 'object' ? { payload: params.payload } : {})
        }
      });
    } catch (e) {
      logger.debug?.('RuntimeResume: persist resume dispatch decision failed', {
        runId,
        decision,
        reasonCode,
        err: String(e)
      });
    }
  };

  const loadDelayRuntimeSessionFromRuntimeStore = async (params: {
    delaySessionId?: string;
    runId?: string;
    orchestratorRunId?: string;
  }): Promise<DelayRuntimeSessionSnapshot | null> => {
    const sessionId = String(params?.delaySessionId || '').trim();
    const runId = String(params?.runId || '').trim();
    const orchestratorRunId = String(params?.orchestratorRunId || '').trim();
    if (typeof loadRuntimeDelaySessionSnapshot === 'function') {
      try {
        const fromStore = await loadRuntimeDelaySessionSnapshot({ sessionId, runId, orchestratorRunId });
        const normalized = normalizeDelayRuntimeSessionSnapshot(fromStore);
        if (normalized) return normalized;
      } catch (e) {
        logger.debug?.('DelayRuntimeResume: loadRuntimeDelaySessionSnapshot failed', {
          err: String(e),
          sessionId: sessionId || null,
          runId: runId || null,
          orchestratorRunId: orchestratorRunId || null
        });
      }
    }

    const directRunIds = [runId, orchestratorRunId].filter(Boolean);
    for (const rid of directRunIds) {
      if (typeof loadRuntimeRunCheckpointSnapshot !== 'function') break;
      try {
        const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: rid });
        if (!checkpoint || typeof checkpoint !== 'object') continue;
        const candidate = normalizeDelayRuntimeSessionSnapshot(
          (checkpoint as Record<string, unknown>).delayRuntimeSession
        );
        if (!candidate) continue;
        if (!sessionId || candidate.sessionId === sessionId) {
          return {
            ...candidate,
            checkpointRunId: candidate.checkpointRunId || rid,
            orchestratorRunId: candidate.orchestratorRunId || orchestratorRunId || ''
          };
        }
      } catch (e) {
        logger.debug?.('DelayRuntimeResume: loadRuntimeRunCheckpointSnapshot failed', {
          err: String(e),
          runId: rid
        });
      }
    }
    return null;
  };

  const persistDelayRuntimeSessionToRuntimeStore = async (params: {
    runId?: string;
    orchestratorRunId?: string;
    session: Record<string, unknown>;
    eventType: string;
  }) => {
    if (typeof persistRuntimeCheckpoint !== 'function') return;
    const session = normalizeDelayRuntimeSessionSnapshot(params.session);
    if (!session) return;
    const runId = String(params.runId || session.checkpointRunId || session.runId || '').trim();
    const orchestratorRunId = String(params.orchestratorRunId || session.orchestratorRunId || '').trim();
    const targetRunIds = Array.from(new Set([runId, orchestratorRunId].filter(Boolean)));
    if (targetRunIds.length === 0) return;
    const sessionPayload = {
      ...session,
      updatedAt: Date.now()
    };
    for (const rid of targetRunIds) {
      await persistRuntimeCheckpoint({
        runId: rid,
        context: {
          orchestratorRunId: orchestratorRunId || rid,
          parentRunId: orchestratorRunId || rid
        },
        patch: {
          delayRuntimeSession: {
            ...sessionPayload,
            checkpointRunId: rid,
            orchestratorRunId: orchestratorRunId || rid
          }
        },
        event: {
          type: String(params.eventType || 'delay_runtime_session_update'),
          sessionId: sessionPayload.sessionId,
          runId: sessionPayload.runId || '',
          fireAt: sessionPayload.fireAt,
          dueFiredAt: sessionPayload.dueFiredAt,
          completedAt: sessionPayload.completedAt,
          bufferedEvents: Array.isArray(sessionPayload.bufferedEvents) ? sessionPayload.bufferedEvents.length : 0,
          replayNextOffset: Number(sessionPayload.replayCursor?.nextOffset || 0),
          replayStatus: String(sessionPayload.replayCursor?.status || '')
        }
      });
    }
  };

  const restoreDelayRuntimeQueueFromCheckpoints = async () => {
    if (typeof listRuntimeDelaySessionSnapshots !== 'function') return;
    const startedAt = Date.now();
    try {
      const snapshotsRaw = await listRuntimeDelaySessionSnapshots({
        includeCompleted: false,
        limit: 2000
      });
      const snapshots = (Array.isArray(snapshotsRaw) ? snapshotsRaw : [])
        .map((item) => normalizeDelayRuntimeSessionSnapshot(item))
        .filter((item): item is DelayRuntimeSessionSnapshot => !!item);

      const nowTs = Date.now();
      const seen = new Set<string>();
      let enqueued = 0;
      let skipped = 0;
      let dueNow = 0;
      for (const session of snapshots) {
        const sessionId = String(session.sessionId || '').trim();
        if (!sessionId || seen.has(sessionId)) {
          skipped += 1;
          continue;
        }
        seen.add(sessionId);
        if (toFiniteInt(session.completedAt, 0) > 0) {
          skipped += 1;
          continue;
        }
        const fireAt = toFiniteInt(session.fireAt, 0);
        if (!Number.isFinite(fireAt) || fireAt <= 0) {
          skipped += 1;
          continue;
        }
        if (fireAt <= nowTs) dueNow += 1;
        const normalizedReasonCode = normalizeDelayReasonCode(
          session.reasonCode || session.reason || DELAY_REASON_CODE.dueReplay,
          DELAY_REASON_CODE.dueReplay
        );
        await enqueueDelayedJob({
          kind: DELAY_RUNTIME_KIND.dueTriggerJob,
          jobId: sessionId,
          delaySessionId: sessionId,
          runId: session.runId || session.checkpointRunId || '',
          orchestratorRunId: session.orchestratorRunId || '',
          createdAt: nowTs,
          fireAt,
          delayMs: Math.max(0, fireAt - nowTs),
          type: session.type || (session.groupId ? 'group' : 'private'),
          groupId: session.groupId || null,
          userId: session.userId || session.senderId || null,
          aiName: DELAY_RUNTIME_AI_NAME.dueTrigger,
          reason: session.reason || normalizedReasonCode,
          reasonCode: normalizedReasonCode,
          reasonArgs: normalizeDelayReasonArgs(session.reasonArgs),
          hasTool: Array.isArray(session.bufferedEvents) && session.bufferedEvents.length > 0,
          delayWhenText: session.delayWhenText || '',
          delayTargetISO: session.delayTargetISO || '',
          replayCursor: session.replayCursor,
          deferredResponseXml: session.deferredResponseXml || '',
          deferredToolResultEvents: Array.isArray(session.bufferedEvents) ? session.bufferedEvents : []
        });
        enqueued += 1;
      }
      logger.info?.('DelayRuntimeResume: queue restored from runtime checkpoints', {
        candidates: snapshots.length,
        enqueued,
        dueNow,
        skipped,
        elapsedMs: Date.now() - startedAt
      });
      return { candidates: snapshots.length, enqueued, dueNow, skipped };
    } catch (e) {
      logger.warn?.('DelayRuntimeResume: restore queue from checkpoints failed', {
        err: String(e),
        elapsedMs: Date.now() - startedAt
      });
      return { candidates: 0, enqueued: 0, dueNow: 0, skipped: 0, error: String(e) };
    }
  };

  const inspectPendingRunCheckpoints = async () => {
    if (typeof listRuntimeRunCheckpointSnapshots !== 'function') return { pendingRuns: 0 };
    try {
      const runs = await listRuntimeRunCheckpointSnapshots({ includeTerminal: false, limit: 1000 });
      const list = (Array.isArray(runs) ? runs : [])
        .map((row) => normalizeRuntimeRunCheckpointSnapshot(row))
        .filter((row): row is RuntimeRunCheckpointSnapshot => !!row);
      const pending = list.filter((row) => PENDING_RUN_STATUS.has(String(row.status || '').trim().toLowerCase()));
      const nowTs = Date.now();
      let dispatched = 0;
      let skippedDuplicate = 0;
      let skippedTooOld = 0;
      let skippedNoIdentity = 0;
      let skippedNoDispatcher = 0;
      let skippedByDispatchBudget = 0;
      let skippedRecentDispatch = 0;
      let skippedVersionUnchanged = 0;
      let skippedNoPendingSteps = 0;
      let skippedTerminalAfterRefresh = 0;
      let dispatchFailed = 0;

      for (const row of pending) {
        const runId = String(row.runId || '').trim();
        if (!runId) continue;

        let checkpointSnapshot: Record<string, unknown> | null = null;
        if (typeof loadRuntimeRunCheckpointSnapshot === 'function') {
          try {
            const full = await loadRuntimeRunCheckpointSnapshot({ runId });
            if (full && typeof full === 'object' && !Array.isArray(full)) {
              checkpointSnapshot = { ...(full as Record<string, unknown>) };
            }
          } catch (e) {
            logger.debug?.('RuntimeResume: load full checkpoint snapshot failed', {
              runId,
              err: String(e)
            });
          }
        }
        const mergedCheckpoint = (checkpointSnapshot && typeof checkpointSnapshot === 'object')
          ? checkpointSnapshot
          : (row as unknown as Record<string, unknown>);
        const mergedStatus = String(mergedCheckpoint.status || row.status || '').trim().toLowerCase();
        if (TERMINAL_RUN_STATUS.has(mergedStatus)) {
          skippedTerminalAfterRefresh += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_checkpoint_terminal_current',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        const updatedAt = toFiniteInt(mergedCheckpoint.updatedAt ?? row.updatedAt, 0);
        const conversationId = String((mergedCheckpoint.conversationId ?? row.conversationId) || '').trim();
        const userId = String((mergedCheckpoint.userId ?? row.userId) || '').trim();
        const groupId = String((mergedCheckpoint.groupId ?? row.groupId) || '').trim();

        if (dispatchedResumeRunIds.has(runId)) {
          skippedDuplicate += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_duplicate_in_boot',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (updatedAt > 0 && nowTs - updatedAt > PENDING_RUN_RESUME_MAX_AGE_MS) {
          skippedTooOld += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_checkpoint_too_old',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (!conversationId && !userId && !groupId) {
          skippedNoIdentity += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_missing_identity',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (!dispatchRuntimeEvent) {
          skippedNoDispatcher += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_dispatcher_unavailable',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (dispatched >= PENDING_RUN_RESUME_MAX_DISPATCH_PER_BOOT) {
          skippedByDispatchBudget += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_dispatch_budget_exceeded',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (hasNoPendingStepsFromCheckpoint(mergedCheckpoint)) {
          skippedNoPendingSteps += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_no_pending_steps',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        const resumeDispatchState = normalizeResumeDispatchState(mergedCheckpoint.resumeDispatch);
        const checkpointVersion = extractCheckpointVersion(mergedCheckpoint);
        if (
          resumeDispatchState.lastDecision === 'dispatched'
          && checkpointVersion > 0
          && resumeDispatchState.lastDispatchedCheckpointVersion > 0
          && checkpointVersion <= resumeDispatchState.lastDispatchedCheckpointVersion
        ) {
          skippedVersionUnchanged += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_checkpoint_version_unchanged',
            checkpoint: mergedCheckpoint
          });
          continue;
        }
        if (
          resumeDispatchState.lastDecision === 'dispatched'
          && resumeDispatchState.lastDispatchAt > 0
          && (nowTs - resumeDispatchState.lastDispatchAt) < PENDING_RUN_RESUME_DISPATCH_COOLDOWN_MS
        ) {
          skippedRecentDispatch += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'skipped',
            reasonCode: 'resume_dispatch_cooldown_active',
            checkpoint: mergedCheckpoint
          });
          continue;
        }

        const payload = {
          ...(checkpointSnapshot || row),
          runId,
          status: String((checkpointSnapshot?.status ?? row.status) || '').trim(),
          stage: String((checkpointSnapshot?.stage ?? row.stage) || '').trim(),
          updatedAt: toFiniteInt(checkpointSnapshot?.updatedAt ?? row.updatedAt, updatedAt),
          conversationId: String((checkpointSnapshot?.conversationId ?? row.conversationId) || '').trim(),
          objective: String((checkpointSnapshot?.objective ?? row.objective) || '').trim(),
          userId: String((checkpointSnapshot?.userId ?? row.userId) || '').trim(),
          groupId: String((checkpointSnapshot?.groupId ?? row.groupId) || '').trim(),
          channelId: String((checkpointSnapshot?.channelId ?? row.channelId) || '').trim(),
          identityKey: String((checkpointSnapshot?.identityKey ?? row.identityKey) || '').trim(),
          lastCompletedStepIndex: toFiniteInt(
            checkpointSnapshot?.lastCompletedStepIndex ?? row.lastCompletedStepIndex,
            -1
          ),
          totalSteps: toFiniteInt(checkpointSnapshot?.totalSteps ?? row.totalSteps, 0),
          resumeDispatch: resumeDispatchState
        };
        try {
          await dispatchRuntimeEvent({
            type: 'runtime_resume_checkpoint',
            payload
          });
          dispatchedResumeRunIds.add(runId);
          dispatched += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'dispatched',
            reasonCode: 'resume_dispatched',
            checkpoint: mergedCheckpoint,
            payload: {
              status: String(payload.status || ''),
              stage: String(payload.stage || ''),
              lastCompletedStepIndex: toFiniteInt(payload.lastCompletedStepIndex, -1),
              totalSteps: toFiniteInt(payload.totalSteps, 0)
            }
          });
        } catch (e) {
          dispatchFailed += 1;
          await persistResumeDispatchDecision({
            runId,
            decision: 'dispatch_failed',
            reasonCode: 'resume_dispatch_failed',
            checkpoint: mergedCheckpoint,
            payload: {
              error: String(e)
            }
          });
          logger.warn?.('RuntimeResume: dispatch runtime resume event failed', {
            runId,
            err: String(e)
          });
        }
      }
      logger.info?.('RuntimeResume: pending run checkpoints scanned', {
        total: list.length,
        pendingRuns: pending.length,
        dispatched,
        skippedDuplicate,
        skippedTooOld,
        skippedNoIdentity,
        skippedNoDispatcher,
        skippedByDispatchBudget,
        skippedRecentDispatch,
        skippedVersionUnchanged,
        skippedNoPendingSteps,
        skippedTerminalAfterRefresh,
        dispatchFailed
      });
      return {
        pendingRuns: pending.length,
        total: list.length,
        dispatched,
        skippedDuplicate,
        skippedTooOld,
        skippedNoIdentity,
        skippedNoDispatcher,
        skippedByDispatchBudget,
        skippedRecentDispatch,
        skippedVersionUnchanged,
        skippedNoPendingSteps,
        skippedTerminalAfterRefresh,
        dispatchFailed
      };
    } catch (e) {
      logger.warn?.('RuntimeResume: inspect pending run checkpoints failed', { err: String(e) });
      return { pendingRuns: 0, error: String(e) };
    }
  };

  const restoreRuntimeFromCheckpoints = async () => {
    const [delayStats, pendingRunStats] = await Promise.all([
      restoreDelayRuntimeQueueFromCheckpoints(),
      inspectPendingRunCheckpoints()
    ]);
    return {
      delay: delayStats,
      pendingRuns: pendingRunStats
    };
  };

  return {
    normalizeDelayRuntimeSessionSnapshot,
    loadDelayRuntimeSessionFromRuntimeStore,
    persistDelayRuntimeSessionToRuntimeStore,
    restoreDelayRuntimeQueueFromCheckpoints,
    inspectPendingRunCheckpoints,
    restoreRuntimeFromCheckpoints
  };
}

export default {
  createRuntimeResumeController,
  normalizeDelayRuntimeSessionSnapshot
};
