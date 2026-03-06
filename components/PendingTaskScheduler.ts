import { createLogger } from '../utils/logger.js';
import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';
import { extractScopeId, isGroupScopeId } from '../utils/conversationId.js';

const logger = createLogger('PendingTaskScheduler');

function getRuntimeConfig() {
  return {
    enabled: getEnvBool('TASK_RECOVERY_ENABLED', true),
    scanIntervalMs: getEnvInt('TASK_RECOVERY_SCAN_INTERVAL_MS', 60000),
    minIntervalSec: getEnvInt('TASK_RECOVERY_MIN_INTERVAL_SEC', 300),
    idleWaitSec: getEnvInt('TASK_RECOVERY_IDLE_WAIT_SEC', 60),
    maxPerTick: getEnvInt('TASK_RECOVERY_MAX_PER_TICK', 1)
  };
}

function isTerminalStatus(statusRaw: unknown): boolean {
  const status = String(statusRaw || '').trim().toLowerCase();
  return status === 'completed' || status === 'complete' || status === 'done' || status === 'failed' || status === 'cancelled';
}

function toText(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return 0;
  const s = value.trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  const ts = Date.parse(s);
  if (Number.isFinite(ts) && ts > 0) return ts;
  return 0;
}

function buildConversationId(task: Record<string, unknown> | null | undefined): string | null {
  const userIdRaw = task && 'userId' in task ? (task as { userId?: unknown }).userId : null;
  const userId = userIdRaw != null ? String(userIdRaw) : '';
  if (!userId) return null;
  const groupIdValue = task && 'groupId' in task ? (task as { groupId?: unknown }).groupId : null;
  const groupIdRaw = groupIdValue != null ? String(groupIdValue) : '';
  if (isGroupScopeId(groupIdRaw)) {
    const gid = extractScopeId(groupIdRaw);
    if (gid) return `group_${gid}_sender_${userId}`;
  }
  return `private_${userId}`;
}

type PendingTaskCandidate = {
  task: Record<string, unknown>;
  conversationId: string;
  mtimeMs: number;
  recoveryCount: number;
  source?: 'checkpoint';
  runId?: string;
  attempt?: number;
};

type RuntimeCheckpointSnapshot = {
  runId?: unknown;
  conversationId?: unknown;
  objective?: unknown;
  userId?: unknown;
  groupId?: unknown;
  status?: unknown;
  stage?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
};

