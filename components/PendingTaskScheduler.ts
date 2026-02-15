import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { getEnvBool, getEnvInt } from '../utils/envHotReloader.js';

const logger = createLogger('PendingTaskScheduler');

function getRuntimeConfig() {
  return {
    enabled: getEnvBool('TASK_RECOVERY_ENABLED', true),
    scanIntervalMs: getEnvInt('TASK_RECOVERY_SCAN_INTERVAL_MS', 60000),
    minIntervalSec: getEnvInt('TASK_RECOVERY_MIN_INTERVAL_SEC', 300),
    idleWaitSec: getEnvInt('TASK_RECOVERY_IDLE_WAIT_SEC', 60),
    maxPerTick: getEnvInt('TASK_RECOVERY_MAX_PER_TICK', 1),
    maxFailureAttempts: getEnvInt('TASK_RECOVERY_MAX_FAILURE_ATTEMPTS', 2),
    fileTtlHours: getEnvInt('TASK_RECOVERY_FILE_TTL_HOURS', 24)
  };
}

function isPendingStatus(statusRaw: unknown): boolean {
  const status = String(statusRaw || '').toLowerCase();
  if (!status) return true;
  if (status === 'completed' || status === 'complete' || status === 'done') return false;
  return true;
}

function isPendingTask(data: Record<string, unknown> | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  const isComplete = (data as { isComplete?: boolean }).isComplete;
  if (isComplete === true) return false;
  const status = (data as { status?: unknown }).status;
  return isPendingStatus(status);
}

function buildConversationId(task: Record<string, unknown> | null | undefined): string | null {
  const userIdRaw = task && 'userId' in task ? (task as { userId?: unknown }).userId : null;
  const userId = userIdRaw != null ? String(userIdRaw) : '';
  if (!userId) return null;
  const groupIdValue = task && 'groupId' in task ? (task as { groupId?: unknown }).groupId : null;
  const groupIdRaw = groupIdValue != null ? String(groupIdValue) : '';
  if (groupIdRaw && groupIdRaw.startsWith('G:')) {
    const gid = groupIdRaw.slice(2);
    if (gid) return `group_${gid}_sender_${userId}`;
  }
  return `private_${userId}`;
}

async function listJsonFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: Array<import('fs').Dirent> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        output.push(full);
      }
    }
  }
  return output;
}

async function loadTaskFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return data;
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

function getTaskRecoveryCount(task: Record<string, unknown> | null | undefined): number {
  if (!task || typeof task !== 'object') return 0;
  const raw = (task as { recoveryCount?: unknown }).recoveryCount;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function getTaskCreatedAtMs(task: Record<string, unknown> | null | undefined, statMtimeMs: number): number {
  const fromCreatedAt = toEpochMs((task as { createdAt?: unknown })?.createdAt);
  if (fromCreatedAt > 0) return fromCreatedAt;
  const fromTimestamp = toEpochMs((task as { timestamp?: unknown })?.timestamp);
  if (fromTimestamp > 0) return fromTimestamp;
  return Number.isFinite(statMtimeMs) && statMtimeMs > 0 ? statMtimeMs : Date.now();
}

function isExpiredTask(
  task: Record<string, unknown> | null | undefined,
  statMtimeMs: number,
  ttlHoursRaw: unknown,
  nowMs: number
): boolean {
  const ttlHours = Number(ttlHoursRaw);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return false;

  const expiresAt = toEpochMs((task as { expiresAt?: unknown })?.expiresAt);
  if (expiresAt > 0) return nowMs >= expiresAt;

  const createdAt = getTaskCreatedAtMs(task, statMtimeMs);
  const ttlMs = ttlHours * 3600 * 1000;
  return nowMs >= createdAt + ttlMs;
}

async function deleteTaskArtifacts(jsonPath: string) {
  if (!jsonPath) return;
  try {
    await fs.unlink(jsonPath);
  } catch { }
  try {
    const mdPath = jsonPath.replace(/\.json$/i, '.md');
    if (mdPath && mdPath !== jsonPath) {
      await fs.unlink(mdPath);
    }
  } catch { }
}

type PendingTaskCandidate = {
  task: Record<string, unknown>;
  conversationId: string;
  jsonPath: string;
  mtimeMs: number;
  recoveryCount: number;
  attempt?: number;
};

type PendingTaskSchedulerOptions = {
  rootDir?: string;
  getActiveTaskCount?: (conversationId: string) => number;
  onCandidate?: (candidate: PendingTaskCandidate) => Promise<void> | void;
};

export function startPendingTaskScheduler(options: PendingTaskSchedulerOptions = {}) {
  const {
    rootDir = './taskData',
    getActiveTaskCount,
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
      const jsonFiles = await listJsonFiles(rootDir);
      if (!jsonFiles || jsonFiles.length === 0) return;

      const candidates: PendingTaskCandidate[] = [];
      const now = Date.now();
      for (const filePath of jsonFiles) {
        let stat = null;
        try {
          stat = await fs.stat(filePath);
        } catch {
          continue;
        }

        let task: Record<string, unknown>;
        try {
          task = await loadTaskFile(filePath);
        } catch (e) {
          logger.debug('skip invalid task json', { filePath, err: String(e) });
          continue;
        }

        const recoveryCount = getTaskRecoveryCount(task);
        const maxFailureAttempts = Number.isFinite(Number(cfg.maxFailureAttempts))
          ? Math.max(1, Number(cfg.maxFailureAttempts))
          : 2;

        if (isExpiredTask(task, stat?.mtimeMs || 0, cfg.fileTtlHours, now)) {
          await deleteTaskArtifacts(filePath);
          logger.info('task recovery: expired task file deleted', { filePath });
          continue;
        }

        if (recoveryCount >= maxFailureAttempts) {
          await deleteTaskArtifacts(filePath);
          logger.info('task recovery: exceeded max failure attempts, file deleted', {
            filePath,
            recoveryCount,
            maxFailureAttempts
          });
          continue;
        }

        if (!isPendingTask(task)) continue;
        const conversationId = buildConversationId(task);
        if (!conversationId) continue;
        candidates.push({
          task,
          conversationId,
          jsonPath: filePath,
          mtimeMs: stat.mtimeMs,
          recoveryCount
        });
      }

      if (candidates.length === 0) return;

      candidates.sort((a, b) => {
        const aFailed = a.recoveryCount > 0 ? 1 : 0;
        const bFailed = b.recoveryCount > 0 ? 1 : 0;
        if (aFailed !== bFailed) return aFailed - bFailed;

        // 未失败过：按旧任务优先；失败过：降级并在同组内按较新的先尝试
        if (aFailed === 0) return a.mtimeMs - b.mtimeMs;
        return b.mtimeMs - a.mtimeMs;
      });

      const maxPerTick = typeof cfg.maxPerTick === 'number' && cfg.maxPerTick > 0 ? cfg.maxPerTick : 1;
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