type PendingTaskSchedulerOptions = {
  getActiveTaskCount?: (conversationId: string) => number;
  listRuntimeRunCheckpointSnapshots?: (args?: {
    includeTerminal?: boolean;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  onCandidate?: (candidate: PendingTaskCandidate) => Promise<void> | void;
};

function candidateStableKey(candidate: PendingTaskCandidate): string {
  const runId = toText(candidate?.runId);
  if (runId) return `run:${runId}`;
  const taskId = toText(candidate?.task?.taskId);
  if (taskId) return `task:${taskId}`;
  return `checkpoint:${toText(candidate?.conversationId)}`;
}

function buildCheckpointCandidate(snapshotRaw: RuntimeCheckpointSnapshot, nowMs: number): PendingTaskCandidate | null {
  const snapshot = (snapshotRaw && typeof snapshotRaw === 'object') ? snapshotRaw : null;
  if (!snapshot) return null;

  const runId = toText(snapshot.runId);
  if (!runId) return null;

  const status = toText(snapshot.status).toLowerCase();
  if (isTerminalStatus(status)) return null;

  const userId = toText(snapshot.userId);
  const groupId = toText(snapshot.groupId);
  const conversationIdRaw = toText(snapshot.conversationId);
  const conversationId = conversationIdRaw || buildConversationId({ userId, groupId });
  if (!conversationId) return null;

  const objective = toText(snapshot.objective);
  const stage = toText(snapshot.stage);
  const summary = objective || `runtime checkpoint pending (run=${runId})`;
  const reason = stage
    ? `checkpoint stage=${stage}, status=${status || 'running'}`
    : `checkpoint status=${status || 'running'}`;

  const mtimeMs = Math.max(
    0,
    toEpochMs(snapshot.updatedAt)
    || toEpochMs(snapshot.startedAt)
    || nowMs
  );

  const task: Record<string, unknown> = {
    taskId: runId,
    runId,
    userId,
    groupId,
    status: status || 'running',
    summary,
    reason,
    objective,
    timestamp: mtimeMs
  };

  return {
    task,
    conversationId,
    mtimeMs,
    recoveryCount: 0,
    source: 'checkpoint',
    runId
  };
}

async function collectCheckpointCandidates(
  listRuntimeRunCheckpointSnapshots: PendingTaskSchedulerOptions['listRuntimeRunCheckpointSnapshots']
): Promise<PendingTaskCandidate[]> {
  if (typeof listRuntimeRunCheckpointSnapshots !== 'function') return [];
  try {
    const snapshots = await listRuntimeRunCheckpointSnapshots({
      includeTerminal: false,
      limit: 2000
    });
    if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

    const nowMs = Date.now();
    const out: PendingTaskCandidate[] = [];
    for (const item of snapshots) {
      const candidate = buildCheckpointCandidate(item as RuntimeCheckpointSnapshot, nowMs);
      if (candidate) out.push(candidate);
    }
    return out;
  } catch (e) {
    logger.debug('task recovery: checkpoint listing failed', { err: String(e) });
    return [];
  }
}

export function startPendingTaskScheduler(options: PendingTaskSchedulerOptions = {}) {
  const {
    getActiveTaskCount,
    listRuntimeRunCheckpointSnapshots,
    onCandidate
  } = options || {};

  const lastAttemptByTask = new Map<string, number>();
  const idleSinceByConversation = new Map<string, number>();
  let running = false;

  const tick = async () => {
    const cfg = getRuntimeConfig();
    const intervalMs = typeof cfg.scanIntervalMs === 'number' && cfg.scanIntervalMs > 0 ? cfg.scanIntervalMs : 60000;
    setTimeout(() => {
      tick().catch((err) => {
        logger.warn('task recovery tick failed', { err: String(err) });
      });
    }, intervalMs);

    if (!cfg.enabled || running) {
      return;
    }
    if (typeof onCandidate !== 'function') {
      return;
    }

    running = true;
    try {
      const allCandidates = await collectCheckpointCandidates(listRuntimeRunCheckpointSnapshots);
      if (allCandidates.length === 0) return;

      const deduped = new Map<string, PendingTaskCandidate>();
      for (const item of allCandidates) {
        const key = candidateStableKey(item);
        const prev = deduped.get(key);
        if (!prev) {
          deduped.set(key, item);
          continue;
        }
        if (item.mtimeMs >= prev.mtimeMs) {
          deduped.set(key, item);
        }
      }
      const candidates = Array.from(deduped.values());
      if (candidates.length === 0) return;

      candidates.sort((a, b) => {
        const aFailed = a.recoveryCount > 0 ? 1 : 0;
        const bFailed = b.recoveryCount > 0 ? 1 : 0;
        if (aFailed !== bFailed) return aFailed - bFailed;
        if (aFailed === 0) return a.mtimeMs - b.mtimeMs;
        return b.mtimeMs - a.mtimeMs;
      });

      const maxPerTick = typeof cfg.maxPerTick === 'number' && cfg.maxPerTick > 0 ? cfg.maxPerTick : 1;
      const now = Date.now();
      let triggered = 0;
      for (const item of candidates) {
        if (triggered >= maxPerTick) break;
        const taskIdRaw = item.task && 'taskId' in item.task ? (item.task as { taskId?: unknown }).taskId : '';
        const taskId = taskIdRaw ? String(taskIdRaw) : '';
        if (!taskId) continue;

        const lastAttemptAt = lastAttemptByTask.get(taskId);
        const minIntervalMs = Math.max(0, (cfg.minIntervalSec || 0) * 1000);
        if (lastAttemptAt && minIntervalMs > 0 && now - lastAttemptAt < minIntervalMs) {
          continue;
        }

        if (typeof getActiveTaskCount === 'function') {
          const activeCount = getActiveTaskCount(item.conversationId);
          if (activeCount > 0) {
            idleSinceByConversation.set(item.conversationId, now);
            continue;
          }
          const idleSince = idleSinceByConversation.get(item.conversationId);
          if (!idleSince) {
            idleSinceByConversation.set(item.conversationId, now);
            continue;
          }
          const idleWaitMs = Math.max(0, (cfg.idleWaitSec || 0) * 1000);
          if (idleWaitMs > 0 && now - idleSince < idleWaitMs) {
            continue;
          }
        }

        const nextAttempt = Math.max(1, item.recoveryCount + 1);
        lastAttemptByTask.set(taskId, now);
        await onCandidate({ ...item, attempt: nextAttempt });
        triggered += 1;
      }
    } catch (e) {
      logger.warn('task recovery scan failed', { err: String(e) });
    } finally {
      running = false;
    }
  };

  tick().catch((e) => {
    logger.warn('task recovery scheduler failed to start', { err: String(e) });
  });
}
